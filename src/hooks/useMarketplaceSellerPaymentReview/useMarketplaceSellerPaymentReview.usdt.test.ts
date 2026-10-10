import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { USDT_RESOLVE_TX_HASH } from '@/test/fixtures/commerce/usdt-payment-review.wire';
import { useMarketplaceSellerPaymentReview } from './useMarketplaceSellerPaymentReview';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    confirmBitcoinPayment: vi.fn(),
    resolveBitcoinPayment: vi.fn(),
  },
}));

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/molecules/Toaster/use-toast', () => ({ toast }));

const HASH_COPY = 'Enter the Arbitrum transaction hash (0x followed by 64 characters).';

function refusal(code: ClientErrorCode, reason: string) {
  return Err.client(code, 'static', {
    service: ErrorService.Marketplace,
    operation: 'resolveBitcoinPayment',
    context: { statusCode: 422, reason },
  });
}

describe('useMarketplaceSellerPaymentReview on the USDT rail', () => {
  beforeEach(() => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockReset();
    toast.mockReset();
  });

  it('sends the lowercase Arbitrum transaction hash through the shared resolve call', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockResolvedValue({} as never);
    const onChanged = vi.fn();
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(onChanged, 'usdt'));

    await act(async () => {
      expect(
        await result.current.resolve(
          'order-1',
          'refunded',
          ' returned ',
          ` ${USDT_RESOLVE_TX_HASH.toUpperCase().replace('0X', '0x')} `,
        ),
      ).toBe(true);
    });

    expect(CommerceController.resolveBitcoinPayment).toHaveBeenCalledWith(
      'order-1',
      { outcome: 'refunded', reason: 'returned', externalRefundReference: USDT_RESOLVE_TX_HASH },
      expect.any(String),
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a Bitcoin-style reference', 'tx-contract-refund'],
    ['a hash without 0x', 'a'.repeat(64)],
  ])('refuses %s before any request and says why in USDT terms', async (_label, reference) => {
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(() => {}, 'usdt'));

    await act(async () => {
      expect(await result.current.resolve('order-1', 'refunded', undefined, reference)).toBe(false);
    });

    expect(CommerceController.resolveBitcoinPayment).not.toHaveBeenCalled();
    expect(result.current.error).toBe(HASH_COPY);
    expect(toast).toHaveBeenCalledWith({ variant: 'error', description: HASH_COPY });
  });

  it('resolves paid and abandoned with no reference', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockResolvedValue({} as never);
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(() => {}, 'usdt'));

    await act(() => result.current.resolve('order-1', 'paid'));
    await act(() => result.current.resolve('order-2', 'abandoned', 'gone'));

    const calls = vi.mocked(CommerceController.resolveBitcoinPayment).mock.calls;
    expect(calls[0]?.[1]).toEqual({ outcome: 'paid', reason: undefined, externalRefundReference: undefined });
    expect(calls[1]?.[1]).toEqual({ outcome: 'abandoned', reason: 'gone', externalRefundReference: undefined });
  });

  it('reads the service reference refusal as a transaction hash requirement', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockRejectedValue(
      refusal(ClientErrorCode.BAD_REQUEST, 'invalid_refund_reference'),
    );
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(() => {}, 'usdt'));

    await act(() => result.current.resolve('order-1', 'refunded', undefined, USDT_RESOLVE_TX_HASH));

    expect(result.current.error).toBe(HASH_COPY);
  });

  it('asks for the buyer refund address, then reloads the order, when none is confirmed', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockRejectedValue(
      refusal(ClientErrorCode.CONFLICT, 'refund_destination_required'),
    );
    const onChanged = vi.fn();
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(onChanged, 'usdt'));

    await act(() => result.current.resolve('order-1', 'refunded', undefined, USDT_RESOLVE_TX_HASH));

    expect(result.current.error).toBe("Ask the buyer to confirm a refund address first. It's on their order page.");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps every other refusal in its shared copy', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockRejectedValue(
      refusal(ClientErrorCode.CONFLICT, 'already_resolved'),
    );
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(() => {}, 'usdt'));

    await act(() => result.current.resolve('order-1', 'paid'));

    expect(result.current.error).toBe('This payment was already resolved. The latest order state was reloaded.');
  });
});

describe('useMarketplaceSellerPaymentReview on the Bitcoin rail (default)', () => {
  beforeEach(() => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockReset();
  });

  it('still takes a short reference and refuses a transaction hash', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockResolvedValue({} as never);
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(() => {}));

    await act(async () => {
      expect(await result.current.resolve('order-1', 'refunded', undefined, 'tx-1')).toBe(true);
      expect(await result.current.resolve('order-1', 'refunded', undefined, USDT_RESOLVE_TX_HASH)).toBe(false);
    });

    expect(CommerceController.resolveBitcoinPayment).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe('Enter a printable ASCII refund reference from 1 to 64 characters.');
  });

  it('keeps the Bitcoin reference refusal copy', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockRejectedValue(
      refusal(ClientErrorCode.BAD_REQUEST, 'invalid_refund_reference'),
    );
    const { result } = renderHook(() => useMarketplaceSellerPaymentReview(() => {}));

    await act(() => result.current.resolve('order-1', 'refunded', undefined, 'tx-1'));

    expect(result.current.error).toBe('The external refund reference is not valid.');
  });
});
