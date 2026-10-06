import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarketplaceSellerSummary } from './useMarketplaceSellerSummary';

const fetchSellerReputation = vi.hoisted(() => vi.fn());

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => unknown) => querier(),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getShop: () => null,
    fetchSellerReputation: (...args: unknown[]) => fetchSellerReputation(...args),
  },
}));

describe('useMarketplaceSellerSummary', () => {
  beforeEach(() => {
    fetchSellerReputation.mockReset();
    fetchSellerReputation.mockResolvedValue({ status: 'new_seller' });
  });

  it('fetches reputation by default', async () => {
    const seller = 's'.repeat(52);
    renderHook(() => useMarketplaceSellerSummary(seller));

    await waitFor(() => {
      expect(fetchSellerReputation).toHaveBeenCalledWith(seller);
    });
  });

  it('skips the reputation fetch when includeReputation is false', async () => {
    const seller = 's'.repeat(52);
    const { result } = renderHook(() => useMarketplaceSellerSummary(seller, { includeReputation: false }));

    await waitFor(() => {
      expect(result.current.reputation).toEqual({ status: 'unavailable' });
    });
    expect(fetchSellerReputation).not.toHaveBeenCalled();
  });
});
