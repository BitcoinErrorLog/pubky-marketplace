import type { MarketplaceNotification, MarketplaceNotificationPreferences } from '@/services/marketplace/marketplace';

export const NOTIFICATION_FIXTURE_RECIPIENT = 'b'.repeat(52);
export const NOTIFICATION_FIXTURE_ACTOR = 's'.repeat(52);

/**
 * Keyed record instead of a plain array so adding a type to the notification
 * schema union fails compilation here (missing key) instead of leaving the new
 * type silently untested. The value marks whether the fixture is unread, so
 * the sweep also renders both read and unread rows.
 */
const NOTIFICATION_TYPE_UNREAD = {
  message_received: true,
  offer_received: true,
  offer_countered: false,
  offer_accepted: true,
  offer_rejected: false,
  outbid: true,
  auction_won: false,
  auction_ended: true,
  order_created: false,
  payment_method_bound: false,
  fiat_payment_reported: false,
  payment_confirmed: true,
  bitcoin_manual_review: false,
  bitcoin_payment_seen: true,
  bitcoin_prepare_voided: false,
  order_cancelled: false,
  order_cancelled_terms_change: true,
  order_shipped: true,
  order_delivery_assumed: true,
  order_delivered: false,
  order_completed: false,
  return_updated: true,
  refund_recorded: false,
  refund_destination_confirmed: true,
  review_received: false,
  pickup_details_updated: true,
  pickup_details_cleared: false,
  pickup_ready: true,
  payment_refund_required: true,
  drop_sold_out: false,
  payment_reversal_cancelled: true,
} as const satisfies Record<MarketplaceNotification['type'], boolean>;

/** Every notification type the marketplace notification schema defines. */
export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_TYPE_UNREAD) as readonly MarketplaceNotification['type'][];

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  // The variant nibble must be 8–b for `z.uuid()` to accept the id.
  return `018f47d2-6a27-7c23-a62f-${hex}`;
}

export function createNotificationFixture(
  type: MarketplaceNotification['type'],
  overrides: Partial<MarketplaceNotification> = {},
): MarketplaceNotification {
  const typeIndex = NOTIFICATION_TYPES.indexOf(type) + 1;
  return {
    id: uuid(typeIndex),
    revision: typeIndex,
    recipientPubky: NOTIFICATION_FIXTURE_RECIPIENT,
    actorPubky: NOTIFICATION_FIXTURE_ACTOR,
    type,
    aggregateId: `notification:${uuid(100 + typeIndex)}`,
    createdAt: '2026-08-19T12:00:00.000Z',
    readAt: NOTIFICATION_TYPE_UNREAD[type] ? null : '2026-08-19T18:00:00.000Z',
    ...overrides,
  };
}

/** One notification per schema type, mixing read and unread rows. */
export function createNotificationsForEveryType(): MarketplaceNotification[] {
  return NOTIFICATION_TYPES.map((type) => createNotificationFixture(type));
}

export function createNotificationPreferencesFixture(
  overrides: Partial<MarketplaceNotificationPreferences> = {},
): MarketplaceNotificationPreferences {
  return {
    ownerPubky: NOTIFICATION_FIXTURE_RECIPIENT,
    revision: 2,
    messages: true,
    offers: true,
    bids: true,
    auctions: true,
    updatedAt: '2026-08-19T12:00:00.000Z',
    ...overrides,
  };
}
