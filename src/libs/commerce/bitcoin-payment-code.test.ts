import { describe, expect, it } from 'vitest';
import { marketplaceOrderSchema } from '@/core/services/marketplace/marketplace-projections';
import projectionSamples from '@/libs/commerce/contracts/samples/projections.json';
import { createBitcoinQuotedOrderFixture, createOrderFixture } from '@/test/fixtures/commerce/orders';
import {
  BITCOIN_PAYMENT_CODE_CHECKOUT_NOTE,
  bitcoinPaymentBreakdown,
  formatBitcoinAmountBreakdown,
  orderAmountEntry,
} from './bitcoin-payment-code';
import { toCamelCaseWire } from './wire-casing';

const PLACEHOLDERS: Record<string, string> = {
  '<uuid:1>': '018f47d2-6a27-7c23-a49d-000000000001',
  '<uuid:2>': '018f47d2-6a27-7c23-a49d-000000000002',
  '<uuid:3>': '018f47d2-6a27-7c23-a49d-000000000003',
  '<uuid:4>': '018f47d2-6a27-7c23-a49d-000000000004',
  '<uuid:5>': '018f47d2-6a27-7c23-a49d-000000000005',
  '<uuid:6>': '018f47d2-6a27-7c23-a49d-000000000006',
  '<pubky:buyer>': 'b'.repeat(52),
  '<pubky:seller>': 's'.repeat(52),
  '<timestamp:1>': '2026-08-20T20:00:00.000Z',
  '<timestamp:2>': '2026-08-20T21:00:00.000Z',
  '<timestamp:3>': '2026-08-27T20:00:00.000Z',
  '<paykit-reference:1>': 'paykit-reference-1',
  '<paykit-reference:2>': 'paykit-reference-2',
  '<paykit-reference:3>': 'paykit-reference-3',
};

function projectionBody(scene: keyof typeof projectionSamples): Record<string, unknown> {
  const source = projectionSamples[scene].response.body;
  return JSON.parse(
    JSON.stringify(source, (_key, value: unknown) =>
      typeof value === 'string' ? (PLACEHOLDERS[value] ?? value) : value,
    ),
  ) as Record<string, unknown>;
}

function parseOrder(wire: Record<string, unknown>) {
  return marketplaceOrderSchema.parse(toCamelCaseWire(wire));
}

const SAMPLE_EQUATION = 'Items ₿50,000 · Shipping ₿1,200 · Payment code ₿437 = Total ₿51,637';
const CANARY_EQUATION = 'Items ₿1,000 · Shipping ₿0 · Payment code ₿255 = Total ₿1,255';

describe('bitcoin payment code', () => {
  it('pins the vendored Paykit projection: 50,000 + 1,200 + 437 = 51,637', () => {
    const order = parseOrder(projectionBody('buyer_awaiting_confirmation'));

    expect(order.paykitTotalSats).toBe(51_637);
    expect(order.total).toEqual({ amountMinor: 51_637, currency: 'SAT', exponent: 0 });
    const breakdown = bitcoinPaymentBreakdown(order);
    expect(breakdown).toEqual({
      items: { amountMinor: 50_000, currency: 'SAT', exponent: 0 },
      shipping: { amountMinor: 1_200, currency: 'SAT', exponent: 0 },
      paymentCode: { amountMinor: 437, currency: 'SAT', exponent: 0 },
      payable: { amountMinor: 51_637, currency: 'SAT', exponent: 0 },
    });
    expect(formatBitcoinAmountBreakdown(breakdown!)).toBe(SAMPLE_EQUATION);
    expect(breakdown!.items.amountMinor + breakdown!.shipping.amountMinor + breakdown!.paymentCode.amountMinor).toBe(
      breakdown!.payable.amountMinor,
    );
  });

  it('reads merchandise_total and bitcoin_payable from the service payload', () => {
    const wire = projectionBody('buyer_awaiting_confirmation');
    wire.merchandise_total = { amount_minor: 51_200, currency: 'SAT', exponent: 0 };
    wire.bitcoin_payable = { amount_minor: 51_637, currency: 'SAT', exponent: 0 };

    const order = parseOrder(wire);

    expect(order.merchandiseTotal).toEqual({ amountMinor: 51_200, currency: 'SAT', exponent: 0 });
    expect(order.bitcoinPayable).toEqual({ amountMinor: 51_637, currency: 'SAT', exponent: 0 });
    expect(formatBitcoinAmountBreakdown(bitcoinPaymentBreakdown(order)!)).toBe(SAMPLE_EQUATION);
  });

  it('explains a BTC listing whose payable is denominated in SAT', () => {
    const wire = projectionBody('buyer_awaiting_confirmation');
    const btc = (amount: number) => ({ amount_minor: amount, currency: 'BTC', exponent: 8 });
    wire.subtotal = btc(1_000);
    wire.shipping = btc(0);
    wire.merchandise_total = btc(1_000);
    wire.total = btc(1_255);
    wire.bitcoin_payable = { amount_minor: 1_255, currency: 'SAT', exponent: 0 };
    wire.paykit_total_sats = 1_255;
    const lines = wire.lines as Array<Record<string, unknown>>;
    lines[0].unit_price = btc(1_000);
    lines[0].subtotal = btc(1_000);

    const order = parseOrder(wire);
    const breakdown = bitcoinPaymentBreakdown(order);

    expect(breakdown?.paymentCode).toEqual({ amountMinor: 255, currency: 'BTC', exponent: 8 });
    expect(breakdown?.payable).toEqual({ amountMinor: 1_255, currency: 'BTC', exponent: 8 });
    expect(formatBitcoinAmountBreakdown(breakdown!)).toBe(CANARY_EQUATION);
    expect(orderAmountEntry(order)).toEqual({ amountMinor: 1_255, exponent: 0, unitLabel: '₿' });
    expect(breakdown!.items.amountMinor + breakdown!.shipping.amountMinor + breakdown!.paymentCode.amountMinor).toBe(
      breakdown!.payable.amountMinor,
    );
  });

  it('keeps a fiat order in its own currency and puts the code on the bitcoin amount', () => {
    const order = marketplaceOrderSchema.parse({
      ...createBitcoinQuotedOrderFixture(),
      bitcoinPayable: { amountMinor: 3_000, currency: 'SAT', exponent: 0 },
      paykitTotalSats: 3_000,
    });

    expect(formatBitcoinAmountBreakdown(bitcoinPaymentBreakdown(order)!)).toBe(
      'Items $125.00 · Shipping $12.00 · Payment code ₿412 = Total ₿3,000',
    );
  });

  it('drops a malformed payable and still parses the order', () => {
    const wire = projectionBody('buyer_awaiting_confirmation');
    wire.bitcoin_payable = { amount_minor: '1255', currency: 'SAT', exponent: 0 };
    wire.merchandise_total = { amount_minor: false };

    const order = parseOrder(wire);

    expect(order.bitcoinPayable).toBeUndefined();
    expect(order.merchandiseTotal).toBeUndefined();
    expect(formatBitcoinAmountBreakdown(bitcoinPaymentBreakdown(order)!)).toBe(SAMPLE_EQUATION);
  });

  it('stays quiet before a code exists, on other rails, and when the parts would not add', () => {
    expect(bitcoinPaymentBreakdown(createOrderFixture('pending_payment', { paymentMethod: 'bitcoin' }))).toBeNull();
    expect(
      bitcoinPaymentBreakdown(
        createOrderFixture('paid', {
          paymentMethod: 'paypal',
          paykitTotalSats: 51_637,
        }),
      ),
    ).toBeNull();
    const exact = projectionBody('buyer_awaiting_confirmation');
    exact.paykit_total_sats = 51_200;
    exact.total = { amount_minor: 51_200, currency: 'SAT', exponent: 0 };
    expect(bitcoinPaymentBreakdown(parseOrder(exact))).toBeNull();
  });

  it('says the checkout payment adds 1–999 sats, without a protocol name', () => {
    expect(BITCOIN_PAYMENT_CODE_CHECKOUT_NOTE).toContain('1–999 sats');
    expect(BITCOIN_PAYMENT_CODE_CHECKOUT_NOTE).not.toMatch(/paykit|protocol/i);
  });
});
