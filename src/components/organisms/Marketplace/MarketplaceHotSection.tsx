'use client';

import { APP_ROUTES } from '@/app/routes';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import type { MarketplaceCatalogItem } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { useMarketplaceHotListings } from '@/hooks/useMarketplaceHotListings/useMarketplaceHotListings';
import type { CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { cn } from '@/libs/utils/utils';
import { MarketplaceListingCard } from '@/organisms/Marketplace/MarketplaceListingCard';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import type { CommerceSort } from '@/stores/commerce/commerce.types';

export interface MarketplaceHotSectionProps {
  className?: string;
}

/**
 * Marketplace discovery modules for the Hot page: "Ending soon" (auctions
 * closing soonest, from the Nexus auction end-time stream) and "Fresh
 * listings" (most recently updated).
 *
 * Ranking honesty: both orderings are deadline/recency facts from the index.
 * Bid-count or popularity ranking is deliberately absent — bids live in the
 * transaction service, not in the Nexus listing index, so any such ordering
 * here would be fabricated. Each module renders only when it has real cards;
 * the whole section renders nothing when the index has nothing (or the
 * marketplace adapter mode is `unavailable` — the nav-entry gate, enforced
 * inside the data hook).
 *
 * "See all" pre-selects the matching catalog sort (the catalog's existing
 * ending-soon / newest filters) before navigating, so the full catalog opens
 * on the same ordering the module showed.
 */
export function MarketplaceHotSection({ className }: MarketplaceHotSectionProps) {
  const { endingSoon, fresh, shopsBySeller } = useMarketplaceHotListings();

  if (endingSoon.length === 0 && fresh.length === 0) return null;

  return (
    <Container overrideDefaults className={cn('flex flex-col gap-6', className)}>
      {endingSoon.length > 0 && (
        <MarketplaceHotModule
          heading="Ending soon"
          seeAllSort="ending_soon"
          listings={endingSoon}
          shopsBySeller={shopsBySeller}
        />
      )}
      {fresh.length > 0 && (
        <MarketplaceHotModule
          heading="Fresh listings"
          seeAllSort="newest"
          listings={fresh}
          shopsBySeller={shopsBySeller}
        />
      )}
    </Container>
  );
}

function MarketplaceHotModule({
  heading,
  seeAllSort,
  listings,
  shopsBySeller,
}: {
  heading: string;
  seeAllSort: CommerceSort;
  listings: MarketplaceCatalogItem[];
  shopsBySeller: Map<string, CommerceShopRecord>;
}) {
  const setSort = useCommerceStore((state) => state.setSort);

  return (
    <section aria-label={`Marketplace: ${heading}`} className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col">
          <Typography
            as="span"
            className="text-[11px] leading-4 font-medium tracking-[1.2px] text-muted-foreground uppercase"
          >
            Marketplace
          </Typography>
          <Heading level={5} size="lg" className="font-light text-muted-foreground">
            {heading}
          </Heading>
        </div>
        <Link
          href={APP_ROUTES.MARKETPLACE}
          overrideDefaults
          className="shrink-0 text-sm font-medium text-brand hover:underline"
          onClick={() => setSort(seeAllSort)}
        >
          See all
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {listings.map((listing) => (
          <MarketplaceListingCard
            key={listing.id}
            listing={listing}
            shopName={shopsBySeller.get(listing.sellerId)?.name}
          />
        ))}
      </div>
    </section>
  );
}
