import { describe, expect, it } from 'vitest';
import { createNotificationFixture } from '@/test/fixtures/commerce/notifications';
import {
  isIntegrityGapActivityType,
  MARKETPLACE_ACTIVITY_LABELS,
  SERVICE_NOTIFICATION_TYPES,
} from './marketplace-activity-copy';
import { marketplaceNotificationSchema, parseMarketplaceNotificationEntries } from './marketplace-projections';

describe('service notification types', () => {
  it('maps every type pubky-marketplace-service can emit', () => {
    const schemaTypes = new Set<string>(marketplaceNotificationSchema.shape.type.options);
    const missing = SERVICE_NOTIFICATION_TYPES.filter(
      (type) => !schemaTypes.has(type) || !(type in MARKETPLACE_ACTIVITY_LABELS),
    );
    expect(missing).toEqual([]);
  });

  it('parses a valid row for each service type as recognized activity', () => {
    const notifications = SERVICE_NOTIFICATION_TYPES.map((type) => createNotificationFixture(type));
    const entries = parseMarketplaceNotificationEntries({ notifications });
    const unrecognized = entries.filter((entry) => 'kind' in entry);
    expect(unrecognized).toEqual([]);
    for (const type of SERVICE_NOTIFICATION_TYPES) {
      expect(isIntegrityGapActivityType(type)).toBe(false);
      expect(MARKETPLACE_ACTIVITY_LABELS[type].length).toBeGreaterThan(0);
    }
  });

  it('quarantines an unknown type as an integrity gap', () => {
    const row = {
      ...createNotificationFixture('order_created'),
      type: 'payment_hold_acquired_unknown',
    };
    const [entry] = parseMarketplaceNotificationEntries({ notifications: [row] });
    expect(entry).toMatchObject({ kind: 'unrecognized', type: 'payment_hold_acquired_unknown' });
    expect(isIntegrityGapActivityType('payment_hold_acquired_unknown')).toBe(true);
  });

  it('does not treat a known type as an integrity gap when another field fails the schema', () => {
    const row = {
      ...createNotificationFixture('payment_method_bound'),
      createdAt: 'not-a-timestamp',
    };
    const [entry] = parseMarketplaceNotificationEntries({ notifications: [row] });
    expect(entry).toMatchObject({ kind: 'unrecognized', type: 'payment_method_bound' });
    expect(isIntegrityGapActivityType('payment_method_bound')).toBe(false);
  });
});
