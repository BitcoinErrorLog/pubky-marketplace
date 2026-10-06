import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarkMarketplaceOrdersSeen } from './useMarkMarketplaceOrdersSeen';

const state = vi.hoisted(() => ({ currentUserPubky: 'o'.repeat(52) as string | null }));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (store: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: state.currentUserPubky }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: { markOrdersAttentionSeen: vi.fn() },
}));

describe('useMarkMarketplaceOrdersSeen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentUserPubky = 'o'.repeat(52);
    vi.mocked(CommerceController.markOrdersAttentionSeen).mockResolvedValue();
  });

  it('saves the account checkpoint once orders are on screen', async () => {
    const { rerender } = renderHook(({ showing }) => useMarkMarketplaceOrdersSeen(showing), {
      initialProps: { showing: false },
    });
    expect(CommerceController.markOrdersAttentionSeen).not.toHaveBeenCalled();

    rerender({ showing: true });

    await waitFor(() => expect(CommerceController.markOrdersAttentionSeen).toHaveBeenCalledOnce());
  });

  it('does nothing when signed out', async () => {
    state.currentUserPubky = null;
    renderHook(() => useMarkMarketplaceOrdersSeen(true));
    await Promise.resolve();
    expect(CommerceController.markOrdersAttentionSeen).not.toHaveBeenCalled();
  });

  it('treats a controller that throws before returning a promise as a failed write, not a render error', async () => {
    vi.mocked(CommerceController.markOrdersAttentionSeen).mockImplementation(() => {
      throw new TypeError('CommerceController.markOrdersAttentionSeen is not a function');
    });

    expect(() => renderHook(() => useMarkMarketplaceOrdersSeen(true))).not.toThrow();
    await waitFor(() => expect(CommerceController.markOrdersAttentionSeen).toHaveBeenCalled());
  });

  it('saves again when the tab comes back into view, and not while it is hidden', async () => {
    renderHook(() => useMarkMarketplaceOrdersSeen(true));
    await waitFor(() => expect(CommerceController.markOrdersAttentionSeen).toHaveBeenCalledOnce());

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(CommerceController.markOrdersAttentionSeen).toHaveBeenCalledOnce();

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(CommerceController.markOrdersAttentionSeen).toHaveBeenCalledTimes(2));
    visibility.mockRestore();
  });
});
