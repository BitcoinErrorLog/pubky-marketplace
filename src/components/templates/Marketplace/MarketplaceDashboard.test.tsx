import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { COMMERCE_LISTING_MAX_QUANTITY } from '@/config/commerce';
import { COMMERCE_FIXTURE_SELLER, createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import { toCommerceListingModel } from '@/test/fixtures/commerce/listing-models';
import { MarketplaceDashboard } from './MarketplaceDashboard';

const viewport = vi.hoisted(() => ({ isMobile: false }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const dashboardFns = vi.hoisted(() => ({
  duplicateListing: vi.fn(async () => true),
  hasUnsavedListingDraft: vi.fn(async (): Promise<string | null> => null),
  discardListingDraft: vi.fn(async () => undefined),
  resumeListingDraft: vi.fn(),
}));
const dashboardState = vi.hoisted(() => ({
  listings: [] as unknown[],
  nowMs: Date.parse('2026-09-21T12:00:00.000Z'),
  metrics: {
    activeListings: 0,
    totalInventory: 0,
    lowStock: 0,
    paidOrders: 0,
    revenue: [] as unknown[],
    openOffers: 0,
  },
  actionNeeded: {
    ordersToShip: 0,
    offersAwaitingReply: 0,
    expiringAuctions: 0,
    total: 0,
  },
  unfinishedDrafts: [] as Array<{ listingId: string; title: string; updatedAt: number; ageLabel: string }>,
  needsSession: false,
  sessionError: null as string | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => MARKETPLACE_ROUTES.DASHBOARD,
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  return await import('@/test/mocks/marketplace-media-hooks');
});

vi.mock('@/hooks/useIsMobile/useIsMobile', () => ({
  useIsMobile: () => viewport.isMobile,
}));

vi.mock('@/hooks/useMarketplaceSellerDashboard/useMarketplaceSellerDashboard', () => ({
  useMarketplaceSellerDashboard: () => ({
    listings: dashboardState.listings,
    nowMs: dashboardState.nowMs,
    sellerOrders: [],
    offers: [],
    isLoading: false,
    needsSession: dashboardState.needsSession,
    sessionError: dashboardState.sessionError,
    metrics: dashboardState.metrics,
    actionNeeded: dashboardState.actionNeeded,
    updateListingState: vi.fn(async () => true),
    duplicateListing: dashboardFns.duplicateListing,
    hasUnsavedListingDraft: dashboardFns.hasUnsavedListingDraft,
    unfinishedDrafts: dashboardState.unfinishedDrafts,
    discardListingDraft: dashboardFns.discardListingDraft,
    resumeListingDraft: dashboardFns.resumeListingDraft,
    exportCsv: () => 'listing_id,title,state,format,price_minor,currency,inventory',
  }),
}));

vi.mock('@/organisms/Marketplace/MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: ({ triggerLabel }: { triggerLabel: string }) => <button>{triggerLabel}</button>,
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => ({ record: { name: 'Satoshi Vintage' } }),
}));

const paymentGate = vi.hoisted(() => ({
  isDurable: false,
  ready: true,
  reason: null as 'unsigned' | 'no-method' | 'unverified' | null,
}));

vi.mock('@/hooks/useSellerPaymentMethodGate/useSellerPaymentMethodGate', () => ({
  useSellerPaymentMethodGate: () => paymentGate,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getShop: () => Promise.resolve({ record: { name: 'Satoshi Vintage' } }),
    getOrFetchShop: () => Promise.resolve({ name: 'Satoshi Vintage' }),
  },
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { currentUserPubky: string }) => unknown) =>
      selector({ currentUserPubky: COMMERCE_FIXTURE_SELLER }),
    {
      getState: () => ({
        currentUserPubky: COMMERCE_FIXTURE_SELLER,
        selectCurrentUserPubky: () => COMMERCE_FIXTURE_SELLER,
      }),
      setState: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

describe('MarketplaceDashboard', () => {
  beforeEach(() => {
    dashboardState.unfinishedDrafts = [];
    dashboardState.needsSession = false;
    dashboardState.sessionError = null;
    dashboardFns.discardListingDraft.mockClear();
    dashboardFns.resumeListingDraft.mockClear();
    router.push.mockClear();
    paymentGate.isDurable = false;
    paymentGate.ready = true;
    paymentGate.reason = null;
  });

  it('explains the marketplace approval on the seller dashboard', () => {
    dashboardState.needsSession = true;
    dashboardState.sessionError = 'A marketplace session is required.';

    render(<MarketplaceDashboard />);

    expect(
      screen.getByText(
        'Your sales use this same approval, because the marketplace lists them only for a session it can tie to you.',
      ),
    ).toBeInTheDocument();
  });

  it('renders KPI metrics as a horizontal chip strip on mobile', () => {
    viewport.isMobile = true;
    dashboardState.listings = [listing()];
    dashboardState.metrics = {
      activeListings: 1,
      totalInventory: 4,
      lowStock: 0,
      paidOrders: 2,
      revenue: [{ amountMinor: 12_500, currency: 'USD', exponent: 2 }],
      openOffers: 1,
    };
    dashboardState.actionNeeded = {
      ordersToShip: 1,
      offersAwaitingReply: 0,
      expiringAuctions: 0,
      total: 1,
    };

    render(<MarketplaceDashboard />);

    expect(screen.getByRole('heading', { name: 'Seller studio' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Inventory/ })).toHaveAttribute('href', MARKETPLACE_ROUTES.INVENTORY);
    const chips = screen.getByTestId('marketplace-dashboard-kpi-chips');
    expect(chips).toHaveAttribute('role', 'region');
    expect(chips).toHaveAttribute('aria-label', 'Dashboard metrics');
    expect(chips).toHaveAttribute('tabindex', '0');
    expect(chips).toHaveTextContent('Active listings');
    expect(chips).toHaveTextContent('1');
    expect(chips).toHaveTextContent('$125.00');
    expect(screen.getByText('Action needed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My listings' })).toBeInTheDocument();
  });

  it('keeps KPI cards on desktop', () => {
    viewport.isMobile = false;
    dashboardState.listings = [listing()];

    render(<MarketplaceDashboard />);

    expect(screen.queryByTestId('marketplace-dashboard-kpi-chips')).not.toBeInTheDocument();
    expect(screen.getByText('Active listings')).toBeInTheDocument();
  });

  it('seeds a sell draft from Duplicate and navigates to the sell studio', async () => {
    viewport.isMobile = false;
    dashboardFns.duplicateListing.mockClear();
    dashboardFns.hasUnsavedListingDraft.mockResolvedValue(null);
    router.push.mockClear();
    const rowListing = listing({ listingId: 'no_media', title: 'No media listing', media: [] });
    dashboardState.listings = [rowListing];

    render(<MarketplaceDashboard />);

    const row = screen.getByRole('row', { name: /No media listing/ });
    expect(within(row).getByLabelText('No thumbnail for No media listing')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /Duplicate/ }));

    await vi.waitFor(() => {
      expect(dashboardFns.duplicateListing).toHaveBeenCalledWith('no_media', { replaceUnsavedDraft: false });
    });
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(MARKETPLACE_ROUTES.SELL);
    });
  });

  it('asks before replacing an unsaved draft and keeps it when Keep is chosen', async () => {
    viewport.isMobile = false;
    dashboardFns.duplicateListing.mockClear();
    dashboardFns.hasUnsavedListingDraft.mockResolvedValue('existingdraft');
    router.push.mockClear();
    dashboardState.listings = [listing({ listingId: 'no_media', title: 'No media listing', media: [] })];

    render(<MarketplaceDashboard />);

    fireEvent.click(
      within(screen.getByRole('row', { name: /No media listing/ })).getByRole('button', { name: /Duplicate/ }),
    );

    expect(await screen.findByTestId('dialog-title')).toHaveTextContent('Replace your unsaved draft?');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));

    expect(dashboardFns.duplicateListing).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('replaces an unsaved draft when Replace is confirmed', async () => {
    viewport.isMobile = false;
    dashboardFns.duplicateListing.mockClear();
    dashboardFns.hasUnsavedListingDraft.mockResolvedValue('existingdraft');
    router.push.mockClear();
    dashboardState.listings = [listing({ listingId: 'no_media', title: 'No media listing', media: [] })];

    render(<MarketplaceDashboard />);

    fireEvent.click(
      within(screen.getByRole('row', { name: /No media listing/ })).getByRole('button', { name: /Duplicate/ }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));

    await vi.waitFor(() => {
      expect(dashboardFns.duplicateListing).toHaveBeenCalledWith('no_media', {
        replaceUnsavedDraft: true,
        unsavedDraftId: 'existingdraft',
      });
    });
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(MARKETPLACE_ROUTES.SELL);
    });
  });

  it('asks before replacing an unsaved photos-only draft', async () => {
    viewport.isMobile = false;
    dashboardFns.duplicateListing.mockClear();
    dashboardFns.hasUnsavedListingDraft.mockResolvedValue('photosonly');
    router.push.mockClear();
    dashboardState.listings = [listing({ listingId: 'no_media', title: 'No media listing', media: [] })];

    render(<MarketplaceDashboard />);

    fireEvent.click(
      within(screen.getByRole('row', { name: /No media listing/ })).getByRole('button', { name: /Duplicate/ }),
    );

    expect(await screen.findByTestId('dialog-title')).toHaveTextContent('Replace your unsaved draft?');
    expect(dashboardFns.duplicateListing).not.toHaveBeenCalled();
  });

  it('badges ended auctions from the dashboard clock, not wall time', () => {
    viewport.isMobile = false;
    const endsAt = '2026-09-21T12:00:00.000Z';
    const rowListing = listing({
      listingId: 'ended_auction',
      title: 'Ended rangefinder',
      sale: {
        format: 'auction',
        startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        startsAt: '2026-09-21T10:00:00.000Z',
        endsAt,
        antiSnipingWindowSeconds: 120,
        antiSnipingExtensionSeconds: 120,
      },
    });
    dashboardState.listings = [rowListing];
    dashboardState.nowMs = Date.parse(endsAt) - 1;

    const { rerender } = render(<MarketplaceDashboard />);
    expect(within(screen.getByRole('row', { name: /Ended rangefinder/ })).getByText('active')).toBeInTheDocument();

    dashboardState.nowMs = Date.parse(endsAt);
    rerender(<MarketplaceDashboard />);
    expect(within(screen.getByRole('row', { name: /Ended rangefinder/ })).getByText('ended')).toBeInTheDocument();
  });

  it('lists unfinished drafts when more than one is saved on this device', () => {
    viewport.isMobile = false;
    dashboardState.listings = [listing()];
    dashboardState.unfinishedDrafts = [
      { listingId: 'draft_a', title: 'Vintage boots', updatedAt: 1, ageLabel: '3 min ago' },
      { listingId: 'draft_b', title: 'Untitled listing', updatedAt: 2, ageLabel: '1 hour ago' },
    ];

    render(<MarketplaceDashboard />);

    expect(screen.getByRole('heading', { name: 'Unfinished drafts' })).toBeInTheDocument();
    expect(document.querySelector('[data-surface="listing-drafts-list"]')).not.toBeNull();
    expect(screen.getByText('Vintage boots')).toBeInTheDocument();
    expect(screen.getByText('Untitled listing')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Resume' })[0]);
    expect(dashboardFns.resumeListingDraft).toHaveBeenCalledWith('draft_a');
    expect(router.push).toHaveBeenCalledWith(MARKETPLACE_ROUTES.SELL);

    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[1]);
    expect(dashboardFns.discardListingDraft).toHaveBeenCalledWith('draft_b');
  });

  it('surfaces the payment-method precondition on Create listing / Sell an item', () => {
    viewport.isMobile = false;
    paymentGate.isDurable = true;
    paymentGate.ready = true;
    paymentGate.reason = 'no-method';
    dashboardState.listings = [];
    dashboardState.metrics = {
      activeListings: 0,
      totalInventory: 0,
      lowStock: 0,
      paidOrders: 0,
      revenue: [],
      openOffers: 0,
    };

    render(<MarketplaceDashboard />);

    const notes = screen.getAllByTestId('create-listing-payment-precondition');
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note).toHaveTextContent('Payment setup required');
      expect(note).toHaveTextContent('Set up how you get paid first');
    }
    for (const link of screen.getAllByRole('link', { name: 'Sell an item' })) {
      expect(link).toHaveAttribute('href', MARKETPLACE_ROUTES.SELL);
    }
  });

  it('styles Payment settings like the other studio actions and keeps the setup notice on that row', () => {
    viewport.isMobile = false;
    paymentGate.isDurable = true;
    paymentGate.ready = true;
    paymentGate.reason = 'no-method';
    dashboardState.listings = [];
    dashboardState.metrics = {
      activeListings: 0,
      totalInventory: 0,
      lowStock: 0,
      paidOrders: 0,
      revenue: [],
      openOffers: 0,
    };

    render(<MarketplaceDashboard />);

    const settings = screen.getByRole('link', { name: 'Payment settings' });
    const shop = screen.getByRole('link', { name: 'My shop' });
    expect(settings.className).toContain('bg-secondary');
    expect(settings.className).not.toContain('border-none');
    expect(shop.className).toContain('bg-secondary');
    expect(settings.parentElement?.className).toContain('items-center');
    expect(settings.parentElement?.className).not.toContain('flex-col');

    const note = settings.parentElement?.querySelector('[data-testid="create-listing-payment-precondition"]');
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent('Payment setup required');
    expect(note).toHaveTextContent('Set up how you get paid first');
    const headerSell = screen.getAllByRole('link', { name: 'Sell an item' })[0];
    expect(headerSell.parentElement?.contains(note as Node)).toBe(false);
  });

  it('shows Unlimited for a listing with an unlimited variant and a number for the rest', () => {
    viewport.isMobile = false;
    dashboardState.listings = [
      listing({
        listingId: 'guide',
        title: 'Printable field guide',
        fulfillmentMethods: ['digital'],
        package: undefined,
        shippingOptions: [],
        variants: [
          {
            id: 'file',
            options: { size: 'pdf' },
            quantity: COMMERCE_LISTING_MAX_QUANTITY,
            mediaIds: ['image_01'],
            enabled: true,
          },
          {
            id: 'sample',
            options: { size: 'sample' },
            quantity: 2,
            mediaIds: ['image_01'],
            enabled: true,
          },
        ],
      }),
      listing(),
    ];

    render(<MarketplaceDashboard />);

    const guide = screen.getByRole('row', { name: /Printable field guide/ });
    expect(within(guide).getByText('Unlimited')).toBeInTheDocument();
    expect(within(guide).queryByText(String(COMMERCE_LISTING_MAX_QUANTITY))).not.toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Vintage leather boots/ })).getByText('1')).toBeInTheDocument();
  });
});

function listing(overrides: Partial<Parameters<typeof createCommerceListingFixture>[0]> = {}) {
  return toCommerceListingModel(createCommerceListingFixture(overrides));
}
