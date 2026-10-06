'use client';

import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import {
  sellerPaymentConfirmationInputSchema,
  sellerPaymentResolutionInputSchema,
} from '@/libs/commerce/marketplace-payment-review';
import { useMarketplaceSellerPaymentReview } from './useMarketplaceSellerPaymentReview';

export type SellerPaymentConfirmationForm = z.input<typeof sellerPaymentConfirmationInputSchema>;
export type SellerPaymentConfirmationSubmission = z.output<typeof sellerPaymentConfirmationInputSchema>;
export type SellerPaymentResolutionForm = z.input<typeof sellerPaymentResolutionInputSchema>;
export type SellerPaymentResolutionSubmission = z.output<typeof sellerPaymentResolutionInputSchema>;

export function useMarketplaceSellerPaymentReviewForm(
  orderId: string,
  onChanged: () => void | Promise<void>,
): {
  confirmForm: UseFormReturn<SellerPaymentConfirmationForm, unknown, SellerPaymentConfirmationSubmission>;
  resolveForm: UseFormReturn<SellerPaymentResolutionForm, unknown, SellerPaymentResolutionSubmission>;
  submitConfirm: () => Promise<boolean>;
  submitResolve: () => Promise<boolean>;
  isSubmitting: boolean;
  error: string | null;
} {
  const mutation = useMarketplaceSellerPaymentReview(onChanged);
  const confirmForm = useForm<SellerPaymentConfirmationForm, unknown, SellerPaymentConfirmationSubmission>({
    resolver: zodResolver(sellerPaymentConfirmationInputSchema),
    defaultValues: { reason: '' },
  });
  const resolveForm = useForm<SellerPaymentResolutionForm, unknown, SellerPaymentResolutionSubmission>({
    resolver: zodResolver(sellerPaymentResolutionInputSchema),
    defaultValues: { outcome: 'paid', reason: '', externalRefundReference: '' },
  });
  const { reset } = mutation;
  useEffect(() => {
    return () => {
      confirmForm.reset();
      resolveForm.reset();
      reset();
    };
  }, [orderId, confirmForm, resolveForm, reset]);

  const submitConfirm = async (): Promise<boolean> => {
    let submitted = false;
    let succeeded = false;
    await confirmForm.handleSubmit(async (input) => {
      submitted = true;
      succeeded = await mutation.confirm(orderId, input.reason);
      if (succeeded) confirmForm.reset();
    })();
    return submitted && succeeded;
  };
  const submitResolve = async (): Promise<boolean> => {
    let submitted = false;
    let succeeded = false;
    await resolveForm.handleSubmit(async (input) => {
      submitted = true;
      succeeded = await mutation.resolve(
        orderId,
        input.outcome,
        input.reason,
        input.outcome === 'refunded' ? input.externalRefundReference : undefined,
      );
      if (succeeded) resolveForm.reset();
    })();
    return submitted && succeeded;
  };

  return {
    confirmForm,
    resolveForm,
    submitConfirm,
    submitResolve,
    isSubmitting: mutation.isSubmitting,
    error: mutation.error,
  };
}
