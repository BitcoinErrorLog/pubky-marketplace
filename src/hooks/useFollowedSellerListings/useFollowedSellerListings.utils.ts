import {
  isCatalogItemOpen,
  type MarketplaceCatalogItem,
} from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';

/**
 * Composes the home-feed shelf from the local catalog: open listings (active, and no auction past its end time) whose
 * seller the viewer follows, most recently updated first, capped at `cap`.
 *
 * Pure recency ordering — the client holds no engagement or ranking signal
 * for listings (bids live in the transaction service, views are not tracked),
 * so nothing else is claimed. An empty result means the shelf renders
 * nothing, not an empty shell.
 */
export function composeFollowedSellerListings(
  items: MarketplaceCatalogItem[],
  followedPubkys: readonly string[],
  cap: number,
  nowMs: number = Date.now(),
): MarketplaceCatalogItem[] {
  if (followedPubkys.length === 0) return [];
  const followed = new Set(followedPubkys);
  return items
    .filter((item) => isCatalogItemOpen(item, nowMs) && followed.has(item.sellerId))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, cap);
}
