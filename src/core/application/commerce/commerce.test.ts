import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TagKind } from '@/application/tag/tag.types';
import * as commerceConfig from '@/config/commerce';
import { COMMERCE_LISTING_MAX_QUANTITY } from '@/config/commerce';
import { NEXUS_LISTINGS_PER_PAGE } from '@/config/nexus';
import { bumpAuthEpoch } from '@/controllers/auth/auth-epoch';
import { CommerceController } from '@/controllers/commerce/commerce';
import { marketplaceCommandResponseSchema } from '@/libs/commerce/transaction-commands';
import { UNLIMITED_STOCK_REFUSAL, UNLIMITED_STOCK_RESERVED_MESSAGE } from '@/libs/commerce/unlimited-stock';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import { AuthErrorCode, ClientErrorCode, ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { httpStatusCodeToError } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import {
  CommerceCatalogEntryModel,
  CommerceListingModel,
  CommerceShopModel,
  CommerceSyncJobModel,
} from '@/models/commerce/commerce.models';
import { isListingRegistrationPending, LISTING_READ_BACK_PENDING_WINDOW_MS } from '@/models/commerce/commerce.schema';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { LocalMarketplaceTagService } from '@/services/local/tag/marketplace/tag.marketplace';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { NexusMarketplaceService } from '@/services/nexus/marketplace/marketplace';
import type { NexusListingDetails } from '@/services/nexus/marketplace/marketplace.types';
import { useAuthStore } from '@/stores/auth/auth.store';
import {
  COMMERCE_FIXTURE_SELLER,
  createCommerceCatalogEntryFixture,
  createCommerceListingFixture,
  createCommerceShopFixture,
  createNexusAuctionListingDetailsFixture,
  createNexusListingDetailsFixture,
} from '@/test/fixtures/commerce/commerce';
import { toCommerceListingModel } from '@/test/fixtures/commerce/listing-models';
import { installWebLocks, removeWebLocks } from '@/test-utils/web-locks';
import { CommerceApplication, LISTING_REGISTRATION_LOCK_PREFIX } from './commerce';

const SHOP_URL = `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/shop.json`;
const LISTING_URL = `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/listings/boots_01`;
const LISTING_REGISTERED_RESPONSE = {
  ok: true as const,
  version: 1 as const,
  commandId: '00000000-0000-4000-8000-000000000901',
  aggregateId: `listing:${COMMERCE_FIXTURE_SELLER}_boots_01`,
  revision: 1,
  eventIds: [],
  result: { kind: 'listing' as const },
};
const listingRegisteredResponse = (command: { commandId: string; aggregateId: string }) => ({
  ...LISTING_REGISTERED_RESPONSE,
  commandId: command.commandId,
  aggregateId: command.aggregateId,
});
// Service refusal of a registration with no homeserver record, as built by
// pubky-marketplace-service 14dca9c (`register_listing.rs` `record_not_found`,
// `result.rs` `CommandFailure::body`): HTTP 404. Derived from the service
// source and its test, not a live capture.
const LISTING_RECORD_NOT_FOUND_WIRE = {
  ok: false,
  error: { code: 'NOT_FOUND', message: "The seller's homeserver has no such listing record." },
};
const LISTING_RECORD_NOT_FOUND_RESPONSE = marketplaceCommandResponseSchema.parse(
  toCamelCaseWire(LISTING_RECORD_NOT_FOUND_WIRE),
);
const isRegistrationLock = (name: string) => name.startsWith(LISTING_REGISTRATION_LOCK_PREFIX);
/** Records every Web Lock request, with the names already held when it was made. */
const recordLockRequests = () => {
  const granting = (navigator as Navigator & { locks: { request: (...args: unknown[]) => Promise<unknown> } }).locks;
  const requested: string[] = [];
  const nested: Array<{ requested: string; held: string[] }> = [];
  const held: string[] = [];
  const request = async (name: string, ...rest: unknown[]) => {
    requested.push(name);
    if (held.length > 0) nested.push({ requested: name, held: [...held] });
    const callback = rest[rest.length - 1] as (lock: unknown) => Promise<unknown>;
    const options = rest.length > 1 ? rest[0] : {};
    return await granting.request(name, options, async (lock: unknown) => {
      if (!lock) return await callback(lock);
      held.push(name);
      try {
        return await callback(lock);
      } finally {
        held.splice(held.indexOf(name), 1);
      }
    });
  };
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return Object.assign(requested, { nested });
};
/** Serves the listing's record from the seller's homeserver; every other URL keeps the default mock. */
const publishOnHomeserver = (record: ReturnType<typeof createCommerceListingFixture>) => {
  const fallback = vi.mocked(CommerceHomeserverService.fetchJson).getMockImplementation();
  const url = CommerceRecordNormalizer.listingUri(record.ownerPubky, record.listingId);
  vi.mocked(CommerceHomeserverService.fetchJson).mockImplementation(async (requested, logUrl) =>
    requested === url ? record : fallback!(requested, logUrl),
  );
};
const LIVE_SELFHEAL_FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../test/fixtures/commerce/live/shop-v32-selfheal.json'), 'utf8'),
) as { sync: unknown };
const SELLER_REFRESH_FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../test/fixtures/commerce/live/seller-dashboard-refresh-v23.json'), 'utf8'),
) as {
  nexus: NexusListingDetails[];
  canonical: Array<{ record: unknown; provenance: { contentSha256: string; sourceUri: string } }>;
  provenance: {
    capturedAtUtc: string;
    sourceManifestSha256: string;
    nexusInventoryWholeFileSha256: string;
    stableContentHashEncoding: string;
    sources: Record<string, { wholeFileSha256: string; contentSha256: string }>;
  };
};

describe('CommerceApplication', () => {
  beforeEach(() => {
    installWebLocks();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async (url) => {
      if (vi.isMockFunction(CommerceHomeserverService.putJson)) {
        const latest = vi
          .mocked(CommerceHomeserverService.putJson)
          .mock.calls.toReversed()
          .find(([writtenUrl]) => writtenUrl === url);
        if (latest) return latest[1];
      }
      throw Err.client(ClientErrorCode.NOT_FOUND, 'Not found', {
        service: ErrorService.Homeserver,
        operation: 'fetchJson',
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeWebLocks();
    useAuthStore.getState().setCurrentUserPubky(null);
  });

  it('pins repaired fixture provenance and canonical content hashes', () => {
    expect(SELLER_REFRESH_FIXTURE.provenance).toMatchObject({
      capturedAtUtc: '2026-09-11T13:00:05.111Z',
      sourceManifestSha256: '75bbbe4c5d3b4ae160589ffb25c3cbaf7df63b3ae1b07129887d891248455a42',
      nexusInventoryWholeFileSha256: 'b899f0ca780dda0d226c7140b393818fd873f8acfb0006bd05d037d7d4ecc4b0',
    });
    expect(SELLER_REFRESH_FIXTURE.provenance.sources).toEqual({
      offer: {
        wholeFileSha256: '01bfd471185db06f79bb148df4009a946e51c09e8fa83d582e144bd4b8ae5439',
        contentSha256: '4a200919c86eb6450f2d6cc15d5adc2e25422d39f9911a6a5e21d04a025924d0',
      },
      verify: {
        wholeFileSha256: '6dc57c5fed7da1914efe30600decc9e8030c2e8ca65b44725f32d163e75fdf48',
        contentSha256: 'be1b2a4e6d02998cc446080eadf037bfc2bb2e5cc6ddfd0b540906323a84502e',
      },
      casio: {
        wholeFileSha256: '4b4d25a821683373f0717ed0cd2457696c5b630802e36f9519b08b4cda50155c',
        contentSha256: '055c7270893b0fc45837b0b4235b82f4ed689c6a733330f059566145d0845171',
      },
    });

    const sourceByListingId = {
      c73b6be3ab4642539c69a797f9006dcb: 'offer',
      '45b2aedff744407ea2d67c8069ed112e': 'verify',
      aa2c8b308dbc47619793fe64dcefa9e8: 'casio',
    } as const;
    for (const { record, provenance } of SELLER_REFRESH_FIXTURE.canonical) {
      const listingRecord = record as { listingId: keyof typeof sourceByListingId };
      const source = SELLER_REFRESH_FIXTURE.provenance.sources[sourceByListingId[listingRecord.listingId]];
      expect(createHash('sha256').update(JSON.stringify(record)).digest('hex')).toBe(provenance.contentSha256);
      expect(provenance.contentSha256).toBe(source.contentSha256);
    }

    const tampered = { ...(SELLER_REFRESH_FIXTURE.canonical[0].record as Record<string, unknown>), title: 'tampered' };
    expect(createHash('sha256').update(JSON.stringify(tampered)).digest('hex')).not.toBe(
      SELLER_REFRESH_FIXTURE.provenance.sources.offer.contentSha256,
    );
  });

  it('parses the captured production listing sync response', () => {
    const parsed = marketplaceCommandResponseSchema.safeParse(toCamelCaseWire(LIVE_SELFHEAL_FIXTURE.sync));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      ok: true,
      revision: 3,
      result: { kind: 'listing' },
    });
  });

  it('returns a local shop without a network request', async () => {
    const record = createCommerceShopFixture();
    vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(
      new CommerceShopModel({
        id: COMMERCE_FIXTURE_SELLER,
        owner_id: COMMERCE_FIXTURE_SELLER,
        record,
        revision: 1,
        sync_status: 'synced',
        updated_at: Date.parse(record.updatedAt),
      }),
    );
    const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson');

    await expect(CommerceApplication.getOrFetchShop(COMMERCE_FIXTURE_SELLER)).resolves.toEqual(record);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it.each([
    { available: 0, expected: 0 },
    { available: 2, expected: 2 },
  ])('derives purchasable inventory without rewriting the signed record', async ({ available, expected }) => {
    const record = createCommerceListingFixture({
      variants: [{ ...createCommerceListingFixture().variants[0], quantity: 3 }],
    });
    const model = toCommerceListingModel(record);
    vi.spyOn(LocalCommerceService, 'getListingsBySeller').mockResolvedValue([model]);
    vi.spyOn(LocalCommerceService, 'getListingProjection').mockResolvedValue({
      id: model.id,
      seller_id: model.seller_id,
      listing_id: model.listing_id,
      listing_revision: record.revision,
      content_hash: record.media[0].contentHash,
      server_revision: 2,
      state: available === 0 ? 'sold' : 'available',
      available_quantity: available,
      current_price: record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice,
      auction_state: null,
      bid_count: 0,
      sync_status: 'synced',
      synced_at: Date.now(),
    });

    const [listing] = await CommerceApplication.getListingsBySeller(record.ownerPubky);

    expect(listing.purchasableQuantity).toBe(expected);
    expect(listing.record.variants[0].quantity).toBe(3);
  });

  it('keeps the original quantity in the homeserver write after reading projected inventory', async () => {
    const record = createCommerceListingFixture({
      variants: [{ ...createCommerceListingFixture().variants[0], quantity: 3 }],
    });
    const model = toCommerceListingModel(record);
    vi.spyOn(LocalCommerceService, 'getListingsBySeller').mockResolvedValue([model]);
    vi.spyOn(LocalCommerceService, 'getListingProjection').mockResolvedValue({
      id: model.id,
      seller_id: model.seller_id,
      listing_id: model.listing_id,
      listing_revision: record.revision,
      content_hash: record.media[0].contentHash,
      server_revision: 2,
      state: 'available',
      available_quantity: 0,
      current_price: record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice,
      auction_state: null,
      bid_count: 0,
      sync_status: 'synced',
      synced_at: Date.now(),
    });
    const [listing] = await CommerceApplication.getListingsBySeller(record.ownerPubky);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.mocked(CommerceHomeserverService.fetchJson).mockResolvedValueOnce(record).mockResolvedValueOnce(record);
    vi.spyOn(LocalCommerceService, 'stageListingSync');
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');

    await CommerceApplication.commitUpsertListing({
      ...listing.record,
      revision: listing.record.revision + 1,
      state: 'paused',
      updatedAt: new Date().toISOString(),
    });

    expect(put.mock.calls[0][1]).toMatchObject({ variants: [{ quantity: 3 }] });
  });

  it('does not derive availability from a stale projection revision', async () => {
    const record = createCommerceListingFixture();
    const model = toCommerceListingModel(record);
    vi.spyOn(LocalCommerceService, 'getListingsBySeller').mockResolvedValue([model]);
    vi.spyOn(LocalCommerceService, 'getListingProjection').mockResolvedValue({
      id: model.id,
      seller_id: model.seller_id,
      listing_id: model.listing_id,
      listing_revision: record.revision - 1,
      content_hash: record.media[0].contentHash,
      server_revision: 2,
      state: 'sold',
      available_quantity: 0,
      current_price: record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice,
      auction_state: null,
      bid_count: 0,
      sync_status: 'synced',
      synced_at: Date.now(),
    });

    const [listing] = await CommerceApplication.getListingsBySeller(record.ownerPubky);

    expect(listing.purchasableQuantity).toBeNull();
  });

  it('seeds catalog data only when sandbox mode is explicit', async () => {
    const seed = vi.spyOn(LocalCommerceService, 'seedSandboxCatalog').mockResolvedValue(true);
    vi.spyOn(CommerceApplication, 'ensureListingRegistered').mockResolvedValue(true);
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');

    await expect(CommerceApplication.initializeSandboxCatalog()).resolves.toBe(false);
    expect(seed).not.toHaveBeenCalled();

    vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('sandbox');
    await expect(CommerceApplication.initializeSandboxCatalog()).resolves.toBe(true);
    expect(seed).toHaveBeenCalledOnce();
  });

  it('does not report sandbox success when another catalog prevents seeding', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    vi.spyOn(LocalCommerceService, 'seedSandboxCatalog').mockResolvedValue(false);
    vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(null);
    const register = vi.spyOn(CommerceApplication, 'ensureListingRegistered').mockResolvedValue(true);

    await expect(CommerceApplication.initializeSandboxCatalog()).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('reports sandbox setup failure when listings cannot register for checkout', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    vi.spyOn(LocalCommerceService, 'seedSandboxCatalog').mockResolvedValue(true);
    vi.spyOn(CommerceApplication, 'ensureListingRegistered').mockResolvedValue(false);

    await expect(CommerceApplication.initializeSandboxCatalog()).rejects.toMatchObject({
      code: ServerErrorCode.SERVICE_UNAVAILABLE,
    });
  });

  it('fetches, validates, and caches a missing shop', async () => {
    const record = createCommerceShopFixture();
    vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(null);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(record);
    const upsert = vi.spyOn(LocalCommerceService, 'upsertShop').mockResolvedValue(undefined);

    await expect(CommerceApplication.getOrFetchShop(COMMERCE_FIXTURE_SELLER)).resolves.toEqual(record);
    expect(upsert).toHaveBeenCalledWith(record, 'synced');
  });

  it('fetches, validates, and caches a missing listing', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(null);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(record);
    const upsert = vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);

    await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).resolves.toEqual(record);
    expect(CommerceHomeserverService.fetchJson).toHaveBeenCalledWith(LISTING_URL);
    expect(upsert).toHaveBeenCalledWith(record, 'synced');
  });

  it('stages a shop locally before publishing and then clears its job', async () => {
    const record = createCommerceShopFixture();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('018f47d2-6a27-7c23-a49d-6b21bb770120');
    const stage = vi.spyOn(LocalCommerceService, 'stageShopSync').mockResolvedValue(undefined);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    const upsert = vi.spyOn(LocalCommerceService, 'upsertShop').mockResolvedValue(undefined);
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);

    await CommerceApplication.commitUpsertShop(record);

    expect(stage).toHaveBeenCalledWith(
      record,
      expect.objectContaining({
        id: '018f47d2-6a27-7c23-a49d-6b21bb770120',
        entity_type: 'shop',
        entity_id: COMMERCE_FIXTURE_SELLER,
        operation: 'publish',
        status: 'pending',
        payload: { url: SHOP_URL },
      }),
    );
    expect(stage.mock.invocationCallOrder[0]).toBeLessThan(put.mock.invocationCallOrder[0]);
    expect(put).toHaveBeenCalledWith(SHOP_URL, record);
    expect(upsert).toHaveBeenCalledWith(record, 'synced');
    expect(complete).toHaveBeenCalledWith('018f47d2-6a27-7c23-a49d-6b21bb770120');
  });

  it('leaves a staged shop pending when the homeserver write fails', async () => {
    const record = createCommerceShopFixture();
    vi.spyOn(LocalCommerceService, 'stageShopSync').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'putJson').mockRejectedValue(new TypeError('network unavailable'));
    const upsert = vi.spyOn(LocalCommerceService, 'upsertShop');
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob');

    await expect(CommerceApplication.commitUpsertShop(record)).rejects.toThrow('network unavailable');
    expect(upsert).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('publishes a listing and registers it with the transaction service in sandbox mode', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    const stage = vi.spyOn(LocalCommerceService, 'stageListingSync');
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    const execute = vi
      .spyOn(MarketplaceGatewayService, 'execute')
      .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));

    await CommerceApplication.commitUpsertListing(record);

    expect(stage).toHaveBeenCalledWith(record, expect.objectContaining({ operation: 'publish' }), 'unregistered');
    expect(execute).toHaveBeenCalledWith(
      record.ownerPubky,
      expect.objectContaining({
        kind: 'listing.register',
        payload: expect.objectContaining({
          sellerPubky: record.ownerPubky,
          listingId: record.listingId,
          listingRevision: record.revision,
        }),
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  // Digital delivery design §6 A1–A4: the register payload's methods mirror
  // the service's own derivation of the record.
  it.each([
    [['digital'], false, ['digital']],
    [['physical', 'shipping', 'digital'], false, ['shipping', 'digital']],
    [['pickup', 'digital'], false, ['pickup', 'digital']],
    [['digital'], true, ['shipping']],
  ] as const)('register_accepts_digital_method: %j (lock %s) registers %j', async (methods, locks, expected) => {
    const physical = (methods as readonly string[]).includes('physical');
    const base = createCommerceListingFixture();
    const record = createCommerceListingFixture({
      fulfillmentMethods: [...methods],
      package: physical ? base.package : undefined,
      shippingOptions: physical ? base.shippingOptions : [],
      ...(locks
        ? {
            digitalLock: {
              policyUri: `pubky://${COMMERCE_FIXTURE_SELLER}/pub/locks.app/boots_01.json`,
              criterionId: 'criterion-1',
              contentPath: 'premium.txt',
              resourceHash: 'b'.repeat(64),
              minimumConfirmations: 6,
            },
          }
        : {}),
    });
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    vi.spyOn(LocalCommerceService, 'stageListingSync');
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    const execute = vi
      .spyOn(MarketplaceGatewayService, 'execute')
      .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));

    await CommerceApplication.commitUpsertListing(record);

    expect(execute).toHaveBeenCalledWith(
      record.ownerPubky,
      expect.objectContaining({
        kind: 'listing.register',
        payload: expect.objectContaining({ fulfillmentMethods: [...expected] }),
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('registers a sandbox auction with an explicit null private reserve', async () => {
    const record = createCommerceListingFixture();
    record.sale = {
      format: 'auction',
      startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      startsAt: '2026-08-19T20:00:00.000Z',
      endsAt: '2026-08-29T20:00:00.000Z',
      antiSnipingWindowSeconds: 120,
      antiSnipingExtensionSeconds: 120,
    };
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    vi.spyOn(LocalCommerceService, 'stageListingSync');
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    const execute = vi
      .spyOn(MarketplaceGatewayService, 'execute')
      .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));

    await CommerceApplication.commitUpsertListing(record);

    expect(execute).toHaveBeenCalledWith(
      record.ownerPubky,
      expect.objectContaining({
        payload: expect.objectContaining({
          auctionReserve: {
            expectedRecordRevision: 0,
            recordRevision: 1,
            reservePrice: null,
          },
        }),
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('persists registered after a successful publish and never sends registration_status to the homeserver', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementation(async (_actor, command) =>
      listingRegisteredResponse(command),
    );

    await expect(CommerceApplication.commitUpsertListing(record)).resolves.toEqual({
      registered: true,
      verified: true,
    });

    expect(put.mock.calls[0][1]).not.toHaveProperty('registration_status');
    await expect(LocalCommerceService.getListing(`${record.ownerPubky}:${record.listingId}`)).resolves.toMatchObject({
      registration_status: 'registered',
      sync_status: 'synced',
    });
  });

  it('scrubs nested public reserve keys and reuses the verified private reserve on retry', async () => {
    const listing = createCommerceListingFixture();
    listing.sale = {
      format: 'auction',
      startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      buyNowPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
      minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      startsAt: '2026-08-19T20:00:00.000Z',
      endsAt: '2026-08-29T20:00:00.000Z',
      antiSnipingWindowSeconds: 120,
      antiSnipingExtensionSeconds: 120,
    };
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    const reserve = { amountMinor: 8_000, currency: 'USD', exponent: 2 };
    vi.spyOn(MarketplaceGatewayService, 'getSellerListing')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        serverRevision: 7,
        reserveRecordRevision: 0,
        reservePrice: reserve,
      } as never)
      .mockResolvedValue(null);
    const publicProjection = vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    const execute = vi
      .spyOn(MarketplaceGatewayService, 'execute')
      .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));
    const writes: Array<[string, Record<string, unknown>]> = [];
    vi.spyOn(CommerceHomeserverService, 'putJson').mockImplementation(async (url, body) => {
      writes.push([url, body]);
    });
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async (url) => {
      const written = writes.toReversed().find(([writtenUrl]) => writtenUrl === url);
      if (written) return written[1];
      if (url.includes('/auction_reserves/')) {
        throw Err.client(ClientErrorCode.NOT_FOUND, 'Not found', {
          service: ErrorService.Homeserver,
          operation: 'fetchJson',
        });
      }
      return {
        ...listing,
        media: listing.media.map((entry) => ({ ...entry, futureMedia: { keep: null } })),
        variants: listing.variants.map((entry) => ({ ...entry, futureVariant: ['keep'] })),
        shippingOptions: listing.shippingOptions.map((entry) => ({ ...entry, futureShipping: { keep: true } })),
        futureField: { keep: true, nested: [{ reserve_price: null, keepToo: 'yes' }] },
      };
    });
    await expect(CommerceApplication.commitUpsertListing(listing, reserve)).resolves.toEqual({
      registered: true,
      verified: true,
    });
    await expect(CommerceApplication.commitUpsertListing(listing)).resolves.toEqual({
      registered: true,
      verified: true,
    });

    const privateWrites = writes.filter(([url]) => url.includes('/auction_reserves/'));
    const publicWrites = writes.filter(([url]) => url.includes('/pub/'));
    expect(privateWrites).toHaveLength(0);
    expect(publicWrites).toHaveLength(1);
    expect(publicWrites[0][1]).toMatchObject({
      media: [{ futureMedia: { keep: null } }],
      variants: [{ futureVariant: ['keep'] }],
      shippingOptions: [{ futureShipping: { keep: true } }],
      futureField: { keep: true, nested: [{ keepToo: 'yes' }] },
    });
    expect(JSON.stringify(publicWrites)).not.toMatch(/reserve(?:Price|_price|Met|_met)/);
    expect(execute.mock.calls[0][1]).toMatchObject({
      kind: 'listing.register',
      payload: {
        auctionTerms: expect.not.objectContaining({ reservePrice: expect.anything() }),
        auctionReserve: { expectedRecordRevision: 0, recordRevision: 1, reservePrice: reserve },
      },
    });
    expect(execute.mock.calls[1][1].commandId).toBe(execute.mock.calls[0][1].commandId);
    expect(execute.mock.calls[1][1].issuedAt).toBe(execute.mock.calls[0][1].issuedAt);
    expect(execute.mock.calls[1][1].expectedRevision).toBe(execute.mock.calls[0][1].expectedRevision);
    expect(execute.mock.calls[1][1].payload).toMatchObject({
      auctionReserve: (execute.mock.calls[0][1].payload as { auctionReserve: unknown }).auctionReserve,
    });
    expect(publicProjection).not.toHaveBeenCalled();

    vi.mocked(CommerceApplication.hasActiveMarketplaceSession).mockReturnValue(true);
    await expect(
      CommerceApplication.commitUpsertListing(listing, {
        amountMinor: reserve.amountMinor + 1_000,
        currency: reserve.currency,
        exponent: reserve.exponent,
      }),
    ).rejects.toMatchObject({ code: ClientErrorCode.CONFLICT });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('refuses a public PUT when the fresh listing revision is not the expected base', async () => {
    const record = createCommerceListingFixture();
    record.revision = 2;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue({ ...record, revision: 3 });
    const put = vi.spyOn(CommerceHomeserverService, 'putJson');

    await expect(CommerceApplication.commitUpsertListing(record)).rejects.toMatchObject({
      code: ClientErrorCode.CONFLICT,
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a public PUT when the listing changes after the fresh base GET', async () => {
    const record = createCommerceListingFixture();
    const base = { ...record };
    record.revision = 2;
    record.title = 'Seller edit';
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
    vi.spyOn(CommerceHomeserverService, 'fetchJson')
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({ ...base, title: 'Concurrent edit' });
    const put = vi.spyOn(CommerceHomeserverService, 'putJson');

    await expect(CommerceApplication.commitUpsertListing(record)).rejects.toMatchObject({
      code: ClientErrorCode.CONFLICT,
    });
    expect(put).not.toHaveBeenCalled();
  });

  // Production 2026-09-30: a seller's publish wrote the record (it indexed a
  // second later), but the verify read ran 410ms after the write and got a
  // 404 — so the app reported "Could not publish this listing." and the seller
  // nearly re-posted a live listing as a duplicate. An acked write that reads
  // back late is a truth to report, never a publish to fail. The read-back
  // retries run on real, fixed short waits here (250ms / 500ms / 1s) — no fake
  // timers, which the fake-IndexedDB stack does not survive.
  describe('the acked-write read-back', () => {
    const missing = () =>
      Err.client(ClientErrorCode.NOT_FOUND, 'Not found', {
        service: ErrorService.Homeserver,
        operation: 'fetchJson',
      });
    const publishableSession = () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
      vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
      vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementation(async (_actor, command) =>
        listingRegisteredResponse(command),
      );
    };

    it('confirms the publish once a lagging read-back catches up', async () => {
      const record = createCommerceListingFixture();
      publishableSession();
      vi.spyOn(CommerceHomeserverService, 'fetchJson')
        .mockRejectedValueOnce(missing()) // pre-write read: nothing published yet
        .mockRejectedValueOnce(missing()) // fresh-base read before the PUT
        .mockRejectedValueOnce(missing()) // read-back: the acked write is not visible yet
        .mockResolvedValueOnce({ ...record }); // read-back retry: now visible

      await expect(CommerceApplication.commitUpsertListing(record)).resolves.toEqual({
        registered: true,
        verified: true,
      });
    });

    it('reports an acked publish as unverified, never as failed, while the homeserver has not served it back', async () => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      publishableSession();
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async () => {
        throw missing();
      });

      // The registration precheck would read the same lag as a deleted record,
      // so the listing is left pending instead of being registered or dropped.
      await expect(CommerceApplication.commitUpsertListing(record)).resolves.toEqual({
        registered: false,
        verified: false,
      });
      expect(MarketplaceGatewayService.execute).not.toHaveBeenCalled();
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        sync_status: 'synced',
        registration_status: 'unregistered',
        read_back_pending_since: expect.any(Number),
      });

      // The owner surface's first heal still reads a 404 through its retries: lag, not a deletion.
      const readsBeforeHeal = fetchJson.mock.calls.length;
      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
      expect(fetchJson.mock.calls.length - readsBeforeHeal).toBe(4);
      expect(MarketplaceGatewayService.execute).not.toHaveBeenCalled();
      const afterFirstHeal = await LocalCommerceService.getListing(listingId);
      expect(afterFirstHeal).toMatchObject({
        registration_status: 'unregistered',
        read_back_pending_since: expect.any(Number),
      });
      expect(isListingRegistrationPending(afterFirstHeal!)).toBe(true);

      fetchJson.mockResolvedValue({ ...record });
      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(true);
      expect(MarketplaceGatewayService.execute).toHaveBeenCalledOnce();
      const registered = await LocalCommerceService.getListing(listingId);
      expect(registered).toMatchObject({ registration_status: 'registered' });
      expect(registered?.read_back_pending_since).toBeUndefined();
    });

    it('settles a remote deletion as authoritative once the read-back window has passed', async () => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      publishableSession();
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async () => {
        throw missing();
      });
      await expect(CommerceApplication.commitUpsertListing(record)).resolves.toEqual({
        registered: false,
        verified: false,
      });
      const pendingSince = (await LocalCommerceService.getListing(listingId))?.read_back_pending_since;
      expect(pendingSince).toEqual(expect.any(Number));

      // Another device deletes the record, so every read keeps answering 404; within the window that is lag.
      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'unregistered',
      });

      vi.spyOn(Date, 'now').mockReturnValue(pendingSince! + LISTING_READ_BACK_PENDING_WINDOW_MS);
      const readsBeforeExpiredHeal = fetchJson.mock.calls.length;
      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
      expect(fetchJson.mock.calls.length - readsBeforeExpiredHeal).toBe(1);
      expect(MarketplaceGatewayService.execute).not.toHaveBeenCalled();
      await expect(LocalCommerceService.getListing(listingId)).resolves.toBeNull();
    });

    it('keeps an unconfirmed publish pending when the service cannot read the record yet either', async () => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      publishableSession();
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async () => {
        throw missing();
      });
      await expect(CommerceApplication.commitUpsertListing(record)).resolves.toEqual({
        registered: false,
        verified: false,
      });

      fetchJson.mockResolvedValue({ ...record });
      vi.mocked(MarketplaceGatewayService.execute).mockResolvedValueOnce(LISTING_RECORD_NOT_FOUND_RESPONSE);
      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'unregistered',
        read_back_pending_since: expect.any(Number),
      });

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(true);
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'registered',
      });
    });

    it('still refuses when the homeserver serves a record that is not what the seller wrote', async () => {
      const record = createCommerceListingFixture();
      publishableSession();
      vi.spyOn(CommerceHomeserverService, 'fetchJson')
        .mockRejectedValueOnce(missing())
        .mockRejectedValueOnce(missing())
        .mockResolvedValueOnce({ ...record, title: 'Not the record the seller signed' });

      await expect(CommerceApplication.commitUpsertListing(record)).rejects.toMatchObject({
        code: ServerErrorCode.INVALID_RESPONSE,
        message: 'The published listing did not match the verified candidate.',
      });
    });
  });

  // Sol round 3: the unlimited cap is refused on physical stock where every
  // Shop publisher writes or registers a listing, not only in the form.
  describe('the shared stock publish rule', () => {
    const atCap = (overrides: Parameters<typeof createCommerceListingFixture>[0] = {}) => {
      const record = createCommerceListingFixture(overrides);
      record.variants = record.variants.map((variant) => ({ ...variant, quantity: COMMERCE_LISTING_MAX_QUANTITY }));
      return record;
    };
    const refused = { context: { refusal: UNLIMITED_STOCK_REFUSAL }, message: UNLIMITED_STOCK_RESERVED_MESSAGE };

    it('refuses to publish a physical listing at the cap before staging or writing anything', async () => {
      const record = atCap();
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      const put = vi.spyOn(CommerceHomeserverService, 'putJson');

      await expect(CommerceApplication.commitUpsertListing(record)).rejects.toMatchObject(refused);
      expect(CommerceHomeserverService.fetchJson).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      await expect(LocalCommerceService.getListing(`${record.ownerPubky}:${record.listingId}`)).resolves.toBeFalsy();
    });

    it('refuses the Inventory Studio write of a physical listing at the cap', async () => {
      const put = vi.spyOn(CommerceHomeserverService, 'putJson');

      await expect(CommerceApplication.putPublicListingForImport(atCap())).rejects.toMatchObject(refused);
      expect(put).not.toHaveBeenCalled();
    });

    it('sends no registration for a physical listing at the cap', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const getListing = vi.spyOn(MarketplaceGatewayService, 'getListing');
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

      await expect(CommerceApplication.ensureListingRegistered(atCap())).resolves.toBe(false);
      expect(getListing).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('still writes a digital-only listing at the cap, which is how Unlimited is stored', async () => {
      const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);

      await CommerceApplication.putPublicListingForImport(
        atCap({ fulfillmentMethods: ['digital'], package: undefined, shippingOptions: [] }),
      );
      expect(put).toHaveBeenCalledTimes(1);
    });
  });

  it('reads the reserve from the service, writes no private copy, and deletes the seller file', async () => {
    const listing = createCommerceListingFixture();
    listing.revision = 2;
    listing.sale = {
      format: 'auction',
      startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      startsAt: '2026-08-19T20:00:00.000Z',
      endsAt: '2026-08-29T20:00:00.000Z',
      antiSnipingWindowSeconds: 120,
      antiSnipingExtensionSeconds: 120,
    };
    const fileReserve = { amountMinor: 8_000, currency: 'USD', exponent: 2 };
    const serviceReserve = { amountMinor: 9_000, currency: 'USD', exponent: 2 };
    const reserveUrl = CommerceRecordNormalizer.auctionReserveUri(listing.ownerPubky, listing.listingId);
    const privateRecord = {
      schemaVersion: 1,
      recordType: 'auction_reserve',
      ownerPubky: listing.ownerPubky,
      listingId: listing.listingId,
      listingRevision: 1,
      recordRevision: 1,
      writeId: '00000000-0000-4000-8000-000000000001',
      reservePrice: fileReserve,
      createdAt: listing.createdAt,
      updatedAt: listing.updatedAt,
    };
    useAuthStore.getState().setCurrentUserPubky(listing.ownerPubky);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'listAll').mockResolvedValue([
      reserveUrl,
      `${reserveUrl}/nested.json`,
      'pubky://other/priv/pubky.app/marketplace/v1/auction_reserves/other.json',
    ]);
    const remove = vi.spyOn(CommerceHomeserverService, 'delete').mockResolvedValue(undefined);
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    vi.spyOn(MarketplaceGatewayService, 'getSellerListing').mockResolvedValue({
      serverRevision: 4,
      reserveRecordRevision: 1,
      reservePrice: serviceReserve,
      lastReserveCommandId: privateRecord.writeId,
    } as never);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async (url) => {
      if (url.includes('/auction_reserves/')) return privateRecord;
      const written = put.mock.calls.toReversed().find(([writtenUrl]) => writtenUrl === url);
      if (written) return written[1];
      return { ...listing, revision: 1 };
    });
    const execute = vi
      .spyOn(MarketplaceGatewayService, 'execute')
      .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));

    await expect(CommerceApplication.commitUpsertListing(listing)).resolves.toEqual({
      registered: true,
      verified: true,
    });

    expect(put.mock.calls.map(([url]) => url).some((url) => url.includes('/auction_reserves/'))).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(reserveUrl);
    expect(execute.mock.calls[0][1].payload).toMatchObject({
      auctionReserve: {
        expectedRecordRevision: 1,
        recordRevision: 2,
        reservePrice: serviceReserve,
      },
    });
  });

  it('still registers when deleting the old reserve file fails', async () => {
    const listing = createCommerceListingFixture();
    listing.sale = {
      format: 'auction',
      startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      startsAt: '2026-08-19T20:00:00.000Z',
      endsAt: '2026-08-29T20:00:00.000Z',
      antiSnipingWindowSeconds: 120,
      antiSnipingExtensionSeconds: 120,
    };
    const reserveUrl = CommerceRecordNormalizer.auctionReserveUri(listing.ownerPubky, listing.listingId);
    useAuthStore.getState().setCurrentUserPubky(listing.ownerPubky);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'listAll').mockResolvedValue([reserveUrl]);
    vi.spyOn(CommerceHomeserverService, 'delete').mockRejectedValue(new TypeError('delete failed'));
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    vi.spyOn(MarketplaceGatewayService, 'getSellerListing').mockResolvedValue(null);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    const execute = vi
      .spyOn(MarketplaceGatewayService, 'execute')
      .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));

    await expect(CommerceApplication.commitUpsertListing(listing, null)).resolves.toEqual({
      registered: true,
      verified: true,
    });

    expect(put.mock.calls.map(([url]) => url).some((url) => url.includes('/auction_reserves/'))).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('persists unregistered after registration rejects and stamps registered on a successful retry', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    const execute = vi
      .spyOn(MarketplaceGatewayService, 'execute')
      .mockRejectedValueOnce(new Error('registration unavailable'))
      .mockImplementationOnce(async (_actor, command) => listingRegisteredResponse(command));

    await expect(CommerceApplication.commitUpsertListing(record)).resolves.toEqual({
      registered: false,
      verified: true,
    });
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'unregistered',
    });

    await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(true);
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'registered',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('stages unregistered before the homeserver write and keeps it persisted while registration is pending', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    let releaseRegistration: (() => void) | undefined;
    let registrationCommand: { commandId: string; aggregateId: string } | undefined;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementation(
      (_actor, command) =>
        new Promise((resolve) => {
          registrationCommand = command;
          releaseRegistration = () => resolve(listingRegisteredResponse(registrationCommand!));
        }),
    );

    const publish = CommerceApplication.commitUpsertListing(record);
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'unregistered',
    });

    releaseRegistration?.();
    await expect(publish).resolves.toEqual({ registered: true, verified: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('registers a legacy listing with an undefined status and stamps it registered', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    publishOnHomeserver(record);
    await LocalCommerceService.upsertListing(record, 'synced');
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: undefined,
    });
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementation(async (_actor, command) =>
      listingRegisteredResponse(command),
    );

    await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(true);
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'registered',
    });
  });

  it('sends nothing for a listing with no local row, and creates none', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    publishOnHomeserver(record);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    const execute = vi
      .spyOn(MarketplaceGatewayService, 'execute')
      .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));

    await expect(LocalCommerceService.getListing(listingId)).resolves.toBeNull();
    await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
    await expect(LocalCommerceService.getListing(listingId)).resolves.toBeNull();
  });

  it.each(['ALREADY_EXISTS', 'ALREADY_REGISTERED', 'UNCHANGED', 'NO_OP'])(
    'treats %s from listing.sync as registered for a legacy listing',
    async (code) => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      publishOnHomeserver(record);
      await LocalCommerceService.upsertListing(record, 'synced');
      vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue({ serverRevision: 3 } as never);
      vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({
        ok: false,
        error: { code, message: 'The listing is already registered.' },
      });

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(true);
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'registered',
      });
    },
  );

  it('rejects a benign listing.sync response for another aggregate', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    publishOnHomeserver(record);
    await LocalCommerceService.upsertListing(record, 'synced');
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue({ serverRevision: 3 } as never);
    vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({
      ok: false,
      aggregateId: 'listing:another-seller_other-listing',
      error: { code: 'NO_OP', message: 'Already converged.' },
    });

    await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'unregistered',
    });
  });

  it('confirms a benign listing.register response with a fresh listing GET', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    publishOnHomeserver(record);
    await LocalCommerceService.upsertListing(record, 'synced');
    const getListing = vi
      .spyOn(MarketplaceGatewayService, 'getListing')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ serverRevision: 1 } as never);
    vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({
      ok: false,
      error: { code: 'ALREADY_EXISTS', message: 'Already registered.' },
    });

    await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(true);
    expect(getListing).toHaveBeenCalledTimes(2);
    expect(getListing).toHaveBeenNthCalledWith(
      2,
      record.ownerPubky,
      `listing:${record.ownerPubky}_${record.listingId}`,
      { signal: expect.any(AbortSignal) },
    );
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'registered',
    });
  });

  it('keeps a listing unregistered when confirming a benign listing.register response throws', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    publishOnHomeserver(record);
    await LocalCommerceService.upsertListing(record, 'synced');
    vi.spyOn(MarketplaceGatewayService, 'getListing')
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new TypeError('confirmation unavailable'));
    vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({
      ok: false,
      error: { code: 'ALREADY_EXISTS', message: 'Already registered.' },
    });

    await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'unregistered',
    });
  });

  it('refuses a benign listing.register response when the confirming listing GET is empty', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    publishOnHomeserver(record);
    await LocalCommerceService.upsertListing(record, 'synced');
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({
      ok: false,
      error: { code: 'NO_OP', message: 'Already converged.' },
    });

    await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'unregistered',
    });
  });

  it('keeps a legacy listing unregistered after a real listing.sync refusal', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    publishOnHomeserver(record);
    await LocalCommerceService.upsertListing(record, 'synced');
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue({ serverRevision: 3 } as never);
    vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'The listing is invalid.' },
    });

    await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'unregistered',
    });
  });

  it('rejects a successful listing.sync response for another aggregate', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    publishOnHomeserver(record);
    await LocalCommerceService.upsertListing(record, 'synced');
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue({ serverRevision: 3 } as never);
    vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({
      ...LISTING_REGISTERED_RESPONSE,
      aggregateId: 'listing:another-seller_other-listing',
    });

    await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'unregistered',
    });
  });

  it.each([
    ['session rejection', () => Promise.reject(new Error('SESSION_EXPIRED'))],
    [
      'forbidden',
      () =>
        Promise.resolve({
          ok: false as const,
          error: { code: 'FORBIDDEN', message: 'The actor cannot register this listing.' },
        }),
    ],
    [
      'revision conflict on a real edit',
      () =>
        Promise.resolve({
          ok: false as const,
          error: { code: 'REVISION_CONFLICT', message: 'The listing revision is stale.', currentRevision: 4 },
        }),
    ],
    ['5xx', () => Promise.reject(new Error('Marketplace request failed with status 503'))],
    ['malformed/non-JSON body', () => Promise.reject(new Error('Invalid marketplace command response'))],
  ] as const)('leaves registration unregistered after %s', async (_name, result) => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    publishOnHomeserver(record);
    await LocalCommerceService.upsertListing(record, 'synced');
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementation(() => result());

    await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'unregistered',
    });
  });

  describe('a listing the seller deleted', () => {
    it('sends nothing when the service has no aggregate and the homeserver record is gone, and drops the local copy', async () => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      await LocalCommerceService.upsertListing(record, 'synced');
      const getListing = vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
      const execute = vi
        .spyOn(MarketplaceGatewayService, 'execute')
        .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);

      expect(CommerceHomeserverService.fetchJson).toHaveBeenCalledWith(LISTING_URL);
      expect(getListing).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      await expect(LocalCommerceService.getListing(listingId)).resolves.toBeNull();

      // A surface still holding the stale record retries: still nothing is sent, nothing is re-created.
      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
      expect(execute).not.toHaveBeenCalled();
      await expect(LocalCommerceService.getListing(listingId)).resolves.toBeNull();
    });

    it('sends no auction registration when the homeserver record is gone', async () => {
      const record = createCommerceListingFixture();
      record.sale = {
        format: 'auction',
        startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        startsAt: '2026-08-19T20:00:00.000Z',
        endsAt: '2026-08-29T20:00:00.000Z',
        antiSnipingWindowSeconds: 120,
        antiSnipingExtensionSeconds: 120,
      };
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      const sellerListing = vi.spyOn(MarketplaceGatewayService, 'getSellerListing').mockResolvedValue(null);
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);

      expect(sellerListing).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('keeps the listing pending when the homeserver read fails for another reason', async () => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      await LocalCommerceService.upsertListing(record, 'synced');
      vi.mocked(CommerceHomeserverService.fetchJson).mockRejectedValue(new TypeError('homeserver unreachable'));
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);

      expect(execute).not.toHaveBeenCalled();
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'unregistered',
      });
    });

    it.each([
      ['listing.register', null],
      ['listing.sync', { serverRevision: 3 }],
    ] as const)('stops the pending registration when the service answers NOT_FOUND to %s', async (kind, projection) => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      publishOnHomeserver(record);
      await LocalCommerceService.upsertListing(record, 'synced');
      vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(projection as never);
      const execute = vi
        .spyOn(MarketplaceGatewayService, 'execute')
        .mockResolvedValue(LISTING_RECORD_NOT_FOUND_RESPONSE);

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);

      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][1].kind).toBe(kind);
      const stored = await LocalCommerceService.getListing(listingId);
      expect(stored).toMatchObject({ registration_status: 'not_found' });
      expect(isListingRegistrationPending(stored!)).toBe(false);
    });

    it('marks a publish refused with NOT_FOUND as not pending, and a later publish retries registration', async () => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
      vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
      const execute = vi
        .spyOn(MarketplaceGatewayService, 'execute')
        .mockResolvedValueOnce(LISTING_RECORD_NOT_FOUND_RESPONSE)
        .mockImplementationOnce(async (_actor, command) => listingRegisteredResponse(command));

      await expect(CommerceApplication.commitUpsertListing(record)).resolves.toEqual({
        registered: false,
        verified: true,
      });
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'not_found',
      });

      const edited = { ...record, revision: record.revision + 1, updatedAt: new Date().toISOString() };
      await expect(CommerceApplication.commitUpsertListing(edited)).resolves.toEqual({
        registered: true,
        verified: true,
      });
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'registered',
      });
      expect(execute).toHaveBeenCalledTimes(2);
    });

    describe('races with a republish', () => {
      const homeserverNotFound = () =>
        Err.client(ClientErrorCode.NOT_FOUND, 'Not found', {
          service: ErrorService.Homeserver,
          operation: 'fetchJson',
        });

      /** Homeserver whose listing reads return the latest PUT, else the original record. */
      const homeserverWith = (
        record: ReturnType<typeof createCommerceListingFixture>,
        firstRead?: () => Promise<unknown>,
      ) => {
        const writes: Array<[string, Record<string, unknown>]> = [];
        vi.spyOn(CommerceHomeserverService, 'putJson').mockImplementation(async (url, body) => {
          writes.push([url, body]);
        });
        let reads = 0;
        vi.mocked(CommerceHomeserverService.fetchJson).mockImplementation(async (url) => {
          if (url !== LISTING_URL) throw homeserverNotFound();
          reads += 1;
          if (reads === 1 && firstRead) return await firstRead();
          return writes.toReversed().find(([writtenUrl]) => writtenUrl === url)?.[1] ?? record;
        });
      };

      it('a deletion read before a successful republish neither deletes nor parks the republished listing', async () => {
        const record = createCommerceListingFixture();
        const listingId = `${record.ownerPubky}:${record.listingId}`;
        vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
        vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
        await LocalCommerceService.upsertListing(record, 'synced');
        let releaseStaleRead: (() => void) | undefined;
        homeserverWith(record, async () => {
          await new Promise<void>((resolve) => {
            releaseStaleRead = resolve;
          });
          throw homeserverNotFound();
        });
        vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
        const execute = vi
          .spyOn(MarketplaceGatewayService, 'execute')
          .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));

        const staleAttempt = CommerceApplication.ensureListingRegistered(record);
        await vi.waitFor(() => expect(releaseStaleRead).toBeDefined());
        const republished = { ...record, revision: record.revision + 1, updatedAt: new Date().toISOString() };
        await expect(CommerceApplication.commitUpsertListing(republished)).resolves.toEqual({
          registered: true,
          verified: true,
        });
        releaseStaleRead!();
        await expect(staleAttempt).resolves.toBe(false);

        expect(execute).toHaveBeenCalledOnce();
        await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
          revision: republished.revision,
          sync_status: 'synced',
          registration_status: 'registered',
        });
      });

      it('a NOT_FOUND answered before a successful republish does not park the republished listing', async () => {
        const record = createCommerceListingFixture();
        const listingId = `${record.ownerPubky}:${record.listingId}`;
        vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
        vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
        await LocalCommerceService.upsertListing(record, 'synced');
        homeserverWith(record);
        vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
        let releaseStaleRefusal: (() => void) | undefined;
        vi.spyOn(MarketplaceGatewayService, 'execute')
          .mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
              releaseStaleRefusal = resolve;
            });
            return LISTING_RECORD_NOT_FOUND_RESPONSE;
          })
          .mockImplementationOnce(async (_actor, command) => listingRegisteredResponse(command));

        const requested = recordLockRequests();
        const staleAttempt = CommerceApplication.ensureListingRegistered(record);
        await vi.waitFor(() => expect(releaseStaleRefusal).toBeDefined());
        const republished = { ...record, revision: record.revision + 1, updatedAt: new Date().toISOString() };
        const republish = CommerceApplication.commitUpsertListing(republished);
        // The republish has staged, written and read back its record, and now waits for the stale attempt's lock.
        await vi.waitFor(() => expect(requested.filter(isRegistrationLock)).toHaveLength(2));
        releaseStaleRefusal!();
        await expect(staleAttempt).resolves.toBe(false);
        await expect(republish).resolves.toEqual({ registered: true, verified: true });

        await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
          revision: republished.revision,
          registration_status: 'registered',
        });
      });

      it.each([
        ['succeeds', true],
        ['fails', false],
      ] as const)(
        'an attempt that read no row and %s does not re-create the row after a create and a delete',
        async (_name, succeeds) => {
          const record = createCommerceListingFixture();
          const listingId = `${record.ownerPubky}:${record.listingId}`;
          vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
          vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
          let releaseRead: (() => void) | undefined;
          homeserverWith(record, async () => {
            await new Promise<void>((resolve) => {
              releaseRead = resolve;
            });
            return record;
          });
          vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
          const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementation(async (_actor, command) => {
            if (!succeeds) throw new TypeError('registration unavailable');
            return listingRegisteredResponse(command);
          });

          const staleAttempt = CommerceApplication.ensureListingRegistered(record);
          await vi.waitFor(() => expect(releaseRead).toBeDefined());
          await LocalCommerceService.upsertListing(record, 'synced');
          await LocalCommerceService.deleteListing(listingId);
          releaseRead!();
          await expect(staleAttempt).resolves.toBe(false);

          expect(execute).not.toHaveBeenCalled();
          await expect(LocalCommerceService.getListing(listingId)).resolves.toBeNull();
        },
      );

      it("a stale auction NOT_FOUND keeps the newer attempt's pending auction command", async () => {
        const record = createCommerceListingFixture();
        record.sale = {
          format: 'auction',
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          startsAt: '2026-08-19T20:00:00.000Z',
          endsAt: '2026-08-29T20:00:00.000Z',
          antiSnipingWindowSeconds: 120,
          antiSnipingExtensionSeconds: 120,
        };
        vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
        vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
        await LocalCommerceService.upsertListing(record, 'synced');
        homeserverWith(record);
        vi.spyOn(MarketplaceGatewayService, 'getSellerListing').mockResolvedValue(null);
        let releaseStale: (() => void) | undefined;
        let releaseNewer: (() => void) | undefined;
        const execute = vi
          .spyOn(MarketplaceGatewayService, 'execute')
          .mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
              releaseStale = resolve;
            });
            return LISTING_RECORD_NOT_FOUND_RESPONSE;
          })
          .mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
              releaseNewer = resolve;
            });
            throw new TypeError('registration unavailable');
          })
          .mockImplementationOnce(async (_actor, command) => listingRegisteredResponse(command));

        const requested = recordLockRequests();
        const staleAttempt = CommerceApplication.ensureListingRegistered(record);
        await vi.waitFor(() => expect(releaseStale).toBeDefined());
        const republished = { ...record, revision: record.revision + 1, updatedAt: new Date().toISOString() };
        const newerPublish = CommerceApplication.commitUpsertListing(republished);
        // The newer publish has staged its edit and waits for the stale attempt's lock to choose its command.
        await vi.waitFor(() => expect(requested.filter(isRegistrationLock)).toHaveLength(2));
        releaseStale!();
        await expect(staleAttempt).resolves.toBe(false);
        await vi.waitFor(() => expect(releaseNewer).toBeDefined());
        releaseNewer!();
        await expect(newerPublish).resolves.toEqual({ registered: false, verified: true });

        // The retry replays the newer attempt's command only if the stale attempt left it in place.
        await expect(CommerceApplication.commitUpsertListing(republished)).resolves.toEqual({
          registered: true,
          verified: true,
        });
        expect(execute).toHaveBeenCalledTimes(3);
        expect(execute.mock.calls[1][1].commandId).not.toBe(execute.mock.calls[0][1].commandId);
        expect(execute.mock.calls[2][1].commandId).toBe(execute.mock.calls[1][1].commandId);
      });

      it('a deleted auction record drops the held auction command, so a republish at the same revision sends a fresh one', async () => {
        const record = createCommerceListingFixture();
        record.sale = {
          format: 'auction',
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          startsAt: '2026-08-19T20:00:00.000Z',
          endsAt: '2026-08-29T20:00:00.000Z',
          antiSnipingWindowSeconds: 120,
          antiSnipingExtensionSeconds: 120,
        };
        const listingId = `${record.ownerPubky}:${record.listingId}`;
        const firstReserve = { amountMinor: 8_000, currency: 'USD', exponent: 2 };
        const secondReserve = { amountMinor: 9_000, currency: 'USD', exponent: 2 };
        vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
        vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
        vi.spyOn(MarketplaceGatewayService, 'getSellerListing').mockResolvedValue(null);
        let published: Record<string, unknown> | null = null;
        vi.spyOn(CommerceHomeserverService, 'putJson').mockImplementation(async (url, body) => {
          if (url === LISTING_URL) published = body;
        });
        vi.mocked(CommerceHomeserverService.fetchJson).mockImplementation(async (url) => {
          if (url === LISTING_URL && published) return published;
          throw homeserverNotFound();
        });
        const execute = vi
          .spyOn(MarketplaceGatewayService, 'execute')
          .mockRejectedValueOnce(new TypeError('registration unavailable'))
          .mockImplementationOnce(async (_actor, command) => listingRegisteredResponse(command));

        await expect(CommerceApplication.commitUpsertListing(record, firstReserve)).resolves.toEqual({
          registered: false,
          verified: true,
        });
        published = null;
        await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
        await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
          registration_status: 'not_found',
        });

        await expect(CommerceApplication.commitUpsertListing(record, secondReserve)).resolves.toEqual({
          registered: true,
          verified: true,
        });
        expect(execute).toHaveBeenCalledTimes(2);
        expect(execute.mock.calls[1][1].commandId).not.toBe(execute.mock.calls[0][1].commandId);
        expect(execute.mock.calls[1][1].payload).toMatchObject({ auctionReserve: { reservePrice: secondReserve } });
      });
    });

    it('keeps a listing whose publish never reached the homeserver, and its sync job, marking it not_found', async () => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      vi.spyOn(CommerceHomeserverService, 'putJson').mockRejectedValue(new TypeError('network unavailable'));
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

      await expect(CommerceApplication.commitUpsertListing(record)).rejects.toThrow('network unavailable');
      vi.mocked(CommerceHomeserverService.fetchJson).mockRejectedValue(
        Err.client(ClientErrorCode.NOT_FOUND, 'Not found', {
          service: ErrorService.Homeserver,
          operation: 'fetchJson',
        }),
      );
      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);

      expect(execute).not.toHaveBeenCalled();
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        record,
        sync_status: 'pending',
        registration_status: 'not_found',
      });
      const jobs = await CommerceSyncJobModel.table.where('entity_id').equals(record.listingId).toArray();
      expect(jobs).toEqual([
        expect.objectContaining({ entity_type: 'listing', operation: 'publish', status: 'pending' }),
      ]);
    });

    it('treats a NOT_FOUND refusal for another aggregate as an ordinary failure', async () => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      publishOnHomeserver(record);
      await LocalCommerceService.upsertListing(record, 'synced');
      vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
      vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({
        ...LISTING_RECORD_NOT_FOUND_RESPONSE,
        aggregateId: 'listing:another-seller_other-listing',
      } as never);

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'unregistered',
      });
    });
  });

  describe('one registration owner per listing', () => {
    const auctionListing = () => {
      const record = createCommerceListingFixture();
      record.sale = {
        format: 'auction',
        startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        startsAt: '2026-08-19T20:00:00.000Z',
        endsAt: '2026-08-29T20:00:00.000Z',
        antiSnipingWindowSeconds: 120,
        antiSnipingExtensionSeconds: 120,
      };
      return record;
    };
    const durableSeller = async (record: ReturnType<typeof createCommerceListingFixture>) => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
      vi.spyOn(MarketplaceGatewayService, 'getSellerListing').mockResolvedValue(null);
      publishOnHomeserver(record);
      await LocalCommerceService.upsertListing(record, 'synced');
      return `${record.ownerPubky}:${record.listingId}`;
    };
    const held = <T>(answer: () => T) => {
      const gate: { release?: () => void } = {};
      const run = async () => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return answer();
      };
      return { gate, run };
    };

    it('a second tab gives up while the first holds the listing, so one command is sent', async () => {
      const record = createCommerceListingFixture();
      await durableSeller(record);
      const first = held(() => undefined);
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementationOnce(async (_actor, command) => {
        await first.run();
        return listingRegisteredResponse(command);
      });

      const firstTab = CommerceApplication.ensureListingRegistered(record);
      await vi.waitFor(() => expect(first.gate.release).toBeDefined());
      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
      expect(execute).toHaveBeenCalledOnce();
      first.gate.release!();
      await expect(firstTab).resolves.toBe(true);
    });

    it('replays the persisted auction command across tabs, a reload and a seller refresh', async () => {
      const record = auctionListing();
      const listingId = await durableSeller(record);
      const execute = vi
        .spyOn(MarketplaceGatewayService, 'execute')
        .mockRejectedValueOnce(new TypeError('registration unavailable'))
        .mockImplementationOnce(async (_actor, command) => listingRegisteredResponse(command));

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
      const firstCommandId = execute.mock.calls[0][1].commandId;
      expect((await LocalCommerceService.getListing(listingId))?.auction_registration?.command_id).toBe(firstCommandId);

      await LocalCommerceService.commitSellerCatalogRefresh([createCommerceCatalogEntryFixture()], [record]);
      expect((await LocalCommerceService.getListing(listingId))?.auction_registration?.command_id).toBe(firstCommandId);

      // A fresh attempt holds no memory of the first: the command id can only come from the row.
      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(true);
      expect(execute.mock.calls[1][1].commandId).toBe(firstCommandId);
    });

    it.each([
      ['accepted', true],
      ['refused with NOT_FOUND', false],
    ])(
      'a sign-out in another tab while the command is in flight stops the attempt before it writes (%s)',
      async (_name, accepted) => {
        const record = createCommerceListingFixture();
        const listingId = await durableSeller(record);
        const inFlight = held(() => accepted);
        vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementationOnce(async (_actor, command) =>
          (await inFlight.run()) ? listingRegisteredResponse(command) : LISTING_RECORD_NOT_FOUND_RESPONSE,
        );
        const before = await LocalCommerceService.getListing(listingId);

        const attempt = CommerceApplication.ensureListingRegistered(record);
        await vi.waitFor(() => expect(inFlight.gate.release).toBeDefined());
        bumpAuthEpoch();
        inFlight.gate.release!();
        await expect(attempt).resolves.toBe(false);

        await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
          registration_status: before?.registration_status,
          write_id: before?.write_id,
        });
      },
    );

    it('a sign-out while a publish registers leaves the listing pending and its publish job in place', async () => {
      const record = createCommerceListingFixture();
      const listingId = `${record.ownerPubky}:${record.listingId}`;
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
      vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
      const inFlight = held(() => undefined);
      vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementationOnce(async (_actor, command) => {
        await inFlight.run();
        return listingRegisteredResponse(command);
      });
      const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob');

      const publish = CommerceApplication.commitUpsertListing(record);
      await vi.waitFor(() => expect(inFlight.gate.release).toBeDefined());
      bumpAuthEpoch();
      inFlight.gate.release!();
      await expect(publish).resolves.toEqual({ registered: false, verified: true });

      expect(complete).not.toHaveBeenCalled();
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'unregistered',
      });
    });

    it('a timed-out command releases the lock and leaves the listing pending', async () => {
      const record = createCommerceListingFixture();
      const listingId = await durableSeller(record);
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
      const execute = vi
        .spyOn(MarketplaceGatewayService, 'execute')
        .mockImplementationOnce(
          (_actor, _command, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
            }),
        )
        .mockImplementationOnce(async (_actor, command) => listingRegisteredResponse(command));

      const attempt = CommerceApplication.ensureListingRegistered(record);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      deadline.abort();
      await expect(attempt).resolves.toBe(false);
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'unregistered',
      });

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(true);
    });

    it('without Web Locks nothing registers: the heal sends nothing and a publish stays unregistered', async () => {
      removeWebLocks();
      const record = createCommerceListingFixture();
      const listingId = await durableSeller(record);
      const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute');
      vi.mocked(CommerceHomeserverService.fetchJson)
        .mockClear()
        .mockImplementation(async (url) => put.mock.calls.findLast(([written]) => written === url)?.[1] ?? record);

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
      expect(CommerceHomeserverService.fetchJson).not.toHaveBeenCalled();

      const edited = { ...record, revision: record.revision + 1, updatedAt: new Date().toISOString() };
      await expect(CommerceApplication.commitUpsertListing(edited)).resolves.toEqual({
        registered: false,
        verified: true,
      });
      expect(put).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        revision: edited.revision,
        registration_status: 'unregistered',
      });
      expect(CommerceApplication.canCoordinateListingRegistration()).toBe(false);
    });

    it('requests no other lock while holding a listing registration lock', async () => {
      const record = auctionListing();
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      vi.spyOn(MarketplaceGatewayService, 'getSellerListing').mockResolvedValue(null);
      vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
      vi.spyOn(MarketplaceGatewayService, 'execute')
        .mockRejectedValueOnce(new TypeError('registration unavailable'))
        .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));
      const requested = recordLockRequests();

      await expect(CommerceApplication.commitUpsertListing(record, null)).resolves.toEqual({
        registered: false,
        verified: true,
      });
      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(true);

      expect(requested.length).toBeGreaterThanOrEqual(3);
      expect(requested.every(isRegistrationLock)).toBe(true);
      expect(requested.nested).toEqual([]);
    });

    describe('publish and delete writes', () => {
      const notFound = () =>
        Err.client(ClientErrorCode.NOT_FOUND, 'Not found', {
          service: ErrorService.Homeserver,
          operation: 'fetchJson',
        });
      /** One listing record on the seller's homeserver, changed only by the PUT and DELETE spies. */
      const homeserver = (record: ReturnType<typeof createCommerceListingFixture>) => {
        const state: { published: Record<string, unknown> | null; deleteGate?: () => void; holdDelete: boolean } = {
          published: { ...record },
          holdDelete: false,
        };
        const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockImplementation(async (url, body) => {
          if (url === LISTING_URL) state.published = body;
        });
        const remove = vi.spyOn(CommerceHomeserverService, 'delete').mockImplementation(async (url) => {
          if (url !== LISTING_URL) return;
          if (state.holdDelete) {
            await new Promise<void>((resolve) => {
              state.deleteGate = resolve;
            });
          }
          state.published = null;
        });
        vi.mocked(CommerceHomeserverService.fetchJson).mockImplementation(async (url) => {
          if (url === LISTING_URL && state.published) return state.published;
          throw notFound();
        });
        return { state, put, remove };
      };

      it('a publish queued behind a delete does not bring the record back', async () => {
        const record = createCommerceListingFixture();
        const listingId = await durableSeller(record);
        const { state, put } = homeserver(record);
        state.holdDelete = true;
        const execute = vi.spyOn(MarketplaceGatewayService, 'execute');
        const requested = recordLockRequests();

        const deleting = CommerceApplication.commitDeleteListing(record.ownerPubky, record.listingId);
        await vi.waitFor(() => expect(state.deleteGate).toBeDefined());
        const edited = { ...record, revision: record.revision + 1, updatedAt: new Date().toISOString() };
        const publish = CommerceApplication.commitUpsertListing(edited).then(
          () => null,
          (error: unknown) => error,
        );
        // The publish has staged its edit and read the record, and now waits for the delete's lock to PUT.
        await vi.waitFor(() => expect(requested.filter(isRegistrationLock)).toHaveLength(2));
        state.deleteGate!();
        await deleting;

        await expect(publish).resolves.toMatchObject({ code: ClientErrorCode.CONFLICT });
        expect(put).not.toHaveBeenCalled();
        expect(state.published).toBeNull();
        expect(execute).not.toHaveBeenCalled();
        await expect(LocalCommerceService.getListing(listingId)).resolves.toBeNull();
      });

      it('a stale tab publishing the same next revision cannot overwrite the newer publish', async () => {
        const record = createCommerceListingFixture();
        const listingId = `${record.ownerPubky}:${record.listingId}`;
        vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
        await LocalCommerceService.upsertListing(record, 'synced');
        const { state, put } = homeserver(record);
        const stale = { ...record, revision: record.revision + 1, title: 'Stale tab edit' };
        const newer = { ...record, revision: record.revision + 1, title: 'Newer tab edit' };
        // The stale tab stages first and is held at its first homeserver read; the newer tab then stages
        // the same revision and is held mid-PUT, inside the lock, while the stale tab passes its reads.
        const staleRead = held(() => undefined);
        let reads = 0;
        vi.mocked(CommerceHomeserverService.fetchJson).mockImplementation(async (url) => {
          if (url !== LISTING_URL) throw notFound();
          reads += 1;
          if (reads === 1) await staleRead.run();
          if (state.published) return state.published;
          throw notFound();
        });
        const newerPut = held(() => undefined);
        put.mockImplementation(async (url, body) => {
          if (body.title === newer.title) await newerPut.run();
          if (url === LISTING_URL) state.published = body;
        });
        const requested = recordLockRequests();

        const stalePublish = CommerceApplication.commitUpsertListing(stale).then(
          () => null,
          (error: unknown) => error,
        );
        await vi.waitFor(() => expect(staleRead.gate.release).toBeDefined());
        const newerPublish = CommerceApplication.commitUpsertListing(newer);
        await vi.waitFor(() => expect(newerPut.gate.release).toBeDefined());
        staleRead.gate.release!();
        await vi.waitFor(() => expect(requested.filter(isRegistrationLock)).toHaveLength(2));
        newerPut.gate.release!();

        await expect(newerPublish).resolves.toEqual({ registered: false, verified: true });
        await expect(stalePublish).resolves.toMatchObject({ code: ClientErrorCode.CONFLICT });
        expect(put.mock.calls.map(([, body]) => body.title)).toEqual([newer.title]);
        expect(state.published).toMatchObject({ title: newer.title });
        await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
          record: newer,
          sync_status: 'synced',
        });
      });

      it('a delete waits for a registration the service is accepting, then removes the record', async () => {
        const record = createCommerceListingFixture();
        const listingId = await durableSeller(record);
        const { state, remove } = homeserver(record);
        const accepting = held(() => undefined);
        vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementationOnce(async (_actor, command) => {
          await accepting.run();
          return listingRegisteredResponse(command);
        });
        const requested = recordLockRequests();

        const registering = CommerceApplication.ensureListingRegistered(record);
        await vi.waitFor(() => expect(accepting.gate.release).toBeDefined());
        const deleting = CommerceApplication.commitDeleteListing(record.ownerPubky, record.listingId);
        await vi.waitFor(() => expect(requested.filter(isRegistrationLock)).toHaveLength(2));
        expect(remove).not.toHaveBeenCalled();
        expect(state.published).not.toBeNull();

        accepting.gate.release!();
        await expect(registering).resolves.toBe(true);
        await deleting;
        expect(remove).toHaveBeenCalledWith(LISTING_URL, undefined, { singleAttempt: true });
        expect(state.published).toBeNull();
        await expect(LocalCommerceService.getListing(listingId)).resolves.toBeNull();
      });

      it('a publish whose record is deleted before it registers sends nothing', async () => {
        const record = createCommerceListingFixture();
        const listingId = `${record.ownerPubky}:${record.listingId}`;
        vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
        vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
        vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
        const { state } = homeserver(record);
        state.published = null;
        const execute = vi.spyOn(MarketplaceGatewayService, 'execute');
        // Reads: base, pre-PUT recheck, read-back, then the registration precheck, which is held.
        const precheck = held(() => undefined);
        let reads = 0;
        vi.mocked(CommerceHomeserverService.fetchJson).mockImplementation(async (url) => {
          if (url !== LISTING_URL) throw notFound();
          reads += 1;
          const seen = state.published;
          if (reads === 4) await precheck.run();
          if (seen) return seen;
          throw notFound();
        });

        const publish = CommerceApplication.commitUpsertListing(record);
        await vi.waitFor(() => expect(precheck.gate.release).toBeDefined());
        await CommerceApplication.commitDeleteListing(record.ownerPubky, record.listingId);
        precheck.gate.release!();

        await expect(publish).resolves.toEqual({ registered: false, verified: true });
        expect(execute).not.toHaveBeenCalled();
        await expect(LocalCommerceService.getListing(listingId)).resolves.toBeNull();
      });

      it('a publish whose account changes during its PUT does not mark the listing synced', async () => {
        const record = createCommerceListingFixture();
        const listingId = `${record.ownerPubky}:${record.listingId}`;
        vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
        vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
        useAuthStore.getState().setCurrentUserPubky(record.ownerPubky);
        const { state } = homeserver(record);
        state.published = null;
        const putting = held(() => undefined);
        vi.mocked(CommerceHomeserverService.putJson).mockImplementation(async (url, body) => {
          await putting.run();
          if (url === LISTING_URL) state.published = body;
        });
        const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

        const publish = CommerceApplication.commitUpsertListing(record);
        await vi.waitFor(() => expect(putting.gate.release).toBeDefined());
        useAuthStore.getState().setCurrentUserPubky('b'.repeat(52));
        putting.gate.release!();

        await expect(publish).rejects.toMatchObject({ code: AuthErrorCode.SESSION_EXPIRED });
        expect(execute).not.toHaveBeenCalled();
        await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({ sync_status: 'pending' });
      });
    });

    it.each(['account', 'marketplace session'] as const)(
      'a %s switch while the command is in flight stops the attempt before it writes',
      async (switched) => {
        const record = createCommerceListingFixture();
        const listingId = await durableSeller(record);
        useAuthStore.getState().setCurrentUserPubky(record.ownerPubky);
        let token = 'A'.repeat(43);
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockImplementation(() => ({ token }) as never);
        const inFlight = held(() => undefined);
        vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementationOnce(async (_actor, command) => {
          await inFlight.run();
          return listingRegisteredResponse(command);
        });
        const before = await LocalCommerceService.getListing(listingId);

        const attempt = CommerceApplication.ensureListingRegistered(record);
        await vi.waitFor(() => expect(inFlight.gate.release).toBeDefined());
        if (switched === 'account') useAuthStore.getState().setCurrentUserPubky('b'.repeat(52));
        else token = 'B'.repeat(43);
        inFlight.gate.release!();
        await expect(attempt).resolves.toBe(false);

        await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
          registration_status: before?.registration_status,
          write_id: before?.write_id,
        });
      },
    );

    it("a deleted record found while another tab's attempt is in flight neither settles nor drops that attempt's command", async () => {
      const record = auctionListing();
      const listingId = await durableSeller(record);
      const inFlight = held(() => undefined);
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementationOnce(async () => {
        await inFlight.run();
        throw new TypeError('registration unavailable');
      });

      const firstTab = CommerceApplication.ensureListingRegistered(record);
      await vi.waitFor(() => expect(inFlight.gate.release).toBeDefined());
      const commandId = execute.mock.calls[0][1].commandId;
      vi.mocked(CommerceHomeserverService.fetchJson).mockRejectedValue(
        Err.client(ClientErrorCode.NOT_FOUND, 'Not found', {
          service: ErrorService.Homeserver,
          operation: 'fetchJson',
        }),
      );

      await expect(CommerceApplication.ensureListingRegistered(record)).resolves.toBe(false);
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        auction_registration: expect.objectContaining({ command_id: commandId }),
      });

      inFlight.gate.release!();
      await expect(firstTab).resolves.toBe(false);
      await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
        registration_status: 'unregistered',
        auction_registration: expect.objectContaining({ command_id: commandId }),
      });
    });
  });

  it('skips transaction-service registration when the listing is already registered (sandbox)', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    vi.spyOn(LocalCommerceService, 'stageListingSync');
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue({ serverRevision: 4 } as never);
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    await CommerceApplication.commitUpsertListing(record);

    expect(execute).not.toHaveBeenCalled();
  });

  it('syncs an already-registered listing on republish so edits reach the authority (durable)', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
    vi.spyOn(LocalCommerceService, 'stageListingSync');
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue({ serverRevision: 4 } as never);
    const execute = vi
      .spyOn(MarketplaceGatewayService, 'execute')
      .mockImplementation(async (_actor, command) => listingRegisteredResponse(command));

    const result = await CommerceApplication.commitUpsertListing(record);

    // The convergent sync — never a fresh register — carries the edit.
    expect(execute).toHaveBeenCalledWith(
      record.ownerPubky,
      expect.objectContaining({
        kind: 'listing.sync',
        payload: { sellerPubky: record.ownerPubky, listingId: record.listingId },
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(result).toEqual({ registered: true, verified: true });
  });

  it.each(['unavailable', 'transaction-service'] as const)(
    'publishes a composer record whose optional fields are undefined, verified against its JSON read-back (%s)',
    async (mode) => {
      // The composer leaves these undefined by default: a blank region, a final sale, no item specifics.
      const fixture = createCommerceListingFixture();
      const record = {
        ...fixture,
        location: { countryCode: 'US', region: undefined },
        attributes: undefined,
        returnPolicy: { ...fixture.returnPolicy, acceptsReturns: false, returnWindowDays: undefined },
      } as typeof fixture;
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue(mode);
      vi.spyOn(CommerceApplication, 'hasActiveMarketplaceSession').mockReturnValue(true);
      vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
      vi.spyOn(MarketplaceGatewayService, 'execute').mockImplementation(async (_actor, command) =>
        listingRegisteredResponse(command),
      );
      // The homeserver stores what JSON carries: keys whose value is undefined are gone on read-back.
      let stored: unknown = null;
      const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockImplementation(async (url, body) => {
        if (url === LISTING_URL) stored = JSON.parse(JSON.stringify(body));
      });
      vi.mocked(CommerceHomeserverService.fetchJson).mockImplementation(async (url) => {
        if (url === LISTING_URL && stored) return stored;
        throw Err.client(ClientErrorCode.NOT_FOUND, 'Not found', {
          service: ErrorService.Homeserver,
          operation: 'fetchJson',
        });
      });

      await expect(CommerceApplication.commitUpsertListing(record)).resolves.toEqual({
        registered: mode === 'transaction-service',
        verified: true,
      });
      expect(put).toHaveBeenCalledOnce();
      expect(stored).not.toHaveProperty('attributes');
      expect(stored).toMatchObject({ location: { countryCode: 'US' } });
    },
  );

  it('publishes a listing without registration when the marketplace adapter is unavailable', async () => {
    const record = createCommerceListingFixture();
    const listingId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    await expect(CommerceApplication.commitUpsertListing(record)).resolves.toEqual({
      registered: false,
      verified: true,
    });

    expect(put).toHaveBeenCalledWith(LISTING_URL, record, { singleAttempt: true });
    expect(execute).not.toHaveBeenCalled();
    await expect(LocalCommerceService.getListing(listingId)).resolves.toMatchObject({
      registration_status: 'unavailable',
    });
  });

  it('issues listing.sync as a convergent command any actor may send', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('018f47d2-6a27-7c23-a49d-6b21bb770130');
    const response = {
      ok: true as const,
      version: 1 as const,
      commandId: '018f47d2-6a27-7c23-a49d-6b21bb770130',
      aggregateId: `listing:${COMMERCE_FIXTURE_SELLER}_boots_01`,
      revision: 1,
      eventIds: [],
      result: { kind: 'listing' as const },
    };
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue(response);
    const buyer = 'ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u';

    await expect(
      CommerceApplication.syncListingRegistration(buyer, COMMERCE_FIXTURE_SELLER, 'boots_01'),
    ).resolves.toEqual(response);

    // The buyer — not the seller — is the acting identity, and the command
    // is convergent: expectedRevision is always 0.
    expect(execute).toHaveBeenCalledWith(
      buyer,
      expect.objectContaining({
        kind: 'listing.sync',
        aggregateId: `listing:${COMMERCE_FIXTURE_SELLER}_boots_01`,
        expectedRevision: 0,
        payload: { sellerPubky: COMMERCE_FIXTURE_SELLER, listingId: 'boots_01' },
      }),
    );
  });

  it('refuses listing.sync outside the durable transaction-service modes', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    await expect(
      CommerceApplication.syncListingRegistration(
        'ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u',
        COMMERCE_FIXTURE_SELLER,
        'boots_01',
      ),
    ).rejects.toThrow('Listing sync requires the durable transaction service.');
    expect(execute).not.toHaveBeenCalled();
  });

  describe('multi-operator mismatch guard (docs/ecommerce/multi-operator.md, increment 1)', () => {
    const command = {
      version: 1 as const,
      commandId: '018f47d2-6a27-7c23-a49d-6b21bb770140',
      aggregateId: `listing:${COMMERCE_FIXTURE_SELLER}_boots_01`,
      expectedRevision: 1,
      issuedAt: '2026-08-23T12:00:00.000Z',
      kind: 'checkout.create',
      payload: {},
    } as never;

    const shopModelWith = (transactionService?: string) => {
      const record = { ...createCommerceShopFixture(), ...(transactionService ? { transactionService } : {}) };
      return new CommerceShopModel({
        id: COMMERCE_FIXTURE_SELLER,
        owner_id: COMMERCE_FIXTURE_SELLER,
        record,
        revision: 1,
        sync_status: 'synced',
        updated_at: Date.parse(record.updatedAt),
      });
    };

    it('refuses a listing-aggregate command when the shop declares a different service origin', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(commerceConfig, 'getMarketplaceUrl').mockReturnValue('https://service.this-deployment.example');
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(shopModelWith('https://other-operator.example'));
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

      await expect(CommerceApplication.executeMarketplaceCommand('actor', command)).rejects.toThrow(
        'This listing is not registered with this Shop, so checkout cannot continue here.',
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it('passes when the declared origin matches the configured service', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(commerceConfig, 'getMarketplaceUrl').mockReturnValue('https://service.this-deployment.example');
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(
        shopModelWith('https://service.this-deployment.example/api'),
      );
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({ ok: true } as never);

      await expect(CommerceApplication.executeMarketplaceCommand('actor', command)).resolves.toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('passes when the shop declares nothing', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(commerceConfig, 'getMarketplaceUrl').mockReturnValue('https://service.this-deployment.example');
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(shopModelWith());
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({ ok: true } as never);

      await expect(CommerceApplication.executeMarketplaceCommand('actor', command)).resolves.toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('fails open when the shop record cannot be read at all', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(commerceConfig, 'getMarketplaceUrl').mockReturnValue('https://service.this-deployment.example');
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(null);
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(new Error('homeserver unreachable'));
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({ ok: true } as never);

      await expect(CommerceApplication.executeMarketplaceCommand('actor', command)).resolves.toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('does not guard sandbox commands or non-listing aggregates', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(shopModelWith('https://other-operator.example'));
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({ ok: true } as never);

      await expect(CommerceApplication.executeMarketplaceCommand('actor', command)).resolves.toEqual({ ok: true });

      vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('transaction-service');
      vi.spyOn(commerceConfig, 'getMarketplaceUrl').mockReturnValue('https://service.this-deployment.example');
      const orderCommand = { ...(command as Record<string, unknown>), aggregateId: 'order:some-order-id' } as never;
      await expect(CommerceApplication.executeMarketplaceCommand('actor', orderCommand)).resolves.toEqual({
        ok: true,
      });
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  it('lists own drop ids from the homeserver drops directory, ignoring non-id entries', async () => {
    const base = `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/drops/`;
    vi.spyOn(HomeserverService, 'listAll').mockResolvedValue([
      `${base}drop_summer_01`,
      `${base}drop_autumn_02`,
      `${base}nested/never-an-id`,
      base,
    ]);

    await expect(CommerceApplication.listOwnDropIds(COMMERCE_FIXTURE_SELLER)).resolves.toEqual([
      'drop_summer_01',
      'drop_autumn_02',
    ]);
    expect(HomeserverService.listAll).toHaveBeenCalledWith({ baseDirectory: base });
  });

  it('deletes a listing from the homeserver, then every local cache, then its media', async () => {
    const record = createCommerceListingFixture();
    const compositeId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('018f47d2-6a27-7c23-a49d-6b21bb770122');
    vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(
      new CommerceListingModel({
        id: compositeId,
        seller_id: record.ownerPubky,
        listing_id: record.listingId,
        record,
        revision: record.revision,
        state: record.state,
        category_id: record.categoryId,
        format: record.sale.format,
        currency: 'USD',
        price_minor: 12_500,
        sync_status: 'synced',
        updated_at: Date.parse(record.updatedAt),
      }),
    );
    const upsertJob = vi.spyOn(LocalCommerceService, 'upsertSyncJob').mockResolvedValue(undefined);
    const remove = vi.spyOn(CommerceHomeserverService, 'delete').mockResolvedValue(undefined);
    const deleteLocal = vi.spyOn(LocalCommerceService, 'deleteListing').mockResolvedValue(undefined);
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);

    await CommerceApplication.commitDeleteListing(record.ownerPubky, record.listingId);

    expect(upsertJob).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: 'listing', entity_id: record.listingId, operation: 'remove' }),
    );
    expect(remove).toHaveBeenNthCalledWith(1, LISTING_URL, undefined, { singleAttempt: true });
    expect(deleteLocal).toHaveBeenCalledWith(compositeId);
    expect(complete).toHaveBeenCalledWith('018f47d2-6a27-7c23-a49d-6b21bb770122');
    // Media cleanup follows the record deletion, one call per media file.
    record.media.forEach((media) => expect(remove).toHaveBeenCalledWith(media.url));
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(deleteLocal.mock.invocationCallOrder[0]);
  });

  it('keeps the local listing when the homeserver record deletion fails', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(null);
    vi.spyOn(LocalCommerceService, 'upsertSyncJob').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'delete').mockRejectedValue(new TypeError('network unavailable'));
    const deleteLocal = vi.spyOn(LocalCommerceService, 'deleteListing');
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob');

    await expect(CommerceApplication.commitDeleteListing(record.ownerPubky, record.listingId)).rejects.toThrow(
      'network unavailable',
    );
    expect(deleteLocal).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  describe('fetchSellerCatalogListings', () => {
    const capturedRecords = SELLER_REFRESH_FIXTURE.canonical.map(({ record }) =>
      CommerceRecordNormalizer.listing(record),
    );
    const capturedById = new Map(capturedRecords.map((record) => [record.listingId, record]));
    const capturedSeller = capturedRecords[0].ownerPubky;

    it('refreshes discovery and hydrates the missing canonical listing while retaining cached records', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      await LocalCommerceService.upsertListing(capturedById.get('c73b6be3ab4642539c69a797f9006dcb')!, 'synced');
      await LocalCommerceService.upsertListing(capturedById.get('45b2aedff744407ea2d67c8069ed112e')!, 'synced');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue(SELLER_REFRESH_FIXTURE.nexus);
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async (url) => {
        const listingId = url.split('/').pop();
        return capturedById.get(listingId!)!;
      });

      await CommerceApplication.refreshListingsBySeller(capturedSeller);

      expect(await LocalCommerceService.getListingsBySeller(capturedSeller)).toHaveLength(3);
      expect(fetchJson).toHaveBeenCalledExactlyOnceWith(
        `pubky://${capturedSeller}/pub/pubky.app/marketplace/v1/listings/aa2c8b308dbc47619793fe64dcefa9e8`,
      );
    });

    it('rejects an owner-mismatched Nexus row before mutating the catalog cache', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const existing = createCommerceCatalogEntryFixture({ listing_id: 'existing' });
      await CommerceCatalogEntryModel.table.clear();
      await CommerceCatalogEntryModel.table.put(existing);
      const before = await CommerceCatalogEntryModel.table.toArray();
      const mismatched = {
        ...(SELLER_REFRESH_FIXTURE.nexus[0] as Record<string, unknown>),
        owner_id: 's'.repeat(52),
        uri: `pubky://${'s'.repeat(52)}/pub/pubky.app/marketplace/v1/listings/c73b6be3ab4642539c69a797f9006dcb`,
      } as NexusListingDetails;
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([mismatched]);

      await expect(CommerceApplication.refreshListingsBySeller(COMMERCE_FIXTURE_SELLER)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });

      expect(await CommerceCatalogEntryModel.table.toArray()).toEqual(before);
    });

    it('uses the real Dexie revision seam for missing and stale canonical hydration', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      const stale = { ...capturedById.get('45b2aedff744407ea2d67c8069ed112e')!, revision: 1 };
      await LocalCommerceService.upsertListing(capturedById.get('c73b6be3ab4642539c69a797f9006dcb')!, 'synced');
      await LocalCommerceService.upsertListing(stale, 'synced');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue(SELLER_REFRESH_FIXTURE.nexus);
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async (url) => {
        const listingId = url.split('/').pop();
        return capturedById.get(listingId!)!;
      });

      await CommerceApplication.refreshListingsBySeller(capturedSeller);

      expect(await LocalCommerceService.getListingsBySeller(capturedSeller)).toHaveLength(3);
      expect(fetchJson.mock.calls.map(([url]) => url).sort()).toEqual([
        `pubky://${capturedSeller}/pub/pubky.app/marketplace/v1/listings/45b2aedff744407ea2d67c8069ed112e`,
        `pubky://${capturedSeller}/pub/pubky.app/marketplace/v1/listings/aa2c8b308dbc47619793fe64dcefa9e8`,
      ]);
      expect(
        (await LocalCommerceService.getListing(`${capturedSeller}:45b2aedff744407ea2d67c8069ed112e`))?.revision,
      ).toBe(3);
    });

    it('replaces a non-empty stale active cache row with the newer canonical record state', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      const listingId = '45b2aedff744407ea2d67c8069ed112e';
      const stale = { ...capturedById.get(listingId)!, revision: 1, state: 'active' as const };
      const canonical = { ...capturedById.get(listingId)!, revision: 3, state: 'paused' as const };
      const directoryEntry = { ...SELLER_REFRESH_FIXTURE.nexus.find((entry) => entry.id === listingId)!, revision: 3 };
      await LocalCommerceService.upsertListing(stale, 'synced');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([directoryEntry]);
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(canonical);

      await CommerceApplication.refreshListingsBySeller(capturedSeller);

      expect(await LocalCommerceService.getListingsBySeller(capturedSeller)).toMatchObject([
        { listing_id: listingId, revision: 3, state: 'paused' },
      ]);
    });

    it('pages a complete seller refresh and keeps the highest duplicate revision', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const pageOne = Array.from({ length: NEXUS_LISTINGS_PER_PAGE }, (_, index) =>
        nexusRow(`page_${index}`, index === 0 ? 1 : 1),
      );
      const duplicate = nexusRow('page_0', 2);
      const pageTwo = [duplicate, nexusRow('page_30', 1)];
      const stream = vi
        .spyOn(NexusMarketplaceService, 'fetchListingStream')
        .mockResolvedValueOnce(pageOne)
        .mockResolvedValueOnce(pageTwo);
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);

      await CommerceApplication.fetchSellerCatalogListings(capturedSeller, {
        strictIdentity: true,
        paginate: true,
      });

      expect(stream.mock.calls).toEqual([
        [{ seller_id: capturedSeller, state: 'active', limit: NEXUS_LISTINGS_PER_PAGE }],
        [{ seller_id: capturedSeller, state: 'active', limit: NEXUS_LISTINGS_PER_PAGE, skip: NEXUS_LISTINGS_PER_PAGE }],
      ]);
      const entries = bulkUpsert.mock.calls[0][0];
      expect(entries).toHaveLength(NEXUS_LISTINGS_PER_PAGE + 1);
      expect(entries.find(({ listing_id }) => listing_id === 'page_0')?.revision).toBe(2);
    });

    it('rejects a bad later page before mutating the catalog cache', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      await CommerceCatalogEntryModel.table.put(createCommerceCatalogEntryFixture({ listing_id: 'existing' }));
      await CommerceListingModel.table.put(
        toCommerceListingModel(createCommerceListingFixture({ listingId: 'existing' })),
      );
      const beforeCatalog = await CommerceCatalogEntryModel.table.toArray();
      const beforeListings = await CommerceListingModel.table.toArray();
      const pageOne = Array.from({ length: NEXUS_LISTINGS_PER_PAGE }, (_, index) => nexusRow(`page_${index}`, 1));
      const badPage = {
        ...nexusRow('page_30', 1),
        owner_id: 's'.repeat(52),
        uri: `pubky://${'s'.repeat(52)}/pub/pubky.app/marketplace/v1/listings/page_30`,
      };
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream')
        .mockResolvedValueOnce(pageOne)
        .mockResolvedValueOnce([badPage]);

      await expect(
        CommerceApplication.fetchSellerCatalogListings(capturedSeller, {
          strictIdentity: true,
          paginate: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await CommerceCatalogEntryModel.table.toArray()).toEqual(beforeCatalog);
      expect(await CommerceListingModel.table.toArray()).toEqual(beforeListings);
    });

    it('rejects a lower canonical revision without mutating either real cache table', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      const indexed = capturedById.get('45b2aedff744407ea2d67c8069ed112e')!;
      await CommerceCatalogEntryModel.table.put(
        createCommerceCatalogEntryFixture({
          id: `${capturedSeller}:45b2aedff744407ea2d67c8069ed112e`,
          seller_id: capturedSeller,
          listing_id: indexed.listingId,
          revision: indexed.revision,
        }),
      );
      await CommerceListingModel.table.put(toCommerceListingModel({ ...indexed, revision: 1 }));
      const beforeCatalog = await CommerceCatalogEntryModel.table.toArray();
      const beforeListings = await CommerceListingModel.table.toArray();
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([SELLER_REFRESH_FIXTURE.nexus[1]]);
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue({ ...indexed, revision: 1 });

      await expect(CommerceApplication.refreshListingsBySeller(capturedSeller)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(await CommerceCatalogEntryModel.table.toArray()).toEqual(beforeCatalog);
      expect(await CommerceListingModel.table.toArray()).toEqual(beforeListings);
    });

    it('fails instead of claiming completeness when the bounded page cap is exhausted', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const fullPage = Array.from({ length: NEXUS_LISTINGS_PER_PAGE }, (_, index) => nexusRow(`page_${index}`, 1));
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue(fullPage);
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries');

      await expect(
        CommerceApplication.fetchSellerCatalogListings(capturedSeller, {
          strictIdentity: true,
          paginate: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(stream).toHaveBeenCalledTimes(100);
      expect(bulkUpsert).not.toHaveBeenCalled();
    });

    it('retains cached listings when the seller Nexus refresh fails', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const cached = [
        createCommerceListingFixture({ listingId: 'boots_01' }),
        createCommerceListingFixture({ listingId: 'boots_02' }),
      ];
      vi.spyOn(LocalCommerceService, 'getListingsBySeller').mockResolvedValue(
        cached.map((record) => toCommerceListingModel(record)),
      );
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockRejectedValue(new Error('nexus unreachable'));

      await expect(CommerceApplication.refreshListingsBySeller(COMMERCE_FIXTURE_SELLER)).rejects.toThrow(
        'nexus unreachable',
      );

      expect(await LocalCommerceService.getListingsBySeller(COMMERCE_FIXTURE_SELLER)).toHaveLength(2);
    });

    it('never queries Nexus in sandbox mode and retains the cached seller rows', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      await LocalCommerceService.upsertListing(createCommerceListingFixture({ listingId: 'boots_01' }), 'synced');
      await LocalCommerceService.upsertListing(createCommerceListingFixture({ listingId: 'boots_02' }), 'synced');
      const beforeCatalog = await CommerceCatalogEntryModel.table.toArray();
      const beforeListings = await CommerceListingModel.table.toArray();
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([]);
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue({});
      const commitRefresh = vi.spyOn(LocalCommerceService, 'commitSellerCatalogRefresh');
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries');

      await expect(CommerceApplication.refreshListingsBySeller(COMMERCE_FIXTURE_SELLER)).resolves.toBeUndefined();

      expect(stream).not.toHaveBeenCalled();
      expect(fetchJson).not.toHaveBeenCalled();
      expect(commitRefresh).not.toHaveBeenCalled();
      expect(bulkUpsert).not.toHaveBeenCalled();
      expect(await CommerceCatalogEntryModel.table.toArray()).toEqual(beforeCatalog);
      expect(await CommerceListingModel.table.toArray()).toEqual(beforeListings);
    });

    it('deduplicates concurrent refreshes by seller', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(LocalCommerceService, 'getCatalogEntriesBySeller').mockResolvedValue([]);
      let release: ((entries: NexusListingDetails[]) => void) | undefined;
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const first = CommerceApplication.refreshListingsBySeller(COMMERCE_FIXTURE_SELLER);
      const second = CommerceApplication.refreshListingsBySeller(COMMERCE_FIXTURE_SELLER);
      release?.([]);
      await Promise.all([first, second]);

      expect(stream).toHaveBeenCalledOnce();
    });

    it('returns locally cached seller listings without fetching the catalog', async () => {
      const first = createCommerceListingFixture({ listingId: 'boots_01' });
      const second = createCommerceListingFixture({ listingId: 'boots_02' });
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      await LocalCommerceService.upsertListing(first, 'synced');
      await LocalCommerceService.upsertListing(second, 'synced');
      await LocalCommerceService.bulkUpsertCatalogEntries([
        createCommerceCatalogEntryFixture({ listing_id: 'boots_01' }),
        createCommerceCatalogEntryFixture({ id: `${COMMERCE_FIXTURE_SELLER}:boots_02`, listing_id: 'boots_02' }),
      ]);

      const fetchCatalog = vi.spyOn(CommerceApplication, 'fetchSellerCatalogListings');
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson');

      await expect(CommerceApplication.getOrFetchListingsBySeller(COMMERCE_FIXTURE_SELLER)).resolves.toHaveLength(2);

      expect(fetchCatalog).not.toHaveBeenCalled();
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it('fetches an empty seller catalog and persists fetched listings in Dexie', async () => {
      const listing = createCommerceListingFixture();
      const catalogEntry = createCommerceCatalogEntryFixture();
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      const fetchStream = vi
        .spyOn(NexusMarketplaceService, 'fetchListingStream')
        .mockResolvedValue([createNexusListingDetailsFixture()]);
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(listing);

      await expect(CommerceApplication.getOrFetchListingsBySeller(COMMERCE_FIXTURE_SELLER)).resolves.toMatchObject([
        expect.objectContaining({ listing_id: 'boots_01' }),
      ]);

      expect(fetchStream).toHaveBeenCalledWith(
        expect.objectContaining({ seller_id: COMMERCE_FIXTURE_SELLER, state: 'active' }),
      );
      expect(fetchJson).toHaveBeenCalledOnce();
      expect(await LocalCommerceService.getCatalogEntriesBySeller(COMMERCE_FIXTURE_SELLER)).toEqual([catalogEntry]);
      expect(await LocalCommerceService.getListingsBySeller(COMMERCE_FIXTURE_SELLER)).toHaveLength(1);
    });

    it('hydrates canonical seller listings after discovering catalog entries', async () => {
      const first = createCommerceListingFixture({ listingId: 'boots_01' });
      const second = createCommerceListingFixture({ listingId: 'boots_02' });
      const listingRows = [
        new CommerceListingModel({
          id: `${COMMERCE_FIXTURE_SELLER}:boots_01`,
          listing_id: 'boots_01',
          record: first,
          revision: first.revision,
          state: 'active',
          category_id: first.categoryId,
          format: 'fixed_price',
          price_minor: 12_500,
          currency: 'USD',
          sync_status: 'synced',
          updated_at: Date.parse(first.updatedAt),
          seller_id: COMMERCE_FIXTURE_SELLER,
        }),
        new CommerceListingModel({
          id: `${COMMERCE_FIXTURE_SELLER}:boots_02`,
          listing_id: 'boots_02',
          record: second,
          revision: second.revision,
          state: 'active',
          category_id: second.categoryId,
          format: 'fixed_price',
          price_minor: 12_500,
          currency: 'USD',
          sync_status: 'synced',
          updated_at: Date.parse(second.updatedAt),
          seller_id: COMMERCE_FIXTURE_SELLER,
        }),
      ];
      vi.spyOn(LocalCommerceService, 'getListingsBySeller')
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(listingRows);
      vi.spyOn(LocalCommerceService, 'getCatalogEntriesBySeller').mockResolvedValue([
        createCommerceCatalogEntryFixture({ listing_id: 'boots_01' }),
        createCommerceCatalogEntryFixture({ listing_id: 'boots_02' }),
      ]);
      vi.spyOn(CommerceApplication, 'fetchSellerCatalogListings').mockResolvedValue(undefined);
      const hydrate = vi
        .spyOn(CommerceApplication, 'getOrFetchListing')
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);

      await expect(CommerceApplication.getOrFetchListingsBySeller(COMMERCE_FIXTURE_SELLER)).resolves.toHaveLength(2);
      expect(hydrate).toHaveBeenCalledWith(COMMERCE_FIXTURE_SELLER, 'boots_01');
      expect(hydrate).toHaveBeenCalledWith(COMMERCE_FIXTURE_SELLER, 'boots_02');
    });

    it('hydrates one seller from the Nexus index outside sandbox mode', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const stream = vi
        .spyOn(NexusMarketplaceService, 'fetchListingStream')
        .mockResolvedValue([createNexusListingDetailsFixture()]);
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);

      await CommerceApplication.fetchSellerCatalogListings(COMMERCE_FIXTURE_SELLER);

      expect(stream).toHaveBeenCalledWith(
        expect.objectContaining({ seller_id: COMMERCE_FIXTURE_SELLER, state: 'active' }),
      );
      expect(bulkUpsert).toHaveBeenCalledOnce();
    });

    it('never reads from Nexus in sandbox mode', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream');

      await CommerceApplication.fetchSellerCatalogListings(COMMERCE_FIXTURE_SELLER);

      expect(stream).not.toHaveBeenCalled();
    });
  });

  describe('fetchFollowedSellerCatalogListings', () => {
    const FOLLOWED_KNOWN_SELLER = COMMERCE_FIXTURE_SELLER;
    const FOLLOWED_SHOP_ONLY_SELLER = 's'.repeat(52);
    const FOLLOWED_NON_SELLER = 'z'.repeat(52);

    function mockLocalCache({ withShopOnlySeller = false } = {}) {
      vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'getAllCatalogEntries').mockResolvedValue([createCommerceCatalogEntryFixture()]);
      vi.spyOn(LocalCommerceService, 'getAllShops').mockResolvedValue(
        withShopOnlySeller
          ? [
              new CommerceShopModel({
                id: FOLLOWED_SHOP_ONLY_SELLER,
                owner_id: FOLLOWED_SHOP_ONLY_SELLER,
                record: createCommerceShopFixture({ ownerPubky: FOLLOWED_SHOP_ONLY_SELLER }),
                revision: 1,
                sync_status: 'synced',
                updated_at: 1_000,
              }),
            ]
          : [],
      );
      // Shop hydration for refreshed sellers stays cache-first.
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(
        new CommerceShopModel({
          id: FOLLOWED_KNOWN_SELLER,
          owner_id: FOLLOWED_KNOWN_SELLER,
          record: createCommerceShopFixture(),
          revision: 1,
          sync_status: 'synced',
          updated_at: 1_000,
        }),
      );
    }

    it('never reads from Nexus in sandbox mode or without follows', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream');

      await CommerceApplication.fetchFollowedSellerCatalogListings([FOLLOWED_KNOWN_SELLER]);
      expect(stream).not.toHaveBeenCalled();

      vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('transaction-service');
      await CommerceApplication.fetchFollowedSellerCatalogListings([]);
      expect(stream).not.toHaveBeenCalled();
    });

    it('issues one global page plus per-seller refreshes only for follows known to sell', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      mockLocalCache({ withShopOnlySeller: true });
      const stream = vi
        .spyOn(NexusMarketplaceService, 'fetchListingStream')
        .mockResolvedValue([createNexusListingDetailsFixture()]);

      await CommerceApplication.fetchFollowedSellerCatalogListings([
        FOLLOWED_NON_SELLER,
        FOLLOWED_KNOWN_SELLER,
        FOLLOWED_SHOP_ONLY_SELLER,
      ]);

      const sellerCalls = stream.mock.calls.map(([params]) => params?.seller_id).filter(Boolean);
      expect(stream).toHaveBeenNthCalledWith(1, { state: 'active', limit: 30 });
      // The known seller (cached index entry) and the shop-only seller are
      // refreshed; the followed account that never sold anything costs nothing.
      expect(sellerCalls).toEqual([FOLLOWED_KNOWN_SELLER, FOLLOWED_SHOP_ONLY_SELLER]);
    });

    it('caps per-seller refreshes at the configured budget', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const followedSellers = Array.from({ length: 10 }, (_, index) => String.fromCharCode(97 + index).repeat(52));
      vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'getAllCatalogEntries').mockResolvedValue(
        followedSellers.map((sellerId) =>
          createCommerceCatalogEntryFixture({ id: `${sellerId}:boots_01`, seller_id: sellerId }),
        ),
      );
      vi.spyOn(LocalCommerceService, 'getAllShops').mockResolvedValue([]);
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(
        new CommerceShopModel({
          id: COMMERCE_FIXTURE_SELLER,
          owner_id: COMMERCE_FIXTURE_SELLER,
          record: createCommerceShopFixture(),
          revision: 1,
          sync_status: 'synced',
          updated_at: 1_000,
        }),
      );
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([]);

      await CommerceApplication.fetchFollowedSellerCatalogListings(followedSellers);

      const sellerCalls = stream.mock.calls.map(([params]) => params?.seller_id).filter(Boolean);
      expect(sellerCalls).toEqual(
        followedSellers.slice(0, commerceConfig.MARKETPLACE_FOLLOWED_SHELF_MAX_SELLER_FETCHES),
      );
    });

    it('falls back to cache-known sellers when the global page fails, and survives per-seller failures', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      mockLocalCache({ withShopOnlySeller: true });
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockImplementation(async (params = {}) => {
        if (!params.seller_id) throw new TypeError('nexus unreachable');
        if (params.seller_id === FOLLOWED_SHOP_ONLY_SELLER) throw new TypeError('seller stream failed');
        return [createNexusListingDetailsFixture()];
      });

      await expect(
        CommerceApplication.fetchFollowedSellerCatalogListings([FOLLOWED_KNOWN_SELLER, FOLLOWED_SHOP_ONLY_SELLER]),
      ).resolves.toBeUndefined();

      const sellerCalls = stream.mock.calls.map(([params]) => params?.seller_id).filter(Boolean);
      expect(sellerCalls).toEqual([FOLLOWED_KNOWN_SELLER, FOLLOWED_SHOP_ONLY_SELLER]);
    });
  });

  describe('fetchMarketplaceTags', () => {
    const VIEWER = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo';
    const nexusTag = { label: 'handmade', taggers: [VIEWER], taggers_count: 1, relationship: true };

    it('fetches listing tags from Nexus and merges them into the local cache', async () => {
      const fetchSpy = vi.spyOn(NexusMarketplaceService, 'fetchListingTags').mockResolvedValue([nexusTag]);
      const mergeSpy = vi.spyOn(LocalMarketplaceTagService, 'mergeTags').mockResolvedValue(undefined);

      const result = await CommerceApplication.fetchMarketplaceTags({
        kind: TagKind.LISTING,
        taggedId: `${COMMERCE_FIXTURE_SELLER}:0034A0X7NJ52A`,
        viewerId: VIEWER,
      });

      expect(result).toEqual([nexusTag]);
      expect(fetchSpy).toHaveBeenCalledWith({
        seller_id: COMMERCE_FIXTURE_SELLER,
        listing_id: '0034A0X7NJ52A',
        skip_tags: undefined,
        limit_tags: undefined,
        viewer_id: VIEWER,
      });
      expect(mergeSpy).toHaveBeenCalledWith({
        taggedId: `listing:${COMMERCE_FIXTURE_SELLER}:0034A0X7NJ52A`,
        tags: [nexusTag],
        viewerId: VIEWER,
      });
    });

    it('fetches shop tags from Nexus keyed by the owner pubky', async () => {
      const fetchSpy = vi.spyOn(NexusMarketplaceService, 'fetchShopTags').mockResolvedValue([nexusTag]);
      const mergeSpy = vi.spyOn(LocalMarketplaceTagService, 'mergeTags').mockResolvedValue(undefined);

      await CommerceApplication.fetchMarketplaceTags({ kind: TagKind.SHOP, taggedId: COMMERCE_FIXTURE_SELLER });

      expect(fetchSpy).toHaveBeenCalledWith({
        seller_id: COMMERCE_FIXTURE_SELLER,
        skip_tags: undefined,
        limit_tags: undefined,
        viewer_id: undefined,
      });
      expect(mergeSpy).toHaveBeenCalledWith({
        taggedId: `shop:${COMMERCE_FIXTURE_SELLER}`,
        tags: [nexusTag],
        viewerId: null,
      });
    });

    it('returns [] without touching the cache when the tag endpoint answers 404 (not deployed)', async () => {
      vi.spyOn(NexusMarketplaceService, 'fetchListingTags').mockRejectedValue(
        Err.client(ClientErrorCode.NOT_FOUND, 'Not found', { service: ErrorService.Nexus, operation: 'fetchNexus' }),
      );
      const mergeSpy = vi.spyOn(LocalMarketplaceTagService, 'mergeTags');

      const result = await CommerceApplication.fetchMarketplaceTags({
        kind: TagKind.LISTING,
        taggedId: `${COMMERCE_FIXTURE_SELLER}:0034A0X7NJ52A`,
      });

      expect(result).toEqual([]);
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('propagates non-404 errors', async () => {
      vi.spyOn(NexusMarketplaceService, 'fetchShopTags').mockRejectedValue(new Error('nexus unreachable'));

      await expect(
        CommerceApplication.fetchMarketplaceTags({ kind: TagKind.SHOP, taggedId: COMMERCE_FIXTURE_SELLER }),
      ).rejects.toThrow('nexus unreachable');
    });

    it('skips the merge when Nexus returns an empty aggregate', async () => {
      vi.spyOn(NexusMarketplaceService, 'fetchShopTags').mockResolvedValue([]);
      const mergeSpy = vi.spyOn(LocalMarketplaceTagService, 'mergeTags');

      const result = await CommerceApplication.fetchMarketplaceTags({
        kind: TagKind.SHOP,
        taggedId: COMMERCE_FIXTURE_SELLER,
      });

      expect(result).toEqual([]);
      expect(mergeSpy).not.toHaveBeenCalled();
    });
  });

  describe('fetchCatalogListings', () => {
    const SELLER_B = 'b'.repeat(52);
    const SELLER_B_SHOP_URL = `pubky://${SELLER_B}/pub/pubky.app/marketplace/v1/shop.json`;
    const liveListingStream = JSON.parse(
      readFileSync(resolve(__dirname, '../../../test/fixtures/commerce/live/marketplace-listings.json'), 'utf8'),
    );

    it('never reads from Nexus in sandbox mode', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream');

      await CommerceApplication.fetchCatalogListings();

      expect(stream).not.toHaveBeenCalled();
    });

    it('passes server-side filters to the listing stream', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([]);

      await CommerceApplication.fetchCatalogListings({ saleFormat: 'auction', condition: 'like_new' });

      expect(stream).toHaveBeenCalledWith({
        state: 'active',
        limit: 30,
        sale_format: 'auction',
        condition: 'like_new',
      });
    });

    it('requests the auction end-time stream for the ending-soonest catalog', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([]);

      await CommerceApplication.fetchCatalogListings({ endingSoonest: true });

      expect(stream).toHaveBeenCalledWith({
        state: 'active',
        limit: 30,
        sorting: 'ends_at',
        order: 'ascending',
      });
    });

    it('caches the validated index projections without hydrating listings from homeservers', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([
        createNexusListingDetailsFixture(),
        createNexusAuctionListingDetailsFixture(),
      ]);
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(
        new CommerceShopModel({
          id: COMMERCE_FIXTURE_SELLER,
          owner_id: COMMERCE_FIXTURE_SELLER,
          record: createCommerceShopFixture(),
          revision: 1,
          sync_status: 'synced',
          updated_at: 1_000,
        }),
      );
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson');
      const upsertListing = vi.spyOn(LocalCommerceService, 'upsertListing');

      await CommerceApplication.fetchCatalogListings();

      expect(bulkUpsert).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ id: `${COMMERCE_FIXTURE_SELLER}:boots_01`, sale_format: 'fixed_price' }),
        expect.objectContaining({
          id: `${COMMERCE_FIXTURE_SELLER}:rangefinder_camera`,
          sale_format: 'auction',
          auction: expect.objectContaining({ endsAt: '2026-08-29T20:00:00.000Z' }),
        }),
      ]);
      expect(fetchJson).not.toHaveBeenCalled();
      expect(upsertListing).not.toHaveBeenCalled();
    });

    it('hydrates only shop records the cache is missing, deduplicated per seller', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([
        createNexusListingDetailsFixture(),
        createNexusListingDetailsFixture({ owner_id: SELLER_B, id: 'jacket_01' }),
        createNexusListingDetailsFixture({ owner_id: SELLER_B, id: 'scarf_01' }),
      ]);
      vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'getShop').mockImplementation(async (ownerId) =>
        ownerId === COMMERCE_FIXTURE_SELLER
          ? new CommerceShopModel({
              id: COMMERCE_FIXTURE_SELLER,
              owner_id: COMMERCE_FIXTURE_SELLER,
              record: createCommerceShopFixture(),
              revision: 1,
              sync_status: 'synced',
              updated_at: 1_000,
            })
          : null,
      );
      const sellerBShop = createCommerceShopFixture({ ownerPubky: SELLER_B, name: 'Block 9 Archive' });
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(sellerBShop);
      const upsertShop = vi.spyOn(LocalCommerceService, 'upsertShop').mockResolvedValue(undefined);

      await CommerceApplication.fetchCatalogListings();

      expect(fetchJson).toHaveBeenCalledExactlyOnceWith(SELLER_B_SHOP_URL);
      expect(upsertShop).toHaveBeenCalledExactlyOnceWith(sellerBShop, 'synced');
    });

    it('keeps the discovered catalog when one seller shop is unreachable', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([
        createNexusListingDetailsFixture(),
        createNexusListingDetailsFixture({ owner_id: SELLER_B, id: 'jacket_01' }),
      ]);
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(null);
      const sellerAShop = createCommerceShopFixture();
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async (url) => {
        if (url.startsWith(`pubky://${SELLER_B}/`)) throw new TypeError('seller homeserver unreachable');
        return sellerAShop;
      });
      const upsertShop = vi.spyOn(LocalCommerceService, 'upsertShop').mockResolvedValue(undefined);

      await expect(CommerceApplication.fetchCatalogListings()).resolves.toBeUndefined();

      expect(bulkUpsert).toHaveBeenCalledOnce();
      expect(upsertShop).toHaveBeenCalledExactlyOnceWith(sellerAShop, 'synced');
    });

    it('propagates a Nexus failure without touching the cache', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockRejectedValue(new Error('nexus unreachable'));
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries');
      const upsertShop = vi.spyOn(LocalCommerceService, 'upsertShop');

      await expect(CommerceApplication.fetchCatalogListings()).rejects.toThrow('nexus unreachable');
      expect(bulkUpsert).not.toHaveBeenCalled();
      expect(upsertShop).not.toHaveBeenCalled();
    });

    it('persists the live Nexus stream into the catalog cache', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      await CommerceCatalogEntryModel.table.clear();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(liveListingStream), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.spyOn(CommerceApplication, 'getOrFetchShop').mockResolvedValue(createCommerceShopFixture());

      await CommerceController.fetchCatalogListings({
        saleFormat: 'all',
        conditions: [],
        sort: 'recommended',
        countryCode: null,
      });

      expect(await CommerceCatalogEntryModel.table.count()).toBeGreaterThan(0);
    });

    it('rejects an invalid stream payload before caching anything', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([
        createNexusAuctionListingDetailsFixture({ auction_ends_at: null }),
      ]);
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries');

      await expect(CommerceApplication.fetchCatalogListings()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(bulkUpsert).not.toHaveBeenCalled();
    });
  });

  describe('getOrFetchListing revision freshness', () => {
    function cachedListingModel(revision: number) {
      const record = createCommerceListingFixture({ revision });
      return new CommerceListingModel({
        id: `${COMMERCE_FIXTURE_SELLER}:boots_01`,
        seller_id: COMMERCE_FIXTURE_SELLER,
        listing_id: 'boots_01',
        record,
        revision,
        state: 'active',
        category_id: 'fashion-shoes-boots',
        format: 'fixed_price',
        currency: 'USD',
        price_minor: 12_500,
        sync_status: 'synced',
        updated_at: Date.parse(record.updatedAt),
      });
    }

    it('returns a cached listing without fetching when the index has seen nothing newer', async () => {
      const cached = cachedListingModel(1);
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(cached);
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(
        new CommerceCatalogEntryModel(createCommerceCatalogEntryFixture({ revision: 1 })),
      );
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson');

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).resolves.toEqual(
        cached.record,
      );
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it('refetches the canonical record when the index revision moved past the cache', async () => {
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(cachedListingModel(1));
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(
        new CommerceCatalogEntryModel(createCommerceCatalogEntryFixture({ revision: 2 })),
      );
      const refreshedRecord = createCommerceListingFixture({ revision: 2 });
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(refreshedRecord);
      const upsertListing = vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).resolves.toEqual(
        refreshedRecord,
      );
      expect(upsertListing).toHaveBeenCalledExactlyOnceWith(refreshedRecord, 'synced');
    });

    it('rejects a canonical record older than the Nexus revision without overwriting the cache', async () => {
      await CommerceListingModel.table.clear();
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.put(cachedListingModel(1));
      await CommerceCatalogEntryModel.table.put(
        createCommerceCatalogEntryFixture({
          id: `${COMMERCE_FIXTURE_SELLER}:boots_01`,
          seller_id: COMMERCE_FIXTURE_SELLER,
          listing_id: 'boots_01',
          revision: 2,
        }),
      );
      const beforeListings = await CommerceListingModel.table.toArray();
      const beforeCatalog = await CommerceCatalogEntryModel.table.toArray();
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(createCommerceListingFixture({ revision: 1 }));

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });

      expect(await CommerceListingModel.table.toArray()).toEqual(beforeListings);
      expect(await CommerceCatalogEntryModel.table.toArray()).toEqual(beforeCatalog);
    });

    it('serves the cached record when a staleness refresh fails', async () => {
      const cached = cachedListingModel(1);
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(cached);
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(
        new CommerceCatalogEntryModel(createCommerceCatalogEntryFixture({ revision: 2 })),
      );
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(new TypeError('homeserver unreachable'));

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).resolves.toEqual(
        cached.record,
      );
    });

    it('propagates a fetch failure when no cached record exists', async () => {
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(null);
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(null);
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(new TypeError('homeserver unreachable'));

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).rejects.toThrow(
        'homeserver unreachable',
      );
    });

    it('rejects a canonical record whose identity does not match its requested path', async () => {
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(null);
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(null);
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(
        createCommerceListingFixture({ ownerPubky: 's'.repeat(52) }),
      );
      const upsertListing = vi.spyOn(LocalCommerceService, 'upsertListing');

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });

      expect(upsertListing).not.toHaveBeenCalled();
    });
  });

  describe('isListingConfirmedRemoved', () => {
    const homeserverError = (status: number) =>
      httpStatusCodeToError(status, 'Request failed', ErrorService.Homeserver, 'request', 'pubky://listing');
    const stubNexusStatus = (status: number) => {
      const fetchMock = vi.fn(async () => new Response(status === 200 ? '{}' : '', { status }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('confirms deletion when the homeserver and Nexus both answer 404, asking Nexus once', async () => {
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(null);
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(null);
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(homeserverError(404));
      const nexusFetch = stubNexusStatus(404);
      const fetchError = await CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01').catch(
        (error: unknown) => error,
      );

      await expect(
        CommerceApplication.isListingConfirmedRemoved(COMMERCE_FIXTURE_SELLER, 'boots_01', fetchError),
      ).resolves.toBe(true);
      expect(nexusFetch).toHaveBeenCalledOnce();
    });

    it('stays unknown when Nexus still lists the listing', async () => {
      stubNexusStatus(200);

      await expect(
        CommerceApplication.isListingConfirmedRemoved(COMMERCE_FIXTURE_SELLER, 'boots_01', homeserverError(404)),
      ).resolves.toBe(false);
    });

    it('stays unknown when Nexus fails without a 404', async () => {
      stubNexusStatus(503);

      await expect(
        CommerceApplication.isListingConfirmedRemoved(COMMERCE_FIXTURE_SELLER, 'boots_01', homeserverError(404)),
      ).resolves.toBe(false);
    });

    it('stays unknown when Nexus is unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('network down');
        }),
      );

      await expect(
        CommerceApplication.isListingConfirmedRemoved(COMMERCE_FIXTURE_SELLER, 'boots_01', homeserverError(404)),
      ).resolves.toBe(false);
    });

    it.each([
      ['a homeserver 500', homeserverError(500)],
      ['a homeserver transport failure', new TypeError('homeserver unreachable')],
    ])('never asks Nexus and stays unknown after %s', async (_label, fetchError) => {
      const nexusFetch = stubNexusStatus(404);

      await expect(
        CommerceApplication.isListingConfirmedRemoved(COMMERCE_FIXTURE_SELLER, 'boots_01', fetchError),
      ).resolves.toBe(false);
      expect(nexusFetch).not.toHaveBeenCalled();
    });

    it('does not treat a 404 from another service as a deleted listing', async () => {
      const nexusFetch = stubNexusStatus(404);
      const foreignNotFound = httpStatusCodeToError(404, 'Not found', ErrorService.Nexus, 'fetchNexus', 'https://n');

      await expect(
        CommerceApplication.isListingConfirmedRemoved(COMMERCE_FIXTURE_SELLER, 'boots_01', foreignNotFound),
      ).resolves.toBe(false);
      expect(nexusFetch).not.toHaveBeenCalled();
    });
  });

  /**
   * docs/ecommerce/step-up-approval.md, Option C: the widened homeserver
   * grant is requested LAZILY, only from the explicit re-auth CTA. A bridged
   * (narrow-grant) session must be able to browse, publish listings, and hit
   * the first checkout without the app ever requesting a wider approval on
   * its own. (The bridged-restore leg is asserted in
   * src/core/application/auth/auth.test.ts; the hook itself only starts from
   * its CTA — src/hooks/useStepUpReauth/useStepUpReauth.test.ts.)
   */
  describe('step-up re-approval is never auto-triggered', () => {
    it('browsing the catalog never requests a widened grant or a service session', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([]);
      const generateAuthUrlSpy = vi.spyOn(HomeserverService, 'generateAuthUrl');
      const beginSessionFlowSpy = vi.spyOn(MarketplaceSessionService, 'beginSessionFlow');

      await CommerceApplication.fetchCatalogListings();

      expect(generateAuthUrlSpy).not.toHaveBeenCalled();
      expect(beginSessionFlowSpy).not.toHaveBeenCalled();
    });

    it('publishing a listing under the narrow bridged grant never requests a widened grant', async () => {
      const record = createCommerceListingFixture();
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(LocalCommerceService, 'stageListingSync');
      // The public /pub write succeeds under the narrow grant.
      const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
      // Service registration fails without a marketplace session; the publish
      // stands and registration self-heals later — no approval is requested.
      vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
      vi.spyOn(MarketplaceGatewayService, 'execute').mockRejectedValue(
        Err.auth(AuthErrorCode.SESSION_EXPIRED, 'Connect a marketplace session to continue.', {
          service: ErrorService.Marketplace,
          operation: 'test',
        }),
      );
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      const generateAuthUrlSpy = vi.spyOn(HomeserverService, 'generateAuthUrl');
      const beginSessionFlowSpy = vi.spyOn(MarketplaceSessionService, 'beginSessionFlow');

      await expect(CommerceApplication.commitUpsertListing(record)).rejects.toMatchObject({
        code: AuthErrorCode.SESSION_EXPIRED,
      });

      expect(put).not.toHaveBeenCalled();
      expect(generateAuthUrlSpy).not.toHaveBeenCalled();
      expect(beginSessionFlowSpy).not.toHaveBeenCalled();
    });

    it('the first checkout fails closed on a missing session instead of auto-requesting any approval', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const sessionRequired = Err.auth(AuthErrorCode.SESSION_EXPIRED, 'Connect a marketplace session to continue.', {
        service: ErrorService.Marketplace,
        operation: 'test',
      });
      vi.spyOn(MarketplaceGatewayService, 'execute').mockRejectedValue(sessionRequired);
      const generateAuthUrlSpy = vi.spyOn(HomeserverService, 'generateAuthUrl');
      const beginSessionFlowSpy = vi.spyOn(MarketplaceSessionService, 'beginSessionFlow');

      await expect(
        CommerceApplication.executeMarketplaceCommand(COMMERCE_FIXTURE_SELLER, {
          version: 1,
          commandId: '018f47d2-6a27-7c23-a49d-6b21bb770299',
          aggregateId: 'checkout:018f47d2-6a27-7c23-a49d-6b21bb770299',
          expectedRevision: 0,
          issuedAt: new Date().toISOString(),
          kind: 'checkout.create',
          payload: {
            lines: [
              {
                listingAggregateId: `listing:${'s'.repeat(52)}_boots_01`,
                expectedRevision: 0,
                quantity: 1,
              },
            ],
            deliveryAddress: {
              name: 'Buyer',
              line1: '1 Main St',
              line2: '',
              city: 'Lisbon',
              region: 'Lisbon',
              postalCode: '1000-001',
              countryCode: 'PT',
            },
            guaranteePolicyVersion: 1,
          },
        } as never),
      ).rejects.toMatchObject({ code: AuthErrorCode.SESSION_EXPIRED, service: ErrorService.Marketplace });

      // The empty-caps service token comes only from the explicit connect
      // dialog; the wide homeserver grant only from the re-auth CTA.
      expect(generateAuthUrlSpy).not.toHaveBeenCalled();
      expect(beginSessionFlowSpy).not.toHaveBeenCalled();
    });
  });
});

function nexusRow(id: string, revision: number): NexusListingDetails {
  const row = SELLER_REFRESH_FIXTURE.nexus[0];
  return {
    ...row,
    id,
    uri: `pubky://${row.owner_id}/pub/pubky.app/marketplace/v1/listings/${id}`,
    revision,
  };
}
