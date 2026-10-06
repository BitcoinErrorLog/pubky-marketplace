/**
 * Whether a freshly read order already shows the outcome of an order command.
 *
 * A revision conflict means the revision the dialog held was stale. The
 * command may still have landed (the return window can close, and the
 * request can commit, between open and confirm). The caller re-reads and
 * uses this to decide: the visible result is success; anything else stays
 * a conflict.
 */

export type CommandOrderSnapshot = {
  state: string;
  cancellationReason?: string | null;
  shipment?: { carrier: string; trackingNumber: string; state: string } | null;
  returnRequest?: { state: string; reason: string; requestedAmountMinor: number } | null;
  externalRefund?: { amountMinor: number; transactionId: string } | null;
  reviews?: { rating: number; text: string }[] | null;
};

// A refunded order proves delivery only through its delivered shipment:
// a PayPal refund or reversal also moves a `shipped` order to
// `refunded_external`.
const DELIVERED_OR_LATER = new Set([
  'delivered',
  'completed',
  'return_requested',
  'return_approved',
  'return_received',
]);

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function minor(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export function orderShowsCommandResult(
  order: CommandOrderSnapshot,
  kind: string,
  payload: Record<string, unknown>,
): boolean {
  switch (kind) {
    case 'return.request': {
      const request = order.returnRequest;
      return (
        request != null &&
        request.reason === text(payload.reason) &&
        request.requestedAmountMinor === minor(payload.requestedAmountMinor)
      );
    }
    case 'return.approve':
      return (
        order.returnRequest?.state === 'approved' ||
        order.returnRequest?.state === 'received' ||
        order.returnRequest?.state === 'refunded'
      );
    case 'return.receive':
      return (
        order.returnRequest?.state === 'received' ||
        order.returnRequest?.state === 'refunded' ||
        order.state === 'return_received' ||
        order.state === 'refunded_external' ||
        order.state === 'refunded_partial'
      );
    case 'order.cancel_request':
      return (
        order.cancellationReason === text(payload.reason) &&
        (order.state === 'cancel_requested' || order.state === 'cancelled')
      );
    case 'order.cancel_approve':
      return order.state === 'cancelled';
    case 'fulfillment.ship':
      return (
        order.shipment != null &&
        order.shipment.carrier === text(payload.carrier) &&
        order.shipment.trackingNumber === text(payload.trackingNumber)
      );
    case 'fulfillment.confirm_delivery':
      return order.shipment?.state === 'delivered' || DELIVERED_OR_LATER.has(order.state);
    case 'refund.record_external':
      return (
        order.externalRefund != null &&
        order.externalRefund.amountMinor === minor(payload.amountMinor) &&
        order.externalRefund.transactionId === text(payload.transactionId)
      );
    case 'review.create':
    case 'review.update': {
      const rating = minor(payload.rating);
      const reviewText = text(payload.text);
      return (order.reviews ?? []).some((review) => review.rating === rating && review.text === reviewText);
    }
    default:
      return false;
  }
}
