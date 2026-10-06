'use client';

import { useLayoutEffect, useState } from 'react';
import { buildFeatureDiscoveryStorageKey, MARKETPLACE_PROMO_STORAGE_ID } from '@/config/featureDiscovery';
import { useAuthStore } from '@/stores/auth/auth.store';

interface PromoDismissalState {
  pubky: string | null;
  dismissed: boolean;
  hydrated: boolean;
}

/**
 * Per-account dismissal of the marketplace promo hero, persisted through the
 * same feature-discovery localStorage keys as useCollectionsNavDiscovery.
 * Guests can dismiss for the current session only (no account to key on).
 *
 * `isResolved` is false until the stored dismissal for the current account has
 * been read. The server-rendered promo stays mounted until then, and the read
 * runs in a layout effect so a dismissed promo is removed before paint.
 */
export function useMarketplacePromoDismissal() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const [dismissalState, setDismissalState] = useState<PromoDismissalState>({
    pubky: null,
    dismissed: false,
    hydrated: false,
  });

  useLayoutEffect(() => {
    if (!currentUserPubky) {
      setDismissalState({ pubky: null, dismissed: false, hydrated: true });
      return;
    }

    try {
      const storageKey = buildFeatureDiscoveryStorageKey(currentUserPubky, MARKETPLACE_PROMO_STORAGE_ID);
      setDismissalState({
        pubky: currentUserPubky,
        dismissed: window.localStorage.getItem(storageKey) === 'dismissed',
        hydrated: true,
      });
    } catch {
      setDismissalState({ pubky: currentUserPubky, dismissed: false, hydrated: true });
    }
  }, [currentUserPubky]);

  const isResolved = dismissalState.hydrated && dismissalState.pubky === (currentUserPubky ?? null);
  const showPromo = isResolved && !dismissalState.dismissed;

  const dismissPromo = () => {
    if (!showPromo) return;
    setDismissalState({ pubky: currentUserPubky ?? null, dismissed: true, hydrated: true });
    if (!currentUserPubky) return;

    try {
      const storageKey = buildFeatureDiscoveryStorageKey(currentUserPubky, MARKETPLACE_PROMO_STORAGE_ID);
      window.localStorage.setItem(storageKey, 'dismissed');
    } catch {
      // The in-memory state already hides the promo for this render session.
    }
  };

  return {
    showPromo,
    isResolved,
    dismissPromo,
  };
}
