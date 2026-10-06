'use client';

import { ToastAction } from '@/atoms/Toast/Toast';
import {
  isReaderWalletSetupNeeded,
  marketplacePaymentMethodFailureMessage,
  READER_WALLET_SETUP_COPY,
} from '@/libs/commerce/failure-messages';
import { toast } from '@/molecules/Toaster/use-toast';

/** Long enough to finish wallet setup on the phone and come back to try again. */
export const READER_WALLET_SETUP_TOAST_MS = 60_000;

/**
 * Error toast for a refused payment-method bind. The wallet-setup refusal
 * gets its own title and a Try again action that re-runs the caller's step
 * on the buyer's click. Nothing retries on its own.
 */
export function showPaymentMethodRefusalToast({
  error,
  fallback,
  title,
  onRetry,
}: {
  error: unknown;
  fallback: string;
  title?: string;
  onRetry?: () => void;
}): void {
  if (isReaderWalletSetupNeeded(error)) {
    toast({
      variant: 'error',
      title: READER_WALLET_SETUP_COPY.title,
      description: READER_WALLET_SETUP_COPY.description,
      duration: READER_WALLET_SETUP_TOAST_MS,
      dismissButton: true,
      ...(onRetry
        ? {
            action: (
              <ToastAction altText={READER_WALLET_SETUP_COPY.retry} onClick={onRetry}>
                {READER_WALLET_SETUP_COPY.retry}
              </ToastAction>
            ),
          }
        : {}),
    });
    return;
  }
  toast({
    variant: 'error',
    ...(title ? { title } : {}),
    description: marketplacePaymentMethodFailureMessage(error, fallback),
  });
}
