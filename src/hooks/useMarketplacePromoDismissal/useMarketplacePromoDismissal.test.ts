import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFeatureDiscoveryStorageKey, MARKETPLACE_PROMO_STORAGE_ID } from '@/config/featureDiscovery';
import { useMarketplacePromoDismissal } from './useMarketplacePromoDismissal';

const mocks = vi.hoisted(() => ({
  currentUserPubky: 'pk:test-user-pubky' as string | null,
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: vi.fn((selector: (state: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: mocks.currentUserPubky }),
  ),
}));

describe('useMarketplacePromoDismissal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.currentUserPubky = 'pk:test-user-pubky';
  });

  it('shows the promo for authenticated users who have not dismissed it', async () => {
    const { result } = renderHook(() => useMarketplacePromoDismissal());

    await waitFor(() => {
      expect(result.current.showPromo).toBe(true);
    });
  });

  it('shows the promo for guests', async () => {
    mocks.currentUserPubky = null;

    const { result } = renderHook(() => useMarketplacePromoDismissal());

    await waitFor(() => {
      expect(result.current.showPromo).toBe(true);
    });
  });

  it('hides the promo when a prior dismissal is persisted for the account', async () => {
    window.localStorage.setItem(
      buildFeatureDiscoveryStorageKey('pk:test-user-pubky', MARKETPLACE_PROMO_STORAGE_ID),
      'dismissed',
    );

    const { result } = renderHook(() => useMarketplacePromoDismissal());

    await waitFor(() => {
      expect(result.current.showPromo).toBe(false);
    });
  });

  it('persists dismissal in per-account localStorage and hides the promo', async () => {
    const { result, rerender } = renderHook(() => useMarketplacePromoDismissal());

    await waitFor(() => {
      expect(result.current.showPromo).toBe(true);
    });

    act(() => result.current.dismissPromo());

    expect(
      window.localStorage.getItem(buildFeatureDiscoveryStorageKey('pk:test-user-pubky', MARKETPLACE_PROMO_STORAGE_ID)),
    ).toBe('dismissed');
    expect(result.current.showPromo).toBe(false);

    rerender();

    act(() => result.current.dismissPromo());

    expect(window.localStorage.length).toBe(1);
  });

  it('dismisses in-memory only for guests without writing to localStorage', async () => {
    mocks.currentUserPubky = null;

    const { result } = renderHook(() => useMarketplacePromoDismissal());

    await waitFor(() => {
      expect(result.current.showPromo).toBe(true);
    });

    act(() => result.current.dismissPromo());

    expect(result.current.showPromo).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it('does not reuse dismissal while switching users in the same tab', async () => {
    const { result, rerender } = renderHook(() => useMarketplacePromoDismissal());

    await waitFor(() => {
      expect(result.current.showPromo).toBe(true);
    });

    act(() => result.current.dismissPromo());
    expect(result.current.showPromo).toBe(false);

    mocks.currentUserPubky = 'pk:second-user';
    rerender();

    await waitFor(() => {
      expect(result.current.showPromo).toBe(true);
    });

    expect(
      window.localStorage.getItem(buildFeatureDiscoveryStorageKey('pk:second-user', MARKETPLACE_PROMO_STORAGE_ID)),
    ).toBeNull();
  });
});
