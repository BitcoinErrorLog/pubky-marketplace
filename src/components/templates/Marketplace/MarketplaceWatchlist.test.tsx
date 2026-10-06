import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogItemFromCatalogEntry } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { MarketplaceWatchlistEntry } from '@/hooks/useMarketplaceWatchlist/useMarketplaceWatchlist';
import { createCommerceCatalogEntryFixture } from '@/test/fixtures/commerce/commerce';
import { MarketplaceWatchlist } from './MarketplaceWatchlist';

const relativeTime = vi.hoisted(() => ({ value: '11s' }));
const sellerSummary = vi.hoisted(() => ({ displayName: 'Proof of Film' }));
const view = vi.hoisted(() => ({
  entries: [] as MarketplaceWatchlistEntry[],
  isSignedIn: true,
  watchlistSyncStatus: 'synced' as string,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/watchlist',
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  return await import('@/test/mocks/marketplace-media-hooks');
});

vi.mock('@/hooks/useMarketplaceWatchlist/useMarketplaceWatchlist', () => ({
  useMarketplaceWatchlist: () => ({
    entries: view.entries,
    isLoading: false,
    isSignedIn: view.isSignedIn,
    watchlistSyncStatus: view.watchlistSyncStatus,
    syncWatchlist: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed', () => ({
  useMarketplaceWatchAlertFeed: () => ({ items: [] }),
}));

vi.mock('@/hooks/useMarketplaceNotificationFeed/useMarketplaceNotificationFeed', () => ({
  useMarketplaceNotificationFeed: () => ({ items: [] }),
}));

vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: true, isLoading: false, isMutating: false, toggle: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid', () => ({
  useMarketplaceLiveBid: () => ({ ref: () => {}, bid: null }),
}));

const sellerSummaryCalls = vi.hoisted(() => ({ options: [] as Array<{ includeReputation?: boolean } | undefined> }));

vi.mock('@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary', () => ({
  useMarketplaceSellerSummary: (_sellerPubky: string, options?: { includeReputation?: boolean }) => {
    sellerSummaryCalls.options.push(options);
    return {
      shop: null,
      reputation: { status: 'unavailable' },
      displayName: sellerSummary.displayName,
    };
  },
}));

vi.mock('@/hooks/useRelativeTime/useRelativeTime', () => ({
  useRelativeTime: () => ({ formatRelativeTime: () => relativeTime.value }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

function watchlistEntry(): MarketplaceWatchlistEntry {
  const seller = 'n'.repeat(52);
  const item = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${seller}:rangefinder_camera`,
      seller_id: seller,
      listing_id: 'rangefinder_camera',
      title: '35mm rangefinder camera',
      price: { amountMinor: 18_500, currency: 'USD', exponent: 2 },
    }),
  );

  return {
    listingId: item.id,
    sellerId: seller,
    rawListingId: item.listingId,
    watchedAt: Date.now() - 60_000,
    item,
    snapshot: {
      id: `owner|${item.id}`,
      owner_id: 'o'.repeat(52),
      listing_id: item.id,
      title: item.title,
      index_revision: 2,
      index_state: 'active',
      price_minor: 18_500,
      price_currency: 'USD',
      price_exponent: 2,
      auction_ends_at: null,
      server_revision: 4,
      projection_state: null,
      bid_count: null,
      bid_amount_minor: null,
      leader_pubky: null,
      ending_soon_alerted_ends_at: null,
      checked_at: Date.now() - 11_000,
    },
  };
}

describe('MarketplaceWatchlist', () => {
  beforeEach(() => {
    relativeTime.value = '11s';
    sellerSummary.displayName = 'Proof of Film';
    view.entries = [watchlistEntry()];
    view.isSignedIn = true;
    view.watchlistSyncStatus = 'synced';
  });

  it('renders the seller name and expanded checked copy', () => {
    sellerSummaryCalls.options = [];
    render(<MarketplaceWatchlist />);

    expect(screen.getByText('Proof of Film')).toBeInTheDocument();
    expect(screen.getByText('Checked 11 sec ago')).toBeInTheDocument();
    expect(sellerSummaryCalls.options).toEqual([{ includeReputation: false }]);
  });

  it('renders just now for a zero-second checked label', () => {
    relativeTime.value = '0s';

    render(<MarketplaceWatchlist />);

    expect(screen.getByText('Checked just now')).toBeInTheDocument();
  });

  it('says private sync is unavailable when the data key cannot be released', () => {
    view.watchlistSyncStatus = 'unavailable';

    render(<MarketplaceWatchlist />);

    expect(screen.getByText('Private sync is unavailable right now')).toBeInTheDocument();
    expect(screen.getByText('Proof of Film')).toBeInTheDocument();
  });

  it('says this browser cannot sync, and keeps the list, without the Web Locks API', () => {
    view.watchlistSyncStatus = 'unsupported';

    render(<MarketplaceWatchlist />);

    expect(screen.getByText('This browser cannot sync your watchlist')).toBeInTheDocument();
    expect(screen.queryByText('Private sync is unavailable right now')).not.toBeInTheDocument();
    expect(screen.getByText('Proof of Film')).toBeInTheDocument();
  });

  it('labels a watched auction Ended once its end time passes although the index row says active', () => {
    const entry = watchlistEntry();
    entry.item = {
      ...entry.item!,
      saleFormat: 'auction',
      auction: {
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-01-08T00:00:00.000Z',
        buyNowPrice: null,
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      },
    };
    expect(entry.item.state).toBe('active');
    view.entries = [entry];

    render(<MarketplaceWatchlist />);

    expect(screen.getAllByText('Ended').length).toBeGreaterThan(0);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('labels a watched fixed-price listing Active', () => {
    render(<MarketplaceWatchlist />);

    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows no unavailable notice once sync succeeds', () => {
    render(<MarketplaceWatchlist />);

    expect(screen.queryByText('Private sync is unavailable right now')).not.toBeInTheDocument();
    expect(screen.queryByText('This browser cannot sync your watchlist')).not.toBeInTheDocument();
  });
});
