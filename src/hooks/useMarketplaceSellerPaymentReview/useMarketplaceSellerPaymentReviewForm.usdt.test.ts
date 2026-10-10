import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USDT_RESOLVE_TX_HASH } from '@/test/fixtures/commerce/usdt-payment-review.wire';
import { useMarketplaceSellerPaymentReviewForm } from './useMarketplaceSellerPaymentReviewForm';

const mutation = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  resolve: vi.fn(async () => true),
  reset: vi.fn(),
  isSubmitting: false,
  error: null as string | null,
}));
const mutationRail = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock('./useMarketplaceSellerPaymentReview', () => ({
  useMarketplaceSellerPaymentReview: (_onChanged: unknown, rail: unknown) => {
    mutationRail.calls.push(rail);
    return mutation;
  },
}));

describe('useMarketplaceSellerPaymentReviewForm on the USDT rail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationRail.calls = [];
  });

  it('hands the rail to the mutation and defaults to Bitcoin', () => {
    renderHook(() => useMarketplaceSellerPaymentReviewForm('order-1', () => {}, 'usdt'));
    renderHook(() => useMarketplaceSellerPaymentReviewForm('order-1', () => {}));

    expect(mutationRail.calls).toContain('usdt');
    expect(mutationRail.calls).toContain('bitcoin');
  });

  it.each(['', 'tx-contract-refund', `0x${'a'.repeat(63)}`])(
    'rejects a refund reference that is not a transaction hash: %s',
    async (reference) => {
      const { result } = renderHook(() => useMarketplaceSellerPaymentReviewForm('order-1', () => {}, 'usdt'));
      await act(async () => {
        result.current.resolveForm.setValue('outcome', 'refunded');
        result.current.resolveForm.setValue('externalRefundReference', reference);
        await result.current.submitResolve();
      });

      expect(mutation.resolve).not.toHaveBeenCalled();
      expect(result.current.resolveForm.getFieldState('externalRefundReference').error?.message).toBeTruthy();
    },
  );

  it('submits a refund with the hash in lowercase', async () => {
    const { result } = renderHook(() => useMarketplaceSellerPaymentReviewForm('order-1', () => {}, 'usdt'));
    await act(async () => {
      result.current.resolveForm.setValue('outcome', 'refunded');
      result.current.resolveForm.setValue('externalRefundReference', `  0x${'CD34'.repeat(16)}`);
      await result.current.submitResolve();
    });

    expect(mutation.resolve).toHaveBeenCalledWith('order-1', 'refunded', '', USDT_RESOLVE_TX_HASH);
  });

  it('submits paid without a reference', async () => {
    const { result } = renderHook(() => useMarketplaceSellerPaymentReviewForm('order-1', () => {}, 'usdt'));
    await act(async () => {
      await result.current.submitResolve();
    });

    expect(mutation.resolve).toHaveBeenCalledWith('order-1', 'paid', '', undefined);
  });
});
