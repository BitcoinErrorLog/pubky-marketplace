import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';
import { navigatesWithinGesture } from '@/test-utils/user-gesture';
import { useMarketplaceInventoryGrantConnect } from './useMarketplaceInventoryGrantConnect';

const navigation = vi.hoisted(() => ({ navigateTop: vi.fn() }));

vi.mock('@/libs/navigation/navigate-top', () => ({ navigateTop: navigation.navigateTop }));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: { beginInventorySessionConnect: vi.fn() },
}));

describe('useMarketplaceInventoryGrantConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ currentUserPubky: 'z'.repeat(52) });
  });

  it('hands the signer deeplink to the top window inside the tap, with no async boundary before it', () => {
    vi.mocked(CommerceController.beginInventorySessionConnect).mockReturnValue({
      authorizationUrl: 'pubkyauth:///?caps=inventory',
      awaitSession: () => new Promise(() => {}),
      cancel: vi.fn(),
    });
    const { result } = renderHook(() => useMarketplaceInventoryGrantConnect());
    act(() => result.current.start());

    expect(
      navigatesWithinGesture(navigation.navigateTop, 'pubkyauth:///?caps=inventory', () =>
        result.current.openInSigner(),
      ),
    ).toBe(true);
    expect(result.current.isOpeningSigner).toBe(true);
  });

  it('does nothing before a flow has produced a signer URL', () => {
    const { result } = renderHook(() => useMarketplaceInventoryGrantConnect());

    act(() => result.current.openInSigner());

    expect(navigation.navigateTop).not.toHaveBeenCalled();
  });
});
