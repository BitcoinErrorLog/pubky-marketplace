'use client';

import { useMarketplaceActivityAttentionKeys } from '@/hooks/useMarketplaceActivityAttentionKeys/useMarketplaceActivityAttentionKeys';
import { useMarketplaceOrdersAttentionKeys } from '@/hooks/useMarketplaceOrdersAttentionKeys/useMarketplaceOrdersAttentionKeys';

/**
 * Things that need this identity across Activity and Orders. An order that
 * badges both tabs (its return row on Activity, the order itself on Orders)
 * counts once.
 */
export function useMarketplaceNavAttention(): number {
  const activity = useMarketplaceActivityAttentionKeys();
  const orders = useMarketplaceOrdersAttentionKeys();
  return new Set([...activity, ...orders]).size;
}
