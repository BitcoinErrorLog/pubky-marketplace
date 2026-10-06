'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { CommerceController } from '@/controllers/commerce/commerce';
import { marketplaceOfferFailureMessage } from '@/libs/commerce/failure-messages';
import { amountInputSchemaForAsset, amountInputToMoney, type CommerceAsset } from '@/libs/commerce/pricing';
import { isMarketplaceRevisionConflict } from '@/libs/commerce/transaction-commands';
import { toast } from '@/molecules/Toaster/use-toast';
import {
  type MarketplaceOfferData,
  marketplaceOfferDefaults,
  marketplaceOfferSchema,
} from './useMarketplaceOffer.types';

export interface UseMarketplaceOfferResult {
  form: UseFormReturn<MarketplaceOfferData>;
  submit: () => Promise<boolean>;
  reset: () => void;
}

/**
 * `priceAsset` is the listing's own pricing asset: the offer's money is built
 * in it (bitcoin offers on bitcoin listings, USD on USD) because the record and
 * service reject cross-asset amounts.
 */
export function useMarketplaceOffer(
  aggregateId: string,
  expectedRevision: number | null,
  onConflict: () => void | Promise<void>,
  priceAsset: CommerceAsset,
  isOwner = false,
): UseMarketplaceOfferResult {
  const form = useForm<MarketplaceOfferData>({
    resolver: zodResolver(marketplaceOfferSchema),
    defaultValues: marketplaceOfferDefaults,
    mode: 'onChange',
  });

  const submit = async (): Promise<boolean> => {
    if (isOwner) {
      toast({ variant: 'error', description: 'You cannot buy your own listing' });
      return false;
    }
    if (expectedRevision === null) return false;
    let succeeded = false;
    await form.handleSubmit(async (data) => {
      const assetCheck = amountInputSchemaForAsset(priceAsset).safeParse(data.amount);
      if (!assetCheck.success) {
        form.setError('amount', { message: assetCheck.error.issues[0]?.message ?? 'Enter a valid amount.' });
        return;
      }
      try {
        const response = await CommerceController.executeMarketplaceCommand({
          version: 1,
          commandId: crypto.randomUUID(),
          aggregateId,
          expectedRevision,
          issuedAt: new Date().toISOString(),
          kind: 'offer.create',
          payload: {
            amount: amountInputToMoney(data.amount, priceAsset),
            quantity: Number(data.quantity),
            expiresInSeconds: 24 * 60 * 60,
            message: data.message,
          },
        });
        if (!response.ok) {
          if (isMarketplaceRevisionConflict(response)) {
            await onConflict();
            toast({
              variant: 'error',
              description: 'This listing changed since you loaded it. The latest terms were reloaded — offer again.',
            });
            return;
          }
          toast({
            variant: 'error',
            description: marketplaceOfferFailureMessage(response.error.code, response.error.message),
          });
          return;
        }
        succeeded = true;
        toast({ title: 'Offer sent', description: 'The seller has 24 hours to respond.' });
      } catch {
        toast({ variant: 'error', description: 'Could not send this offer.' });
      }
    })();
    return succeeded;
  };

  const reset = () => form.reset(marketplaceOfferDefaults);
  return { form, submit, reset };
}
