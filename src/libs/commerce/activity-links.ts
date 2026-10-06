import { MARKETPLACE_ROUTES } from '@/app/routes';
import { getMarketplaceCheckoutRoute } from '@/libs/commerce/checkout-phase';
import { marketplaceConversationHref } from '@/libs/commerce/marketplace-conversation-query';
import { parseConversationAggregateId } from '@/libs/commerce/messaging-contracts';
import { MarketplaceNotificationNormalizer } from '@/pipes/marketplaceNotification/marketplaceNotification.normalizer';
import type { MarketplaceNotification } from '@/services/marketplace/marketplace';

const OFFER_TYPES = new Set<MarketplaceNotification['type']>([
  'offer_received',
  'offer_countered',
  'offer_accepted',
  'offer_rejected',
]);

/**
 * Where an Activity row goes. Order rows land on that order. A checkout-started
 * row lands on checkout while that order is still the buyer's unpaid checkout,
 * and on the order otherwise. Offer rows land on that offer. A message row
 * opens its thread when the aggregate is a conversation id. Everything else
 * uses the same surface as the notification deep link.
 */
export function activityRowHref(
  type: MarketplaceNotification['type'],
  aggregateId: string | null,
  options?: { canCheckout?: boolean },
): string {
  if (type === 'message_received' && aggregateId && parseConversationAggregateId(aggregateId)) {
    return marketplaceConversationHref(aggregateId);
  }
  if (OFFER_TYPES.has(type) && aggregateId?.startsWith('offer:')) {
    const offerId = aggregateId.slice('offer:'.length);
    return offerId ? `${MARKETPLACE_ROUTES.OFFERS}#offer-${offerId}` : MARKETPLACE_ROUTES.OFFERS;
  }
  if (type === 'order_created') {
    const orderId = aggregateId?.startsWith('order:') ? aggregateId.slice('order:'.length) : '';
    if (!orderId) return MARKETPLACE_ROUTES.ORDERS;
    if (options?.canCheckout) return getMarketplaceCheckoutRoute(orderId);
    return `${MARKETPLACE_ROUTES.ORDERS}#order-${encodeURIComponent(orderId)}`;
  }
  const base = MarketplaceNotificationNormalizer.toDeepLink(type, aggregateId ?? '');
  if (base === MARKETPLACE_ROUTES.ORDERS && aggregateId?.startsWith('order:')) {
    const orderId = aggregateId.slice('order:'.length);
    return orderId ? `${MARKETPLACE_ROUTES.ORDERS}#order-${encodeURIComponent(orderId)}` : base;
  }
  return base;
}

export function orderAnchorId(orderId: string): string {
  return `order-${orderId}`;
}

/** `#order-<id>` from an activity row. Other hashes stay with checkout. */
export function readOrderAnchorId(hash: string): string | null {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!value.startsWith('order-')) return null;
  const id = decodeURIComponent(value.slice('order-'.length)).trim();
  return id.length > 0 ? id : null;
}
