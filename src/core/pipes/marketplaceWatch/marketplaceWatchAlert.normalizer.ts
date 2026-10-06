import { getMarketplaceListingRoute } from '@/app/routes';
import type { CommerceMoney } from '@/libs/commerce/transaction-contracts';
import type { CommerceWatchAlertModelSchema } from '@/models/commerce/commerce.schema';
import type { MarketplaceWatchAlertFeedItem } from './marketplaceWatchAlert.types';

export class MarketplaceWatchAlertNormalizer {
  private constructor() {}

  /**
   * Maps a persisted watch alert row onto the shape the notification
   * surfaces render. Everything here was observed by this device — amounts
   * are reconstructed exactly from the minor units the observation carried,
   * and `isUnseen` is real read state because the row exists only locally.
   */
  static toFeedItem(alert: CommerceWatchAlertModelSchema): MarketplaceWatchAlertFeedItem {
    const separator = alert.listing_id.indexOf(':');
    const rawListingId = alert.listing_id.slice(separator + 1);
    return {
      id: `watch:${alert.id}`,
      source: 'watch-alert',
      kind: alert.kind,
      title: alert.title,
      href: getMarketplaceListingRoute(alert.seller_id, rawListingId),
      timestamp: alert.created_at,
      isUnseen: alert.seen_at === null,
      endsAt: alert.ends_at,
      previousAmount: this.toMoney(alert.previous_amount_minor, alert),
      currentAmount: this.toMoney(alert.current_amount_minor, alert),
      bidCount: alert.bid_count,
      previousState: alert.previous_state,
      nextState: alert.next_state,
    };
  }

  private static toMoney(amountMinor: number | null, alert: CommerceWatchAlertModelSchema): CommerceMoney | null {
    if (amountMinor === null || alert.currency === null || alert.exponent === null) return null;
    return { amountMinor, currency: alert.currency, exponent: alert.exponent };
  }
}
