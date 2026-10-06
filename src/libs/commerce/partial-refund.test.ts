import { describe, expect, it } from 'vitest';
import { partialRefundLabel, plainRefundRefusal } from './partial-refund';

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', exponent: 2 });

describe('partialRefundLabel', () => {
  it('names a recorded amount below the order total', () => {
    expect(
      partialRefundLabel({
        state: 'refunded_external',
        total: usd(250),
        externalRefund: { amountMinor: 189 },
      }),
    ).toBe('Refunded $1.89 of $2.50');
  });

  it('names a partial-refund state even when the amounts match', () => {
    expect(
      partialRefundLabel({
        state: 'refunded_partial',
        total: usd(250),
        externalRefund: { amountMinor: 250 },
      }),
    ).toBe('Refunded $2.50 of $2.50');
  });

  it('leaves a full external refund on the existing copy', () => {
    expect(
      partialRefundLabel({
        state: 'refunded_external',
        total: usd(250),
        externalRefund: { amountMinor: 250 },
      }),
    ).toBeNull();
  });
});

describe('plainRefundRefusal', () => {
  it('keeps the service refusal sentence', () => {
    expect(plainRefundRefusal('The external refund cannot be recorded.')).toBe(
      'The external refund cannot be recorded.',
    );
  });

  it('drops markup and empty text', () => {
    expect(plainRefundRefusal('<b>no</b>')).toBeNull();
    expect(plainRefundRefusal('  ')).toBeNull();
    expect(plainRefundRefusal(null)).toBeNull();
  });
});
