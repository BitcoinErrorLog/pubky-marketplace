import { MARKETPLACE_ROUTES } from '@/app/routes';
import { formatOrderInstant, UNBOUND_BACK_CANCEL_REASON } from '@/libs/commerce/checkout-hold';
import type { PaymentMethodKind } from '@/libs/commerce/payment-methods';
import { isUsdtPaymentReviewOrder } from '@/libs/commerce/usdt-payment-review';

export const CHECKOUT_IN_PROGRESS_LABEL = 'Checkout in progress';
export const RESERVED_WHILE_YOU_PAY_LABEL = 'Awaiting payment · Item reserved';
export const BIND_FAIL_CANCEL_REASON = UNBOUND_BACK_CANCEL_REASON;

const PAID_OR_LATER_STATES = new Set([
  'paid',
  'processing',
  'shipped',
  'delivered',
  'completed',
  'ready_for_pickup',
  'cancel_requested',
  'return_requested',
  'return_approved',
  'return_received',
  'refunded_external',
  'refunded_partial',
  'closed',
]);

export function getMarketplaceCheckoutRoute(orderId?: string | null): string {
  return orderId ? `${MARKETPLACE_ROUTES.CHECKOUT}#${orderId}` : MARKETPLACE_ROUTES.CHECKOUT;
}

export function getMarketplaceOfferCheckoutRoute(offerId?: string | null): string {
  if (!offerId) return MARKETPLACE_ROUTES.CHECKOUT;
  const params = new URLSearchParams({ offer: offerId });
  return `${MARKETPLACE_ROUTES.CHECKOUT}?${params.toString()}`;
}

export function getMarketplaceDropCheckoutRoute(input: {
  sellerPubky: string;
  dropId: string;
  listingId: string;
}): string {
  const params = new URLSearchParams({
    seller: input.sellerPubky,
    drop: input.dropId,
    listing: input.listingId,
  });
  return `${MARKETPLACE_ROUTES.CHECKOUT}?${params.toString()}`;
}

export function isPendingPaymentState(state: string): boolean {
  return state === 'pending_payment';
}

export function isPaidOrLaterState(state: string): boolean {
  return PAID_OR_LATER_STATES.has(state);
}

function hasReceipt(order: { receiptId?: string | null }): boolean {
  return typeof order.receiptId === 'string' && order.receiptId.length > 0;
}

function isPaidOrReceiptedState(order: { state: string; receiptId?: string | null }): boolean {
  return isPaidOrLaterState(order.state) || (order.state === 'cancelled' && hasReceipt(order));
}

/** Buyer history = paid and later, plus cancelled rows that already have a receipt. */
export function isBuyerOrderHistory(
  order: { state: string; buyerPubky: string; receiptId?: string | null },
  buyerPubky: string | null,
): boolean {
  return buyerPubky !== null && order.buyerPubky === buyerPubky && isPaidOrReceiptedState(order);
}

/** Unpaid checkout cancel only. A cancelled paid or pickup order keeps its receipt and stays an Order. */
export function isAbandonedCheckout(
  order: { state: string; buyerPubky: string; receiptId?: string | null },
  buyerPubky: string | null,
): boolean {
  return buyerPubky !== null && order.buyerPubky === buyerPubky && order.state === 'cancelled' && !hasReceipt(order);
}

type SellerOrderRole = {
  state: string;
  sellerPubky: string;
  buyerPubky: string;
  paymentMethod?: PaymentMethodKind | null;
  paymentAsset?: string | null;
};

function isSellerParty(order: SellerOrderRole, currentUserPubky: string | null): boolean {
  return currentUserPubky !== null && order.sellerPubky === currentUserPubky && order.buyerPubky !== currentUserPubky;
}

/**
 * A bound Bitcoin payment is a sale, not a stock hold. The seller resolves
 * and confirms it on the sales card. An unbound hold stays a reservation.
 */
export function isSellerBoundBitcoinOrder(order: SellerOrderRole): boolean {
  return isPendingPaymentState(order.state) && order.paymentMethod === 'bitcoin';
}

/**
 * A USDT payment held for manual review is a sale the seller must resolve, not
 * a stock hold, the same as a bound Bitcoin payment. Other pending USDT
 * orders stay reservations. Keyed on the order's own asset, never the flag.
 */
export function isSellerUsdtReviewOrder(
  order: SellerOrderRole,
  payment: { state?: string | null } | null | undefined,
): boolean {
  return isPendingPaymentState(order.state) && isUsdtPaymentReviewOrder(order) && payment?.state === 'manual_review';
}

/**
 * Seller unpaid hold — Shop has no `stock_held` field, so pending_payment is
 * the reservation. `payment` is optional: without it only the bound-Bitcoin
 * exception applies.
 */
export function isSellerReservation(
  order: SellerOrderRole,
  currentUserPubky: string | null,
  payment?: { state?: string | null } | null,
): boolean {
  return (
    isSellerParty(order, currentUserPubky) &&
    isPendingPaymentState(order.state) &&
    !isSellerBoundBitcoinOrder(order) &&
    !isSellerUsdtReviewOrder(order, payment)
  );
}

export function isSellerPaidOrder(
  order: { state: string; sellerPubky: string; buyerPubky: string; receiptId?: string | null },
  currentUserPubky: string | null,
): boolean {
  return (
    currentUserPubky !== null &&
    order.sellerPubky === currentUserPubky &&
    order.buyerPubky !== currentUserPubky &&
    isPaidOrReceiptedState(order)
  );
}

/**
 * Paid sales, plus a seller's bound Bitcoin payment that is still pending and
 * a USDT payment held for manual review.
 */
export function isSellerSalesOrder(
  order: SellerOrderRole & { receiptId?: string | null },
  currentUserPubky: string | null,
  payment?: { state?: string | null } | null,
): boolean {
  if (!isSellerParty(order, currentUserPubky)) return false;
  return isPaidOrReceiptedState(order) || isSellerBoundBitcoinOrder(order) || isSellerUsdtReviewOrder(order, payment);
}

/** State pill for an order an Activity link opens but no Orders section lists (a seller's unpaid cancel). */
export function unlistedOrderStateLabel(order: { state: string; receiptId?: string | null }): string {
  if (order.state === 'cancelled' && !hasReceipt(order)) return 'Cancelled before payment';
  if (isPendingPaymentState(order.state)) return 'Awaiting payment';
  const label = order.state.replaceAll('_', ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function isBuyerCheckoutInProgress(
  order: { state: string; buyerPubky: string },
  buyerPubky: string | null,
): boolean {
  return buyerPubky !== null && order.buyerPubky === buyerPubky && isPendingPaymentState(order.state);
}

export function buyerCheckoutStateLabel(order: { paymentMethod?: PaymentMethodKind | null }): string {
  return order.paymentMethod ? RESERVED_WHILE_YOU_PAY_LABEL : CHECKOUT_IN_PROGRESS_LABEL;
}

function remainingParts(
  holdExpiresAt: string | null | undefined,
  nowMs: number,
): { hours: number; minutes: number; seconds: number } | null {
  if (!holdExpiresAt) return null;
  const expires = Date.parse(holdExpiresAt);
  if (!Number.isFinite(expires)) return null;
  const totalSeconds = Math.floor(Math.max(0, expires - nowMs) / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

export function formatRemainingMmSs(holdExpiresAt: string | null | undefined, nowMs = Date.now()): string | null {
  const parts = remainingParts(holdExpiresAt, nowMs);
  if (!parts) return null;
  const mm = parts.minutes.toString().padStart(2, '0');
  const ss = parts.seconds.toString().padStart(2, '0');
  if (parts.hours > 0) return `${parts.hours}:${mm}:${ss}`;
  return `${parts.minutes}:${ss}`;
}

/** Always `H:MM:SS`: one second left reads `0:00:01`. */
export function formatRemainingHMmSs(holdExpiresAt: string | null | undefined, nowMs = Date.now()): string | null {
  const parts = remainingParts(holdExpiresAt, nowMs);
  if (!parts) return null;
  return `${parts.hours}:${parts.minutes.toString().padStart(2, '0')}:${parts.seconds.toString().padStart(2, '0')}`;
}

export function reservedWhileYouPayCopy(holdExpiresAt: string | null | undefined, nowMs = Date.now()): string {
  const remaining = formatRemainingMmSs(holdExpiresAt, nowMs);
  return remaining ? `${RESERVED_WHILE_YOU_PAY_LABEL} · ${remaining}` : RESERVED_WHILE_YOU_PAY_LABEL;
}

export function sellerReservationCopy(holdExpiresAt: string | null | undefined): string {
  const restock = formatOrderInstant(holdExpiresAt);
  return restock ? `Held for a buyer · restocks ${restock}` : 'Held for a buyer.';
}

export function extractCheckoutOrderIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const orders = (result as { orders?: unknown }).orders;
  if (!Array.isArray(orders)) return [];
  return orders.flatMap((order) => {
    if (!order || typeof order !== 'object' || !('id' in order)) return [];
    return typeof order.id === 'string' && order.id.length > 0 ? [order.id] : [];
  });
}

export function listingAggregatesFromCheckoutLines(lines: Array<{ listingAggregateId?: string }>): string[] {
  return lines.flatMap((line) => (line.listingAggregateId ? [line.listingAggregateId] : []));
}

const PAYMENT_METHOD_ORDER: PaymentMethodKind[] = ['bitcoin', 'usdt', 'paypal'];

/** Shared rails across every seller in a cart. Empty means Pay stays disabled. */
export function intersectPaymentMethods(sets: PaymentMethodKind[][]): PaymentMethodKind[] {
  if (sets.length === 0) return [];
  return PAYMENT_METHOD_ORDER.filter((method) => sets.every((set) => set.includes(method)));
}

export function readCheckoutHashOrderId(hash = ''): string | null {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveCreatedCheckoutOrderIds(input: {
  result: unknown;
  orders: Array<{
    id: string;
    state: string;
    buyerPubky: string;
    lines: Array<{ listingAggregateId: string }>;
  }>;
  listingAggregateIds: string[];
  buyerPubky: string | null;
}): string[] {
  const fromResult = extractCheckoutOrderIds(input.result);
  if (fromResult.length > 0) return fromResult;
  if (!input.buyerPubky) return [];
  const wanted = new Set(input.listingAggregateIds);
  return input.orders
    .filter(
      (order) =>
        isBuyerCheckoutInProgress(order, input.buyerPubky) &&
        order.lines.some((line) => wanted.has(line.listingAggregateId)),
    )
    .map((order) => order.id);
}
