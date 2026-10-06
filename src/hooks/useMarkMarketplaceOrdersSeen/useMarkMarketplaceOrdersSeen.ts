'use client';

import { useEffect } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import { Logger } from '@/libs/logger/logger';
import { useAuthStore } from '@/stores/auth/auth.store';

function markOrdersSeen() {
  // A stubbed controller throws before a promise exists; that is a failed
  // write, not a render error.
  Promise.resolve()
    .then(() => CommerceController.markOrdersAttentionSeen())
    .catch((error) => {
      Logger.warn('Failed to advance the orders badge checkpoint', { error });
    });
}

/**
 * Moves the signed-in account's Orders checkpoint to now when the Orders
 * list becomes ready, when the account changes, and when the tab comes back
 * into view while the list is showing. A refreshed or polled order list is
 * not a new "seen" moment and never writes.
 */
export function useMarkMarketplaceOrdersSeen(isShowingOrders: boolean): void {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  useEffect(() => {
    if (!currentUserPubky || !isShowingOrders) return;
    markOrdersSeen();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') markOrdersSeen();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [currentUserPubky, isShowingOrders]);
}
