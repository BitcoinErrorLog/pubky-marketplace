'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { dropClockOffsetMs } from '@/libs/commerce/drop-clock';
import type { CommerceDropRecord } from '@/libs/commerce/marketplace-records';
import { isAppError, isNotFound } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import type { MarketplaceDropReadyCheck, MarketplacePublicDrop } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { deriveDropDisplayState, type MarketplaceDropDisplayState } from './drop-display';

/** ± window around server-time `startsAt` where the T-0 cadence applies. */
export const DROP_T0_POLL_WINDOW_MS = 10_000;
/** Poll cadence inside the ±T-0 window — the reload-free live transition. */
export const DROP_T0_POLL_INTERVAL_MS = 2_000;
/** Poll cadence inside the open window (live drops), outside the T-0 spike. */
export const DROP_OPEN_POLL_INTERVAL_MS = 30_000;

/**
 * The bounded T-0 polling discipline (drops design, "T-0 transition"): the
 * next projection poll is due in 2s while the CORRECTED clock is within
 * ±10s of `startsAt`, in 30s inside the open window, and never otherwise —
 * ended states are terminal and far-future drops poll nothing. The clock
 * only schedules polls; the projection's `state` makes every claim.
 */
export function dropProjectionPollDelayMs(
  projection: MarketplacePublicDrop,
  offsetMs: number,
  deviceNowMs: number,
): number | null {
  if (projection.state !== 'announced' && projection.state !== 'live') return null;
  const correctedNowMs = deviceNowMs + offsetMs;
  const startMs = Date.parse(projection.startsAt);
  if (Math.abs(correctedNowMs - startMs) <= DROP_T0_POLL_WINDOW_MS) return DROP_T0_POLL_INTERVAL_MS;
  const endMs = projection.endsAt ? Date.parse(projection.endsAt) : null;
  const windowOpen = correctedNowMs >= startMs && (endMs === null || correctedNowMs < endMs);
  if (windowOpen) return DROP_OPEN_POLL_INTERVAL_MS;
  return null;
}

export interface UseMarketplaceDropResult {
  /** Canonical seller-signed record from the homeserver; null while loading or on failure. */
  record: CommerceDropRecord | null;
  recordError: string | null;
  /** Authoritative service projection; null = unregistered or sandbox/unavailable mode. */
  projection: MarketplacePublicDrop | null;
  /** Device-vs-service clock offset measured from `projection.serverTime` at fetch time. */
  clockOffsetMs: number | null;
  /** The signed-in buyer's per-drop allowance; null while unavailable. */
  readyCheck: MarketplaceDropReadyCheck | null;
  displayState: MarketplaceDropDisplayState;
  isLoading: boolean;
  adapterMode: ReturnType<typeof getCommerceAdapterMode>;
  refresh: () => Promise<void>;
}

/**
 * One drop, honestly: the seller-signed homeserver record (the announcement),
 * the transaction service's public projection (the ONLY source of
 * `live`/stock/ended), the buyer's ready-check allowance when signed in, and
 * the server-corrected clock reading the countdown renders from.
 *
 * Polling is bounded by design (no daemons — the same discipline as the
 * watchlist's visit/focus checks): timers exist only while the page is
 * mounted AND visible, tighten to 2s inside ±10s of server-time `startsAt`,
 * relax to 30s inside the open window, and stop entirely otherwise.
 *
 * Self-heal mirrors listings: when the record exists but the projection
 * 404s in a durable mode, one `drop.sync` runs (any signed-in actor may
 * register the seller-signed record), then one re-read.
 */
export function useMarketplaceDrop(sellerPubky: string, dropId: string): UseMarketplaceDropResult {
  const adapterMode = getCommerceAdapterMode();
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  // Refetch trigger: connecting a session replaces this store object, so the
  // ready check loads immediately instead of waiting for a manual refresh.
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const [record, setRecord] = useState<CommerceDropRecord | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [projection, setProjection] = useState<MarketplacePublicDrop | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState<number | null>(null);
  const [readyCheck, setReadyCheck] = useState<MarketplaceDropReadyCheck | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const syncAttemptedRef = useRef(false);

  const loadRecord = useCallback(async (): Promise<void> => {
    try {
      const next = await CommerceController.fetchDrop(sellerPubky, dropId);
      setRecord(next);
      setRecordError(null);
    } catch (error) {
      setRecord(null);
      setRecordError(
        isAppError(error) && isNotFound(error)
          ? "This drop does not exist on the seller's homeserver. It may have been removed."
          : 'This drop could not be loaded from the seller’s homeserver.',
      );
    }
  }, [sellerPubky, dropId]);

  const loadProjection = useCallback(async (): Promise<MarketplacePublicDrop | null> => {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return null;
    const fetchedAtDeviceMs = Date.now();
    let next = await CommerceController.getPublicDrop(sellerPubky, dropId);
    // Self-heal, once per mount: an unregistered drop whose record exists is
    // registrable by any signed-in actor via the convergent `drop.sync`
    // (exactly like `listing.sync`). One attempt, then one re-read; a
    // failure leaves the honest "not registered" state.
    if (next === null && !syncAttemptedRef.current && useAuthStore.getState().currentUserPubky) {
      syncAttemptedRef.current = true;
      try {
        const response = await CommerceController.syncDropRegistration(sellerPubky, dropId);
        if (response.ok) next = await CommerceController.getPublicDrop(sellerPubky, dropId);
      } catch (error) {
        Logger.warn('Drop registration self-heal failed; the drop stays unregistered here', { error });
      }
    }
    setProjection(next);
    setClockOffsetMs(next ? dropClockOffsetMs(next.serverTime, fetchedAtDeviceMs) : null);
    return next;
  }, [sellerPubky, dropId]);

  const loadReadyCheck = useCallback(async (): Promise<void> => {
    const signedIn = Boolean(useAuthStore.getState().currentUserPubky);
    const hasSession = useCommerceStore.getState().marketplaceSession !== null;
    if (!signedIn || !hasSession || !isDurableCommerceMode(getCommerceAdapterMode())) {
      setReadyCheck(null);
      return;
    }
    try {
      setReadyCheck(await CommerceController.getDropReadyCheck(sellerPubky, dropId));
    } catch (error) {
      // An unreadable allowance renders as honest absence in the ready-check
      // panel (its session item already carries the remedy) — never a guess.
      Logger.warn('Drop ready-check read failed', { error });
      setReadyCheck(null);
    }
  }, [sellerPubky, dropId]);

  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([loadRecord(), loadProjection().catch(() => null), loadReadyCheck()]);
  }, [loadRecord, loadProjection, loadReadyCheck]);

  // Initial load: record + projection + ready check, then bounded polling of
  // the projection alone. Timers are cleared on unmount and while hidden.
  useEffect(() => {
    let active = true;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (next: MarketplacePublicDrop | null, offsetMs: number | null) => {
      clearTimer();
      if (!active || !next || offsetMs === null) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const delay = dropProjectionPollDelayMs(next, offsetMs, Date.now());
      if (delay === null) return;
      timer = window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (!active) return;
      const fetchedAtDeviceMs = Date.now();
      try {
        const next = await loadProjection();
        if (!active) return;
        schedule(next, next ? dropClockOffsetMs(next.serverTime, fetchedAtDeviceMs) : null);
      } catch (error) {
        Logger.warn('Drop projection poll failed; retrying on the next scheduled tick', { error });
        if (!active) return;
        // Transient read failure mid-window: keep the last projection and
        // retry at the open-window cadence rather than going silent.
        timer = window.setTimeout(() => void poll(), DROP_OPEN_POLL_INTERVAL_MS);
      }
    };

    const initialLoad = async () => {
      setIsLoading(true);
      const fetchedAtDeviceMs = Date.now();
      const [, next] = await Promise.all([loadRecord(), loadProjection().catch(() => null), loadReadyCheck()]);
      if (!active) return;
      setIsLoading(false);
      schedule(next, next ? dropClockOffsetMs(next.serverTime, fetchedAtDeviceMs) : null);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearTimer();
        return;
      }
      // Regaining visibility re-reads immediately (the page may have crossed
      // T-0 while hidden) and re-enters the bounded schedule from the result.
      void poll();
    };

    void initialLoad();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadRecord, loadProjection, loadReadyCheck, marketplaceSession]);

  // The ready check depends on who is signed in; account switches reload it.
  useEffect(() => {
    void loadReadyCheck();
  }, [loadReadyCheck, currentUserPubky, marketplaceSession]);

  return {
    record,
    recordError,
    projection,
    clockOffsetMs,
    readyCheck,
    displayState: deriveDropDisplayState({ adapterMode, projection }),
    isLoading,
    adapterMode,
    refresh,
  };
}
