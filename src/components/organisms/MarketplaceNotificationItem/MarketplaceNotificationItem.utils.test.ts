import { describe, expect, it } from 'vitest';
import { getMarketplaceNotificationActionText } from './MarketplaceNotificationItem.utils';

describe('getMarketplaceNotificationActionText', () => {
  it('renders the mechanical base text when the payload carries no amount', () => {
    expect(getMarketplaceNotificationActionText({ type: 'auction_ended' })).toBe('ended an auction');
    expect(getMarketplaceNotificationActionText({ type: 'outbid' })).toBe('outbid you in an auction');
    expect(getMarketplaceNotificationActionText({ type: 'offer_received' })).toBe('sent you an offer');
    expect(getMarketplaceNotificationActionText({ type: 'payment_confirmed' })).toBe('confirmed payment for an order');
    expect(getMarketplaceNotificationActionText({ type: 'order_delivery_assumed' })).toBe(
      'marked an order delivered automatically',
    );
    expect(getMarketplaceNotificationActionText({ type: 'order_completed' })).toBe('completed an order');
  });

  it('uses role-neutral payment copy for buyer and seller actors', () => {
    const actionText = getMarketplaceNotificationActionText({ type: 'payment_confirmed' });

    expect(`Buyer ${actionText}`).toBe('Buyer confirmed payment for an order');
    expect(`Seller ${actionText}`).toBe('Seller confirmed payment for an order');
    expect(actionText).not.toContain('receipt');
    expect(actionText).not.toContain('paid for');
  });

  it('renders the local pickup copy (Wave 7, §A3/§A6)', () => {
    // pickup_details_updated / pickup_ready are their own types; a handover
    // confirm emits fulfillment.delivered (the order_delivered type, shared
    // with shipped orders by contract); the unilateral buyer-protection exit
    // notifies as order_cancelled_terms_change — distinct from the ordinary
    // order_cancelled, with copy that names the buyer protection (§A3).
    expect(getMarketplaceNotificationActionText({ type: 'pickup_details_updated' })).toBe('updated the pickup details');
    expect(getMarketplaceNotificationActionText({ type: 'pickup_details_cleared' })).toBe('removed the pickup details');
    expect(getMarketplaceNotificationActionText({ type: 'pickup_ready' })).toBe('marked your order ready for pickup');
    expect(getMarketplaceNotificationActionText({ type: 'payment_refund_required' })).toBe(
      'requires a refund for a late payment',
    );
    expect(getMarketplaceNotificationActionText({ type: 'order_delivered' })).toBe('confirmed delivery of an order');
    expect(getMarketplaceNotificationActionText({ type: 'order_cancelled' })).toBe('updated an order cancellation');
    expect(getMarketplaceNotificationActionText({ type: 'order_cancelled_terms_change' })).toBe(
      'cancelled because the seller changed the pickup terms',
    );
  });

  it('words a digital delivery as a purchase to download, never as a parcel', () => {
    expect(getMarketplaceNotificationActionText({ type: 'order_delivered', digitalDelivery: 'automatic' })).toBe(
      'confirmed your payment. Your purchase is ready to download',
    );
    expect(
      `PayPal ${getMarketplaceNotificationActionText({ type: 'order_delivered', digitalDelivery: 'automatic' })}`,
    ).toBe('PayPal confirmed your payment. Your purchase is ready to download');
    expect(getMarketplaceNotificationActionText({ type: 'order_delivered', digitalDelivery: 'manual' })).toBe(
      'delivered your purchase',
    );
    expect(getMarketplaceNotificationActionText({ type: 'order_delivered' })).toBe('confirmed delivery of an order');
  });

  it('states each Bitcoin review reason after the system actor', () => {
    expect(getMarketplaceNotificationActionText({ type: 'bitcoin_payment_seen' })).toBe(
      'saw a Bitcoin payment waiting for your confirmation',
    );
    expect(
      getMarketplaceNotificationActionText({ type: 'bitcoin_manual_review', reviewReason: 'late_settlement' }),
    ).toBe('flagged a late Bitcoin payment for your decision');
    expect(
      getMarketplaceNotificationActionText({ type: 'bitcoin_manual_review', reviewReason: 'seller_response_overdue' }),
    ).toBe('flagged a Bitcoin payment that has waited two business days');
    expect(getMarketplaceNotificationActionText({ type: 'bitcoin_manual_review' })).toBe(
      'flagged a bitcoin payment for a decision',
    );
    expect(
      getMarketplaceNotificationActionText({ type: 'bitcoin_manual_review', reviewReason: 'refund_required' }),
    ).toBe('flagged a bitcoin payment for a decision');
  });

  it('renders the PayPal refund and reversal copy after the PayPal actor', () => {
    expect(getMarketplaceNotificationActionText({ type: 'refund_recorded' })).toBe('recorded a refund');
    expect(getMarketplaceNotificationActionText({ type: 'payment_reversal_cancelled' })).toBe(
      'restored a disputed payment',
    );
  });

  it('words the USDT refund-address confirmation as recorded by the buyer, never as verified', () => {
    const text = getMarketplaceNotificationActionText({ type: 'refund_destination_confirmed' });
    expect(text).toBe('confirmed a USDT refund address for an order');
    expect(text).not.toMatch(/verified|received|sent/i);
  });

  it('appends the §8-permitted amount to auction and offer copy', () => {
    const usd = { amountMinor: 8_500, currency: 'USD', exponent: 2 };
    expect(getMarketplaceNotificationActionText({ type: 'auction_ended', amount: usd })).toBe(
      'ended an auction at $85.00',
    );
    expect(getMarketplaceNotificationActionText({ type: 'auction_won', amount: usd })).toBe(
      'closed an auction you won at $85.00',
    );
    expect(getMarketplaceNotificationActionText({ type: 'outbid', amount: usd })).toBe(
      'outbid you in an auction — now at $85.00',
    );
    expect(getMarketplaceNotificationActionText({ type: 'offer_received', amount: usd })).toBe(
      'sent you an offer of $85.00',
    );
    expect(getMarketplaceNotificationActionText({ type: 'offer_countered', amount: usd })).toBe(
      'countered an offer at $85.00',
    );
    expect(getMarketplaceNotificationActionText({ type: 'offer_accepted', amount: usd })).toBe(
      'accepted an offer of $85.00',
    );
    expect(getMarketplaceNotificationActionText({ type: 'offer_rejected', amount: usd })).toBe(
      'declined an offer of $85.00',
    );
  });

  it('renders bitcoin amounts per BIP-177: ₿ with grouped base units, never "sats"', () => {
    const text = getMarketplaceNotificationActionText({
      type: 'offer_received',
      amount: { amountMinor: 15_000, currency: 'BTC', exponent: 8 },
    });
    expect(text).toBe('sent you an offer of ₿15,000');
    expect(text).not.toContain('sats');
    expect(
      getMarketplaceNotificationActionText({
        type: 'offer_received',
        amount: { amountMinor: 1_303, currency: 'SAT', exponent: 0 },
      }),
    ).toBe('sent you an offer of ₿1,303');
    expect(
      getMarketplaceNotificationActionText({
        type: 'refund_recorded',
        amount: { amountMinor: 1_303, currency: 'SAT', exponent: 0 },
      }),
    ).toBe('recorded a refund');
  });

  it('falls back to the base text for types that never carry amounts', () => {
    expect(
      getMarketplaceNotificationActionText({
        type: 'order_created',
        amount: { amountMinor: 100, currency: 'USD', exponent: 2 },
      }),
    ).toBe('started checkout');
  });
});
