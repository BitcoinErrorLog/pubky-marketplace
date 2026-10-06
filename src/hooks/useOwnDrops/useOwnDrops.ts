'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { readOwnDropIndex } from '@/hooks/useDropStudio/drop-index';
import type { CommerceDropRecord } from '@/libs/commerce/marketplace-records';
import { hasHttpStatus, isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import type { MarketplaceSellerDrop } from '@/services/marketplace/marketplace-projections';
import { useAuthStore } from '@/stores/auth/auth.store';

type OwnDropProjection =
  | { status: 'loaded'; drop: MarketplaceSellerDrop }
  | { status: 'unregistered' }
  | {
      status: 'session-unavailable' | 'unavailable';
    };

export interface OwnDropRow {
  dropId: string;
  /** The seller-signed homeserver record, or null when it could not be read. */
  record: CommerceDropRecord | null;
  /** The transaction-service read, preserving absence separately from failures. */
  projection: OwnDropProjection;
}

export interface UseOwnDropsResult {
  rows: OwnDropRow[];
  isLoading: boolean;
  isDurable: boolean;
  refresh: () => Promise<void>;
}

export type OwnDropReadFailure = Exclude<OwnDropProjection['status'], 'loaded'>;

export function classifyOwnDropReadError(error: unknown): OwnDropReadFailure {
  if (isMarketplaceSessionRequiredError(error) || hasHttpStatus(error, 401)) return 'session-unavailable';
  if (hasHttpStatus(error, 404)) return 'unregistered';
  return 'unavailable';
}

async function loadOwnDropRows(currentUserPubky: string, isDurable: boolean): Promise<OwnDropRow[]> {
  // Same restore as Seller Studio publish: a still-valid persisted bearer
  // must be in memory before the protected drop-status read, or the
  // transport throws SESSION_EXPIRED and the row never reaches the service.
  CommerceController.restorePersistedMarketplaceSession(currentUserPubky);
  const listed = await CommerceController.listOwnDropIds().catch(() => [] as string[]);
  const remembered = readOwnDropIndex(currentUserPubky);
  const dropIds = [...new Set([...listed, ...remembered])];
  const loaded = await Promise.all(
    dropIds.map(async (dropId): Promise<OwnDropRow> => {
      const record = await CommerceController.fetchDrop(currentUserPubky, dropId).catch(() => null);
      if (!isDurable) return { dropId, record, projection: { status: 'unavailable' } };
      try {
        const drop = await CommerceController.getOwnDrop(dropId);
        return drop
          ? { dropId, record, projection: { status: 'loaded', drop } }
          : { dropId, record, projection: { status: 'unregistered' } };
      } catch (error) {
        return { dropId, record, projection: { status: classifyOwnDropReadError(error) } };
      }
    }),
  );
  loaded.sort((a, b) => Date.parse(b.record?.startsAt ?? '') - Date.parse(a.record?.startsAt ?? ''));
  return loaded;
}

/**
 * The seller's drops for the drops home, enumerated from the homeserver's
 * drops directory (`CommerceController.listOwnDropIds` — authoritative,
 * works across devices), merged with the device-local publish index as a
 * freshness supplement for ids published moments ago. Each id is then
 * re-read from BOTH authorities: the homeserver record (title, schedule
 * intent) and the service's seller projection (state, revision). Rows sort
 * newest launch first. Every read failure renders as honest absence on its
 * own row — a missing projection never hides the record and vice versa;
 * an unreachable directory listing degrades to the local index alone.
 */
export function useOwnDrops(): UseOwnDropsResult {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isDurable = isDurableCommerceMode(getCommerceAdapterMode());
  const [rows, setRows] = useState<OwnDropRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const requestIdRef = useRef(0);

  const runLoad = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!currentUserPubky) {
        setRows([]);
        setIsLoading(false);
        return;
      }
      const requestId = ++requestIdRef.current;
      if (mode === 'initial') setIsLoading(true);
      const loaded = await loadOwnDropRows(currentUserPubky, isDurable);
      if (requestId !== requestIdRef.current) return;
      setRows(loaded);
      setIsLoading(false);
    },
    [currentUserPubky, isDurable],
  );

  useEffect(() => {
    void runLoad('initial');
    return () => {
      requestIdRef.current += 1;
    };
  }, [runLoad]);

  return {
    rows,
    isLoading,
    isDurable,
    refresh: () => runLoad('refresh'),
  };
}
