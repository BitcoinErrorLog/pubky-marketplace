import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceMessages } from './useMarketplaceMessages';

const BUYER = 'b'.repeat(52);
const SELLER = 'y'.repeat(52);

const config = vi.hoisted(() => ({
  mode: 'sandbox' as string,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommercePollIntervalMs: () => 60_000, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) => selector({ currentUserPubky: BUYER }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceConversations: vi.fn(),
    executeMarketplaceCommand: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

describe('useMarketplaceMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.mode = 'sandbox';
    vi.mocked(CommerceController.getMarketplaceConversations).mockResolvedValue([]);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000920');
  });

  it('sends a revision-bound private listing message', async () => {
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000920',
      aggregateId: `conversation:${SELLER}_${BUYER}_boots_01`,
      revision: 1,
      eventIds: ['00000000-0000-4000-8000-000000000921'],
      result: { kind: 'message' },
    });
    const { result } = renderHook(() => useMarketplaceMessages(SELLER, 'boots_01'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.form.setValue('text', 'Is this still available?'));

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: `conversation:${SELLER}_${BUYER}_boots_01`,
        expectedRevision: 0,
        kind: 'message.send',
        payload: {
          listingAggregateId: `listing:${SELLER}_boots_01`,
          recipientPubky: SELLER,
          text: 'Is this still available?',
          attachmentIds: [],
        },
      }),
    );
  });

  it('never loads or sends outside sandbox mode — messaging has no durable backend', async () => {
    config.mode = 'transaction-service';
    const { result } = renderHook(() => useMarketplaceMessages(SELLER, 'boots_01'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.form.setValue('text', 'Is this still available?'));

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(result.current.isSandbox).toBe(false);
    expect(CommerceController.getMarketplaceConversations).not.toHaveBeenCalled();
    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });

  it('maps server and thrown sentinel failures to static copy', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_messages';
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const { result } = renderHook(() => useMarketplaceMessages(SELLER, 'boots_01'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.form.setValue('text', 'Is this still available?'));

    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INVALID_STATE', message: sentinel },
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(vi.mocked(toast).mock.calls[0]?.[0]?.description).toBeTypeOf('string');
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);

    vi.mocked(CommerceController.executeMarketplaceCommand).mockRejectedValueOnce({
      name: 'AppError',
      code: 'INVALID_STATE',
      message: sentinel,
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);
  });
});
