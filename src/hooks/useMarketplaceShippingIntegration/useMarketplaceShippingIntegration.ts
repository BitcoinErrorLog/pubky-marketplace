'use client';

import { useEffect, useState } from 'react';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import type { SellerShippingConfig, ShipFromAddress } from '@/libs/commerce/shipping';
import { Logger } from '@/libs/logger/logger';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * The seller's Shippo shipping integration settings (durable service only):
 * loads the stored configuration and saves changes. The Shippo API token is
 * write-only on the service — only `shippoApiKeySet` ever comes back, so
 * the UI can show that a token exists without ever holding it.
 */
export function useMarketplaceShippingIntegration() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isDurable = isDurableCommerceMode(getCommerceAdapterMode());
  const enabled = isDurable && Boolean(currentUserPubky);
  const [config, setConfig] = useState<SellerShippingConfig | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const stored = await CommerceController.getMyShippingConfig();
        if (active) setConfig(stored);
      } catch (error) {
        Logger.error('Failed to load the shipping integration configuration', { error });
      } finally {
        if (active) setIsLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [enabled]);

  const save = async (input: { shippoApiKey?: string; shipFrom: ShipFromAddress | null }): Promise<boolean> => {
    setIsSaving(true);
    try {
      const saved = await CommerceController.putMyShippingConfig(input);
      setConfig(saved);
      toast({ description: 'Shipping integration settings saved.' });
      return true;
    } catch (error) {
      Logger.error('Failed to save the shipping integration configuration', { error });
      toast({
        title: 'Could not save shipping settings',
        description: marketplaceFailureMessage(
          marketplaceErrorCode(error),
          MARKETPLACE_FAILURE_MESSAGES.shippingSettings,
        ),
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  return { enabled, config, isLoading, isSaving, save };
}
