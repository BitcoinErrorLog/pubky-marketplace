import { NEXUS_LISTINGS_PER_PAGE } from '@/config/nexus';
import {
  catalogItemFromCatalogEntry,
  type MarketplaceCatalogItem,
} from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { NEXUS_STREAM_LISTINGS_ROUTE } from '@/libs/commerce/nexus-routes';
import { Logger } from '@/libs/logger/logger';
import { getCommerceAdapterMode, getMarketplaceNexusUrl } from '@/libs/runtime-config/runtime-config';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { fetchShopForMetadata, OG_COMMERCE_REVALIDATE } from './ogCommerceData';

export interface MarketplaceCatalogSsrPayload {
  listings: MarketplaceCatalogItem[];
  shops: CommerceShopRecord[];
}

/**
 * Server-only first page of the public Nexus marketplace listing stream for
 * the `/marketplace` catalog HTML, plus shop records for the distinct sellers
 * on that page so SSR cards render the shop name (not the pubky fallback).
 * Same constraints as `ogCommerceData`: no Dexie/controller writes — a read of
 * public index projections and public `shop.json` records, cached with the
 * listing/shop OG revalidate window.
 *
 * Sandbox deployments never query Nexus (seeded local catalogs only).
 */
export async function fetchMarketplaceCatalogForSsr(): Promise<MarketplaceCatalogSsrPayload> {
  if (getCommerceAdapterMode() === 'sandbox') return { listings: [], shops: [] };

  const query = new URLSearchParams({
    state: 'active',
    limit: String(NEXUS_LISTINGS_PER_PAGE),
  });
  const url = `${getMarketplaceNexusUrl()}/${NEXUS_STREAM_LISTINGS_ROUTE}?${query.toString()}`;

  try {
    const res = await fetch(url, { next: { revalidate: OG_COMMERCE_REVALIDATE } });
    if (!res.ok) {
      Logger.warn('[ogCatalogData] Listing stream failed', { url, status: res.status });
      return { listings: [], shops: [] };
    }

    const json: unknown = await res.json();
    const listings = CommerceRecordNormalizer.nexusListingStream(json).map(catalogItemFromCatalogEntry);
    const shops = await fetchShopsForCatalogSellers(listings);
    return { listings, shops };
  } catch (error) {
    Logger.warn('[ogCatalogData] Failed to fetch marketplace listing stream', { error });
    return { listings: [], shops: [] };
  }
}

/**
 * Per-seller budget for catalog shop names. A seller whose record misses it
 * renders with the pubky fallback instead of holding up the catalog HTML.
 * One page caps the fan-out at `NEXUS_LISTINGS_PER_PAGE` sellers.
 */
export const CATALOG_SHOP_FETCH_TIMEOUT_MS = 800;

async function fetchShopsForCatalogSellers(listings: MarketplaceCatalogItem[]): Promise<CommerceShopRecord[]> {
  const sellers = [...new Set(listings.map((listing) => listing.sellerId))];
  const settled = await Promise.allSettled(
    sellers.map((seller) => fetchShopForMetadata(seller, { timeoutMs: CATALOG_SHOP_FETCH_TIMEOUT_MS })),
  );
  return settled.flatMap((result) => {
    if (result.status !== 'fulfilled' || result.value.kind !== 'found') return [];
    return [result.value.record];
  });
}
