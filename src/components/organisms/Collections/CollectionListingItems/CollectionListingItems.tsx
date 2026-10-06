'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { PackageX } from 'lucide-react';
import { Container } from '@/atoms/Container/Container';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import { catalogItemFromListingModel } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { ListingUriRef } from '@/libs/commerce/listingUri';
import { MarketplaceListingCard } from '@/organisms/Marketplace/MarketplaceListingCard';

export interface CollectionListingItemsProps {
  /** Listing refs parsed from the collection envelope's listing item URIs, in envelope order. */
  listings: ListingUriRef[];
}

/**
 * Marketplace listings curated into a collection.
 *
 * Collection post items render through the Nexus post stream, which cannot
 * return marketplace listings — so listing items get their own section,
 * hydrated through the same local-first commerce path the marketplace uses
 * (`getOrFetchListing`: cache first, owner homeserver on miss) and rendered
 * with the same `MarketplaceListingCard` as the catalog.
 *
 * Honesty: a listing that cannot be hydrated (deleted, homeserver
 * unreachable) renders an explicit "unavailable" cell instead of being
 * silently dropped or faked.
 */
export function CollectionListingItems({ listings }: CollectionListingItemsProps) {
  const listingsKey = listings.map((ref) => `${ref.sellerPubky}:${ref.listingId}`).join(',');

  // Ids whose hydration attempt has finished (success or failure). Until an
  // id settles its cell stays a skeleton, so "unavailable" is only ever shown
  // for listings that genuinely could not be hydrated — not mid-fetch.
  const [settledIds, setSettledIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSettledIds(new Set());
    let stale = false;

    for (const ref of listings) {
      const compositeId = `${ref.sellerPubky}:${ref.listingId}`;
      void CommerceController.getOrFetchListing(ref.sellerPubky, ref.listingId)
        .catch(() => {})
        .finally(() => {
          if (stale) return;
          setSettledIds((current) => new Set(current).add(compositeId));
        });
    }

    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listingsKey encodes every ref
  }, [listingsKey]);

  const cachedListings = useLiveQuery(
    async () => {
      return await Promise.all(listings.map((ref) => CommerceController.getListing(ref.sellerPubky, ref.listingId)));
    },
    [listingsKey],
    undefined,
  );

  if (listings.length === 0) return null;

  return (
    <Container overrideDefaults data-cy="collection-listing-items" className="flex w-full flex-col gap-3">
      <Typography as="p" className="text-sm font-semibold text-muted-foreground">
        Listings in this collection
      </Typography>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:gap-5">
        {listings.map((ref, index) => {
          const compositeId = `${ref.sellerPubky}:${ref.listingId}`;
          const cached = cachedListings?.[index];

          if (cached) {
            return <MarketplaceListingCard key={compositeId} listing={catalogItemFromListingModel(cached)} />;
          }

          if (!settledIds.has(compositeId) || cachedListings === undefined) {
            return <Skeleton key={compositeId} className="aspect-[4/5] w-full rounded-xl" />;
          }

          return (
            <Container
              key={compositeId}
              overrideDefaults
              data-cy="collection-listing-unavailable"
              className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center"
            >
              <PackageX className="size-8 text-muted-foreground" />
              <Typography as="p" overrideDefaults className="px-4 text-sm text-muted-foreground">
                Listing unavailable
              </Typography>
            </Container>
          );
        })}
      </div>
    </Container>
  );
}
