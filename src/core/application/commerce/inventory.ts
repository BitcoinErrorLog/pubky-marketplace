import type { InventoryAdjustRequest } from '@bitcoinerrorlog/pubky-shop';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import type { CommerceListingRecord } from '@/libs/commerce/marketplace-records';
import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import { isUnlimitedStock } from '@/libs/commerce/unlimited-stock';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import {
  type InventoryBearer,
  MarketplaceInventorySessionService,
} from '@/services/marketplace/marketplace-inventory-session';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { MarketplaceShopClientService, PubkyShopError } from '@/services/marketplace/marketplace-shop-client';

export type InventoryBoardRow = {
  listingId: string;
  sellerPubky: string;
  aggregateId: string;
  title: string;
  thumbUrl: string | null;
  state: string;
  format: string;
  dropId: string | null;
  available: number;
  reserved: number;
  sold: number;
  total: number;
  serverRevision: number;
  /** Set when the listing record itself is unlimited. Available may be lower while a hold reserves units. */
  unlimited?: boolean;
  sync: 'synced' | 'missing';
  syncMessage?: string | null;
  recordStatus?: 'unavailable';
};

export type InventoryBoardLoad =
  | { status: 'durable-unavailable' }
  | { status: 'unauthenticated' }
  | { status: 'session-required' }
  | { status: 'grant-needed' }
  | { status: 'empty'; rows: [] }
  | { status: 'ready'; rows: InventoryBoardRow[] }
  | { status: 'error'; message: string };

export type InventoryAdjustPlan =
  | { ok: true; request: InventoryAdjustRequest }
  | { ok: false; reason: 'delta_zero' | 'negative_available' };

export type InventorySetResult =
  | { status: 'updated'; row: InventoryBoardRow }
  | { status: 'grant-needed' }
  | { status: 'revision_conflict' }
  | { status: 'session-required' }
  | { status: 'error'; message: string };

export type InventoryRetryResult =
  | { status: 'synced'; listingId: string }
  | { status: 'missing'; listingId: string; message: string }
  | { status: 'grant-needed' }
  | { status: 'error'; message: string };

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return null;
}

function thumbUrl(record: Record<string, unknown> | null): string | null {
  const media = record?.media;
  if (!Array.isArray(media) || media.length === 0) return null;
  const first = media[0];
  if (typeof first === 'string') return first;
  const object = asObject(first);
  return asString(object?.url) ?? asString(object?.src);
}

function dropIdFromRecord(record: Record<string, unknown> | null): string | null {
  const edition = asObject(record?.edition);
  return asString(edition?.dropId) ?? asString(record?.dropId);
}

function recordStatusFromExport(entry: Record<string, unknown>): 'unavailable' | undefined {
  return entry.record_status === 'unavailable' ? 'unavailable' : undefined;
}

const EXPORT_FULFILLMENT_METHODS = ['physical', 'shipping', 'pickup', 'digital'] as const;

function exportRecordIsUnlimited(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  const methods = Array.isArray(record.fulfillmentMethods)
    ? record.fulfillmentMethods.filter(
        (method): method is CommerceListingRecord['fulfillmentMethods'][number] =>
          typeof method === 'string' && (EXPORT_FULFILLMENT_METHODS as readonly string[]).includes(method),
      )
    : [];
  const variants = Array.isArray(record.variants) ? record.variants : [];
  return variants.some((entry) => {
    const object = asObject(entry);
    const quantity = object ? asInt(object.quantity) : null;
    return (
      quantity !== null && isUnlimitedStock({ fulfillmentMethods: methods, digitalLock: record.digitalLock }, quantity)
    );
  });
}

export function planInventoryAdjust(input: {
  listingId: string;
  aggregateId: string;
  currentAvailable: number;
  targetAvailable: number;
  expectedRevision: number;
  idempotencyKey: string;
}): InventoryAdjustPlan {
  if (!Number.isSafeInteger(input.targetAvailable) || input.targetAvailable < 0) {
    return { ok: false, reason: 'negative_available' };
  }
  if (input.targetAvailable === input.currentAvailable) {
    return { ok: false, reason: 'delta_zero' };
  }
  const delta = BigInt(input.targetAvailable - input.currentAvailable);
  return {
    ok: true,
    request: {
      schema_version: 1,
      kind: 'inventory.adjust',
      aggregate_id: input.aggregateId,
      listing_id: input.listingId,
      expected_revision: BigInt(input.expectedRevision),
      delta,
      idempotency_key: input.idempotencyKey,
    },
  };
}

function syncManyHttpOk(status: unknown): boolean {
  if (typeof status === 'number') return status >= 200 && status < 300;
  if (typeof status === 'bigint') return status >= BigInt(200) && status < BigInt(300);
  if (typeof status === 'string') {
    if (status === 'success' || status === 'ok') return true;
    const parsed = Number(status);
    return Number.isInteger(parsed) && parsed >= 200 && parsed < 300;
  }
  return false;
}

function syncManyItemError(item: Record<string, unknown>): string {
  const result = asObject(item.result);
  const error = asObject(result?.error) ?? asObject(item.error);
  return asString(error?.message) ?? asString(item.message) ?? 'Published, not yet registered for checkout';
}

/** Classify one 207 `listing.sync_many` result. HTTP 207 is the envelope, not success. */
export function classifySyncManyItem(item: unknown): { listingId: string | null; ok: boolean; message: string } {
  const object = asObject(item);
  if (!object) {
    return { listingId: null, ok: false, message: 'The service returned an invalid sync result.' };
  }
  const listingId = asString(object.listing_id);
  if (syncManyHttpOk(object.status)) {
    return { listingId, ok: true, message: 'Synced' };
  }
  return { listingId, ok: false, message: syncManyItemError(object) };
}

function classifyClientError(error: PubkyShopError): InventoryBoardLoad['status'] | 'revision_conflict' {
  if (MarketplaceShopClientService.isSessionRejected(error)) return 'session-required';
  if (MarketplaceShopClientService.isCapabilityRequired(error)) return 'grant-needed';
  if (MarketplaceShopClientService.isRevisionConflict(error)) return 'revision_conflict';
  return 'error';
}

export class CommerceInventoryApplication {
  private constructor() {}

  static restoreInventorySession(pubky: string) {
    return MarketplaceInventorySessionService.restorePersistedSession(pubky);
  }

  static clearInventorySession(): void {
    MarketplaceInventorySessionService.clearSession('cleared');
  }

  static clearInventorySessionForSignOut(): void {
    MarketplaceInventorySessionService.clearForSignOut();
  }

  static clearInventorySessionsOfOtherAccounts(keepPubky: string): void {
    MarketplaceInventorySessionService.clearOtherAccounts(keepPubky);
  }

  static onInventorySessionEnded(
    listener: Parameters<typeof MarketplaceInventorySessionService.onSessionEnded>[0],
  ): () => void {
    return MarketplaceInventorySessionService.onSessionEnded(listener);
  }

  static beginInventorySessionFlow(expectedPubky: string) {
    return MarketplaceInventorySessionService.beginInventorySessionFlow(expectedPubky);
  }

  static async loadBoard(sellerPubky: string): Promise<InventoryBoardLoad> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      return { status: 'durable-unavailable' };
    }
    if (!sellerPubky) {
      return { status: 'unauthenticated' };
    }
    if (!MarketplaceSessionService.getActiveSession()) {
      return { status: 'session-required' };
    }
    const inventory = MarketplaceInventorySessionService.getCoveringBearer(sellerPubky);
    if (!inventory) {
      return { status: 'grant-needed' };
    }

    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    const rows: InventoryBoardRow[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await MarketplaceShopClientService.listSellerListings(client, sellerPubky, {
        limit: 100,
        cursor,
      });
      if (!page.ok) {
        return this.boardError(page.error, inventory);
      }
      const listings = page.value.listings;
      if (!Array.isArray(listings)) {
        return { status: 'error', message: 'The service returned an invalid listings page.' };
      }
      for (const entry of listings) {
        const object = asObject(entry);
        if (!object) continue;
        const projection = asObject(object.projection);
        const record = asObject(object.record);
        const listingId = asString(projection?.listing_id) ?? asString(record?.listingId);
        if (!listingId) continue;
        const unlimited = exportRecordIsUnlimited(record);
        const aggregateId =
          asString(projection?.aggregate_id) ?? buildMarketplaceListingAggregateId(sellerPubky, listingId);
        const inventoryResult = await MarketplaceShopClientService.getInventoryProjection(client, aggregateId);
        if (!inventoryResult.ok) {
          if (MarketplaceShopClientService.isCapabilityRequired(inventoryResult.error)) {
            return { status: 'grant-needed' };
          }
          if (MarketplaceShopClientService.isSessionRejected(inventoryResult.error)) {
            MarketplaceInventorySessionService.clearRejectedBearer(inventory);
            return { status: 'grant-needed' };
          }
          rows.push({
            listingId,
            sellerPubky,
            aggregateId,
            title: asString(projection?.title) ?? asString(record?.title) ?? listingId,
            thumbUrl: thumbUrl(record),
            state: asString(projection?.state) ?? 'unknown',
            format: asString(projection?.sale_format) ?? asString(asObject(record?.sale)?.format) ?? 'fixed_price',
            dropId: dropIdFromRecord(record),
            available: asInt(projection?.available_quantity) ?? 0,
            reserved: asInt(projection?.reserved_quantity) ?? 0,
            sold: asInt(projection?.sold_quantity) ?? 0,
            total: asInt(projection?.total_quantity) ?? 0,
            serverRevision: asInt(projection?.server_revision) ?? 0,
            ...(unlimited ? { unlimited: true as const } : {}),
            sync: 'missing',
            ...(recordStatusFromExport(object) ? { recordStatus: 'unavailable' as const } : {}),
          });
          continue;
        }
        const stock = inventoryResult.value.stock;
        rows.push({
          listingId,
          sellerPubky,
          aggregateId,
          title: asString(projection?.title) ?? asString(record?.title) ?? listingId,
          thumbUrl: thumbUrl(record),
          state: asString(projection?.state) ?? 'unknown',
          format: asString(projection?.sale_format) ?? asString(asObject(record?.sale)?.format) ?? 'fixed_price',
          dropId: dropIdFromRecord(record),
          available: Number(stock.available),
          reserved: Number(stock.reserved),
          sold: Number(stock.sold),
          total: Number(stock.total),
          serverRevision: Number(inventoryResult.value.server_revision),
          ...(unlimited ? { unlimited: true as const } : {}),
          sync: 'synced',
          ...(recordStatusFromExport(object) ? { recordStatus: 'unavailable' as const } : {}),
        });
      }
      const next = asString(page.value.next_cursor);
      if (!next) break;
      cursor = next;
    }
    if (rows.length === 0) {
      return { status: 'empty', rows: [] };
    }
    return { status: 'ready', rows };
  }

  static async setAvailable(input: {
    sellerPubky: string;
    row: InventoryBoardRow;
    targetAvailable: number;
    idempotencyKey: string;
  }): Promise<InventorySetResult> {
    const inventory = MarketplaceInventorySessionService.getCoveringBearer(input.sellerPubky);
    if (!inventory) {
      return { status: 'grant-needed' };
    }
    const plan = planInventoryAdjust({
      listingId: input.row.listingId,
      aggregateId: input.row.aggregateId,
      currentAvailable: input.row.available,
      targetAvailable: input.targetAvailable,
      expectedRevision: input.row.serverRevision,
      idempotencyKey: input.idempotencyKey,
    });
    if (!plan.ok) {
      return { status: 'error', message: plan.reason };
    }
    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    const result = await MarketplaceShopClientService.adjustInventory(client, plan.request);
    if (!result.ok) {
      const classified = classifyClientError(result.error);
      if (classified === 'grant-needed') {
        if (MarketplaceShopClientService.isSessionRejected(result.error)) {
          MarketplaceInventorySessionService.clearRejectedBearer(inventory);
        }
        return { status: 'grant-needed' };
      }
      if (classified === 'revision_conflict') {
        return { status: 'revision_conflict' };
      }
      if (classified === 'session-required') {
        MarketplaceInventorySessionService.clearRejectedBearer(inventory);
        return { status: 'grant-needed' };
      }
      return { status: 'error', message: result.error.message };
    }
    const stock = result.value.result.stock;
    return {
      status: 'updated',
      row: {
        ...input.row,
        available: Number(stock.available),
        reserved: Number(stock.reserved),
        sold: Number(stock.sold),
        total: Number(stock.total),
        serverRevision: Number(result.value.result.server_revision),
        sync: 'synced',
      },
    };
  }

  static async retrySync(sellerPubky: string, listingId: string): Promise<InventoryRetryResult> {
    const inventory = MarketplaceInventorySessionService.getCoveringBearer(sellerPubky);
    if (!inventory) return { status: 'grant-needed' };
    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    const result = await MarketplaceShopClientService.syncMany(client, [
      { seller_pubky: sellerPubky, listing_id: listingId },
    ]);
    if (!result.ok) {
      const classified = classifyClientError(result.error);
      if (classified === 'grant-needed' || classified === 'session-required') {
        if (MarketplaceShopClientService.isSessionRejected(result.error)) {
          MarketplaceInventorySessionService.clearRejectedBearer(inventory);
        }
        return { status: 'grant-needed' };
      }
      return { status: 'error', message: result.error.message };
    }
    const items = Array.isArray(result.value.results) ? result.value.results : [];
    const match = items.map((item) => classifySyncManyItem(item)).find((item) => item.listingId === listingId);
    if (!match) {
      return {
        status: 'missing',
        listingId,
        message: 'The service did not return a sync result for this listing.',
      };
    }
    if (match.ok) {
      return { status: 'synced', listingId };
    }
    return { status: 'missing', listingId, message: match.message };
  }

  private static boardError(error: PubkyShopError, bearer: InventoryBearer): InventoryBoardLoad {
    const classified = classifyClientError(error);
    if (classified === 'grant-needed') return { status: 'grant-needed' };
    if (classified === 'session-required') {
      MarketplaceInventorySessionService.clearRejectedBearer(bearer);
      return { status: 'grant-needed' };
    }
    return { status: 'error', message: error.message };
  }

  static requireDurable(): void {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Inventory Studio requires the durable transaction service.', {
        service: ErrorService.Marketplace,
        operation: 'inventory',
      });
    }
  }
}
