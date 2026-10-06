'use client';

import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import {
  getCommerceAdapterMode,
  getCommercePollIntervalMs,
  isDurableCommerceMode,
  isTransactionalCommerceMode,
} from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import { buildMarketplaceListingAggregateId, isListingDeletedResponse } from '@/libs/commerce/transaction-commands';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import type { MarketplaceListingProjection } from '@/services/marketplace/marketplace';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

/**
 * Polls the listing/inventory projection from whichever transactional backend
 * the mode selects (sandbox or durable transaction service). The projection's
 * `serverRevision` is what bid/offer/checkout commands send as
 * `expected_revision`, so interactive flows are only enabled while this read
 * works. Failures surface as `error` — including the durable service's
 * session requirement, which carries its own guidance.
 */
export function useMarketplaceProjection(sellerPubky: string, listingId: string) {
  const isTransactional = isTransactionalCommerceMode(getCommerceAdapterMode());
  // Refetch trigger: connecting a session replaces this store object, so the
  // effect below re-runs immediately instead of waiting for the next poll.
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const [projection, setProjection] = useState<MarketplaceListingProjection | null>(null);
  const [isLoading, setIsLoading] = useState(isTransactional);
  const [error, setError] = useState<string | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  const [listingRemoved, setListingRemoved] = useState(false);
  const generationRef = useRef(0);

  const refresh = () => {
    const generation = generationRef.current;
    void loadProjection(
      sellerPubky,
      listingId,
      setProjection,
      setIsLoading,
      setError,
      setNeedsSession,
      setListingRemoved,
      () => generationRef.current === generation,
    );
  };

  useEffect(() => {
    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    setProjection(null);
    setIsLoading(true);
    setError(null);
    setNeedsSession(false);
    setListingRemoved(false);
    if (!isTransactional) {
      setIsLoading(false);
      return;
    }
    let active = true;
    const refetch = () => {
      if (active)
        void loadProjection(
          sellerPubky,
          listingId,
          setProjection,
          setIsLoading,
          setError,
          setNeedsSession,
          setListingRemoved,
          isCurrent,
        );
    };
    void loadProjection(
      sellerPubky,
      listingId,
      setProjection,
      setIsLoading,
      setError,
      setNeedsSession,
      setListingRemoved,
      isCurrent,
    );
    const timer = window.setInterval(() => {
      if (active)
        void loadProjection(
          sellerPubky,
          listingId,
          setProjection,
          setIsLoading,
          setError,
          setNeedsSession,
          setListingRemoved,
          isCurrent,
        );
    }, getCommercePollIntervalMs());
    window.addEventListener('focus', refetch);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refetch);
    };
  }, [isTransactional, listingId, sellerPubky, marketplaceSession]);

  return { projection, isLoading, error, needsSession, listingRemoved, refresh };
}

async function loadProjection(
  sellerPubky: string,
  listingId: string,
  setProjection: Dispatch<SetStateAction<MarketplaceListingProjection | null>>,
  setIsLoading: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | null>>,
  setNeedsSession: Dispatch<SetStateAction<boolean>>,
  setListingRemoved: Dispatch<SetStateAction<boolean>>,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isTransactionalCommerceMode(getCommerceAdapterMode())) return;
  try {
    let next = await CommerceController.getMarketplaceListingProjection(sellerPubky, listingId);
    let removed = false;
    // An unregistered listing is healable by ANY signed-in user: the service
    // fetches the canonical seller-signed record from the homeserver itself
    // (`listing.sync`). Exactly one attempt per poll cycle, then one re-read.
    // A signed-out visitor never reaches this point in durable mode — the
    // projection read itself throws the session requirement first, so the
    // needsSession affordance takes precedence over any sync attempt.
    if (!next && isDurableCommerceMode(getCommerceAdapterMode())) {
      ({ projection: next, removed } = await syncThenReread(sellerPubky, listingId));
    }
    if (!isCurrent()) return;
    setProjection(next);
    if (next) {
      await cacheProjection(next);
      if (!isCurrent()) return;
    }
    setError(
      next
        ? null
        : removed
          ? MARKETPLACE_FAILURE_MESSAGES.listingRemoved
          : MARKETPLACE_FAILURE_MESSAGES.claimListingUnavailable,
    );
    setNeedsSession(false);
    setListingRemoved(removed && !next);
  } catch (loadError) {
    if (!isCurrent()) return;
    // A missing/expired marketplace session is not a dead end: flag it so the
    // listing surface renders the session-connect affordance.
    setNeedsSession(isMarketplaceSessionRequiredError(loadError));
    setError(
      loadError instanceof Error && loadError.name === 'AppError'
        ? loadError.message
        : 'Transaction service is unavailable.',
    );
  } finally {
    if (isCurrent()) setIsLoading(false);
  }
}

async function cacheProjection(projection: MarketplaceListingProjection): Promise<void> {
  const aggregate = projection.aggregateId.slice('listing:'.length);
  if (aggregate.length < 54 || aggregate[52] !== '_') return;
  const sellerPubky = aggregate.slice(0, 52);
  const listingId = aggregate.slice(53);
  if (!sellerPubky || !listingId) return;
  await CommerceController.cacheMarketplaceListingProjection({
    id: `${sellerPubky}:${listingId}`,
    seller_id: sellerPubky,
    listing_id: listingId,
    listing_revision: projection.listingRevision,
    content_hash: projection.contentHash,
    server_revision: projection.serverRevision,
    state: projection.state,
    available_quantity: projection.availableQuantity,
    current_price: projection.auction?.currentPrice ?? projection.unitPrice,
    auction_state:
      projection.auction?.status === 'scheduled' ||
      projection.auction?.status === 'active' ||
      projection.auction?.status === 'sold' ||
      projection.auction?.status === 'unsold' ||
      projection.auction?.status === 'cancelled'
        ? projection.auction.status
        : null,
    bid_count: projection.auction?.bidCount ?? 0,
    sync_status: 'synced',
    synced_at: Date.now(),
  });
}

/**
 * One `listing.sync` attempt followed by one projection re-read. Sync
 * failures are deliberately swallowed here: the caller's honest "could not
 * be prepared" copy is the fallback, and the next poll cycle retries. A sync
 * that reports the seller deleted the listing is not a failure: `removed`
 * lets the caller say so.
 */
async function syncThenReread(
  sellerPubky: string,
  listingId: string,
): Promise<{ projection: MarketplaceListingProjection | null; removed: boolean }> {
  try {
    const response = await CommerceController.syncListingRegistration(sellerPubky, listingId);
    if (!response.ok) return { projection: null, removed: false };
    if (isListingDeletedResponse(response, buildMarketplaceListingAggregateId(sellerPubky, listingId))) {
      return { projection: null, removed: true };
    }
    return {
      projection: await CommerceController.getMarketplaceListingProjection(sellerPubky, listingId),
      removed: false,
    };
  } catch {
    return { projection: null, removed: false };
  }
}
