// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP } from '@/test-utils/vrt.viewports';
import { MarketplaceListingCard } from '@/organisms/Marketplace/MarketplaceListingCard';

// Deterministic BTC/USD rate for the capture (1 BTC = $100,000): the "≈"
// estimates render from this fixed value, never from the network.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: (enabled: boolean) =>
    enabled ? { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') } : null,
}));

/**
 * Card-level scenarios for catalog cards rendered from Nexus index entries.
 * The full Marketplace template keeps its hero above the fold, so these
 * render the bare grid to keep every card term visible in the capture.
 *
 * Live bid state does not come from the index: in `transaction-service`
 * mode each visible auction card lazily reads the service's public listing
 * projection (`useMarketplaceLiveBid`). That hook is mocked below — per
 * listing id — so the live-bid scenario captures the exact states the
 * service can produce (bids placed / zero bids / unreachable) without a
 * network dependency in VRT.
 *
 * Card media: the fixed-price control keeps its index `media_urls` and the
 * URL resolver is mocked to a deterministic data-URI image (no network in
 * VRT), so every scenario shows one card WITH a loaded cover image; the
 * auction fixtures set `media_urls: []` and render the honest media-less
 * gradient.
 */
const CARD_IMAGE_DATA_URL = vi.hoisted(
  () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=',
);

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks((uri) => (uri ? CARD_IMAGE_DATA_URL : null));
});
const fixtures = vi.hoisted(async () => {
  const { catalogItemFromCatalogEntry, filterMarketplaceCatalog } =
    await import('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils');
  const { createCommerceCatalogEntryFixture } = await import('@/test/fixtures/commerce/commerce');

  const auctionWithTerms = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${'n'.repeat(52)}:rangefinder_camera`,
      seller_id: 'n'.repeat(52),
      listing_id: 'rangefinder_camera',
      title: '35mm rangefinder camera',
      description: 'Recently serviced mechanical rangefinder with bright optics.',
      category_id: 'electronics-cameras-film',
      condition: 'excellent',
      tags: ['film', 'camera'],
      sale_format: 'auction',
      media_urls: [],
      price: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      auction: {
        startsAt: '2026-08-19T20:00:00.000Z',
        endsAt: '2026-08-29T20:00:00.000Z',
        buyNowPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      },
      updated_at: Date.parse('2026-08-19T21:02:00.000Z'),
    }),
  );

  // An auction whose Nexus index row predates the auction-term fields: the
  // card renders the terms it actually has (starting bid) and omits the end
  // date and buy-now badges instead of inventing them.
  const auctionMissingTerms = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${'m'.repeat(52)}:mystery_auction`,
      seller_id: 'm'.repeat(52),
      listing_id: 'mystery_auction',
      title: 'Estate lot mystery auction',
      description: 'Auction indexed before Nexus carried auction terms.',
      category_id: 'collectibles-music-vinyl',
      condition: 'fair',
      tags: ['estate', 'lot'],
      sale_format: 'auction',
      media_urls: [],
      price: { amountMinor: 2_500, currency: 'USD', exponent: 2 },
      auction: null,
      updated_at: Date.parse('2026-08-19T21:30:00.000Z'),
    }),
  );

  const auctionEndingSooner = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${'g'.repeat(52)}:silver_signet`,
      seller_id: 'g'.repeat(52),
      listing_id: 'silver_signet',
      title: 'Brutalist silver signet',
      description: 'Solid recycled silver ring cast and finished by hand.',
      category_id: 'fashion-jewelry-rings',
      condition: 'new',
      tags: ['silver', 'handmade'],
      sale_format: 'auction',
      media_urls: [],
      price: { amountMinor: 12_000, currency: 'USD', exponent: 2 },
      auction: {
        startsAt: '2026-08-19T20:00:00.000Z',
        endsAt: '2026-08-22T20:00:00.000Z',
        buyNowPrice: null,
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      },
      updated_at: Date.parse('2026-08-19T21:06:00.000Z'),
    }),
  );

  // Same terms as the rangefinder above, but under the listing id the mocked
  // live-bid hook answers for — so ONLY the live-bid scenario shows a current
  // bid and the other scenarios keep their baselines (terms only).
  const auctionWithLiveBid = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${'n'.repeat(52)}:live_bid_rangefinder`,
      seller_id: 'n'.repeat(52),
      listing_id: 'live_bid_rangefinder',
      title: '35mm rangefinder camera',
      description: 'Recently serviced mechanical rangefinder with bright optics.',
      category_id: 'electronics-cameras-film',
      condition: 'excellent',
      tags: ['film', 'camera'],
      sale_format: 'auction',
      media_urls: [],
      price: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      auction: {
        startsAt: '2026-08-19T20:00:00.000Z',
        endsAt: '2026-08-29T20:00:00.000Z',
        buyNowPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      },
      updated_at: Date.parse('2026-08-19T21:02:00.000Z'),
    }),
  );

  const fixedPrice = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      reputation: { avg: 4.8, count: 23, verifiedCount: 19 },
    }),
  );

  // Record-backed items (attributes known) next to an index-entry item
  // (attributes unknown → the card shows no attribute line, honestly).
  const { catalogItemFromListingModel } = await import('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils');
  const { createCommerceListingFixture } = await import('@/test/fixtures/commerce/commerce');
  const { toCommerceListingModel } = await import('@/test/fixtures/commerce/listing-models');
  const attributedFashion = catalogItemFromListingModel(
    toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'varsity_fleece',
        title: 'Heavyweight varsity fleece',
        description: 'Boxy 90s collegiate fleece with an embroidered chest hit.',
        categoryId: 'fashion-men-tops-hoodies',
        attributes: { size: 'L', brand: 'Champion', color: ['grey', 'navy'] },
      }),
    ),
  );
  const attributedElectronics = catalogItemFromListingModel(
    toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'slr_program',
        title: 'Program-mode 35mm SLR',
        description: 'Clean program-mode SLR body with a fresh light seal service.',
        categoryId: 'electronics-cameras-film',
        attributes: { brand: 'Canon', model: 'AE-1 Program' },
      }),
    ),
  );

  const reservedPrice = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${'r'.repeat(52)}:reserved_boots`,
      seller_id: 'r'.repeat(52),
      listing_id: 'reserved_boots',
      title: 'Handmade leather boots',
      reputation: { avg: 4.8, count: 23, verifiedCount: 19 },
    }),
  );

  return {
    attributeStates: [attributedFashion, attributedElectronics, fixedPrice],
    termStates: [auctionWithTerms, auctionMissingTerms, fixedPrice],
    liveBidStates: [auctionWithLiveBid, auctionMissingTerms, fixedPrice],
    reservedStates: [reservedPrice, fixedPrice],
    endingSoon: filterMarketplaceCatalog([fixedPrice, auctionWithTerms, auctionMissingTerms, auctionEndingSooner], {
      query: '',
      categoryId: null,
      saleFormat: 'all',
      conditions: [],
      minimumPriceMinor: null,
      maximumPriceMinor: null,
      countryCode: null,
      sort: 'ending_soon',
    }),
    shopNames: new Map([
      [auctionWithTerms.sellerId, 'Proof of Film'],
      [auctionEndingSooner.sellerId, 'Low Time Preference'],
      [fixedPrice.sellerId, 'Satoshi Vintage'],
      [reservedPrice.sellerId, 'Satoshi Vintage'],
    ]),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace',
}));

// Only the dedicated live-bid fixture gets an answer; every other card
// resolves to `null`, which is also what the terms-only scenarios (no
// durable backend reachable) render with.
vi.mock('@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid', () => ({
  useMarketplaceLiveBid: (_sellerPubky: string, listingId: string) => ({
    ref: () => {},
    bid:
      listingId === 'live_bid_rangefinder'
        ? {
            currentPrice: { amountMinor: 7_500, currency: 'USD', exponent: 2 },
            bidCount: 4,
          }
        : null,
    listingState: listingId === 'reserved_boots' ? 'reserved' : null,
  }),
}));

// The display store persists to localStorage, which the VRT browser shares
// across test files — pin the defaults so captures never depend on what a
// previously-run file left behind.
beforeEach(async () => {
  const { useMarketplaceDisplayStore } = await import('@/stores/marketplace-display/marketplace-display.store');
  useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: 'metric' });
});

describe('Marketplace listing cards — visual regression', () => {
  it('renders index-entry auction cards with terms, missing terms, and a fixed-price control at desktop viewport', async () => {
    const { termStates, shopNames } = await fixtures;
    const screen = await renderForVRT(
      <div className="grid grid-cols-4 gap-5 p-6">
        {termStates.map((listing) => (
          <MarketplaceListingCard key={listing.id} listing={listing} shopName={shopNames.get(listing.sellerId)} />
        ))}
      </div>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-cards-auction-terms-desktop');
  });

  it('renders a live current bid with bid count next to bid-less and fixed-price controls at desktop viewport', async () => {
    const { liveBidStates, shopNames } = await fixtures;
    // The rangefinder card is the one the mocked hook answers for, so it
    // relabels to "Current bid" with a bid count while its term-less and
    // fixed-price neighbours stay unchanged.
    const screen = await renderForVRT(
      <div className="grid grid-cols-4 gap-5 p-6">
        {liveBidStates.map((listing) => (
          <MarketplaceListingCard key={listing.id} listing={listing} shopName={shopNames.get(listing.sellerId)} />
        ))}
      </div>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-cards-live-bid-desktop');
  });

  it('renders card attribute lines for record-backed items next to an index-entry control at desktop viewport', async () => {
    const { attributeStates, shopNames } = await fixtures;
    const screen = await renderForVRT(
      <div className="grid grid-cols-4 gap-5 p-6">
        {attributeStates.map((listing) => (
          <MarketplaceListingCard key={listing.id} listing={listing} shopName={shopNames.get(listing.sellerId)} />
        ))}
      </div>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-cards-attributes-desktop');
  });

  it('renders the ending-soon ordering with a term-less auction after known end times at desktop viewport', async () => {
    const { endingSoon, shopNames } = await fixtures;
    const screen = await renderForVRT(
      <div className="grid grid-cols-4 gap-5 p-6">
        {endingSoon.map((listing) => (
          <MarketplaceListingCard key={listing.id} listing={listing} shopName={shopNames.get(listing.sellerId)} />
        ))}
      </div>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-cards-ending-soon-desktop');
  });

  it('replaces Buy now with the holding sentence on a reserved fixed-price card at desktop viewport', async () => {
    const { reservedStates, shopNames } = await fixtures;
    const screen = await renderForVRT(
      <div className="grid grid-cols-4 gap-5 p-6">
        {reservedStates.map((listing) => (
          <MarketplaceListingCard key={listing.id} listing={listing} shopName={shopNames.get(listing.sellerId)} />
        ))}
      </div>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-cards-reserved-desktop');
  });
});
