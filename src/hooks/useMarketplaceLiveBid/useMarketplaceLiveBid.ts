'use client';

import { useEffect, useRef, useState } from 'react';
import { getCommerceAdapterMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useViewportObserver } from '@/hooks/useViewportObserver/useViewportObserver';
import type { CommerceMoney } from '@/libs/commerce/transaction-contracts';

export interface MarketplaceLiveBid {
  currentPrice: CommerceMoney;
  bidCount: number;
}

export interface UseMarketplaceLiveBidResult {
  /** Attach to the card's DOM so the fetch only fires for on-screen cards. */
  ref: (node: HTMLElement | null) => void;
  /** Live auction state, or `null` while unknown (not fetched yet, service unreachable, or mode without a durable backend). */
  bid: MarketplaceLiveBid | null;
  /** Durable listing state, used to replace Buy now on a reserved unit. */
  listingState: 'available' | 'reserved' | 'sold' | null;
}

/**
 * Lazily fetches public live auction state (current bid and bid count)
 * for ONE catalog card from the durable transaction service's public listing
 * projection — the only authoritative source for bids, which the Nexus index
 * deliberately never carries.
 *
 * Cost model: the durable service exposes only per-listing reads
 * (`GET /v1/listings/{aggregate_id}`, no batch endpoint), so an eager fetch
 * per grid row would issue N requests on every catalog render. Instead the
 * card registers an IntersectionObserver via `ref` and fetches ONCE when it
 * first scrolls into view (200px pre-fetch margin), so off-screen cards cost
 * nothing. The value is a point-in-time read, not a live subscription — the
 * detail page's `useMarketplaceProjection` remains the polling surface.
 *
 * Scope: `transaction-service` mode only. The sandbox keeps terms-only cards;
 * its simulated bid state stays on the detail page where it is labeled as
 * such. Failures (no session yet, service unreachable) leave `bid` and
 * `listingState` null and the card falls back to the seller's terms
 * from the index — never a fabricated bid or sold-out claim.
 */
export function useMarketplaceLiveBid(
  sellerPubky: string,
  listingId: string,
  enabled: boolean,
): UseMarketplaceLiveBidResult {
  const isDurableMode = getCommerceAdapterMode() === 'transaction-service';
  const isActive = enabled && isDurableMode;
  const { ref, isVisible } = useViewportObserver({ enabled: isActive });
  const [bid, setBid] = useState<MarketplaceLiveBid | null>(null);
  const [listingState, setListingState] = useState<'available' | 'reserved' | 'sold' | null>(null);
  const hasFetchedRef = useRef(false);

  useEffect(() => {
    if (!isActive || !isVisible || hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    let mounted = true;
    void CommerceController.getMarketplaceListingProjection(sellerPubky, listingId)
      .then((projection) => {
        if (!mounted || !projection) return;
        setListingState(projection.state);
        if (!projection.auction) return;
        setBid({
          currentPrice: projection.auction.currentPrice,
          bidCount: projection.auction.bidCount,
        });
      })
      .catch(() => {
        // Degrade to terms-only: the card must never invent bid state, and a
        // missing session or unreachable service is not an error at card level.
      });
    return () => {
      mounted = false;
    };
  }, [isActive, isVisible, listingId, sellerPubky]);

  return { ref, bid, listingState };
}
