import { z } from 'zod';
import { COMMERCE_CONTRACT_VERSION } from '@/config/commerce';

export { COMMERCE_CONTRACT_VERSION } from '@/config/commerce';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export const commercePubkySchema = z
  .string()
  .regex(/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/, 'Expected a 52-character z-base-32 Pubky');

export const commerceEntityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Expected a path-safe commerce identifier');

export const commerceAggregateIdSchema = z
  .string()
  .min(3)
  .max(289)
  .regex(/^[a-z][a-z0-9_-]{1,31}:[A-Za-z0-9_-]{1,256}$/, 'Expected type:identifier aggregate format');

export const commerceTimestampSchema = z.iso.datetime({ offset: true });

export const commerceRevisionSchema = z.number().int().min(0).max(MAX_SAFE_INTEGER);

export const commerceCurrencySchema = z
  .string()
  .min(3)
  .max(12)
  .regex(/^[A-Z][A-Z0-9]*$/, 'Expected an uppercase asset code');

export const commerceMoneySchema = z
  .object({
    amountMinor: z.number().int().min(0).max(MAX_SAFE_INTEGER),
    currency: commerceCurrencySchema,
    exponent: z.number().int().min(0).max(18),
  })
  .strict();

export const commercePositiveMoneySchema = commerceMoneySchema.refine(({ amountMinor }) => amountMinor > 0, {
  message: 'Expected a positive monetary amount',
  path: ['amountMinor'],
});

export const commerceCommandBaseSchema = z
  .object({
    version: z.literal(COMMERCE_CONTRACT_VERSION),
    commandId: z.uuid(),
    aggregateId: commerceAggregateIdSchema,
    expectedRevision: commerceRevisionSchema,
    issuedAt: commerceTimestampSchema,
  })
  .strict();

export function createCommerceCommandSchema<const TKind extends string, TPayload extends z.ZodType>(
  kind: TKind,
  payload: TPayload,
) {
  return commerceCommandBaseSchema
    .extend({
      kind: z.literal(kind),
      payload,
    })
    .strict();
}

export const commerceEventBaseSchema = z
  .object({
    version: z.literal(COMMERCE_CONTRACT_VERSION),
    eventId: z.uuid(),
    commandId: z.uuid(),
    aggregateId: commerceAggregateIdSchema,
    revision: commerceRevisionSchema.refine((revision) => revision > 0, 'Event revision must be positive'),
    actorPubky: commercePubkySchema,
    occurredAt: commerceTimestampSchema,
  })
  .strict();

export function createCommerceEventSchema<const TKind extends string, TPayload extends z.ZodType>(
  kind: TKind,
  payload: TPayload,
) {
  return commerceEventBaseSchema
    .extend({
      kind: z.literal(kind),
      payload,
    })
    .strict();
}

export function createCommerceCommandResultSchema<TResult extends z.ZodType>(result: TResult) {
  return z
    .object({
      version: z.literal(COMMERCE_CONTRACT_VERSION),
      commandId: z.uuid(),
      aggregateId: commerceAggregateIdSchema,
      revision: commerceRevisionSchema,
      eventIds: z.array(z.uuid()),
      result,
    })
    .strict();
}

// -----------------------------------------------------------------------------
// Aggregate state enums.
//
// These mirror the Marketplace Transaction Service's canonical contract
// artifact (`contracts/state-machines.json`, vendored at
// `src/libs/commerce/contracts/state-machines.json`); the service is the
// authority when the two disagree (ADR-0022). `state-machines.contract.test.ts`
// fails whenever these enums or the transition tables drift from the artifact.
// -----------------------------------------------------------------------------

/**
 * The transaction authority tracks inventory availability only; the catalog
 * lifecycle (drafts, pauses, removal) belongs to seller-signed homeserver
 * records, not to this enum.
 */
export const listingStateSchema = z.enum(['available', 'reserved', 'sold']);

export const reservationStateSchema = z.enum(['active', 'converted', 'released', 'expired']);

export const offerStateSchema = z.enum(['pending', 'countered', 'accepted', 'rejected', 'withdrawn', 'expired']);

export const auctionStateSchema = z.enum(['scheduled', 'active', 'sold', 'unsold', 'cancelled']);

export const paymentStateSchema = z.enum(['awaiting_entitlement', 'detected', 'confirmed', 'expired', 'manual_review']);

export const orderStateSchema = z.enum([
  'pending_payment',
  'paid',
  // Wave 7 local pickup (local pickup design §A6): the seller armed the
  // handover; the buyer confirms on receipt. Declared between `paid` and
  // `processing`, matching the vendored artifact's state list.
  'ready_for_pickup',
  'processing',
  'shipped',
  'delivered',
  'completed',
  'cancel_requested',
  'cancelled',
  'return_requested',
  'return_approved',
  'return_received',
  'refunded_external',
  'closed',
]);

/**
 * Order state a later service revision can emit when the recorded refund is
 * below the order total. It is not part of `orderStateSchema`: that enum
 * matches the vendored service artifact, which still lands
 * `refund.record_external` on `refunded_external`. The order projection
 * accepts this value so the order stays readable when the service starts
 * emitting it.
 */
export const PARTIAL_REFUND_ORDER_STATE = 'refunded_partial' as const;

export const returnStateSchema = z.enum(['requested', 'approved', 'received', 'refunded']);

/**
 * Drop lifecycle (ADR 0026). `live` begins at server-time `startsAt`;
 * `ended_sold_out` is terminal paid-out quantity, `ended_closed` the
 * schedule's end, `ended_cancelled` the seller's kill switch.
 */
export const dropStateSchema = z.enum(['announced', 'live', 'ended_sold_out', 'ended_closed', 'ended_cancelled']);

export type CommerceJsonValue =
  | null
  | boolean
  | number
  | string
  | CommerceJsonValue[]
  | { [key: string]: CommerceJsonValue };

export type CommerceMoney = z.infer<typeof commerceMoneySchema>;
export type ListingState = z.infer<typeof listingStateSchema>;
export type ReservationState = z.infer<typeof reservationStateSchema>;
export type OfferState = z.infer<typeof offerStateSchema>;
export type AuctionState = z.infer<typeof auctionStateSchema>;
export type PaymentState = z.infer<typeof paymentStateSchema>;
export type OrderState = z.infer<typeof orderStateSchema>;
export type ReturnState = z.infer<typeof returnStateSchema>;
export type DropState = z.infer<typeof dropStateSchema>;
