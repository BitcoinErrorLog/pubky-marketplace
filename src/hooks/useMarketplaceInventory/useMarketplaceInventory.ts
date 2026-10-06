'use client';

import { useCallback, useEffect, useState } from 'react';
import type { InventoryBoardLoad, InventoryBoardRow } from '@/application/commerce/inventory';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export function useMarketplaceInventory() {
  const sellerPubky = useAuthStore((state) => state.currentUserPubky);
  const identitySession = useCommerceStore((state) => state.marketplaceSession);
  const inventorySession = useCommerceStore((state) => state.inventorySession);
  const [load, setLoad] = useState<InventoryBoardLoad>({ status: 'session-required' });
  const [isLoading, setIsLoading] = useState(true);
  const [conflictListingId, setConflictListingId] = useState<string | null>(null);
  const [pendingListingId, setPendingListingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sellerPubky) {
      setLoad({ status: 'unauthenticated' });
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const next = await CommerceController.loadInventoryBoard(sellerPubky);
    setLoad(next);
    setIsLoading(false);
  }, [sellerPubky]);

  useEffect(() => {
    void refresh();
  }, [refresh, identitySession, inventorySession]);

  const setAvailable = useCallback(
    async (row: InventoryBoardRow, targetAvailable: number) => {
      if (!sellerPubky) return { status: 'error' as const, message: 'unauthenticated' };
      setPendingListingId(row.listingId);
      setConflictListingId(null);
      const result = await CommerceController.setInventoryAvailable({
        sellerPubky,
        row,
        targetAvailable,
        idempotencyKey: crypto.randomUUID(),
      });
      setPendingListingId(null);
      if (result.status === 'revision_conflict') {
        setConflictListingId(row.listingId);
        await refresh();
        return result;
      }
      if (result.status === 'updated') {
        setLoad((current) => {
          if (current.status !== 'ready') return current;
          return {
            status: 'ready',
            rows: current.rows.map((entry) => (entry.listingId === result.row.listingId ? result.row : entry)),
          };
        });
      }
      if (result.status === 'grant-needed') {
        setLoad({ status: 'grant-needed' });
      }
      return result;
    },
    [refresh, sellerPubky],
  );

  const retrySync = useCallback(
    async (row: InventoryBoardRow) => {
      if (!sellerPubky) return;
      setPendingListingId(row.listingId);
      const result = await CommerceController.retryInventorySync(sellerPubky, row.listingId);
      setPendingListingId(null);
      if (result.status === 'grant-needed') {
        setLoad({ status: 'grant-needed' });
        return;
      }
      if (result.status === 'synced' || result.status === 'missing') {
        setLoad((current) => {
          if (current.status !== 'ready') return current;
          return {
            status: 'ready',
            rows: current.rows.map((entry) =>
              entry.listingId === result.listingId
                ? {
                    ...entry,
                    sync: result.status,
                    syncMessage: result.status === 'missing' ? result.message : null,
                  }
                : entry,
            ),
          };
        });
      }
      if (result.status === 'synced') {
        await refresh();
      }
    },
    [refresh, sellerPubky],
  );

  return {
    sellerPubky,
    load,
    isLoading,
    conflictListingId,
    pendingListingId,
    refresh,
    setAvailable,
    retrySync,
  };
}
