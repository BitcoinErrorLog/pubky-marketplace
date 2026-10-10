import { describe, expect, it } from 'vitest';
import { marketplaceOrderSchema } from '@/core/services/marketplace/marketplace-projections';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import {
  USDT_WIRE_ORDER_FINAL,
  USDT_WIRE_ORDER_INCLUDED_NOT_FINAL,
  USDT_WIRE_ORDER_PENDING_PAYMENT,
  USDT_WIRE_ORDER_REORGED,
  USDT_WIRE_PAYMENT_NOT_FINAL_REFUSAL,
} from '@/test/fixtures/commerce/usdt-orders';
import { isPaymentNotFinalRefusal, PAYMENT_FINALITIES, PAYMENT_NOT_FINAL_REASON } from './usdt-settlement-contract';

const parseWire = (wire: Record<string, unknown>) =>
  marketplaceOrderSchema.parse({
    ...createOrderFixture('paid'),
    ...(toCamelCaseWire(wire) as Record<string, unknown>),
  });

describe('USDT settlement contract', () => {
  it('pins the finality values and the refusal reason the service sends', () => {
    expect(PAYMENT_FINALITIES).toEqual(['pending', 'final', 'reverted']);
    expect(PAYMENT_NOT_FINAL_REASON).toBe('payment_not_final');
  });

  it('parses payment_finality from each pinned wire fixture', () => {
    expect(parseWire(USDT_WIRE_ORDER_PENDING_PAYMENT).paymentFinality).toBeUndefined();
    expect(parseWire(USDT_WIRE_ORDER_INCLUDED_NOT_FINAL).paymentFinality).toBe('pending');
    expect(parseWire(USDT_WIRE_ORDER_FINAL).paymentFinality).toBe('final');
    expect(parseWire(USDT_WIRE_ORDER_REORGED).paymentFinality).toBe('reverted');
  });

  it('reads a null finality as absent and keeps the order when the value is unknown', () => {
    expect(parseWire({ ...USDT_WIRE_ORDER_FINAL, payment_finality: null }).paymentFinality).toBeNull();
    const parsed = parseWire({ ...USDT_WIRE_ORDER_FINAL, payment_finality: 'settled-ish' });
    expect(parsed.paymentMethod).toBe('usdt');
    expect(parsed.paymentFinality).toBeUndefined();
  });

  it('leaves every non-USDT order without a finality, byte-for-byte as before', () => {
    for (const method of ['bitcoin', 'paypal', 'stripe', null] as const) {
      const input = { ...createOrderFixture('paid'), paymentMethod: method };
      const parsed = marketplaceOrderSchema.parse(input);
      expect(parsed.paymentFinality).toBeUndefined();
      expect(parsed).toEqual(marketplaceOrderSchema.parse(createOrderFixture('paid', { paymentMethod: method })));
    }
  });

  it('recognises the payment_not_final command refusal and nothing else', () => {
    expect(isPaymentNotFinalRefusal(USDT_WIRE_PAYMENT_NOT_FINAL_REFUSAL)).toBe(true);
    expect(
      isPaymentNotFinalRefusal({ ok: false, error: { code: 'INVALID_STATE', message: 'x', reason: 'sold_out' } }),
    ).toBe(false);
    expect(isPaymentNotFinalRefusal({ ok: false, error: { code: 'payment_not_final', message: 'x' } })).toBe(false);
    expect(isPaymentNotFinalRefusal({ ok: true })).toBe(false);
    expect(isPaymentNotFinalRefusal(null)).toBe(false);
    expect(isPaymentNotFinalRefusal('payment_not_final')).toBe(false);
  });
});
