import { describe, expect, it } from 'vitest';
import { marketplaceOrderSchema } from '@/core/services/marketplace/marketplace-projections';
import {
  USDT_RESOLVE_REFUNDED_WIRE_REQUEST,
  USDT_RESOLVE_REFUNDED_WIRE_RESPONSE,
  USDT_RESOLVE_REFUSAL_WIRES,
  USDT_RESOLVE_TX_HASH,
} from '@/test/fixtures/commerce/usdt-payment-review.wire';
import { REFUND_FIXTURE_ADDRESS } from '@/test/fixtures/commerce/usdt-refund.wire';
import {
  sellerPaymentResolutionInputSchema,
  sellerPaymentResolutionSchema,
  sellerPaymentReviewReasonCopy,
  sellerPaymentReviewReasonSchema,
} from './marketplace-payment-review';
import {
  isUsdtPaymentReviewOrder,
  isUsdtResolutionReferenceInput,
  paymentReviewRail,
  USDT_PAYMENT_REVIEW_COPY,
  USDT_RESOLUTION_REFERENCE_PATTERN,
  usdtPaymentResolutionInputSchema,
  usdtPaymentReviewReasonMessage,
  usdtReviewRefundAddress,
  usdtReviewTotalLine,
} from './usdt-payment-review';
import { usdtRefundRecordLine } from './usdt-refund';
import { toCamelCaseWire } from './wire-casing';

describe('USDT payment review gate', () => {
  it('follows the order asset, so an existing USDT order is never stranded', () => {
    expect(isUsdtPaymentReviewOrder({ paymentMethod: 'usdt', paymentAsset: 'USDT' })).toBe(true);
    expect(isUsdtPaymentReviewOrder({ paymentAsset: 'USDT' })).toBe(true);
    expect(isUsdtPaymentReviewOrder({ paymentMethod: 'usdt' })).toBe(true);
    expect(paymentReviewRail({ paymentMethod: 'usdt', paymentAsset: 'USDT' })).toBe('usdt');
  });

  it.each([
    { paymentMethod: 'bitcoin' },
    { paymentMethod: 'paypal' },
    { paymentMethod: 'stripe' },
    { paymentMethod: null },
    {},
  ])('leaves %j on the Bitcoin rail', (order) => {
    expect(isUsdtPaymentReviewOrder(order)).toBe(false);
    expect(paymentReviewRail(order)).toBe('bitcoin');
  });
});

describe('USDT resolution input', () => {
  it('accepts a refund with an Arbitrum transaction hash and sends it lowercase', () => {
    const parsed = usdtPaymentResolutionInputSchema.parse({
      outcome: 'refunded',
      reason: '  returned  ',
      externalRefundReference: `  0x${'AB12'.repeat(16)}  `,
    });

    expect(parsed).toEqual({
      outcome: 'refunded',
      reason: 'returned',
      externalRefundReference: `0x${'ab12'.repeat(16)}`,
    });
    expect(USDT_RESOLUTION_REFERENCE_PATTERN.test(parsed.externalRefundReference ?? '')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a Bitcoin transaction id', 'tx-contract-refund'],
    ['a 64-character reference without 0x', 'a'.repeat(64)],
    ['too short', `0x${'a'.repeat(63)}`],
    ['too long', `0x${'a'.repeat(65)}`],
    ['not hex', `0x${'g'.repeat(64)}`],
  ])('refuses a refund whose reference is %s', (_label, reference) => {
    const result = usdtPaymentResolutionInputSchema.safeParse({
      outcome: 'refunded',
      externalRefundReference: reference,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['externalRefundReference']);
  });

  it('refuses a refund with no reference at all, in USDT copy', () => {
    const result = usdtPaymentResolutionInputSchema.safeParse({ outcome: 'refunded' });

    expect(result.error?.issues[0]?.message).toBe(
      'Enter the Arbitrum transaction hash (0x followed by 64 characters).',
    );
  });

  it.each(['paid', 'abandoned'] as const)('takes no reference on a %s outcome', (outcome) => {
    expect(usdtPaymentResolutionInputSchema.parse({ outcome, reason: 'ok', externalRefundReference: '' })).toEqual({
      outcome,
      reason: 'ok',
      externalRefundReference: undefined,
    });
    expect(
      usdtPaymentResolutionInputSchema.safeParse({ outcome, externalRefundReference: USDT_RESOLVE_TX_HASH }).success,
    ).toBe(false);
  });

  it('keeps the reason bound at 500 characters, as for Bitcoin', () => {
    expect(usdtPaymentResolutionInputSchema.safeParse({ outcome: 'paid', reason: 'x'.repeat(500) }).success).toBe(true);
    expect(usdtPaymentResolutionInputSchema.safeParse({ outcome: 'paid', reason: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });

  it('is the Bitcoin schema that stays unchanged: a hash is too long there, a short reference is not a hash here', () => {
    expect(
      sellerPaymentResolutionInputSchema.safeParse({
        outcome: 'refunded',
        externalRefundReference: USDT_RESOLVE_TX_HASH,
      }).success,
    ).toBe(false);
    expect(
      sellerPaymentResolutionInputSchema.safeParse({ outcome: 'refunded', externalRefundReference: 'tx-1' }).success,
    ).toBe(true);
    expect(
      usdtPaymentResolutionInputSchema.safeParse({ outcome: 'refunded', externalRefundReference: 'tx-1' }).success,
    ).toBe(false);
  });

  it('checks typed input the way the form does', () => {
    expect(isUsdtResolutionReferenceInput(` ${USDT_RESOLVE_TX_HASH.toUpperCase().replace('0X', '0x')} `)).toBe(true);
    expect(isUsdtResolutionReferenceInput('0x')).toBe(false);
  });
});

describe('USDT resolve wire contract', () => {
  it('sends the wire reference the schema produces', () => {
    const body = USDT_RESOLVE_REFUNDED_WIRE_REQUEST.body;
    const parsed = usdtPaymentResolutionInputSchema.parse({
      outcome: body.outcome,
      reason: body.reason,
      externalRefundReference: body.external_refund_reference,
    });

    expect(parsed.externalRefundReference).toBe(body.external_refund_reference);
    expect(USDT_RESOLVE_REFUNDED_WIRE_REQUEST.path).toMatch(/\/bitcoin\/resolve$/);
  });

  it('reads the resolved USDT order and its resolution', () => {
    const response = toCamelCaseWire(USDT_RESOLVE_REFUNDED_WIRE_RESPONSE) as {
      order: unknown;
      resolution: unknown;
    };
    const order = marketplaceOrderSchema.parse(response.order);

    expect(sellerPaymentResolutionSchema.parse(response.resolution)).toMatchObject({ outcome: 'refunded' });
    expect(order).toMatchObject({
      state: 'refunded_external',
      paymentAsset: 'USDT',
      externalRefund: { amountMinor: 13_700, transactionId: USDT_RESOLVE_TX_HASH },
      refundDestination: { address: REFUND_FIXTURE_ADDRESS },
    });
    expect(usdtRefundRecordLine(order)).toBe(
      `The seller recorded a refund of 137.000000 USDT to ${REFUND_FIXTURE_ADDRESS} (transaction ${USDT_RESOLVE_TX_HASH}). The Shop hasn't checked it on Arbitrum.`,
    );
  });

  it('reads both USDT refusals through the closed review-reason set', () => {
    for (const wire of Object.values(USDT_RESOLVE_REFUSAL_WIRES)) {
      const reason = sellerPaymentReviewReasonSchema.parse(wire.body.error.reason);
      expect(sellerPaymentReviewReasonCopy[reason]).toBeTypeOf('string');
    }
  });
});

describe('USDT review copy', () => {
  it('reads the reference refusal as a transaction hash and leaves other reasons to the shared copy', () => {
    expect(usdtPaymentReviewReasonMessage('invalid_refund_reference')).toBe(
      'Enter the Arbitrum transaction hash (0x followed by 64 characters).',
    );
    expect(sellerPaymentReviewReasonCopy.invalid_refund_reference).toBe('The external refund reference is not valid.');
    expect(usdtPaymentReviewReasonMessage('already_resolved')).toBeNull();
    expect(usdtPaymentReviewReasonMessage(undefined)).toBeNull();
  });

  it('asks the seller to wait for the buyer address when none is confirmed', () => {
    expect(sellerPaymentReviewReasonCopy.refund_destination_required).toBe(
      "Ask the buyer to confirm a refund address first. It's on their order page.",
    );
    expect(USDT_PAYMENT_REVIEW_COPY.refundAddressMissing).toBe(
      sellerPaymentReviewReasonCopy.refund_destination_required,
    );
  });

  it('shows the order total beside its parity USDT amount', () => {
    const total = { amountMinor: 13_700, currency: 'USD', exponent: 2 };

    expect(usdtReviewTotalLine({ total, paymentAmountMinor: 137_000_000 })).toBe('$137.00 · 137.000000 USDT');
    expect(usdtReviewTotalLine({ total })).toBe('$137.00 · 137.000000 USDT');
    expect(
      usdtReviewTotalLine({ total: { amountMinor: 999, currency: 'USD', exponent: 2 }, paymentAmountMinor: null }),
    ).toBe('$9.99 · 9.990000 USDT');
    expect(usdtReviewTotalLine({ total: { amountMinor: 1_000, currency: 'EUR', exponent: 2 } })).toBe('€10.00');
  });

  it('reads the buyer-confirmed address only when there is one', () => {
    expect(usdtReviewRefundAddress({})).toBeNull();
    expect(usdtReviewRefundAddress({ refundDestination: null })).toBeNull();
    expect(
      usdtReviewRefundAddress({
        refundDestination: {
          address: REFUND_FIXTURE_ADDRESS,
          network: 'arbitrum-one',
          asset: 'USDT',
          source: 'buyer_entered',
          confirmedAt: '2026-10-09T16:00:00.000Z',
        },
      }),
    ).toBe(REFUND_FIXTURE_ADDRESS);
  });

  it("records refunds as the seller's, and never says verified or confirmed on Arbitrum", () => {
    const copy = Object.values(USDT_PAYMENT_REVIEW_COPY).join(' ');

    expect(copy).toMatch(/recorded by the seller/i);
    expect(copy).not.toMatch(/verified|confirmed on arbitrum|bitcoin|sats/i);
  });
});
