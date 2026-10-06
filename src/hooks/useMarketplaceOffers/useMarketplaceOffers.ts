'use client';

import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { getCommercePollIntervalMs } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  type MarketplaceOfferData,
  marketplaceOfferDefaults,
  marketplaceOfferSchema,
} from '@/hooks/useMarketplaceOffer/useMarketplaceOffer.types';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import { amountInputSchemaForAsset, amountInputToMoney } from '@/libs/commerce/pricing';
import { isMarketplaceRevisionConflict } from '@/libs/commerce/transaction-commands';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceOffer } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export function useMarketplaceOffers() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  // Refetch trigger: connecting a session replaces this store object, so the
  // effect below re-runs immediately instead of waiting for the next poll.
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const [offers, setOffers] = useState<MarketplaceOffer[]>([]);
  const [isLoading, setIsLoading] = useState(Boolean(currentUserPubky));
  const [error, setError] = useState<string | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  const form = useForm<MarketplaceOfferData>({
    resolver: zodResolver(marketplaceOfferSchema),
    defaultValues: marketplaceOfferDefaults,
    mode: 'onChange',
  });

  const refresh = () => loadOffers(currentUserPubky, setOffers, setIsLoading, setError, setNeedsSession);

  useEffect(() => {
    if (!currentUserPubky) {
      setIsLoading(false);
      return;
    }
    let active = true;
    void loadOffers(currentUserPubky, setOffers, setIsLoading, setError, setNeedsSession);
    const timer = window.setInterval(() => {
      if (active) void loadOffers(currentUserPubky, setOffers, setIsLoading, setError, setNeedsSession);
    }, getCommercePollIntervalMs());
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [currentUserPubky, marketplaceSession]);

  const act = async (offer: MarketplaceOffer, kind: 'offer.accept' | 'offer.reject' | 'offer.withdraw') => {
    try {
      const response = await CommerceController.executeMarketplaceCommand({
        version: 1,
        commandId: crypto.randomUUID(),
        aggregateId: offer.aggregateId,
        expectedRevision: offer.revision,
        issuedAt: new Date().toISOString(),
        kind,
        payload: { offerId: offer.id },
      });
      if (!response.ok) {
        if (isMarketplaceRevisionConflict(response)) {
          await refresh();
          toast({
            variant: 'error',
            description: MARKETPLACE_FAILURE_MESSAGES.offerChanged,
          });
          return false;
        }
        toast({
          variant: 'error',
          description: marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.offer),
        });
        return false;
      }
      await refresh();
      if (kind === 'offer.accept') {
        toast({ title: 'Offer accepted — the buyer has 30 minutes to complete checkout.' });
      } else if (kind === 'offer.reject') {
        toast({ title: 'Offer declined.' });
      }
      return true;
    } catch (actionError) {
      if (isMarketplaceSessionRequiredError(actionError)) {
        // Expiry mid-action must surface the reconnect affordance, not a
        // generic failure: the surface swaps to the session-required card.
        setNeedsSession(true);
        setError(MARKETPLACE_FAILURE_MESSAGES.session);
        toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.session });
        return false;
      }
      toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.offer });
      return false;
    }
  };

  const counter = async (offer: MarketplaceOffer): Promise<boolean> => {
    let succeeded = false;
    await form.handleSubmit(async (data) => {
      // Counters are made in the offer's own asset (bitcoin counters on
      // bitcoin offers): the record and service reject cross-asset amounts.
      const assetCheck = amountInputSchemaForAsset(offer.amount).safeParse(data.amount);
      if (!assetCheck.success) {
        form.setError('amount', { message: assetCheck.error.issues[0]?.message ?? 'Enter a valid amount.' });
        return;
      }
      try {
        const response = await CommerceController.executeMarketplaceCommand({
          version: 1,
          commandId: crypto.randomUUID(),
          aggregateId: offer.aggregateId,
          expectedRevision: offer.revision,
          issuedAt: new Date().toISOString(),
          kind: 'offer.counter',
          payload: {
            offerId: offer.id,
            amount: amountInputToMoney(data.amount, offer.amount),
            quantity: Number(data.quantity),
            expiresInSeconds: 24 * 60 * 60,
            message: data.message,
          },
        });
        if (!response.ok) {
          if (isMarketplaceRevisionConflict(response)) {
            await refresh();
            toast({
              variant: 'error',
              description: MARKETPLACE_FAILURE_MESSAGES.offerChanged,
            });
            return;
          }
          toast({
            variant: 'error',
            description: marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.counterOffer),
          });
          return;
        }
        succeeded = true;
        form.reset(marketplaceOfferDefaults);
        await refresh();
      } catch (actionError) {
        if (isMarketplaceSessionRequiredError(actionError)) {
          setNeedsSession(true);
          setError(MARKETPLACE_FAILURE_MESSAGES.session);
          toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.session });
          return;
        }
        toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.counterOffer });
      }
    })();
    return succeeded;
  };

  return { offers, isLoading, error, needsSession, form, refresh, act, counter };
}

async function loadOffers(
  currentUserPubky: string | null,
  setOffers: Dispatch<SetStateAction<MarketplaceOffer[]>>,
  setIsLoading: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | null>>,
  setNeedsSession: Dispatch<SetStateAction<boolean>>,
): Promise<void> {
  if (!currentUserPubky) return;
  try {
    setOffers(await CommerceController.getMarketplaceOffers());
    setError(null);
    setNeedsSession(false);
  } catch (loadError) {
    // A missing/expired marketplace session is not a dead end: flag it so the
    // surface renders the session-connect affordance with static guidance.
    setNeedsSession(isMarketplaceSessionRequiredError(loadError));
    setError(
      marketplaceFailureMessage(
        marketplaceErrorCode(loadError),
        MARKETPLACE_FAILURE_MESSAGES.offersUnavailable,
        loadError,
      ),
    );
  } finally {
    setIsLoading(false);
  }
}
