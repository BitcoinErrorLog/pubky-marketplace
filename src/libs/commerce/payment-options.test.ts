import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  formatUsdt,
  parsePaymentOptionId,
  PAYMENT_ASSETS,
  PAYMENT_METHOD_KINDS,
  PAYMENT_NETWORKS,
  PAYMENT_OPTION_IDS,
  PAYMENT_OPTIONS,
  paymentAssetFieldsShape,
  paymentOptionForMethod,
  SETTLEMENT_MODES,
  USDT_EXPONENT,
  USDT_PAYMENT_OPTION_ID,
} from './payment-options';

describe('payment option model', () => {
  it('names the USDT option {method}.{asset}.{network}', () => {
    expect(USDT_PAYMENT_OPTION_ID).toBe('paykit.usdt.arbitrum-one');
    expect(PAYMENT_OPTIONS['paykit.usdt.arbitrum-one']).toEqual({
      id: 'paykit.usdt.arbitrum-one',
      method: 'usdt',
      asset: 'USDT',
      network: 'arbitrum-one',
    });
  });

  it('keeps every existing method label on its existing option', () => {
    expect(paymentOptionForMethod('bitcoin').id).toBe('paykit.btc.bitcoin');
    expect(paymentOptionForMethod('paypal')).toMatchObject({ id: 'paypal.fiat', asset: null, network: null });
    expect(paymentOptionForMethod('stripe')).toMatchObject({ id: 'stripe.fiat', asset: null, network: null });
    expect(paymentOptionForMethod('usdt').id).toBe('paykit.usdt.arbitrum-one');
  });

  it('defines exactly one option per method label, and every option id is {method}.{asset}.{network} or {method}.fiat', () => {
    expect(PAYMENT_OPTION_IDS).toHaveLength(PAYMENT_METHOD_KINDS.length);
    for (const id of PAYMENT_OPTION_IDS) {
      const option = PAYMENT_OPTIONS[id];
      const [rail, ...rest] = id.split('.');
      expect(PAYMENT_METHOD_KINDS).toContain(option.method);
      if (option.asset === null) {
        expect(rest).toEqual(['fiat']);
      } else {
        expect(rest).toEqual([option.asset.toLowerCase(), option.network]);
        expect(PAYMENT_ASSETS).toContain(option.asset);
        expect(PAYMENT_NETWORKS).toContain(option.network);
      }
      expect(rail.length).toBeGreaterThan(0);
    }
  });

  it('separates Lock Server entitlement from every service-verified mode', () => {
    expect(SETTLEMENT_MODES).toEqual(['locked', 'paykit', 'gateway-notified', 'processor', 'seller-attested']);
  });

  it('parses a known option id and returns null for anything else', () => {
    expect(parsePaymentOptionId('paykit.usdt.arbitrum-one')).toBe('paykit.usdt.arbitrum-one');
    expect(parsePaymentOptionId('paykit.usdt.base')).toBeNull();
    expect(parsePaymentOptionId(undefined)).toBeNull();
    expect(parsePaymentOptionId(7)).toBeNull();
  });
});

describe('asset-bearing order fields', () => {
  const schema = z.object(paymentAssetFieldsShape);

  it('accepts a USDT attempt', () => {
    expect(
      schema.parse({
        paymentAsset: 'USDT',
        paymentNetwork: 'arbitrum-one',
        paymentAmountMinor: 25_000_000,
        paymentExponent: USDT_EXPONENT,
        paymentQuoteBasis: 'parity',
      }),
    ).toEqual({
      paymentAsset: 'USDT',
      paymentNetwork: 'arbitrum-one',
      paymentAmountMinor: 25_000_000,
      paymentExponent: 6,
      paymentQuoteBasis: 'parity',
    });
  });

  it('accepts nulls and absence for non-USDT orders', () => {
    expect(schema.parse({})).toEqual({});
    expect(
      schema.parse({
        paymentAsset: null,
        paymentNetwork: null,
        paymentAmountMinor: null,
        paymentExponent: null,
        paymentQuoteBasis: null,
      }),
    ).toEqual({
      paymentAsset: null,
      paymentNetwork: null,
      paymentAmountMinor: null,
      paymentExponent: null,
      paymentQuoteBasis: null,
    });
  });

  it('drops a value the Shop does not recognise instead of failing', () => {
    expect(
      schema.parse({
        paymentAsset: 'DAI',
        paymentNetwork: 'base',
        paymentAmountMinor: -1,
        paymentExponent: 1.5,
        paymentQuoteBasis: 'oracle',
      }),
    ).toEqual({});
  });
});

describe('formatUsdt', () => {
  it.each([
    [25_000_000, '25.000000 USDT'],
    [1, '0.000001 USDT'],
    [0, '0.000000 USDT'],
    [1_234_567_890, '1234.567890 USDT'],
    [999_999, '0.999999 USDT'],
  ])('renders %i millionths as %s', (millionths, expected) => {
    expect(formatUsdt(millionths)).toBe(expected);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('refuses %s', (value) => {
    expect(() => formatUsdt(value)).toThrow();
  });
});
