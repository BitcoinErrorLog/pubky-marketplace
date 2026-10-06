// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceFilters } from '@/organisms/Marketplace/MarketplaceFilters';
import type { MarketplaceCatalogItem } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { commerceInitialState, type CommerceState } from '@/stores/commerce/commerce.types';

const auth = vi.hoisted(() => ({ currentUserPubky: null as string | null }));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({
    currentUserPubky: auth.currentUserPubky,
    selectCurrentUserPubky: () => auth.currentUserPubky,
  }),
}));

function setStoreState(overrides: Partial<CommerceState> = {}) {
  useCommerceStore.setState({ ...commerceInitialState, ...overrides });
}

// One record-backed catalog item whose attributes feed the facet chips.
const facetItem: MarketplaceCatalogItem = {
  id: 'seller:varsity_fleece',
  sellerId: 's'.repeat(52),
  listingId: 'varsity_fleece',
  state: 'active',
  title: 'Heavyweight varsity fleece',
  description: 'Boxy 90s collegiate fleece.',
  categoryId: 'fashion-men-tops-hoodies',
  condition: 'good',
  tags: [],
  saleFormat: 'fixed_price',
  price: { amountMinor: 7_200, currency: 'USD', exponent: 2 },
  auction: null,
  attributes: { size: 'L', brand: 'Champion', color: ['grey', 'navy'] },
  location: { countryCode: 'US', region: null },
  mediaUrls: [],
  reputation: null,
  revision: 1,
  updatedAt: 1_000,
};

function FiltersHarness({ resultCount, facetPool }: { resultCount: number; facetPool?: MarketplaceCatalogItem[] }) {
  return (
    <main className="w-full px-6 py-6">
      <MarketplaceFilters resultCount={resultCount} facetPool={facetPool} />
    </main>
  );
}

// Every capture here is non-interactive (state is set through the store, not
// clicks), so `disableHover` is safe and necessary: the browser pointer rests
// wherever the previous test file left it, and Chromium re-applies `:hover`
// to whatever chip sits beneath it — a nondeterministic capture.
describe('Marketplace filters — visual regression', () => {
  beforeEach(() => {
    auth.currentUserPubky = null;
  });

  it('renders the default filter bar at desktop viewport', async () => {
    setStoreState();

    const screen = await renderForVRT(<FiltersHarness resultCount={8} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('filters-default-desktop');
  });

  it('renders the default filter bar at mobile viewport', async () => {
    setStoreState();

    const screen = await renderForVRT(<FiltersHarness resultCount={8} />, {
      viewport: VRT_VIEWPORT_MOBILE,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('filters-default-mobile');
  });

  it('renders applied filters with the clear action at desktop viewport', async () => {
    setStoreState({ query: 'boots', categoryId: 'fashion', saleFormat: 'fixed_price', sort: 'price_low' });

    const screen = await renderForVRT(<FiltersHarness resultCount={3} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('filters-applied-desktop');
  });

  it('renders the list layout toggle selected at desktop viewport', async () => {
    setStoreState({ layout: 'list' });

    const screen = await renderForVRT(<FiltersHarness resultCount={8} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('filters-list-layout-desktop');
  });

  it('renders the zero-results emphasis at desktop viewport', async () => {
    setStoreState({ query: 'no matches expected', saleFormat: 'auction' });

    const screen = await renderForVRT(<FiltersHarness resultCount={0} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('filters-zero-results-desktop');
  });

  it('renders the category drill-down breadcrumb with child chips at desktop viewport', async () => {
    setStoreState({ categoryId: 'fashion-men-footwear' });

    const screen = await renderForVRT(<FiltersHarness resultCount={4} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('filters-category-drilldown-desktop');
  });

  it('renders attribute facet chips with an active size filter at desktop viewport', async () => {
    setStoreState({ categoryId: 'fashion', attributeFilters: { size: 'L' } });

    const screen = await renderForVRT(<FiltersHarness resultCount={1} facetPool={[facetItem]} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('filters-attribute-facets-desktop');
  });

  it('renders attribute facet chips at mobile viewport', async () => {
    setStoreState({ categoryId: 'fashion' });

    const screen = await renderForVRT(<FiltersHarness resultCount={1} facetPool={[facetItem]} />, {
      viewport: VRT_VIEWPORT_MOBILE,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('filters-attribute-facets-mobile');
  });

  it('renders the saved-searches trigger when signed in at desktop viewport', async () => {
    auth.currentUserPubky = 'v'.repeat(52);
    setStoreState();

    const screen = await renderForVRT(<FiltersHarness resultCount={8} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('filters-saved-trigger-desktop');
  });
});
