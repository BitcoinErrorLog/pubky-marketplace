// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { CollectionListingItems } from '@/organisms/Collections/CollectionListingItems/CollectionListingItems';

// No rate in this capture: the indicative-rate hook resolves to null (no
// rate -> no estimate), keeping the scenario network-free and byte-identical
// to the pre-estimate baseline.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

// The commerce fixtures carry `pubky://` media URIs that the real resolver
// turns into live homeserver URLs — a network fetch mid-capture whose
// load/error timing raced `toMatchScreenshot`'s stability loop (the source of
// this suite's "could not capture a stable screenshot" timeouts). Resolve to
// null so the card renders its deterministic gradient+icon backdrop, same as
// `Marketplace.vrt.test.tsx`.
vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});

const fixtures = vi.hoisted(async () => {
  const { createCommerceListingFixture, COMMERCE_FIXTURE_SELLER } = await import('@/test/fixtures/commerce/commerce');
  const { toCommerceListingModel } = await import('@/test/fixtures/commerce/listing-models');

  return {
    seller: COMMERCE_FIXTURE_SELLER,
    bootsListing: toCommerceListingModel(createCommerceListingFixture()),
    cameraListing: toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'rangefinder_camera',
        title: '35mm rangefinder camera',
        categoryId: 'electronics-cameras-film',
        condition: 'excellent',
      }),
    ),
  };
});

const view = vi.hoisted(() => ({
  cachedByListingId: new Map<string, unknown>(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/collections',
}));

// `CollectionListingItems` uses an async live-query, so the usual synchronous
// passthrough would surface a Promise. Unwrap it into state; the browser-mode
// render waits (fonts, images, rAF) long enough for the settle to paint.
vi.mock('dexie-react-hooks', async () => {
  const { useEffect, useState } = await import('react');
  return {
    useLiveQuery: (querier: () => unknown, deps: unknown[] = [], defaultValue?: unknown) => {
      const [value, setValue] = useState(defaultValue);
      useEffect(() => {
        let stale = false;
        Promise.resolve(querier()).then((result) => {
          if (!stale) setValue(result);
        });
        return () => {
          stale = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mirror useLiveQuery's deps contract
      }, deps);
      return value;
    },
  };
});

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    ...createMarketplaceVrtCommerceController(),
    getListing: (_seller: string, listingId: string) => view.cachedByListingId.get(listingId),
    // Hydration settles immediately; the cells render from the "cache" above.
    getOrFetchListing: () => Promise.resolve(null),
    // The hydrated cells are real MarketplaceListingCards: their watch toggle
    // reads favorite state through the controller (and would hit the real
    // auth store under a full-suite run, where another file may leave a
    // signed-in user behind), and the live-bid hook reads the projection in
    // durable mode. Keep every static the card reaches on the mock.
    isFavorite: () => Promise.resolve(false),
    commitCreateFavorite: () => Promise.resolve(),
    commitDeleteFavorite: () => Promise.resolve(),
    getMarketplaceListingProjection: () => Promise.resolve(null),
  },
}));

describe('Collection listing items — visual regression', () => {
  it('renders listing cards for collection listing items at desktop viewport', async () => {
    const { seller, bootsListing, cameraListing } = await fixtures;
    view.cachedByListingId = new Map<string, unknown>([
      ['boots_01', bootsListing],
      ['rangefinder_camera', cameraListing],
    ]);

    const screen = await renderForVRT(
      <CollectionListingItems
        listings={[
          { sellerPubky: seller, listingId: 'boots_01' },
          { sellerPubky: seller, listingId: 'rangefinder_camera' },
        ]}
      />,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('collection-listing-items-desktop');
  });

  it('renders listing cards at mobile viewport', async () => {
    const { seller, bootsListing } = await fixtures;
    view.cachedByListingId = new Map<string, unknown>([['boots_01', bootsListing]]);

    const screen = await renderForVRT(
      <CollectionListingItems listings={[{ sellerPubky: seller, listingId: 'boots_01' }]} />,
      { viewport: VRT_VIEWPORT_MOBILE, disableHover: true },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('collection-listing-items-mobile');
  });

  it('renders an explicit unavailable cell for a listing that cannot be hydrated', async () => {
    const { seller, bootsListing } = await fixtures;
    view.cachedByListingId = new Map<string, unknown>([['boots_01', bootsListing]]);

    const screen = await renderForVRT(
      <CollectionListingItems
        listings={[
          { sellerPubky: seller, listingId: 'boots_01' },
          { sellerPubky: seller, listingId: 'gone_listing_0' },
        ]}
      />,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('collection-listing-unavailable-desktop');
  });
});
