'use client';

import { useEffect, useState } from 'react';
import { BadgeCheck, MessageSquareReply, Star } from 'lucide-react';
import { getMarketplaceShopRoute, getProfileRoute, PROFILE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Textarea } from '@/atoms/Textarea/Textarea';
import { Typography } from '@/atoms/Typography/Typography';
import { isTrustedMarketplaceAttestor } from '@/config/commerce';
import { isSocialLinkOutEnabled } from '@/config/social';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceReviews } from '@/hooks/useMarketplaceReviews/useMarketplaceReviews';
import { cn } from '@/libs/utils/utils';
import type { CommerceIndexedReview, CommerceReviewResponseModelSchema } from '@/models/commerce/commerce.schema';
import { MarketplaceStarRating } from '@/molecules/MarketplaceStarRating/MarketplaceStarRating';
import { ProfileOnPubkyLink } from '@/molecules/ProfileOnPubkyLink/ProfileOnPubkyLink';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';

export interface MarketplaceReviewsSectionProps {
  sellerPubky: string;
  /** When set, the section lists the buyer reviews of one listing; otherwise the seller's. */
  listingId?: string;
  className?: string;
  infoCard?: boolean;
}

/**
 * The public review list for a listing or shop page, read from the Nexus
 * review index with the ratified labeling rules:
 *
 * - D5: every review states its verification honestly — a "Verified
 *   purchase" badge only when the embedded attestation cryptographically
 *   verified at the index AND the attestor is one this app trusts; an
 *   "Attested (unrecognized attestor)" label when the signature verified
 *   but the signer is not in this client's trust list; an explicit
 *   "Unverified" label otherwise.
 * - D7: the subject's single revisable response threads beneath the review,
 *   and the respond/edit affordance renders only for the signed-in subject.
 *
 * When no review-aware index serves this deployment the section renders
 * nothing at all — absence, not an empty claim.
 */
export function MarketplaceReviewsSection({
  sellerPubky,
  listingId,
  className,
  infoCard = false,
}: MarketplaceReviewsSectionProps) {
  const { status, reviews, isFetching, hasMore, loadMore } = useMarketplaceReviews({ sellerPubky, listingId });
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);

  if (status === 'unavailable' || status === 'loading') return null;

  return (
    <section
      className={cn(
        'flex w-full gap-3',
        infoCard
          ? 'marketplace-item-details min-w-0 items-start rounded-xl bg-card p-5 text-card-foreground shadow-sm sm:col-span-2'
          : 'flex-col',
        className,
      )}
      data-testid="marketplace-reviews-section"
    >
      {infoCard && <Star className="size-5 shrink-0 text-brand" aria-hidden="true" />}
      <div className={cn('flex min-w-0 flex-1 flex-col', infoCard ? 'gap-1' : 'gap-3')}>
        <Heading
          level={2}
          size={infoCard ? 'sm' : 'lg'}
          className={infoCard ? 'text-sm leading-5 font-semibold' : 'font-medium text-muted-foreground'}
        >
          Reviews
        </Heading>
        {reviews.length === 0 ? (
          <Typography
            as="p"
            overrideDefaults
            className={cn('text-muted-foreground', infoCard ? 'text-sm leading-5 font-medium' : 'text-xs')}
          >
            No reviews yet
          </Typography>
        ) : (
          <ul className="flex flex-col gap-4">
            {reviews.map((review) => (
              <MarketplaceReviewItem
                key={`${review.reviewerId}:${review.reviewId}`}
                review={review}
                currentUserPubky={currentUserPubky}
              />
            ))}
          </ul>
        )}
        {hasMore && (
          <Button
            size="sm"
            variant="secondary"
            className="self-start rounded-full"
            disabled={isFetching}
            onClick={loadMore}
          >
            {isFetching ? 'Loading…' : 'Load more reviews'}
          </Button>
        )}
      </div>
    </section>
  );
}

function MarketplaceReviewItem({
  review,
  currentUserPubky,
}: {
  review: CommerceIndexedReview;
  currentUserPubky: string | null;
}) {
  const isSubject = currentUserPubky !== null && currentUserPubky === review.subjectId;
  const [composerOpen, setComposerOpen] = useState(false);
  const [response, setResponse] = useState(review.response);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border/60 p-3" data-cy="marketplace-review-item">
      <div className="flex flex-wrap items-center gap-2">
        <MarketplaceStarRating rating={review.ratingOverall} size="sm" />
        <Link
          href={
            isSocialLinkOutEnabled()
              ? getMarketplaceShopRoute(review.reviewerId)
              : getProfileRoute(PROFILE_ROUTES.PROFILE, review.reviewerId)
          }
          overrideDefaults
          className="text-xs font-medium text-foreground hover:underline"
        >
          {review.reviewerId.slice(0, 8)}…
        </Link>
        <ProfileOnPubkyLink pubky={review.reviewerId} />
        <Typography as="span" overrideDefaults className="text-xs text-muted-foreground">
          {formatReviewDate(review.createdAt)}
        </Typography>
        {review.editedLate && (
          <Typography
            as="span"
            overrideDefaults
            className="text-xs text-amber-400"
            title="This review was revised after the service's edit window."
          >
            Edited late
          </Typography>
        )}
        <MarketplaceReviewVerificationBadge review={review} />
      </div>
      {review.text.length > 0 && (
        <Typography as="p" overrideDefaults className="text-sm whitespace-pre-wrap text-foreground">
          {review.text}
        </Typography>
      )}
      {response !== null && (
        <div className="flex flex-col gap-1 rounded-md border-l-2 border-brand/50 bg-muted/40 p-2 pl-3">
          <Typography
            as="p"
            overrideDefaults
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
          >
            <MessageSquareReply className="size-3.5" />
            Response from {response.responderId === review.subjectId ? 'the reviewed party' : 'the subject'} ·{' '}
            {formatReviewDate(response.updatedAt)}
          </Typography>
          <Typography as="p" overrideDefaults className="text-sm whitespace-pre-wrap text-foreground">
            {response.text}
          </Typography>
        </div>
      )}
      {isSubject && !composerOpen && (
        <Button size="sm" variant="ghost" className="self-start rounded-full" onClick={() => setComposerOpen(true)}>
          {response === null ? 'Respond' : 'Edit response'}
        </Button>
      )}
      {isSubject && composerOpen && (
        <MarketplaceReviewResponseComposer
          review={review}
          onClose={() => setComposerOpen(false)}
          onPublished={(published) => {
            setResponse(toIndexedReviewResponse(published));
            setComposerOpen(false);
          }}
        />
      )}
    </li>
  );
}

/**
 * The D5 labeling in one place. Verification proves the SIGNER; whether that
 * signer is a trusted attestor is this client's configuration
 * (`MARKETPLACE_TRUSTED_ATTESTORS`) — so an attested review from an
 * unrecognized signer is labeled exactly that, never upgraded to "verified".
 */
function MarketplaceReviewVerificationBadge({ review }: { review: CommerceIndexedReview }) {
  if (review.verified && review.attestorId !== null && isTrustedMarketplaceAttestor(review.attestorId)) {
    return (
      <Badge variant="secondary" className="gap-1 text-emerald-400">
        <BadgeCheck className="size-3" />
        Verified purchase
      </Badge>
    );
  }
  if (review.verified) {
    return (
      <Badge
        variant="outline"
        className="text-muted-foreground"
        title={`The purchase attestation verified cryptographically, but its signer (${review.attestorId ?? 'unknown'}) is not an attestor this app recognizes.`}
      >
        Attested (unrecognized attestor)
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-muted-foreground"
      title="This review carries no verifiable purchase attestation."
    >
      Unverified
    </Badge>
  );
}

/**
 * The subject's single revisable response (ratified D7): a homeserver record
 * on the responder's own homeserver, revised in place — the composer loads
 * the local prior (if any) to prefill and to preserve `createdAt`/revision.
 */
function MarketplaceReviewResponseComposer({
  review,
  onClose,
  onPublished,
}: {
  review: CommerceIndexedReview;
  onClose: () => void;
  onPublished: (response: CommerceReviewResponseModelSchema) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);

  useEffect(() => {
    let active = true;
    CommerceController.getOwnMarketplaceReviewResponse(review.reviewId)
      .then((own) => {
        if (active) setText(own?.record.text ?? review.response?.text ?? '');
      })
      .catch(() => {
        if (active) setText(review.response?.text ?? '');
      });
    return () => {
      active = false;
    };
  }, [review.reviewId, review.response?.text]);

  if (text === null) return null;

  const publish = async () => {
    setIsPublishing(true);
    try {
      const published = await CommerceController.publishMarketplaceReviewResponse({
        review,
        text: text.trim(),
        priorRevision: review.response?.revision ?? null,
        priorCreatedAt: review.response?.createdAt ?? null,
      });
      toast({
        title: 'Response published',
        description: 'Your response is saved and will appear shortly.',
      });
      onPublished(published);
    } catch {
      toast({ variant: 'error', description: 'Could not publish the response.' });
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-cy="marketplace-review-response-composer">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Write a public response to this review…"
        rows={3}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          className="rounded-full"
          disabled={isPublishing || text.trim().length === 0}
          onClick={publish}
        >
          {isPublishing ? 'Publishing…' : review.response === null ? 'Publish response' : 'Update response'}
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full" disabled={isPublishing} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function formatReviewDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso),
  );
}

function toIndexedReviewResponse(
  response: CommerceReviewResponseModelSchema,
): NonNullable<CommerceIndexedReview['response']> {
  return {
    responderId: response.owner_id,
    text: response.record.text,
    createdAt: response.record.createdAt,
    updatedAt: response.record.updatedAt,
    revision: response.record.revision,
  };
}
