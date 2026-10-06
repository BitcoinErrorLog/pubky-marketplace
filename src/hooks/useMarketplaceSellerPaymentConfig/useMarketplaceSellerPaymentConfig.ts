'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import {
  isStripePaymentLink,
  isStripeRestrictedKey,
  type SellerPaymentConfigOwnView,
} from '@/libs/commerce/payment-methods';
import { Logger } from '@/libs/logger/logger';
import { toast } from '@/molecules/Toaster/use-toast';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

/**
 * The seller's "Get paid" configuration: stored rails (loaded from the
 * durable service) and the save action. Watch-only registration is the
 * Bitkit setup grant; `accountClaimed` is read from paykit-server.
 */
export function useMarketplaceSellerPaymentConfig() {
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [config, setConfig] = useState<SellerPaymentConfigOwnView | null>(null);
  const [accountClaimed, setAccountClaimed] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Reads overlap: a session refresh can still be in flight when Step 2's
  // claim read returns. The older read must not put the claim back.
  const loadGeneration = useRef(0);

  const load = useCallback(async (): Promise<boolean | null> => {
    const generation = ++loadGeneration.current;
    setIsLoading(true);
    setLoadError(null);
    const [configResult, claimedResult] = await Promise.allSettled([
      CommerceController.getMyPaymentConfig(),
      CommerceController.isOwnPaykitAccountClaimed(),
    ]);
    const claimed = claimedResult.status === 'fulfilled' ? claimedResult.value : null;
    if (generation !== loadGeneration.current) return claimed;
    if (configResult.status === 'fulfilled') {
      setConfig(configResult.value);
    } else {
      Logger.error('Failed to load the payment configuration', { error: configResult.reason });
      setLoadError(
        marketplaceFailureMessage(
          marketplaceErrorCode(configResult.reason),
          MARKETPLACE_FAILURE_MESSAGES.paymentSettings,
          configResult.reason,
        ),
      );
    }
    setAccountClaimed(claimed);
    setIsLoading(false);
    return claimed;
  }, []);

  const commitAccountClaimed = useCallback((claimed: boolean) => {
    loadGeneration.current += 1;
    setAccountClaimed(claimed);
  }, []);

  useEffect(() => {
    let active = true;
    void load().then(() => {
      if (!active) return;
    });
    return () => {
      active = false;
    };
  }, [load, marketplaceSession]);

  const save = useCallback(
    async (input: {
      bitcoinEnabled: boolean;
      stripePaymentLink: string;
      stripeRestrictedKey: string;
      paypalMerchantEmail: string;
    }): Promise<SellerPaymentConfigOwnView | false> => {
      const stripePaymentLink = input.stripePaymentLink.trim();
      const paypalMerchantEmail = input.paypalMerchantEmail.trim();
      const stripeRestrictedKey = input.stripeRestrictedKey.trim();
      if (stripePaymentLink && !isStripePaymentLink(stripePaymentLink)) {
        toast({
          title: 'Payment settings were not saved',
          description: 'The stored payment link could not be kept.',
        });
        return false;
      }
      if (stripeRestrictedKey && !isStripeRestrictedKey(stripeRestrictedKey)) {
        toast({
          title: 'Payment settings were not saved',
          description: 'The payment key is not a restricted key.',
        });
        return false;
      }
      setIsSaving(true);
      try {
        const saved = await CommerceController.putMyPaymentConfig({
          bitcoinEnabled: input.bitcoinEnabled,
          stripePaymentLink: stripePaymentLink || null,
          // Omit to preserve the stored key; the empty string clears it only
          // when a key exists to clear (an explicit user action in the form).
          ...(stripeRestrictedKey ? { stripeRestrictedKey } : {}),
          paypalMerchantEmail: paypalMerchantEmail || null,
        });
        setConfig(saved);
        toast({ title: 'Payment settings saved' });
        return saved;
      } catch (error) {
        Logger.error('Failed to save the payment configuration', { error });
        toast({
          title: 'Saving payment settings failed',
          description: marketplaceFailureMessage(
            marketplaceErrorCode(error),
            MARKETPLACE_FAILURE_MESSAGES.paymentSettingsSave,
          ),
        });
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [],
  );

  const clearStripeKey = useCallback(async (): Promise<boolean> => {
    if (!config) return false;
    setIsSaving(true);
    try {
      const saved = await CommerceController.putMyPaymentConfig({
        bitcoinEnabled: config.bitcoinEnabled,
        stripePaymentLink: config.stripePaymentLink,
        stripeRestrictedKey: '',
        paypalMerchantEmail: config.paypalMerchantEmail,
      });
      setConfig(saved);
      toast({ title: 'Payment key removed' });
      return true;
    } catch (error) {
      Logger.error('Failed to remove the Stripe key', { error });
      toast({
        title: 'Removing the payment key failed',
        description: marketplaceFailureMessage(
          marketplaceErrorCode(error),
          MARKETPLACE_FAILURE_MESSAGES.stripeKeyRemoval,
          error,
        ),
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [config]);

  return {
    isLoading,
    isSaving,
    config,
    accountClaimed,
    loadError,
    save,
    clearStripeKey,
    refresh: load,
    commitAccountClaimed,
  };
}
