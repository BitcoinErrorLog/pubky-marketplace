import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { marketplaceOrderSchema } from '@/core/services/marketplace/marketplace-projections';
import resolveSamples from '@/libs/commerce/contracts/samples/resolve.json';
import { sellerPaymentResolutionSchema } from '@/libs/commerce/marketplace-payment-review';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { useMarketplaceSellerPaymentReview } from './useMarketplaceSellerPaymentReview';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    confirmBitcoinPayment: vi.fn(),
    resolveBitcoinPayment: vi.fn(),
  },
}));

describe('useMarketplaceSellerPaymentReview', () => {
  beforeEach(() => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockReset();
  });

  it('reuses an idempotency key only for the same order and body', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(resolveSuccessResponse());
    const onChanged = vi.fn();
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(onChanged));

    await act(() => result.current.resolve('order-1', 'paid', ' checked '));
    await act(() => result.current.resolve('order-1', 'paid', 'checked'));
    await act(() => result.current.resolve('order-2', 'paid', 'checked'));
    await act(() => result.current.resolve('order-2', 'refunded', 'checked', 'refund-1'));

    const calls = vi.mocked(CommerceController.resolveBitcoinPayment).mock.calls;
    expect(calls[0]?.[2]).toBe(calls[1]?.[2]);
    expect(calls[1]?.[2]).not.toBe(calls[2]?.[2]);
    expect(calls[2]?.[2]).not.toBe(calls[3]?.[2]);
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  it('clears the stale intent before one conflict refresh', async () => {
    const conflict = Err.client(ClientErrorCode.CONFLICT, 'static', {
      service: ErrorService.Marketplace,
      operation: 'resolveBitcoinPayment',
    });
    vi.mocked(CommerceController.resolveBitcoinPayment)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue(resolveSuccessResponse());
    const onChanged = vi.fn();
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(onChanged));

    await act(() => result.current.resolve('order-1', 'paid'));
    await act(() => result.current.resolve('order-1', 'paid'));

    const calls = vi.mocked(CommerceController.resolveBitcoinPayment).mock.calls;
    expect(calls[0]?.[2]).not.toBe(calls[1]?.[2]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('disables duplicate resolution while the unchanged intent is in flight', async () => {
    let release!: () => void;
    vi.mocked(CommerceController.resolveBitcoinPayment).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(resolveSuccessResponse());
        }),
    );
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(() => {}));
    const first = result.current.resolve('order-1', 'paid');
    await waitFor(() => expect(result.current.isSubmitting).toBe(true));
    await act(async () => {
      expect(await result.current.resolve('order-1', 'paid')).toBe(false);
    });
    release();
    await act(() => first);
    expect(CommerceController.resolveBitcoinPayment).toHaveBeenCalledTimes(1);
  });
});

function resolveSuccessResponse() {
  const replacements: Record<string, string> = {
    '<uuid:1>': '018f47d2-6a27-7c23-a49d-000000000001',
    '<uuid:2>': '018f47d2-6a27-7c23-a49d-000000000002',
    '<uuid:3>': '018f47d2-6a27-7c23-a49d-000000000003',
    '<pubky:buyer>': 'b'.repeat(52),
    '<pubky:seller>': 's'.repeat(52),
    '<timestamp:1>': '2026-08-20T20:00:00.000Z',
    '<paykit-reference:1>': 'paykit-reference-1',
  };
  const response = toCamelCaseWire(
    JSON.parse(
      JSON.stringify(resolveSamples.abandoned.response.body, (_key, value: unknown) =>
        typeof value === 'string' ? (replacements[value] ?? value) : value,
      ),
    ),
  );
  if (response === null || Array.isArray(response) || typeof response !== 'object') {
    throw new Error('Resolve fixture response must be an object.');
  }
  return {
    order: marketplaceOrderSchema.parse(response.order),
    resolution: sellerPaymentResolutionSchema.parse(response.resolution),
  };
}
