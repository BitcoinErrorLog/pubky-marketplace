import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagingConversationSummary } from '@/application/messaging/messaging';
import { MessagingController } from '@/controllers/messaging/messaging';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { asInvalid } from '@/test-utils/type-assertions';
import { useEncryptedInbox } from './useEncryptedInbox';

const OWNER = 'o'.repeat(52);

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommercePollIntervalMs: () => 60_000 };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: OWNER }),
}));

vi.mock('@/stores/messaging/messaging.store', () => ({
  useMessagingStore: (selector: (state: { enabledPubky: string | null }) => unknown) =>
    selector({ enabledPubky: null }),
}));

vi.mock('@/controllers/messaging/messaging', () => ({
  MessagingController: {
    getMessagingStatus: vi.fn(),
    syncInbox: vi.fn(),
    getConversations: vi.fn(),
    restartInboxRetries: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

// Only the fields the hook passes through; the rows are never rendered here.
const savedConversation = (id: string) =>
  asInvalid<MessagingConversationSummary>({ id, conversation_id: id, counterparty_pubky: 'c'.repeat(52) });

describe('useEncryptedInbox lists saved conversations before the first sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MessagingController.syncInbox).mockResolvedValue({ mutes: 'ready', rateLimited: 0 });
  });

  it('shows the saved conversations while the status read has not settled', async () => {
    vi.mocked(MessagingController.getMessagingStatus).mockReturnValue(new Promise(() => undefined));
    vi.mocked(MessagingController.getConversations).mockResolvedValue({
      mutes: 'ready',
      conversations: [savedConversation('a')],
    });

    const { result } = renderHook(() => useEncryptedInbox());

    await waitFor(() => expect(result.current.conversations.map((row) => row.id)).toEqual(['a']));
    expect(result.current.status).toBe('loading');
    expect(result.current.mutesStatus).toBe('ready');
    expect(MessagingController.syncInbox).not.toHaveBeenCalled();
  });

  it('a slower opening read never replaces the list the first sync showed', async () => {
    let finishOpening: (value: Awaited<ReturnType<typeof MessagingController.getConversations>>) => void = () => {};
    vi.mocked(MessagingController.getMessagingStatus).mockResolvedValue({
      sessionActive: true,
      receiverProvisioned: true,
      ownKeyRepublished: null,
    });
    vi.mocked(MessagingController.getConversations)
      .mockReturnValueOnce(new Promise((resolve) => (finishOpening = resolve)))
      .mockResolvedValue({ mutes: 'ready', conversations: [savedConversation('after-sync')] });

    const { result } = renderHook(() => useEncryptedInbox());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.conversations.map((row) => row.id)).toEqual(['after-sync']);

    await act(async () => finishOpening({ mutes: 'ready', conversations: [savedConversation('stale')] }));
    expect(result.current.conversations.map((row) => row.id)).toEqual(['after-sync']);
  });

  it('a failed opening read leaves the inbox to the sync', async () => {
    vi.mocked(MessagingController.getMessagingStatus).mockResolvedValue({
      sessionActive: true,
      receiverProvisioned: true,
      ownKeyRepublished: null,
    });
    vi.mocked(MessagingController.getConversations)
      .mockRejectedValueOnce(new Error('local read failed'))
      .mockResolvedValue({ mutes: 'ready', conversations: [savedConversation('a')] });

    const { result } = renderHook(() => useEncryptedInbox());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.conversations.map((row) => row.id)).toEqual(['a']);
    expect(result.current.errorMessage).toBeNull();
  });

  it('a status read that timed out shows its copy; the next sync recovers', async () => {
    vi.mocked(MessagingController.getConversations).mockResolvedValue({
      mutes: 'ready',
      conversations: [savedConversation('a')],
    });
    vi.mocked(MessagingController.getMessagingStatus)
      .mockRejectedValueOnce(new Error(MESSAGING_COPY.statusTimeout))
      .mockResolvedValue({ sessionActive: true, receiverProvisioned: true, ownKeyRepublished: null });

    const { result } = renderHook(() => useEncryptedInbox());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBe(MESSAGING_COPY.statusTimeout);
    expect(result.current.conversations.map((row) => row.id)).toEqual(['a']);

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });
});

describe('useEncryptedInbox retry backoff restarts only while someone can see it', () => {
  const restart = () => vi.mocked(MessagingController.restartInboxRetries);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MessagingController.getMessagingStatus).mockResolvedValue({
      sessionActive: true,
      receiverProvisioned: true,
      ownKeyRepublished: null,
    });
    vi.mocked(MessagingController.syncInbox).mockResolvedValue({ mutes: 'ready', rateLimited: 0 });
    vi.mocked(MessagingController.getConversations).mockResolvedValue({ mutes: 'ready', conversations: [] });
  });

  it('restarts on open, when the page becomes visible again (before that sync), and on Try again', async () => {
    const { result } = renderHook(() => useEncryptedInbox());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(restart()).toHaveBeenCalledTimes(1);
    expect(restart().mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(MessagingController.syncInbox).mock.invocationCallOrder[0],
    );

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(MessagingController.syncInbox).toHaveBeenCalledTimes(2));
    expect(restart()).toHaveBeenCalledTimes(2);
    expect(restart().mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(MessagingController.syncInbox).mock.invocationCallOrder[1],
    );

    act(() => result.current.refresh());
    await waitFor(() => expect(MessagingController.syncInbox).toHaveBeenCalledTimes(3));
    expect(restart()).toHaveBeenCalledTimes(3);
  });

  it('a hidden page keeps backing off: no restart and no sync on open, a hidden visibility event, or Try again', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      const { result } = renderHook(() => useEncryptedInbox());
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      act(() => result.current.refresh());
      await act(async () => {});

      expect(restart()).not.toHaveBeenCalled();
      expect(MessagingController.syncInbox).not.toHaveBeenCalled();
    } finally {
      hidden.mockRestore();
    }
  });
});
