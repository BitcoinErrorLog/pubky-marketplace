import { z } from 'zod';
import { commercePubkySchema } from './transaction-contracts';

export const sellerPaymentReviewReasonSchema = z.enum([
  'confirmation_observation_mismatch',
  'confirmation_effects_failed',
  'invalid_reason',
  'not_order_seller',
  'order_not_awaiting_confirmation',
  'order_not_found',
  'already_resolved',
  'conflict',
  'invalid_idempotency_key',
  'invalid_outcome',
  'invalid_refund_reference',
  'missing_pin',
  'not_in_manual_review',
  'resolution_not_applicable',
  'stock_unavailable',
]);

export type SellerPaymentReviewReason = z.infer<typeof sellerPaymentReviewReasonSchema>;

export const sellerPaymentObservationSchema = z
  .object({
    txid: z.string().nullable().optional(),
    observedSats: z.number().int().nonnegative().nullable().optional(),
    confirmations: z.number().int().nonnegative().nullable().optional(),
    amountMatched: z.boolean().nullable().optional(),
    disappeared: z.boolean().nullable().optional(),
    observedAt: z.string().nullable().optional(),
  })
  .strict();

export const sellerPaymentConfirmationSchema = z
  .object({
    confirmationBasis: z.literal('seller_attestation'),
    confirmationSource: z.literal('seller'),
    confirmedAmountSats: z.number().int().nonnegative().nullable().optional(),
    confirmedAt: z.string(),
    confirmedByPubky: commercePubkySchema,
    confirmedReason: z.string().nullable().optional(),
    confirmedTxid: z.string().nullable().optional(),
    orderId: z.uuid(),
    paykitObservation: sellerPaymentObservationSchema.nullable().optional(),
  })
  .strict();

export const sellerPaymentResolutionSchema = z
  .object({
    basis: z.literal('seller_attestation'),
    orderId: z.uuid(),
    outcome: z.enum(['paid', 'refunded', 'abandoned']),
    resolutionId: z.uuid(),
    resolvedAt: z.string(),
    resolvedByPubky: commercePubkySchema,
  })
  .strict();

export const sellerPaymentResolutionOutcomeSchema = z.enum(['paid', 'refunded', 'abandoned']);

export const sellerPaymentConfirmationInputSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const sellerPaymentResolutionInputSchema = z
  .object({
    outcome: sellerPaymentResolutionOutcomeSchema,
    reason: z.string().trim().max(500).optional(),
    externalRefundReference: z
      .union([
        z.literal(''),
        z
          .string()
          .trim()
          .regex(/^[\x20-\x7E]{1,64}$/),
      ])
      .optional()
      .transform((value) => value || undefined),
  })
  .superRefine((input, context) => {
    if (input.outcome === 'refunded' && !input.externalRefundReference) {
      context.addIssue({
        code: 'custom',
        path: ['externalRefundReference'],
        message: 'A refund reference is required.',
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

export const sellerPaymentReviewReasonCopy: Readonly<Record<SellerPaymentReviewReason, string>> = {
  confirmation_observation_mismatch: 'The payment evidence changed. Review the latest order state.',
  confirmation_effects_failed: 'The payment could not be confirmed. Review the latest order state.',
  invalid_reason: 'The reason is not valid for this payment review.',
  not_order_seller: 'Only the seller can review this payment.',
  order_not_awaiting_confirmation: 'This payment is no longer awaiting seller confirmation.',
  order_not_found: 'The order was not found.',
  already_resolved: 'This payment was already resolved. The latest order state was reloaded.',
  conflict: 'This payment changed while you were reviewing it. The latest order state was reloaded.',
  invalid_idempotency_key: 'The payment resolution could not be submitted.',
  invalid_outcome: 'Choose a valid payment resolution.',
  invalid_refund_reference: 'The external refund reference is not valid.',
  missing_pin: 'This payment resolution requires the seller confirmation step first.',
  not_in_manual_review: 'This payment is no longer awaiting manual resolution.',
  resolution_not_applicable: 'This payment cannot be resolved from its current state.',
  stock_unavailable: 'Stock is no longer available. Choose refunded or abandoned.',
};
