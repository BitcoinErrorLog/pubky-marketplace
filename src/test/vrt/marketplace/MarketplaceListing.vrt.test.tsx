// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore, createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_DENSE_CHROME_SCREENSHOT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceListing } from '@/templates/Marketplace/MarketplaceListing';

// Deterministic BTC/USD rate for the capture (1 BTC = $100,000): the "≈"
// estimates render from this fixed value, never from the network.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: (enabled: boolean) =>
    enabled ? { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') } : null,
}));

// Record media resolves to a deterministic portrait data-URI (8×16, orange
// over teal) so the gallery captures a REAL loaded image without a network
// fetch. The listing fixture declares 1200×1600; a square 8×8 made
// object-cover vs object-contain indistinguishable in the reserved frame.
const MEDIA_DATA_URL = vi.hoisted(
  () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAQCAIAAACk6KkqAAAAGUlEQVR42mN4UaKEFTEMMQmtuf1Y0RCTAAByT7UBUCR7sgAAAABJRU5ErkJggg==',
);

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks((uri) => (uri ? MEDIA_DATA_URL : null));
});

const fixtures = vi.hoisted(async () => {
  const { createCommerceListingFixture, createCommerceShopFixture, COMMERCE_FIXTURE_SELLER } =
    await import('@/test/fixtures/commerce/commerce');
  const { toCommerceListingModel, toCommerceShopModel } = await import('@/test/fixtures/commerce/listing-models');
  const { createAuctionProjectionFixture, createListingProjectionFixture } =
    await import('@/test/fixtures/commerce/projections');

  const seller = COMMERCE_FIXTURE_SELLER;
  const twoVariants = (quantity: number) => [
    { id: 'variant_42', options: { size: '42' }, quantity, mediaIds: ['image_01'], enabled: true },
    { id: 'variant_43', options: { size: '43' }, quantity, mediaIds: ['image_01'], enabled: true },
  ];
  const galleryImage = (id: string, altText: string) => ({
    id,
    type: 'image' as const,
    url: `pubky://${seller}/pub/pubky.app/marketplace/v1/media/${id}`,
    contentHash: 'c'.repeat(64),
    mimeType: 'image/jpeg',
    byteSize: 10_000,
    width: 1_200,
    height: 1_600,
    altText,
  });

  return {
    galleryListing: toCommerceListingModel(
      createCommerceListingFixture({
        media: [
          galleryImage('image_01', 'Front view'),
          galleryImage('image_02', 'Sole view'),
          galleryImage('image_03', 'Detail view'),
        ],
      }),
    ),
    seller,
    shop: toCommerceShopModel(createCommerceShopFixture()),
    brandedShop: toCommerceShopModel(
      createCommerceShopFixture({
        avatarUrl: `pubky://${seller}/pub/pubky.app/marketplace/v1/media/shop_avatar`,
      }),
    ),
    fixedPriceListing: toCommerceListingModel(createCommerceListingFixture({ variants: twoVariants(2) })),
    soldOutListing: toCommerceListingModel(createCommerceListingFixture({ variants: twoVariants(0) })),
    auctionListing: toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'rangefinder_camera',
        title: '35mm rangefinder camera',
        description: 'Recently serviced mechanical rangefinder with bright optics.',
        categoryId: 'electronics-cameras-film',
        condition: 'excellent',
        tags: ['film', 'camera'],
        sale: {
          format: 'auction',
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          startsAt: '2026-08-19T20:00:00.000Z',
          endsAt: '2026-08-29T20:00:00.000Z',
          antiSnipingWindowSeconds: 120,
          antiSnipingExtensionSeconds: 120,
        },
      }),
    ),
    endedAuctionListing: toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'ended_rangefinder',
        title: 'Ended rangefinder camera',
        sale: {
          format: 'auction',
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          startsAt: '2026-08-19T20:00:00.000Z',
          endsAt: '2026-08-29T20:00:00.000Z',
          antiSnipingWindowSeconds: 120,
          antiSnipingExtensionSeconds: 120,
        },
      }),
    ),
    digitalListing: toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'field_recordings',
        title: 'Field recordings archive (digital)',
        description: 'Locks-gated download of a 24-bit field recording collection.',
        categoryId: 'collectibles-music-vinyl',
        condition: 'new',
        tags: ['digital', 'audio'],
        fulfillmentMethods: ['digital'],
        digitalLock: {
          policyUri: `pubky://${seller}/pub/locks.app/policies/field_recordings.json`,
          criterionId: 'criterion-1',
          contentPath: 'field_recordings/archive.zip',
          resourceHash: 'a'.repeat(64),
          minimumConfirmations: 3,
        },
      }),
    ),
    attributedListing: toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'varsity_fleece',
        title: 'Heavyweight varsity fleece',
        description: 'Boxy 90s collegiate fleece with an embroidered chest hit.',
        categoryId: 'fashion-men-tops-hoodies',
        attributes: {
          size: 'L',
          brand: 'Champion',
          color: ['grey', 'navy'],
          source: 'vintage',
          age: '90s',
          style: ['retro', 'sportswear'],
          // A key this build's taxonomy does not define: renders as a
          // prettified label with the raw value instead of being dropped.
          'graded-by': 'PSA 9',
        },
      }),
    ),
    pausedListing: toCommerceListingModel(createCommerceListingFixture({ state: 'paused' })),
    vacationShop: toCommerceShopModel(createCommerceShopFixture({ vacationMode: true })),
    fixedPriceProjection: createListingProjectionFixture(),
    auctionProjection: createAuctionProjectionFixture(),
    // Marketplace-held digital delivery (digital delivery design §3): a
    // digital-only file listing, and one that ships or is emailed.
    fileListing: toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'field_guide',
        title: 'Printable field guide',
        description: 'A 40-page printable guide to coastal birds.',
        condition: 'new',
        fulfillmentMethods: ['digital'],
        package: undefined,
        shippingOptions: [],
      }),
    ),
    fileProjection: createListingProjectionFixture({
      listingId: 'field_guide',
      fulfillmentMethods: ['digital'],
      digitalDelivery: { kind: 'file', contentType: 'application/pdf', sizeBytes: 12_582_912 },
    }),
    unlimitedListing: toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'field_guide_unlimited',
        title: 'Printable field guide',
        description: 'A 40-page printable guide to coastal birds.',
        condition: 'new',
        fulfillmentMethods: ['digital'],
        package: undefined,
        shippingOptions: [],
        variants: [
          {
            id: 'variant_pdf',
            options: { size: 'PDF' },
            quantity: 1_000_000,
            mediaIds: ['image_01'],
            enabled: true,
          },
          {
            id: 'variant_epub',
            options: { size: 'EPUB' },
            quantity: 1_000_000,
            mediaIds: ['image_01'],
            enabled: true,
          },
        ],
      }),
    ),
    unlimitedProjection: createListingProjectionFixture({
      listingId: 'field_guide_unlimited',
      fulfillmentMethods: ['digital'],
      availableQuantity: 1_000_000,
      digitalDelivery: { kind: 'file', contentType: 'application/pdf', sizeBytes: 12_582_912 },
    }),
    shipOrEmailListing: toCommerceListingModel(
      createCommerceListingFixture({ fulfillmentMethods: ['physical', 'shipping', 'digital'] }),
    ),
    shipOrEmailProjection: createListingProjectionFixture({
      fulfillmentMethods: ['shipping', 'digital'],
      digitalDelivery: { kind: 'email' },
    }),
  };
});

const view = vi.hoisted(() => ({
  adapterMode: 'sandbox' as 'sandbox' | 'unavailable' | 'locks-paykit' | 'transaction-service',
  listing: undefined as unknown,
  shop: undefined as unknown,
  projection: null as unknown,
  reputation: { status: 'new_seller' as const } as unknown,
  fetchFails: false,
  currentUserPubky: 'u'.repeat(52) as string | null,
  listingTags: [] as unknown[],
  needsSession: false,
  orders: [] as Array<{
    order: { id: string; buyerPubky: string; state: string; lines: Array<{ listingAggregateId: string }> };
  }>,
  offers: [] as Array<{
    id: string;
    state: string;
    buyerPubky: string;
    listingAggregateId: string;
    award?: { state: string } | null;
  }>,
  sessionPubky: null as string | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace',
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: (action: () => void) => action() }),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ getCurrentUserPubky: () => view.currentUserPubky, session: {} }),
}));

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => view.adapterMode };
});

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
    getListing: () => view.listing,
    getShop: () => view.shop,
    getOrFetchListing: () => (view.fetchFails ? Promise.reject(new Error('offline')) : Promise.resolve(null)),
    isListingConfirmedRemoved: () => Promise.resolve(false),
    getListingTags: () => view.listingTags,
    fetchListingTags: () => Promise.resolve([]),
    getMarketplaceMediaOwnerHomeserver: (_ownerPubky: unknown) => Promise.resolve(null),
    hasFullHomeserverGrant: () => true,
    // The owner panel self-heals listing registration on mount; VRT renders
    // the visual outcome only, so the call resolves without side effects.
    ensureListingRegistered: () => Promise.resolve(false),
    canRegisterListings: () => true,
    fetchSellerReputation: () => Promise.resolve(view.reputation),
    fetchSellerReviews: () => Promise.resolve({ status: 'unavailable' }),
    fetchListingReviews: () => Promise.resolve({ status: 'unavailable' }),
  },
}));

// Pass tags through unchanged: enrichment reads user details from the local
// DB, which VRT deliberately does not exercise.
vi.mock('@/hooks/useEnrichedTags/useEnrichedTags', () => ({
  useEnrichedTags: (tags: unknown[]) => ({ enrichedTags: tags, isLoading: false }),
}));

vi.mock('@/hooks/useAuthoredCollections/useAuthoredCollections', () => ({
  useAuthoredCollections: () => ({ collections: [], isLoading: false }),
}));

vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: false, isMutating: false, toggle: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', () => ({
  useMarketplaceCart: () => ({
    items: [],
    itemCount: 0,
    subtotals: [],
    isLoading: false,
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  }),
}));

vi.mock('@/services/marketplace/marketplace-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/marketplace/marketplace-session')>();
  const service = actual.MarketplaceSessionService;
  service.getActiveSession = () => {
    if (!view.sessionPubky) return null;
    return {
      pubky: view.sessionPubky,
      capabilities: '/pub/pubky.app/:rw',
      expiresAt: '2026-09-21T12:00:00.000Z',
      issuedAt: '2026-08-21T12:00:00.000Z',
      expiresAtMs: Date.now() + 60 * 60 * 1000,
      token: 'vrt-session',
    } as ReturnType<typeof service.getActiveSession>;
  };
  return actual;
});

vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({
    offers: view.offers,
    isLoading: false,
    error: null,
    needsSession: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: view.orders,
    isLoading: false,
    error: null,
    needsSession: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceProjection/useMarketplaceProjection', () => ({
  useMarketplaceProjection: () => ({
    projection: view.projection,
    isLoading: false,
    error: null,
    needsSession: view.needsSession,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceMessages/useMarketplaceMessages', async () => {
  const { useForm } = await import('react-hook-form');
  const { marketplaceMessageDefaults } = await import('@/hooks/useMarketplaceMessages/useMarketplaceMessages.types');
  return {
    useMarketplaceMessages: () => ({
      form: useForm({ defaultValues: marketplaceMessageDefaults }),
      conversation: null,
      isLoading: false,
      error: null,
      isSandbox: view.adapterMode === 'sandbox',
      attachment: {
        file: null,
        previewUrl: null,
        error: null,
        inputRef: { current: null },
        onInputChange: vi.fn(),
        choose: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
        upload: vi.fn(),
      },
      submit: vi.fn(async () => false),
      refresh: vi.fn(async () => {}),
    }),
  };
});

vi.mock('@/hooks/useMarketplaceBid/useMarketplaceBid', async () => {
  const { useForm } = await import('react-hook-form');
  const { marketplaceBidDefaults } = await import('@/hooks/useMarketplaceBid/useMarketplaceBid.types');
  return {
    useMarketplaceBid: () => ({
      form: useForm({ defaultValues: marketplaceBidDefaults }),
      submit: vi.fn(async () => false),
      reset: vi.fn(),
    }),
  };
});

vi.mock('@/hooks/useMarketplaceOffer/useMarketplaceOffer', async () => {
  const { useForm } = await import('react-hook-form');
  const { marketplaceOfferDefaults } = await import('@/hooks/useMarketplaceOffer/useMarketplaceOffer.types');
  return {
    useMarketplaceOffer: () => ({
      form: useForm({ defaultValues: marketplaceOfferDefaults }),
      submit: vi.fn(async () => false),
      reset: vi.fn(),
    }),
  };
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

async function setView(overrides: Partial<typeof view>) {
  const { shop } = await fixtures;
  view.adapterMode = 'sandbox';
  view.listing = undefined;
  view.shop = shop;
  view.projection = null;
  view.reputation = { status: 'new_seller' };
  view.fetchFails = false;
  view.currentUserPubky = 'u'.repeat(52);
  view.listingTags = [];
  view.needsSession = false;
  view.orders = [];
  view.offers = [];
  view.sessionPubky = null;
  Object.assign(view, overrides);
}

// The display store persists to localStorage, which the VRT browser shares
// across test files — pin the defaults so captures never depend on what a
// previously-run file left behind.
beforeEach(async () => {
  const { useMarketplaceDisplayStore } = await import('@/stores/marketplace-display/marketplace-display.store');
  useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: 'metric' });
});

describe('Marketplace listing detail — visual regression', () => {
  it('renders the item-specifics table with vocab labels and a foreign key at desktop viewport', async () => {
    const { seller, attributedListing, fixedPriceProjection } = await fixtures;
    await setView({ listing: attributedListing, projection: fixedPriceProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="varsity_fleece" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-item-specifics-desktop');
  });

  it('renders a fixed-price listing at desktop viewport', async () => {
    const { seller, fixedPriceListing, fixedPriceProjection } = await fixtures;
    await setView({ listing: fixedPriceListing, projection: fixedPriceProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-fixed-price-desktop');
  });

  it('renders the media gallery with a main image and thumbnail strip at desktop viewport', async () => {
    const { seller, galleryListing, fixedPriceProjection } = await fixtures;
    await setView({ listing: galleryListing, projection: fixedPriceProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-media-gallery-desktop');
  });

  it('renders the seller block with the shop avatar at desktop viewport', async () => {
    const { seller, fixedPriceListing, fixedPriceProjection, brandedShop } = await fixtures;
    await setView({
      listing: fixedPriceListing,
      projection: fixedPriceProjection,
      shop: brandedShop,
      reputation: {
        status: 'rated',
        summary: {
          count: 18,
          verifiedCount: 14,
          avg: 4.8,
          histogram: [0, 0, 1, 3, 14],
          responseCount: 5,
          editedLateCount: 0,
          attestors: {},
          lastReviewedAt: '2026-08-20T12:00:00.000Z',
        },
      },
    });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-shop-avatar-desktop');
  });

  it('renders a fixed-price listing at mobile viewport', async () => {
    const { seller, fixedPriceListing, fixedPriceProjection } = await fixtures;
    await setView({ listing: fixedPriceListing, projection: fixedPriceProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_MOBILE,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'listing-fixed-price-mobile',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders an auction listing with live bid state at desktop viewport', async () => {
    const { seller, auctionListing, auctionProjection } = await fixtures;
    await setView({ listing: auctionListing, projection: auctionProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="rangefinder_camera" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-auction-desktop');
  });

  it('renders an ended auction with bidding closed at desktop viewport', async () => {
    const { seller, endedAuctionListing, auctionProjection } = await fixtures;
    await setView({
      listing: endedAuctionListing,
      projection: {
        ...auctionProjection,
        auction: auctionProjection.auction
          ? { ...auctionProjection.auction, endsAt: '2026-08-29T20:00:00.000Z', status: 'ended' }
          : null,
      },
    });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="ended_rangefinder" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-auction-ended-desktop');
  });

  it('renders a digital listing with a Locks lock at desktop viewport', async () => {
    const { seller, digitalListing, fixedPriceProjection } = await fixtures;
    await setView({ listing: digitalListing, projection: fixedPriceProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="field_recordings" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-digital-locks-desktop');
  });

  // In locks-paykit mode the digital-delivery notice describes the REAL
  // post-checkout wallet flow instead of the fail-closed unavailability note
  // covered by the scenario above (non-locks-paykit modes).
  it('renders a digital listing with the live payment-rails notice at desktop viewport', async () => {
    const { seller, digitalListing, fixedPriceProjection } = await fixtures;
    await setView({ listing: digitalListing, projection: fixedPriceProjection, adapterMode: 'locks-paykit' });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="field_recordings" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-digital-locks-paykit-desktop');
  });

  it('renders unlimited stock on a digital variant picker at desktop viewport', async () => {
    const { seller, unlimitedListing, unlimitedProjection } = await fixtures;
    await setView({ listing: unlimitedListing, projection: unlimitedProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="field_guide_unlimited" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await vi.waitFor(() => {
      const trigger = screen.container.querySelector('[aria-label="Choose listing variant"]');
      if (!trigger?.textContent?.includes('Unlimited')) {
        throw new Error('Unlimited stock has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-unlimited-stock-desktop');
  });

  it('renders a digital-only file listing at desktop viewport', async () => {
    const { seller, fileListing, fileProjection } = await fixtures;
    await setView({ listing: fileListing, projection: fileProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="field_guide" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-digital-file-desktop');
  });

  it('renders a listing that ships or is emailed at desktop viewport', async () => {
    const { seller, shipOrEmailListing, shipOrEmailProjection } = await fixtures;
    await setView({ listing: shipOrEmailListing, projection: shipOrEmailProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-ship-or-email-desktop');
  });

  it('renders community tags separated from seller keywords at desktop viewport', async () => {
    const { seller, fixedPriceListing, fixedPriceProjection } = await fixtures;
    await setView({
      listing: fixedPriceListing,
      projection: fixedPriceProjection,
      listingTags: [
        { label: 'handmade', taggers: ['t'.repeat(52), 'v'.repeat(52)], taggers_count: 2, relationship: true },
        { label: 'vintage', taggers: ['w'.repeat(52)], taggers_count: 1, relationship: false },
      ],
    });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-community-tags-desktop');
  });

  it('renders a sold-out listing at desktop viewport', async () => {
    const { seller, soldOutListing, fixedPriceProjection } = await fixtures;
    await setView({ listing: soldOutListing, projection: fixedPriceProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-sold-out-desktop');
  });

  it('renders the seller-owned listing with the management panel at desktop viewport', async () => {
    const { seller, fixedPriceListing, fixedPriceProjection } = await fixtures;
    await setView({ listing: fixedPriceListing, projection: fixedPriceProjection, currentUserPubky: seller });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-owner-panel-desktop');
  });

  it('renders the owner set-up-your-shop prompt when no shop record exists at desktop viewport', async () => {
    const { seller, fixedPriceListing, fixedPriceProjection } = await fixtures;
    await setView({
      listing: fixedPriceListing,
      projection: fixedPriceProjection,
      currentUserPubky: seller,
      shop: null,
    });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-owner-no-shop-desktop');
  });

  it('renders an unlisted (paused) listing for a visitor at desktop viewport', async () => {
    const { seller, pausedListing, fixedPriceProjection } = await fixtures;
    await setView({ listing: pausedListing, projection: fixedPriceProjection });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-unlisted-desktop');
  });

  it('renders the seller-on-vacation badge at desktop viewport', async () => {
    const { seller, fixedPriceListing, vacationShop, fixedPriceProjection } = await fixtures;
    await setView({ listing: fixedPriceListing, projection: fixedPriceProjection, shop: vacationShop });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-vacation-desktop');
  });

  it('renders the unavailable state at desktop viewport', async () => {
    const { seller } = await fixtures;
    await setView({ listing: null, shop: null });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="gone_listing" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-unavailable-desktop');
  });

  it('renders the load-error state at desktop viewport', async () => {
    const { seller } = await fixtures;
    await setView({ adapterMode: 'locks-paykit', listing: null, shop: null, fetchFails: true });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="broken_listing" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-error-desktop');
  });

  it('renders the loading skeleton at desktop viewport', async () => {
    const { seller } = await fixtures;
    await setView({ listing: undefined, shop: undefined });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-loading-desktop');
  });

  it('renders the logged-out purchase path at desktop viewport', async () => {
    const { seller, fixedPriceListing } = await fixtures;
    await setView({
      listing: fixedPriceListing,
      adapterMode: 'transaction-service',
      currentUserPubky: null,
      needsSession: true,
      projection: null,
    });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: { width: 1440, height: 1800 },
    });
    await expect(screen.getByRole('button', { name: 'Buy' })).toBeVisible();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-logged-out-desktop');
  });

  it('renders the logged-out purchase path at mobile viewport', async () => {
    const { seller, fixedPriceListing } = await fixtures;
    await setView({
      listing: fixedPriceListing,
      adapterMode: 'transaction-service',
      currentUserPubky: null,
      needsSession: true,
      projection: null,
    });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: { width: 390, height: 1800 },
    });
    await expect(screen.getByRole('button', { name: 'Buy' })).toBeVisible();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'listing-logged-out-mobile',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders Held for you when the viewer owns the checkout hold at desktop viewport', async () => {
    const { seller, fixedPriceListing, fixedPriceProjection } = await fixtures;
    const buyer = 'u'.repeat(52);
    await setView({
      listing: fixedPriceListing,
      adapterMode: 'transaction-service',
      currentUserPubky: buyer,
      projection: { ...fixedPriceProjection, state: 'reserved', availableQuantity: 0, reservedQuantity: 1 },
      orders: [
        {
          order: {
            id: '018f47d2-6a27-7c23-a49d-000000000001',
            buyerPubky: buyer,
            state: 'pending_payment',
            lines: [{ listingAggregateId: `listing:${seller}_boots_01` }],
          },
        },
      ],
    });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: { width: 1440, height: 1800 },
    });
    await expect(screen.getByRole('link', { name: 'Buy' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Held for you' })).toBeDisabled();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-held-for-you-desktop');
  });

  it('renders Held for you when the viewer owns the checkout hold at mobile viewport', async () => {
    const { seller, fixedPriceListing, fixedPriceProjection } = await fixtures;
    const buyer = 'u'.repeat(52);
    await setView({
      listing: fixedPriceListing,
      adapterMode: 'transaction-service',
      currentUserPubky: buyer,
      projection: { ...fixedPriceProjection, state: 'reserved', availableQuantity: 0, reservedQuantity: 1 },
      orders: [
        {
          order: {
            id: '018f47d2-6a27-7c23-a49d-000000000001',
            buyerPubky: buyer,
            state: 'pending_payment',
            lines: [{ listingAggregateId: `listing:${seller}_boots_01` }],
          },
        },
      ],
    });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: { width: 390, height: 2200 },
    });
    await expect(screen.getByRole('link', { name: 'Buy' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Held for you' })).toBeDisabled();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'listing-held-for-you-mobile',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('disables Make offer with hold copy while another buyer pays at desktop viewport', async () => {
    const { seller, fixedPriceListing, fixedPriceProjection } = await fixtures;
    await setView({
      listing: fixedPriceListing,
      adapterMode: 'transaction-service',
      currentUserPubky: 'u'.repeat(52),
      projection: { ...fixedPriceProjection, state: 'reserved', availableQuantity: 0, reservedQuantity: 1 },
    });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: { width: 1440, height: 1800 },
    });
    await expect(screen.getByRole('button', { name: 'Held while another buyer pays' })).toBeDisabled();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-held-another-desktop');
  });

  it('disables Make offer with hold copy while another buyer pays at mobile viewport', async () => {
    const { seller, fixedPriceListing, fixedPriceProjection } = await fixtures;
    await setView({
      listing: fixedPriceListing,
      adapterMode: 'transaction-service',
      currentUserPubky: 'u'.repeat(52),
      projection: { ...fixedPriceProjection, state: 'reserved', availableQuantity: 0, reservedQuantity: 1 },
    });

    const screen = await renderForVRT(<MarketplaceListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: { width: 390, height: 2200 },
    });
    await expect(screen.getByRole('button', { name: 'Held while another buyer pays' })).toBeDisabled();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'listing-held-another-mobile',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });
});
