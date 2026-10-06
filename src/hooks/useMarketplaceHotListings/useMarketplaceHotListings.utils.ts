import {
  isCatalogItemOpen,
  type MarketplaceCatalogItem,
} from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { CommerceCatalogAuctionTerms } from '@/models/commerce/commerce.schema';

export type MarketplaceAuctionCatalogItem = MarketplaceCatalogItem & { auction: CommerceCatalogAuctionTerms };

/**
 * Composes the Hot-page "Ending soon" module: active auctions ordered by
 * soonest auction end, capped at `cap`.
 *
 * Deadline-based ordering only — the client holds no bid data (bids live in
 * the transaction service, not the Nexus index), so bid-count ranking is not
 * offered. Auctions whose stale index row predates the auction-term fields
 * (`auction === null`) are excluded rather than ranked by a guessed end time.
 * An auction whose end time has been reached at `nowMs` is excluded even when
 * the cached row still says `active`: sellers do not edit a record when an
 * auction closes, so the end time is what says it is over.
 */
export function composeEndingSoonListings(
  items: MarketplaceCatalogItem[],
  cap: number,
  nowMs: number = Date.now(),
): MarketplaceAuctionCatalogItem[] {
  return items
    .filter(
      (item): item is MarketplaceAuctionCatalogItem =>
        isCatalogItemOpen(item, nowMs) && item.saleFormat === 'auction' && item.auction !== null,
    )
    .sort((left, right) => Date.parse(left.auction.endsAt) - Date.parse(right.auction.endsAt))
    .slice(0, cap);
}

/**
 * Composes the Hot-page "Fresh listings" module: active listings ordered by
 * most recent record update, capped at `cap`. `excludeIds` removes listings
 * already shown by a sibling module (ending-soon auctions are usually also
 * recent) so the two modules never duplicate a card.
 */
export function composeFreshListings(
  items: MarketplaceCatalogItem[],
  excludeIds: ReadonlySet<string>,
  cap: number,
  nowMs: number = Date.now(),
): MarketplaceCatalogItem[] {
  return items
    .filter((item) => isCatalogItemOpen(item, nowMs) && !excludeIds.has(item.id))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, cap);
}
