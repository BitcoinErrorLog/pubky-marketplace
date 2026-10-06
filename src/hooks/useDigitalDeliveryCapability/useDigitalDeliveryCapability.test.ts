import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useDigitalDeliveryCapability, useSellerAcceptsPaypal } from './useDigitalDeliveryCapability';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchDigitalDeliveryCapability: vi.fn(),
    getSellerPaymentConfig: vi.fn(),
  },
}));

const paymentConfig = (paypalAvailable: boolean) => ({
  bitcoinAvailable: true,
  bitcoinOfferAvailable: true,
  paypalAvailable,
});

beforeEach(() => {
  vi.mocked(CommerceController.fetchDigitalDeliveryCapability).mockReset();
  vi.mocked(CommerceController.getSellerPaymentConfig).mockReset();
  useAuthStore.setState({ currentUserPubky: null });
});

describe('useDigitalDeliveryCapability', () => {
  it('is null while loading, then the capability the service reports', async () => {
    vi.mocked(CommerceController.fetchDigitalDeliveryCapability).mockResolvedValue({
      available: true,
      maxBytes: 52_428_800,
    });
    const { result } = renderHook(() => useDigitalDeliveryCapability());

    expect(result.current).toBeNull();
    await waitFor(() => {
      expect(result.current).toEqual({ available: true, maxBytes: 52_428_800 });
    });
  });

  it('reads a failed /health read as unavailable', async () => {
    vi.mocked(CommerceController.fetchDigitalDeliveryCapability).mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useDigitalDeliveryCapability());

    await waitFor(() => {
      expect(result.current).toEqual({ available: false, maxBytes: null });
    });
  });
});

describe('useSellerAcceptsPaypal', () => {
  it('is false without a signed-in seller, and reads nothing', () => {
    const { result } = renderHook(() => useSellerAcceptsPaypal());

    expect(result.current).toBe(false);
    expect(CommerceController.getSellerPaymentConfig).not.toHaveBeenCalled();
  });

  it("follows the signed-in seller's PayPal rail", async () => {
    useAuthStore.setState({ currentUserPubky: 'seller_pubky' });
    vi.mocked(CommerceController.getSellerPaymentConfig).mockResolvedValue(paymentConfig(true));
    const { result } = renderHook(() => useSellerAcceptsPaypal());

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
    expect(CommerceController.getSellerPaymentConfig).toHaveBeenCalledWith('seller_pubky');
  });

  it('is false for a shop without PayPal and on a failed read', async () => {
    useAuthStore.setState({ currentUserPubky: 'seller_pubky' });
    vi.mocked(CommerceController.getSellerPaymentConfig).mockResolvedValueOnce(paymentConfig(false));
    const first = renderHook(() => useSellerAcceptsPaypal());
    await waitFor(() => {
      expect(CommerceController.getSellerPaymentConfig).toHaveBeenCalledTimes(1);
    });
    expect(first.result.current).toBe(false);

    vi.mocked(CommerceController.getSellerPaymentConfig).mockRejectedValueOnce(new TypeError('offline'));
    const second = renderHook(() => useSellerAcceptsPaypal());
    await waitFor(() => {
      expect(CommerceController.getSellerPaymentConfig).toHaveBeenCalledTimes(2);
    });
    expect(second.result.current).toBe(false);
  });
});
