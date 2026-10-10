import { describe, expect, it } from 'vitest';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import {
  buyerCheckoutStateLabel,
  extractCheckoutOrderIds,
  formatRemainingHMmSs,
  formatRemainingMmSs,
  getMarketplaceCheckoutRoute,
  getMarketplaceDropCheckoutRoute,
  getMarketplaceOfferCheckoutRoute,
  intersectPaymentMethods,
  isAbandonedCheckout,
  isBuyerCheckoutInProgress,
  isBuyerOrderHistory,
  isSellerBoundBitcoinOrder,
  isSellerPaidOrder,
  isSellerReservation,
  isSellerSalesOrder,
  isSellerUsdtReviewOrder,
  readCheckoutHashOrderId,
  reservedWhileYouPayCopy,
  resolveCreatedCheckoutOrderIds,
  sellerReservationCopy,
  unlistedOrderStateLabel,
} from './checkout-phase';

const BUYER = 'b'.repeat(52);
const SELLER = 's'.repeat(52);

describe('checkout-phase', () => {
  it('names the state of an order no Orders section lists', () => {
    expect(unlistedOrderStateLabel({ state: 'cancelled', receiptId: null })).toBe('Cancelled before payment');
    expect(unlistedOrderStateLabel({ state: 'cancelled' })).toBe('Cancelled before payment');
    expect(unlistedOrderStateLabel({ state: 'cancelled', receiptId: 'receipt-1' })).toBe('Cancelled');
    expect(unlistedOrderStateLabel({ state: 'pending_payment' })).toBe('Awaiting payment');
    expect(unlistedOrderStateLabel({ state: 'return_requested' })).toBe('Return requested');
  });

  it('builds the checkout route without minting a second id', () => {
    expect(getMarketplaceCheckoutRoute()).toBe(MARKETPLACE_ROUTES.CHECKOUT);
    expect(getMarketplaceCheckoutRoute('018f47d2-6a27-7c23-a49d-000000000001')).toBe(
      `${MARKETPLACE_ROUTES.CHECKOUT}#018f47d2-6a27-7c23-a49d-000000000001`,
    );
    expect(getMarketplaceOfferCheckoutRoute('offer-1')).toBe(`${MARKETPLACE_ROUTES.CHECKOUT}?offer=offer-1`);
    expect(getMarketplaceDropCheckoutRoute({ sellerPubky: SELLER, dropId: 'vol1', listingId: 'boots' })).toBe(
      `${MARKETPLACE_ROUTES.CHECKOUT}?seller=${SELLER}&drop=vol1&listing=boots`,
    );
  });

  it('keeps unpaid buyer rows out of order history', () => {
    expect(isBuyerOrderHistory({ state: 'pending_payment', buyerPubky: BUYER, receiptId: null }, BUYER)).toBe(false);
    expect(
      isBuyerOrderHistory(
        { state: 'paid', buyerPubky: BUYER, receiptId: '018f47d2-6a27-7c23-a49d-000000000201' },
        BUYER,
      ),
    ).toBe(true);
    expect(isBuyerOrderHistory({ state: 'return_requested', buyerPubky: BUYER }, BUYER)).toBe(true);
    expect(isBuyerCheckoutInProgress({ state: 'pending_payment', buyerPubky: BUYER }, BUYER)).toBe(true);
  });

  it('classifies cancelled rows by receipt for buyer history, abandoned, and seller orders', () => {
    const receiptId = '018f47d2-6a27-7c23-a49d-000000000201';
    const unpaidCancel = { state: 'cancelled', buyerPubky: BUYER, sellerPubky: SELLER, receiptId: null };
    const paidCancel = { state: 'cancelled', buyerPubky: BUYER, sellerPubky: SELLER, receiptId };
    const paid = { state: 'paid', buyerPubky: BUYER, sellerPubky: SELLER, receiptId };
    const pending = { state: 'pending_payment', buyerPubky: BUYER, sellerPubky: SELLER, receiptId: null };

    expect(isAbandonedCheckout(unpaidCancel, BUYER)).toBe(true);
    expect(isBuyerOrderHistory(unpaidCancel, BUYER)).toBe(false);
    expect(isSellerPaidOrder(unpaidCancel, SELLER)).toBe(false);

    expect(isAbandonedCheckout(paidCancel, BUYER)).toBe(false);
    expect(isBuyerOrderHistory(paidCancel, BUYER)).toBe(true);
    expect(isSellerPaidOrder(paidCancel, SELLER)).toBe(true);

    expect(isAbandonedCheckout(paid, BUYER)).toBe(false);
    expect(isBuyerOrderHistory(paid, BUYER)).toBe(true);
    expect(isSellerPaidOrder(paid, SELLER)).toBe(true);

    expect(isAbandonedCheckout(pending, BUYER)).toBe(false);
    expect(isBuyerOrderHistory(pending, BUYER)).toBe(false);
    expect(isSellerPaidOrder(pending, SELLER)).toBe(false);
    expect(isBuyerCheckoutInProgress(pending, BUYER)).toBe(true);
  });

  it('classifies seller reservations as unpaid holds, not orders', () => {
    const unpaid = { state: 'pending_payment', sellerPubky: SELLER, buyerPubky: BUYER, receiptId: null };
    const paid = {
      state: 'paid',
      sellerPubky: SELLER,
      buyerPubky: BUYER,
      receiptId: '018f47d2-6a27-7c23-a49d-000000000201',
    };
    const returning = { state: 'return_requested', sellerPubky: SELLER, buyerPubky: BUYER };
    expect(isSellerReservation(unpaid, SELLER)).toBe(true);
    expect(isSellerPaidOrder(unpaid, SELLER)).toBe(false);
    expect(isSellerSalesOrder(unpaid, SELLER)).toBe(false);
    const boundBitcoin = { ...unpaid, paymentMethod: 'bitcoin' as const };
    expect(isSellerBoundBitcoinOrder(boundBitcoin)).toBe(true);
    expect(isSellerReservation(boundBitcoin, SELLER)).toBe(false);
    expect(isSellerSalesOrder(boundBitcoin, SELLER)).toBe(true);
    expect(isSellerReservation({ ...unpaid, paymentMethod: 'paypal' }, SELLER)).toBe(true);
    expect(isSellerSalesOrder({ ...unpaid, paymentMethod: 'paypal' }, SELLER)).toBe(false);
    expect(isSellerReservation(paid, SELLER)).toBe(false);
    expect(isSellerPaidOrder(paid, SELLER)).toBe(true);
    expect(isSellerPaidOrder(returning, SELLER)).toBe(true);
    expect(
      isSellerPaidOrder({ state: 'cancelled', sellerPubky: SELLER, buyerPubky: BUYER, receiptId: null }, SELLER),
    ).toBe(false);
  });

  it('lists a USDT payment in manual review as a sale to resolve, keyed on the order asset', () => {
    const usdt = {
      state: 'pending_payment',
      sellerPubky: SELLER,
      buyerPubky: BUYER,
      paymentMethod: 'usdt' as const,
      paymentAsset: 'USDT',
    };
    const review = { state: 'manual_review' };

    expect(isSellerUsdtReviewOrder(usdt, review)).toBe(true);
    expect(isSellerReservation(usdt, SELLER, review)).toBe(false);
    expect(isSellerSalesOrder(usdt, SELLER, review)).toBe(true);
    expect(isSellerUsdtReviewOrder({ ...usdt, paymentMethod: undefined }, review)).toBe(true);

    for (const payment of [{ state: 'awaiting_entitlement' }, { state: 'confirmed' }, null, undefined]) {
      expect(isSellerUsdtReviewOrder(usdt, payment)).toBe(false);
      expect(isSellerReservation(usdt, SELLER, payment)).toBe(true);
      expect(isSellerSalesOrder(usdt, SELLER, payment)).toBe(false);
    }
  });

  it('never moves a Bitcoin, PayPal or method-less order in review, nor a buyer view or a paid USDT order', () => {
    const unpaid = { state: 'pending_payment', sellerPubky: SELLER, buyerPubky: BUYER };
    const review = { state: 'manual_review' };

    expect(isSellerUsdtReviewOrder({ ...unpaid, paymentMethod: 'paypal' }, review)).toBe(false);
    expect(isSellerUsdtReviewOrder(unpaid, review)).toBe(false);
    expect(isSellerReservation({ ...unpaid, paymentMethod: 'paypal' }, SELLER, review)).toBe(true);
    expect(isSellerReservation(unpaid, SELLER, review)).toBe(true);
    expect(isSellerSalesOrder({ ...unpaid, paymentMethod: 'bitcoin' }, SELLER, review)).toBe(true);
    expect(isSellerUsdtReviewOrder({ ...unpaid, state: 'paid', paymentAsset: 'USDT' }, review)).toBe(false);
    expect(isSellerSalesOrder({ ...unpaid, paymentAsset: 'USDT' }, BUYER, review)).toBe(false);
    expect(isSellerReservation({ ...unpaid, paymentAsset: 'USDT' }, BUYER, review)).toBe(false);
  });

  it('labels unbound vs bound checkout without the word order', () => {
    expect(buyerCheckoutStateLabel({ paymentMethod: null })).toBe('Checkout in progress');
    expect(buyerCheckoutStateLabel({ paymentMethod: 'paypal' })).toBe('Awaiting payment · Item reserved');
    expect(reservedWhileYouPayCopy('2099-01-01T00:00:00.000Z', Date.parse('2098-12-31T23:50:19.000Z'))).toBe(
      'Awaiting payment · Item reserved · 9:41',
    );
    expect(formatRemainingMmSs(null)).toBeNull();
    expect(formatRemainingMmSs('2026-09-28T11:59:59.000Z', Date.parse('2026-09-28T11:00:00.000Z'))).toBe('59:59');
    expect(formatRemainingMmSs('2026-09-28T12:00:00.000Z', Date.parse('2026-09-28T11:00:00.000Z'))).toBe('1:00:00');
    expect(formatRemainingMmSs('2026-09-29T10:53:06.000Z', Date.parse('2026-09-28T11:00:00.000Z'))).toBe('23:53:06');
    expect(formatRemainingHMmSs(null)).toBeNull();
    expect(formatRemainingHMmSs('2026-09-28T11:00:01.000Z', Date.parse('2026-09-28T11:00:00.000Z'))).toBe('0:00:01');
    expect(formatRemainingHMmSs('2026-09-28T11:59:59.000Z', Date.parse('2026-09-28T11:00:00.000Z'))).toBe('0:59:59');
    expect(formatRemainingHMmSs('2026-09-28T12:00:00.000Z', Date.parse('2026-09-28T11:00:00.000Z'))).toBe('1:00:00');
    expect(formatRemainingHMmSs('2026-09-29T10:53:06.000Z', Date.parse('2026-09-28T11:00:00.000Z'))).toBe('23:53:06');
    expect(formatRemainingHMmSs('2026-09-28T10:00:00.000Z', Date.parse('2026-09-28T11:00:00.000Z'))).toBe('0:00:00');
    expect(sellerReservationCopy('2026-10-02T09:10:00.000Z')).toBe(
      'Held for a buyer · restocks Oct 2, 2026, 9:10 AM UTC',
    );
    expect(sellerReservationCopy(null)).toBe('Held for a buyer.');
    expect(sellerReservationCopy('not a date')).toBe('Held for a buyer.');
  });

  it('reads order ids from the checkout command passthrough', () => {
    expect(extractCheckoutOrderIds({ kind: 'checkout' })).toEqual([]);
    expect(
      extractCheckoutOrderIds({
        kind: 'checkout',
        orders: [{ id: '018f47d2-6a27-7c23-a49d-000000000001' }, { id: '018f47d2-6a27-7c23-a49d-000000000002' }],
      }),
    ).toEqual(['018f47d2-6a27-7c23-a49d-000000000001', '018f47d2-6a27-7c23-a49d-000000000002']);
  });

  it('intersects seller rails and falls back to participant orders when create omits ids', () => {
    expect(
      intersectPaymentMethods([
        ['bitcoin', 'paypal'],
        ['paypal', 'stripe'],
      ]),
    ).toEqual(['paypal']);
    expect(intersectPaymentMethods([['bitcoin'], ['stripe']])).toEqual([]);
    expect(
      intersectPaymentMethods([
        ['paypal', 'usdt', 'bitcoin'],
        ['bitcoin', 'usdt'],
      ]),
    ).toEqual(['bitcoin', 'usdt']);
    expect(intersectPaymentMethods([['bitcoin', 'usdt'], ['bitcoin']])).toEqual(['bitcoin']);
    expect(
      intersectPaymentMethods([
        ['bitcoin', 'stripe', 'paypal'],
        ['bitcoin', 'stripe', 'paypal'],
      ]),
    ).toEqual(['bitcoin', 'paypal']);
    expect(readCheckoutHashOrderId('#018f47d2-6a27-7c23-a49d-000000000001')).toBe(
      '018f47d2-6a27-7c23-a49d-000000000001',
    );
    expect(
      resolveCreatedCheckoutOrderIds({
        result: { kind: 'checkout' },
        listingAggregateIds: ['listing:a'],
        buyerPubky: BUYER,
        orders: [
          {
            id: '018f47d2-6a27-7c23-a49d-000000000009',
            state: 'pending_payment',
            buyerPubky: BUYER,
            lines: [{ listingAggregateId: 'listing:a' }],
          },
        ],
      }),
    ).toEqual(['018f47d2-6a27-7c23-a49d-000000000009']);
  });
});
