'use client';

import { useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import { Logger } from '@/libs/logger/logger';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { parseDropAggregateId } from '../useMarketplaceDrop/drop-display';

export interface UseMarketplaceDropEditionResult {
  /** The gapless edition number from the order projection; null for non-drop orders. */
  edition: number | null;
  /**
   * The drop's total quantity ("of") from the authoritative public drop
   * projection; null while unavailable. The portable receipt record on the
   * user's homeserver carries the same pair inside its verified
   * `pubky-drop-edition+v1` attestation — no controller read exposes that
   * private record back to the UI, so this surface renders the projection
   * value the attestation was issued from.
   */
  of: number | null;
}

/**
 * "Edition N (of M)" facts for one order row. The edition itself comes ONLY
 * from the order projection (assigned inside the exactly-once payment
 * confirmation, ADR 0026); the drop size is read once from the public drop
 * projection. Nothing here verifies anything — verification happened in the
 * receipt publisher before the portable receipt was written.
 */
export function useMarketplaceDropEdition(order: MarketplaceOrder): UseMarketplaceDropEditionResult {
  const edition = typeof order.edition === 'number' ? order.edition : null;
  const dropAggregateId = typeof order.dropAggregateId === 'string' ? order.dropAggregateId : null;
  const [of, setOf] = useState<number | null>(null);

  useEffect(() => {
    if (edition === null || dropAggregateId === null) return;
    const parsed = parseDropAggregateId(dropAggregateId);
    if (!parsed) return;
    let active = true;
    void CommerceController.getPublicDrop(parsed.sellerPubky, parsed.dropId)
      .then((drop) => {
        if (active && drop) setOf(drop.totalQuantity);
      })
      .catch((error) => {
        // The badge renders "Edition N" alone — absence, never a guess.
        Logger.warn('Drop size read for the edition badge failed', { error });
      });
    return () => {
      active = false;
    };
  }, [edition, dropAggregateId]);

  return { edition, of };
}
