import { describe, expect, it } from 'vitest';
import {
  amountInputFromMoney,
  amountInputSchemaForAsset,
  amountInputToMoney,
  amountInputUnitLabel,
  BTC_ASSET,
  indicativeCounterpartLabel,
  isBitcoinAsset,
  sumMoneyByAsset,
  USD_ASSET,
} from './pricing';

describe('asset identification', () => {
  it('recognizes base-unit-denominated bitcoin and nothing else', () => {
    expect(isBitcoinAsset({ currency: 'BTC', exponent: 8 })).toBe(true);
    expect(isBitcoinAsset({ currency: 'BTC', exponent: 2 })).toBe(false);
    expect(isBitcoinAsset({ currency: 'USD', exponent: 8 })).toBe(false);
  });

  it('labels the input unit per asset', () => {
    expect(amountInputUnitLabel(USD_ASSET)).toBe('USD');
    expect(amountInputUnitLabel(BTC_ASSET)).toBe('₿');
    expect(amountInputUnitLabel({ currency: 'EUR', exponent: 2 })).toBe('EUR');
  });
});

describe('amount input validation', () => {
  it('accepts USD amounts with at most two decimals', () => {
    const schema = amountInputSchemaForAsset(USD_ASSET);
    expect(schema.safeParse('125.00').success).toBe(true);
    expect(schema.safeParse('125').success).toBe(true);
    expect(schema.safeParse('125.001').success).toBe(false);
    expect(schema.safeParse('0').success).toBe(false);
    expect(schema.safeParse('-5').success).toBe(false);
  });

  it('accepts only whole positive base units within the total supply', () => {
    const schema = amountInputSchemaForAsset(BTC_ASSET);
    expect(schema.safeParse('15000').success).toBe(true);
    expect(schema.safeParse('1').success).toBe(true);
    expect(schema.safeParse('0').success).toBe(false);
    expect(schema.safeParse('150.5').success).toBe(false);
    expect(schema.safeParse('2100000000000001').success).toBe(false);
  });
});

describe('amount input to money and back', () => {
  it('converts USD input to cents without conversion drift', () => {
    expect(amountInputToMoney('125.00', USD_ASSET)).toEqual({ amountMinor: 12_500, currency: 'USD', exponent: 2 });
    expect(amountInputToMoney('0.10', USD_ASSET)).toEqual({ amountMinor: 10, currency: 'USD', exponent: 2 });
  });

  it('treats a bitcoin input as the minor unit itself', () => {
    expect(amountInputToMoney('15000', BTC_ASSET)).toEqual({ amountMinor: 15_000, currency: 'BTC', exponent: 8 });
  });

  it('round-trips money back to its input string', () => {
    expect(amountInputFromMoney({ amountMinor: 12_500, currency: 'USD', exponent: 2 })).toBe('125.00');
    expect(amountInputFromMoney({ amountMinor: 15_000, currency: 'BTC', exponent: 8 })).toBe('15000');
  });
});

describe('indicativeCounterpartLabel', () => {
  const RATE = 100_000; // 1 BTC = $100,000 → 1 base unit = $0.001

  it('shows a bitcoin estimate for USD-priced money', () => {
    expect(indicativeCounterpartLabel({ amountMinor: 12_500, currency: 'USD', exponent: 2 }, RATE)).toBe('≈ ₿125,000');
  });

  it('shows a USD estimate for BTC-priced money', () => {
    expect(indicativeCounterpartLabel({ amountMinor: 15_000, currency: 'BTC', exponent: 8 }, RATE)).toBe('≈ $15.00');
  });

  it('returns null without a positive finite rate — no rate, no estimate', () => {
    const money = { amountMinor: 12_500, currency: 'USD', exponent: 2 };
    expect(indicativeCounterpartLabel(money, 0)).toBeNull();
    expect(indicativeCounterpartLabel(money, -1)).toBeNull();
    expect(indicativeCounterpartLabel(money, Number.NaN)).toBeNull();
    expect(indicativeCounterpartLabel(money, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('returns null for assets with no rate source', () => {
    expect(indicativeCounterpartLabel({ amountMinor: 12_500, currency: 'EUR', exponent: 2 }, RATE)).toBeNull();
  });

  it('returns null when the estimate rounds to zero in the counterpart unit', () => {
    // $0.0000004 at $100k/BTC rounds to 0 base units — amountMinor can't
    // express this for USD/2, so use a high-exponent USD to prove the guard.
    expect(indicativeCounterpartLabel({ amountMinor: 4, currency: 'USD', exponent: 7 }, RATE)).toBeNull();
    // 1 base unit at $100k/BTC is $0.001 → rounds below one cent.
    expect(indicativeCounterpartLabel({ amountMinor: 1, currency: 'BTC', exponent: 8 }, RATE)).toBeNull();
  });
});

describe('sumMoneyByAsset', () => {
  it('sums quantities within one asset', () => {
    const totals = sumMoneyByAsset([
      { money: { amountMinor: 1_000, currency: 'USD', exponent: 2 }, quantity: 2 },
      { money: { amountMinor: 500, currency: 'USD', exponent: 2 }, quantity: 1 },
    ]);
    expect(totals).toEqual([{ amountMinor: 2_500, currency: 'USD', exponent: 2 }]);
  });

  it('never adds minor units of different assets together', () => {
    const totals = sumMoneyByAsset([
      { money: { amountMinor: 3_000, currency: 'USD', exponent: 2 }, quantity: 1 },
      { money: { amountMinor: 25_000, currency: 'BTC', exponent: 8 }, quantity: 1 },
    ]);
    expect(totals).toEqual([
      { amountMinor: 3_000, currency: 'USD', exponent: 2 },
      { amountMinor: 25_000, currency: 'BTC', exponent: 8 },
    ]);
  });

  it('returns an empty list for an empty cart', () => {
    expect(sumMoneyByAsset([])).toEqual([]);
  });
});
