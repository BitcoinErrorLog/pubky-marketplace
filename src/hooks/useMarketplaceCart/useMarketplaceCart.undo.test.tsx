import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarketplaceCart } from './useMarketplaceCart';

const state = vi.hoisted(() => ({
  pubky: 'buyer',
  items: [] as unknown[],
  toast: vi.fn(),
  getCartItems: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  restoreAward: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => state.items }));
vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({ useRequireAuth: () => ({ requireAuth: vi.fn() }) }));
vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: state.toast }));
vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: Object.assign((selector: (value: unknown) => unknown) => selector({ currentUserPubky: state.pubky }), {
    getState: () => ({ currentUserPubky: state.pubky }),
  }),
}));
vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    commitDeleteCartItem: state.remove,
    getCartItems: state.getCartItems,
    commitUpsertCartItem: state.restore,
    commitUpsertAwardCartItem: state.restoreAward,
  },
}));

const item = {
  id: 'seller:boots:large',
  listingId: 'seller:boots',
  variantId: 'large',
  quantity: 3,
  listing: {
    record: {
      title: 'Boots',
      ownerPubky: 'seller',
      variants: [],
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 1000, currency: 'USD', exponent: 2 } },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.pubky = 'buyer';
  state.items = [item];
  state.getCartItems.mockResolvedValue([]);
  state.remove.mockResolvedValue(undefined);
});

async function removeItem(awardId?: string, showUndo = true) {
  const { result } = renderHook(() => useMarketplaceCart());
  await act(() => result.current.remove(item.listingId, item.variantId, awardId, showUndo));
  return state.toast.mock.calls.at(-1)?.[0].action.props.onClick;
}

describe('cart removal undo', () => {
  it('restores the original quantity only once', async () => {
    const undo = await removeItem();
    await act(() => undo());
    await act(() => undo());
    expect(state.restore).toHaveBeenCalledExactlyOnceWith(item.listingId, item.variantId, 3);
  });

  it('preserves accepted offer metadata', async () => {
    state.items = [{ ...item, awardId: 'award', awardOfferRevision: 7 }];
    const undo = await removeItem('award');
    await act(() => undo());
    expect(state.restoreAward).toHaveBeenCalledExactlyOnceWith(item.listingId, item.variantId, 3, 'award', 7);
    expect(state.restore).not.toHaveBeenCalled();
  });

  it('does not overwrite an item already added again', async () => {
    const undo = await removeItem();
    state.getCartItems.mockResolvedValue([{ id: item.id }]);
    await act(() => undo());
    expect(state.restore).not.toHaveBeenCalled();
  });

  it('does not restore into a different account', async () => {
    const undo = await removeItem();
    state.pubky = 'other-buyer';
    await act(() => undo());
    expect(state.restore).not.toHaveBeenCalled();
  });

  it('keeps automatic checkout cleanup silent', async () => {
    await removeItem(undefined, false);
    expect(state.remove).toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });

  it('shows an error without offering undo when deletion fails', async () => {
    state.remove.mockRejectedValueOnce('unavailable');
    const { result } = renderHook(() => useMarketplaceCart());
    await act(() => result.current.remove(item.listingId, item.variantId));
    expect(state.toast).toHaveBeenCalledWith({ variant: 'error', description: 'Could not remove this item.' });
    expect(state.restore).not.toHaveBeenCalled();
  });
});
