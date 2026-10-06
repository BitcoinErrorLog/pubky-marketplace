'use client';

import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getCommerceAdapterMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { CommerceWatchSnapshotModelSchema } from '@/models/commerce/commerce.schema';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  buildMarketplaceCatalogItems,
  type MarketplaceCatalogItem,
} from '../useMarketplaceCatalog/useMarketplaceCatalog.utils';

export interface MarketplaceWatchlistEntry {
  /** Composite `seller:listingId`. */
  listingId: string;
  sellerId: string;
  rawListingId: string;
  watchedAt: number;
  /**
   * The catalog item when this device holds the listing (cached record or
   * index projection — detection passes keep the index projection fresh for
   * watched items). Null when neither cache has it yet; the row then renders
   * from the snapshot title or the bare id instead of pretending to know.
   */
  item: MarketplaceCatalogItem | null;
  /** The last state this device observed for the item, when a check has run. */
  snapshot: CommerceWatchSnapshotModelSchema | null;
}

/**
 * The signed-in user's watchlist: their favorites (one concept — the
 * watchlist IS the favorites store, presented properly) joined with the
 * local catalog caches and the per-item observation snapshots. Live queries
 * throughout, so unwatching, detection passes, and catalog refreshes all
 * re-render without wiring.
 */
export function useMarketplaceWatchlist() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const adapterMode = getCommerceAdapterMode();
  const watchlistSyncStatus = useCommerceStore((state) => state.watchlistSyncStatus);

  // One cross-device sync round per visit: pulls the private homeserver
  // document, merges (LWW per item), pushes back local changes, and mirrors
  // the outcome — including the honest "needs re-approval" state — into the
  // store this hook reads.
  useEffect(() => {
    if (!currentUserPubky) return;
    void CommerceController.syncWatchlist();
  }, [currentUserPubky]);

  /** Re-runs the sync round on demand — e.g. after a step-up re-approval widened the grant. */
  const syncWatchlist = () => CommerceController.syncWatchlist();

  const favorites = useLiveQuery(() => (currentUserPubky ? CommerceController.getFavorites() : []), [currentUserPubky]);
  const localListings = useLiveQuery(() => CommerceController.getAllListings(), []);
  const catalogEntries = useLiveQuery(() => CommerceController.getAllCatalogEntries(), []);
  const snapshots = useLiveQuery(async () => {
    if (!currentUserPubky) return [];
    return await CommerceController.getWatchSnapshots();
  }, [currentUserPubky]);

  const itemsById = new Map(
    buildMarketplaceCatalogItems(localListings ?? [], catalogEntries ?? []).map((item) => [item.id, item]),
  );
  const snapshotsByListing = new Map((snapshots ?? []).map((snapshot) => [snapshot.listing_id, snapshot]));

  const entries: MarketplaceWatchlistEntry[] = (favorites ?? [])
    .map((favorite) => {
      const separator = favorite.listing_id.indexOf(':');
      return {
        listingId: favorite.listing_id,
        sellerId: favorite.listing_id.slice(0, separator),
        rawListingId: favorite.listing_id.slice(separator + 1),
        watchedAt: favorite.created_at,
        item: itemsById.get(favorite.listing_id) ?? null,
        snapshot: snapshotsByListing.get(favorite.listing_id) ?? null,
      };
    })
    .sort((left, right) => right.watchedAt - left.watchedAt);

  return {
    entries,
    isLoading: Boolean(currentUserPubky) && (favorites === undefined || localListings === undefined),
    isSignedIn: Boolean(currentUserPubky),
    adapterMode,
    syncWatchlist,
    /** `needs_reauth` = the session's grant cannot write /priv (or a write was refused); watching still works locally. */
    watchlistSyncStatus,
  };
}
