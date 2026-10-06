'use client';

import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getCommerceAdapterMode, MARKETPLACE_HOT_MODULE_MAX_CARDS } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceCatalogItem } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { buildMarketplaceCatalogItems } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { Logger } from '@/libs/logger/logger';
import { composeEndingSoonListings, composeFreshListings } from './useMarketplaceHotListings.utils';

export interface UseMarketplaceHotListingsResult {
  /** Active auctions closing soonest (auction end-time stream); empty renders no module. */
  endingSoon: MarketplaceCatalogItem[];
  /** Most recently updated active listings, minus the ending-soon cards; empty renders no module. */
  fresh: MarketplaceCatalogItem[];
  shopsBySeller: Map<string, CommerceShopRecord>;
}

/**
 * Data for the Hot-page marketplace modules ("Ending soon" + "Fresh
 * listings").
 *
 * Cost model: one refresh issues at most two Nexus listing-stream requests —
 * the auction end-time stream (`sorting=ends_at&order=ascending`) and the
 * default indexing timeline — through the same catalog-cache path the
 * marketplace grid uses. Both modules then render from Dexie, so an
 * unreachable Nexus degrades to cached listings and an empty index (for
 * example while the marketplace Nexus replays history) renders nothing.
 *
 * Ranking honesty: ordering is deadline- and recency-based only; see the
 * composition utils for why bid-count ranking is not offered.
 *
 * Gating: inert when the marketplace adapter mode is `unavailable` — the
 * same gate as the marketplace nav entry. Signed-out visitors are served:
 * the Nexus listing stream is a public read, like the rest of the Hot page.
 */
export function useMarketplaceHotListings(): UseMarketplaceHotListingsResult {
  const adapterMode = getCommerceAdapterMode();
  const isEnabled = adapterMode !== 'unavailable';

  useEffect(() => {
    if (!isEnabled) return;

    let active = true;
    void Promise.allSettled([
      CommerceController.fetchCatalogListings({ saleFormat: 'all', conditions: [], sort: 'ending_soon' }),
      CommerceController.fetchCatalogListings({ saleFormat: 'all', conditions: [], sort: 'newest' }),
    ]).then((results) => {
      if (!active) return;
      results.forEach((result) => {
        if (result.status === 'rejected') {
          // The modules keep rendering from the local cache; discovery just
          // does not widen until Nexus is reachable again.
          Logger.warn('[useMarketplaceHotListings] Nexus refresh failed; rendering cached modules', {
            error: result.reason,
          });
        }
      });
    });

    return () => {
      active = false;
    };
  }, [isEnabled]);

  const localListings = useLiveQuery(() => (isEnabled ? CommerceController.getAllListings() : []), [isEnabled]);
  const catalogEntries = useLiveQuery(() => (isEnabled ? CommerceController.getAllCatalogEntries() : []), [isEnabled]);
  const localShops = useLiveQuery(() => (isEnabled ? CommerceController.getAllShops() : []), [isEnabled]);

  const items = isEnabled ? buildMarketplaceCatalogItems(localListings ?? [], catalogEntries ?? []) : [];
  const endingSoon = composeEndingSoonListings(items, MARKETPLACE_HOT_MODULE_MAX_CARDS);
  const fresh = composeFreshListings(items, new Set(endingSoon.map(({ id }) => id)), MARKETPLACE_HOT_MODULE_MAX_CARDS);
  const shopsBySeller = new Map((localShops ?? []).map(({ owner_id, record }) => [owner_id, record]));

  return { endingSoon, fresh, shopsBySeller };
}
