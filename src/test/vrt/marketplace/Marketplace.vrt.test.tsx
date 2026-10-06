// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFeatureDiscoveryStorageKey, MARKETPLACE_PROMO_STORAGE_ID } from '@/config/featureDiscovery';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { Marketplace } from '@/templates/Marketplace/Marketplace';

// No rate in this capture: the indicative-rate hook resolves to null (no
// rate -> no estimate), keeping the scenario network-free and byte-identical
// to the pre-estimate baseline.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

const VRT_USER_PUBKY = vi.hoisted(() => 'y'.repeat(52));

const catalogView = vi.hoisted(() => ({ adapterMode: 'sandbox' as string }));

const fixtures = vi.hoisted(async () => {
  const { createCommerceSandboxCatalog } = await import('@/libs/commerce/sandbox-catalog');
  const { buildMarketplaceCatalogItems } = await import('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils');
  const { toCommerceListingModel } = await import('@/test/fixtures/commerce/listing-models');

  const catalog = createCommerceSandboxCatalog();
  return {
    listings: buildMarketplaceCatalogItems(catalog.listings.map(toCommerceListingModel), []),
    shopsBySeller: new Map(catalog.shops.map((shop) => [shop.ownerPubky, shop])),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace',
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: (action: () => void) => action() }),
}));

// These scenes represent the staging deploy: the staging environment banner
// is part of the home surface there, so the baselines name the environment
// explicitly instead of inheriting whatever the VRT browser resolves.
vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => 'staging' };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: VRT_USER_PUBKY }),
}));

vi.mock('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog', async () => {
  const catalog = await fixtures;
  return {
    useMarketplaceCatalog: () => ({
      listings: catalog.listings,
      facetPool: catalog.listings,
      shopsBySeller: catalog.shopsBySeller,
      isLoading: false,
      adapterMode: catalogView.adapterMode,
    }),
  };
});

// The card watch toggle reads live favorite state; VRT keeps every card at
// the unwatched baseline (toggle states are captured in the watchlist VRT).
vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: false, isLoading: false, isMutating: false, toggle: vi.fn() }),
}));

// Detection is a visit-triggered network/Dexie pass — a no-op for screenshots.
vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

// Nav badges read live Dexie/service state; zero keeps these baselines at the
// no-badge nav (populated badges are captured in MarketplaceNavBadges VRT).
vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 0,
}));
vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 0,
}));

vi.mock('@/hooks/useMarketplaceSavedSearches/useMarketplaceSavedSearches', () => ({
  useMarketplaceSavedSearches: () => ({
    searches: [
      {
        id: 'saved-1',
        owner_id: VRT_USER_PUBKY,
        name: 'Film cameras under $200',
        params: {
          query: 'camera',
          categoryId: null,
          saleFormat: 'all',
          conditions: [],
          minimumPriceMinor: null,
          maximumPriceMinor: 20_000,
          sort: 'newest',
        },
        watermark_updated_at: 1_000,
        latest_match_updated_at: 5_000,
        new_count: 3,
        last_checked_at: 6_000,
        created_at: 100,
      },
      {
        id: 'saved-2',
        owner_id: VRT_USER_PUBKY,
        name: 'Ending-soon auctions',
        params: {
          query: '',
          categoryId: null,
          saleFormat: 'auction',
          conditions: [],
          minimumPriceMinor: null,
          maximumPriceMinor: null,
          sort: 'ending_soon',
        },
        watermark_updated_at: 5_000,
        latest_match_updated_at: 5_000,
        new_count: 0,
        last_checked_at: 6_000,
        created_at: 200,
      },
    ],
    isSignedIn: true,
    saveCurrentSearch: vi.fn(async () => true),
    applySearch: vi.fn(async () => {}),
    deleteSearch: vi.fn(async () => {}),
  }),
}));

// The sandbox records carry pubky:// media URIs whose bytes exist nowhere a
// VRT browser could fetch them. Resolving to null renders the deterministic
// gradient fallback (the same honest state a failed load ends in) instead of
// racing a doomed network request during the screenshot. Cards WITH loaded
// images are captured in MarketplaceListingCards.vrt.test.tsx via a data URI.
vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace — visual regression', () => {
  beforeEach(() => {
    window.localStorage.clear();
    catalogView.adapterMode = 'sandbox';
  });

  it('renders the sandbox catalog with the promo visible at desktop viewport', async () => {
    const screen = await renderForVRT(<Marketplace />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('marketplace-desktop');
  });

  it('renders the sandbox catalog with the promo dismissed at desktop viewport', async () => {
    window.localStorage.setItem(
      buildFeatureDiscoveryStorageKey(VRT_USER_PUBKY, MARKETPLACE_PROMO_STORAGE_ID),
      'dismissed',
    );
    const screen = await renderForVRT(<Marketplace />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('marketplace-promo-dismissed-desktop');
  });

  it('renders the sandbox catalog at mobile viewport', async () => {
    const screen = await renderForVRT(<Marketplace />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('marketplace-mobile');
  });
});
