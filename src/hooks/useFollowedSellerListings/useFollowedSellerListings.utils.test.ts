import { describe, expect, it } from 'vitest';
import { catalogItemFromCatalogEntry } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { COMMERCE_FIXTURE_SELLER, createCommerceCatalogEntryFixture } from '@/test/fixtures/commerce/commerce';
import { composeFollowedSellerListings } from './useFollowedSellerListings.utils';

const FOLLOWED_SELLER = COMMERCE_FIXTURE_SELLER;
const OTHER_FOLLOWED_SELLER = 'f'.repeat(52);
const UNFOLLOWED_SELLER = 'u'.repeat(52);

function item(overrides: Parameters<typeof createCommerceCatalogEntryFixture>[0]) {
  return catalogItemFromCatalogEntry(createCommerceCatalogEntryFixture(overrides));
}

describe('composeFollowedSellerListings', () => {
  it('keeps only active listings whose seller the viewer follows', () => {
    const followed = item({ id: `${FOLLOWED_SELLER}:boots_01` });
    const notFollowed = item({
      id: `${UNFOLLOWED_SELLER}:jacket_01`,
      seller_id: UNFOLLOWED_SELLER,
      listing_id: 'jacket_01',
    });
    const followedButEnded = item({ id: `${FOLLOWED_SELLER}:sold_01`, listing_id: 'sold_01', state: 'ended' });

    const result = composeFollowedSellerListings(
      [notFollowed, followedButEnded, followed],
      [FOLLOWED_SELLER, OTHER_FOLLOWED_SELLER],
      12,
    );

    expect(result).toEqual([followed]);
  });

  it('leaves out an auction past its end time even when the cached row still says active', () => {
    const endsAt = '2026-09-29T12:00:00.000Z';
    const closedAuction = item({
      id: `${FOLLOWED_SELLER}:closed_auction`,
      listing_id: 'closed_auction',
      sale_format: 'auction',
      auction: {
        startsAt: '2026-09-01T12:00:00.000Z',
        endsAt,
        buyNowPrice: null,
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      },
    });

    expect(closedAuction.state).toBe('active');
    expect(composeFollowedSellerListings([closedAuction], [FOLLOWED_SELLER], 12, Date.parse(endsAt) - 1)).toEqual([
      closedAuction,
    ]);
    expect(composeFollowedSellerListings([closedAuction], [FOLLOWED_SELLER], 12, Date.parse(endsAt))).toEqual([]);
  });

  it('orders by most recent update and caps the shelf', () => {
    const older = item({ id: `${FOLLOWED_SELLER}:older`, listing_id: 'older', updated_at: 1_000 });
    const newest = item({ id: `${FOLLOWED_SELLER}:newest`, listing_id: 'newest', updated_at: 3_000 });
    const middle = item({
      id: `${OTHER_FOLLOWED_SELLER}:middle`,
      seller_id: OTHER_FOLLOWED_SELLER,
      listing_id: 'middle',
      updated_at: 2_000,
    });

    const result = composeFollowedSellerListings([older, newest, middle], [FOLLOWED_SELLER, OTHER_FOLLOWED_SELLER], 2);

    expect(result.map(({ id }) => id)).toEqual([newest.id, middle.id]);
  });

  it('returns empty for an empty follow set so the shelf renders nothing', () => {
    expect(composeFollowedSellerListings([item({})], [], 12)).toEqual([]);
  });
});
