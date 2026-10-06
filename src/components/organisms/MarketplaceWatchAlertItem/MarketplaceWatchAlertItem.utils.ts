import { formatCommerceMoney } from '@/libs/commerce/format';
import type { MarketplaceWatchAlertFeedItem } from '@/pipes/marketplaceWatch/marketplaceWatchAlert.types';

/**
 * Headline for a watch alert row. Phrasing only claims what the observation
 * itself established (see the detector's honesty rules): "outbid" appears
 * only for the alert kind the detector reserves for proven participation,
 * and state transitions are named from their actual endpoints.
 */
export function getWatchAlertHeadline(item: MarketplaceWatchAlertFeedItem): string {
  switch (item.kind) {
    case 'ending_soon':
      return 'Auction ending soon';
    case 'new_bid':
      return 'New bid on a watched auction';
    case 'outbid':
      return 'You were outbid';
    case 'price_change':
      return priceChangeHeadline(item);
    case 'state_change':
      return stateChangeHeadline(item);
  }
}

/** Secondary detail line: the observed values behind the headline, when present. */
export function getWatchAlertDetail(item: MarketplaceWatchAlertFeedItem): string | null {
  switch (item.kind) {
    case 'ending_soon':
      return item.endsAt ? `Ends ${formatWatchAlertDate(item.endsAt)}` : null;
    case 'new_bid':
    case 'outbid': {
      if (!item.currentAmount) return null;
      const bidCount = item.bidCount !== null ? ` · ${item.bidCount} ${item.bidCount === 1 ? 'bid' : 'bids'}` : '';
      return `Current bid ${formatCommerceMoney(item.currentAmount)}${bidCount}`;
    }
    case 'price_change':
      return item.previousAmount && item.currentAmount
        ? `${formatCommerceMoney(item.previousAmount)} to ${formatCommerceMoney(item.currentAmount)}`
        : null;
    case 'state_change':
      return item.previousState && item.nextState ? `Was ${item.previousState}, now ${item.nextState}` : null;
  }
}

function priceChangeHeadline(item: MarketplaceWatchAlertFeedItem): string {
  if (item.previousAmount && item.currentAmount) {
    return item.currentAmount.amountMinor < item.previousAmount.amountMinor ? 'Price dropped' : 'Price increased';
  }
  return 'Price changed';
}

function stateChangeHeadline(item: MarketplaceWatchAlertFeedItem): string {
  switch (item.nextState) {
    case 'sold':
      return 'Sold out';
    case 'ended':
      return 'Listing ended';
    case 'removed':
      return 'Listing removed';
    case 'paused':
      return 'Unlisted by the seller';
    case 'active':
    case 'available':
      return 'Relisted';
    default:
      return 'Listing state changed';
  }
}

function formatWatchAlertDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(isoDate));
}
