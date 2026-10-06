'use client';

import { useMarketplaceActivityAttentionKeys } from '@/hooks/useMarketplaceActivityAttentionKeys/useMarketplaceActivityAttentionKeys';

/** Activity subjects that still need the signed-in account (see `useMarketplaceActivityAttentionKeys`). */
export function useMarketplaceActivityUnread(): number {
  return useMarketplaceActivityAttentionKeys().length;
}
