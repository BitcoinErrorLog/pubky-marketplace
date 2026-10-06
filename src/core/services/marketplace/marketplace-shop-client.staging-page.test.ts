import { PubkyShopClient } from '@bitcoinerrorlog/pubky-shop';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommerceInventoryApplication } from '@/application/commerce/inventory';
import { INVENTORY_GRANT } from '@/services/marketplace/marketplace-inventory-grant';
import { MarketplaceInventorySessionService } from '@/services/marketplace/marketplace-inventory-session';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import capturedPage from './staging-seller-listings.fixture.json';

const TOKEN = 'A'.repeat(43);
const SELLER = capturedPage.seller_pubky;
const originalFetch = globalThis.fetch;

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => 'transaction-service',
    getMarketplaceUrl: () => 'https://staging-api.pubky.app',
    isDurableCommerceMode: () => true,
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Chromium throws when `Window.fetch` is invoked with `this` bound to the
 * shop client. The captured staging page is served only after that call
 * succeeds, so removing the bind fails this test before any row is mapped.
 */
function chromiumFetch(this: unknown, input: RequestInfo | URL): Promise<Response> {
  if (this !== globalThis) {
    throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
  }
  const url = String(input);
  if (url.includes(`/v1/sellers/${SELLER}/listings`)) {
    return Promise.resolve(jsonResponse(capturedPage));
  }
  const marker = '/v1/inventory/listings/';
  const markerAt = url.indexOf(marker);
  if (markerAt !== -1) {
    const aggregateId = decodeURIComponent(url.slice(markerAt + marker.length));
    const entry = capturedPage.listings.find((item) => item.projection.aggregate_id === aggregateId);
    if (!entry) return Promise.resolve(new Response('missing', { status: 404 }));
    return Promise.resolve(
      jsonResponse({
        schema_version: 1,
        kind: 'inventory_projection',
        aggregate_id: aggregateId,
        seller_pubky: SELLER,
        listing_id: entry.projection.listing_id,
        server_revision: entry.projection.server_revision,
        stock: {
          authority: 'listing_total',
          available: entry.projection.available_quantity,
          reserved: entry.projection.reserved_quantity,
          sold: entry.projection.sold_quantity,
          total: entry.projection.total_quantity,
        },
      }),
    );
  }
  return Promise.reject(new Error(`unexpected ${url}`));
}

describe('staging seller listings page', () => {
  it('parses the captured page when the client is given Window.fetch directly', async () => {
    globalThis.fetch = chromiumFetch as typeof fetch;
    const client = new PubkyShopClient({
      session: TOKEN,
      serviceUrl: 'https://staging-api.pubky.app',
    });
    const page = await client.listings(SELLER, { limit: 100 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(Array.isArray(page.value.listings)).toBe(true);
    expect(page.value.listings).toHaveLength(3);
    expect(page.value.next_cursor).toBeNull();
  });

  it('loads zero-stock rows, null delivery, and an unavailable export through the real parser', async () => {
    expect(capturedPage.listings).toHaveLength(3);
    expect(capturedPage.next_cursor).toBeNull();
    for (const entry of capturedPage.listings) {
      expect(entry.projection.available_quantity).toBe(0);
      expect(entry.projection.reserved_quantity).toBe(0);
      expect(entry.projection.sold_quantity).toBe(0);
      expect(entry.projection.total_quantity).toBe(0);
      expect(entry.projection.auction).toBeNull();
      expect(entry.projection.digital_delivery).toBeNull();
    }
    expect(capturedPage.listings[1]?.record_status).toBe('unavailable');
    expect(capturedPage.listings[2]?.record_status).toBe('unavailable');
    expect(capturedPage.listings[0]).not.toHaveProperty('record_status');

    globalThis.fetch = chromiumFetch as typeof fetch;
    vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue({
      token: TOKEN,
      pubky: SELLER,
      capabilities: INVENTORY_GRANT,
      expiresAt: '2099-01-01T00:00:00.000Z',
      expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
      issuedAt: '2026-09-27T00:00:00.000Z',
    });
    vi.spyOn(MarketplaceInventorySessionService, 'getActiveSession').mockReturnValue({
      token: TOKEN,
      pubky: SELLER,
      capabilities: INVENTORY_GRANT,
      expiresAt: '2099-01-01T00:00:00.000Z',
      expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
      issuedAt: '2026-09-27T00:00:00.000Z',
    });

    const board = await CommerceInventoryApplication.loadBoard(SELLER);
    expect(board).toMatchObject({
      status: 'ready',
      rows: [
        {
          listingId: 'w4i_mujp0ovw_a',
          available: 0,
          reserved: 0,
          sold: 0,
          total: 0,
          serverRevision: 2,
          sync: 'synced',
          thumbUrl: `pubky://${SELLER}/pub/pubky.app/marketplace/v1/media/img_w4i_mujp0ovw_a`,
        },
        {
          listingId: 'w4i_mujp0ovw_b',
          available: 0,
          reserved: 0,
          sold: 0,
          total: 0,
          sync: 'synced',
          recordStatus: 'unavailable',
        },
        {
          listingId: 'w4i_mujp0ovw_c',
          available: 0,
          reserved: 0,
          sold: 0,
          total: 0,
          sync: 'synced',
          recordStatus: 'unavailable',
        },
      ],
    });
  });
});
