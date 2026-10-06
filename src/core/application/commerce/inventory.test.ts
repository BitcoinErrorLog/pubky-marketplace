import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMERCE_LISTING_MAX_QUANTITY } from '@/config/commerce';
import { INVENTORY_GRANT } from '@/services/marketplace/marketplace-inventory-grant';
import { MarketplaceInventorySessionService } from '@/services/marketplace/marketplace-inventory-session';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { MarketplaceShopClientService, PubkyShopError } from '@/services/marketplace/marketplace-shop-client';
import capturedParity from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import {
  classifySyncManyItem,
  CommerceInventoryApplication,
  type InventoryBoardRow,
  planInventoryAdjust,
} from './inventory';
import capturedUnavailableExport from './unavailable-listing-export.fixture.json';

const PUBKY = 'y'.repeat(52);
const TOKEN = 'A'.repeat(43);

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => 'transaction-service',
    getMarketplaceUrl: () => 'https://staging-api.pubky.app',
    isDurableCommerceMode: () => true,
  };
});

vi.mock('@/services/marketplace/marketplace-shop-client', () => {
  class MockPubkyShopError extends Error {
    readonly code: string;
    readonly details: { status?: number; serviceCode?: string };
    constructor(code: string, details: { status?: number; serviceCode?: string } = {}) {
      super(code);
      this.code = code;
      this.details = details;
    }
  }
  return {
    PubkyShopError: MockPubkyShopError,
    MarketplaceShopClientService: {
      createInventoryClient: vi.fn(() => ({ token: 'inventory' })),
      listSellerListings: vi.fn(),
      getInventoryProjection: vi.fn(),
      adjustInventory: vi.fn(),
      syncMany: vi.fn(),
      isCapabilityRequired: (error: InstanceType<typeof MockPubkyShopError>) =>
        error.code === 'service_error' && error.details.serviceCode === 'capability_required',
      isRevisionConflict: (error: InstanceType<typeof MockPubkyShopError>) =>
        error.code === 'service_error' && error.details.serviceCode === 'revision_conflict',
      isSessionRejected: (error: InstanceType<typeof MockPubkyShopError>) => error.code === 'session_rejected',
    },
  };
});

function row(overrides: Partial<InventoryBoardRow> = {}): InventoryBoardRow {
  return {
    listingId: 'boots',
    sellerPubky: PUBKY,
    aggregateId: `listing:${PUBKY}_boots`,
    title: 'Boots',
    thumbUrl: null,
    state: 'active',
    format: 'fixed_price',
    dropId: null,
    available: 4,
    reserved: 1,
    sold: 2,
    total: 7,
    serverRevision: 3,
    sync: 'synced',
    ...overrides,
  };
}

describe('planInventoryAdjust', () => {
  it('builds delta, expected_revision, and a UUID idempotency key', () => {
    const plan = planInventoryAdjust({
      listingId: 'boots',
      aggregateId: `listing:${PUBKY}_boots`,
      currentAvailable: 4,
      targetAvailable: 6,
      expectedRevision: 3,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    expect(plan).toEqual({
      ok: true,
      request: {
        schema_version: 1,
        kind: 'inventory.adjust',
        aggregate_id: `listing:${PUBKY}_boots`,
        listing_id: 'boots',
        expected_revision: BigInt(3),
        delta: BigInt(2),
        idempotency_key: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('rejects a zero delta and a negative target', () => {
    expect(
      planInventoryAdjust({
        listingId: 'boots',
        aggregateId: 'listing:x',
        currentAvailable: 4,
        targetAvailable: 4,
        expectedRevision: 1,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      }).ok,
    ).toBe(false);
    expect(
      planInventoryAdjust({
        listingId: 'boots',
        aggregateId: 'listing:x',
        currentAvailable: 4,
        targetAvailable: -1,
        expectedRevision: 1,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      }),
    ).toEqual({ ok: false, reason: 'negative_available' });
  });
});

describe('CommerceInventoryApplication', () => {
  beforeEach(() => {
    vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue({
      token: TOKEN,
      pubky: PUBKY,
      capabilities: '',
      expiresAt: '2099-01-01T00:00:00.000Z',
      expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
      issuedAt: '2026-09-21T00:00:00.000Z',
    });
    vi.spyOn(MarketplaceInventorySessionService, 'getActiveSession').mockReturnValue({
      token: 'I'.repeat(43),
      pubky: PUBKY,
      capabilities: INVENTORY_GRANT,
      expiresAt: '2099-01-01T00:00:00.000Z',
      expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
      issuedAt: '2026-09-21T00:00:00.000Z',
    });
    vi.mocked(MarketplaceShopClientService.listSellerListings).mockReset();
    vi.mocked(MarketplaceShopClientService.getInventoryProjection).mockReset();
    vi.mocked(MarketplaceShopClientService.adjustInventory).mockReset();
    vi.mocked(MarketplaceShopClientService.syncMany).mockReset();
  });

  it('returns grant-needed when inventory coverage is missing', async () => {
    vi.spyOn(MarketplaceInventorySessionService, 'getActiveSession').mockReturnValue(null);
    await expect(CommerceInventoryApplication.loadBoard(PUBKY)).resolves.toEqual({ status: 'grant-needed' });
    expect(MarketplaceShopClientService.listSellerListings).not.toHaveBeenCalled();
  });

  it('returns grant-needed on 403 capability_required', async () => {
    vi.mocked(MarketplaceShopClientService.listSellerListings).mockResolvedValue({
      ok: false,
      error: new PubkyShopError('service_error', { status: 403, serviceCode: 'capability_required' }),
    });
    await expect(CommerceInventoryApplication.loadBoard(PUBKY)).resolves.toEqual({ status: 'grant-needed' });
  });

  it('does not send a second adjust after 409 revision_conflict', async () => {
    vi.mocked(MarketplaceShopClientService.adjustInventory).mockResolvedValue({
      ok: false,
      error: new PubkyShopError('service_error', { status: 409, serviceCode: 'revision_conflict' }),
    });
    const result = await CommerceInventoryApplication.setAvailable({
      sellerPubky: PUBKY,
      row: row(),
      targetAvailable: 5,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    expect(result).toEqual({ status: 'revision_conflict' });
    expect(MarketplaceShopClientService.adjustInventory).toHaveBeenCalledTimes(1);
  });

  it('loads listing-total stock from the seller export then the inventory projection', async () => {
    vi.mocked(MarketplaceShopClientService.listSellerListings).mockResolvedValue({
      ok: true,
      value: {
        kind: 'seller_listing_export',
        listings: [
          {
            projection: {
              listing_id: 'boots',
              title: 'Vintage work boots',
              state: 'active',
              sale_format: 'fixed_price',
            },
            record: { listingId: 'boots', title: 'Vintage work boots' },
          },
        ],
      },
    });
    vi.mocked(MarketplaceShopClientService.getInventoryProjection).mockResolvedValue({
      ok: true,
      value: {
        schema_version: BigInt(1),
        kind: 'inventory_projection',
        aggregate_id: `listing:${PUBKY}_boots`,
        seller_pubky: PUBKY,
        listing_id: 'boots',
        server_revision: BigInt(3),
        stock: {
          authority: 'listing_total',
          available: BigInt(4),
          reserved: BigInt(2),
          sold: BigInt(1),
          total: BigInt(7),
        },
      },
    } as Awaited<ReturnType<typeof MarketplaceShopClientService.getInventoryProjection>>);
    await expect(CommerceInventoryApplication.loadBoard(PUBKY)).resolves.toEqual({
      status: 'ready',
      rows: [
        {
          listingId: 'boots',
          sellerPubky: PUBKY,
          aggregateId: `listing:${PUBKY}_boots`,
          title: 'Vintage work boots',
          thumbUrl: null,
          state: 'active',
          format: 'fixed_price',
          dropId: null,
          available: 4,
          reserved: 2,
          sold: 1,
          total: 7,
          serverRevision: 3,
          sync: 'synced',
        },
      ],
    });
    expect(MarketplaceShopClientService.getInventoryProjection).toHaveBeenCalledWith(
      expect.anything(),
      `listing:${PUBKY}_boots`,
    );
  });

  it('renders an unavailable export row from projection without a homeserver record', async () => {
    expect(capturedUnavailableExport.record_status).toBe('unavailable');
    expect(capturedUnavailableExport).not.toHaveProperty('record');
    expect(capturedUnavailableExport).not.toHaveProperty('record_bytes_base64');
    expect(capturedUnavailableExport).not.toHaveProperty('record_sha256');
    vi.mocked(MarketplaceShopClientService.listSellerListings).mockResolvedValue({
      ok: true,
      value: {
        kind: 'seller_listing_export',
        listings: [capturedUnavailableExport],
      },
    });
    vi.mocked(MarketplaceShopClientService.getInventoryProjection).mockResolvedValue({
      ok: true,
      value: {
        schema_version: BigInt(1),
        kind: 'inventory_projection',
        aggregate_id: capturedUnavailableExport.projection.aggregate_id,
        seller_pubky: PUBKY,
        listing_id: capturedUnavailableExport.projection.listing_id,
        server_revision: BigInt(1),
        stock: {
          authority: 'listing_total',
          available: BigInt(1),
          reserved: BigInt(0),
          sold: BigInt(0),
          total: BigInt(1),
        },
      },
    } as Awaited<ReturnType<typeof MarketplaceShopClientService.getInventoryProjection>>);

    await expect(CommerceInventoryApplication.loadBoard(PUBKY)).resolves.toEqual({
      status: 'ready',
      rows: [
        {
          listingId: '0789dcfe82644b8bbdd3e559d0015356',
          sellerPubky: PUBKY,
          aggregateId: capturedUnavailableExport.projection.aggregate_id,
          title: 'Cutover test — do not buy — Locks 1A proof',
          thumbUrl: null,
          state: 'available',
          format: 'fixed_price',
          dropId: null,
          available: 1,
          reserved: 0,
          sold: 0,
          total: 1,
          serverRevision: 1,
          sync: 'synced',
          recordStatus: 'unavailable',
        },
      ],
    });
  });

  function purchaseSessionOnly(capabilities: string) {
    vi.spyOn(MarketplaceInventorySessionService, 'getActiveSession').mockReturnValue(null);
    vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue({
      token: TOKEN,
      pubky: PUBKY,
      capabilities,
      expiresAt: '2099-01-01T00:00:00.000Z',
      expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
      issuedAt: '2026-09-21T00:00:00.000Z',
    });
  }

  it('loads the board with a Bitkit purchase session that carries the inventory scope', async () => {
    purchaseSessionOnly(capturedParity.parity_request.homeserver_verified);
    vi.mocked(MarketplaceShopClientService.createInventoryClient).mockClear();
    vi.mocked(MarketplaceShopClientService.listSellerListings).mockResolvedValue({
      ok: true,
      value: { listings: [], next_cursor: null },
    } as never);

    const result = await CommerceInventoryApplication.loadBoard(PUBKY);

    expect(result.status).not.toBe('grant-needed');
    expect(MarketplaceShopClientService.createInventoryClient).toHaveBeenCalledWith(TOKEN);
  });

  it('still needs the Studio grant when the purchase session is identity-only', async () => {
    purchaseSessionOnly('');
    await expect(CommerceInventoryApplication.loadBoard(PUBKY)).resolves.toEqual({ status: 'grant-needed' });
    expect(MarketplaceShopClientService.listSellerListings).not.toHaveBeenCalled();
  });

  it('drops the purchase session, not the Studio slot, when the service rejects its bearer', async () => {
    purchaseSessionOnly(capturedParity.parity_request.homeserver_verified);
    const clearPurchase = vi.spyOn(MarketplaceSessionService, 'clearSessionIfBearer').mockImplementation(() => {});
    const clearStudio = vi.spyOn(MarketplaceInventorySessionService, 'clearSession').mockImplementation(() => {});
    vi.mocked(MarketplaceShopClientService.adjustInventory).mockResolvedValue({
      ok: false,
      error: new PubkyShopError('session_rejected', { status: 401 }),
    });

    const result = await CommerceInventoryApplication.setAvailable({
      sellerPubky: PUBKY,
      row: row(),
      targetAvailable: 5,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });

    expect(result.status).toBe('grant-needed');
    expect(clearPurchase).toHaveBeenCalledWith(TOKEN, 'rejected');
    expect(clearStudio).not.toHaveBeenCalled();
  });

  it('does not treat 409 as a grant miss', async () => {
    vi.mocked(MarketplaceShopClientService.adjustInventory).mockResolvedValue({
      ok: false,
      error: new PubkyShopError('service_error', { status: 409, serviceCode: 'revision_conflict' }),
    });
    const result = await CommerceInventoryApplication.setAvailable({
      sellerPubky: PUBKY,
      row: row(),
      targetAvailable: 5,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    expect(result.status).not.toBe('grant-needed');
  });

  it('marks unlimited stock from a digital-only record even when a hold has lowered available', async () => {
    const stock = {
      authority: 'listing_total',
      available: BigInt(4),
      reserved: BigInt(1),
      sold: BigInt(0),
      total: BigInt(5),
    };
    vi.mocked(MarketplaceShopClientService.listSellerListings).mockResolvedValue({
      ok: true,
      value: {
        kind: 'seller_listing_export',
        listings: [
          {
            projection: { listing_id: 'guide', title: 'Guide', state: 'active', sale_format: 'fixed_price' },
            record: {
              fulfillmentMethods: ['digital'],
              variants: [{ quantity: COMMERCE_LISTING_MAX_QUANTITY }],
            },
          },
          {
            projection: { listing_id: 'boots', title: 'Boots', state: 'active', sale_format: 'fixed_price' },
            record: {
              fulfillmentMethods: ['physical'],
              variants: [{ quantity: COMMERCE_LISTING_MAX_QUANTITY }],
            },
          },
          {
            projection: { listing_id: 'locks', title: 'Locks', state: 'active', sale_format: 'fixed_price' },
            record: {
              fulfillmentMethods: ['digital'],
              digitalLock: { policyUri: 'pubky://locks' },
              variants: [{ quantity: COMMERCE_LISTING_MAX_QUANTITY }],
            },
          },
        ],
      },
    });
    vi.mocked(MarketplaceShopClientService.getInventoryProjection).mockResolvedValue({
      ok: true,
      value: {
        schema_version: BigInt(1),
        kind: 'inventory_projection',
        aggregate_id: `listing:${PUBKY}_guide`,
        seller_pubky: PUBKY,
        listing_id: 'guide',
        server_revision: BigInt(3),
        stock,
      },
    } as Awaited<ReturnType<typeof MarketplaceShopClientService.getInventoryProjection>>);

    const board = await CommerceInventoryApplication.loadBoard(PUBKY);
    expect(board.status).toBe('ready');
    if (board.status !== 'ready') return;
    const byId = Object.fromEntries(board.rows.map((entry) => [entry.listingId, entry]));
    expect(byId.guide).toMatchObject({ unlimited: true, available: 4 });
    expect(byId.boots.unlimited).toBeUndefined();
    expect(byId.locks.unlimited).toBeUndefined();
  });
});

describe('classifySyncManyItem', () => {
  it('treats HTTP 207 envelope items as per-id success or failure', () => {
    expect(classifySyncManyItem({ listing_id: 'boots', status: 200 }).ok).toBe(true);
    expect(
      classifySyncManyItem({
        listing_id: 'hats',
        status: 500,
        result: { ok: false, error: { code: 'internal', message: 'The listing could not be synchronized.' } },
      }),
    ).toEqual({
      listingId: 'hats',
      ok: false,
      message: 'The listing could not be synchronized.',
    });
  });
});

describe('CommerceInventoryApplication.retrySync', () => {
  beforeEach(() => {
    vi.spyOn(MarketplaceInventorySessionService, 'getActiveSession').mockReturnValue({
      token: 'I'.repeat(43),
      pubky: PUBKY,
      capabilities: INVENTORY_GRANT,
      expiresAt: '2099-01-01T00:00:00.000Z',
      expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
      issuedAt: '2026-09-21T00:00:00.000Z',
    });
    vi.mocked(MarketplaceShopClientService.syncMany).mockReset();
  });

  it('classifies a mixed 207 per listing id and only requests the retried id', async () => {
    vi.mocked(MarketplaceShopClientService.syncMany).mockResolvedValue({
      ok: true,
      value: {
        schema_version: BigInt(1),
        kind: 'listing.sync_many',
        results: [
          { listing_id: 'boots', seller_pubky: PUBKY, status: 200, result: { ok: true } },
          {
            listing_id: 'hats',
            seller_pubky: PUBKY,
            status: 500,
            result: { ok: false, error: { code: 'internal', message: 'The listing could not be synchronized.' } },
          },
        ],
      },
    } as Awaited<ReturnType<typeof MarketplaceShopClientService.syncMany>>);

    await expect(CommerceInventoryApplication.retrySync(PUBKY, 'boots')).resolves.toEqual({
      status: 'synced',
      listingId: 'boots',
    });
    expect(MarketplaceShopClientService.syncMany).toHaveBeenCalledWith(expect.anything(), [
      { seller_pubky: PUBKY, listing_id: 'boots' },
    ]);

    await expect(CommerceInventoryApplication.retrySync(PUBKY, 'hats')).resolves.toEqual({
      status: 'missing',
      listingId: 'hats',
      message: 'The listing could not be synchronized.',
    });
    expect(MarketplaceShopClientService.syncMany).toHaveBeenLastCalledWith(expect.anything(), [
      { seller_pubky: PUBKY, listing_id: 'hats' },
    ]);
  });

  it('does not treat a 207 success as a generic refetch error', async () => {
    vi.mocked(MarketplaceShopClientService.syncMany).mockResolvedValue({
      ok: true,
      value: {
        schema_version: BigInt(1),
        kind: 'listing.sync_many',
        results: [{ listing_id: 'boots', status: 200 }],
      },
    } as Awaited<ReturnType<typeof MarketplaceShopClientService.syncMany>>);
    await expect(CommerceInventoryApplication.retrySync(PUBKY, 'boots')).resolves.toEqual({
      status: 'synced',
      listingId: 'boots',
    });
  });
});
