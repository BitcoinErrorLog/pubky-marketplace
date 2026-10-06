'use client';

import { APP_ROUTES } from '@/app/routes';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { useFollowedSellerListings } from '@/hooks/useFollowedSellerListings/useFollowedSellerListings';
import { MarketplaceListingCard } from '@/organisms/Marketplace/MarketplaceListingCard';

/**
 * Home-feed shelf of recent active listings from sellers the viewer follows.
 *
 * This is content, not promo — there is deliberately no dismissal: the shelf
 * renders nothing at all (no empty shell, no skeleton) unless a followed
 * seller actually has active listings, and disappears again when they don't.
 * A small "Marketplace" label plus a "See all" link keep the source and the
 * way to the full catalog explicit. Posts are untouched: this is a dedicated
 * marketplace module on the feed surface, never listings injected into the
 * post stream.
 *
 * Rendered only when the marketplace adapter mode is not `unavailable` and a
 * user is signed in (both enforced inside the data hook, which is inert
 * otherwise).
 */
export function MarketplaceFollowedSellersShelf() {
  const { listings, shopsBySeller } = useFollowedSellerListings();

  if (listings.length === 0) return null;

  return (
    <section aria-label="Marketplace listings from sellers you follow" className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col">
          <Typography
            as="span"
            className="text-[11px] leading-4 font-medium tracking-[1.2px] text-muted-foreground uppercase"
          >
            Marketplace
          </Typography>
          <Typography as="h2" className="text-base leading-6 font-semibold text-foreground">
            From sellers you follow
          </Typography>
        </div>
        <Link
          href={APP_ROUTES.MARKETPLACE}
          overrideDefaults
          className="shrink-0 text-sm font-medium text-brand hover:underline"
        >
          See all
        </Link>
      </div>
      <div className="-mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-2">
        {listings.map((listing) => (
          <div key={listing.id} className="w-44 shrink-0 snap-start sm:w-52">
            <MarketplaceListingCard listing={listing} shopName={shopsBySeller.get(listing.sellerId)?.name} />
          </div>
        ))}
      </div>
    </section>
  );
}
