import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import type { MarketplaceListingProjection } from '@/services/marketplace/marketplace';

export const PROJECTION_FIXTURE_SELLER = 'y'.repeat(52);
export const PROJECTION_FIXTURE_LEADER = 'b'.repeat(52);

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', exponent: 2 });

/** Transaction-service projection for a fixed-price listing. */
export function createListingProjectionFixture(
  overrides: Partial<MarketplaceListingProjection> = {},
): MarketplaceListingProjection {
  return {
    aggregateId: buildMarketplaceListingAggregateId(PROJECTION_FIXTURE_SELLER, 'boots_01'),
    sellerPubky: PROJECTION_FIXTURE_SELLER,
    listingId: 'boots_01',
    listingRevision: 1,
    contentHash: 'c'.repeat(64),
    serverRevision: 3,
    state: 'available',
    availableQuantity: 2,
    reservedQuantity: 0,
    unitPrice: usd(12_500),
    saleFormat: 'fixed_price',
    fulfillmentMethods: ['shipping'],
    auction: null,
    ...overrides,
  };
}

/** Transaction-service projection for a live auction with active bidding. */
export function createAuctionProjectionFixture(
  overrides: Partial<MarketplaceListingProjection> = {},
): MarketplaceListingProjection {
  return createListingProjectionFixture({
    aggregateId: buildMarketplaceListingAggregateId(PROJECTION_FIXTURE_SELLER, 'rangefinder_camera'),
    listingId: 'rangefinder_camera',
    availableQuantity: 1,
    unitPrice: usd(4_500),
    saleFormat: 'auction',
    auction: {
      startsAt: '2026-08-19T20:00:00.000Z',
      endsAt: '2026-08-29T20:00:00.000Z',
      minimumIncrement: usd(500),
      currentPrice: usd(6_900),
      leaderPubky: PROJECTION_FIXTURE_LEADER,
      bidCount: 4,
    },
    ...overrides,
  });
}

/** Authenticated bidder projection captured from the marketplace service contract sample. */
export function createViewerBidAuctionProjectionFixture(): MarketplaceListingProjection {
  return createAuctionProjectionFixture({
    auction: {
      ...createAuctionProjectionFixture().auction!,
      currentPrice: usd(4_500),
    },
    viewerBid: {
      maximumAmount: usd(7_000),
      minimumNextBid: usd(7_001),
    },
  });
}
