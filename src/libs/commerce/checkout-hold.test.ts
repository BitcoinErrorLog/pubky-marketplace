import { describe, expect, it } from 'vitest';
import { createOrderFixture, ORDER_FIXTURE_BUYER } from '@/test/fixtures/commerce/orders';
import {
  CHECKOUT_HOLD_COPY,
  findViewerAcceptedOfferHold,
  findViewerPendingHoldOrder,
  formatHoldDeadline,
  formatOrderInstant,
  holderBoundCopy,
  holderUnboundCopy,
  isHoldExpiredNoLateMoney,
  isLateCompletionOrder,
  isRefundRequiredPayment,
  PAYMENT_WINDOW_ELAPSED_REASON,
  refundRequiredCopyForRole,
  refundRequiredSellerCopy,
  UNBOUND_BACK_CANCEL_REASON,
} from './checkout-hold';

describe('checkout-hold copy', () => {
  it('asks a Bitcoin buyer to settle a pending payment before ordering again, without claiming a wallet guards it', () => {
    expect(CHECKOUT_HOLD_COPY.pendingBitcoinPaymentBuyer).toBe(
      'If a payment is still pending in Bitkit, another wallet or another device, let it finish or resolve it before you order again.',
    );
    expect(CHECKOUT_HOLD_COPY.pendingBitcoinPaymentBuyer).not.toMatch(/duplicate|dedup|prevent|block/i);
    expect(CHECKOUT_HOLD_COPY.expiredNoLateMoney).toBe('Payment window elapsed. The item is available again.');
  });

  it('formats hold deadlines in en-US UTC', () => {
    expect(formatHoldDeadline('2026-08-20T21:15:00.000Z')).toBe('Aug 20, 2026, 9:15 PM UTC');
  });

  it('formats order timestamps with the day, and nothing for a missing or invalid value', () => {
    expect(formatOrderInstant('2026-10-01T08:10:00.000Z')).toBe('Oct 1, 2026, 8:10 AM UTC');
    expect(formatOrderInstant(null)).toBeNull();
    expect(formatOrderInstant(undefined)).toBeNull();
    expect(formatOrderInstant('')).toBeNull();
    expect(formatOrderInstant('not a date')).toBeNull();
  });

  it('renders unbound and bound holder copy with the deadline', () => {
    expect(holderUnboundCopy('2026-08-20T21:15:00.000Z')).toBe(
      'The item is held for you until Aug 20, 2026, 9:15 PM UTC.',
    );
    expect(holderBoundCopy('2026-08-20T21:15:00.000Z')).toBe(
      'Pay by Aug 20, 2026, 9:15 PM UTC. If the window ends, the item restocks.',
    );
    expect(holderUnboundCopy(null)).toBe('The item is held for you once a payment starts.');
  });

  it('detects late completion from paid plus leftover elapsed reason', () => {
    expect(isLateCompletionOrder({ state: 'paid', cancellationReason: PAYMENT_WINDOW_ELAPSED_REASON })).toBe(true);
    expect(isLateCompletionOrder({ state: 'paid', cancellationReason: null })).toBe(false);
    expect(isLateCompletionOrder({ state: 'cancelled', cancellationReason: PAYMENT_WINDOW_ELAPSED_REASON })).toBe(
      false,
    );
  });

  it('detects refund_required and elapsed-without-late-money', () => {
    expect(isRefundRequiredPayment({ reviewReason: 'refund_required' })).toBe(true);
    expect(
      isHoldExpiredNoLateMoney(
        { state: 'cancelled', cancellationReason: PAYMENT_WINDOW_ELAPSED_REASON },
        { state: 'expired', reviewReason: null },
      ),
    ).toBe(true);
    expect(
      isHoldExpiredNoLateMoney(
        { state: 'cancelled', cancellationReason: PAYMENT_WINDOW_ELAPSED_REASON },
        { state: 'manual_review', reviewReason: 'refund_required' },
      ),
    ).toBe(false);
  });

  it('picks seller refund instructions per rail', () => {
    expect(refundRequiredSellerCopy('paypal')).toBe(CHECKOUT_HOLD_COPY.refundRequiredPaypalSeller);
    expect(refundRequiredSellerCopy('stripe')).toBe(CHECKOUT_HOLD_COPY.refundRequiredStripeSeller);
    expect(refundRequiredSellerCopy('bitcoin')).toBe(CHECKOUT_HOLD_COPY.refundRequiredBitcoinSeller);
    expect(refundRequiredSellerCopy('usdt')).toBe(CHECKOUT_HOLD_COPY.refundRequiredUsdtSeller);
    expect(CHECKOUT_HOLD_COPY.refundRequiredUsdtSeller).not.toMatch(/bitcoin/i);
    expect(UNBOUND_BACK_CANCEL_REASON.length).toBeGreaterThanOrEqual(1);
    expect(UNBOUND_BACK_CANCEL_REASON.length).toBeLessThanOrEqual(500);
  });

  it('splits refund_required copy by buyer vs seller role', () => {
    expect(refundRequiredCopyForRole(true, 'bitcoin')).toBe(CHECKOUT_HOLD_COPY.refundRequiredBuyer);
    expect(refundRequiredCopyForRole(true, 'paypal')).toBe(CHECKOUT_HOLD_COPY.refundRequiredBuyer);
    expect(refundRequiredCopyForRole(false, 'bitcoin')).toBe(CHECKOUT_HOLD_COPY.refundRequiredBitcoinSeller);
    expect(refundRequiredCopyForRole(false, 'paypal')).toBe(CHECKOUT_HOLD_COPY.refundRequiredPaypalSeller);
    expect(refundRequiredCopyForRole(false, 'stripe')).toBe(CHECKOUT_HOLD_COPY.refundRequiredStripeSeller);
  });
});

describe('findViewerPendingHoldOrder', () => {
  const listingAggregateId = 'listing:yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy_boots_01';
  const sessionId = 'sess_not-a-pubky-identifier';

  const ownHold = {
    order: createOrderFixture('pending_payment', {
      buyerPubky: ORDER_FIXTURE_BUYER,
      lines: [
        {
          ...createOrderFixture('pending_payment').lines[0],
          listingAggregateId,
        },
      ],
    }),
  };

  it('matches the viewer pubky to a pending_payment order on this listing', () => {
    expect(findViewerPendingHoldOrder([ownHold], listingAggregateId, ORDER_FIXTURE_BUYER)).toEqual({
      orderId: ownHold.order.id,
    });
  });

  it('does not treat a session id as the hold owner', () => {
    expect(findViewerPendingHoldOrder([ownHold], listingAggregateId, sessionId)).toBeNull();
    const sessionKeyed = {
      order: { ...ownHold.order, buyerPubky: sessionId },
    };
    expect(findViewerPendingHoldOrder([sessionKeyed], listingAggregateId, ORDER_FIXTURE_BUYER)).toBeNull();
  });

  it('ignores paid orders and holds on other listings', () => {
    const paid = { order: createOrderFixture('paid', { buyerPubky: ORDER_FIXTURE_BUYER }) };
    expect(findViewerPendingHoldOrder([paid], listingAggregateId, ORDER_FIXTURE_BUYER)).toBeNull();
    expect(findViewerPendingHoldOrder([ownHold], 'listing:other_item', ORDER_FIXTURE_BUYER)).toBeNull();
  });
});

describe('findViewerAcceptedOfferHold', () => {
  const listingAggregateId = 'listing:yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy_boots_01';
  const sessionPubky = 'b'.repeat(52);
  const otherPubky = 'c'.repeat(52);
  const activeAward = { state: 'active' as const };

  const ownOffer = {
    id: '018f47d2-6a27-7c23-b51e-000000000003',
    state: 'accepted',
    buyerPubky: sessionPubky,
    listingAggregateId,
    award: activeAward,
  };

  it('links the award buyer to checkout when the accepted offer buyerPubky matches the session pubky', () => {
    expect(findViewerAcceptedOfferHold([ownOffer], listingAggregateId, sessionPubky)).toEqual({
      offerId: ownOffer.id,
    });
  });

  it("does not treat another pubky accepted offer as the viewer's hold", () => {
    expect(
      findViewerAcceptedOfferHold([{ ...ownOffer, buyerPubky: otherPubky }], listingAggregateId, sessionPubky),
    ).toBeNull();
  });

  it('does not claim an offer hold without an active session pubky', () => {
    expect(findViewerAcceptedOfferHold([ownOffer], listingAggregateId, null)).toBeNull();
    expect(findViewerAcceptedOfferHold([ownOffer], listingAggregateId, undefined)).toBeNull();
  });

  it('ignores an accepted offer that does not hold this listing', () => {
    expect(findViewerAcceptedOfferHold([ownOffer], 'listing:other_item', sessionPubky)).toBeNull();
    expect(
      findViewerAcceptedOfferHold([{ ...ownOffer, award: { state: 'expired' } }], listingAggregateId, sessionPubky),
    ).toBeNull();
    expect(
      findViewerAcceptedOfferHold([{ ...ownOffer, state: 'pending' }], listingAggregateId, sessionPubky),
    ).toBeNull();
    expect(
      findViewerAcceptedOfferHold([{ ...ownOffer, award: undefined }], listingAggregateId, sessionPubky),
    ).toBeNull();
  });
});
