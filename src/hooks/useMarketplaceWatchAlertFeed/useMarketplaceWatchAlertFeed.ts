'use client';

import { useCallback, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CommerceController } from '@/controllers/commerce/commerce';
import { Logger } from '@/libs/logger/logger';
import { MarketplaceWatchAlertNormalizer } from '@/pipes/marketplaceWatch/marketplaceWatchAlert.normalizer';
import type { MarketplaceWatchAlertFeedItem } from '@/pipes/marketplaceWatch/marketplaceWatchAlert.types';
import { useAuthStore } from '@/stores/auth/auth.store';

const EMPTY_ITEMS: MarketplaceWatchAlertFeedItem[] = [];

/**
 * Device-local watchlist alerts shaped for the notification surfaces, read
 * live from Dexie (detection passes write there, so new alerts appear
 * without any refetch wiring). `markAllSeen` clears the honest local read
 * state; rows that were unseen when this mount first saw them keep their
 * highlight until the surface is next opened — the same freeze the social
 * list and the marketplace feed apply — so marking-seen on page entry does
 * not instantly strip the highlights the user is looking at.
 */
export function useMarketplaceWatchAlertFeed() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const seenUnseenIdsRef = useRef<ReadonlySet<string>>(new Set());

  const items =
    useLiveQuery(async () => {
      if (!currentUserPubky) return EMPTY_ITEMS;
      const alerts = await CommerceController.getWatchAlerts();
      const frozen = new Set(seenUnseenIdsRef.current);
      const mapped = alerts.map((alert) => MarketplaceWatchAlertNormalizer.toFeedItem(alert));
      for (const item of mapped) {
        if (item.isUnseen) frozen.add(item.id);
      }
      seenUnseenIdsRef.current = frozen;
      return mapped.map((item) => (frozen.has(item.id) ? { ...item, isUnseen: true } : item));
    }, [currentUserPubky]) ?? EMPTY_ITEMS;

  const markAllSeen = useCallback(async () => {
    try {
      await CommerceController.markWatchAlertsSeen();
    } catch (error) {
      Logger.warn('Failed to mark watchlist alerts seen', { error });
    }
  }, []);

  return { items, markAllSeen };
}
