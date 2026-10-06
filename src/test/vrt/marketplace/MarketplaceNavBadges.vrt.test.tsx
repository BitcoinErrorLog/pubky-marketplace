// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFeatureDiscoveryStorageKey, MARKETPLACE_PROMO_STORAGE_ID } from '@/config/featureDiscovery';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { Marketplace } from '@/templates/Marketplace/Marketplace';

/**
 * The honest count badges on the marketplace nav pills: the Cart badge shows
 * exactly what the cart page shows, and the Activity badge shows the
 * device-local unread count (see the hooks' contracts). Zero renders NO
 * badge — that state is asserted here explicitly, not just implied by the
 * plain-nav baselines in Marketplace.vrt.
 */

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

const VRT_USER_PUBKY = vi.hoisted(() => 'y'.repeat(52));

const badgeCounts = vi.hoisted(() => ({ cart: 0, activity: 0 }));

const fixtures = vi.hoisted(async () => {
  const { createCommerceSandboxCatalog } = await import('@/libs/commerce/sandbox-catalog');
  const { buildMarketplaceCatalogItems } = await import('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils');
  const { toCommerceListingModel } = await import('@/test/fixtures/commerce/listing-models');

  const catalog = createCommerceSandboxCatalog();
  return {
    listings: buildMarketplaceCatalogItems(catalog.listings.map(toCommerceListingModel), []).slice(0, 4),
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

// Same staging-deploy framing as Marketplace.vrt: the staging environment
// banner is part of the nav surface on staging, so these baselines name the
// environment explicitly.
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
      adapterMode: 'sandbox',
    }),
  };
});

vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: false, isLoading: false, isMutating: false, toggle: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

// The badge hooks are the units under their own tests; VRT pins their output
// so the capture shows the rendered badge states deterministically.
vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => badgeCounts.cart,
}));
vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => badgeCounts.activity,
}));

vi.mock('@/hooks/useMarketplaceSavedSearches/useMarketplaceSavedSearches', () => ({
  useMarketplaceSavedSearches: () => ({
    searches: [],
    isSignedIn: true,
    saveCurrentSearch: vi.fn(async () => true),
    applySearch: vi.fn(async () => {}),
    deleteSearch: vi.fn(async () => {}),
  }),
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace nav badges — visual regression', () => {
  beforeEach(() => {
    badgeCounts.cart = 0;
    badgeCounts.activity = 0;
    window.localStorage.clear();
    // The promo is captured by Marketplace.vrt; dismissing it keeps these
    // baselines focused on the nav pills.
    window.localStorage.setItem(
      buildFeatureDiscoveryStorageKey(VRT_USER_PUBKY, MARKETPLACE_PROMO_STORAGE_ID),
      'dismissed',
    );
  });

  it('renders the Cart and Activity badges populated at desktop viewport', async () => {
    badgeCounts.cart = 3;
    badgeCounts.activity = 5;

    const screen = await renderForVRT(<Marketplace />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect.element(screen.getByLabelText('3 cart items')).toBeInTheDocument();
    await expect.element(screen.getByLabelText('5 activity needing you')).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('marketplace-nav-badges-desktop');
  });

  it('caps the displayed count at 21+ like the header badge at desktop viewport', async () => {
    badgeCounts.cart = 2;
    badgeCounts.activity = 25;

    const screen = await renderForVRT(<Marketplace />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect
      .element(screen.getByTestId('marketplace-section-nav-activity-badge').getByText('21+'))
      .toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('marketplace-nav-badges-capped-desktop');
  });

  it('renders NO badges at zero counts at desktop viewport', async () => {
    const screen = await renderForVRT(<Marketplace />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    expect(document.querySelector('[data-cy="marketplace-nav-cart-counter"]')).toBeNull();
    expect(document.querySelector('[data-cy="marketplace-nav-activity-counter"]')).toBeNull();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('marketplace-nav-badges-zero-desktop');
  });

  it('renders the populated badges at mobile viewport', async () => {
    badgeCounts.cart = 1;
    badgeCounts.activity = 2;

    const screen = await renderForVRT(<Marketplace />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect.element(screen.getByTestId('marketplace-section-nav')).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('marketplace-nav-badges-mobile');
  });
});
