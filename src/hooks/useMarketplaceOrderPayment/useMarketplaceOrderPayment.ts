'use client';

import { useCallback, useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
  marketplacePaymentMethodFailureMessage,
} from '@/libs/commerce/failure-messages';
import {
  availablePaymentMethods,
  type PaymentMethodKind,
  type SellerPaymentConfig,
} from '@/libs/commerce/payment-methods';
import { Logger } from '@/libs/logger/logger';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

/**
 * Buyer/seller actions for one order's payment method (durable modes only):
 * loads the seller's available rails while no method is bound, binds the
 * buyer's choice, and drives the per-rail follow-ups — Stripe verification,
 * the PayPal report, and the seller's PayPal receipt confirmation. Every
 * successful action calls `onPaymentChanged` so the parent refetches the
 * authoritative order.
 */
export function useMarketplaceOrderPayment({
  order,
  enabled,
  onPaymentChanged,
}: {
  order: MarketplaceOrder;
  enabled: boolean;
  onPaymentChanged: () => void | Promise<void>;
}) {
  const [sellerConfig, setSellerConfig] = useState<SellerPaymentConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'bind' | 'verify' | 'mark-paid' | 'confirm' | null>(null);

  const needsConfig = enabled && !order.paymentMethod;

  useEffect(() => {
    if (!needsConfig) return;
    let active = true;
    const load = async () => {
      setConfigError(null);
      try {
        const config = await CommerceController.getSellerPaymentConfig(order.sellerPubky);
        if (active) setSellerConfig(config);
      } catch (error) {
        Logger.error('Failed to load the seller payment configuration', { error });
        if (active)
          setConfigError(
            marketplaceFailureMessage(marketplaceErrorCode(error), MARKETPLACE_FAILURE_MESSAGES.paymentSettings, error),
          );
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [needsConfig, order.sellerPubky]);

  const runAction = useCallback(
    async (action: 'bind' | 'verify' | 'mark-paid' | 'confirm', run: () => Promise<void>) => {
      setPendingAction(action);
      try {
        await run();
        await onPaymentChanged();
      } catch (error) {
        Logger.error(`Marketplace payment action '${action}' failed`, { error });
        toast({
          variant: 'error',
          title: 'Payment action failed',
          description: marketplacePaymentMethodFailureMessage(error, 'The payment action could not be completed.'),
        });
      } finally {
        setPendingAction(null);
      }
    },
    [onPaymentChanged],
  );

  const bind = useCallback(
    async (method: PaymentMethodKind) => {
      await runAction('bind', async () => {
        await CommerceController.bindPaymentMethod(order.id, method);
      });
    },
    [order.id, runAction],
  );

  const verifyStripe = useCallback(async () => {
    await runAction('verify', async () => {
      const result = await CommerceController.verifyStripePayment(order.id);
      if (!result.verified) {
        toast({
          title: 'Payment not found yet',
          description:
            'No matching payment has been reported on the seller\u2019s account. If you just paid, wait a moment and verify again.',
        });
      }
    });
  }, [order.id, runAction]);

  const markPaid = useCallback(
    async (transactionRef: string) => {
      await runAction('mark-paid', async () => {
        await CommerceController.markFiatPaid(order.id, transactionRef.trim() || undefined);
      });
    },
    [order.id, runAction],
  );

  const confirmReceived = useCallback(async () => {
    await runAction('confirm', async () => {
      await CommerceController.confirmFiatReceived(order.id);
    });
  }, [order.id, runAction]);

  return {
    availableMethods: sellerConfig ? availablePaymentMethods(sellerConfig) : null,
    bitcoinOfferUnavailable: sellerConfig?.bitcoinAvailable === true && sellerConfig.bitcoinOfferAvailable === false,
    configError,
    pendingAction,
    bind,
    verifyStripe,
    markPaid,
    confirmReceived,
  };
}
