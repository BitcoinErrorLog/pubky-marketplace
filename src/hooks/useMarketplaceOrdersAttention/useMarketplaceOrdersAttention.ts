'use client';

import { useMarketplaceOrdersAttentionKeys } from '@/hooks/useMarketplaceOrdersAttentionKeys/useMarketplaceOrdersAttentionKeys';

/** Orders that still need the signed-in account (see `useMarketplaceOrdersAttentionKeys`). */
export function useMarketplaceOrdersAttention(): number {
  return useMarketplaceOrdersAttentionKeys().length;
}
