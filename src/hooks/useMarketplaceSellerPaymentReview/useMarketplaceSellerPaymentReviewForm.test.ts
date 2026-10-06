import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarketplaceSellerPaymentReviewForm } from './useMarketplaceSellerPaymentReviewForm';

const mutation = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  resolve: vi.fn(async () => true),
  reset: vi.fn(),
  isSubmitting: false,
  error: null as string | null,
}));

vi.mock('./useMarketplaceSellerPaymentReview', () => ({
  useMarketplaceSellerPaymentReview: () => mutation,
}));

describe('useMarketplaceSellerPaymentReviewForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects oversized reasons before mutation and focuses the invalid field', async () => {
    const { result } = renderHook(() => useMarketplaceSellerPaymentReviewForm('order-1', () => {}));
    await act(async () => {
      result.current.confirmForm.setValue('reason', 'x'.repeat(501));
      await result.current.submitConfirm();
    });

    expect(mutation.confirm).not.toHaveBeenCalled();
    expect(result.current.confirmForm.getFieldState('reason').error?.message).toContain('500');
  });

  it.each([
    ['', 'A refund reference is required.'],
    ['é', 'Invalid string: must match pattern /^[\\x20-\\x7E]{1,64}$/'],
    ['x'.repeat(65), 'Invalid string: must match pattern /^[\\x20-\\x7E]{1,64}$/'],
  ])('rejects invalid refund references: %s', async (reference) => {
    const { result } = renderHook(() => useMarketplaceSellerPaymentReviewForm('order-1', () => {}));
    await act(async () => {
      result.current.resolveForm.setValue('outcome', 'refunded');
      result.current.resolveForm.setValue('externalRefundReference', reference);
      await result.current.submitResolve();
    });

    expect(mutation.resolve).not.toHaveBeenCalled();
    expect(result.current.resolveForm.getFieldState('externalRefundReference').error?.message).toBeTruthy();
  });

  it('excludes a refund reference for non-refund outcomes', async () => {
    const { result } = renderHook(() => useMarketplaceSellerPaymentReviewForm('order-1', () => {}));
    await act(async () => {
      result.current.resolveForm.setValue('outcome', 'paid');
      result.current.resolveForm.setValue('externalRefundReference', '');
      await result.current.submitResolve();
    });

    expect(mutation.resolve).toHaveBeenCalledWith('order-1', 'paid', '', undefined);
  });
});
