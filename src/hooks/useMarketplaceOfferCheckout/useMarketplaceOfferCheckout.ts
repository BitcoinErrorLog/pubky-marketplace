'use client';

import { useRef, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import { isMarketplaceAwardCheckoutEligible } from '@/core/services/marketplace/marketplace-projections';
import { BIND_FAIL_CANCEL_REASON, extractCheckoutOrderIds } from '@/libs/commerce/checkout-phase';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceOfferCheckoutFailureMessage,
  marketplacePaymentMethodFailureMessage,
} from '@/libs/commerce/failure-messages';
import type { PaymentMethodKind } from '@/libs/commerce/payment-methods';
import { buildMarketplaceOrderAggregateId } from '@/libs/commerce/transaction-commands';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceOffer, MarketplaceOfferAward, MarketplaceOrder } from '@/services/marketplace/marketplace';

type DeliveryAddress = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
};

export type MarketplaceOfferCheckoutResult =
  | { ok: true; orderId: string | null; boundOrder: MarketplaceOrder | null }
  | { ok: false; code: string | null };

export function useMarketplaceOfferCheckout(onCompleted?: () => Promise<void> | void) {
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  /**
   * `deliveryAddress` is null exactly for a pickup award: the command then
   * carries `fulfillment: 'pickup'` and no address. A shipped award sends the
   * same payload as before, so older service builds keep accepting it.
   */
  const submit = async (
    offer: MarketplaceOffer,
    deliveryAddress: DeliveryAddress | null,
    method?: PaymentMethodKind | null,
  ): Promise<MarketplaceOfferCheckoutResult> => {
    if (submittingRef.current) return { ok: false, code: 'SUBMITTING' };
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      let currentOffer: MarketplaceOffer | undefined;
      try {
        currentOffer = (await CommerceController.getMarketplaceOffers()).find(({ id }) => id === offer.id);
      } catch (error) {
        if (isMarketplaceSessionRequiredError(error)) {
          toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.session });
          return { ok: false, code: 'SESSION_REQUIRED' };
        }
        throw error;
      }
      if (!currentOffer) {
        toast({ variant: 'error', description: 'This offer is no longer available.' });
        return { ok: false, code: 'AWARD_UNAVAILABLE' };
      }
      const award: MarketplaceOfferAward | undefined = currentOffer.award;
      if (!award || award.state !== 'active' || !isMarketplaceAwardCheckoutEligible(award)) {
        toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.offerCheckoutUnavailable });
        return { ok: false, code: 'AWARD_UNAVAILABLE' };
      }
      try {
        const response = await CommerceController.commitOfferCheckout({
          version: 1,
          commandId: crypto.randomUUID(),
          aggregateId: currentOffer.aggregateId,
          expectedRevision: currentOffer.revision,
          issuedAt: new Date().toISOString(),
          kind: 'offer.checkout',
          payload: {
            offerId: currentOffer.id,
            awardId: award.id,
            listingAggregateId: award.listing.aggregateId,
            listingRevision: award.listing.listingRevision,
            listingRecordSha256: award.listing.listingRecordSha256,
            variantId: award.variant.id,
            quantity: award.quantity,
            ...(deliveryAddress ? { deliveryAddress } : { fulfillment: 'pickup' as const }),
            guaranteePolicyVersion: 1,
          },
        });
        if (!response.ok) {
          toast({
            variant: 'error',
            description: marketplaceOfferCheckoutFailureMessage(response.error.code),
          });
          return { ok: false, code: response.error.code };
        }
        const createdOrder = response.result.order;
        const orderId =
          createdOrder &&
          typeof createdOrder === 'object' &&
          'id' in createdOrder &&
          typeof createdOrder.id === 'string'
            ? createdOrder.id
            : (extractCheckoutOrderIds(response.result)[0] ?? null);
        let boundOrder: MarketplaceOrder | null = null;
        if (method && orderId) {
          try {
            boundOrder = await CommerceController.bindPaymentMethod(orderId, method);
          } catch (bindError) {
            try {
              await CommerceController.executeMarketplaceCommand({
                version: 1,
                commandId: crypto.randomUUID(),
                aggregateId: buildMarketplaceOrderAggregateId(orderId),
                expectedRevision: 1,
                issuedAt: new Date().toISOString(),
                kind: 'order.cancel_request',
                payload: { orderId, reason: BIND_FAIL_CANCEL_REASON },
              });
            } catch {
              // Bind already failed; leftover expires on the hold clock.
            }
            toast({
              variant: 'error',
              description: marketplacePaymentMethodFailureMessage(bindError, MARKETPLACE_FAILURE_MESSAGES.checkout),
            });
            return { ok: false, code: 'BIND_FAILED' };
          }
        }
        await onCompleted?.();
        return { ok: true, orderId, boundOrder };
      } catch (error) {
        if (isMarketplaceSessionRequiredError(error)) {
          toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.session });
          return { ok: false, code: 'SESSION_REQUIRED' };
        }
        toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.checkout });
        return { ok: false, code: null };
      }
    } catch {
      toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.offerCheckoutUnavailable });
      return { ok: false, code: 'AWARD_UNAVAILABLE' };
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return { submit, isSubmitting };
}
