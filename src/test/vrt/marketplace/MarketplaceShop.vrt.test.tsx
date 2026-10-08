// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore, createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceShop } from '@/templates/Marketplace/MarketplaceShop';
import { setSocialHost } from '@/test-utils/social-host';

// No rate in this capture: the indicative-rate hook resolves to null (no
// rate -> no estimate), keeping the scenario network-free and byte-identical
// to the pre-estimate baseline.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

const fixtures = vi.hoisted(async () => {
  const { createCommerceListingFixture, createCommerceShopFixture, COMMERCE_FIXTURE_SELLER } =
    await import('@/test/fixtures/commerce/commerce');
  const { toCommerceListingModel, toCommerceShopModel } = await import('@/test/fixtures/commerce/listing-models');

  const listingEntry = (
    listingId: string,
    title: string,
    categoryId: string,
    amountMinor: number,
    colorHash: string,
    auction = false,
  ) =>
    toCommerceListingModel(
      createCommerceListingFixture({
        listingId,
        title,
        categoryId,
        media: [
          {
            id: `${listingId}_image`,
            type: 'image',
            url: `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/${listingId}_image`,
            contentHash: colorHash.repeat(64),
            mimeType: 'image/jpeg',
            byteSize: 10_000,
            width: 1_200,
            height: 1_600,
            altText: title,
          },
        ],
        sale: auction
          ? {
              format: 'auction',
              startingPrice: { amountMinor, currency: 'USD', exponent: 2 },
              minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
              startsAt: '2026-08-19T20:00:00.000Z',
              endsAt: '2026-08-29T20:00:00.000Z',
              antiSnipingWindowSeconds: 120,
              antiSnipingExtensionSeconds: 120,
            }
          : {
              format: 'fixed_price',
              unitPrice: { amountMinor, currency: 'USD', exponent: 2 },
              acceptsOffers: true,
            },
      }),
    );

  return {
    seller: COMMERCE_FIXTURE_SELLER,
    shop: toCommerceShopModel(createCommerceShopFixture()),
    brandedShop: toCommerceShopModel(
      createCommerceShopFixture({
        avatarUrl: `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/shop_avatar`,
        bannerUrl: `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/shop_banner`,
      }),
    ),
    vacationShop: toCommerceShopModel(createCommerceShopFixture({ vacationMode: true })),
    listings: [
      listingEntry('leather_boots', 'Vintage leather boots', 'fashion-shoes-boots', 12_500, 'a'),
      listingEntry('selvedge_jacket', 'Selvedge denim jacket', 'fashion-jackets', 8_900, 'b'),
      listingEntry('rangefinder_camera', '35mm rangefinder camera', 'electronics-cameras-film', 4_500, 'c', true),
      listingEntry('ceramic_vase', 'Hand-thrown ceramic vase', 'home-decor-ceramics', 6_400, 'd'),
    ],
  };
});

const view = vi.hoisted(() => ({
  shop: undefined as unknown,
  listings: undefined as unknown,
  catalogEntries: undefined as unknown,
  currentUserPubky: 'u'.repeat(52),
  shopTags: [] as unknown[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ getCurrentUserPubky: () => view.currentUserPubky }),
}));

// The community-tags hook uses an async live-query, so a synchronous
// passthrough would surface a Promise. Unwrap into state; the browser-mode
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
    getShop: () => view.shop,
    getOrFetchShop: () =>
      view.shop ? Promise.resolve((view.shop as { record: unknown }).record) : Promise.reject(new Error('no shop')),
    fetchSellerCatalogListings: () => Promise.resolve(),
    getListingsBySeller: () => view.listings,
    getCatalogEntriesBySeller: () => view.catalogEntries,
    getShopTags: () => view.shopTags,
    fetchShopTags: () => Promise.resolve([]),
    // Cards carry a watch toggle; VRT keeps them at the unwatched baseline.
    // The toggle's favorite hook and the live-bid hook read through the
    // controller, so every static the card reaches stays on the mock.
    isFavorite: () => Promise.resolve(false),
    commitCreateFavorite: () => Promise.resolve(),
    commitDeleteFavorite: () => Promise.resolve(),
    getMarketplaceListingProjection: () => Promise.resolve(null),
    // No reputation-aware index in these scenarios: the rating header and the
    // reviews section render nothing, keeping the existing baselines. The
    // review surfaces have their own VRT file (MarketplaceReviewsPublic).
    fetchSellerReputation: () => Promise.resolve({ status: 'unavailable' }),
    fetchSellerReviews: () => Promise.resolve({ status: 'unavailable' }),
    fetchListingReviews: () => Promise.resolve({ status: 'unavailable' }),
  },
}));

vi.mock('@/hooks/useCommerceShopFollow/useCommerceShopFollow', () => ({
  useCommerceShopFollow: () => ({ isFollowing: false, isMutating: false, toggle: vi.fn() }),
}));

// Fixture media URIs have no fetchable bytes in VRT; null keeps the honest
// gradient fallback deterministic (loaded-image cards are captured in
// MarketplaceListingCards.vrt.test.tsx captures loaded-image cards via a data
// URI; this scene keeps the honest gradient fallback.

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ isAuthenticated: true, requireAuth: (action: () => void) => action() }),
}));

// Pass tags through unchanged: enrichment reads user details from the local
// DB, which VRT deliberately does not exercise.
vi.mock('@/hooks/useEnrichedTags/useEnrichedTags', () => ({
  useEnrichedTags: (tags: unknown[]) => ({ enrichedTags: tags, isLoading: false }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace shop — visual regression', () => {
  it('renders a populated shop at desktop viewport', async () => {
    const { seller, shop, listings } = await fixtures;
    view.currentUserPubky = 'u'.repeat(52);
    view.shop = shop;
    view.listings = listings;
    view.catalogEntries = [];

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-populated-desktop');
  });

  it('renders the Profile on Pubky action under social link-out at desktop viewport', async () => {
    const { seller, shop, listings } = await fixtures;
    view.currentUserPubky = 'u'.repeat(52);
    view.shop = shop;
    view.listings = listings;
    view.catalogEntries = [];
    setSocialHost('https://pubky.app');
    try {
      const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
        viewport: VRT_VIEWPORT_DESKTOP,
        disableHover: true,
      });
      await expect
        .element(screen.getByRole('link', { name: 'Profile on Pubky' }))
        .toHaveAttribute('href', `https://pubky.app/profile/${seller}`);
      await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-social-linkout-desktop');
    } finally {
      setSocialHost(undefined);
    }
  });

  it('renders the no-shop fallback under social link-out at desktop viewport', async () => {
    const { seller, listings } = await fixtures;
    view.currentUserPubky = 'u'.repeat(52);
    view.shop = null;
    view.listings = listings;
    view.catalogEntries = [];
    setSocialHost('https://pubky.app');
    try {
      const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
        viewport: VRT_VIEWPORT_DESKTOP,
        disableHover: true,
      });
      await vi.waitFor(() => {
        if (!screen.container.textContent?.includes('hasn’t set up a shop profile yet')) {
          throw new Error('The no-shop fallback has not rendered yet.');
        }
      });
      await expect
        .element(screen.getByRole('link', { name: 'Profile on Pubky' }))
        .toHaveAttribute('href', `https://pubky.app/profile/${seller}`);
      await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-no-record-social-linkout-desktop');
    } finally {
      setSocialHost(undefined);
    }
  });

  it('renders a populated shop at mobile viewport', async () => {
    const { seller, shop, listings } = await fixtures;
    view.shop = shop;
    view.listings = listings;
    view.catalogEntries = [];

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_MOBILE,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-populated-mobile');
  });

  it('renders a shop with a banner and avatar at desktop viewport', async () => {
    const { seller, brandedShop, listings } = await fixtures;
    view.currentUserPubky = 'u'.repeat(52);
    view.shop = brandedShop;
    view.listings = listings;
    view.catalogEntries = [];

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-branding-desktop');
  });

  it('renders a shop with a banner and avatar at mobile viewport', async () => {
    const { seller, brandedShop, listings } = await fixtures;
    view.shop = brandedShop;
    view.listings = listings;
    view.catalogEntries = [];

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_MOBILE,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-branding-mobile');
  });

  it('renders shop community tags at desktop viewport', async () => {
    const { seller, shop, listings } = await fixtures;
    view.shop = shop;
    view.listings = listings;
    view.catalogEntries = [];
    view.shopTags = [
      { label: 'trusted', taggers: ['t'.repeat(52), 'v'.repeat(52)], taggers_count: 2, relationship: true },
      { label: 'fast-shipping', taggers: ['w'.repeat(52)], taggers_count: 1, relationship: false },
    ];

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-community-tags-desktop');
    view.shopTags = [];
  });

  it('renders a shop in vacation mode at desktop viewport', async () => {
    const { seller, vacationShop, listings } = await fixtures;
    view.shop = vacationShop;
    view.listings = listings;
    view.catalogEntries = [];

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-vacation-mode-desktop');
  });

  it('renders a shop with no listings at desktop viewport', async () => {
    const { seller, shop } = await fixtures;
    view.shop = shop;
    view.listings = [];
    view.catalogEntries = [];

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-no-listings-desktop');
  });

  it('renders the loading skeleton at desktop viewport', async () => {
    const { seller } = await fixtures;
    view.shop = undefined;
    view.listings = undefined;
    view.catalogEntries = undefined;

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-loading-desktop');
  });

  // A seller who never created a shop record must NOT dead-end visitors:
  // the page shows the seller identity and their listings instead.
  it('renders the no-shop fallback with listings for a visitor at desktop viewport', async () => {
    const { seller, listings } = await fixtures;
    view.currentUserPubky = 'u'.repeat(52);
    view.shop = null;
    view.listings = listings;
    view.catalogEntries = [];

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('hasn’t set up a shop profile yet')) {
        throw new Error('The no-shop fallback has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-no-record-visitor-desktop');
  });

  it('renders the no-shop fallback with the set-up prompt for the owner at desktop viewport', async () => {
    const { seller, listings } = await fixtures;
    view.currentUserPubky = seller;
    view.shop = null;
    view.listings = listings;
    view.catalogEntries = [];

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('Add a shop name, description, and images to personalize your storefront.')) {
        throw new Error('The owner set-up prompt has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-no-record-owner-desktop');
  });

  it('renders the no-shop fallback for a visitor at mobile viewport', async () => {
    const { seller, listings } = await fixtures;
    view.currentUserPubky = 'u'.repeat(52);
    view.shop = null;
    view.listings = listings;
    view.catalogEntries = [];

    const screen = await renderForVRT(<MarketplaceShop sellerPubky={seller} />, {
      viewport: VRT_VIEWPORT_MOBILE,
      disableHover: true,
    });
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('hasn’t set up a shop profile yet')) {
        throw new Error('The no-shop fallback has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('shop-no-record-visitor-mobile');
  });
});
