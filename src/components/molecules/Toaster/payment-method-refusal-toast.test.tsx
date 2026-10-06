import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { READER_WALLET_SETUP_TOAST_MS, showPaymentMethodRefusalToast } from './payment-method-refusal-toast';
import { Toaster } from './Toaster';
import { useToast } from './use-toast';

const refusal = (reason: string) =>
  new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.BAD_REQUEST,
    message: 'SENTINEL',
    service: ErrorService.Marketplace,
    operation: 'bindPaymentMethod',
    context: { statusCode: 409, reason, serviceCode: 'INVALID_STATE' },
  });

function Harness() {
  const { dismiss } = useToast();
  return (
    <>
      <button type="button" onClick={() => dismiss()}>
        reset
      </button>
      <Toaster />
    </>
  );
}

describe('showPaymentMethodRefusalToast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows Reader wallet setup needed with a Try again action that runs only on click', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<Harness />);

    act(() => {
      showPaymentMethodRefusalToast({ error: refusal('buyer_paykit_wallet_setup_needed'), fallback: 'x', onRetry });
    });

    expect(screen.getByText('Reader wallet setup needed')).toBeInTheDocument();
    expect(
      screen.getByText('Finish setting up Bitkit (or another Paykit wallet) for this pubky, then try again.'),
    ).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(READER_WALLET_SETUP_TOAST_MS - 1_000);
    });
    expect(onRetry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
  });

  it('keeps other refusals as a plain mapped toast with no action', () => {
    render(<Harness />);

    act(() => {
      showPaymentMethodRefusalToast({
        error: refusal('buyer_paykit_wallet_required'),
        fallback: 'x',
        title: 'Payment action failed',
        onRetry: vi.fn(),
      });
    });

    expect(screen.getByText('Payment action failed')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Connect Bitkit to pay with Bitcoin: this account has no Paykit wallet that can receive a payment request.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
  });
});
