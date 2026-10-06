'use client';

import { useEffect, useState } from 'react';
import { getCommerceAdapterMode, getCommercePollIntervalMs } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceConversation } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * SANDBOX transport inbox: the durable transaction service has no
 * conversation or message tables (the `message.*` commands were never
 * ported), so in any other mode this hook loads nothing. Durable modes list
 * encrypted conversations through `useEncryptedInbox` instead.
 */
export function useMarketplaceInbox() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isSandbox = getCommerceAdapterMode() === 'sandbox';
  const [conversations, setConversations] = useState<MarketplaceConversation[]>([]);
  const [isLoading, setIsLoading] = useState(isSandbox && Boolean(currentUserPubky));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentUserPubky || !isSandbox) {
      setIsLoading(false);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const next = await CommerceController.getMarketplaceConversations();
        if (active) {
          setConversations(next);
          setError(null);
        }
      } catch {
        if (active) setError('Marketplace messages are unavailable.');
      } finally {
        if (active) setIsLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, getCommercePollIntervalMs());
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [currentUserPubky, isSandbox]);

  return { conversations, isLoading, error, isSandbox };
}
