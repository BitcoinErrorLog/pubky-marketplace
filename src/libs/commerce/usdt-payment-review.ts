import { z } from 'zod';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { formatUsdt } from '@/libs/commerce/payment-options';
import { sellerPaymentResolutionOutcomeSchema } from './marketplace-payment-review';
import type { CommerceMoney } from './transaction-contracts';
import {
  ARBITRUM_TX_HASH_PATTERN,
  formatUsdtParity,
  isUsdtRefundOrder,
  normalizeArbitrumTxHash,
  type RefundDestination,
  USDT_REFUND_COPY,
} from './usdt-refund';

/**
 * Manual-review resolution of a USDT payment (docs/ecommerce/usdt-payments.md,
 * plan §2.6 and §2.7). A seller resolves a USDT payment that is held for
 * manual review through the same service endpoint as Bitcoin, with the same
 * three outcomes. This file is the only place the Shop assumes anything about
 * the service's S6 widening of that endpoint, so the real payloads can be
 * swapped in without touching a component.
 *
 * Wire contract with service S6 (pubky-marketplace-service#94), as merged into
 * the existing endpoint:
 *
 * - Route, method, `Idempotency-Key` header and the `{ ok, order, resolution }`
 *   response are unchanged: `POST /v0/orders/{id}/bitcoin/resolve`. Its scope
 *   widens from `payment_method = 'bitcoin'` to `'bitcoin'` and `'usdt'`.
 *   `POST /v0/orders/{id}/confirm-bitcoin-payment` stays Bitcoin-only: a USDT
 *   payment is paid at verified inclusion and has no seller-confirmation step.
 * - Outcomes `paid`, `refunded` and `abandoned` and the `reason` note are
 *   unchanged.
 * - On a USDT order `external_refund_reference` of a `refunded` outcome is the
 *   Arbitrum transaction hash of the refund: `0x` + 64 lowercase hex digits
 *   (66 characters). A Bitcoin order still takes the 1 to 64 printable ASCII
 *   characters it always did, so a hash sent for a Bitcoin order is refused.
 * - A `refunded` outcome on a USDT order also needs the refund address the
 *   buyer confirmed, and records the whole quoted USDT amount (in order units)
 *   with `destination_address` copied into `external_refund`.
 * - Refusal `error.reason` values that read differently on a USDT order:
 *   `invalid_refund_reference` (422) and the new `refund_destination_required`
 *   (409). Every other reason keeps its Bitcoin meaning and copy.
 *
 * Nothing here verifies a transfer on Arbitrum. The resolution, and the Paykit
 * `refunded` annotation the service later sends, are what the seller recorded
 * (plan D5), so every string says "recorded by the seller", never "verified"
 * or "confirmed on Arbitrum".
 */

/** The wire form of a USDT refund reference: lowercase, as the service stores and compares it. */
export const USDT_RESOLUTION_REFERENCE_PATTERN = /^0x[0-9a-f]{64}$/;

export const USDT_RESOLUTION_REASON_MAX_LENGTH = 500;

/**
 * Whether a seller may resolve this order's manual-review payment as USDT. It
 * follows the order's own asset, never the new-offer flag, so an existing USDT
 * order is never stranded when the flag flips off (plan §3). The method label
 * is read too because the service scopes the endpoint on it.
 */
export function isUsdtPaymentReviewOrder(order: {
  paymentMethod?: string | null;
  paymentAsset?: string | null;
}): boolean {
  return order.paymentMethod === 'usdt' || isUsdtRefundOrder(order);
}

/** Which rail's copy and reference rules a manual-review resolution follows. */
export type PaymentReviewRail = 'bitcoin' | 'usdt';

export function paymentReviewRail(order: {
  paymentMethod?: string | null;
  paymentAsset?: string | null;
}): PaymentReviewRail {
  return isUsdtPaymentReviewOrder(order) ? 'usdt' : 'bitcoin';
}

/**
 * The seller's resolution form for a USDT payment. A refund needs the Arbitrum
 * transaction hash; any case is accepted as typed and sent lowercase. The
 * other outcomes carry no reference, as for Bitcoin.
 */
export const usdtPaymentResolutionInputSchema = z
  .object({
    outcome: sellerPaymentResolutionOutcomeSchema,
    reason: z.string().trim().max(USDT_RESOLUTION_REASON_MAX_LENGTH).optional(),
    externalRefundReference: z
      .union([z.literal(''), z.string().trim().regex(ARBITRUM_TX_HASH_PATTERN)])
      .optional()
      .transform((value) => (value ? normalizeArbitrumTxHash(value) : undefined)),
  })
  .superRefine((input, context) => {
    if (input.outcome === 'refunded' && !input.externalRefundReference) {
      context.addIssue({
        code: 'custom',
        path: ['externalRefundReference'],
        message: USDT_REFUND_COPY.referenceRequired,
      });
    }
    if (input.outcome !== 'refunded' && input.externalRefundReference !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['externalRefundReference'],
        message: 'A refund reference is only valid for refunds.',
      });
    }
  });

/** True when what the seller typed is, once trimmed, an Arbitrum transaction hash (any case; sent lowercase). */
export function isUsdtResolutionReferenceInput(value: string): boolean {
  return ARBITRUM_TX_HASH_PATTERN.test(value.trim());
}

export const USDT_PAYMENT_REVIEW_COPY = {
  title: 'Resolve USDT payment review',
  intro:
    'This payment is held for manual review. Choose an outcome; the marketplace remains the authority. Nothing here is checked on Arbitrum: a refund is what you record.',
  amountLabel: 'Order total',
  refundAddressLabel: 'Buyer refund address',
  refundAddressMissing: USDT_REFUND_COPY.sellerWaiting,
  refundAmountLabel: 'Refund to send',
  refundHint: USDT_REFUND_COPY.recordHint,
  refundRecordedBySeller:
    'The refund is recorded by the seller with this transaction hash. The Shop does not check it on Arbitrum.',
  referenceLabel: `${USDT_REFUND_COPY.referenceLabel} (required)`,
  referenceError: USDT_REFUND_COPY.referenceRequired,
  paidOutcome: 'Paid',
  refundedOutcome: 'Refunded',
  abandonedOutcome: 'Abandoned',
} as const;

/**
 * The order total beside its parity USDT amount: "$137.00 · 137.000000 USDT".
 * The USDT figure is the service's quoted amount when it sent one, else parity
 * from a USD total; a total that is neither shows only its own price.
 */
export function usdtReviewTotalLine(order: { total: CommerceMoney; paymentAmountMinor?: number | null }): string {
  const price = formatCommerceMoney(order.total);
  const quoted = order.paymentAmountMinor;
  const usdt =
    quoted !== null && quoted !== undefined && Number.isSafeInteger(quoted) && quoted >= 0
      ? formatUsdt(quoted)
      : formatUsdtParity(order.total);
  return usdt ? `${price} · ${usdt}` : price;
}

/** The buyer-confirmed address a refund goes to, or null until the buyer confirms one. */
export function usdtReviewRefundAddress(order: { refundDestination?: RefundDestination | null }): string | null {
  return order.refundDestination?.address ?? null;
}

/**
 * The USDT reading of a refusal reason. Only `invalid_refund_reference` reads
 * differently from Bitcoin: its hash rule replaces the 64-character reference
 * rule. `refund_destination_required` only ever comes from a USDT order and
 * has its copy in `sellerPaymentReviewReasonCopy`. Null for every other reason.
 */
export function usdtPaymentReviewReasonMessage(reason: unknown): string | null {
  return reason === 'invalid_refund_reference' ? USDT_REFUND_COPY.referenceRequired : null;
}
