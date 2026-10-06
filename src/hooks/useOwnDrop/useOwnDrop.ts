'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { dropClockOffsetMs } from '@/libs/commerce/drop-clock';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import type { CommerceDropRecord } from '@/libs/commerce/marketplace-records';
import { isMarketplaceRevisionConflict } from '@/libs/commerce/transaction-commands';
import type { DropState } from '@/libs/commerce/transaction-contracts';
import type { MarketplaceSellerDrop } from '@/services/marketplace/marketplace-projections';
import { useAuthStore } from '@/stores/auth/auth.store';

/** Mission-control poll cadence while the page is visible. */
export const OWN_DROP_POLL_MS = 15_000;

export const DROP_ENDED_STATES: readonly DropState[] = ['ended_sold_out', 'ended_closed', 'ended_cancelled'];
export const DROP_CANCELLABLE_STATES: readonly DropState[] = ['announced', 'live'];

export interface DropCommandOutcome {
  ok: boolean;
  /** True when the CAS guard tripped: fresh state was already refetched — review and retry. */
  conflict: boolean;
  message: string | null;
}

export interface UseOwnDropResult {
  /** Authoritative seller detail, or null when the drop is not registered with the service. */
  drop: MarketplaceSellerDrop | null;
  /** The seller-signed homeserver record (title, media, schedule intent), or null when unreadable. */
  record: CommerceDropRecord | null;
  isLoading: boolean;
  isDurable: boolean;
  /** Device-vs-service clock offset measured at the latest projection fetch. */
  offsetMs: number;
  refresh: () => Promise<void>;
  /** Kill switch (announced/live only): `drop.cancel`, CAS-guarded. */
  cancel: () => Promise<DropCommandOutcome>;
  /** Ended states only: `drop.release_listings`, CAS-guarded. */
  releaseListings: () => Promise<DropCommandOutcome>;
  /** Convergent `drop.sync` for a published-but-unregistered drop, then re-read. */
  syncRegistration: () => Promise<void>;
  isActing: boolean;
}

/**
 * Mission-control data for one of the current seller's drops. Polls the
 * seller projection every {@link OWN_DROP_POLL_MS} while the document is
 * visible — the interval is cleared on hide and on unmount, and one fresh
 * read fires on return to visibility (watch-check discipline: no background
 * daemons). Both lifecycle commands send the freshly read revision and treat
 * `REVISION_CONFLICT` as refetch-then-ask-again, never a blind resubmit.
 */
export function useOwnDrop(dropId: string): UseOwnDropResult {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isDurable = isDurableCommerceMode(getCommerceAdapterMode());
  const [drop, setDrop] = useState<MarketplaceSellerDrop | null>(null);
  const [record, setRecord] = useState<CommerceDropRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [offsetMs, setOffsetMs] = useState(0);
  const [isActing, setIsActing] = useState(false);
  const dropRef = useRef<MarketplaceSellerDrop | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!currentUserPubky || !isDurable) {
      setIsLoading(false);
      return;
    }
    const [nextDrop, nextRecord] = await Promise.all([
      CommerceController.getOwnDrop(dropId).catch(() => null),
      CommerceController.fetchDrop(currentUserPubky, dropId).catch(() => null),
    ]);
    if (nextDrop) {
      setOffsetMs(dropClockOffsetMs(nextDrop.serverTime, Date.now()));
    }
    dropRef.current = nextDrop;
    setDrop(nextDrop);
    setRecord(nextRecord);
    setIsLoading(false);
  }, [currentUserPubky, dropId, isDurable]);

  useEffect(() => {
    if (!currentUserPubky || !isDurable) {
      setIsLoading(false);
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (timer !== null) return;
      timer = setInterval(() => void load(), OWN_DROP_POLL_MS);
    };
    const stopPolling = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void load();
        startPolling();
      } else {
        stopPolling();
      }
    };

    void load();
    if (document.visibilityState === 'visible') startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [currentUserPubky, isDurable, load]);

  const runLifecycleCommand = async (
    kind: 'cancel' | 'release',
    allowedStates: readonly DropState[],
    refusal: string,
  ): Promise<DropCommandOutcome> => {
    const current = dropRef.current;
    if (!current || !allowedStates.includes(current.state)) {
      return { ok: false, conflict: false, message: refusal };
    }
    setIsActing(true);
    try {
      const response =
        kind === 'cancel'
          ? await CommerceController.cancelDrop(dropId, current.revision)
          : await CommerceController.releaseDropListings(dropId, current.revision);
      if (response.ok) {
        await load();
        return { ok: true, conflict: false, message: null };
      }
      if (isMarketplaceRevisionConflict(response)) {
        await load();
        return {
          ok: false,
          conflict: true,
          message: 'The drop changed since you loaded it. Fresh state is shown — review it and confirm again.',
        };
      }
      return {
        ok: false,
        conflict: false,
        message: marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.dropRefusal),
      };
    } catch (commandError) {
      return {
        ok: false,
        conflict: false,
        message: marketplaceFailureMessage(
          marketplaceErrorCode(commandError),
          MARKETPLACE_FAILURE_MESSAGES.drop,
          commandError,
        ),
      };
    } finally {
      setIsActing(false);
    }
  };

  const cancel = () =>
    runLifecycleCommand('cancel', DROP_CANCELLABLE_STATES, 'Only an announced or live drop can be cancelled.');

  const releaseListings = () =>
    runLifecycleCommand('release', DROP_ENDED_STATES, 'Listings release only after the drop ends.');

  const syncRegistration = async (): Promise<void> => {
    if (!currentUserPubky || !isDurable) return;
    setIsActing(true);
    try {
      await CommerceController.syncDropRegistration(currentUserPubky, dropId);
    } catch {
      // The re-read below renders whatever is honestly true after the attempt.
    } finally {
      await load();
      setIsActing(false);
    }
  };

  return {
    drop,
    record,
    isLoading,
    isDurable,
    offsetMs,
    refresh: load,
    cancel,
    releaseListings,
    syncRegistration,
    isActing,
  };
}
