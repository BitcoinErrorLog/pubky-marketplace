import type { MarketplaceNotification } from '@/services/marketplace/marketplace';

/**
 * Activity rows that can need the person who received them. A row of one of
 * these types badges only while its subject still needs that person (see
 * `activityNeedsCurrentUser`). Informational rows (checkout started, payment
 * confirmed, shipped, cancelled, completed, refund recorded) stay in the
 * history and never badge. A restored disputed payment can hand a reopened
 * order back to the seller, so it badges while that order waits on them.
 */
const ACTION_ACTIVITY_TYPES = new Set<MarketplaceNotification['type']>([
  'message_received',
  'offer_received',
  'offer_countered',
  'offer_accepted',
  'return_updated',
  'pickup_ready',
  'payment_refund_required',
  'bitcoin_manual_review',
  'bitcoin_payment_seen',
  'payment_reversal_cancelled',
]);

const OFFER_ACTION_TYPES = new Set<MarketplaceNotification['type']>([
  'offer_received',
  'offer_countered',
  'offer_accepted',
]);

const ORDER_ACTION_TYPES = new Set<MarketplaceNotification['type']>([
  'return_updated',
  'pickup_ready',
  'payment_refund_required',
  'bitcoin_manual_review',
  'bitcoin_payment_seen',
  'payment_reversal_cancelled',
]);

export function isMarketplaceActionActivity(type: MarketplaceNotification['type']): boolean {
  return ACTION_ACTIVITY_TYPES.has(type);
}

const ORDERS_SEEN_PREFIX = 'pubky.marketplace.ordersSeen.';

export const MARKETPLACE_ORDERS_SEEN_EVENT = 'marketplace-orders-seen';

export function readOrdersSeenAt(pubky: string, storage: Pick<Storage, 'getItem'>): number {
  const raw = storage.getItem(`${ORDERS_SEEN_PREFIX}${pubky}`);
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Moves the per-identity orders checkpoint forward. Never backward. */
export function writeOrdersSeenAt(pubky: string, at: number, storage: Pick<Storage, 'getItem' | 'setItem'>): boolean {
  const current = readOrdersSeenAt(pubky, storage);
  if (!(at > current)) return false;
  storage.setItem(`${ORDERS_SEEN_PREFIX}${pubky}`, String(at));
  return true;
}

/**
 * Raises this browser's copy of the orders checkpoint and tells mounted
 * badges to re-read it. Returns whether the value moved.
 */
export function raiseLocalOrdersSeenAt(pubky: string, at: number): boolean {
  if (typeof window === 'undefined') return false;
  if (!writeOrdersSeenAt(pubky, at, window.localStorage)) return false;
  window.dispatchEvent(new Event(MARKETPLACE_ORDERS_SEEN_EVENT));
  return true;
}

export function readLocalOrdersSeenAt(pubky: string): number {
  if (typeof window === 'undefined') return 0;
  return readOrdersSeenAt(pubky, window.localStorage);
}

type AttentionOrder = {
  id: string;
  state?: string;
  nextActor: 'buyer' | 'seller' | 'none';
  buyerPubky: string;
  sellerPubky: string;
  updatedAt: string;
  holdExpiresAt?: string | null;
};

export function orderNeedsCurrentUser(
  order: AttentionOrder,
  currentUserPubky: string | null,
  now = Date.now(),
): boolean {
  if (currentUserPubky === null) return false;
  // An unpaid checkout whose hold already lapsed is waiting on the expiry
  // sweep, not on either participant.
  if (order.state === 'pending_payment' && order.holdExpiresAt) {
    const expires = Date.parse(order.holdExpiresAt);
    if (Number.isFinite(expires) && expires <= now) return false;
  }
  if (order.nextActor === 'buyer') return order.buyerPubky === currentUserPubky;
  if (order.nextActor === 'seller') return order.sellerPubky === currentUserPubky;
  return false;
}

export type AttentionOffer = {
  id: string;
  buyerPubky: string;
  sellerPubky: string;
  state: 'pending' | 'countered' | 'accepted' | 'rejected' | 'withdrawn' | 'expired' | 'converted';
  offeredBy: string;
  expiresAt: string;
  award?: { state: 'active' | 'converted' | 'expired' } | null;
};

/**
 * An open offer needs the party who did not make the latest amount (accept,
 * decline, or counter). An accepted offer needs its buyer while the award is
 * still open for checkout.
 */
export function offerNeedsCurrentUser(
  offer: AttentionOffer,
  currentUserPubky: string | null,
  now = Date.now(),
): boolean {
  if (currentUserPubky === null) return false;
  if (offer.buyerPubky !== currentUserPubky && offer.sellerPubky !== currentUserPubky) return false;
  if (offer.state === 'pending' || offer.state === 'countered') {
    const expires = Date.parse(offer.expiresAt);
    if (Number.isFinite(expires) && expires <= now) return false;
    return offer.offeredBy !== currentUserPubky;
  }
  if (offer.state === 'accepted') return offer.buyerPubky === currentUserPubky && offer.award?.state === 'active';
  return false;
}

export function marketplaceNavAccessibleName(cartCount: number, attentionCount: number): string {
  const attention = attentionCount === 1 ? '1 needs attention' : `${attentionCount} need attention`;
  if (cartCount <= 0) return `Marketplace, ${attention}`;
  const cart = cartCount === 1 ? '1 item in cart' : `${cartCount} items in cart`;
  return `Marketplace, ${cart}, ${attention}`;
}

/** The subject key an order contributes to the combined marketplace badge. */
export function orderAttentionKey(orderId: string): string {
  return `order:${orderId}`;
}

/**
 * Orders whose next move is this identity, newer than the last time this
 * account opened Orders. A missing timestamp still counts when the tab has
 * never been opened. Returns one subject key per order.
 */
export function ordersNeedingAttentionKeys(
  orders: readonly AttentionOrder[],
  currentUserPubky: string,
  seenAt: number,
  now = Date.now(),
): string[] {
  return orders
    .filter((order) => {
      if (!orderNeedsCurrentUser(order, currentUserPubky, now)) return false;
      const updated = Date.parse(order.updatedAt);
      if (!Number.isFinite(updated)) return seenAt === 0;
      return updated > seenAt;
    })
    .map((order) => orderAttentionKey(order.id));
}

type AttentionNotification = {
  id: string;
  type: MarketplaceNotification['type'];
  aggregateId: string;
  createdAt: string;
  readAt?: string | null;
};

export type ActivityAttentionInput = {
  notifications: readonly AttentionNotification[];
  orders: readonly AttentionOrder[];
  offers: readonly AttentionOffer[];
  currentUserPubky: string;
  /**
   * `seen` compares each row's `createdAt` to the account's activity
   * checkpoint; `read-state` uses the row's own `readAt` (sandbox).
   */
  clearedBy: { kind: 'seen'; seenAt: number } | { kind: 'read-state' };
  now?: number;
};

/**
 * Activity that still needs this identity, as one subject key per order,
 * offer, or message row. Several rows about the same order or offer count
 * once. A row about an order or offer the caller could not load does not
 * count: the badge may lag reality but never invents it.
 */
export function activityNeedingAttentionKeys({
  notifications,
  orders,
  offers,
  currentUserPubky,
  clearedBy,
  now = Date.now(),
}: ActivityAttentionInput): string[] {
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const offersById = new Map(offers.map((offer) => [offer.id, offer]));
  const keys = new Set<string>();
  for (const notification of notifications) {
    if (!isMarketplaceActionActivity(notification.type)) continue;
    if (clearedBy.kind === 'read-state') {
      if (notification.readAt) continue;
    } else if (!(Date.parse(notification.createdAt) > clearedBy.seenAt)) {
      continue;
    }
    if (ORDER_ACTION_TYPES.has(notification.type)) {
      const orderId = aggregateSuffix(notification.aggregateId, 'order:');
      const order = orderId ? ordersById.get(orderId) : undefined;
      if (order && orderNeedsCurrentUser(order, currentUserPubky, now)) keys.add(orderAttentionKey(order.id));
      continue;
    }
    if (OFFER_ACTION_TYPES.has(notification.type)) {
      const offerId = aggregateSuffix(notification.aggregateId, 'offer:');
      const offer = offerId ? offersById.get(offerId) : undefined;
      if (offer && offerNeedsCurrentUser(offer, currentUserPubky, now)) keys.add(`offer:${offer.id}`);
      continue;
    }
    keys.add(`notification:${notification.id}`);
  }
  return [...keys];
}

function aggregateSuffix(aggregateId: string, prefix: string): string | null {
  if (!aggregateId.startsWith(prefix)) return null;
  const id = aggregateId.slice(prefix.length);
  return id.length > 0 ? id : null;
}
