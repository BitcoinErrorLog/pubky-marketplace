import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { useMarketplaceNotifications } from './useMarketplaceNotifications';

const OWNER = 'y'.repeat(52);
const ACTOR = 'b'.repeat(52);
const NOTIFICATION_ID = '00000000-0000-4000-8000-000000000980';

const config = vi.hoisted(() => ({
  mode: 'sandbox' as string,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommercePollIntervalMs: () => 60_000, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) => selector({ currentUserPubky: OWNER }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceNotifications: vi.fn(),
    getMarketplaceNotificationPreferences: vi.fn(),
    executeMarketplaceCommand: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

describe('useMarketplaceNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.mode = 'sandbox';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000981');
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([
      {
        id: NOTIFICATION_ID,
        revision: 1,
        recipientPubky: OWNER,
        actorPubky: ACTOR,
        type: 'offer_received',
        aggregateId: 'offer:test',
        createdAt: '2026-08-19T23:00:00.000Z',
        readAt: null,
      },
    ]);
    vi.mocked(CommerceController.getMarketplaceNotificationPreferences).mockResolvedValue({
      ownerPubky: OWNER,
      revision: 1,
      messages: true,
      offers: true,
      bids: true,
      auctions: true,
      updatedAt: '2026-08-19T23:00:00.000Z',
    });
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000981',
      aggregateId: `notification:${NOTIFICATION_ID}`,
      revision: 2,
      eventIds: ['00000000-0000-4000-8000-000000000982'],
      result: { kind: 'notification' },
    });
  });

  it('marks unread notifications with their current revisions', async () => {
    const { result } = renderHook(() => useMarketplaceNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(() => result.current.markAllRead());

    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: `notification:${NOTIFICATION_ID}`,
        expectedRevision: 1,
        kind: 'notification.mark_read',
      }),
    );
    expect(result.current.unreadCount).toBe(0);
  });

  it('updates all preference categories under one revisioned command', async () => {
    const { result } = renderHook(() => useMarketplaceNotifications());
    await waitFor(() => expect(result.current.preferences?.revision).toBe(1));

    await act(() =>
      result.current.updatePreferences({
        messages: false,
        offers: true,
        bids: true,
        auctions: true,
      }),
    );

    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: `notification_preferences:${OWNER}`,
        expectedRevision: 1,
        kind: 'notification.preferences.update',
        payload: { messages: false, offers: true, bids: true, auctions: true },
      }),
    );
  });

  it('reads notifications but never preferences in transaction-service mode', async () => {
    config.mode = 'transaction-service';
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([
      {
        // Durable notifications are immutable outbox rows: no revision.
        id: NOTIFICATION_ID,
        recipientPubky: OWNER,
        actorPubky: ACTOR,
        type: 'order_shipped',
        aggregateId: 'order:00000000-0000-4000-8000-000000000983',
        createdAt: '2026-08-19T23:00:00.000Z',
        readAt: null,
      },
    ]);

    const { result } = renderHook(() => useMarketplaceNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.preferences).toBeNull();
    expect(result.current.canMarkRead).toBe(false);
    expect(CommerceController.getMarketplaceNotificationPreferences).not.toHaveBeenCalled();
  });

  it('does not count quarantined rows as unread or send them to mark-all-read', async () => {
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([
      {
        kind: 'unrecognized',
        id: 'row-1',
        index: 0,
        type: 'payment_method_bound',
        createdAt: '2026-08-19T23:00:00.000Z',
      },
      {
        id: NOTIFICATION_ID,
        revision: 1,
        recipientPubky: OWNER,
        actorPubky: ACTOR,
        type: 'offer_received',
        aggregateId: 'offer:test',
        createdAt: '2026-08-19T23:00:00.000Z',
        readAt: null,
      },
    ]);

    const { result } = renderHook(() => useMarketplaceNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.unreadCount).toBe(1);
    await act(() => result.current.markAllRead());
    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledOnce();
    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({ aggregateId: `notification:${NOTIFICATION_ID}` }),
    );
  });

  it('refuses to mark read in transaction-service mode — the service has no read state', async () => {
    config.mode = 'transaction-service';
    const { result } = renderHook(() => useMarketplaceNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(() => result.current.markAllRead());

    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });

  it('maps server and thrown sentinel failures to static copy', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_notifications';
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const { result } = renderHook(() => useMarketplaceNotifications());
    await waitFor(() => expect(result.current.preferences).not.toBeNull());

    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INVALID_STATE', message: sentinel },
    });
    await act(async () => {
      await result.current.updatePreferences({ messages: false, offers: true, bids: true, auctions: true });
    });
    expect(vi.mocked(toast).mock.calls[0]?.[0]?.description).toBeTypeOf('string');
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);

    vi.mocked(CommerceController.executeMarketplaceCommand).mockRejectedValueOnce(
      new AppError({
        category: ErrorCategory.Client,
        code: ClientErrorCode.CONFLICT,
        message: sentinel,
        service: ErrorService.Marketplace,
        operation: 'notifications',
      }),
    );
    await act(async () => {
      await result.current.updatePreferences({ messages: true, offers: true, bids: true, auctions: true });
    });
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);
  });
});
