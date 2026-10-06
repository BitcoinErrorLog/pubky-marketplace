import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useCommerceShopFollow } from './useCommerceShopFollow';

const state = vi.hoisted(() => ({
  currentUserPubky: 'y'.repeat(52) as string | null,
  following: false,
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (query: () => unknown) => query(),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (store: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: state.currentUserPubky }),
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({
    requireAuth: (action: () => unknown) => (state.currentUserPubky ? action() : undefined),
  }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    isShopFollowed: vi.fn(() => state.following),
    commitCreateShopFollow: vi.fn(),
    commitDeleteShopFollow: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

describe('useCommerceShopFollow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentUserPubky = 'y'.repeat(52);
    state.following = false;
  });

  it('creates and removes a persistent shop follow from live state', async () => {
    const { result, rerender } = renderHook(() => useCommerceShopFollow('b'.repeat(52)));

    await act(() => result.current.toggle());
    expect(CommerceController.commitCreateShopFollow).toHaveBeenCalledOnce();

    state.following = true;
    rerender();
    expect(result.current.isFollowing).toBe(true);

    await act(() => result.current.toggle());
    expect(CommerceController.commitDeleteShopFollow).toHaveBeenCalledOnce();
  });
});
