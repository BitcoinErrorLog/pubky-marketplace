import { describe, expect, it } from 'vitest';
import {
  BITCOIN_BUYER_STATUS_TABLE,
  BITCOIN_WALLET_SENT_COPY,
  bitcoinConfirmationExists,
  bitcoinPaidConfirmation,
  bitcoinSeenBadgeLabel,
  buyerBitcoinWalletCopy,
  buyerCheckoutBadgeLabel,
  buyerCheckoutProgressCopy,
  holdCountdownCopy,
  paidOrderHeadline,
  PAYMENT_CONFIRMED_ON_CHAIN_COPY,
  PAYMENT_CONFIRMED_ON_CHAIN_LABEL,
  PAYMENT_SEEN_LABEL,
  SELLER_CONFIRMED_ON_CHAIN_COPY,
  SELLER_CONFIRMED_PAYMENT_COPY,
  sellerBitcoinConfirmPrompt,
  sellerBitcoinDecision,
} from './bitcoin-buyer-status';

const NOW = Date.parse('2026-09-28T11:00:00.000Z');
const SHORT_HOLD = '2026-09-28T11:05:00.000Z';
const SELLER_DEADLINE = '2026-09-29T10:56:41.980Z';

const COUNTDOWN = '23:56:41 left';

const seenOrder = {
  paymentMethod: 'bitcoin' as const,
  paykitRequestState: 'awaiting_seller_confirmation' as const,
  paykitDeliveryState: 'delivered',
  holdExpiresAt: SELLER_DEADLINE,
  paykitSellerConfirmationDeadline: SELLER_DEADLINE,
  paykitTotalSats: 1_303,
  merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
  bitcoinPayable: { amountMinor: 1_303, currency: 'SAT', exponent: 0 },
  subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
  shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
  total: { amountMinor: 1_303, currency: 'BTC', exponent: 8 },
};

describe('bitcoin buyer status', () => {
  it.each(BITCOIN_BUYER_STATUS_TABLE)('$id', (row) => {
    const order = {
      paymentMethod: 'bitcoin' as const,
      paykitRequestState: row.paykitRequestState,
      paykitDeliveryState: 'delivered' as const,
      holdExpiresAt: row.forbidsPayLabels ? SELLER_DEADLINE : SHORT_HOLD,
      paykitSellerConfirmationDeadline: row.forbidsPayLabels ? SELLER_DEADLINE : null,
    };
    const payment = {
      state: row.paymentState,
      reviewReason: row.reviewReason,
      confirmations: row.confirmations,
    };
    expect(bitcoinConfirmationExists(order, payment)).toBe(row.confirmationExists);
    const progress = buyerCheckoutProgressCopy(order, payment, NOW);
    const wallet = buyerBitcoinWalletCopy(order, payment);
    expect(progress).toBe(row.progress.includes('Seller confirms by') ? `${row.progress} ${COUNTDOWN}` : row.progress);
    expect(wallet.text).toBe(row.wallet);
    expect(buyerCheckoutBadgeLabel(order, payment)).toBe(
      row.forbidsPayLabels ? PAYMENT_SEEN_LABEL : 'Reserved while you pay',
    );
    if (row.forbidsPayLabels) {
      expect(progress).not.toMatch(/Reserved while you pay|Pay by/);
      expect(wallet.text).not.toMatch(/Reserved while you pay|Pay by|Open Bitkit to pay/);
    }
    if (!row.confirmationExists) {
      expect(progress).not.toMatch(/confirmed on-chain/);
      expect(wallet.text).not.toMatch(/confirmed on-chain/);
    }
  });

  it('names the seller confirm-by time once a payment is seen', () => {
    expect(buyerCheckoutProgressCopy(seenOrder, { state: 'awaiting_entitlement' }, NOW)).toBe(
      `Seller confirms by Sep 29, 2026, 10:56 AM UTC. ${COUNTDOWN}`,
    );
    expect(sellerBitcoinConfirmPrompt(seenOrder)).toBe('Confirm you received ₿1,303');
    expect(sellerBitcoinDecision(seenOrder, { state: 'awaiting_entitlement' })).toBe('confirm');
  });

  it('asks the seller to resolve a late settlement', () => {
    const reviewed = { ...seenOrder, paykitRequestState: 'confirmed' as const };
    expect(sellerBitcoinDecision(reviewed, { state: 'manual_review', reviewReason: 'late_settlement' })).toBe(
      'resolve',
    );
  });

  it('counts down the seller-confirmation hold as H:MM:SS and drops it once the window ends', () => {
    expect(holdCountdownCopy(SELLER_DEADLINE, NOW)).toBe(COUNTDOWN);
    expect(holdCountdownCopy(SELLER_DEADLINE, Date.parse('2026-09-29T10:56:40.000Z'))).toBe('0:00:01 left');
    expect(holdCountdownCopy(SELLER_DEADLINE, Date.parse('2026-09-29T10:06:41.000Z'))).toBe('0:50:00 left');
    expect(holdCountdownCopy(SELLER_DEADLINE, Date.parse('2026-09-29T10:56:00.000Z'))).toBe('0:00:41 left');
    expect(holdCountdownCopy(SELLER_DEADLINE, Date.parse('2026-09-29T10:56:41.980Z'))).toBeNull();
    expect(holdCountdownCopy(SELLER_DEADLINE, Date.parse('2026-09-30T00:00:00.000Z'))).toBeNull();
    expect(holdCountdownCopy(null, NOW)).toBeNull();
    expect(holdCountdownCopy('not a date', NOW)).toBeNull();
    expect(
      buyerCheckoutProgressCopy(seenOrder, { state: 'awaiting_entitlement' }, Date.parse('2026-09-30T00:00:00Z')),
    ).toBe('Seller confirms by Sep 29, 2026, 10:56 AM UTC.');
  });

  it('labels the badge Payment seen once the payment is seen and Confirmed on-chain after a confirmation', () => {
    const unpaid = { ...seenOrder, paykitRequestState: 'pending' as const };
    expect(bitcoinSeenBadgeLabel(unpaid, { state: 'awaiting_entitlement' })).toBeNull();
    expect(bitcoinSeenBadgeLabel(seenOrder, { state: 'awaiting_entitlement' })).toBe(PAYMENT_SEEN_LABEL);
    expect(
      bitcoinSeenBadgeLabel({ ...seenOrder, paykitRequestState: 'detected' }, { state: 'awaiting_entitlement' }),
    ).toBe(PAYMENT_SEEN_LABEL);
    expect(bitcoinSeenBadgeLabel(seenOrder, { state: 'awaiting_entitlement', confirmations: 1 })).toBe(
      PAYMENT_CONFIRMED_ON_CHAIN_LABEL,
    );
    expect(bitcoinSeenBadgeLabel({ paymentMethod: 'paypal' }, { state: 'awaiting_entitlement' })).toBeNull();
  });

  it('tells a buyer who already broadcast that the page follows the transaction', () => {
    const unpaid = { ...seenOrder, paykitRequestState: 'pending' as const };
    const wallet = buyerBitcoinWalletCopy(unpaid, { state: 'awaiting_entitlement' });
    expect(wallet).toEqual({ kind: 'pay', text: BITCOIN_WALLET_SENT_COPY });
    expect(wallet.text).toMatch(
      /already sent the payment, this page updates as soon as the marketplace sees the transaction/,
    );
  });

  it('says the request was sent, never delivered, because Paykit cannot see the wallet accept it', () => {
    const unpaid = { ...seenOrder, paykitRequestState: 'pending' as const };
    const wallet = buyerBitcoinWalletCopy(unpaid, { state: 'awaiting_entitlement' });
    expect(wallet.text).toMatch(/^Sent to your wallet\. Open Bitkit to pay\./);
    expect(wallet.text).toMatch(/check that the seller is one of your Bitkit contacts/);
    expect(wallet.text).not.toMatch(/[Dd]elivered/);
  });

  describe('paid order confirmation', () => {
    const paidOrder = {
      ...seenOrder,
      paykitRequestState: 'confirmed' as const,
      paykitSellerConfirmationDeadline: null,
    };

    it('names the seller and records no chain confirmation for a seller confirm at 0 confirmations', () => {
      const payment = { state: 'confirmed', confirmations: 0 };
      expect(bitcoinPaidConfirmation(paidOrder, payment)).toEqual({ sellerConfirmed: true, onChain: false });
      expect(bitcoinConfirmationExists(paidOrder, payment)).toBe(false);
      expect(paidOrderHeadline(paidOrder, payment)).toBe(SELLER_CONFIRMED_PAYMENT_COPY);
      expect(paidOrderHeadline(paidOrder, payment)).not.toMatch(/on-chain/);
    });

    it('adds the chain state when a confirmation was recorded', () => {
      const payment = { state: 'confirmed', confirmations: 2 };
      expect(bitcoinPaidConfirmation(paidOrder, payment)).toEqual({ sellerConfirmed: true, onChain: true });
      expect(paidOrderHeadline(paidOrder, payment)).toBe(SELLER_CONFIRMED_ON_CHAIN_COPY);
    });

    it.each(['late_settlement', 'amount_mismatch'] as const)(
      'treats a resolved %s review as a chain observation the seller accepted',
      (reviewReason) => {
        const payment = { state: 'confirmed', confirmations: 0, reviewReason, resolutionOutcome: 'paid' };
        expect(bitcoinPaidConfirmation(paidOrder, payment)).toEqual({ sellerConfirmed: true, onChain: true });
      },
    );

    it.each([null, 'unpinned_legacy', 'refund_required'] as const)(
      'does not count a resolved review with reason %s as on-chain',
      (reviewReason) => {
        const payment = { state: 'confirmed', confirmations: 0, reviewReason, resolutionOutcome: 'paid' };
        expect(bitcoinPaidConfirmation(paidOrder, payment)).toEqual({ sellerConfirmed: true, onChain: false });
      },
    );

    it('credits the chain, not the seller, for late money that completed the order', () => {
      const late = { ...paidOrder, cancellationReason: 'payment window elapsed' };
      const payment = { state: 'confirmed', confirmations: 0 };
      expect(bitcoinPaidConfirmation(late, payment)).toEqual({ sellerConfirmed: false, onChain: true });
      expect(paidOrderHeadline(late, payment)).toBe(PAYMENT_CONFIRMED_ON_CHAIN_COPY);
    });

    it('is null before payment and on other rails', () => {
      expect(bitcoinPaidConfirmation(paidOrder, { state: 'awaiting_entitlement' })).toBeNull();
      expect(bitcoinPaidConfirmation({ paymentMethod: 'paypal' }, { state: 'confirmed' })).toBeNull();
      expect(paidOrderHeadline({ paymentMethod: 'paypal' }, { state: 'confirmed' })).toBe('Payment confirmed.');
      expect(paidOrderHeadline(paidOrder, null)).toBe('Payment confirmed.');
    });
  });
});
