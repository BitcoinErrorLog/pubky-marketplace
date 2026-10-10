import { z } from 'zod';

/**
 * The service-side settlement contract the Shop reads for a USDT order
 * (docs/ecommerce/usdt-payments.md, "Settlement and finality"). Everything the
 * Shop assumes about the upcoming service status work (S3) lives in this one
 * file so the real fields can be swapped in here without touching a component:
 *
 * - `payment_finality` on the order projection: `pending | final | reverted`.
 *   Absent for every Bitcoin, PayPal and Stripe order, and for a USDT order
 *   that is not paid yet.
 * - Command refusal `error.reason === 'payment_not_final'` on
 *   `fulfillment.ship`, `fulfillment.mark_ready` and `fulfillment.confirm_pickup`
 *   while finality is `pending` or `reverted`.
 *
 * "Paid" is decided by the order and payment state as for every other rail
 * (USDT is paid at verified inclusion). Finality only decides whether physical
 * fulfilment may start; it never changes whether the order is paid.
 */

export const PAYMENT_FINALITIES = ['pending', 'final', 'reverted'] as const;
export type PaymentFinality = (typeof PAYMENT_FINALITIES)[number];

export const PAYMENT_NOT_FINAL_REASON = 'payment_not_final';

/**
 * Order projection field. Tolerant like the other asset-bearing fields: a value
 * the Shop does not recognise reads as absent and never fails the order parse.
 */
export const usdtSettlementFieldsShape = {
  paymentFinality: z.enum(PAYMENT_FINALITIES).nullish().catch(undefined),
};

/** True when a command envelope refused because the USDT payment is not final yet. */
export function isPaymentNotFinalRefusal(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const error = (response as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return false;
  return (error as { reason?: unknown }).reason === PAYMENT_NOT_FINAL_REASON;
}
