/** Exact Shop copy for exclusive checkout holds (issue #50). */

export const PAYMENT_WINDOW_ELAPSED_REASON = 'payment window elapsed';

export const UNBOUND_BACK_CANCEL_REASON = 'Released hold before choosing a payment method.';

export const CHECKOUT_HOLD_COPY = {
  listingReserved:
    'Another buyer is currently paying for this item. If payment does not complete, it will become available again.',
  heldForYouCta: 'Held for you · view your order',
  heldForYouOfferCta: 'Held for you · continue checkout',
  heldWhileAnotherPays: 'Held while another buyer pays',
  expiredNoLateMoney: 'Payment window elapsed. The item is available again.',
  lateCompleteBuyer:
    'Your payment arrived after the hold window. The item was still available, so this order is now paid.',
  lateCompleteSeller: 'A late payment completed this order. The item is sold.',
  refundRequiredBuyer:
    'Your payment arrived after another buyer took this item. This order cannot be completed. The seller must return your funds.',
  refundRequiredBitcoinSeller:
    'Return the observed bitcoin to the buyer. This marketplace cannot reverse Bitcoin. Message the buyer for a return address, send the transaction, then record it as an external refund.',
  refundRequiredPaypalSeller:
    'Refund this PayPal payment from your PayPal account. This marketplace cannot refund PayPal. Then record the refund.',
  refundRequiredStripeSeller: 'Refund this card payment from the account that received it. Then record the refund.',
  stripeRefundSubmitted: 'Refund submitted.',
  stripeRefundRefused: 'The refund was refused. Refund it from the account that received the payment.',
} as const;

/** An order timestamp with its day, e.g. `Oct 1, 2026, 10:10 AM UTC`. Holds can run 24 hours. */
export function formatOrderInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)} UTC`;
}

export function formatHoldDeadline(holdExpiresAt: string | null | undefined): string | null {
  return formatOrderInstant(holdExpiresAt);
}

export function holderUnboundCopy(holdExpiresAt: string | null | undefined): string {
  const deadline = formatHoldDeadline(holdExpiresAt);
  return deadline ? `The item is held for you until ${deadline}.` : 'The item is held for you once a payment starts.';
}

export function holderBoundCopy(holdExpiresAt: string | null | undefined): string {
  const deadline = formatHoldDeadline(holdExpiresAt);
  return deadline
    ? `Pay by ${deadline}. If the window ends, the item restocks.`
    : 'If the window ends, the item restocks.';
}

export function isLateCompletionOrder(order: { state: string; cancellationReason?: string | null }): boolean {
  return order.state === 'paid' && order.cancellationReason === PAYMENT_WINDOW_ELAPSED_REASON;
}

export function isRefundRequiredPayment(payment: { reviewReason?: string | null } | null | undefined): boolean {
  return payment?.reviewReason === 'refund_required';
}

export function isHoldExpiredNoLateMoney(
  order: { state: string; cancellationReason?: string | null },
  payment: { state: string; reviewReason?: string | null } | null | undefined,
): boolean {
  return (
    (order.state === 'cancelled' || payment?.state === 'expired') &&
    order.cancellationReason === PAYMENT_WINDOW_ELAPSED_REASON &&
    payment?.reviewReason !== 'refund_required' &&
    !isLateCompletionOrder(order)
  );
}

export function refundRequiredSellerCopy(paymentMethod: string | null | undefined): string {
  if (paymentMethod === 'paypal') return CHECKOUT_HOLD_COPY.refundRequiredPaypalSeller;
  if (paymentMethod === 'stripe') return CHECKOUT_HOLD_COPY.refundRequiredStripeSeller;
  return CHECKOUT_HOLD_COPY.refundRequiredBitcoinSeller;
}

export function refundRequiredCopyForRole(isBuyer: boolean, paymentMethod: string | null | undefined): string {
  return isBuyer ? CHECKOUT_HOLD_COPY.refundRequiredBuyer : refundRequiredSellerCopy(paymentMethod);
}

type ViewerHoldOrderLine = {
  listingAggregateId: string;
};

type ViewerHoldOrder = {
  id: string;
  buyerPubky: string;
  state: string;
  lines: readonly ViewerHoldOrderLine[];
};

type ViewerHoldOrderView = {
  order: ViewerHoldOrder;
};

/**
 * Match a reserved listing to the viewer's own pending-payment order.
 * Compare `order.buyerPubky` to the authenticated pubky — never a session id.
 */
export function findViewerPendingHoldOrder(
  orders: readonly ViewerHoldOrderView[],
  listingAggregateId: string,
  viewerPubky: string | null | undefined,
): { orderId: string } | null {
  if (!viewerPubky) return null;
  for (const { order } of orders) {
    if (order.buyerPubky !== viewerPubky) continue;
    if (order.state !== 'pending_payment') continue;
    if (!order.lines.some((line) => line.listingAggregateId === listingAggregateId)) continue;
    return { orderId: order.id };
  }
  return null;
}

type ViewerAcceptedOffer = {
  id: string;
  state: string;
  buyerPubky: string;
  listingAggregateId: string;
  award?: { state: string } | null;
};

/**
 * Match a reserved listing to the viewer's accepted offer award.
 * Compare `offer.buyerPubky` to `MarketplaceSessionService.getActiveSession().pubky`.
 * A pending-payment order hold wins over this match.
 */
export function findViewerAcceptedOfferHold(
  offers: readonly ViewerAcceptedOffer[],
  listingAggregateId: string,
  sessionPubky: string | null | undefined,
): { offerId: string } | null {
  if (!sessionPubky) return null;
  for (const offer of offers) {
    if (offer.buyerPubky !== sessionPubky) continue;
    if (offer.state !== 'accepted') continue;
    if (offer.listingAggregateId !== listingAggregateId) continue;
    if (offer.award?.state !== 'active') continue;
    return { offerId: offer.id };
  }
  return null;
}
