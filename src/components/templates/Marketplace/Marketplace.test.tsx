import { renderToString } from 'react-dom/server';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import {
  buildFeatureDiscoveryDeviceStorageKey,
  FEATURE_DISCOVERY_STORAGE_PREFIX,
  MARKETPLACE_PROMO_STORAGE_ID,
} from '@/config/featureDiscovery';
import { createCommerceShopFixture } from '@/test/fixtures/commerce/commerce';
import { Marketplace } from './Marketplace';

const routerPush = vi.hoisted(() => vi.fn());
const sellingAccess = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/hooks/useMarketplaceSellingAccess/useMarketplaceSellingAccess', () => ({
  useMarketplaceSellingAccess: () => ({ checkAccess: () => sellingAccess.allowed }),
}));
vi.mock('@/organisms/Marketplace/MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: ({
    intent,
    onOpenChange,
    onConnected,
  }: {
    intent: string;
    onOpenChange: (open: boolean) => void;
    onConnected: () => void;
  }) => (
    <div role="dialog" aria-label={intent}>
      <button onClick={() => onOpenChange(false)}>Cancel approval</button>
      <button onClick={onConnected}>Complete approval</button>
    </div>
  ),
}));
const setSaleFormat = vi.hoisted(() => vi.fn());
const promoDismiss = vi.hoisted(() => vi.fn());
const promoState = vi.hoisted(() => ({ showPromo: false, isResolved: true }));
const navCounts = vi.hoisted(() => ({ cart: 0, activity: 0 }));
const catalogState = vi.hoisted(() => ({
  listings: [] as Array<{ id: string; title: string }>,
  isLoading: false,
  adapterMode: 'sandbox' as 'sandbox' | 'transaction-service' | 'locks-paykit' | 'unavailable',
}));
const runtime = vi.hoisted(() => ({ deployEnv: 'staging' as 'production' | 'staging' | undefined }));
const commerceState = vi.hoisted(() => ({
  query: '',
  setQuery: vi.fn(),
  saleFormat: 'all' as string,
  categoryId: '',
  countryCode: '',
  sort: 'newest',
  layout: 'grid' as const,
  setSaleFormat,
}));
const dropEntry = vi.hoisted(() => ({
  id: 'drop-1',
  owner_id: 'y'.repeat(52),
  title: 'Drops live proof — 1 of 1',
  description: 'Indexed drop',
  media_urls: [] as string[],
  format: 'fixed_price',
  starts_at: '2026-09-20T12:00:00.000Z',
  ends_at: '2026-09-22T12:00:00.000Z',
  total_quantity: 1,
  per_buyer_limit: 1,
}));
const dropsState = vi.hoisted(() => ({
  buckets: {
    upcoming: [] as Array<typeof dropEntry>,
    live: [] as Array<typeof dropEntry>,
    ended: [] as Array<typeof dropEntry>,
  },
  isIndexed: true,
  isLoading: false,
  error: null as string | null,
  adapterMode: 'transaction-service',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
  usePathname: () => '/marketplace',
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ isAuthenticated: false, requireAuth: (action: () => void) => action() }),
}));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => runtime.deployEnv };
});

vi.mock('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog', () => ({
  useMarketplaceCatalog: (
    initialListings: typeof catalogState.listings = [],
    initialShops: Array<{ ownerPubky: string; name: string }> = [],
  ) => ({
    listings: catalogState.isLoading && initialListings.length > 0 ? initialListings : catalogState.listings,
    facetPool: catalogState.isLoading && initialListings.length > 0 ? initialListings : catalogState.listings,
    shopsBySeller: new Map(initialShops.map((shop) => [shop.ownerPubky, shop])),
    isLoading: catalogState.isLoading,
    adapterMode: catalogState.adapterMode,
  }),
}));

vi.mock('@/hooks/useMarketplacePromoDismissal/useMarketplacePromoDismissal', () => ({
  useMarketplacePromoDismissal: () => ({
    showPromo: promoState.showPromo,
    isResolved: promoState.isResolved,
    dismissPromo: promoDismiss,
  }),
}));

vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

vi.mock('@/hooks/useMarketplaceDrops/useMarketplaceDrops', () => ({
  useMarketplaceDrops: () => dropsState,
}));

vi.mock('@/organisms/Marketplace/DropCard', () => ({
  DropCard: ({ entry }: { entry: { title: string } }) => <article>{entry.title}</article>,
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => navCounts.cart,
}));

vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => navCounts.activity,
}));

vi.mock('@/stores/commerce/commerce.store', () => ({
  useCommerceStore: (selector: (state: typeof commerceState) => unknown) => selector(commerceState),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/organisms/Marketplace/MarketplaceFilters', () => ({
  MarketplaceFilters: ({
    searchControl,
    sellControl,
  }: {
    searchControl?: React.ReactNode;
    sellControl?: React.ReactNode;
  }) => (
    <div data-testid="marketplace-filters">
      {searchControl}
      {sellControl}
    </div>
  ),
}));

vi.mock('@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid', () => ({
  useMarketplaceLiveBid: () => ({ ref: () => {}, bid: null }),
}));

vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: false, isLoading: false, isMutating: false, toggle: vi.fn() }),
}));

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

describe('Marketplace', () => {
  beforeEach(() => {
    routerPush.mockClear();
    sellingAccess.allowed = true;
    setSaleFormat.mockClear();
    promoDismiss.mockClear();
    promoState.showPromo = false;
    promoState.isResolved = true;
    navCounts.cart = 0;
    navCounts.activity = 0;
    catalogState.listings = [];
    catalogState.isLoading = false;
    catalogState.adapterMode = 'sandbox';
    runtime.deployEnv = 'staging';
    commerceState.query = '';
    commerceState.saleFormat = 'all';
    commerceState.categoryId = '';
    commerceState.countryCode = '';
    commerceState.sort = 'newest';
    dropsState.buckets = { upcoming: [], live: [], ended: [] };
    dropsState.isLoading = false;
    dropsState.error = null;
    dropsState.isIndexed = true;
    window.localStorage.clear();
  });

  it('renders the marketplace section navigation and primary actions in SSR markup', () => {
    const html = renderToString(<Marketplace />);

    expect(html).toContain('data-testid="marketplace-section-nav"');
    expect(html).toContain('Sell an item');
    expect(html).toContain('My shop');
  });

  it('does not repeat the logo environment label as a catalog banner', () => {
    const { rerender } = render(<Marketplace />);

    expect(screen.queryByText('Staging environment — test rails, no real funds move')).not.toBeInTheDocument();
    expect(screen.queryByText('Real money. Payments are final and go directly to the seller.')).not.toBeInTheDocument();

    runtime.deployEnv = 'production';
    catalogState.adapterMode = 'transaction-service';
    rerender(<Marketplace />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('fails closed to the real-money side for an unknown deploy environment', () => {
    runtime.deployEnv = undefined;
    render(<Marketplace />);

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('renders guest catalog cards from server listings while the local cache hydrates', () => {
    catalogState.isLoading = true;
    const initialListings = [
      {
        id: 'seller:boots_01',
        sellerId: 'y'.repeat(52),
        listingId: 'boots_01',
        state: 'active' as const,
        title: 'Vintage leather boots',
        description: 'Well cared for boots with light wear.',
        categoryId: 'fashion-shoes-boots',
        condition: 'good' as const,
        tags: ['vintage'],
        saleFormat: 'fixed_price' as const,
        price: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        auction: null,
        attributes: null,
        location: { countryCode: 'US', region: 'NY' },
        mediaUrls: [],
        reputation: null,
        revision: 1,
        updatedAt: Date.parse('2026-08-19T21:00:00.000Z'),
      },
    ];

    const html = renderToString(
      <Marketplace initialListings={initialListings} initialShops={[createCommerceShopFixture()]} />,
    );

    expect(html).toContain('Vintage leather boots');
    expect(html).toContain('Satoshi Vintage');
    expect(html).toContain('Buy now');
    expect(html).not.toContain('marketplace-skeleton');
    expect(html).not.toContain(`${'y'.repeat(8)}…`);

    render(<Marketplace initialListings={initialListings} />);

    expect(screen.getByRole('heading', { name: 'Vintage leather boots' })).toBeInTheDocument();
    expect(
      within(screen.getByTestId('marketplace-section-nav')).getByRole('link', { name: 'Orders' }),
    ).toBeInTheDocument();
  });

  it('asks for selling approval before navigating to the listing form', async () => {
    sellingAccess.allowed = false;
    render(<Marketplace />);
    await userEvent.click(screen.getByRole('button', { name: 'Sell an item' }));
    expect(screen.getByRole('dialog', { name: 'sell' })).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Complete approval' }));
    expect(routerPush).toHaveBeenCalledWith(MARKETPLACE_ROUTES.SELL);
  });

  it('stays in the catalog when selling approval is cancelled', async () => {
    sellingAccess.allowed = false;
    render(<Marketplace />);
    await userEvent.click(screen.getByRole('button', { name: 'Sell an item' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel approval' }));
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the listing form directly when selling is already approved', async () => {
    render(<Marketplace />);
    await userEvent.click(screen.getByRole('button', { name: 'Sell an item' }));
    expect(routerPush).toHaveBeenCalledWith(MARKETPLACE_ROUTES.SELL);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('gates section navigation through the existing auth flow', async () => {
    const user = userEvent.setup();

    render(<Marketplace />);

    await user.click(within(screen.getByTestId('marketplace-section-nav')).getByRole('link', { name: 'Orders' }));

    expect(routerPush).toHaveBeenCalledWith(MARKETPLACE_ROUTES.ORDERS);
  });

  it('persists marketplace promo dismissal for the device', async () => {
    const user = userEvent.setup();
    promoState.showPromo = true;

    render(<Marketplace />);

    const dismissButton = await screen.findByRole('button', { name: 'Dismiss marketplace promo' });
    await user.click(dismissButton);

    await waitFor(() => expect(promoDismiss).toHaveBeenCalledOnce());
    expect(window.localStorage.getItem(buildFeatureDiscoveryDeviceStorageKey(MARKETPLACE_PROMO_STORAGE_ID))).toBe(
      'dismissed',
    );
    expect(buildFeatureDiscoveryDeviceStorageKey(MARKETPLACE_PROMO_STORAGE_ID)).toBe(
      `${FEATURE_DISCOVERY_STORAGE_PREFIX}:${MARKETPLACE_PROMO_STORAGE_ID}`,
    );
    expect(screen.queryByRole('region', { name: 'Marketplace promo' })).not.toBeInTheDocument();
  });

  it('keeps the server-rendered promo mounted until the account dismissal resolves', () => {
    promoState.isResolved = false;

    const { rerender } = render(<Marketplace />);

    expect(screen.getByRole('region', { name: 'Marketplace promo' })).toHaveAttribute('data-marketplace-promo');

    promoState.isResolved = true;
    rerender(<Marketplace />);

    expect(screen.queryByRole('region', { name: 'Marketplace promo' })).not.toBeInTheDocument();
  });

  it('shows the indexed-state caveat on the drops filter and does not repeat the same drop', () => {
    commerceState.saleFormat = 'drops';
    catalogState.adapterMode = 'transaction-service';
    catalogState.listings = [{ id: 'seller:listing-1', title: 'Drops live proof — 1 of 1' }];
    dropsState.buckets = { live: [dropEntry], upcoming: [dropEntry], ended: [] };

    render(<Marketplace />);

    expect(
      screen.getByText(/Discover timed, limited releases. Open a drop to check availability./),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Drops live proof — 1 of 1')).toHaveLength(1);
  });
});
