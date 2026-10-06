import type { CommerceMoney } from '@/libs/commerce/transaction-contracts';
import type { CommerceWatchAlertKind } from '@/models/commerce/commerce.schema';

/**
 * A device-local watch alert prepared for rendering — on the watchlist page,
 * the marketplace notifications page, and interleaved into the app's general
 * notification surface. Unlike `MarketplaceFeedNotification` this row has NO
 * actor: nobody sent it. It reports what a check running on this device
 * observed, and every surface rendering it must say so ("Watchlist ·
 * checked on this device"), never dress it up as a server event.
 */
export type MarketplaceWatchAlertFeedItem = {
  /** `watch:${alertRowId}` — namespaced so it can never collide with social or marketplace ids. */
  id: string;
  /** Discriminates watch-alert rows in shared notification UI. */
  source: 'watch-alert';
  kind: CommerceWatchAlertKind;
  /** Listing title at observation time. */
  title: string;
  /** Deep link to the watched listing. */
  href: string;
  /** When this device made the observation (ms epoch). */
  timestamp: number;
  /** Device-local read state — real, because the row only exists here. */
  isUnseen: boolean;
  /** `ending_soon`: the observed auction deadline (ISO). */
  endsAt: string | null;
  /** `price_change` / bid kinds: before/after money, when both were observed. */
  previousAmount: CommerceMoney | null;
  currentAmount: CommerceMoney | null;
  /** Bid kinds: observed bid count. */
  bidCount: number | null;
  /** `state_change`: transition endpoints. */
  previousState: string | null;
  nextState: string | null;
};
