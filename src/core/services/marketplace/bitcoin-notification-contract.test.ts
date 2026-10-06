import { describe, expect, it } from 'vitest';
import { activityRowHref } from '@/libs/commerce/activity-links';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import {
  BITCOIN_REVIEW_REASON_COPY,
  bitcoinNotificationCopy,
  MARKETPLACE_ACTIVITY_LABELS,
} from './marketplace-activity-copy';
import { isRecognizedMarketplaceNotification, parseMarketplaceNotificationEntries } from './marketplace-projections';

const SELLER = 's'.repeat(52);
const ORDER_ID = '018f47d2-6a27-7c23-a62f-0000000000c1';

/**
 * `GET /v1/notifications` rows in the `NotificationRow::view` shape from
 * pubky-marketplace-service `f79d52011dc50bfc6afa0f2c3c990ff8c2a6e85f`.
 * The contract samples do not carry this read; the view is the wire.
 */
function notificationView(idTail: string, type: string, reviewReason: string | null) {
  return {
    id: `018f47d2-6a27-7c23-a62f-${idTail}`,
    recipient_pubky: SELLER,
    actor_pubky: 'system',
    type,
    aggregate_id: `order:${ORDER_ID}`,
    amount: null,
    created_at: '2026-09-28T10:56:41.000Z',
    read_at: null,
    order_fulfillment: 'shipping',
    review_reason: reviewReason,
  };
}

const REVIEW_SENTENCES = {
  late_settlement: 'A Bitcoin payment settled late and needs your decision',
  amount_mismatch: 'A Bitcoin payment amount does not match the invoice',
  confirmation_failed: 'A confirmed Bitcoin payment could not be applied to this order',
  seller_confirmation_window_elapsed: 'The confirmation window ended before you confirmed this payment',
  seller_response_overdue: 'This Bitcoin payment has waited two business days for your decision',
} as const;

describe('seller Bitcoin notification contract', () => {
  it('recognizes payment-seen and every review reason, and links each row to the order', () => {
    const rows = [
      notificationView('0000000000b1', 'bitcoin_payment_seen', null),
      ...Object.keys(REVIEW_SENTENCES).map((reason, index) =>
        notificationView(`0000000000b${index + 2}`, 'bitcoin_manual_review', reason),
      ),
      notificationView('0000000000b9', 'future_bitcoin_notice', null),
    ];

    const entries = parseMarketplaceNotificationEntries(toCamelCaseWire({ notifications: rows }));
    const recognized = entries.filter(isRecognizedMarketplaceNotification);
    const quarantined = entries.filter((entry) => !isRecognizedMarketplaceNotification(entry));

    expect(quarantined).toEqual([expect.objectContaining({ kind: 'unrecognized', type: 'future_bitcoin_notice' })]);
    expect(recognized.map((entry) => entry.type)).toEqual([
      'bitcoin_payment_seen',
      'bitcoin_manual_review',
      'bitcoin_manual_review',
      'bitcoin_manual_review',
      'bitcoin_manual_review',
      'bitcoin_manual_review',
    ]);

    const seen = recognized[0];
    expect(seen?.reviewReason ?? null).toBeNull();
    expect(bitcoinNotificationCopy(seen!)?.label).toBe('A Bitcoin payment is waiting for your confirmation');
    expect(activityRowHref(seen!.type, seen!.aggregateId)).toBe(`/marketplace/orders#order-${ORDER_ID}`);

    for (const entry of recognized.slice(1)) {
      const reason = entry.reviewReason;
      expect(reason).toBeTruthy();
      expect(BITCOIN_REVIEW_REASON_COPY[reason!].label).toBe(REVIEW_SENTENCES[reason!]);
      expect(bitcoinNotificationCopy(entry)?.label).toBe(REVIEW_SENTENCES[reason!]);
      expect(activityRowHref(entry.type, entry.aggregateId)).toBe(`/marketplace/orders#order-${ORDER_ID}`);
    }
  });

  it('keeps a known Bitcoin row when the review reason is not in the vocabulary', () => {
    const [entry] = parseMarketplaceNotificationEntries(
      toCamelCaseWire({
        notifications: [notificationView('0000000000ba', 'bitcoin_manual_review', 'refund_required')],
      }),
    );

    expect(entry && isRecognizedMarketplaceNotification(entry)).toBe(true);
    if (!entry || !isRecognizedMarketplaceNotification(entry)) return;
    expect(entry.reviewReason ?? null).toBeNull();
    expect(bitcoinNotificationCopy(entry)).toBeNull();
    expect(MARKETPLACE_ACTIVITY_LABELS[entry.type]).toBe('Bitcoin payment needs a decision');
    expect(activityRowHref(entry.type, entry.aggregateId)).toBe(`/marketplace/orders#order-${ORDER_ID}`);
  });

  it('quarantines seller_response_overdue when it arrives as a type instead of a review reason', () => {
    const [entry] = parseMarketplaceNotificationEntries(
      toCamelCaseWire({
        notifications: [notificationView('0000000000bb', 'seller_response_overdue', null)],
      }),
    );

    expect(entry).toMatchObject({ kind: 'unrecognized', type: 'seller_response_overdue' });
  });
});
