'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  getCommerceAdapterMode,
  MARKETPLACE_FOLLOWED_SHELF_FOLLOWS_LIMIT,
  MARKETPLACE_FOLLOWED_SHELF_MAX_CARDS,
} from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { StreamUserController } from '@/controllers/stream/users/users';
import type { MarketplaceCatalogItem } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { buildMarketplaceCatalogItems } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { Logger } from '@/libs/logger/logger';
import type { Pubky } from '@/models/models.types';
import { UserStreamReach } from '@/services/nexus/nexus.types';
import { useAuthStore } from '@/stores/auth/auth.store';
import { composeFollowedSellerListings } from './useFollowedSellerListings.utils';

export interface UseFollowedSellerListingsResult {
  /** Active listings from followed sellers, most recent first; empty renders no shelf. */
  listings: MarketplaceCatalogItem[];
  shopsBySeller: Map<string, CommerceShopRecord>;
}

/**
 * Data for the home-feed "From sellers you follow" shelf.
 *
 * Composition is client-side: the viewer's Nexus-fed follow stream
 * (one slice, capped at {@link MARKETPLACE_FOLLOWED_SHELF_FOLLOWS_LIMIT} most
 * recent follows) is intersected with the marketplace index cache, which one
 * bounded refresh keeps warm (see
 * `CommerceApplication.fetchFollowedSellerCatalogListings` for the request
 * budget). The shelf renders from Dexie, so it degrades to cached listings
 * when Nexus is unreachable and to nothing when nothing is honestly known.
 *
 * Gating: inert (no reads, no fetches, empty result) when the marketplace
 * adapter mode is `unavailable` — the same gate as the marketplace nav entry —
 * or when signed out, since the shelf is defined by the viewer's follows.
 */
export function useFollowedSellerListings(): UseFollowedSellerListingsResult {
  const adapterMode = getCommerceAdapterMode();
  const viewerPubky = useAuthStore((state) => state.currentUserPubky);
  const isEnabled = adapterMode !== 'unavailable' && viewerPubky !== null;

  const [followedPubkys, setFollowedPubkys] = useState<Pubky[]>([]);

  useEffect(() => {
    if (!isEnabled) return;

    let active = true;
    StreamUserController.getOrFetchStreamSlice({
      streamId: `${viewerPubky}:${UserStreamReach.FOLLOWING}`,
      limit: MARKETPLACE_FOLLOWED_SHELF_FOLLOWS_LIMIT,
      skip: 0,
    })
      .then(({ nextPageIds }) => {
        if (!active) return undefined;
        setFollowedPubkys(nextPageIds);
        return CommerceController.fetchFollowedSellerListings(nextPageIds);
      })
      .catch((error) => {
        // The shelf renders whatever the local cache honestly holds; a failed
        // follow read or index refresh only means it does not widen now.
        Logger.warn('[useFollowedSellerListings] Refresh failed; rendering cached shelf', { error });
      });

    return () => {
      active = false;
    };
  }, [isEnabled, viewerPubky]);

  const localListings = useLiveQuery(() => (isEnabled ? CommerceController.getAllListings() : []), [isEnabled]);
  const catalogEntries = useLiveQuery(() => (isEnabled ? CommerceController.getAllCatalogEntries() : []), [isEnabled]);
  const localShops = useLiveQuery(() => (isEnabled ? CommerceController.getAllShops() : []), [isEnabled]);

  const listings = isEnabled
    ? composeFollowedSellerListings(
        buildMarketplaceCatalogItems(localListings ?? [], catalogEntries ?? []),
        followedPubkys,
        MARKETPLACE_FOLLOWED_SHELF_MAX_CARDS,
      )
    : [];
  const shopsBySeller = new Map((localShops ?? []).map(({ owner_id, record }) => [owner_id, record]));

  return { listings, shopsBySeller };
}
