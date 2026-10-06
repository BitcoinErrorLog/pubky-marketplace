'use client';

import { useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  classifyMarketplacePickupRefusal,
  type MarketplacePickupRefusal,
  type MarketplacePickupReveal,
} from '@/libs/commerce/pickup';
import { AppError } from '@/libs/error/error';

export type PickupRevealState = 'idle' | 'loading' | 'ready' | 'refused';

export interface UsePickupRevealResult {
  state: PickupRevealState;
  /** The pinned snapshot, held in component memory ONLY (§A1: never persisted to Dexie or any store). */
  reveal: MarketplacePickupReveal | null;
  /** A plain-language refusal message — never a raw error (§7.2). */
  refusalMessage: string | null;
  /** Issues the reveal read. The entitlement is re-evaluated by the service on every call. */
  load: () => Promise<void>;
  /** Drops the in-memory copy (on dialog close). */
  reset: () => void;
}

/** The buyer-facing message per typed refusal (§A3/§A7) — a clear message, not a toast of the raw error. */
export function pickupRevealRefusalMessage(refusal: MarketplacePickupRefusal | null): string {
  switch (refusal) {
    case 'payment_unconfirmed':
      return 'The meeting point is revealed as soon as your payment confirms.';
    case 'order_terminal':
      return 'This order is closed, so the meeting point is no longer shown.';
    case 'sandbox_confirmed':
      return 'This order was paid with sandbox money, so no real meeting point is ever revealed.';
    case 'no_pinned_details':
      return 'This order carries no pinned pickup details.';
    case 'pickup_unavailable':
      return 'Local pickup is not available on this deployment.';
    case 'not_pickup_order':
      return 'This is not a pickup order.';
    case 'pickup_not_published':
    case 'terms_change_unresolved':
    case null:
      return 'The pickup details could not be shown.';
  }
}

/**
 * The buyer's meeting-point reveal (local pickup design §A3): a dedicated,
 * entitled read issued on each view — the response is `no-store` and the
 * pinned snapshot is held in component state only. Nothing is written to
 * Dexie, a Zustand store, or any other persistence: this hook is the whole
 * lifetime of the plaintext on the device (§A1, §7.2 buyer-side caching).
 */
export function usePickupReveal(orderId: string): UsePickupRevealResult {
  const [state, setState] = useState<PickupRevealState>('idle');
  const [reveal, setReveal] = useState<MarketplacePickupReveal | null>(null);
  const [refusalMessage, setRefusalMessage] = useState<string | null>(null);

  const load = async () => {
    setState('loading');
    setRefusalMessage(null);
    try {
      const result = await CommerceController.fetchPickupReveal(orderId);
      setReveal(result);
      setState('ready');
    } catch (revealError) {
      const refusal =
        revealError instanceof AppError
          ? ((revealError.context?.refusal as MarketplacePickupRefusal | null | undefined) ??
            classifyMarketplacePickupRefusal(revealError.message))
          : null;
      setReveal(null);
      setRefusalMessage(pickupRevealRefusalMessage(refusal));
      setState('refused');
    }
  };

  const reset = () => {
    setState('idle');
    setReveal(null);
    setRefusalMessage(null);
  };

  return { state, reveal, refusalMessage, load, reset };
}
