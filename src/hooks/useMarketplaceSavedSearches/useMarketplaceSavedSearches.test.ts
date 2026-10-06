import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { toast } from '@/molecules/Toaster/use-toast';
import { useMarketplaceSavedSearches } from './useMarketplaceSavedSearches';

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => [] }));
vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    COMMERCE_SAVED_SEARCH_CHECK_MAX: 10,
    COMMERCE_WATCH_CHECK_MIN_INTERVAL_MS: 60_000,
    getCommerceAdapterMode: () => 'sandbox',
  };
});
vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'b'.repeat(52) }),
}));
vi.mock('@/stores/commerce/commerce.store', () => ({
  useCommerceStore: {
    getState: () => ({
      query: '',
      categoryId: null,
      saleFormat: 'all',
      conditions: [],
      minimumPriceMinor: null,
      maximumPriceMinor: null,
      countryCode: null,
      sort: 'newest',
    }),
  },
}));
vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getSavedSearches: vi.fn(async () => []),
    getAllListings: vi.fn(async () => []),
    getAllCatalogEntries: vi.fn(async () => []),
    commitCreateSavedSearch: vi.fn(),
    commitDeleteSavedSearch: vi.fn(),
    fetchCatalogListings: vi.fn(async () => []),
    recordSavedSearchCheck: vi.fn(),
  },
}));
vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

const appError = () =>
  new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.CONFLICT,
    message: 'SENTINEL_SAVED_SEARCH',
    service: ErrorService.Marketplace,
    operation: 'saveSearch',
  });

describe('useMarketplaceSavedSearches', () => {
  it('uses static copy when saving a search fails', async () => {
    vi.mocked(CommerceController.getAllListings).mockRejectedValueOnce(appError());
    const { result } = renderHook(() => useMarketplaceSavedSearches());

    let saved = true;
    await act(async () => {
      saved = await result.current.saveCurrentSearch('boots');
    });
    const description = vi.mocked(toast).mock.calls.at(-1)?.[0]?.description;
    expect(saved).toBe(false);
    expect(description).toBeTypeOf('string');
    expect(description).not.toContain('SENTINEL_SAVED_SEARCH');
  });
});
