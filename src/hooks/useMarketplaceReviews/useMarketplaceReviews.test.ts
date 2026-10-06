import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceReviews } from './useMarketplaceReviews';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchSellerReviews: vi.fn(),
    fetchListingReviews: vi.fn(),
  },
}));

const SELLER = 'y'.repeat(52);

describe('useMarketplaceReviews', () => {
  beforeEach(() => {
    vi.mocked(CommerceController.fetchSellerReviews).mockResolvedValue({ status: 'ok', reviews: [] });
  });

  it('does not return a refresh action — no caller in this workspace used it', async () => {
    const { result } = renderHook(() => useMarketplaceReviews({ sellerPubky: SELLER }));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current).not.toHaveProperty('refresh');
    expect(Object.keys(result.current).sort()).toEqual(['hasMore', 'isFetching', 'loadMore', 'reviews', 'status']);
  });
});
