'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getCommerceAdapterMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { activityNeedingAttentionKeys } from '@/libs/commerce/marketplace-attention';
import { Logger } from '@/libs/logger/logger';
import { isRecognizedMarketplaceNotification } from '@/services/marketplace/marketplace-projections';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

/**
 * Activity that still needs the signed-in account, for the marketplace
 * Activity entry point. One key per subject, without overlap:
 *
 * - `order:<id>` / `offer:<id>` / `notification:<id>` — service rows of an
 *   action type whose subject still needs this account right now (the order
 *   waits on them, the offer waits on their answer, the award waits on their
 *   checkout; see `activityNeedingAttentionKeys`). Informational rows
 *   (checkout started, cancelled, shipped, completed) never count. Sandbox
 *   rows use their REAL read state (`readAt`); durable rows count only when
 *   created after the account's activity checkpoint, which opening Activity
 *   on any browser moves forward (see `CommerceAttentionSeenApplication`).
 * - `alert:<id>` — unseen watch alerts this device's own checks produced,
 *   whose `seen_at` read state is real because it is local.
 *
 * The local parts (alerts, this browser's checkpoint copy) are live Dexie
 * reads; the service lists are fetched on mount and re-fetched when the
 * session or checkpoint changes. A failed fetch contributes nothing — the
 * badge may lag reality but can never invent it. Zero renders no badge.
 *
 * Every asynchronous result is tagged with the pubky it was read for. A
 * result for any other pubky is dropped, and an identity change clears the
 * displayed keys before paint so the previous account cannot badge the
 * next one.
 */
type TaggedKeys = { pubky: string; keys: readonly string[] };

type LocalActivityBadge = {
  pubky: string | null;
  unseenAlertKeys: readonly string[];
  checkpoint: number | undefined;
};

const NO_KEYS: readonly string[] = [];

export function useMarketplaceActivityAttentionKeys(): readonly string[] {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  // Refetch trigger: connecting a session replaces this store object (the
  // same wiring the activity page's own notifications hook relies on).
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const adapterMode = getCommerceAdapterMode();
  const [trackedPubky, setTrackedPubky] = useState(currentUserPubky);
  const [serviceKeys, setServiceKeys] = useState<TaggedKeys | null>(null);
  const pubkyRef = useRef(currentUserPubky);
  useLayoutEffect(() => {
    pubkyRef.current = currentUserPubky;
  }, [currentUserPubky]);

  // Identity changes before paint. React re-renders with cleared keys
  // instead of committing the previous account's badge.
  if (trackedPubky !== currentUserPubky) {
    setTrackedPubky(currentUserPubky);
    setServiceKeys(null);
  }

  useEffect(() => {
    if (!currentUserPubky) return;
    // Raises this browser's checkpoint copy (a live Dexie row) when another
    // browser already opened Activity for this account.
    Promise.resolve()
      .then(() => CommerceController.syncAttentionSeen())
      .catch((error) => {
        Logger.warn('Failed to load the marketplace badge checkpoint', { error });
      });
  }, [currentUserPubky]);

  const local = useLiveQuery(async (): Promise<LocalActivityBadge> => {
    if (!currentUserPubky) return { pubky: null, unseenAlertKeys: NO_KEYS, checkpoint: 0 };
    try {
      const [alerts, checkpoint] = await Promise.all([
        CommerceController.getWatchAlerts(),
        CommerceController.getActivityReadCheckpoint(),
      ]);
      return {
        pubky: currentUserPubky,
        unseenAlertKeys: alerts.filter(({ seen_at }) => seen_at === null).map(({ id }) => `alert:${id}`),
        checkpoint,
      };
    } catch (error) {
      // A stubbed controller throws before a promise exists. Leaving the
      // checkpoint unset keeps the service count at zero instead of treating
      // every row as new.
      Logger.warn('Failed to load the marketplace activity badge count', { error });
      return { pubky: currentUserPubky, unseenAlertKeys: NO_KEYS, checkpoint: undefined };
    }
  }, [currentUserPubky]);

  const localForCurrent = currentUserPubky !== null && local?.pubky === currentUserPubky ? local : undefined;
  const checkpoint = localForCurrent?.checkpoint;
  const keysForCurrent = serviceKeys?.pubky === currentUserPubky ? serviceKeys.keys : NO_KEYS;

  useEffect(() => {
    if (!currentUserPubky || adapterMode === 'unavailable' || checkpoint === undefined) {
      setServiceKeys(currentUserPubky ? { pubky: currentUserPubky, keys: NO_KEYS } : null);
      return;
    }
    const fetchedFor = currentUserPubky;
    const fetchedCheckpoint = checkpoint;
    let active = true;
    // A subject list that fails to load only drops the rows about it.
    const subjects = <T>(load: () => Promise<T[]>, what: string): Promise<T[]> =>
      Promise.resolve()
        .then(load)
        .catch((error) => {
          Logger.warn(`Failed to load marketplace ${what} for the activity badge`, { error });
          return [];
        });
    // A stubbed controller throws before a promise exists. That is a failed
    // load: the badge stays at zero.
    Promise.resolve()
      .then(() =>
        Promise.all([
          CommerceController.getMarketplaceNotifications(),
          subjects(() => CommerceController.getMarketplaceOrders(), 'orders'),
          subjects(() => CommerceController.getMarketplaceOffers(), 'offers'),
        ]),
      )
      .then(([notifications, orders, offers]) => {
        if (!active || pubkyRef.current !== fetchedFor) return;
        setServiceKeys({
          pubky: fetchedFor,
          keys: activityNeedingAttentionKeys({
            notifications: notifications.filter(isRecognizedMarketplaceNotification),
            orders,
            offers,
            currentUserPubky: fetchedFor,
            clearedBy: adapterMode === 'sandbox' ? { kind: 'read-state' } : { kind: 'seen', seenAt: fetchedCheckpoint },
          }),
        });
      })
      .catch((error) => {
        if (!active || pubkyRef.current !== fetchedFor) return;
        setServiceKeys({ pubky: fetchedFor, keys: NO_KEYS });
        Logger.warn('Failed to load the marketplace activity badge count', { error });
      });
    return () => {
      active = false;
    };
  }, [currentUserPubky, adapterMode, checkpoint, marketplaceSession]);

  const alertKeys = localForCurrent?.unseenAlertKeys ?? NO_KEYS;
  return alertKeys.length === 0 ? keysForCurrent : [...keysForCurrent, ...alertKeys];
}
