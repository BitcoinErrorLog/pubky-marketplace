'use client';

import { useCallback, useRef, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import {
  sellerPaymentConfirmationInputSchema,
  sellerPaymentResolutionInputSchema,
  sellerPaymentReviewReasonCopy,
  sellerPaymentReviewReasonSchema,
} from '@/libs/commerce/marketplace-payment-review';
import {
  type PaymentReviewRail,
  usdtPaymentResolutionInputSchema,
  usdtPaymentReviewReasonMessage,
} from '@/libs/commerce/usdt-payment-review';
import { USDT_REFUND_COPY } from '@/libs/commerce/usdt-refund';
import { isAppError } from '@/libs/error/error';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import { toast } from '@/molecules/Toaster/use-toast';

type ResolutionOutcome = 'paid' | 'refunded' | 'abandoned';

/**
 * `rail` picks the resolution rules of the order's payment: Bitcoin takes the
 * 1 to 64 character reference it always did, USDT an Arbitrum transaction hash
 * (usdt-payment-review.ts). It defaults to Bitcoin, so every existing caller
 * is unchanged.
 */
export function useMarketplaceSellerPaymentReview(
  onChanged: () => void | Promise<void>,
  rail: PaymentReviewRail = 'bitcoin',
) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intent = useRef<{ orderId: string; body: string; key: string } | null>(null);

  const confirm = async (orderId: string, reason?: string): Promise<boolean> => {
    if (isSubmitting) return false;
    const parsedInput = sellerPaymentConfirmationInputSchema.safeParse({ reason });
    if (!parsedInput.success) {
      const message = 'The seller note must be 500 characters or fewer.';
      setError(message);
      toast({ variant: 'error', description: message });
      return false;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await CommerceController.confirmBitcoinPayment(orderId, parsedInput.data.reason);
      await onChanged();
      return true;
    } catch (actionError) {
      const message = getReviewErrorMessage(actionError, 'bitcoin');
      setError(message);
      if (isAppError(actionError) && actionError.code === 'CONFLICT') {
        await onChanged();
      }
      toast({ variant: 'error', description: message });
      if (isMarketplaceSessionRequiredError(actionError)) return false;
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  const resolve = async (
    orderId: string,
    outcome: ResolutionOutcome,
    reason?: string,
    externalRefundReference?: string,
  ): Promise<boolean> => {
    if (isSubmitting) return false;
    const parsedInput = (
      rail === 'usdt' ? usdtPaymentResolutionInputSchema : sellerPaymentResolutionInputSchema
    ).safeParse({ outcome, reason, externalRefundReference });
    if (!parsedInput.success) {
      const message =
        parsedInput.error.issues[0]?.path[0] === 'externalRefundReference'
          ? rail === 'usdt'
            ? USDT_REFUND_COPY.referenceRequired
            : 'Enter a printable ASCII refund reference from 1 to 64 characters.'
          : 'The payment review reason must be 500 characters or fewer.';
      setError(message);
      toast({ variant: 'error', description: message });
      return false;
    }
    const input = parsedInput.data;
    const body = JSON.stringify(input);
    if (!intent.current || intent.current.orderId !== orderId || intent.current.body !== body) {
      intent.current = { orderId, body, key: crypto.randomUUID() };
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await CommerceController.resolveBitcoinPayment(orderId, input, intent.current.key);
      intent.current = null;
      await onChanged();
      return true;
    } catch (actionError) {
      const message = getReviewErrorMessage(actionError, rail);
      setError(message);
      if (isAppError(actionError) && actionError.code === 'CONFLICT') {
        intent.current = null;
        await onChanged();
      }
      toast({ variant: 'error', description: message });
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  const reset = useCallback(() => {
    intent.current = null;
    setError(null);
  }, []);

  return { confirm, resolve, reset, isSubmitting, error };
}

function getReviewErrorMessage(error: unknown, rail: PaymentReviewRail): string {
  if (isMarketplaceSessionRequiredError(error)) return MARKETPLACE_FAILURE_MESSAGES.session;
  if (isAppError(error)) {
    const reason = sellerPaymentReviewReasonSchema.safeParse(error.context?.reason);
    if (reason.success) {
      return (
        (rail === 'usdt' ? usdtPaymentReviewReasonMessage(reason.data) : null) ??
        sellerPaymentReviewReasonCopy[reason.data]
      );
    }
    if (error.code === 'CONFLICT') return MARKETPLACE_FAILURE_MESSAGES.paymentChanged;
    if (error.code === 'FORBIDDEN') return 'Only the seller can review this payment.';
    if (error.code === 'NOT_FOUND') return 'The order was not found.';
  }
  return 'The payment review could not be completed.';
}
