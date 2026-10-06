// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { settleMarketplaceSocialCapture } from '@/test-utils/vrt.social-settle';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceFollowedSellersShelf } from '@/organisms/Marketplace/MarketplaceFollowedSellersShelf';
import { MarketplaceHotSection } from '@/organisms/Marketplace/MarketplaceHotSection';

// No rate in this capture: the indicative-rate hook resolves to null (no
// rate -> no estimate), keeping the scenario network-free and the cards
// byte-identical to the pre-estimate baseline.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

/**
 * The social-discovery marketplace surfaces: the home-feed "From sellers you
 * follow" shelf and the Hot-page "Ending soon" / "Fresh listings" modules.
 *
 * The Nexus reads behind both surfaces are mocked at the data-hook boundary
 * (the same seam `useMarketplaceLiveBid` is mocked at in the listing-cards
 * suite) with deterministic fixtures, so the captures are stable regardless
 * of network or index state. The `absent` scenarios pin the load-bearing
 * behavior that these modules render NOTHING — no empty shell, no skeleton —
 * when there is no honest content: only the sentinel markers around them may
 * appear in the capture.
 */
const CARD_IMAGE_DATA_URL = vi.hoisted(
  () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=',
);

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks((uri) => (uri ? CARD_IMAGE_DATA_URL : null));
});

// Mutable per-scenario hook outputs; each test assigns before rendering.
const surfaceState = vi.hoisted(() => ({
  shelf: { listings: [] as unknown[], shopsBySeller: new Map<string, unknown>() },
  hot: { endingSoon: [] as unknown[], fresh: [] as unknown[], shopsBySeller: new Map<string, unknown>() },
}));

const fixtures = vi.hoisted(async () => {
  const { catalogItemFromCatalogEntry } = await import('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils');
  const { createCommerceCatalogEntryFixture, createCommerceShopFixture } =
    await import('@/test/fixtures/commerce/commerce');

  const SELLER_FILM = 'n'.repeat(52);
  const SELLER_SILVER = 'g'.repeat(52);
  const SELLER_VINTAGE = 'y'.repeat(52);

  const auctionEndingSoonest = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${SELLER_SILVER}:silver_signet`,
      seller_id: SELLER_SILVER,
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

  const auctionEndingLater = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${SELLER_FILM}:rangefinder_camera`,
      seller_id: SELLER_FILM,
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

  // Default fixture keeps its media_urls, so exactly one card renders a
  // loaded cover image (the mocked deterministic data URI).
  const fixedPriceBoots = catalogItemFromCatalogEntry(createCommerceCatalogEntryFixture());

  const fixedPriceJacket = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${SELLER_VINTAGE}:field_jacket`,
      listing_id: 'field_jacket',
      title: 'Waxed field jacket',
      description: 'Rewaxed cotton shell with corduroy collar.',
      category_id: 'fashion-outerwear',
      condition: 'excellent',
      tags: ['waxed', 'workwear'],
      media_urls: [],
      price: { amountMinor: 18_000, currency: 'USD', exponent: 2 },
      updated_at: Date.parse('2026-08-19T20:30:00.000Z'),
    }),
  );

  const shopsBySeller = new Map([
    [SELLER_FILM, createCommerceShopFixture({ ownerPubky: SELLER_FILM, name: 'Proof of Film' })],
    [SELLER_SILVER, createCommerceShopFixture({ ownerPubky: SELLER_SILVER, name: 'Low Time Preference' })],
    [SELLER_VINTAGE, createCommerceShopFixture({ ownerPubky: SELLER_VINTAGE, name: 'Satoshi Vintage' })],
  ]);

  return {
    shelfListings: [fixedPriceBoots, auctionEndingSoonest, fixedPriceJacket, auctionEndingLater],
    endingSoon: [auctionEndingSoonest, auctionEndingLater],
    fresh: [fixedPriceBoots, fixedPriceJacket],
    shopsBySeller,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/home',
}));

// The data hooks are the deterministic seam: they own the Nexus reads, the
// Dexie cache, and the adapter-mode/auth gating (all unit-tested in their own
// suites); VRT pins what the components render for a given honest output.
vi.mock('@/hooks/useFollowedSellerListings/useFollowedSellerListings', () => ({
  useFollowedSellerListings: () => surfaceState.shelf,
}));

vi.mock('@/hooks/useMarketplaceHotListings/useMarketplaceHotListings', () => ({
  useMarketplaceHotListings: () => surfaceState.hot,
}));

// Terms-only cards: live bid state is out of scope for these surfaces' VRT
// (covered by the listing-cards suite).
vi.mock('@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid', () => ({
  useMarketplaceLiveBid: () => ({ ref: () => {}, bid: null }),
}));

/** Sentinel-framed host: proves an absent module leaves no shell behind. */
function SurfaceHost({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="rounded border border-dashed border-border p-2 text-sm text-muted-foreground">
        content above the module
      </div>
      {children}
      <div className="rounded border border-dashed border-border p-2 text-sm text-muted-foreground">
        content below the module
      </div>
    </div>
  );
}

async function expectSocialScreenshot(
  screen: Awaited<ReturnType<typeof renderForVRT>>,
  name: string,
  expectedCovers: number,
) {
  await settleMarketplaceSocialCapture(expectedCovers);
  await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(name);
}

describe('Marketplace social surfaces — visual regression', () => {
  it('renders the followed-sellers shelf as a horizontal card strip at desktop viewport', async () => {
    const f = await fixtures;
    surfaceState.shelf = { listings: f.shelfListings, shopsBySeller: f.shopsBySeller };
    const screen = await renderForVRT(
      <SurfaceHost>
        <MarketplaceFollowedSellersShelf />
      </SurfaceHost>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expectSocialScreenshot(screen, 'followed-sellers-shelf-desktop', 1);
  });

  it('renders the followed-sellers shelf at mobile viewport with overflow cards off-screen', async () => {
    const f = await fixtures;
    surfaceState.shelf = { listings: f.shelfListings, shopsBySeller: f.shopsBySeller };
    const screen = await renderForVRT(
      <SurfaceHost>
        <MarketplaceFollowedSellersShelf />
      </SurfaceHost>,
      { viewport: VRT_VIEWPORT_MOBILE, disableHover: true },
    );
    await expectSocialScreenshot(screen, 'followed-sellers-shelf-mobile', 1);
  });

  it('renders nothing at all for the shelf when no followed seller has active listings', async () => {
    surfaceState.shelf = { listings: [], shopsBySeller: new Map() };
    const screen = await renderForVRT(
      <SurfaceHost>
        <MarketplaceFollowedSellersShelf />
      </SurfaceHost>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expectSocialScreenshot(screen, 'followed-sellers-shelf-absent', 0);
  });

  it('renders the Hot-page ending-soon and fresh-listings modules at desktop viewport', async () => {
    const f = await fixtures;
    surfaceState.hot = { endingSoon: f.endingSoon, fresh: f.fresh, shopsBySeller: f.shopsBySeller };
    const screen = await renderForVRT(
      <SurfaceHost>
        <MarketplaceHotSection />
      </SurfaceHost>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expectSocialScreenshot(screen, 'hot-marketplace-modules-desktop', 1);
  });

  it('renders only the fresh-listings module when no auction has known end terms', async () => {
    const f = await fixtures;
    surfaceState.hot = { endingSoon: [], fresh: f.fresh, shopsBySeller: f.shopsBySeller };
    const screen = await renderForVRT(
      <SurfaceHost>
        <MarketplaceHotSection />
      </SurfaceHost>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expectSocialScreenshot(screen, 'hot-marketplace-fresh-only-desktop', 1);
  });

  it('renders nothing at all on Hot when the index has no listings', async () => {
    surfaceState.hot = { endingSoon: [], fresh: [], shopsBySeller: new Map() };
    const screen = await renderForVRT(
      <SurfaceHost>
        <MarketplaceHotSection />
      </SurfaceHost>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expectSocialScreenshot(screen, 'hot-marketplace-modules-absent', 0);
  });
});
