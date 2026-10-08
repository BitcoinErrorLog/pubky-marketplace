'use client';

import { useEffect, useState } from 'react';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export function useMarketplaceSellingAccess() {
  const pubky = useAuthStore((state) => state.currentUserPubky);
  const session = useCommerceStore((state) => state.marketplaceSession);
  const durable = isDurableCommerceMode(getCommerceAdapterMode());
  const [checkedPubky, setCheckedPubky] = useState<string | null>(null);

  useEffect(() => {
    if (durable && pubky) CommerceController.restorePersistedMarketplaceSession(pubky);
    setCheckedPubky(pubky);
  }, [durable, pubky]);

  const checkAccess = () => {
    if (!durable) return true;
    const currentPubky = useAuthStore.getState().currentUserPubky;
    if (!currentPubky) return false;
    CommerceController.restorePersistedMarketplaceSession(currentPubky);
    return (
      useCommerceStore.getState().marketplaceSession?.pubky === currentPubky &&
      CommerceController.hasActiveMarketplaceSession()
    );
  };

  return {
    pubky,
    ready: !durable || (pubky !== null && checkedPubky === pubky),
    allowed: !durable || (session?.pubky === pubky && CommerceController.hasActiveMarketplaceSession()),
    checkAccess,
  };
}
