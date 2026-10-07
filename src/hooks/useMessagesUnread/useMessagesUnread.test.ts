import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagingController } from '@/controllers/messaging/messaging';
import { useMessagesUnread } from './useMessagesUnread';

const state = vi.hoisted(() => ({
  currentUserPubky: 'a'.repeat(52) as string | null,
  enabledPubky: null as string | null,
  unreadConversations: 4,
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (store: typeof state) => unknown) => selector(state),
}));
vi.mock('@/stores/messaging/messaging.store', () => ({
  useMessagingStore: (selector: (store: typeof state) => unknown) => selector(state),
}));
vi.mock('@/controllers/messaging/messaging', () => ({
  MessagingController: { refreshUnreadCount: vi.fn(async () => 4) },
}));

describe('useMessagesUnread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentUserPubky = 'a'.repeat(52);
    state.enabledPubky = null;
    state.unreadConversations = 4;
  });

  it('hydrates once by default and follows the shared count without refreshing on count changes', () => {
    const { result, rerender } = renderHook(() => useMessagesUnread());
    expect(result.current).toBe(4);
    expect(MessagingController.refreshUnreadCount).toHaveBeenCalledTimes(1);

    state.unreadConversations = 5;
    rerender();
    expect(result.current).toBe(5);
    expect(MessagingController.refreshUnreadCount).toHaveBeenCalledTimes(1);
  });

  it('does not hydrate or expose a badge when disabled, including account changes', () => {
    const { result, rerender } = renderHook(() => useMessagesUnread({ enabled: false }));
    expect(result.current).toBe(0);

    state.currentUserPubky = 'b'.repeat(52);
    state.enabledPubky = state.currentUserPubky;
    rerender();
    expect(result.current).toBe(0);
    expect(MessagingController.refreshUnreadCount).not.toHaveBeenCalled();
  });

  it('hydrates when enabled and stops refreshing when disabled again', () => {
    const { result, rerender } = renderHook(({ enabled }) => useMessagesUnread({ enabled }), {
      initialProps: { enabled: false },
    });
    rerender({ enabled: true });
    expect(result.current).toBe(4);
    expect(MessagingController.refreshUnreadCount).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    state.enabledPubky = state.currentUserPubky;
    rerender({ enabled: false });
    expect(result.current).toBe(0);
    expect(MessagingController.refreshUnreadCount).toHaveBeenCalledTimes(1);
  });

  it('does not hydrate for a guest', () => {
    state.currentUserPubky = null;
    renderHook(() => useMessagesUnread());
    expect(MessagingController.refreshUnreadCount).not.toHaveBeenCalled();
  });
});
