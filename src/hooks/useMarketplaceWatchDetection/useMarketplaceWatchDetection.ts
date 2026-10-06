'use client';

import { useEffect } from 'react';
import { COMMERCE_WATCH_CHECK_MIN_INTERVAL_MS, getCommerceAdapterMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { Logger } from '@/libs/logger/logger';
import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * Passes already run this session, per account, so mounting the trigger on
 * several marketplace surfaces (or rapid tab switching) cannot fan out
 * repeated per-item reads. Module-level on purpose: the spacing must hold
 * across mounts, and it resets with the tab — a fresh visit checks again.
 */
const lastDetectionRunAt = new Map<string, number>();

/**
 * Triggers a bounded watchlist detection pass when a marketplace surface is
 * visited and again whenever the tab regains visibility — the local-first
 * substitute for a notification daemon this app deliberately does not have.
 * Passes for the same account are spaced at least
 * {@link COMMERCE_WATCH_CHECK_MIN_INTERVAL_MS} apart. Detection failures are
 * logged, never surfaced: an alert that could not be verified simply does
 * not appear.
 */
export function useMarketplaceWatchDetection() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const enabled = Boolean(currentUserPubky) && getCommerceAdapterMode() !== 'unavailable';

  useEffect(() => {
    if (!enabled || !currentUserPubky) return;

    const runPass = () => {
      const lastRunAt = lastDetectionRunAt.get(currentUserPubky) ?? 0;
      const now = Date.now();
      if (now - lastRunAt < COMMERCE_WATCH_CHECK_MIN_INTERVAL_MS) return;
      lastDetectionRunAt.set(currentUserPubky, now);
      void CommerceController.runWatchlistDetection().catch((error) => {
        Logger.warn('Watchlist detection pass failed', { error });
      });
    };

    runPass();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') runPass();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', runPass);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', runPass);
    };
  }, [enabled, currentUserPubky]);
}
