import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode, ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { toast } from '@/molecules/Toaster/use-toast';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { useMarketplaceSellerPaymentConfig } from './useMarketplaceSellerPaymentConfig';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMyPaymentConfig: vi.fn(),
    isOwnPaykitAccountClaimed: vi.fn(),
    putMyPaymentConfig: vi.fn(),
  },
}));
vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/libs/logger/logger', () => ({ Logger: { error: vi.fn(), warn: vi.fn() } }));

const error = (operation: string) =>
  new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.CONFLICT,
    message: `SENTINEL_SELLER_PAYMENT_${operation}`,
    service: ErrorService.Marketplace,
    operation,
  });

const config = {
  bitcoinEnabled: true,
  stripePaymentLink: null,
  stripeRestrictedKeySet: false,
  paypalMerchantEmail: null,
  updatedAt: '2026-09-09T00:00:00.000Z',
};

describe('useMarketplaceSellerPaymentConfig', () => {
  it('uses static copy for configuration load and save failures', async () => {
    vi.mocked(CommerceController.getMyPaymentConfig).mockRejectedValueOnce(error('load'));
    vi.mocked(CommerceController.isOwnPaykitAccountClaimed).mockResolvedValueOnce(false);
    const { result } = renderHook(() => useMarketplaceSellerPaymentConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toBeTruthy();
    expect(result.current.loadError).not.toContain('SENTINEL_SELLER_PAYMENT_load');

    vi.mocked(CommerceController.putMyPaymentConfig).mockRejectedValueOnce(error('save'));
    await act(async () => {
      await result.current.save({
        bitcoinEnabled: true,
        stripePaymentLink: '',
        stripeRestrictedKey: '',
        paypalMerchantEmail: '',
      });
    });
    const saveDescription = vi.mocked(toast).mock.calls.at(-1)?.[0]?.description;
    expect(saveDescription).toBeTypeOf('string');
    expect(saveDescription).not.toContain('SENTINEL_SELLER_PAYMENT_save');
  });

  it('refetches payment config and claim state when the marketplace session becomes active', async () => {
    const sessionError = new AppError({
      category: ErrorCategory.Auth,
      code: AuthErrorCode.SESSION_EXPIRED,
      message: 'Connect a marketplace session to continue.',
      service: ErrorService.Marketplace,
      operation: 'getMyPaymentConfig',
    });
    useCommerceStore.setState({ marketplaceSession: null });
    vi.mocked(CommerceController.getMyPaymentConfig).mockRejectedValueOnce(sessionError).mockResolvedValueOnce(config);
    vi.mocked(CommerceController.isOwnPaykitAccountClaimed)
      .mockRejectedValueOnce(sessionError)
      .mockResolvedValueOnce(true);

    const { result } = renderHook(() => useMarketplaceSellerPaymentConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toBe('Your marketplace session expired. Reconnect and try again.');

    await act(async () => {
      useCommerceStore.getState().setMarketplaceSession({
        pubky: 'y'.repeat(52),
        capabilities: '/pub/pubky.app/:rw',
        expiresAt: '2026-09-21T12:00:00.000Z',
        issuedAt: '2026-09-13T12:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(result.current.config).toEqual(config);
      expect(result.current.accountClaimed).toBe(true);
      expect(result.current.loadError).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });
    expect(CommerceController.getMyPaymentConfig).toHaveBeenCalledTimes(2);
    expect(CommerceController.isOwnPaykitAccountClaimed).toHaveBeenCalledTimes(2);
    useCommerceStore.getState().reset();
  });

  it('uses static copy for Stripe removal failures', async () => {
    vi.mocked(CommerceController.getMyPaymentConfig).mockResolvedValue(config);
    vi.mocked(CommerceController.isOwnPaykitAccountClaimed).mockResolvedValue(false);
    vi.mocked(CommerceController.putMyPaymentConfig).mockRejectedValueOnce(error('remove'));
    const { result } = renderHook(() => useMarketplaceSellerPaymentConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());

    await act(async () => {
      await result.current.clearStripeKey();
    });
    expect(vi.mocked(toast).mock.calls.at(-1)?.[0]?.description).not.toContain('SENTINEL_SELLER_PAYMENT_remove');
    expect(result.current).not.toHaveProperty('startClaim');
  });
});
