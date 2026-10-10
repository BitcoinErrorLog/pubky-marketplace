import { describe, expect, it } from 'vitest';
import {
  REFUND_FIXTURE_ADDRESS,
  REFUND_FIXTURE_OTHER_ADDRESS,
  REFUND_FIXTURE_TX_HASH,
  USDT_REFUND_REFUSAL_REASONS,
} from '@/test/fixtures/commerce/usdt-refund.wire';
import {
  formatUsdtParity,
  isArbitrumTxHash,
  isUsdtRefundOrder,
  isValidArbitrumAddress,
  normalizeArbitrumTxHash,
  refundDestinationSchema,
  sameArbitrumAddress,
  USDT_REFUND_COPY,
  USDT_REFUND_REFUSAL_COPY,
  usdtParityMillionths,
  usdtRefundDueMoney,
  type UsdtRefundOrder,
  usdtRefundRecordLine,
  usdtRefundRefusalMessage,
  usdtRefundSurface,
} from './usdt-refund';

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', exponent: 2 });
const destination = {
  address: REFUND_FIXTURE_ADDRESS,
  network: 'arbitrum-one' as const,
  asset: 'USDT' as const,
  source: 'buyer_entered',
  confirmedAt: '2026-10-09T16:00:00.000Z',
};
const order = (overrides: Partial<UsdtRefundOrder> = {}): UsdtRefundOrder => ({
  state: 'paid',
  total: usd(2_500),
  paymentAsset: 'USDT',
  receiptId: 'receipt',
  ...overrides,
});

describe('isValidArbitrumAddress', () => {
  it('accepts the EIP-55 specification vectors', () => {
    for (const address of [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ]) {
      expect(isValidArbitrumAddress(address)).toBe(true);
    }
  });

  it('accepts all-lowercase and all-uppercase addresses, which carry no checksum', () => {
    expect(isValidArbitrumAddress(REFUND_FIXTURE_ADDRESS.toLowerCase())).toBe(true);
    expect(isValidArbitrumAddress(`0x${REFUND_FIXTURE_ADDRESS.slice(2).toUpperCase()}`)).toBe(true);
  });

  it('rejects a mixed-case address whose checksum is wrong', () => {
    const flipped = `0x${REFUND_FIXTURE_ADDRESS.slice(2).replace('a', 'A')}`;
    expect(flipped).not.toBe(REFUND_FIXTURE_ADDRESS);
    expect(isValidArbitrumAddress(flipped)).toBe(false);
  });

  it('rejects anything that is not 0x plus 40 hex characters', () => {
    for (const value of [
      '',
      '0x',
      REFUND_FIXTURE_ADDRESS.slice(0, -1),
      `${REFUND_FIXTURE_ADDRESS}0`,
      REFUND_FIXTURE_ADDRESS.slice(2),
      `0x${'g'.repeat(40)}`,
      ` ${REFUND_FIXTURE_ADDRESS}`,
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    ]) {
      expect(isValidArbitrumAddress(value)).toBe(false);
    }
  });

  it('compares addresses ignoring case', () => {
    expect(sameArbitrumAddress(REFUND_FIXTURE_ADDRESS, REFUND_FIXTURE_ADDRESS.toLowerCase())).toBe(true);
    expect(sameArbitrumAddress(REFUND_FIXTURE_ADDRESS, REFUND_FIXTURE_OTHER_ADDRESS)).toBe(false);
    expect(sameArbitrumAddress(null, REFUND_FIXTURE_ADDRESS)).toBe(false);
  });
});

describe('Arbitrum transaction hash', () => {
  it('accepts 0x plus 64 hex characters in either case and normalizes to lowercase', () => {
    expect(isArbitrumTxHash(REFUND_FIXTURE_TX_HASH)).toBe(true);
    expect(isArbitrumTxHash(REFUND_FIXTURE_TX_HASH.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(normalizeArbitrumTxHash(`  0x${'AB'.repeat(32)} `)).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('rejects a short hash, a missing prefix, non-hex characters and an address', () => {
    for (const value of [
      '',
      `0x${'a'.repeat(63)}`,
      `0x${'a'.repeat(65)}`,
      'a'.repeat(64),
      `0x${'z'.repeat(64)}`,
      REFUND_FIXTURE_ADDRESS,
    ]) {
      expect(isArbitrumTxHash(value)).toBe(false);
    }
  });
});

describe('refund destination projection field', () => {
  it('reads the pinned S6 shape', () => {
    expect(refundDestinationSchema.parse(destination)).toEqual(destination);
  });

  it('rejects another network, another asset and a malformed address', () => {
    expect(refundDestinationSchema.safeParse({ ...destination, network: 'base' }).success).toBe(false);
    expect(refundDestinationSchema.safeParse({ ...destination, asset: 'DAI' }).success).toBe(false);
    expect(refundDestinationSchema.safeParse({ ...destination, address: '0x12' }).success).toBe(false);
  });
});

describe('usdtRefundSurface', () => {
  it('stays hidden for every order that is not paid in USDT', () => {
    for (const paymentAsset of [undefined, null, 'BTC']) {
      expect(usdtRefundSurface(order({ paymentAsset }), true, false)).toEqual({ kind: 'hidden' });
      expect(usdtRefundSurface(order({ paymentAsset }), false, false)).toEqual({ kind: 'hidden' });
    }
    expect(isUsdtRefundOrder({ paymentAsset: 'USDT' })).toBe(true);
    expect(isUsdtRefundOrder({})).toBe(false);
  });

  it('stays hidden until the payment settled', () => {
    expect(usdtRefundSurface(order({ state: 'pending_payment' }), true, false)).toEqual({ kind: 'hidden' });
    expect(usdtRefundSurface(order({ state: 'cancelled', receiptId: null }), true, false)).toEqual({ kind: 'hidden' });
  });

  it('asks the buyer for an address on a paid order and marks refund-due states', () => {
    expect(usdtRefundSurface(order(), true, false)).toEqual({ kind: 'buyer', phase: 'needed', refundDue: false });
    expect(usdtRefundSurface(order({ state: 'return_approved' }), true, false)).toEqual({
      kind: 'buyer',
      phase: 'needed',
      refundDue: true,
    });
    expect(usdtRefundSurface(order({ state: 'cancelled' }), true, false)).toEqual({
      kind: 'buyer',
      phase: 'needed',
      refundDue: true,
    });
  });

  it('offers the buyer the address while a payment is in manual review', () => {
    expect(usdtRefundSurface(order({ state: 'pending_payment', receiptId: null }), true, true)).toEqual({
      kind: 'buyer',
      phase: 'needed',
      refundDue: true,
    });
  });

  it('moves the buyer from confirmed to recorded', () => {
    expect(usdtRefundSurface(order({ refundDestination: destination }), true, false)).toMatchObject({
      phase: 'confirmed',
    });
    expect(
      usdtRefundSurface(
        order({
          state: 'refunded_external',
          refundDestination: destination,
          externalRefund: { amountMinor: 2_500, transactionId: REFUND_FIXTURE_TX_HASH },
        }),
        true,
        false,
      ),
    ).toMatchObject({ phase: 'recorded' });
  });

  it('shows the seller nothing on a plain paid order, and the waiting or confirmed state once a refund is due', () => {
    expect(usdtRefundSurface(order(), false, false)).toEqual({ kind: 'hidden' });
    expect(usdtRefundSurface(order({ state: 'return_received' }), false, false)).toEqual({
      kind: 'seller',
      phase: 'waiting',
    });
    expect(usdtRefundSurface(order({ refundDestination: destination }), false, false)).toEqual({
      kind: 'seller',
      phase: 'confirmed',
    });
  });
});

describe('USDT parity amounts', () => {
  it('turns USD cents into exact USDT millionths', () => {
    expect(usdtParityMillionths(usd(2_500))).toBe(25_000_000);
    expect(formatUsdtParity(usd(2_500))).toBe('25.000000 USDT');
    expect(formatUsdtParity(usd(1))).toBe('0.010000 USDT');
  });

  it('has no parity amount for a non-USD or non-cent total', () => {
    expect(usdtParityMillionths({ amountMinor: 1_000, currency: 'SAT', exponent: 0 })).toBeNull();
    expect(usdtParityMillionths({ amountMinor: 1_000, currency: 'USD', exponent: 0 })).toBeNull();
  });

  it('asks for the requested return amount while a return is open, else the whole order', () => {
    expect(usdtRefundDueMoney(order())).toEqual(usd(2_500));
    expect(
      usdtRefundDueMoney(order({ returnRequest: { state: 'approved', requestedAmountMinor: 1_000 } })).amountMinor,
    ).toBe(1_000);
  });
});

describe('refusal copy', () => {
  it('maps every closed S6 reason to plan copy', () => {
    expect(USDT_REFUND_REFUSAL_COPY.size).toBe(USDT_REFUND_REFUSAL_REASONS.length);
    expect(usdtRefundRefusalMessage({ reason: 'refund_destination_required' })).toBe(
      "Ask the buyer to confirm a refund address first. It's on their order page.",
    );
    expect(usdtRefundRefusalMessage({ reason: 'invalid_refund_destination' })).toBe(
      "That isn't a valid Arbitrum address. Check it and try again.",
    );
    expect(usdtRefundRefusalMessage({ reason: 'invalid_refund_reference' })).toBe(
      'Enter the Arbitrum transaction hash (0x followed by 64 characters).',
    );
  });

  it('also reads a message that is exactly the reason token, and never echoes other service text', () => {
    expect(usdtRefundRefusalMessage({ message: 'invalid_refund_reference' })).toBe(USDT_REFUND_COPY.referenceRequired);
    expect(usdtRefundRefusalMessage({ message: `Rejected ${REFUND_FIXTURE_ADDRESS}` })).toBeNull();
    expect(usdtRefundRefusalMessage({ reason: 'something_else', message: 'x' })).toBeNull();
    expect(usdtRefundRefusalMessage({})).toBeNull();
  });
});

describe('recorded refund copy', () => {
  const recorded = order({
    state: 'refunded_external',
    refundDestination: destination,
    externalRefund: { amountMinor: 2_500, transactionId: REFUND_FIXTURE_TX_HASH },
  });

  it('says what the seller recorded and that the Shop has not checked it', () => {
    expect(usdtRefundRecordLine(recorded)).toBe(
      `The seller recorded a refund of 25.000000 USDT to ${REFUND_FIXTURE_ADDRESS} (transaction ${REFUND_FIXTURE_TX_HASH}). The Shop hasn't checked it on Arbitrum.`,
    );
  });

  it('names a partial amount', () => {
    expect(
      usdtRefundRecordLine({
        ...recorded,
        externalRefund: { amountMinor: 1_000, transactionId: REFUND_FIXTURE_TX_HASH },
      }),
    ).toContain('a refund of 10.000000 USDT ($10.00 of $25.00) to ');
  });

  it('is empty for a non-USDT order or an unrecorded refund', () => {
    expect(usdtRefundRecordLine({ ...recorded, paymentAsset: null })).toBeNull();
    expect(usdtRefundRecordLine(order())).toBeNull();
  });

  it('never claims the refund was verified or confirmed on-chain', () => {
    const everyString = [
      ...Object.values(USDT_REFUND_COPY),
      ...USDT_REFUND_REFUSAL_COPY.values(),
      usdtRefundRecordLine(recorded) ?? '',
    ];
    for (const copy of everyString) {
      expect(copy.toLowerCase()).not.toMatch(/verified|verifies|proven|(?:confirmed|settled) on arbitrum/);
    }
    expect(USDT_REFUND_COPY.recordedBySeller).toBe('Recorded by the seller');
  });
});
