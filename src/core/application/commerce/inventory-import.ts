import { CommerceApplication } from '@/application/commerce/commerce';
import {
  type CanonicalImportRow,
  listingToCanonicalRows,
  mapCanonicalRowsToListing,
} from '@/application/commerce/inventory-listing-map';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import type { CommerceListingRecord } from '@/libs/commerce/marketplace-records';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { isAppError, isNotFound } from '@/libs/error/error.utils';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import {
  DexieManifestStore,
  type HostImportCheckpoint,
  type HostPlannedImportRow,
  type InventoryManifestStore,
  isManifestConflict,
} from '@/services/marketplace/marketplace-import-store';
import { MarketplaceInventorySessionService } from '@/services/marketplace/marketplace-inventory-session';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import {
  type CanonicalCsvRow,
  type CurrentImportItem,
  type DryRunCounts,
  type ImportManifest,
  MarketplaceShopClientService,
  PubkyShopError,
  type SdkResult,
  SHOPIFY_CSV_PRICE,
  type SyncManyEnvelope,
  type SyncManyListing,
} from '@/services/marketplace/marketplace-shop-client';

export const IMPORT_PARSE_FAIL_COPY = 'This file could not be planned. Nothing was published.';
export const IMPORT_CONFLICT_COPY =
  'This listing changed since the plan. Confirm or discard; it will not be overwritten.';
export const IMPORT_MIXED_COPY = 'Some listings synced; some did not. Resume publishes only the unfinished rows.';
export const CONFLICT_CONFIRMED = 'conflict_confirmed';
export const CONFLICT_DISCARDED = 'conflict_discarded';

export type InventoryImportAuth =
  | { status: 'durable-unavailable' }
  | { status: 'unauthenticated' }
  | { status: 'session-required' }
  | { status: 'grant-needed' }
  | { status: 'ready' };

export type InventoryImportPlanResult =
  | { status: 'planned'; manifestId: string; rowCount: number; counts: DryRunCounts }
  | { status: 'parse-failed'; message: string; puts: 0 }
  | Exclude<InventoryImportAuth, { status: 'ready' }>
  | { status: 'error'; message: string };

export type InventoryImportPublishResult =
  | {
      status: 'complete';
      published: number;
      synced: number;
      failed: number;
      mixed: boolean;
      message?: string;
    }
  | { status: 'conflict'; listingId: string; message: string }
  | { status: 'rate-limited'; message: string }
  | Exclude<InventoryImportAuth, { status: 'ready' }>
  | { status: 'error'; message: string };

export type InventoryImportConflictAckResult =
  | InventoryImportPublishResult
  | { status: 'planned'; manifestId: string; rowCount: number; counts: DryRunCounts };

export type InventoryImportHost = {
  readonly sellerPubky: string;
  readonly store: InventoryManifestStore;
  planFile: (
    file: Parameters<typeof MarketplaceShopClientService.planBrowserFile>[0],
    store: InventoryManifestStore,
    currentItems: Readonly<Record<string, CurrentImportItem>>,
  ) => Promise<SdkResult<{ manifestId: string; rowCount: number }>>;
  putListing: (record: CommerceListingRecord) => Promise<void>;
  listingExists: (url: string) => Promise<boolean>;
  syncMany: (listings: readonly SyncManyListing[]) => Promise<SdkResult<SyncManyEnvelope>>;
  currentItems: () => Promise<Readonly<Record<string, CurrentImportItem>>>;
};

function csvCell(value: string): string {
  const prefixed = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${prefixed.replaceAll('"', '""')}"`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resumeNext(checkpoint: HostImportCheckpoint): 'publish' | 'reconcile_publish' | 'sync_service' | 'none' {
  if (checkpoint === 'planned') return 'publish';
  if (checkpoint === 'publishing') return 'reconcile_publish';
  if (checkpoint === 'published_unsynced') return 'sync_service';
  return 'none';
}

function payloadRow(json: string): CanonicalImportRow | null {
  try {
    const parsed: unknown = JSON.parse(json);
    const object = asObject(parsed);
    if (!object) return null;
    return parsed as CanonicalImportRow;
  } catch {
    return null;
  }
}

const ADDRESS_KEYS = new Set([
  'address',
  'shippingAddress',
  'shipping_address',
  'deliveryAddress',
  'delivery_address',
  'buyerAddress',
  'buyer_address',
]);

function stripAddresses(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAddresses);
  const object = asObject(value);
  if (!object) return value;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (ADDRESS_KEYS.has(key)) continue;
    next[key] = stripAddresses(entry);
  }
  return next;
}

export class CommerceInventoryImportApplication {
  private constructor(private readonly host: InventoryImportHost) {}

  static authStatus(sellerPubky: string): InventoryImportAuth {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return { status: 'durable-unavailable' };
    if (!sellerPubky) return { status: 'unauthenticated' };
    if (!MarketplaceSessionService.getActiveSession()) return { status: 'session-required' };
    if (!MarketplaceInventorySessionService.getCoveringBearer(sellerPubky)) return { status: 'grant-needed' };
    return { status: 'ready' };
  }

  static createHost(sellerPubky: string, overrides: Partial<InventoryImportHost> = {}): InventoryImportHost {
    const store = overrides.store ?? new DexieManifestStore(sellerPubky);
    return {
      sellerPubky,
      store,
      planFile:
        overrides.planFile ??
        ((file, manifestStore, currentItems) =>
          MarketplaceShopClientService.planBrowserFile(file, manifestStore, currentItems, {
            sellerPubky,
            currency: SHOPIFY_CSV_PRICE.currency,
            exponent: SHOPIFY_CSV_PRICE.exponent,
          })),
      putListing: overrides.putListing ?? CommerceApplication.putPublicListingForImport.bind(CommerceApplication),
      listingExists: overrides.listingExists ?? ((url) => CommerceHomeserverService.exists(url)),
      syncMany:
        overrides.syncMany ??
        (async (listings) => {
          const inventory = MarketplaceInventorySessionService.getCoveringBearer(sellerPubky);
          if (!inventory) {
            return {
              ok: false,
              error: new PubkyShopError('session_rejected'),
            };
          }
          const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
          return MarketplaceShopClientService.syncMany(client, listings);
        }),
      currentItems:
        overrides.currentItems ??
        (async () => {
          const listings = await LocalCommerceService.getListingsBySeller(sellerPubky);
          return MarketplaceShopClientService.currentItemsFromRows(
            listings.flatMap((listing) => listingToCanonicalRows(listing.record)),
          );
        }),
    };
  }

  static forSeller(
    sellerPubky: string,
    overrides: Partial<InventoryImportHost> = {},
  ): CommerceInventoryImportApplication {
    return new CommerceInventoryImportApplication(this.createHost(sellerPubky, overrides));
  }

  async planFile(
    file: Parameters<typeof MarketplaceShopClientService.planBrowserFile>[0],
  ): Promise<InventoryImportPlanResult> {
    const auth = CommerceInventoryImportApplication.authStatus(this.host.sellerPubky);
    if (auth.status !== 'ready') return auth;
    await this.host.store.pruneExpired();
    const currentItems = await this.host.currentItems();
    const planned = await this.host.planFile(file, this.host.store, currentItems);
    if (!planned.ok) {
      return {
        status: 'parse-failed',
        message: MarketplaceShopClientService.formatPlanFailure(planned.error),
        puts: 0,
      };
    }
    const manifest = await this.host.store.load(planned.value.manifestId);
    if (!manifest) {
      return { status: 'parse-failed', message: IMPORT_PARSE_FAIL_COPY, puts: 0 };
    }
    return {
      status: 'planned',
      manifestId: planned.value.manifestId,
      rowCount: planned.value.rowCount,
      counts: MarketplaceShopClientService.dryRunCounts(manifest as ImportManifest),
    };
  }

  async dryRun(manifestId: string): Promise<DryRunCounts | null> {
    const manifest = await this.host.store.load(manifestId);
    if (!manifest) return null;
    return MarketplaceShopClientService.dryRunCounts(manifest as ImportManifest);
  }

  async publish(manifestId: string): Promise<InventoryImportPublishResult> {
    const auth = CommerceInventoryImportApplication.authStatus(this.host.sellerPubky);
    if (auth.status !== 'ready') return auth;
    return this.resume(manifestId);
  }

  async resume(manifestId: string): Promise<InventoryImportPublishResult> {
    const auth = CommerceInventoryImportApplication.authStatus(this.host.sellerPubky);
    if (auth.status !== 'ready') return auth;
    const loaded = await this.host.store.load(manifestId);
    if (!loaded) return { status: 'error', message: 'The import plan is missing.' };

    let published = 0;
    const pendingSync: SyncManyListing[] = [];
    const groups = this.groups(loaded.rows);
    let conflictListingId: string | null = null;

    for (const [listingId, group] of groups) {
      const actionable = group.filter((row) => resumeNext(row.checkpoint) !== 'none');
      if (actionable.length === 0) continue;
      if (group.some((row) => isConflictRow(row))) {
        if (group.every((row) => isAcknowledgedConflict(row) || !isConflictRow(row))) continue;
        conflictListingId ??= listingId;
        continue;
      }
      if (group.every((row) => row.intendedAction === 'unchanged')) continue;

      const needsPut = actionable.some((row) => {
        const next = resumeNext(row.checkpoint);
        return next === 'publish' || next === 'reconcile_publish';
      });
      const needsSync = actionable.some((row) => resumeNext(row.checkpoint) === 'sync_service') || needsPut;

      if (needsPut) {
        const put = await this.publishGroup(manifestId, listingId, group);
        if (put.status === 'conflict' || put.status === 'error') return put;
        published += 1;
      }
      if (needsSync) {
        pendingSync.push({ seller_pubky: this.host.sellerPubky, listing_id: listingId });
      }
    }

    const sync = await this.syncPending(manifestId, pendingSync);
    if (sync.status === 'rate-limited' || sync.status === 'error') return sync;

    const finalManifest = await this.host.store.load(manifestId);
    const rows = finalManifest?.rows ?? [];
    const synced = rows.filter((row) => row.checkpoint === 'complete').length;
    const failed = rows.filter((row) => row.checkpoint === 'failed').length;
    const unfinished = rows.some((row) => resumeNext(row.checkpoint) !== 'none' && row.checkpoint !== 'conflict');
    const mixed = (synced > 0 && failed > 0) || unfinished;
    if (conflictListingId && published === 0 && synced === 0) {
      return { status: 'conflict', listingId: conflictListingId, message: IMPORT_CONFLICT_COPY };
    }
    return {
      status: 'complete',
      published,
      synced,
      failed,
      mixed: mixed || conflictListingId !== null,
      ...(mixed || conflictListingId ? { message: conflictListingId ? IMPORT_CONFLICT_COPY : IMPORT_MIXED_COPY } : {}),
    };
  }

  async confirmConflict(manifestId: string, listingId: string): Promise<InventoryImportConflictAckResult> {
    await this.acknowledgeConflict(manifestId, listingId, 'confirm');
    return this.afterConflictAck(manifestId);
  }

  async discardConflict(manifestId: string, listingId: string): Promise<InventoryImportConflictAckResult> {
    await this.acknowledgeConflict(manifestId, listingId, 'discard');
    return this.afterConflictAck(manifestId);
  }

  async exportListingsCsv(): Promise<Uint8Array> {
    const rows: CanonicalCsvRow[] = [];
    const inventory = MarketplaceInventorySessionService.getCoveringBearer(this.host.sellerPubky);
    if (!inventory) {
      const local = await LocalCommerceService.getListingsBySeller(this.host.sellerPubky);
      return MarketplaceShopClientService.exportListingsCsv(
        local.flatMap((listing) => listingToCanonicalRows(listing.record)),
      );
    }
    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    let cursor: string | undefined;
    for (;;) {
      const page = await MarketplaceShopClientService.listSellerListings(client, this.host.sellerPubky, {
        limit: 100,
        cursor,
      });
      if (!page.ok) break;
      const listings = page.value.listings;
      if (Array.isArray(listings)) {
        for (const entry of listings) {
          const object = asObject(entry);
          const record = object?.record;
          if (!record || typeof record !== 'object') continue;
          try {
            rows.push(...listingToCanonicalRows(record as CommerceListingRecord));
          } catch {
            continue;
          }
        }
      }
      const next = typeof page.value.next_cursor === 'string' ? page.value.next_cursor : null;
      if (!next) break;
      cursor = next;
    }
    return MarketplaceShopClientService.exportListingsCsv(rows);
  }

  async exportOrdersJson(): Promise<string> {
    const inventory = MarketplaceInventorySessionService.getCoveringBearer(this.host.sellerPubky);
    if (!inventory) return '[]';
    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    const collected: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await MarketplaceShopClientService.listSellerOrders(client, this.host.sellerPubky, {
        limit: 100,
        cursor,
      });
      if (!page.ok) break;
      const orders = page.value.orders;
      if (Array.isArray(orders)) collected.push(...orders.map(stripAddresses));
      const next = typeof page.value.next_cursor === 'string' ? page.value.next_cursor : null;
      if (!next) break;
      cursor = next;
    }
    return JSON.stringify(collected);
  }

  async resultCsv(manifestId: string): Promise<string> {
    const manifest = await this.host.store.load(manifestId);
    const lines = ['listing_id,row_identity,checkpoint,result'];
    for (const row of manifest?.rows ?? []) {
      const result = row.checkpoint === 'complete' ? 'synced' : (row.failureCode ?? row.checkpoint);
      lines.push([row.listingId, row.rowIdentity, row.checkpoint, result].map(csvCell).join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  private async afterConflictAck(manifestId: string): Promise<InventoryImportConflictAckResult> {
    const loaded = await this.host.store.load(manifestId);
    if (!loaded) return { status: 'error', message: 'The import plan is missing.' };
    const started = loaded.rows.some((row) => publishHadStarted(row));
    if (started) return this.resume(manifestId);
    const unresolved = firstUnresolvedConflict(this.groups(loaded.rows));
    if (unresolved) {
      return { status: 'conflict', listingId: unresolved, message: IMPORT_CONFLICT_COPY };
    }
    return {
      status: 'planned',
      manifestId,
      rowCount: loaded.rowCount,
      counts: remainingDryRunCounts(loaded.rows),
    };
  }

  private async acknowledgeConflict(manifestId: string, listingId: string, kind: 'confirm' | 'discard'): Promise<void> {
    const loaded = await this.host.store.load(manifestId);
    if (!loaded) return;
    const groups = this.groups(loaded.rows);
    const targetId = listingId || firstUnresolvedConflict(groups);
    if (!targetId) return;
    const group = groups.get(targetId);
    if (!group) return;
    const failureCode = kind === 'confirm' ? CONFLICT_CONFIRMED : CONFLICT_DISCARDED;
    const preferred: HostImportCheckpoint = kind === 'confirm' ? 'conflict' : 'failed';
    for (const row of group) {
      if (isAcknowledgedConflict(row)) continue;
      if (row.checkpoint !== 'conflict') {
        const hop = nextAllowedCheckpoint(row.checkpoint, preferred);
        if (hop !== null) {
          await this.checkpointRow(manifestId, row.rowIdentity, hop);
        }
      }
      await this.annotateRowFailure(manifestId, row.rowIdentity, failureCode);
    }
  }

  private async annotateRowFailure(manifestId: string, rowIdentity: string, failureCode: string): Promise<void> {
    for (;;) {
      const manifest = await this.host.store.load(manifestId);
      if (!manifest) return;
      const row = manifest.rows.find((entry) => entry.rowIdentity === rowIdentity);
      if (!row || row.failureCode === failureCode) return;
      try {
        await this.host.store.compareAndSwap(manifestId, manifest.manifestVersion, (current) => ({
          ...current,
          manifestVersion: current.manifestVersion + 1,
          rows: current.rows.map((entry) => (entry.rowIdentity === rowIdentity ? { ...entry, failureCode } : entry)),
        }));
        return;
      } catch (error) {
        if (!isManifestConflict(error)) return;
      }
    }
  }

  private async checkpointRow(
    manifestId: string,
    rowIdentity: string,
    checkpoint: HostImportCheckpoint,
  ): Promise<void> {
    for (;;) {
      const manifest = await this.host.store.load(manifestId);
      if (!manifest) return;
      const row = manifest.rows.find((entry) => entry.rowIdentity === rowIdentity);
      if (!row || row.checkpoint === checkpoint) return;
      const hop = nextAllowedCheckpoint(row.checkpoint, checkpoint);
      if (hop === null) return;
      const result = await MarketplaceShopClientService.checkpointRow(
        this.host.store,
        manifestId,
        manifest.manifestVersion,
        row.rowIdentity,
        hop,
      );
      if (!result.ok) return;
    }
  }

  private groups(rows: readonly HostPlannedImportRow[]): Map<string, HostPlannedImportRow[]> {
    const groups = new Map<string, HostPlannedImportRow[]>();
    for (const row of rows) {
      const current = groups.get(row.listingId) ?? [];
      current.push(row);
      groups.set(row.listingId, current);
    }
    return groups;
  }

  private async publishGroup(
    manifestId: string,
    listingId: string,
    group: readonly HostPlannedImportRow[],
  ): Promise<
    { status: 'ok' } | { status: 'conflict'; listingId: string; message: string } | { status: 'error'; message: string }
  > {
    const reconcile = group.some((row) => resumeNext(row.checkpoint) === 'reconcile_publish');
    const url = CommerceRecordNormalizer.listingUri(this.host.sellerPubky, listingId);
    if (reconcile) {
      const exists = await this.host.listingExists(url);
      if (exists) {
        await this.checkpointGroup(manifestId, listingId, 'published_unsynced');
        return { status: 'ok' };
      }
    }

    const payloads: CanonicalImportRow[] = [];
    for (const row of group) {
      const json = await this.host.store.getPayloadJson(manifestId, row.rowIdentity);
      if (!json) {
        return { status: 'error', message: IMPORT_PARSE_FAIL_COPY };
      }
      const parsed = payloadRow(json);
      if (!parsed) return { status: 'error', message: IMPORT_PARSE_FAIL_COPY };
      payloads.push(parsed);
    }
    const mapped = mapCanonicalRowsToListing(payloads, this.host.sellerPubky);
    if (!mapped.ok) {
      await this.checkpointGroup(manifestId, listingId, 'failed');
      return { status: 'error', message: mapped.message };
    }

    await this.checkpointGroup(manifestId, listingId, 'publishing');
    try {
      await this.host.putListing(mapped.record);
    } catch (error) {
      if (isAppError(error) && error.code === ClientErrorCode.CONFLICT) {
        await this.checkpointGroup(manifestId, listingId, 'conflict');
        return { status: 'conflict', listingId, message: IMPORT_CONFLICT_COPY };
      }
      if (isAppError(error) && isNotFound(error)) {
        await this.checkpointGroup(manifestId, listingId, 'failed');
        return { status: 'error', message: error.message };
      }
      await this.checkpointGroup(manifestId, listingId, 'failed');
      return { status: 'error', message: error instanceof Error ? error.message : IMPORT_PARSE_FAIL_COPY };
    }
    await this.checkpointGroup(manifestId, listingId, 'published_unsynced');
    return { status: 'ok' };
  }

  private async syncPending(
    manifestId: string,
    listings: readonly SyncManyListing[],
  ): Promise<
    | { status: 'ok'; synced: number; failed: number }
    | { status: 'rate-limited'; message: string }
    | { status: 'error'; message: string }
  > {
    let synced = 0;
    let failed = 0;
    for (const chunk of MarketplaceShopClientService.chunkSyncMany(listings)) {
      if (chunk.length === 0) continue;
      const result = await this.host.syncMany(chunk);
      if (!result.ok) {
        if (MarketplaceShopClientService.isRateLimited(result.error)) {
          return { status: 'rate-limited', message: MarketplaceShopClientService.formatRateLimitCopy(result.error) };
        }
        return { status: 'error', message: result.error.message };
      }
      const items = Array.isArray(result.value.results) ? result.value.results : [];
      const classified = items.map((item) => MarketplaceShopClientService.classifySyncItem(item));
      for (const listing of chunk) {
        const match = classified.find((item) => item.listingId === listing.listing_id);
        if (match?.ok) {
          await this.checkpointGroup(manifestId, listing.listing_id, 'complete');
          synced += 1;
        } else {
          // Leave published_unsynced so resume retries sync without a second PUT.
          failed += 1;
        }
      }
    }
    return { status: 'ok', synced, failed };
  }

  private async checkpointGroup(
    manifestId: string,
    listingId: string,
    checkpoint: HostImportCheckpoint,
  ): Promise<void> {
    for (;;) {
      const manifest = await this.host.store.load(manifestId);
      if (!manifest) return;
      const row = manifest.rows.find((entry) => entry.listingId === listingId && entry.checkpoint !== checkpoint);
      if (!row) return;
      const hop = nextAllowedCheckpoint(row.checkpoint, checkpoint);
      if (hop === null) return;
      const result = await MarketplaceShopClientService.checkpointRow(
        this.host.store,
        manifestId,
        manifest.manifestVersion,
        row.rowIdentity,
        hop,
      );
      if (!result.ok) return;
    }
  }
}

const CHECKPOINT_HOPS: Readonly<Record<HostImportCheckpoint, readonly HostImportCheckpoint[]>> = {
  planned: ['publishing', 'conflict', 'failed'],
  publishing: ['published_unsynced', 'conflict', 'failed'],
  published_unsynced: ['complete', 'conflict', 'failed'],
  complete: [],
  conflict: [],
  failed: ['publishing', 'conflict'],
};

function isConflictRow(row: HostPlannedImportRow): boolean {
  return row.checkpoint === 'conflict' || row.intendedAction === 'conflict';
}

function isAcknowledgedConflict(row: HostPlannedImportRow): boolean {
  return (
    row.failureCode === CONFLICT_CONFIRMED || row.failureCode === CONFLICT_DISCARDED || row.checkpoint === 'failed'
  );
}

function publishHadStarted(row: HostPlannedImportRow): boolean {
  if (row.checkpoint === 'publishing' || row.checkpoint === 'published_unsynced' || row.checkpoint === 'complete') {
    return true;
  }
  return (row.checkpoint === 'conflict' || row.checkpoint === 'failed') && row.intendedAction !== 'conflict';
}

function remainingDryRunCounts(rows: readonly HostPlannedImportRow[]): DryRunCounts {
  const counts = { create: 0, update: 0, end: 0, unchanged: 0, conflict: 0 };
  for (const row of rows) {
    if (isAcknowledgedConflict(row)) continue;
    if (row.intendedAction === 'create') counts.create += 1;
    else if (row.intendedAction === 'update') counts.update += 1;
    else if (row.intendedAction === 'end') counts.end += 1;
    else if (row.intendedAction === 'unchanged') counts.unchanged += 1;
    else if (row.intendedAction === 'conflict') counts.conflict += 1;
  }
  return counts;
}

function firstUnresolvedConflict(groups: Map<string, HostPlannedImportRow[]>): string | null {
  for (const [listingId, group] of groups) {
    if (group.some((row) => isConflictRow(row) && !isAcknowledgedConflict(row))) return listingId;
  }
  return null;
}

function nextAllowedCheckpoint(from: HostImportCheckpoint, target: HostImportCheckpoint): HostImportCheckpoint | null {
  const allowed = CHECKPOINT_HOPS[from];
  if (allowed.includes(target)) return target;
  if (target === 'published_unsynced' && allowed.includes('publishing')) return 'publishing';
  if (target === 'complete' && allowed.includes('published_unsynced')) return 'published_unsynced';
  if (target === 'complete' && allowed.includes('publishing')) return 'publishing';
  if (target === 'published_unsynced' && allowed.includes('failed')) return null;
  return null;
}
