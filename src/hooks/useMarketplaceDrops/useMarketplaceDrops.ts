'use client';

import { useCallback, useEffect, useState } from 'react';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { Logger } from '@/libs/logger/logger';
import { type DropStreamBucket, estimateDropBucket, fetchDropsStream, type NexusDropStreamEntry } from './drops-stream';

export const DROPS_STREAM_PAGE_LIMIT = 30;

export interface UseMarketplaceDropsResult {
  /** Stream entries grouped into ESTIMATE buckets from indexed times. */
  buckets: Record<DropStreamBucket, NexusDropStreamEntry[]>;
  /** False when the deployment's Nexus answered 404 for the drops stream. */
  isIndexed: boolean;
  isLoading: boolean;
  error: string | null;
  adapterMode: ReturnType<typeof getCommerceAdapterMode>;
  refresh: () => Promise<void>;
}

const EMPTY_BUCKETS: Record<DropStreamBucket, NexusDropStreamEntry[]> = { upcoming: [], live: [], ended: [] };

/**
 * The drops calendar's discovery read: one bounded fetch of the Nexus drops
 * stream per visit (no polling — discovery is not authority, and the drop
 * page hydrates the real projection on open). A 404 from a deployment
 * without drop indexing is a first-class outcome (`isIndexed: false`), not
 * an error: the surface renders the honest "not indexed here" empty state.
 */
export function useMarketplaceDrops(): UseMarketplaceDropsResult {
  const adapterMode = getCommerceAdapterMode();
  const isDurable = isDurableCommerceMode(adapterMode);
  const [buckets, setBuckets] = useState(EMPTY_BUCKETS);
  const [isIndexed, setIsIndexed] = useState(true);
  const [isLoading, setIsLoading] = useState(isDurable);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return;
    try {
      const entries = await fetchDropsStream({ limit: DROPS_STREAM_PAGE_LIMIT });
      if (entries === null) {
        setIsIndexed(false);
        setBuckets(EMPTY_BUCKETS);
        setError(null);
        return;
      }
      const now = Date.now();
      const next: Record<DropStreamBucket, NexusDropStreamEntry[]> = { upcoming: [], live: [], ended: [] };
      for (const entry of entries) {
        next[estimateDropBucket(entry, now)].push(entry);
      }
      // Upcoming soonest-first; live and ended newest-start-first.
      next.upcoming.sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at));
      next.live.sort((left, right) => Date.parse(right.starts_at) - Date.parse(left.starts_at));
      next.ended.sort((left, right) => Date.parse(right.starts_at) - Date.parse(left.starts_at));
      setBuckets(next);
      setIsIndexed(true);
      setError(null);
    } catch (loadError) {
      Logger.warn('Drops stream read failed', { error: loadError });
      setError('The drop index could not be reached. Drops opened by link still work.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isDurable) {
      setIsLoading(false);
      return;
    }
    void refresh();
  }, [isDurable, refresh]);

  return { buckets, isIndexed, isLoading, error, adapterMode, refresh };
}
