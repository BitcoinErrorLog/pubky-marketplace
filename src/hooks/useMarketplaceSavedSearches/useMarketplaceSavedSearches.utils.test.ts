import { describe, expect, it } from 'vitest';
import type { CommerceSavedSearchParams } from '@/models/commerce/commerce.schema';
import type { MarketplaceCatalogItem } from '../useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { matchSavedSearch, summarizeSavedSearchMatches } from './useMarketplaceSavedSearches.utils';

const SELLER = 's'.repeat(52);

function item(overrides: Partial<MarketplaceCatalogItem> = {}): MarketplaceCatalogItem {
  const listingId = overrides.listingId ?? 'boots_01';
  return {
    id: `${SELLER}:${listingId}`,
    sellerId: SELLER,
    listingId,
    state: 'active',
    title: 'Vintage boots',
    description: 'Weathered leather boots',
    categoryId: 'fashion-shoes',
    condition: 'good',
    tags: ['boots'],
    saleFormat: 'fixed_price',
    price: { amountMinor: 120_00, currency: 'USD', exponent: 2 },
    auction: null,
    attributes: null,
    location: { countryCode: 'US', region: null },
    mediaUrls: [],
    reputation: null,
    revision: 1,
    updatedAt: 1_000,
    ...overrides,
  };
}

function params(overrides: Partial<CommerceSavedSearchParams> = {}): CommerceSavedSearchParams {
  return {
    query: '',
    categoryId: null,
    saleFormat: 'all',
    conditions: [],
    minimumPriceMinor: null,
    maximumPriceMinor: null,
    sort: 'newest',
    ...overrides,
  };
}

describe('matchSavedSearch', () => {
  it('applies the persisted params exactly like the catalog filter', () => {
    const items = [
      item({ listingId: 'boots_01', title: 'Vintage boots' }),
      item({
        listingId: 'cam_01',
        title: 'Film camera',
        description: 'A 35mm rangefinder',
        tags: ['camera'],
        categoryId: 'electronics-camera',
      }),
      item({ listingId: 'gone_01', state: 'ended' }),
    ];

    const matches = matchSavedSearch(items, params({ query: 'boots' }));

    expect(matches.map(({ listingId }) => listingId)).toEqual(['boots_01']);
  });
});

describe('summarizeSavedSearchMatches', () => {
  it('reports zero NEW on a first check whose watermark is the newest current match', () => {
    const matches = [item({ listingId: 'a', updatedAt: 5_000 }), item({ listingId: 'b', updatedAt: 3_000 })];

    const summary = summarizeSavedSearchMatches(matches, 5_000);

    expect(summary).toEqual({ newCount: 0, latestMatchUpdatedAt: 5_000 });
  });

  it('counts only matches strictly newer than the watermark', () => {
    const matches = [
      item({ listingId: 'old', updatedAt: 2_000 }),
      item({ listingId: 'boundary', updatedAt: 3_000 }),
      item({ listingId: 'new-1', updatedAt: 4_000 }),
      item({ listingId: 'new-2', updatedAt: 6_000 }),
    ];

    const summary = summarizeSavedSearchMatches(matches, 3_000);

    expect(summary).toEqual({ newCount: 2, latestMatchUpdatedAt: 6_000 });
  });

  it('reports nothing NEW for an empty result set', () => {
    expect(summarizeSavedSearchMatches([], 3_000)).toEqual({ newCount: 0, latestMatchUpdatedAt: 0 });
  });

  it('never counts acknowledged items again after the watermark advances', () => {
    const matches = [item({ listingId: 'new-1', updatedAt: 4_000 })];

    const beforeAcknowledge = summarizeSavedSearchMatches(matches, 3_000);
    expect(beforeAcknowledge.newCount).toBe(1);

    // Acknowledging moves the watermark to latestMatchUpdatedAt (4000).
    const afterAcknowledge = summarizeSavedSearchMatches(matches, beforeAcknowledge.latestMatchUpdatedAt);
    expect(afterAcknowledge.newCount).toBe(0);
  });
});
