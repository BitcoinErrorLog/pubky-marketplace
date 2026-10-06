import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MarketplaceSimilarItems } from './MarketplaceSimilarItems';

vi.mock('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog', () => ({
  useMarketplaceCatalog: () => ({
    listings: [
      { id: 'current', sellerId: 'seller', listingId: 'current', title: 'Current item' },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `other-${i}`,
        sellerId: 'other',
        listingId: `item-${i}`,
        title: `Other item ${i}`,
      })),
    ],
    shopsBySeller: new Map(),
    isLoading: false,
  }),
}));
vi.mock('./MarketplaceListingCard', () => ({
  MarketplaceListingCard: ({ listing }: { listing: { title: string } }) => <article>{listing.title}</article>,
}));
it('excludes the current item and displays up to six reused catalog cards', () => {
  render(<MarketplaceSimilarItems categoryId="fashion" sellerPubky="seller" listingId="current" />);
  expect(screen.getByRole('heading', { name: 'Similar items', level: 2 })).toBeInTheDocument();
  expect(screen.queryByText('Current item')).not.toBeInTheDocument();
  expect(screen.getAllByRole('article')).toHaveLength(6);
});
