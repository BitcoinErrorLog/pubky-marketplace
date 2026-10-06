import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMarketplaceCatalogItems,
  catalogItemFromCatalogEntry,
  type MarketplaceCatalogItem,
} from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { MarketplaceLiveBid } from '@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid';
import { createCommerceSandboxCatalog } from '@/libs/commerce/sandbox-catalog';
import { createCommerceCatalogEntryFixture } from '@/test/fixtures/commerce/commerce';
import { toCommerceListingModel } from '@/test/fixtures/commerce/listing-models';
import { MarketplaceListingCard } from './MarketplaceListingCard';

// The card is presentational: the live-bid hook (its viewport observer and
// transaction-service fetch) is behavior-tested in `useMarketplaceLiveBid.test.tsx`.
// Here it is replaced with mutable state so each test declares what the
// service answered — `bid: null` is the default (no fetch / unreachable / no
// durable backend), which matches how the card renders in every prior test.
const liveBid = vi.hoisted(() => ({
  bid: null as MarketplaceLiveBid | null,
  listingState: null as 'available' | 'reserved' | 'sold' | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid', () => ({
  useMarketplaceLiveBid: () => ({ ref: () => {}, bid: liveBid.bid, listingState: liveBid.listingState }),
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  return await import('@/test/mocks/marketplace-media-hooks');
});

function catalogItem(index = 0): MarketplaceCatalogItem {
  const record = createCommerceSandboxCatalog().listings[index];
  return buildMarketplaceCatalogItems([toCommerceListingModel(record)], [])[0];
}

beforeEach(() => {
  liveBid.bid = null;
  liveBid.listingState = null;
});

describe('MarketplaceListingCard', () => {
  it('renders listing terms and canonical detail link', () => {
    const listing = catalogItem();
    render(<MarketplaceListingCard listing={listing} shopName="Satoshi Vintage" />);

    expect(screen.getByRole('heading', { name: 'Vintage leather boots' })).toBeInTheDocument();
    expect(screen.getByText('$125.00')).toBeInTheDocument();
    expect(screen.getByText('Satoshi Vintage')).toBeInTheDocument();
    expect(screen.getByText('No rating yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View Vintage leather boots' })).toHaveAttribute(
      'href',
      `/marketplace/listing/${listing.sellerId}/${listing.listingId}`,
    );
  });

  it('renders the shop name in secondary-foreground so supporting text meets contrast on the card', () => {
    render(<MarketplaceListingCard listing={catalogItem()} shopName="Satoshi Vintage" />);

    const shop = screen.getByText('Satoshi Vintage');
    expect(shop).toHaveClass('text-secondary-foreground');
    expect(shop).not.toHaveClass('text-muted-foreground');
  });

  it('renders card meta in secondary-foreground so small text meets contrast on the card', () => {
    render(<MarketplaceListingCard listing={catalogItem()} shopName="Satoshi Vintage" />);

    for (const label of ['No rating yet', 'Good']) {
      const node = screen.getByText(label);
      expect(node).toHaveClass('text-secondary-foreground');
      expect(node).not.toHaveClass('text-muted-foreground');
    }
  });

  it('renders the seller rating aggregate when the catalog projection carries reviews', () => {
    const listing = catalogItemFromCatalogEntry(
      createCommerceCatalogEntryFixture({ reputation: { avg: 4.6, count: 17, verifiedCount: 11 } }),
    );

    render(<MarketplaceListingCard listing={listing} shopName="Satoshi Vintage" />);

    expect(
      screen.getByRole('img', { name: 'Rated 4.6 out of 5 from 17 reviews, 11 verified purchases' }),
    ).toBeInTheDocument();
    expect(screen.getByTitle('17 reviews')).toBeInTheDocument();
    expect(screen.queryByText('No rating yet')).not.toBeInTheDocument();
  });

  it('labels the auction price as a starting bid instead of claiming a current price', () => {
    render(<MarketplaceListingCard listing={catalogItem(2)} shopName="Proof of Film" />);

    expect(screen.getByText('Auction')).toBeInTheDocument();
    expect(screen.getByText('Ends Aug 29')).toBeInTheDocument();
    expect(screen.getByText('Starting bid')).toBeInTheDocument();
    expect(screen.getByText('$45.00')).toBeInTheDocument();
    expect(screen.getByText('Buy now $125.00')).toBeInTheDocument();
    expect(screen.queryByText(/current bid/i)).not.toBeInTheDocument();
  });

  it('renders an auction whose stale index row lacks terms without inventing them', () => {
    const listing = catalogItemFromCatalogEntry(
      createCommerceCatalogEntryFixture({ sale_format: 'auction', auction: null }),
    );
    render(<MarketplaceListingCard listing={listing} shopName="Satoshi Vintage" />);

    expect(screen.getByText('Auction')).toBeInTheDocument();
    expect(screen.getByText('Starting bid')).toBeInTheDocument();
    expect(screen.getByText('$125.00')).toBeInTheDocument();
    expect(screen.queryByText(/^Ends /)).not.toBeInTheDocument();
    expect(screen.queryByText(/Buy now/)).not.toBeInTheDocument();
  });

  it('renders the first listing image as the card cover, resolved to the homeserver public URL', () => {
    const listing = catalogItem();
    render(<MarketplaceListingCard listing={listing} shopName="Satoshi Vintage" />);

    const cover = screen.getByAltText(listing.title);
    expect(cover).toHaveAttribute('src', expect.stringContaining('/pub/pubky.app/marketplace/v1/media/'));
    expect(cover).toHaveAttribute('src', expect.stringContaining(`pubky-host=${listing.sellerId}`));
  });

  it('falls back to the gradient rendering when the cover image fails to load', () => {
    const listing = catalogItem();
    render(<MarketplaceListingCard listing={listing} shopName="Satoshi Vintage" />);

    fireEvent.error(screen.getByAltText(listing.title));

    expect(screen.queryByAltText(listing.title)).not.toBeInTheDocument();
  });

  it('renders no image element at all for a media-less catalog entry', () => {
    const listing = catalogItemFromCatalogEntry(createCommerceCatalogEntryFixture({ media_urls: [] }));
    render(<MarketplaceListingCard listing={listing} shopName="Satoshi Vintage" />);

    expect(screen.queryByAltText(listing.title)).not.toBeInTheDocument();
  });

  it('renders the horizontal card variant for list layout', () => {
    render(<MarketplaceListingCard listing={catalogItem()} layout="list" />);

    expect(screen.getByTestId('card')).toHaveClass('flex-row');
  });

  it('shows the live current bid and bid count once the transaction service answered with bids', () => {
    liveBid.bid = {
      currentPrice: { amountMinor: 7_500, currency: 'USD', exponent: 2 },
      bidCount: 4,
    };
    render(<MarketplaceListingCard listing={catalogItem(2)} shopName="Proof of Film" />);

    expect(screen.getByText('Current bid')).toBeInTheDocument();
    expect(screen.getByText('$75.00')).toBeInTheDocument();
    expect(screen.getByText('4 bids')).toBeInTheDocument();
    expect(screen.queryByText('Starting bid')).not.toBeInTheDocument();
    expect(screen.queryByText('$45.00')).not.toBeInTheDocument();
  });

  it('keeps the starting-bid label when the service reports zero bids', () => {
    liveBid.bid = {
      currentPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      bidCount: 0,
    };
    render(<MarketplaceListingCard listing={catalogItem(2)} shopName="Proof of Film" />);

    expect(screen.getByText('Starting bid')).toBeInTheDocument();
    expect(screen.getByText('$45.00')).toBeInTheDocument();
    expect(screen.queryByText(/current bid/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ bids?/)).not.toBeInTheDocument();
  });

  it('never shows live bid state on fixed-price listings even if a bid value leaks in', () => {
    liveBid.bid = {
      currentPrice: { amountMinor: 7_500, currency: 'USD', exponent: 2 },
      bidCount: 2,
    };
    render(<MarketplaceListingCard listing={catalogItem()} shopName="Satoshi Vintage" />);

    expect(screen.getByText('$125.00')).toBeInTheDocument();
    expect(screen.queryByText(/current bid/i)).not.toBeInTheDocument();
    expect(screen.queryByText('2 bids')).not.toBeInTheDocument();
  });

  it('replaces Buy now with the holding sentence when the listing is reserved', () => {
    liveBid.listingState = 'reserved';
    render(<MarketplaceListingCard listing={catalogItem()} shopName="Satoshi Vintage" />);

    expect(screen.getByText('Held')).toBeInTheDocument();
    expect(screen.queryByText('Buy now')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Another buyer is currently paying for this item. If payment does not complete, it will become available again.',
      ),
    ).toBeInTheDocument();
  });
});

describe('MarketplaceListingCard - Snapshots', () => {
  it('matches the fixed-price listing snapshot', () => {
    const { container } = render(<MarketplaceListingCard listing={catalogItem()} shopName="Satoshi Vintage" />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it('matches the auction listing snapshot rendered from an index entry', () => {
    const listing = catalogItemFromCatalogEntry(
      createCommerceCatalogEntryFixture({
        id: `${'y'.repeat(52)}:rangefinder_camera`,
        listing_id: 'rangefinder_camera',
        title: '35mm rangefinder camera',
        category_id: 'electronics-cameras-film',
        condition: 'excellent',
        sale_format: 'auction',
        price: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
        auction: {
          startsAt: '2026-08-19T20:00:00.000Z',
          endsAt: '2026-08-29T20:00:00.000Z',
          buyNowPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        },
      }),
    );
    const { container } = render(<MarketplaceListingCard listing={listing} shopName="Proof of Film" />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
