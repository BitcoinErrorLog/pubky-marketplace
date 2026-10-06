import type { MarketplaceWatchAlertFeedItem } from '@/pipes/marketplaceWatch/marketplaceWatchAlert.types';
import { HOUR_MS, VRT_FROZEN_NOW_MS } from '@/test-utils/vrt.clock';

export const WATCH_ALERT_FIXTURE_SELLER = 'w'.repeat(52);

/**
 * One device-local watch alert feed item, timed relative to the frozen VRT
 * clock so relative timestamps render identically across runs.
 */
export function createWatchAlertFeedItemFixture(
  kind: MarketplaceWatchAlertFeedItem['kind'],
  overrides: Partial<MarketplaceWatchAlertFeedItem> = {},
): MarketplaceWatchAlertFeedItem {
  const listingId = overrides.href ? undefined : `${kind}_listing`;
  const base: MarketplaceWatchAlertFeedItem = {
    id: `watch:${WATCH_ALERT_FIXTURE_SELLER}|${WATCH_ALERT_FIXTURE_SELLER}:${kind}_listing|${kind}|fixture`,
    source: 'watch-alert',
    kind,
    title: 'Vintage mechanical keyboard',
    href: `/marketplace/listing/${WATCH_ALERT_FIXTURE_SELLER}/${listingId ?? 'listing'}`,
    timestamp: VRT_FROZEN_NOW_MS - 2 * HOUR_MS,
    isUnseen: false,
    endsAt: null,
    previousAmount: null,
    currentAmount: null,
    bidCount: null,
    previousState: null,
    nextState: null,
  };

  switch (kind) {
    case 'ending_soon':
      base.endsAt = new Date(VRT_FROZEN_NOW_MS + 3 * HOUR_MS).toISOString();
      break;
    case 'new_bid':
    case 'outbid':
      base.previousAmount = { amountMinor: 15_000, currency: 'USD', exponent: 2 };
      base.currentAmount = { amountMinor: 17_500, currency: 'USD', exponent: 2 };
      base.bidCount = 3;
      break;
    case 'price_change':
      base.previousAmount = { amountMinor: 12_000, currency: 'USD', exponent: 2 };
      base.currentAmount = { amountMinor: 9_000, currency: 'USD', exponent: 2 };
      break;
    case 'state_change':
      base.previousState = 'active';
      base.nextState = 'ended';
      break;
  }

  return { ...base, ...overrides };
}
