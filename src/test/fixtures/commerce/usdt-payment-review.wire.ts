import { toSnakeCaseWire } from '@/libs/commerce/wire-casing';
import { createOrderFixture } from './orders';
import { USDT_ORDER_FIELDS } from './usdt-orders';
import { REFUND_FIXTURE_ADDRESS } from './usdt-refund.wire';

/**
 * The service S6 wire contract for resolving a USDT payment held for manual
 * review (pubky-marketplace-service#94; Shop `usdt-payment-review.ts`), pinned
 * exactly as that PR states it. The endpoint is the Bitcoin resolve route,
 * widened to USDT orders. Hand-written from the PR because S6 is not merged;
 * replace with captures once it is.
 */

export const USDT_RESOLVE_ORDER_ID = '018f47d2-6a27-7c23-a49d-0000000009b0';
export const USDT_RESOLVE_IDEMPOTENCY_KEY = '018f47d2-6a27-7c23-a49d-0000000009b1';

/** An Arbitrum transaction hash exactly as the service stores it: `0x` + 64 lowercase hex. */
export const USDT_RESOLVE_TX_HASH = `0x${'cd34'.repeat(16)}`;

/** `POST /v0/orders/{id}/bitcoin/resolve` for a USDT order: the reference is the transaction hash. */
export const USDT_RESOLVE_REFUNDED_WIRE_REQUEST = {
  method: 'POST',
  path: `/v0/orders/${USDT_RESOLVE_ORDER_ID}/bitcoin/resolve`,
  headers_present: ['authorization', 'content-type', 'idempotency-key'],
  body: {
    outcome: 'refunded',
    reason: 'Paid after the window; returned to the buyer',
    external_refund_reference: USDT_RESOLVE_TX_HASH,
  },
} as const;

const REFUND_RECORDED_AT = '2026-10-09T17:00:00.000Z';

/**
 * The resolved USDT order. `external_refund.amount_minor` is the quoted USDT
 * amount in order units (cents), and `destination_address` is the buyer's
 * confirmed address copied in so a later change cannot rewrite the record.
 */
export const USDT_RESOLVE_REFUNDED_WIRE_RESPONSE = {
  ok: true,
  order: {
    ...(toSnakeCaseWire(
      createOrderFixture('refunded_external', {
        id: USDT_RESOLVE_ORDER_ID,
        ...USDT_ORDER_FIELDS,
        paymentFinality: 'final',
        refundDestination: {
          address: REFUND_FIXTURE_ADDRESS,
          network: 'arbitrum-one',
          asset: 'USDT',
          source: 'buyer_entered',
          confirmedAt: '2026-10-09T16:00:00.000Z',
        },
        externalRefund: { amountMinor: 13_700, transactionId: USDT_RESOLVE_TX_HASH, recordedAt: REFUND_RECORDED_AT },
      }),
    ) as Record<string, unknown>),
    external_refund: {
      amount_minor: 13_700,
      transaction_id: USDT_RESOLVE_TX_HASH,
      recorded_at: REFUND_RECORDED_AT,
      destination_address: REFUND_FIXTURE_ADDRESS,
    },
  },
  resolution: {
    basis: 'seller_attestation',
    order_id: USDT_RESOLVE_ORDER_ID,
    outcome: 'refunded',
    resolution_id: USDT_RESOLVE_IDEMPOTENCY_KEY,
    resolved_at: REFUND_RECORDED_AT,
    resolved_by_pubky: 's'.repeat(52),
  },
} as const;

/** The two refusals a USDT resolve can answer with that read differently from Bitcoin. */
export const USDT_RESOLVE_REFUSAL_WIRES = {
  invalid_refund_reference: {
    status: 422,
    body: {
      ok: false,
      error: {
        code: 'INVALID_COMMAND',
        message: 'A refunded resolution requires a valid external refund reference.',
        reason: 'invalid_refund_reference',
      },
    },
  },
  refund_destination_required: {
    status: 409,
    body: {
      ok: false,
      error: {
        code: 'INVALID_STATE',
        message: 'The buyer has not confirmed a refund address.',
        reason: 'refund_destination_required',
      },
    },
  },
} as const;
