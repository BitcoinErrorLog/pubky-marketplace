'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CommerceIndexedReviewsResult, CommerceSellerReputationOverview } from '@/application/commerce/commerce';
import { MARKETPLACE_REVIEWS_PAGE_SIZE } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { CommerceIndexedReview } from '@/models/commerce/commerce.schema';

/**
 * The seller's public reputation overview for rating headers.
 *
 * Three-way honest state machine (never a fabricated number):
 * - `rated` — the index holds reviews; the summary renders.
 * - `new_seller` — a reputation-aware index confirmed zero reviews; the
 *   explicit "New seller" state renders.
 * - `unavailable` — no reputation-aware index answered (old deployment,
 *   sandbox, or unreachable); NO reputation surface renders at all.
 * `loading` is the initial in-flight state.
 */
export function useSellerReputation(sellerPubky: string, options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;
  const [overview, setOverview] = useState<CommerceSellerReputationOverview | { status: 'loading' }>({
    status: 'loading',
  });

  useEffect(() => {
    if (!enabled) {
      setOverview({ status: 'unavailable' });
      return;
    }

    let active = true;
    setOverview({ status: 'loading' });
    CommerceController.fetchSellerReputation(sellerPubky)
      .then((result) => {
        if (active) setOverview(result);
      })
      .catch(() => {
        if (active) setOverview({ status: 'unavailable' });
      });
    return () => {
      active = false;
    };
  }, [sellerPubky, enabled]);

  return overview;
}

export interface MarketplaceReviewsTarget {
  sellerPubky: string;
  /** When set, the list is the listing's buyer reviews; otherwise the seller's. */
  listingId?: string;
}

export interface MarketplaceReviewsState {
  status: 'loading' | 'ok' | 'unavailable';
  reviews: CommerceIndexedReview[];
  /** True while any page fetch is in flight. */
  isFetching: boolean;
  /** True when the last page came back full, so another page may exist. */
  hasMore: boolean;
  loadMore: () => void;
}

/**
 * Paged review list for a seller or one listing, newest-indexed first.
 * `unavailable` means no review index serves this deployment — the caller
 * renders no review section rather than an empty one.
 */
export function useMarketplaceReviews(target: MarketplaceReviewsTarget): MarketplaceReviewsState {
  const { sellerPubky, listingId } = target;
  const [reviews, setReviews] = useState<CommerceIndexedReview[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [isFetching, setIsFetching] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const fetchPage = useCallback(
    async (skip: number): Promise<CommerceIndexedReviewsResult> => {
      const page = { skip, limit: MARKETPLACE_REVIEWS_PAGE_SIZE };
      return listingId === undefined
        ? await CommerceController.fetchSellerReviews(sellerPubky, page)
        : await CommerceController.fetchListingReviews(sellerPubky, listingId, page);
    },
    [sellerPubky, listingId],
  );

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setReviews([]);
    setIsFetching(true);
    fetchPage(0)
      .then((result) => {
        if (!active) return;
        if (result.status === 'unavailable') {
          setStatus('unavailable');
          return;
        }
        setReviews(result.reviews);
        setHasMore(result.reviews.length === MARKETPLACE_REVIEWS_PAGE_SIZE);
        setStatus('ok');
      })
      .finally(() => {
        if (active) setIsFetching(false);
      });
    return () => {
      active = false;
    };
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (isFetching || status !== 'ok') return;
    setIsFetching(true);
    fetchPage(reviews.length)
      .then((result) => {
        if (result.status !== 'ok') return;
        setReviews((current) => {
          const known = new Set(current.map(({ reviewerId, reviewId }) => `${reviewerId}:${reviewId}`));
          const fresh = result.reviews.filter(({ reviewerId, reviewId }) => !known.has(`${reviewerId}:${reviewId}`));
          return [...current, ...fresh];
        });
        setHasMore(result.reviews.length === MARKETPLACE_REVIEWS_PAGE_SIZE);
      })
      .finally(() => setIsFetching(false));
  }, [fetchPage, isFetching, status, reviews.length]);

  return { status, reviews, isFetching, hasMore, loadMore };
}
