import {
  bitcoinPaymentBreakdown,
  type BitcoinPaymentOrder,
  formatBitcoinAwareMoney,
  satoshiCount,
} from '@/libs/commerce/bitcoin-payment-code';
import { CHECKOUT_HOLD_COPY, formatHoldDeadline } from '@/libs/commerce/checkout-hold';
import { buyerCheckoutStateLabel, formatRemainingHMmSs, reservedWhileYouPayCopy } from '@/libs/commerce/checkout-phase';
import type { PaymentMethodKind } from '@/libs/commerce/payment-methods';
import type { CommerceMoney } from '@/libs/commerce/transaction-contracts';

/** Buyer-facing label once a Bitcoin payment has been seen. */
export const PAYMENT_SEEN_LABEL = 'Payment seen';

export const PAYMENT_SEEN_WAITING_COPY = "Payment seen — waiting for confirmation. You don't need to do anything else.";

/** Badge once the payment is confirmed on-chain but the order is not yet paid. */
export const PAYMENT_CONFIRMED_ON_CHAIN_LABEL = 'Confirmed on-chain';

/** A seen payment extends the hold to the 24-hour seller-confirmation window. */
export const PAYMENT_SEEN_HOLD_COPY =
  'Your payment was seen, so the item is held for you for up to 24 hours while the seller confirms it.';

export const PAYMENT_CONFIRMED_LABEL = 'Payment confirmed.';

export const PAYMENT_CONFIRMED_REVIEW_COPY = 'Payment confirmed on-chain. The seller is reviewing it.';

export const PAYMENT_RECEIVED_REVIEW_COPY = 'Payment received — the seller is reviewing it.';

export const PAYMENT_AMOUNT_MISMATCH_REVIEW_COPY =
  'Payment confirmed on-chain. The amount does not match, so the seller is reviewing it.';

export const PAYMENT_AMOUNT_MISMATCH_UNCONFIRMED_COPY = 'The amount does not match. The seller is reviewing it.';

export const PAYMENT_CONFIRMED_WAITING_SELLER_COPY =
  'Payment confirmed on-chain. Waiting for the seller to confirm they received it.';

export const BITCOIN_WALLET_DELIVERED_COPY =
  'Delivered to your wallet. Open Bitkit to pay. If you have already sent the payment, this page updates as soon as the marketplace sees the transaction.';

export const BITCOIN_WALLET_WAITING_COPY =
  'Waiting for your wallet. Keep Bitkit open so it can receive the payment request.';

const SEEN_REQUEST_STATES = new Set(['detected', 'awaiting_seller_confirmation', 'confirmed']);

type BitcoinStatusOrder = {
  paymentMethod?: PaymentMethodKind | null;
  paykitRequestState?: string | null;
  paykitDeliveryState?: string | null;
  holdExpiresAt?: string | null;
  paykitSellerConfirmationDeadline?: string | null;
  subtotal?: CommerceMoney;
  shipping?: CommerceMoney;
  total?: CommerceMoney;
  merchandiseTotal?: CommerceMoney | null;
  bitcoinPayable?: CommerceMoney | null;
  paykitTotalSats?: number | null;
  bitcoinQuote?: { quotedSats: number | null } | null;
};

type BitcoinStatusPayment = {
  state?: string | null;
  reviewReason?: string | null;
  confirmations?: number | null;
} | null;

export type BitcoinBuyerStatusRow = {
  id: string;
  /** How the service reaches this projection. Not a buyer field. */
  enteredFrom: string;
  paykitRequestState: 'preparing' | 'pending' | 'detected' | 'confirmed' | 'awaiting_seller_confirmation';
  paymentState: 'awaiting_entitlement' | 'detected' | 'confirmed' | 'expired' | 'manual_review';
  reviewReason: 'late_settlement' | 'refund_required' | 'amount_mismatch' | 'unpinned_legacy' | null;
  confirmations: number;
  confirmationExists: boolean;
  progress: string;
  wallet: string;
  /** After a payment is seen, pay-again labels are false. */
  forbidsPayLabels: boolean;
};

const SELLER_CONFIRMS_BY = 'Seller confirms by Sep 29, 2026, 10:56 AM UTC.';
const CONFIRMED_SELLER_DEADLINE = `Payment confirmed on-chain. ${SELLER_CONFIRMS_BY}`;

/**
 * Buyer-visible Bitcoin states. A confirmation exists when the request or the
 * payment is `confirmed`, or the payment records at least one confirmation.
 * `paykitRequestState: confirmed` is the service's confirmed observation,
 * including the canary whose `payment.confirmations` stayed 0. A manual
 * review that has none of those says the payment was received, not confirmed.
 */
export const BITCOIN_BUYER_STATUS_TABLE: readonly BitcoinBuyerStatusRow[] = [
  {
    id: 'unpaid-preparing',
    enteredFrom: 'checkout bind, request still preparing',
    paykitRequestState: 'preparing',
    paymentState: 'awaiting_entitlement',
    reviewReason: null,
    confirmations: 0,
    confirmationExists: false,
    progress: 'Reserved while you pay · 5:00',
    wallet: BITCOIN_WALLET_DELIVERED_COPY,
    forbidsPayLabels: false,
  },
  {
    id: 'unpaid-pending',
    enteredFrom: 'request delivered, payment not yet seen',
    paykitRequestState: 'pending',
    paymentState: 'awaiting_entitlement',
    reviewReason: null,
    confirmations: 0,
    confirmationExists: false,
    progress: 'Reserved while you pay · 5:00',
    wallet: BITCOIN_WALLET_DELIVERED_COPY,
    forbidsPayLabels: false,
  },
  {
    id: 'seen-detected',
    enteredFrom: 'exclusive detection, payment still awaiting_entitlement',
    paykitRequestState: 'detected',
    paymentState: 'awaiting_entitlement',
    reviewReason: null,
    confirmations: 0,
    confirmationExists: false,
    progress: SELLER_CONFIRMS_BY,
    wallet: PAYMENT_SEEN_WAITING_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'seen-awaiting-seller',
    enteredFrom: 'shared_manual sighting at 0 confirmations',
    paykitRequestState: 'awaiting_seller_confirmation',
    paymentState: 'awaiting_entitlement',
    reviewReason: null,
    confirmations: 0,
    confirmationExists: false,
    progress: SELLER_CONFIRMS_BY,
    wallet: PAYMENT_SEEN_WAITING_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'seen-awaiting-seller-confirmed-on-chain',
    enteredFrom: 'seller window still open after a chain confirmation',
    paykitRequestState: 'awaiting_seller_confirmation',
    paymentState: 'awaiting_entitlement',
    reviewReason: null,
    confirmations: 1,
    confirmationExists: true,
    progress: CONFIRMED_SELLER_DEADLINE,
    wallet: PAYMENT_CONFIRMED_WAITING_SELLER_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'paid-confirmed',
    enteredFrom: 'payment confirmed',
    paykitRequestState: 'confirmed',
    paymentState: 'confirmed',
    reviewReason: null,
    confirmations: 1,
    confirmationExists: true,
    progress: PAYMENT_CONFIRMED_LABEL,
    wallet: PAYMENT_CONFIRMED_LABEL,
    forbidsPayLabels: true,
  },
  {
    id: 'review-late-settlement',
    enteredFrom: 'Paykit Confirmed with late_settlement (canary 131a7457)',
    paykitRequestState: 'confirmed',
    paymentState: 'manual_review',
    reviewReason: 'late_settlement',
    confirmations: 0,
    confirmationExists: true,
    progress: PAYMENT_CONFIRMED_REVIEW_COPY,
    wallet: PAYMENT_CONFIRMED_REVIEW_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'review-amount-mismatch',
    enteredFrom: 'Paykit Confirmed whose amount did not match',
    paykitRequestState: 'confirmed',
    paymentState: 'manual_review',
    reviewReason: 'amount_mismatch',
    confirmations: 0,
    confirmationExists: true,
    progress: PAYMENT_AMOUNT_MISMATCH_REVIEW_COPY,
    wallet: PAYMENT_AMOUNT_MISMATCH_REVIEW_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'review-refund-required',
    enteredFrom: 'confirmed payment the order can no longer accept',
    paykitRequestState: 'confirmed',
    paymentState: 'manual_review',
    reviewReason: 'refund_required',
    confirmations: 0,
    confirmationExists: true,
    progress: CHECKOUT_HOLD_COPY.refundRequiredBuyer,
    wallet: CHECKOUT_HOLD_COPY.refundRequiredBuyer,
    forbidsPayLabels: true,
  },
  {
    id: 'review-unpinned-legacy',
    enteredFrom: 'projected reason unpinned_legacy on a confirmed request',
    paykitRequestState: 'confirmed',
    paymentState: 'manual_review',
    reviewReason: 'unpinned_legacy',
    confirmations: 0,
    confirmationExists: true,
    progress: PAYMENT_CONFIRMED_REVIEW_COPY,
    wallet: PAYMENT_CONFIRMED_REVIEW_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'review-confirmed-request',
    enteredFrom: 'seller-confirmation window elapsed; request marked confirmed',
    paykitRequestState: 'confirmed',
    paymentState: 'manual_review',
    reviewReason: null,
    confirmations: 0,
    confirmationExists: true,
    progress: PAYMENT_CONFIRMED_REVIEW_COPY,
    wallet: PAYMENT_CONFIRMED_REVIEW_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'review-from-awaiting-entitlement',
    enteredFrom: 'manual_review from awaiting_entitlement, request still pending',
    paykitRequestState: 'pending',
    paymentState: 'manual_review',
    reviewReason: null,
    confirmations: 0,
    confirmationExists: false,
    progress: PAYMENT_RECEIVED_REVIEW_COPY,
    wallet: PAYMENT_RECEIVED_REVIEW_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'review-from-detected',
    enteredFrom: 'manual_review from detected, no chain confirmation',
    paykitRequestState: 'detected',
    paymentState: 'manual_review',
    reviewReason: null,
    confirmations: 0,
    confirmationExists: false,
    progress: PAYMENT_RECEIVED_REVIEW_COPY,
    wallet: PAYMENT_RECEIVED_REVIEW_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'review-from-expired',
    enteredFrom: 'manual_review from expired without a confirmed request',
    paykitRequestState: 'pending',
    paymentState: 'manual_review',
    reviewReason: null,
    confirmations: 0,
    confirmationExists: false,
    progress: PAYMENT_RECEIVED_REVIEW_COPY,
    wallet: PAYMENT_RECEIVED_REVIEW_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'review-late-settlement-unconfirmed',
    enteredFrom: 'late_settlement while the request is still unconfirmed',
    paykitRequestState: 'pending',
    paymentState: 'manual_review',
    reviewReason: 'late_settlement',
    confirmations: 0,
    confirmationExists: false,
    progress: PAYMENT_RECEIVED_REVIEW_COPY,
    wallet: PAYMENT_RECEIVED_REVIEW_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'review-amount-mismatch-unconfirmed',
    enteredFrom: 'amount_mismatch without a confirmation',
    paykitRequestState: 'detected',
    paymentState: 'manual_review',
    reviewReason: 'amount_mismatch',
    confirmations: 0,
    confirmationExists: false,
    progress: PAYMENT_AMOUNT_MISMATCH_UNCONFIRMED_COPY,
    wallet: PAYMENT_AMOUNT_MISMATCH_UNCONFIRMED_COPY,
    forbidsPayLabels: true,
  },
  {
    id: 'review-unpinned-legacy-unconfirmed',
    enteredFrom: 'unpinned_legacy without a confirmation',
    paykitRequestState: 'pending',
    paymentState: 'manual_review',
    reviewReason: 'unpinned_legacy',
    confirmations: 0,
    confirmationExists: false,
    progress: PAYMENT_RECEIVED_REVIEW_COPY,
    wallet: PAYMENT_RECEIVED_REVIEW_COPY,
    forbidsPayLabels: true,
  },
];

function isBitcoinOrder(order: BitcoinStatusOrder): boolean {
  return order.paymentMethod === 'bitcoin' || order.paykitRequestState != null;
}

/** A chain confirmation the buyer projection actually records. */
export function bitcoinConfirmationExists(order: BitcoinStatusOrder, payment: BitcoinStatusPayment): boolean {
  return (
    order.paykitRequestState === 'confirmed' || payment?.state === 'confirmed' || (payment?.confirmations ?? 0) > 0
  );
}

/** The service has observed the payment. The buyer must not be told to pay again. */
export function bitcoinPaymentHasBeenSeen(order: BitcoinStatusOrder, payment: BitcoinStatusPayment = null): boolean {
  if (!isBitcoinOrder(order)) return false;
  if (order.paykitRequestState != null && SEEN_REQUEST_STATES.has(order.paykitRequestState)) return true;
  if (payment?.state === 'detected' || payment?.state === 'confirmed' || payment?.state === 'manual_review') {
    return true;
  }
  return (payment?.confirmations ?? 0) > 0;
}

export function sellerConfirmsByCopy(deadline: string | null | undefined): string {
  const formatted = formatHoldDeadline(deadline);
  return formatted ? `Seller confirms by ${formatted}.` : PAYMENT_SEEN_LABEL;
}

/** `H:MM:SS left` until the deadline, or null with no deadline or once it has passed. */
export function holdCountdownCopy(deadline: string | null | undefined, nowMs = Date.now()): string | null {
  if (!deadline) return null;
  const expires = Date.parse(deadline);
  if (!Number.isFinite(expires) || expires <= nowMs) return null;
  const remaining = formatRemainingHMmSs(deadline, nowMs);
  return remaining ? `${remaining} left` : null;
}

/** "Seller confirms by <time>." with the live countdown appended while the window is open. */
export function sellerConfirmsByWithCountdown(deadline: string | null | undefined, nowMs = Date.now()): string {
  const base = sellerConfirmsByCopy(deadline);
  const countdown = holdCountdownCopy(deadline, nowMs);
  return countdown ? `${base} ${countdown}` : base;
}

/** Buyer badge for a Bitcoin payment the service has seen. Null before it is seen. */
export function bitcoinSeenBadgeLabel(order: BitcoinStatusOrder, payment: BitcoinStatusPayment = null): string | null {
  if (!bitcoinPaymentHasBeenSeen(order, payment)) return null;
  return bitcoinConfirmationExists(order, payment) ? PAYMENT_CONFIRMED_ON_CHAIN_LABEL : PAYMENT_SEEN_LABEL;
}

/** Manual-review sentence. Null when the payment is not in review. */
export function buyerBitcoinReviewCopy(order: BitcoinStatusOrder, payment: BitcoinStatusPayment): string | null {
  if (payment?.state !== 'manual_review') return null;
  if (payment.reviewReason === 'refund_required') return CHECKOUT_HOLD_COPY.refundRequiredBuyer;
  const confirmed = bitcoinConfirmationExists(order, payment);
  if (payment.reviewReason === 'amount_mismatch') {
    return confirmed ? PAYMENT_AMOUNT_MISMATCH_REVIEW_COPY : PAYMENT_AMOUNT_MISMATCH_UNCONFIRMED_COPY;
  }
  return confirmed ? PAYMENT_CONFIRMED_REVIEW_COPY : PAYMENT_RECEIVED_REVIEW_COPY;
}

/**
 * Checkout and order-list line for a buyer still in pending payment.
 * A seen payment never uses the pay-by countdown.
 */
export function buyerCheckoutProgressCopy(
  order: BitcoinStatusOrder,
  payment: BitcoinStatusPayment = null,
  nowMs = Date.now(),
): string {
  if (isBitcoinOrder(order)) {
    const review = buyerBitcoinReviewCopy(order, payment);
    if (review) return review;
    if (order.paykitRequestState === 'detected' || order.paykitRequestState === 'awaiting_seller_confirmation') {
      const deadline = sellerConfirmsByWithCountdown(
        order.paykitSellerConfirmationDeadline ?? order.holdExpiresAt,
        nowMs,
      );
      if (bitcoinConfirmationExists(order, payment)) {
        return deadline === PAYMENT_SEEN_LABEL ? PAYMENT_CONFIRMED_LABEL : `Payment confirmed on-chain. ${deadline}`;
      }
      return deadline;
    }
    if (bitcoinPaymentHasBeenSeen(order, payment)) {
      return bitcoinConfirmationExists(order, payment) ? PAYMENT_CONFIRMED_LABEL : PAYMENT_SEEN_LABEL;
    }
  }
  if (order.paymentMethod) return reservedWhileYouPayCopy(order.holdExpiresAt, nowMs);
  return buyerCheckoutStateLabel(order);
}

export function buyerCheckoutBadgeLabel(order: BitcoinStatusOrder, payment: BitcoinStatusPayment = null): string {
  if (bitcoinPaymentHasBeenSeen(order, payment)) return PAYMENT_SEEN_LABEL;
  return buyerCheckoutStateLabel(order);
}

/** Wallet instructions only while the request is still unpaid. */
export function buyerBitcoinWalletCopy(
  order: BitcoinStatusOrder,
  payment: BitcoinStatusPayment,
):
  | { kind: 'pay'; text: string }
  | { kind: 'seen'; text: string }
  | { kind: 'review'; text: string }
  | { kind: 'refund'; text: string } {
  const review = buyerBitcoinReviewCopy(order, payment);
  if (review) {
    return payment?.reviewReason === 'refund_required'
      ? { kind: 'refund', text: review }
      : { kind: 'review', text: review };
  }
  if (order.paykitRequestState === 'detected' || order.paykitRequestState === 'awaiting_seller_confirmation') {
    return {
      kind: 'seen',
      text: bitcoinConfirmationExists(order, payment)
        ? PAYMENT_CONFIRMED_WAITING_SELLER_COPY
        : PAYMENT_SEEN_WAITING_COPY,
    };
  }
  if (bitcoinPaymentHasBeenSeen(order, payment)) {
    return {
      kind: 'seen',
      text: bitcoinConfirmationExists(order, payment) ? PAYMENT_CONFIRMED_LABEL : PAYMENT_SEEN_WAITING_COPY,
    };
  }
  return {
    kind: 'pay',
    text: order.paykitDeliveryState === 'delivered' ? BITCOIN_WALLET_DELIVERED_COPY : BITCOIN_WALLET_WAITING_COPY,
  };
}

export function sellerBitcoinConfirmPrompt(order: BitcoinStatusOrder): string {
  const payable = payableMoney(order);
  return payable
    ? `Confirm you received ${formatBitcoinAwareMoney(payable)}`
    : 'Confirm you received this Bitcoin payment';
}

export function sellerBitcoinDecision(
  order: BitcoinStatusOrder,
  payment: BitcoinStatusPayment,
): 'confirm' | 'resolve' | null {
  if (order.paymentMethod !== 'bitcoin') return null;
  if (payment?.state === 'manual_review') return 'resolve';
  if (order.paykitRequestState === 'awaiting_seller_confirmation') return 'confirm';
  return null;
}

function payableMoney(order: BitcoinStatusOrder): CommerceMoney | null {
  if (order.subtotal && order.shipping) {
    const breakdown = bitcoinPaymentBreakdown(order as BitcoinPaymentOrder);
    if (breakdown) return breakdown.payable;
  }
  if (order.total && satoshiCount(order.total) !== null) return order.total;
  return null;
}
