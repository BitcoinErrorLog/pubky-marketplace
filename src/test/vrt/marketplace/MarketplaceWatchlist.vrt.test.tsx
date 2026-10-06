// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { formatStableRelative } from '@/test-utils/vrt.clock';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceWatchlist } from '@/templates/Marketplace/MarketplaceWatchlist';

const ROW_IMAGE_DATA_URL = vi.hoisted(
  () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=',
);

const fixtures = vi.hoisted(async () => {
  const { catalogItemFromCatalogEntry } = await import('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils');
  const { createCommerceCatalogEntryFixture } = await import('@/test/fixtures/commerce/commerce');
  const { createWatchAlertFeedItemFixture } = await import('@/test/fixtures/commerce/watch-alerts');
  const { VRT_FROZEN_NOW_MS: NOW, HOUR_MS: HOUR } = await import('@/test-utils/vrt.clock');

  const seller = 'w'.repeat(52);

  const endingSoonAuction = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${seller}:signet_ring`,
      seller_id: seller,
      listing_id: 'signet_ring',
      title: 'Brutalist silver signet',
      description: 'Solid recycled silver ring.',
      category_id: 'fashion-jewelry-rings',
      condition: 'new',
      tags: ['silver'],
      sale_format: 'auction',
      media_urls: [],
      price: { amountMinor: 12_000, currency: 'USD', exponent: 2 },
      auction: {
        startsAt: new Date(NOW - 72 * HOUR).toISOString(),
        endsAt: new Date(NOW + 3 * HOUR).toISOString(),
        buyNowPrice: null,
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      },
      updated_at: NOW - 24 * HOUR,
    }),
  );

  const fixedPrice = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${seller}:film_camera`,
      seller_id: seller,
      listing_id: 'film_camera',
      title: '35mm rangefinder camera',
      description: 'Recently serviced.',
      category_id: 'electronics-cameras-film',
      condition: 'excellent',
      tags: ['camera'],
      sale_format: 'fixed_price',
      media_urls: ['pubky://seller/pub/pubky.app/marketplace/v1/media/cover'],
      price: { amountMinor: 18_500, currency: 'USD', exponent: 2 },
      auction: null,
      updated_at: NOW - 30 * HOUR,
    }),
  );

  const entries = [
    {
      listingId: endingSoonAuction.id,
      sellerId: seller,
      rawListingId: 'signet_ring',
      watchedAt: NOW - 20 * HOUR,
      item: endingSoonAuction,
      snapshot: null,
    },
    {
      listingId: fixedPrice.id,
      sellerId: seller,
      rawListingId: 'film_camera',
      watchedAt: NOW - 40 * HOUR,
      item: fixedPrice,
      snapshot: {
        id: `owner|${fixedPrice.id}`,
        owner_id: 'o'.repeat(52),
        listing_id: fixedPrice.id,
        title: fixedPrice.title,
        index_revision: 2,
        index_state: 'active',
        price_minor: 18_500,
        price_currency: 'USD',
        price_exponent: 2,
        auction_ends_at: null,
        server_revision: 4,
        projection_state: 'sold',
        bid_count: null,
        bid_amount_minor: null,
        leader_pubky: null,
        ending_soon_alerted_ends_at: null,
        checked_at: NOW - HOUR,
      },
    },
    {
      listingId: `${seller}:uncached_listing`,
      sellerId: seller,
      rawListingId: 'uncached_listing',
      watchedAt: NOW - 50 * HOUR,
      item: null,
      snapshot: {
        id: `owner|${seller}:uncached_listing`,
        owner_id: 'o'.repeat(52),
        listing_id: `${seller}:uncached_listing`,
        title: 'Estate lot mystery box',
        index_revision: 1,
        index_state: 'active',
        price_minor: 4_000,
        price_currency: 'USD',
        price_exponent: 2,
        auction_ends_at: null,
        server_revision: null,
        projection_state: null,
        bid_count: null,
        bid_amount_minor: null,
        leader_pubky: null,
        ending_soon_alerted_ends_at: null,
        checked_at: NOW - HOUR,
      },
    },
  ];

  const watchAlerts = [
    createWatchAlertFeedItemFixture('outbid', { isUnseen: true, timestamp: NOW - HOUR }),
    createWatchAlertFeedItemFixture('ending_soon', { timestamp: NOW - 2 * HOUR }),
  ];

  const serviceItems = [
    {
      id: 'marketplace:018f47d2-6a27-7c23-a62f-000000000010',
      source: 'marketplace' as const,
      type: 'outbid',
      actorPubky: 'a'.repeat(52),
      aggregateId: `listing:${seller}_signet_ring`,
      timestamp: NOW - HOUR,
      isUnread: false,
      href: `/marketplace/listing/${seller}/signet_ring`,
    },
  ];

  return { entries, watchAlerts, serviceItems };
});

const view = vi.hoisted(() => ({
  entries: [] as unknown[],
  isLoading: false,
  isSignedIn: true,
  watchAlerts: [] as unknown[],
  serviceItems: [] as unknown[],
  watchlistSyncStatus: undefined as string | undefined,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/watchlist',
}));

vi.mock('@/hooks/useMarketplaceWatchlist/useMarketplaceWatchlist', () => ({
  useMarketplaceWatchlist: () => ({
    entries: view.entries,
    isLoading: view.isLoading,
    isSignedIn: view.isSignedIn,
    adapterMode: 'transaction-service',
    watchlistSyncStatus: view.watchlistSyncStatus,
  }),
}));

vi.mock('@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed', () => ({
  useMarketplaceWatchAlertFeed: () => ({ items: view.watchAlerts, markAllSeen: vi.fn(async () => {}) }),
}));

vi.mock('@/hooks/useMarketplaceNotificationFeed/useMarketplaceNotificationFeed', () => ({
  useMarketplaceNotificationFeed: () => ({
    items: view.serviceItems,
    refresh: vi.fn(async () => {}),
    markAllRead: vi.fn(async () => {}),
  }),
}));

vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

vi.mock('@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary', () => ({
  useMarketplaceSellerSummary: (sellerPubky: string) => ({
    shop: null,
    reputation: { status: 'new_seller' },
    displayName: sellerPubky === 'w'.repeat(52) ? 'Low Time Preference' : `${sellerPubky.slice(0, 10)}…`,
  }),
}));

vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: true, isLoading: false, isMutating: false, toggle: vi.fn() }),
}));

// Only the ending-soon auction row gets a live current bid; the others keep
// the honest terms-only rendering.
vi.mock('@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid', () => ({
  useMarketplaceLiveBid: (_sellerPubky: string, listingId: string) => ({
    ref: () => {},
    bid:
      listingId === 'signet_ring'
        ? { currentPrice: { amountMinor: 14_500, currency: 'USD', exponent: 2 }, bidCount: 5 }
        : null,
  }),
}));

vi.mock('@/hooks/useUserProfile/useUserProfile', () => ({
  useUserProfile: (userId: string) => ({
    profile: { name: 'Rival Bidder', bio: '', publicKey: `pk:${userId}`, link: `/profile/${userId}` },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useRelativeTime/useRelativeTime', () => {
  const result = { formatRelativeTime: (date: Date) => formatStableRelative(date.getTime()) };
  return { useRelativeTime: () => result };
});

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks((uri) => (uri ? ROW_IMAGE_DATA_URL : null));
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

async function setView(overrides: Partial<typeof view>) {
  view.entries = [];
  view.isLoading = false;
  view.isSignedIn = true;
  view.watchAlerts = [];
  view.serviceItems = [];
  view.watchlistSyncStatus = undefined;
  Object.assign(view, overrides);
}

describe('Marketplace watchlist — visual regression', () => {
  it('renders watched items with live bid, sold-out badge, uncached row, and both alert sections at desktop viewport', async () => {
    const { entries, watchAlerts, serviceItems } = await fixtures;
    await setView({ entries, watchAlerts, serviceItems });

    const screen = await renderForVRT(<MarketplaceWatchlist />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('watchlist-populated-desktop');
  });

  it('renders watched items and alerts at mobile viewport', async () => {
    const { entries, watchAlerts, serviceItems } = await fixtures;
    await setView({ entries, watchAlerts, serviceItems });

    const screen = await renderForVRT(<MarketplaceWatchlist />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('watchlist-populated-mobile');
  });

  it('renders the private sync unavailable notice at desktop viewport', async () => {
    const { entries } = await fixtures;
    await setView({ entries, watchlistSyncStatus: 'unavailable' });

    const screen = await renderForVRT(<MarketplaceWatchlist />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('watchlist-sync-unavailable-desktop');
  });

  it('renders the marketplace-approval sync notice at desktop viewport', async () => {
    const { entries } = await fixtures;
    await setView({ entries, watchlistSyncStatus: 'needs_marketplace_approval' });

    const screen = await renderForVRT(<MarketplaceWatchlist />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('watchlist-sync-marketplace-approval-desktop');
  });

  it('renders the unsupported-browser sync notice at desktop viewport', async () => {
    const { entries } = await fixtures;
    await setView({ entries, watchlistSyncStatus: 'unsupported' });

    const screen = await renderForVRT(<MarketplaceWatchlist />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('watchlist-sync-unsupported-desktop');
  });

  it('renders the empty state at desktop viewport', async () => {
    await setView({});

    const screen = await renderForVRT(<MarketplaceWatchlist />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('watchlist-empty-desktop');
  });

  it('renders the signed-out state at desktop viewport', async () => {
    await setView({ isSignedIn: false });

    const screen = await renderForVRT(<MarketplaceWatchlist />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('watchlist-signed-out-desktop');
  });
});
