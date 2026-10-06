'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  InventoryAutomationsLoad,
  InventorySessionKind,
  InventoryWebhookSecretResult,
} from '@/application/commerce/inventory-automations';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export function useMarketplaceInventoryAutomations() {
  const sellerPubky = useAuthStore((state) => state.currentUserPubky);
  const identitySession = useCommerceStore((state) => state.marketplaceSession);
  const inventorySession = useCommerceStore((state) => state.inventorySession);
  const [load, setLoad] = useState<InventoryAutomationsLoad>({ status: 'session-required' });
  const [isLoading, setIsLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [secret, setSecret] = useState<Extract<InventoryWebhookSecretResult, { status: 'secret' }> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sellerPubky) {
      setLoad({ status: 'unauthenticated' });
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const next = await CommerceController.loadInventoryAutomations(sellerPubky);
    setLoad(next);
    setIsLoading(false);
  }, [sellerPubky]);

  useEffect(() => {
    void refresh();
  }, [refresh, identitySession, inventorySession]);

  const revoke = useCallback(
    async (id: string, kind: InventorySessionKind) => {
      if (!sellerPubky) return;
      setPendingId(id);
      setMessage(null);
      const result = await CommerceController.revokeInventorySession(sellerPubky, id, kind);
      setPendingId(null);
      if (result.status === 'revoked') {
        await refresh();
        return;
      }
      if (result.status === 'grant-needed' || result.status === 'session-required') {
        setLoad(result);
        return;
      }
      if (result.status === 'error') setMessage(result.message);
    },
    [refresh, sellerPubky],
  );

  const addWebhook = useCallback(
    async (url: string) => {
      if (!sellerPubky) return;
      setPendingId('add-webhook');
      setMessage(null);
      const result = await CommerceController.addInventoryWebhook(sellerPubky, url);
      setPendingId(null);
      if (result.status === 'secret') {
        setSecret(result);
        await refresh();
        return;
      }
      if (result.status === 'invalid-url') {
        setMessage(result.message);
        return;
      }
      if (result.status === 'grant-needed' || result.status === 'session-required') {
        setLoad(result);
        return;
      }
      if (result.status === 'error') setMessage(result.message);
    },
    [refresh, sellerPubky],
  );

  const rotateWebhook = useCallback(
    async (id: string) => {
      if (!sellerPubky) return;
      setPendingId(id);
      setMessage(null);
      const result = await CommerceController.rotateInventoryWebhook(sellerPubky, id);
      setPendingId(null);
      if (result.status === 'secret') {
        setSecret(result);
        return;
      }
      if (result.status === 'grant-needed' || result.status === 'session-required') {
        setLoad(result);
        return;
      }
      if (result.status === 'error') setMessage(result.message);
    },
    [sellerPubky],
  );

  const deleteWebhook = useCallback(
    async (id: string) => {
      if (!sellerPubky) return;
      setPendingId(id);
      setMessage(null);
      const result = await CommerceController.deleteInventoryWebhook(sellerPubky, id);
      setPendingId(null);
      if (result.status === 'deleted') {
        await refresh();
        return;
      }
      if (result.status === 'grant-needed' || result.status === 'session-required') {
        setLoad(result);
        return;
      }
      if (result.status === 'error') setMessage(result.message);
    },
    [refresh, sellerPubky],
  );

  return {
    sellerPubky,
    load,
    isLoading,
    pendingId,
    secret,
    message,
    refresh,
    revoke,
    addWebhook,
    rotateWebhook,
    deleteWebhook,
    dismissSecret: () => setSecret(null),
  };
}
