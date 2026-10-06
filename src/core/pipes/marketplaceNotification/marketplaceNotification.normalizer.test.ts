import { describe, expect, it } from 'vitest';
import { getMarketplaceListingRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import type { MarketplaceNotification } from '@/services/marketplace/marketplace';
import { MARKETPLACE_NOTIFICATION_TYPE_MAX_LENGTH } from '@/services/marketplace/marketplace-projections';
import { createNotificationFixture, NOTIFICATION_TYPES } from '@/test/fixtures/commerce/notifications';
import { asInvalid } from '@/test-utils/type-assertions';
import { MarketplaceNotificationNormalizer } from './marketplaceNotification.normalizer';
import { MARKETPLACE_FEED_NOTIFICATION_KEYS } from './marketplaceNotification.types';

const SELLER = 's'.repeat(52);

describe('MarketplaceNotificationNormalizer.toFeedNotification', () => {
  it('maps the projection onto the redacted feed shape', () => {
    const notification = createNotificationFixture('offer_received', {
      createdAt: '2026-08-19T12:00:00.000Z',
      readAt: null,
    });

    const item = MarketplaceNotificationNormalizer.toFeedNotification(notification, 'sandbox');

    expect(item).toEqual({
      id: `marketplace:${notification.id}`,
      source: 'marketplace',
      type: 'offer_received',
      actorPubky: notification.actorPubky,
      aggregateId: notification.aggregateId,
      timestamp: Date.parse('2026-08-19T12:00:00.000Z'),
      isUnread: true,
      href: MARKETPLACE_ROUTES.OFFERS,
    });
  });

  it('drops every field beyond the redacted set, even ones smuggled through the passthrough schema', () => {
    // The projection schema is passthrough, so a backend could attach more.
    // ADR-0019 §8 bars order/payment detail, delivery info, message bodies,
    // evidence, and bearer material from notification payloads — the feed
    // shape must not let any of it survive into the shared surface.
    const smuggled = {
      ...createNotificationFixture('order_shipped'),
      deliveryAddress: { line1: '1 Secret Lane' },
      paymentAddress: 'bc1qsecret',
      messageBody: 'private message text',
      bundleId: 'bearer-bundle',
    } as MarketplaceNotification;

    const item = MarketplaceNotificationNormalizer.toFeedNotification(smuggled, 'sandbox');

    // Every emitted key must be in the allowed set (`amount` is optional and
    // only present when the projection carried the §8-permitted context).
    for (const key of Object.keys(item)) {
      expect(MARKETPLACE_FEED_NOTIFICATION_KEYS).toContain(key);
    }
    const serialized = JSON.stringify(item);
    for (const leaked of ['1 Secret Lane', 'bc1qsecret', 'private message text', 'bearer-bundle']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('says how a digital order was delivered, and nothing on any other notification', () => {
    const delivered = (overrides: Partial<MarketplaceNotification>) =>
      MarketplaceNotificationNormalizer.toFeedNotification(
        { ...createNotificationFixture('order_delivered'), ...overrides } as MarketplaceNotification,
        'transaction-service',
      );
    const buyer = createNotificationFixture('order_delivered').recipientPubky;

    expect(delivered({ orderFulfillment: 'digital', actorPubky: 'system' })).toMatchObject({
      digitalDelivery: 'automatic',
    });
    expect(delivered({ orderFulfillment: 'digital', actorPubky: 'paypal-ipn' })).toMatchObject({
      digitalDelivery: 'automatic',
    });
    expect(delivered({ orderFulfillment: 'digital', actorPubky: buyer })).toMatchObject({
      digitalDelivery: 'automatic',
    });
    expect(delivered({ orderFulfillment: 'digital', actorPubky: SELLER })).toMatchObject({
      digitalDelivery: 'manual',
    });
    for (const orderFulfillment of ['shipping', 'pickup', null, undefined]) {
      expect(delivered({ orderFulfillment, actorPubky: SELLER })).not.toHaveProperty('digitalDelivery');
    }
    const shipped = MarketplaceNotificationNormalizer.toFeedNotification(
      { ...createNotificationFixture('order_shipped'), orderFulfillment: 'digital' } as MarketplaceNotification,
      'transaction-service',
    );
    expect(shipped).not.toHaveProperty('digitalDelivery');
  });

  it('treats a sandbox row with null readAt as unread and a read row as read', () => {
    const unread = createNotificationFixture('outbid', { readAt: null });
    const read = createNotificationFixture('outbid', { readAt: '2026-08-19T18:00:00.000Z' });

    expect(MarketplaceNotificationNormalizer.toFeedNotification(unread, 'sandbox').isUnread).toBe(true);
    expect(MarketplaceNotificationNormalizer.toFeedNotification(read, 'sandbox').isUnread).toBe(false);
  });

  it('never marks a durable-service row unread: the service stores no read state to clear', () => {
    const row = createNotificationFixture('outbid', { readAt: null });

    expect(MarketplaceNotificationNormalizer.toFeedNotification(row, 'transaction-service').isUnread).toBe(false);
  });

  it('keeps quarantined rows with the same type and timestamp uniquely keyed', () => {
    const first = MarketplaceNotificationNormalizer.toFeedNotification(
      { kind: 'unrecognized', id: 'row-1', index: 0, type: 'future_event', createdAt: '1970-01-01T00:00:00.000Z' },
      'transaction-service',
    );
    const second = MarketplaceNotificationNormalizer.toFeedNotification(
      { kind: 'unrecognized', id: 'row-2', index: 1, type: 'future_event', createdAt: '1970-01-01T00:00:00.000Z' },
      'transaction-service',
    );

    expect(first.id).not.toBe(second.id);
  });

  it('bounds the raw quarantine id and appends the row index', () => {
    const item = MarketplaceNotificationNormalizer.toFeedNotification(
      {
        kind: 'unrecognized',
        id: 'r'.repeat(1_024),
        index: 7,
        type: 'future_event',
        createdAt: '1970-01-01T00:00:00.000Z',
      },
      'transaction-service',
    );

    expect(item.id).toBe(
      `marketplace:unrecognized:future_event:1970-01-01T00:00:00.000Z:${'r'.repeat(
        MARKETPLACE_NOTIFICATION_TYPE_MAX_LENGTH,
      )}:7`,
    );
  });

  it('carries the §8-permitted amount field-by-field and omits it when absent', () => {
    const withAmount = createNotificationFixture('auction_ended', {
      amount: { amountMinor: 8_500, currency: 'USD', exponent: 2 },
    });
    const carried = MarketplaceNotificationNormalizer.toFeedNotification(withAmount, 'transaction-service');
    expect('amount' in carried ? carried.amount : undefined).toEqual({
      amountMinor: 8_500,
      currency: 'USD',
      exponent: 2,
    });

    // Old service rows deliver amount: null; sandbox rows have no field at
    // all — neither may materialize an `amount` key on the feed shape.
    const nullAmount = createNotificationFixture('auction_ended', { amount: null });
    expect('amount' in MarketplaceNotificationNormalizer.toFeedNotification(nullAmount, 'transaction-service')).toBe(
      false,
    );
    const absent = createNotificationFixture('auction_ended');
    expect('amount' in MarketplaceNotificationNormalizer.toFeedNotification(absent, 'sandbox')).toBe(false);
  });

  it('copies a known Bitcoin review reason and drops any other string', () => {
    const known = createNotificationFixture('bitcoin_manual_review', {
      reviewReason: 'seller_response_overdue',
      actorPubky: 'system',
    });
    const copied = MarketplaceNotificationNormalizer.toFeedNotification(known, 'transaction-service');
    expect('reviewReason' in copied ? copied.reviewReason : undefined).toBe('seller_response_overdue');

    const unknown = asInvalid<MarketplaceNotification>({
      ...createNotificationFixture('bitcoin_manual_review', { actorPubky: 'system' }),
      reviewReason: 'refund_required',
    });
    const dropped = MarketplaceNotificationNormalizer.toFeedNotification(unknown, 'transaction-service');
    expect('reviewReason' in dropped).toBe(false);
    for (const key of Object.keys(dropped)) {
      expect(MARKETPLACE_FEED_NOTIFICATION_KEYS).toContain(key);
    }
  });

  it('includes kind in the exact redacted key set for quarantined rows', () => {
    const item = MarketplaceNotificationNormalizer.toFeedNotification(
      { kind: 'unrecognized', id: 'row-1', index: 0, type: 'future_event', createdAt: '1970-01-01T00:00:00.000Z' },
      'transaction-service',
    );

    expect(MARKETPLACE_FEED_NOTIFICATION_KEYS).toContain('kind');
    for (const key of Object.keys(item)) {
      expect(MARKETPLACE_FEED_NOTIFICATION_KEYS).toContain(key);
    }
  });
});

describe('MarketplaceNotificationNormalizer.toDeepLink', () => {
  const expectedRoutes: Record<MarketplaceNotification['type'], string> = {
    message_received: MARKETPLACE_ROUTES.MESSAGES,
    offer_received: MARKETPLACE_ROUTES.OFFERS,
    offer_countered: MARKETPLACE_ROUTES.OFFERS,
    offer_accepted: MARKETPLACE_ROUTES.OFFERS,
    offer_rejected: MARKETPLACE_ROUTES.OFFERS,
    outbid: getMarketplaceListingRoute(SELLER, 'boots_01'),
    auction_won: getMarketplaceListingRoute(SELLER, 'boots_01'),
    auction_ended: getMarketplaceListingRoute(SELLER, 'boots_01'),
    order_created: MARKETPLACE_ROUTES.CHECKOUT,
    payment_method_bound: MARKETPLACE_ROUTES.ORDERS,
    fiat_payment_reported: MARKETPLACE_ROUTES.ORDERS,
    payment_confirmed: MARKETPLACE_ROUTES.ORDERS,
    bitcoin_manual_review: MARKETPLACE_ROUTES.ORDERS,
    bitcoin_payment_seen: MARKETPLACE_ROUTES.ORDERS,
    bitcoin_prepare_voided: MARKETPLACE_ROUTES.ORDERS,
    order_cancelled: MARKETPLACE_ROUTES.ORDERS,
    order_cancelled_terms_change: MARKETPLACE_ROUTES.ORDERS,
    order_shipped: MARKETPLACE_ROUTES.ORDERS,
    order_delivery_assumed: MARKETPLACE_ROUTES.ORDERS,
    order_delivered: MARKETPLACE_ROUTES.ORDERS,
    order_completed: MARKETPLACE_ROUTES.ORDERS,
    return_updated: MARKETPLACE_ROUTES.ORDERS,
    refund_recorded: MARKETPLACE_ROUTES.ORDERS,
    review_received: MARKETPLACE_ROUTES.ORDERS,
    pickup_details_updated: MARKETPLACE_ROUTES.ORDERS,
    pickup_details_cleared: MARKETPLACE_ROUTES.ORDERS,
    pickup_ready: MARKETPLACE_ROUTES.ORDERS,
    payment_refund_required: MARKETPLACE_ROUTES.ORDERS,
    drop_sold_out: MARKETPLACE_ROUTES.SELL_DROPS,
    payment_reversal_cancelled: MARKETPLACE_ROUTES.ORDERS,
  };

  it.each(NOTIFICATION_TYPES)('routes %s to its marketplace surface', (type) => {
    const aggregateId =
      type === 'outbid' || type === 'auction_won' || type === 'auction_ended'
        ? `listing:${SELLER}_boots_01`
        : type === 'message_received'
          ? `conversation:${SELLER}_${'b'.repeat(52)}_boots_01`
          : type.startsWith('offer')
            ? 'offer:018f47d2-6a27-7c23-c62f-000000000001'
            : 'order:018f47d2-6a27-7c23-c62f-000000000002';

    expect(MarketplaceNotificationNormalizer.toDeepLink(type, aggregateId)).toBe(expectedRoutes[type]);
    if (type === 'message_received') {
      expect(MarketplaceNotificationNormalizer.toDeepLink(type, aggregateId)).toBe(MARKETPLACE_ROUTES.MESSAGES);
      expect(MarketplaceNotificationNormalizer.toDeepLink(type, aggregateId)).not.toContain('conversation=');
    }
  });

  it.each(['order:018f47d2-6a27-7c23-c62f-000000000002', 'listing:', 'listing:_x', 'listing:noseparator'])(
    'falls back to the catalog for auction activity when the aggregate reference is not a listing id (%s)',
    (aggregateId) => {
      expect(MarketplaceNotificationNormalizer.toDeepLink('outbid', aggregateId)).toBe('/marketplace');
    },
  );
});
