import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { useMarketplaceDropEdition } from './useMarketplaceDropEdition';

const SELLER = 's'.repeat(52);

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getPublicDrop: vi.fn(),
  },
}));

function makeOrder(overrides: Partial<MarketplaceOrder> = {}): MarketplaceOrder {
  return {
    id: '018f47d2-6a27-7c23-a49d-000000000001',
    state: 'paid',
    ...overrides,
  } as MarketplaceOrder;
}

describe('useMarketplaceDropEdition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CommerceController.getPublicDrop).mockResolvedValue({ totalQuantity: 100 } as never);
  });

  it('exposes the edition from the order projection and the drop size from the public drop', async () => {
    const { result } = renderHook(() =>
      useMarketplaceDropEdition(makeOrder({ edition: 7, dropAggregateId: `drop:${SELLER}_drop1` })),
    );
    expect(result.current.edition).toBe(7);
    await waitFor(() => expect(result.current.of).toBe(100));
    expect(CommerceController.getPublicDrop).toHaveBeenCalledWith(SELLER, 'drop1');
  });

  it('renders nothing for non-drop orders — no fetch, no guess', () => {
    const { result } = renderHook(() => useMarketplaceDropEdition(makeOrder()));
    expect(result.current.edition).toBeNull();
    expect(result.current.of).toBeNull();
    expect(CommerceController.getPublicDrop).not.toHaveBeenCalled();
  });

  it('keeps "of" absent when the drop read fails — the edition alone still renders', async () => {
    vi.mocked(CommerceController.getPublicDrop).mockRejectedValue(new Error('down'));
    const { result } = renderHook(() =>
      useMarketplaceDropEdition(makeOrder({ edition: 7, dropAggregateId: `drop:${SELLER}_drop1` })),
    );
    expect(result.current.edition).toBe(7);
    await waitFor(() => expect(CommerceController.getPublicDrop).toHaveBeenCalled());
    expect(result.current.of).toBeNull();
  });
});
