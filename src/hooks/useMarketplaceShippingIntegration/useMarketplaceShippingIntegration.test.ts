import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { toast } from '@/molecules/Toaster/use-toast';
import { useMarketplaceShippingIntegration } from './useMarketplaceShippingIntegration';

vi.mock('@/config/commerce', () => ({
  getCommerceAdapterMode: () => 'transaction-service',
  isDurableCommerceMode: () => true,
}));
vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 's'.repeat(52) }),
}));
vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMyShippingConfig: vi.fn(async () => null),
    putMyShippingConfig: vi.fn(),
  },
}));
vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/libs/logger/logger', () => ({ Logger: { error: vi.fn(), warn: vi.fn() } }));

describe('useMarketplaceShippingIntegration', () => {
  it('uses static copy when saving shipping settings fails', async () => {
    vi.mocked(CommerceController.putMyShippingConfig).mockRejectedValueOnce(
      new AppError({
        category: ErrorCategory.Client,
        code: ClientErrorCode.CONFLICT,
        message: 'SENTINEL_SHIPPING_SETTINGS',
        service: ErrorService.Marketplace,
        operation: 'saveShipping',
      }),
    );
    const { result } = renderHook(() => useMarketplaceShippingIntegration());

    let saved = true;
    await act(async () => {
      saved = await result.current.save({ shippoApiKey: 'shippo_test', shipFrom: null });
    });
    const description = vi.mocked(toast).mock.calls.at(-1)?.[0]?.description;
    expect(saved).toBe(false);
    expect(description).toBeTypeOf('string');
    expect(description).not.toContain('SENTINEL_SHIPPING_SETTINGS');
  });
});
