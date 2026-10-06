import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useSellerPaymentMethodGate } from './useSellerPaymentMethodGate';

const OWNER = 'y'.repeat(52);
const authState = vi.hoisted(() => ({ currentUserPubky: 'y'.repeat(52) as string | null }));
const commerceMode = vi.hoisted(() => ({ mode: 'transaction-service' as 'sandbox' | 'transaction-service' }));

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return {
    ...actual,
    getCommerceAdapterMode: () => commerceMode.mode,
  };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string | null }) => unknown) => selector(authState),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getSellerPaymentConfig: vi.fn(),
  },
}));

describe('useSellerPaymentMethodGate', () => {
  beforeEach(() => {
    authState.currentUserPubky = OWNER;
    commerceMode.mode = 'transaction-service';
    vi.mocked(CommerceController.getSellerPaymentConfig).mockReset();
  });

  it('skips the lookup in sandbox mode', () => {
    commerceMode.mode = 'sandbox';
    const { result } = renderHook(() => useSellerPaymentMethodGate());

    expect(result.current).toEqual({ isDurable: false, ready: true, reason: null });
    expect(CommerceController.getSellerPaymentConfig).not.toHaveBeenCalled();
  });

  it('reports no-method when the seller has no buyer-payable rail', async () => {
    vi.mocked(CommerceController.getSellerPaymentConfig).mockResolvedValue({
      bitcoinAvailable: false,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    });

    const { result } = renderHook(() => useSellerPaymentMethodGate());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ isDurable: true, ready: true, reason: 'no-method' });
  });

  it('clears the gate when a payable method is configured', async () => {
    vi.mocked(CommerceController.getSellerPaymentConfig).mockResolvedValue({
      bitcoinAvailable: true,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    });

    const { result } = renderHook(() => useSellerPaymentMethodGate());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.reason).toBeNull();
  });
});
