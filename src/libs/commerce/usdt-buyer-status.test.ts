import { describe, expect, it } from 'vitest';
import { BITCOIN_BUYER_STATUS_TABLE } from '@/libs/commerce/bitcoin-buyer-status';
import { createPaymentFixture } from '@/test/fixtures/commerce/orders';
import { createUsdtOrderFixture } from '@/test/fixtures/commerce/usdt-orders';
import {
  isUsdPricedTotals,
  isUsdtFulfilmentBlocked,
  USDT_BUYER_PHASE_COPY,
  USDT_PHASE_BADGE_LABEL,
  USDT_SELLER_PHASE_COPY,
  usdtAmountLabel,
  usdtPaidAsLine,
  usdtParityMillionths,
  usdtPhaseCopy,
  usdtSettlementPhase,
} from './usdt-buyer-status';

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', exponent: 2 });

describe('usdtSettlementPhase', () => {
  it('walks awaiting, received (inclusion, not final), final and re-checking', () => {
    const phases = (['awaiting', 'received', 'final', 'rechecking'] as const).map((phase) => {
      const { order, payment } = createUsdtOrderFixture(phase);
      return usdtSettlementPhase(order, payment);
    });
    expect(phases).toEqual(['awaiting', 'received', 'final', 'rechecking']);
  });

  it('fails closed to received when a paid USDT order reports no finality', () => {
    const { order, payment } = createUsdtOrderFixture('final', { paymentFinality: undefined });
    expect(usdtSettlementPhase(order, payment)).toBe('received');
    expect(isUsdtFulfilmentBlocked(order)).toBe(true);
  });

  it('puts a manual-review payment in review whatever its finality', () => {
    const { order } = createUsdtOrderFixture('final');
    expect(usdtSettlementPhase(order, createPaymentFixture('manual_review', { adapter: 'paykit' }))).toBe('review');
  });

  it('is null for every order that is not a USDT order', () => {
    for (const method of ['bitcoin', 'paypal', 'stripe', null] as const) {
      const { order, payment } = createUsdtOrderFixture('final', { paymentMethod: method });
      expect(usdtSettlementPhase(order, payment)).toBeNull();
      expect(usdtPhaseCopy(order, payment, true)).toBeNull();
      expect(usdtAmountLabel(order)).toBeNull();
      expect(usdtPaidAsLine(order)).toBeNull();
      expect(isUsdtFulfilmentBlocked(order)).toBe(false);
    }
  });
});

describe('USDT finality gate', () => {
  it('blocks ship, mark ready and pickup until the payment is final', () => {
    expect(isUsdtFulfilmentBlocked(createUsdtOrderFixture('received').order)).toBe(true);
    expect(isUsdtFulfilmentBlocked(createUsdtOrderFixture('rechecking').order)).toBe(true);
    expect(isUsdtFulfilmentBlocked(createUsdtOrderFixture('final').order)).toBe(false);
  });
});

describe('USDT status copy', () => {
  it('uses the agreed buyer and seller sentences for each phase', () => {
    expect(USDT_BUYER_PHASE_COPY).toEqual({
      awaiting: 'Waiting for your USDT payment',
      received: 'USDT payment received. The seller ships once Arbitrum finalizes it.',
      final: 'USDT payment confirmed',
      rechecking: "Your payment is being re-checked on Arbitrum. You don't need to do anything yet.",
    });
    expect(USDT_SELLER_PHASE_COPY).toEqual({
      awaiting: "Waiting for the buyer's USDT payment",
      received: "Payment received. Don't ship yet: Arbitrum hasn't finalized it. Shipping unlocks on its own.",
      final: 'Payment final. You can ship.',
      rechecking: "The buyer's payment is being re-checked on Arbitrum. Don't ship.",
    });
  });

  it('picks the copy for the viewing party', () => {
    const received = createUsdtOrderFixture('received');
    expect(usdtPhaseCopy(received.order, received.payment, true)).toBe(USDT_BUYER_PHASE_COPY.received);
    expect(usdtPhaseCopy(received.order, received.payment, false)).toBe(USDT_SELLER_PHASE_COPY.received);
  });

  it('never calls a USDT order or its status Bitcoin or on-chain', () => {
    const copies = [
      ...Object.values(USDT_BUYER_PHASE_COPY),
      ...Object.values(USDT_SELLER_PHASE_COPY),
      ...Object.values(USDT_PHASE_BADGE_LABEL),
    ];
    for (const copy of copies) expect(copy).not.toMatch(/bitcoin|₿|on-chain|sats/i);
  });

  it('keeps the Bitcoin status table untouched', () => {
    expect(BITCOIN_BUYER_STATUS_TABLE.some((row) => /usdt/i.test(JSON.stringify(row)))).toBe(false);
  });

  it('says the buyer review states in USDT terms, reusing the existing review sentences', () => {
    const { order } = createUsdtOrderFixture('final');
    const review = (reviewReason: 'amount_mismatch' | 'late_settlement' | 'refund_required') =>
      usdtPhaseCopy(order, createPaymentFixture('manual_review', { adapter: 'paykit', reviewReason }), true);
    expect(review('amount_mismatch')).toBe('The USDT amount does not match. The seller is reviewing it.');
    expect(review('late_settlement')).toBe('Payment received — the seller is reviewing it.');
    expect(review('refund_required')).toMatch(/another buyer took this item/);
    expect(usdtPhaseCopy(order, createPaymentFixture('manual_review', { adapter: 'paykit' }), false)).toBeNull();
  });
});

describe('USDT amounts', () => {
  it('writes the receipt line as "$137.00, paid as 137.000000 USDT"', () => {
    const { order } = createUsdtOrderFixture('final');
    expect(usdtAmountLabel(order)).toBe('137.000000 USDT');
    expect(usdtPaidAsLine(order)).toBe('$137.00, paid as 137.000000 USDT');
  });

  it('writes no line until the service sends the USDT amount', () => {
    const { order } = createUsdtOrderFixture('final', { paymentAmountMinor: undefined });
    expect(usdtPaidAsLine(order)).toBeNull();
  });

  it('quotes parity exactly: one cent is 10,000 millionths, with no rounding', () => {
    expect(usdtParityMillionths([usd(2_500)])).toBe(25_000_000);
    expect(usdtParityMillionths([usd(1)])).toBe(10_000);
    expect(usdtParityMillionths([usd(12_500), usd(1_200)])).toBe(137_000_000);
  });

  it('quotes nothing for a total that is not USD with two decimals', () => {
    expect(usdtParityMillionths([])).toBeNull();
    expect(usdtParityMillionths([{ amountMinor: 100, currency: 'BTC', exponent: 8 }])).toBeNull();
    expect(usdtParityMillionths([usd(100), { amountMinor: 100, currency: 'SAT', exponent: 0 }])).toBeNull();
    expect(usdtParityMillionths([{ amountMinor: 100, currency: 'USD', exponent: 0 }])).toBeNull();
    expect(usdtParityMillionths([usd(Number.MAX_SAFE_INTEGER)])).toBeNull();
  });

  it('offers USDT only on USD-priced totals', () => {
    expect(isUsdPricedTotals([usd(100)])).toBe(true);
    expect(isUsdPricedTotals([])).toBe(false);
    expect(isUsdPricedTotals([usd(100), { amountMinor: 1, currency: 'BTC', exponent: 8 }])).toBe(false);
  });
});
