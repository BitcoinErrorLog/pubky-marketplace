'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Zap } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { UseMarketplaceDropClaimResult } from '@/hooks/useMarketplaceDropClaim/useMarketplaceDropClaim';
import { useMarketplaceFirstMediaUrls } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { getMarketplaceCheckoutRoute, getMarketplaceDropCheckoutRoute } from '@/libs/commerce/checkout-phase';
import { formatCommerceMoney } from '@/libs/commerce/format';
import type { CommerceDropRecord, CommerceListingRecord } from '@/libs/commerce/marketplace-records';
import { useAuthStore } from '@/stores/auth/auth.store';
import { MarketplaceIndicativePrice } from './MarketplaceIndicativePrice';
import { MarketplaceSessionRequiredCard } from './MarketplaceSessionRequiredCard';

type HydratedDropListing = {
  listingId: string;
  record: CommerceListingRecord | null;
};

/**
 * The live claim surface (drops design, "At T-0"): the drop's listings,
 * each with ONE "Claim one" button — quantity 1 of one listing per checkout
 * is the v1 rule the service enforces. Optimistic `submitting` state, then
 * the authoritative result; a refusal renders client-owned static copy
 * verbatim in an assertive region. No queue UI exists anywhere.
 */
export function DropClaimPanel({
  record,
  claim,
  remainingAllowance,
  isOwner = false,
}: {
  record: CommerceDropRecord;
  claim: UseMarketplaceDropClaimResult;
  remainingAllowance: number | null;
  isOwner?: boolean;
}) {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const { requireAuth } = useRequireAuth();
  const [listings, setListings] = useState<HydratedDropListing[] | null>(null);

  useEffect(() => {
    let active = true;
    const hydrate = async () => {
      const hydrated = await Promise.all(
        record.listingIds.map(async (listingId) => {
          try {
            const listing = await CommerceController.getOrFetchListing(record.ownerPubky, listingId);
            return { listingId, record: listing };
          } catch {
            // An unreachable listing record renders as an honest bare row —
            // the claim still works because checkout resolves the aggregate
            // from the transaction service, not from this display read.
            return { listingId, record: null };
          }
        }),
      );
      if (active) setListings(hydrated);
    };
    void hydrate();
    return () => {
      active = false;
    };
  }, [record.ownerPubky, record.listingIds]);
  const mediaUrls = useMarketplaceFirstMediaUrls(
    (listings ?? []).map(({ record: listing }) => (listing ? listing.media.map(({ url }) => url) : [])),
  );

  return (
    <section aria-label="Claim" className="flex flex-col gap-3 rounded-xl border border-brand/40 bg-brand/5 p-4">
      <Heading level={2} size="sm" className="flex items-center gap-2 text-base">
        <Zap className="size-4 text-brand" />
        Claim
      </Heading>
      <Typography as="p" className="text-sm text-muted-foreground">
        A drop order is one unit of one listing per checkout. First come, first served — the service answers reserved or
        refused, immediately.
      </Typography>
      {claim.needsSession && claim.sessionError ? (
        <MarketplaceSessionRequiredCard />
      ) : !currentUserPubky ? (
        <Button size="lg" className="w-fit rounded-full" onClick={() => requireAuth(() => undefined)}>
          <Zap className="mr-2 size-4" />
          Sign in to buy
        </Button>
      ) : (
        <ul className="flex flex-col gap-3">
          {(listings ?? record.listingIds.map((listingId) => ({ listingId, record: null }))).map(
            ({ listingId, record: listing }, index) => {
              const compositeId = `${record.ownerPubky}:${listingId}`;
              const isClaimed = claim.claimedListingIds.has(compositeId);
              const claimDeadline = claim.claimDeadlines?.get(compositeId);
              const allowanceSpent = remainingAllowance === 0;
              const mediaUrl = mediaUrls[index] ?? null;
              const price = listing?.sale.format === 'fixed_price' ? listing.sale.unitPrice : null;
              return (
                <li key={listingId} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                  {mediaUrl && (
                    <div className="relative size-12 shrink-0 overflow-hidden rounded-md">
                      {/* eslint-disable-next-line @next/next/no-img-element -- homeserver media bypasses Next image optimization */}
                      <img src={mediaUrl} alt="" className="size-full object-cover object-center" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <Typography as="p" className="truncate text-sm font-semibold">
                      {listing?.title ?? `Listing ${listingId}`}
                    </Typography>
                    {price ? (
                      <Typography as="p" className="text-sm text-brand">
                        {formatCommerceMoney(price)}{' '}
                        <MarketplaceIndicativePrice money={price} className="text-xs font-normal" />
                      </Typography>
                    ) : listing ? null : (
                      <Typography as="p" className="text-xs text-muted-foreground">
                        The listing record could not be loaded; claiming still works.
                      </Typography>
                    )}
                  </div>
                  {isClaimed ? (
                    <div className="flex flex-col items-end gap-1">
                      <Button asChild variant="secondary" size="sm" className="rounded-full">
                        <Link
                          href={getMarketplaceCheckoutRoute(claim.claimedOrderIds?.get(compositeId))}
                          overrideDefaults
                        >
                          <CheckCircle2 className="mr-2 size-4 text-brand" />
                          Claimed — Continue checkout
                        </Link>
                      </Button>
                      {claimDeadline && (
                        <Typography as="p" className="text-right text-xs text-muted-foreground">
                          Complete payment by{' '}
                          {new Date(claimDeadline).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </Typography>
                      )}
                    </div>
                  ) : isOwner || allowanceSpent ? (
                    <Button size="sm" className="rounded-full" disabled>
                      {allowanceSpent ? <CheckCircle2 className="mr-2 size-4" /> : <Zap className="mr-2 size-4" />}
                      {isOwner ? 'You cannot claim from your own drop' : 'Per-buyer limit reached'}
                    </Button>
                  ) : (
                    <Button asChild size="sm" className="rounded-full">
                      <Link
                        href={getMarketplaceDropCheckoutRoute({
                          sellerPubky: record.ownerPubky,
                          dropId: record.dropId,
                          listingId,
                        })}
                        overrideDefaults
                      >
                        <Zap className="mr-2 size-4" />
                        Claim one
                      </Link>
                    </Button>
                  )}
                </li>
              );
            },
          )}
        </ul>
      )}
      {claim.failure && (
        <Typography as="p" role="alert" aria-live="assertive" className="text-sm font-medium text-amber-300">
          {claim.failure}
        </Typography>
      )}
      {remainingAllowance === 0 && currentUserPubky && (
        <Typography as="p" role="status" className="text-sm font-medium text-muted-foreground">
          You have reached this drop&apos;s per-buyer limit.
        </Typography>
      )}
    </section>
  );
}
