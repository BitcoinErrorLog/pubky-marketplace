'use client';

import { useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceFirstMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { parseListingAggregateId } from '@/libs/commerce/marketplace-conversation-query';

/** Listing media is optional; order details always come from the checkout snapshot. */
export function useMarketplaceOrderItemMedia(listingAggregateId: string) {
  const [media, setMedia] = useState<{ aggregateId: string; urls: string[] } | null>(null);

  useEffect(() => {
    const listing = parseListingAggregateId(listingAggregateId);
    if (!listing) return;
    let active = true;
    void CommerceController.getOrFetchListing(listing.sellerPubky, listing.listingId)
      .then((record) => {
        if (active) {
          setMedia({
            aggregateId: listingAggregateId,
            urls: record.media.filter(({ type }) => type === 'image').map(({ url }) => url),
          });
        }
      })
      .catch(() => {
        // The order remains readable if the original listing is unavailable.
        if (active) setMedia({ aggregateId: listingAggregateId, urls: [] });
      });
    return () => {
      active = false;
    };
  }, [listingAggregateId]);

  return useMarketplaceFirstMediaUrl(media?.aggregateId === listingAggregateId ? media.urls : []);
}
