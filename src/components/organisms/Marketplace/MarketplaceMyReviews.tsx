'use client';

import { useEffect, useState } from 'react';
import { BadgeCheck, PenLine } from 'lucide-react';
import { getMarketplaceListingRoute } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import { cn } from '@/libs/utils/utils';
import type { CommerceReviewModelSchema } from '@/models/commerce/commerce.schema';
import { MarketplaceStarRating } from '@/molecules/MarketplaceStarRating/MarketplaceStarRating';
import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * The buyer-side "my reviews" panel on the orders page: the local-first rows
 * of every review this user has published (or staged), newest first. Each row
 * states its own truth — the stars and text from the record, whether the
 * embedded purchase attestation verified at publication time, and whether the
 * homeserver publication actually landed (`pending` rows retry when this
 * surface loads).
 */
export function MarketplaceMyReviews({ className }: { className?: string }) {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const [reviews, setReviews] = useState<CommerceReviewModelSchema[] | null>(null);

  useEffect(() => {
    if (currentUserPubky === null) return;
    let active = true;
    CommerceController.getOwnMarketplaceReviews()
      .then((rows) => {
        if (active) setReviews(rows);
      })
      .catch(() => {
        if (active) setReviews([]);
      });
    return () => {
      active = false;
    };
  }, [currentUserPubky]);

  if (currentUserPubky === null || reviews === null || reviews.length === 0) return null;

  return (
    <Card className={cn('border py-5', className)} data-testid="marketplace-my-reviews">
      <CardContent className="flex flex-col gap-3 px-5">
        <Typography as="h2" className="flex items-center gap-2 text-sm font-semibold">
          <PenLine className="size-4" />
          My reviews
        </Typography>
        <ul className="flex flex-col gap-3">
          {reviews.map((review) => (
            <li
              key={review.id}
              className="flex flex-col gap-1.5 rounded-lg border border-border/60 p-3"
              data-cy="marketplace-my-review-item"
            >
              <div className="flex flex-wrap items-center gap-2">
                <MarketplaceStarRating rating={review.record.ratings.overall} size="sm" />
                <Link
                  href={getMarketplaceListingRoute(review.record.listingOwnerPubky, review.record.listingId)}
                  overrideDefaults
                  className="text-xs font-medium text-foreground hover:underline"
                >
                  View listing
                </Link>
                <Typography as="span" overrideDefaults className="text-xs text-muted-foreground">
                  {formatDate(review.record.updatedAt)}
                </Typography>
                {review.attestation_verified ? (
                  <Badge variant="secondary" className="gap-1 text-emerald-400">
                    <BadgeCheck className="size-3" />
                    Attested
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">
                    Unattested
                  </Badge>
                )}
                {review.sync_status !== 'synced' && (
                  <Badge
                    variant="outline"
                    className="text-amber-400"
                    title="Publication is pending. Reopening this page will retry."
                  >
                    Publication pending
                  </Badge>
                )}
              </div>
              <Typography as="p" overrideDefaults className="line-clamp-3 text-sm whitespace-pre-wrap text-foreground">
                {review.record.text}
              </Typography>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso),
  );
}
