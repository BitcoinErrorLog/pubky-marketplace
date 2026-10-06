import { describe, expect, it } from 'vitest';
import { MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import {
  orderChangedMessage,
  REFUND_ORDER_NOTICES,
  refundOrderNotices,
  refundRecordLine,
  refundStateLabel,
} from './refund-copy';

const total = { amountMinor: 250, currency: 'USD', exponent: 2 };
const refund = (amountMinor: number) => ({
  amountMinor,
  transactionId: '9RF12345AB678901C',
  recordedAt: '2026-09-24T18:00:00.000Z',
});

describe('refund copy', () => {
  it('names a full refund "Refunded" instead of the raw state', () => {
    expect(refundStateLabel({ state: 'refunded_external', total, externalRefund: refund(250) })).toBe('Refunded');
    expect(refundStateLabel({ state: 'paid', total })).toBeNull();
  });

  it('names a fully reversed payment and keeps the partial amount first', () => {
    const reversed = { state: 'refunded_external', total, paymentReversedAt: '2026-09-24T18:00:00.000Z' };
    expect(refundStateLabel({ ...reversed, externalRefund: refund(250) })).toBe('Payment reversed');
    expect(refundStateLabel({ state: 'shipped', total, externalRefund: refund(100) })).toBe('Refunded $1.00 of $2.50');
  });

  it('states the refund amount and reference in plain words', () => {
    expect(refundRecordLine({ state: 'refunded_external', total, externalRefund: refund(250) })).toBe(
      'Refunded in full ($2.50). Reference: 9RF12345AB678901C',
    );
    expect(refundRecordLine({ state: 'paid', total, externalRefund: refund(100) })).toBe(
      'Refunded $1.00 of $2.50. Reference: 9RF12345AB678901C',
    );
    expect(refundRecordLine({ state: 'paid', total })).toBeNull();
  });

  it('puts the payment-code equation on a Bitcoin refund record', () => {
    const bitcoin = {
      paymentMethod: 'bitcoin' as const,
      paykitTotalSats: 1_255,
      merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      bitcoinPayable: { amountMinor: 1_255, currency: 'SAT', exponent: 0 },
      subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
      total: { amountMinor: 1_255, currency: 'BTC', exponent: 8 },
    };
    const equation = 'Items ₿1,000 · Shipping ₿0 · Payment code ₿255 = Total ₿1,255';
    expect(refundRecordLine({ state: 'refunded_external', ...bitcoin, externalRefund: refund(1_255) })).toBe(
      `Refunded in full (${equation}). Reference: 9RF12345AB678901C`,
    );
    expect(refundRecordLine({ state: 'paid', ...bitcoin, externalRefund: refund(500) })).toBe(
      `Refunded ₿500 of ₿1,255. ${equation}. Reference: 9RF12345AB678901C`,
    );
    expect(refundStateLabel({ state: 'paid', ...bitcoin, externalRefund: refund(500) })).toBe(
      'Refunded ₿500 of ₿1,255',
    );
  });

  it('lists a reversal, a cancelled reversal, and each held refund notice', () => {
    expect(refundOrderNotices({ state: 'paid', total })).toEqual([]);
    expect(
      refundOrderNotices({ state: 'refunded_external', total, paymentReversedAt: '2026-09-24T18:00:00.000Z' }),
    ).toEqual(['reversed']);
    expect(
      refundOrderNotices({ state: 'paid', total, paymentReversalCancelledAt: '2026-09-24T19:00:00.000Z' }),
    ).toEqual(['reversalCancelled']);
    expect(
      refundOrderNotices({
        state: 'paid',
        total,
        paymentReversedAt: '2026-09-24T20:00:00.000Z',
        paymentReversalCancelledAt: '2026-09-24T19:00:00.000Z',
        gatewayRefundUnmatched: true,
        gatewayRefundReviewAt: '2026-09-24T18:00:00.000Z',
      }),
    ).toEqual(['reversed', 'refundOnHold', 'refundNeedsCheck']);
  });

  it('keeps every notice free of service codes', () => {
    for (const text of Object.values(REFUND_ORDER_NOTICES)) {
      expect(text).not.toMatch(/_|gateway|ipn|inbox|refunded_external/i);
    }
  });

  it('names the refund or reversal that caused a revision conflict', () => {
    const before = { state: 'shipped', total };
    expect(orderChangedMessage(before, { state: 'refunded_external', total, externalRefund: refund(250) })).toBe(
      MARKETPLACE_FAILURE_MESSAGES.orderRefundedMeanwhile,
    );
    expect(
      orderChangedMessage(before, {
        state: 'refunded_external',
        total,
        externalRefund: refund(250),
        paymentReversedAt: '2026-09-24T18:00:00.000Z',
      }),
    ).toBe(MARKETPLACE_FAILURE_MESSAGES.orderReversedMeanwhile);
    expect(orderChangedMessage(before, { state: 'shipped', total, externalRefund: refund(100) })).toBe(
      MARKETPLACE_FAILURE_MESSAGES.orderRefundRecordedMeanwhile,
    );
    expect(orderChangedMessage(before, { state: 'delivered', total })).toBe(MARKETPLACE_FAILURE_MESSAGES.orderChanged);
    expect(orderChangedMessage(before, null)).toBe(MARKETPLACE_FAILURE_MESSAGES.orderChanged);
    expect(MARKETPLACE_FAILURE_MESSAGES.orderReversedMeanwhile).toMatch(/^PayPal reversed the payment/);
    expect(MARKETPLACE_FAILURE_MESSAGES.orderRefundedMeanwhile).toMatch(/^This order was refunded/);
    expect(MARKETPLACE_FAILURE_MESSAGES.orderRefundRecordedMeanwhile).toMatch(/^A refund was recorded/);
  });
});
