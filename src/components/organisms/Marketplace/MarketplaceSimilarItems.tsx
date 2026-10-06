'use client';

import { Heading } from '@/atoms/Heading/Heading';
import { useMarketplaceCatalog } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog';
import type { MarketplaceCatalogFilters } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { MarketplaceListingCard } from './MarketplaceListingCard';

const SIMILAR_ITEM_FILTERS: MarketplaceCatalogFilters = {
  query: '',
  categoryId: null,
  saleFormat: 'all',
  conditions: [],
  minimumPriceMinor: null,
  maximumPriceMinor: null,
  countryCode: null,
  sort: 'recommended',
};

export function MarketplaceSimilarItems({
  categoryId,
  sellerPubky,
  listingId,
}: {
  categoryId: string;
  sellerPubky: string;
  listingId: string;
}) {
  const { listings, shopsBySeller, isLoading } = useMarketplaceCatalog([], [], {
    ...SIMILAR_ITEM_FILTERS,
    categoryId,
  });
  const similar = listings.filter((item) => item.sellerId !== sellerPubky || item.listingId !== listingId).slice(0, 6);
  return (
    <section
      aria-labelledby="similar-items-heading"
      className="flex min-w-0 flex-col gap-4 border-t border-border pt-6"
    >
      <div id="similar-items-heading">
        <Heading level={2} size="lg" className="font-medium text-muted-foreground">
          Similar items
        </Heading>
      </div>
      {similar.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {similar.map((item, index) => (
            <MarketplaceListingCard
              key={item.id}
              listing={item}
              shopName={shopsBySeller.get(item.sellerId)?.name}
              index={index}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm font-medium text-muted-foreground" role="status">
          {isLoading ? 'Loading similar items…' : 'No similar items yet'}
        </p>
      )}
    </section>
  );
}
