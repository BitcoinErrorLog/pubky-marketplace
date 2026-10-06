import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceShopClientService } from './marketplace-shop-client';

const PUBKY = 'y'.repeat(52);
const TOKEN = 'A'.repeat(43);
const originalFetch = globalThis.fetch;

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getMarketplaceUrl: () => 'https://staging-api.pubky.app',
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('MarketplaceShopClientService.createInventoryClient', () => {
  it('binds Window.fetch so Chromium cannot illegally invoke it', async () => {
    globalThis.fetch = function windowFetch(this: unknown, input: RequestInfo | URL) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      expect(String(input)).toContain(`/v1/sellers/${PUBKY}/listings`);
      return Promise.resolve(
        new Response(JSON.stringify({ kind: 'seller_listing_export', listings: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    } as typeof fetch;

    const client = MarketplaceShopClientService.createInventoryClient(TOKEN);
    const result = await MarketplaceShopClientService.listSellerListings(client, PUBKY, { limit: 100 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value.listings)).toBe(true);
    }
  });
});
