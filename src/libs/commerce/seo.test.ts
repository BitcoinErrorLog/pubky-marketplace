import { describe, expect, it } from 'vitest';
import {
  COMMERCE_FIXTURE_SELLER,
  createCommerceListingFixture,
  createCommerceShopFixture,
} from '@/test/fixtures/commerce/commerce';
import {
  buildListingDescription,
  buildListingTitle,
  buildShopDescription,
  buildShopTitle,
  listingConditionLabel,
  listingPriceLabel,
  listingStateNotice,
  MARKETPLACE_STATIC_SEO,
  resolveListingOgCoverUri,
  SEO_DESCRIPTION_MAX_GRAPHEMES,
} from './seo';

describe('listingPriceLabel', () => {
  it('formats a fixed price as currency', () => {
    expect(listingPriceLabel(createCommerceListingFixture())).toBe('$125.00');
  });

  it('labels an auction with its starting price', () => {
    const listing = createCommerceListingFixture({
      sale: {
        format: 'auction',
        startingPrice: { amountMinor: 5_000, currency: 'USD', exponent: 2 },
        minimumIncrement: { amountMinor: 100, currency: 'USD', exponent: 2 },
        startsAt: '2026-08-19T20:00:00.000Z',
        endsAt: '2026-08-26T20:00:00.000Z',
        antiSnipingWindowSeconds: 60,
        antiSnipingExtensionSeconds: 60,
      },
    });
    expect(listingPriceLabel(listing)).toBe('Auction from $50.00');
  });
});

describe('buildListingTitle', () => {
  it('combines the record title, price, and marketplace label', () => {
    expect(buildListingTitle(createCommerceListingFixture())).toBe(
      'Vintage leather boots — $125.00 | Pubky Marketplace',
    );
  });
});

describe('buildListingDescription', () => {
  it('uses the record description verbatim when it fits', () => {
    expect(buildListingDescription(createCommerceListingFixture())).toBe('Well cared for boots with light wear.');
  });

  it('truncates long descriptions to the grapheme cap with an ellipsis', () => {
    const listing = createCommerceListingFixture({ description: 'a'.repeat(500) });
    const description = buildListingDescription(listing);
    expect(description).toBe(`${'a'.repeat(SEO_DESCRIPTION_MAX_GRAPHEMES)}...`);
  });

  it('prefixes an honest state notice for paused listings', () => {
    const listing = createCommerceListingFixture({ state: 'paused' });
    expect(buildListingDescription(listing)).toBe('Listing paused. Well cared for boots with light wear.');
  });

  it('prefixes an honest state notice for ended listings and keeps the total clamped', () => {
    const listing = createCommerceListingFixture({ state: 'ended', description: 'b'.repeat(500) });
    const description = buildListingDescription(listing);
    expect(description.startsWith('Listing ended. ')).toBe(true);
    expect(description).toBe(
      `Listing ended. ${'b'.repeat(SEO_DESCRIPTION_MAX_GRAPHEMES - 'Listing ended. '.length)}...`,
    );
  });
});

describe('listingStateNotice for auctions', () => {
  const endsAt = '2026-01-08T11:00:00.000Z';
  const auction = createCommerceListingFixture({
    sale: {
      format: 'auction',
      startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      startsAt: '2026-01-01T11:00:00.000Z',
      endsAt,
      antiSnipingWindowSeconds: 120,
      antiSnipingExtensionSeconds: 120,
    },
  });

  it('says an auction stored as active has ended once its end time is reached', () => {
    expect(auction.state).toBe('active');
    expect(listingStateNotice(auction, Date.parse(endsAt) - 1)).toBeNull();
    expect(listingStateNotice(auction, Date.parse(endsAt))).toBe('Listing ended');
  });

  it('prefixes the unfurl description of a closed auction', () => {
    expect(buildListingDescription(auction).startsWith('Listing ended. ')).toBe(true);
  });
});

describe('listingStateNotice', () => {
  it('returns null for active listings', () => {
    expect(listingStateNotice(createCommerceListingFixture())).toBeNull();
  });

  it('maps every non-active state to a notice', () => {
    expect(listingStateNotice(createCommerceListingFixture({ state: 'paused' }))).toBe('Listing paused');
    expect(listingStateNotice(createCommerceListingFixture({ state: 'ended' }))).toBe('Listing ended');
    expect(listingStateNotice(createCommerceListingFixture({ state: 'removed' }))).toBe('Listing removed');
  });
});

describe('resolveListingOgCoverUri', () => {
  it('returns the first image media URI', () => {
    expect(resolveListingOgCoverUri(createCommerceListingFixture())).toBe(
      `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/image_01`,
    );
  });

  it('skips leading video media and returns the first image', () => {
    const base = createCommerceListingFixture();
    const listing = createCommerceListingFixture({
      media: [
        {
          ...base.media[0],
          id: 'video_01',
          type: 'video',
          url: `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/video_01`,
          mimeType: 'video/mp4',
          durationMs: 5_000,
        },
        base.media[0],
      ],
    });
    expect(resolveListingOgCoverUri(listing)).toBe(base.media[0].url);
  });

  it('NEVER exposes a photo for adult-only listings', () => {
    expect(resolveListingOgCoverUri(createCommerceListingFixture({ adultOnly: true }))).toBeNull();
  });
});

describe('listingConditionLabel', () => {
  it('humanizes the condition enum', () => {
    expect(listingConditionLabel(createCommerceListingFixture({ condition: 'like_new' }))).toBe('Like New');
  });
});

describe('shop SEO builders', () => {
  it('builds the shop title from the record name', () => {
    expect(buildShopTitle(createCommerceShopFixture())).toBe('Satoshi Vintage — Shop | Pubky Marketplace');
  });

  it('derives the description from the bio', () => {
    expect(buildShopDescription(createCommerceShopFixture())).toBe('Circular fashion and Bitcoin.');
  });

  it('returns an empty description for an empty bio (caller suppresses, never invents copy)', () => {
    expect(buildShopDescription(createCommerceShopFixture({ bio: '' }))).toBe('');
  });

  it('truncates long bios to the grapheme cap', () => {
    const shop = createCommerceShopFixture({ bio: 'c'.repeat(400) });
    expect(buildShopDescription(shop)).toBe(`${'c'.repeat(SEO_DESCRIPTION_MAX_GRAPHEMES)}...`);
  });
});

describe('MARKETPLACE_STATIC_SEO', () => {
  it('stays within the description cap', () => {
    expect(MARKETPLACE_STATIC_SEO.description.length).toBeLessThanOrEqual(SEO_DESCRIPTION_MAX_GRAPHEMES);
  });
});
