import { describe, expect, it } from 'vitest';
import type { MarketplaceNotification } from '@/services/marketplace/marketplace';
import {
  activityNeedingAttentionKeys,
  type AttentionOffer,
  isMarketplaceActionActivity,
  offerNeedsCurrentUser,
  orderNeedsCurrentUser,
  ordersNeedingAttentionKeys,
  readOrdersSeenAt,
  writeOrdersSeenAt,
} from './marketplace-attention';

const ME = 'm'.repeat(52);
const THEM = 't'.repeat(52);
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

type TestOrder = Parameters<typeof orderNeedsCurrentUser>[0];

function order(id: string, overrides: Partial<TestOrder> = {}): TestOrder {
  return {
    id,
    state: 'paid',
    nextActor: 'seller',
    buyerPubky: THEM,
    sellerPubky: ME,
    updatedAt: '2026-09-23T12:00:00.000Z',
    holdExpiresAt: null,
    ...overrides,
  };
}

function offer(id: string, overrides: Partial<AttentionOffer> = {}): AttentionOffer {
  return {
    id,
    buyerPubky: THEM,
    sellerPubky: ME,
    state: 'pending',
    offeredBy: THEM,
    expiresAt: '2026-09-30T00:00:00.000Z',
    award: null,
    ...overrides,
  };
}

function row(
  id: string,
  type: MarketplaceNotification['type'],
  aggregateId: string,
  createdAt = '2026-09-22T10:00:00.000Z',
) {
  return { id, type, aggregateId, createdAt, readAt: null };
}

describe('marketplace attention', () => {
  it('treats only rows that can ask something of the recipient as action types', () => {
    expect(isMarketplaceActionActivity('return_updated')).toBe(true);
    expect(isMarketplaceActionActivity('offer_received')).toBe(true);
    expect(isMarketplaceActionActivity('offer_accepted')).toBe(true);
    expect(isMarketplaceActionActivity('message_received')).toBe(true);
    expect(isMarketplaceActionActivity('pickup_ready')).toBe(true);
    expect(isMarketplaceActionActivity('order_created')).toBe(false);
    expect(isMarketplaceActionActivity('order_cancelled')).toBe(false);
    expect(isMarketplaceActionActivity('payment_confirmed')).toBe(false);
    expect(isMarketplaceActionActivity('order_shipped')).toBe(false);
  });

  it('keys orders that still need this identity and are newer than last seen', () => {
    const orders = [
      order('a'),
      order('b', { nextActor: 'buyer' }),
      order('c', { updatedAt: '2026-09-01T12:00:00.000Z' }),
      order('d', { state: 'cancelled', nextActor: 'none' }),
    ];
    expect(ordersNeedingAttentionKeys(orders, ME, 0, NOW)).toEqual(['order:a', 'order:c']);
    expect(ordersNeedingAttentionKeys(orders, ME, Date.parse('2026-09-20T00:00:00.000Z'), NOW)).toEqual(['order:a']);
  });

  it('does not ask anyone to pay a checkout whose hold already lapsed', () => {
    const lapsed = order('x', {
      state: 'pending_payment',
      nextActor: 'buyer',
      buyerPubky: ME,
      sellerPubky: THEM,
      holdExpiresAt: '2026-09-22T10:15:00.000Z',
    });
    expect(orderNeedsCurrentUser(lapsed, ME, NOW)).toBe(false);
    expect(orderNeedsCurrentUser({ ...lapsed, holdExpiresAt: '2026-09-24T12:10:00.000Z' }, ME, NOW)).toBe(true);
  });

  it('asks the party who did not make the latest offer amount, until it expires', () => {
    expect(offerNeedsCurrentUser(offer('o'), ME, NOW)).toBe(true);
    expect(offerNeedsCurrentUser(offer('o'), THEM, NOW)).toBe(false);
    expect(offerNeedsCurrentUser(offer('o', { state: 'countered', offeredBy: ME }), ME, NOW)).toBe(false);
    expect(offerNeedsCurrentUser(offer('o', { state: 'countered', offeredBy: ME }), THEM, NOW)).toBe(true);
    expect(offerNeedsCurrentUser(offer('o', { expiresAt: '2026-09-23T00:00:00.000Z' }), ME, NOW)).toBe(false);
    expect(offerNeedsCurrentUser(offer('o', { state: 'rejected' }), ME, NOW)).toBe(false);
    expect(offerNeedsCurrentUser(offer('o', { state: 'pending' }), 'x'.repeat(52), NOW)).toBe(false);
  });

  it('asks the buyer of an accepted offer while its award is open for checkout', () => {
    const accepted = offer('o', { state: 'accepted', award: { state: 'active' } });
    expect(offerNeedsCurrentUser(accepted, THEM, NOW)).toBe(true);
    expect(offerNeedsCurrentUser(accepted, ME, NOW)).toBe(false);
    expect(offerNeedsCurrentUser({ ...accepted, award: { state: 'converted' } }, THEM, NOW)).toBe(false);
  });

  it('never badges old informational rows such as a cancelled order or a started checkout', () => {
    const keys = activityNeedingAttentionKeys({
      notifications: [
        row('n1', 'order_created', 'order:a'),
        row('n2', 'order_cancelled', 'order:b'),
        row('n3', 'payment_confirmed', 'order:c'),
        row('n4', 'order_completed', 'order:d'),
      ],
      orders: [
        order('a', { state: 'pending_payment', nextActor: 'seller' }),
        order('b', { state: 'cancelled', nextActor: 'none' }),
        order('c'),
        order('d', { state: 'completed', nextActor: 'none' }),
      ],
      offers: [],
      currentUserPubky: ME,
      clearedBy: { kind: 'seen', seenAt: 0 },
      now: NOW,
    });
    expect(keys).toEqual([]);
  });

  it('badges an action row only while its order or offer still waits on this identity', () => {
    const keys = activityNeedingAttentionKeys({
      notifications: [
        row('r-open', 'return_updated', 'order:open'),
        row('r-done', 'return_updated', 'order:refunded'),
        row('r-missing', 'return_updated', 'order:not-loaded'),
        row('o-open', 'offer_received', 'offer:pending'),
        row('o-answered', 'offer_received', 'offer:rejected'),
        row('m', 'message_received', 'conversation:abc'),
      ],
      orders: [
        order('open', { state: 'return_requested', nextActor: 'seller' }),
        order('refunded', { state: 'refunded', nextActor: 'none' }),
      ],
      offers: [offer('pending'), offer('rejected', { state: 'rejected' })],
      currentUserPubky: ME,
      clearedBy: { kind: 'seen', seenAt: 0 },
      now: NOW,
    });
    expect(keys).toEqual(['order:open', 'offer:pending', 'notification:m']);
  });

  it('badges PayPal refund activity only when a restored payment hands the order back to this identity', () => {
    const keys = activityNeedingAttentionKeys({
      notifications: [
        row('refund-full', 'refund_recorded', 'order:refunded'),
        row('refund-partial', 'refund_recorded', 'order:partial'),
        row('reversal', 'refund_recorded', 'order:reversed'),
        row('restored-open', 'payment_reversal_cancelled', 'order:reopened'),
        row('restored-buyer', 'payment_reversal_cancelled', 'order:in-transit'),
        row('restored-done', 'payment_reversal_cancelled', 'order:closed-out'),
      ],
      orders: [
        order('refunded', { state: 'refunded_external', nextActor: 'none' }),
        order('partial', { state: 'shipped', nextActor: 'buyer' }),
        order('reversed', { state: 'refunded_external', nextActor: 'none' }),
        order('reopened', { state: 'paid', nextActor: 'seller' }),
        order('in-transit', { state: 'shipped', nextActor: 'buyer' }),
        order('closed-out', { state: 'completed', nextActor: 'none' }),
      ],
      offers: [],
      currentUserPubky: ME,
      clearedBy: { kind: 'seen', seenAt: 0 },
      now: NOW,
    });
    expect(keys).toEqual(['order:reopened']);
    expect(isMarketplaceActionActivity('refund_recorded')).toBe(false);
  });

  it('counts several rows about one subject once', () => {
    const keys = activityNeedingAttentionKeys({
      notifications: [
        row('r1', 'return_updated', 'order:open', '2026-09-22T10:00:00.000Z'),
        row('r2', 'return_updated', 'order:open', '2026-09-22T11:00:00.000Z'),
        row('o1', 'offer_received', 'offer:p'),
        row('o2', 'offer_countered', 'offer:p'),
      ],
      orders: [order('open', { state: 'return_requested' })],
      offers: [offer('p')],
      currentUserPubky: ME,
      clearedBy: { kind: 'seen', seenAt: 0 },
      now: NOW,
    });
    expect(keys).toEqual(['order:open', 'offer:p']);
  });

  it('leaves out rows created before the account last opened Activity, or already read in the sandbox', () => {
    const input = {
      notifications: [
        row('old', 'offer_received', 'offer:p1', '2026-09-20T00:00:00.000Z'),
        { ...row('new', 'offer_received', 'offer:p2', '2026-09-23T00:00:00.000Z'), readAt: '2026-09-23T01:00:00.000Z' },
      ],
      orders: [],
      offers: [offer('p1'), offer('p2')],
      currentUserPubky: ME,
      now: NOW,
    };
    expect(
      activityNeedingAttentionKeys({
        ...input,
        clearedBy: { kind: 'seen', seenAt: Date.parse('2026-09-21T00:00:00.000Z') },
      }),
    ).toEqual(['offer:p2']);
    expect(activityNeedingAttentionKeys({ ...input, clearedBy: { kind: 'read-state' } })).toEqual(['offer:p1']);
  });

  it('stores last-seen per identity and never moves it backward', () => {
    const storage = memoryStorage();
    expect(readOrdersSeenAt(ME, storage)).toBe(0);
    expect(writeOrdersSeenAt(ME, 100, storage)).toBe(true);
    expect(writeOrdersSeenAt(ME, 50, storage)).toBe(false);
    expect(readOrdersSeenAt(ME, storage)).toBe(100);
    expect(readOrdersSeenAt(THEM, storage)).toBe(0);
  });
});
