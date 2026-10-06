import { describe, expect, it } from 'vitest';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { activityRowHref, readOrderAnchorId } from './activity-links';

const SELLER = 's'.repeat(52);
const BUYER = 'b'.repeat(52);
const CONVERSATION = `conversation:${SELLER}_${BUYER}_listing-1`;
const ORDER = '018f47d2-6a27-7c23-a62f-000000000001';

describe('activityRowHref', () => {
  it('anchors an order event on that order', () => {
    expect(activityRowHref('return_updated', `order:${ORDER}`)).toBe(`${MARKETPLACE_ROUTES.ORDERS}#order-${ORDER}`);
    expect(activityRowHref('review_received', `order:${ORDER}`)).toBe(`${MARKETPLACE_ROUTES.ORDERS}#order-${ORDER}`);
  });

  it('anchors an offer and opens a message thread', () => {
    expect(activityRowHref('offer_received', 'offer:offer-1')).toBe(`${MARKETPLACE_ROUTES.OFFERS}#offer-offer-1`);
    expect(activityRowHref('message_received', CONVERSATION)).toBe(
      `${MARKETPLACE_ROUTES.MESSAGES}?conversation=${encodeURIComponent(CONVERSATION)}`,
    );
  });

  it('sends an auction row to the listing', () => {
    const href = activityRowHref('outbid', `listing:${SELLER}_boots`);
    expect(href).toContain(SELLER);
    expect(href).toContain('boots');
  });

  it('opens checkout started on the order, and on checkout only while that order can still be checked out', () => {
    expect(activityRowHref('order_created', `order:${ORDER}`)).toBe(`${MARKETPLACE_ROUTES.ORDERS}#order-${ORDER}`);
    expect(activityRowHref('order_created', `order:${ORDER}`, { canCheckout: false })).toBe(
      `${MARKETPLACE_ROUTES.ORDERS}#order-${ORDER}`,
    );
    expect(activityRowHref('order_created', `order:${ORDER}`, { canCheckout: true })).toBe(
      `${MARKETPLACE_ROUTES.CHECKOUT}#${ORDER}`,
    );
    expect(activityRowHref('order_created', null, { canCheckout: true })).toBe(MARKETPLACE_ROUTES.ORDERS);
  });
});

describe('readOrderAnchorId', () => {
  it('reads only an order anchor', () => {
    expect(readOrderAnchorId(`#order-${ORDER}`)).toBe(ORDER);
    expect(readOrderAnchorId(`#${ORDER}`)).toBeNull();
  });
});
