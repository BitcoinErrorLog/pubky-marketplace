import { APP_ROUTES, getMarketplaceListingRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import type { CommerceAdapterMode } from '@/config/commerce';
import type { MarketplaceNotification, MarketplaceNotificationEntry } from '@/services/marketplace/marketplace';
import { bitcoinReviewReason, digitalDeliveryNotice } from '@/services/marketplace/marketplace-activity-copy';
import { MARKETPLACE_NOTIFICATION_TYPE_MAX_LENGTH } from '@/services/marketplace/marketplace-projections';
import type { MarketplaceFeedNotification } from './marketplaceNotification.types';

export class MarketplaceNotificationNormalizer {
  private constructor() {}

  /**
   * Maps a transactional notification projection onto the shape the general
   * notification surface renders. The output is constructed field-by-field
   * (never spread), so any extra fields a backend might attach to the
   * projection are dropped here — the general surface can only render a
   * type, an actor, an aggregate reference, a timestamp, (where §8 permits)
   * a monetary amount the recipient already sees in a role-scoped
   * projection (ADR-0019 §8), on a digital `order_delivered`, whether it
   * was delivered automatically or by the seller, and on
   * `bitcoin_manual_review` the closed review reason.
   *
   * `isUnread` is honest per adapter mode: the sandbox stores `readAt` and
   * accepts `notification.mark_read`, so its null `readAt` means unread; the
   * durable service delivers immutable outbox rows with no read state, so
   * nothing from it is ever presented as unread — a marker the user could
   * never clear is a count they cannot act on.
   */
  static toFeedNotification(
    notification: MarketplaceNotificationEntry,
    adapterMode: CommerceAdapterMode,
  ): MarketplaceFeedNotification {
    if (notification.kind === 'unrecognized') {
      return {
        id: `marketplace:unrecognized:${notification.type}:${notification.createdAt}:${notification.id.slice(
          0,
          MARKETPLACE_NOTIFICATION_TYPE_MAX_LENGTH,
        )}:${notification.index}`,
        source: 'marketplace',
        kind: 'unrecognized',
        type: notification.type,
        timestamp: Date.parse(notification.createdAt),
        isUnread: false,
        href: APP_ROUTES.MARKETPLACE,
      };
    }

    const digitalDelivery = digitalDeliveryNotice(notification);
    const reviewReason = bitcoinReviewReason(notification.reviewReason);
    return {
      id: `marketplace:${notification.id}`,
      source: 'marketplace',
      type: notification.type,
      actorPubky: notification.actorPubky,
      aggregateId: notification.aggregateId,
      timestamp: Date.parse(notification.createdAt),
      isUnread: adapterMode === 'sandbox' && notification.readAt === null,
      href: MarketplaceNotificationNormalizer.toDeepLink(notification.type, notification.aggregateId),
      // Copied field-by-field like everything above: only the three money
      // fields cross, never the raw projection object.
      ...(notification.amount
        ? {
            amount: {
              amountMinor: notification.amount.amountMinor,
              currency: notification.amount.currency,
              exponent: notification.amount.exponent,
            },
          }
        : {}),
      ...(digitalDelivery ? { digitalDelivery } : {}),
      ...(reviewReason ? { reviewReason } : {}),
    };
  }

  /**
   * Routes a notification to the marketplace surface that shows its
   * aggregate: conversations for messages, the offers inbox for the offer
   * lifecycle, the referenced listing for auction activity (falling back to
   * the catalog when the aggregate reference is not a listing id), and the
   * orders timeline for the whole order/post-purchase family. Exhaustive by
   * construction: adding a notification type fails compilation here.
   */
  static toDeepLink(type: MarketplaceNotification['type'], aggregateId: string): string {
    switch (type) {
      case 'message_received':
        return MARKETPLACE_ROUTES.MESSAGES;
      case 'offer_received':
      case 'offer_countered':
      case 'offer_accepted':
      case 'offer_rejected':
        return MARKETPLACE_ROUTES.OFFERS;
      case 'outbid':
      case 'auction_won':
      case 'auction_ended': {
        const listing = parseListingAggregateId(aggregateId);
        return listing ? getMarketplaceListingRoute(listing.sellerPubky, listing.listingId) : APP_ROUTES.MARKETPLACE;
      }
      case 'order_created':
        return MARKETPLACE_ROUTES.CHECKOUT;
      case 'payment_method_bound':
      case 'fiat_payment_reported':
      case 'payment_confirmed':
      case 'bitcoin_manual_review':
      case 'bitcoin_payment_seen':
      case 'bitcoin_prepare_voided':
      case 'order_cancelled':
      case 'order_cancelled_terms_change':
      case 'order_shipped':
      case 'order_delivery_assumed':
      case 'order_delivered':
      case 'order_completed':
      case 'return_updated':
      case 'refund_recorded':
      case 'review_received':
      case 'pickup_details_updated':
      case 'pickup_details_cleared':
      case 'pickup_ready':
      case 'payment_refund_required':
      case 'payment_reversal_cancelled':
        return MARKETPLACE_ROUTES.ORDERS;
      case 'drop_sold_out':
        return MARKETPLACE_ROUTES.SELL_DROPS;
    }
  }
}

/** Parses `listing:${sellerPubky}_${listingId}` (pubkys never contain `_`). */
function parseListingAggregateId(aggregateId: string): { sellerPubky: string; listingId: string } | null {
  if (!aggregateId.startsWith('listing:')) return null;
  const rest = aggregateId.slice('listing:'.length);
  const separator = rest.indexOf('_');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { sellerPubky: rest.slice(0, separator), listingId: rest.slice(separator + 1) };
}
