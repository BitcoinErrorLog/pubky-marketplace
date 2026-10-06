import { useEffect, useState } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceActivityUnread } from './useMarketplaceActivityUnread';

const OWNER = 'y'.repeat(52);
const ACTOR = 'b'.repeat(52);

const state = vi.hoisted(() => ({
  currentUserPubky: 'y'.repeat(52) as string | null,
  mode: 'transaction-service' as string,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => state.mode };
});

// The real hook reads live from Dexie; resolving the querier once per
// dependency change is enough for these assertions on the count math.
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => Promise<unknown>, deps: unknown[]) => {
    const [value, setValue] = useState<unknown>(undefined);
    useEffect(() => {
      let active = true;
      void Promise.resolve(querier()).then((next) => {
        if (active) setValue(next);
      });
      return () => {
        active = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return value;
  },
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (store: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: state.currentUserPubky }),
}));

vi.mock('@/stores/commerce/commerce.store', () => ({
  useCommerceStore: (selector: (store: { marketplaceSession: null }) => unknown) =>
    selector({ marketplaceSession: null }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getWatchAlerts: vi.fn(),
    getActivityReadCheckpoint: vi.fn(),
    getMarketplaceNotifications: vi.fn(),
    getMarketplaceOrders: vi.fn(),
    getMarketplaceOffers: vi.fn(),
    syncAttentionSeen: vi.fn(),
  },
}));

// Every offer row in these tests points at an offer that still waits on OWNER.
const OPEN_OFFER_IDS = ['old', 'new-1', 'new-2', 'offer', 'unread', 'read', 'seen-1', 'seen-2'];

function openOffer(id: string) {
  return {
    id,
    buyerPubky: ACTOR,
    sellerPubky: OWNER,
    state: 'pending' as const,
    offeredBy: ACTOR,
    expiresAt: '2099-01-01T00:00:00.000Z',
    award: null,
  };
}

function orderRecord(id: string, state: string, nextActor: 'buyer' | 'seller' | 'none') {
  return {
    id,
    state,
    nextActor,
    buyerPubky: ACTOR,
    sellerPubky: OWNER,
    updatedAt: '2026-08-20T01:00:00.000Z',
    holdExpiresAt: null,
  };
}

function notification(id: string, createdAt: string, readAt: string | null = null) {
  return {
    id,
    recipientPubky: OWNER,
    actorPubky: ACTOR,
    type: 'offer_received' as const,
    aggregateId: `offer:${id}`,
    createdAt,
    readAt,
  };
}

function watchAlert(id: string, seenAt: number | null) {
  return { id, owner_id: OWNER, seen_at: seenAt } as never;
}

describe('useMarketplaceActivityUnread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentUserPubky = OWNER;
    state.mode = 'transaction-service';
    vi.mocked(CommerceController.getWatchAlerts).mockResolvedValue([]);
    vi.mocked(CommerceController.getActivityReadCheckpoint).mockResolvedValue(0);
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([]);
    vi.mocked(CommerceController.getMarketplaceOrders).mockResolvedValue([]);
    vi.mocked(CommerceController.getMarketplaceOffers).mockResolvedValue(OPEN_OFFER_IDS.map(openOffer) as never);
    vi.mocked(CommerceController.syncAttentionSeen).mockResolvedValue();
  });

  it('pulls the account-wide checkpoint so a view cleared in another browser stays cleared', async () => {
    renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(CommerceController.syncAttentionSeen).toHaveBeenCalled());
  });

  it('stops badging an offer row once the offer is answered', async () => {
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([
      notification('offer', '2026-08-20T01:00:00.000Z'),
    ]);
    vi.mocked(CommerceController.getMarketplaceOffers).mockResolvedValue([
      { ...openOffer('offer'), state: 'rejected' },
    ] as never);

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(CommerceController.getMarketplaceOffers).toHaveBeenCalled());
    await waitFor(() => expect(CommerceController.getMarketplaceNotifications).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it('badges order rows only while the order waits on this account, never a started checkout or a cancellation', async () => {
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([
      { ...notification('checkout', '2026-08-20T01:00:00.000Z'), type: 'order_created', aggregateId: 'order:o-new' },
      { ...notification('cancel', '2026-08-20T02:00:00.000Z'), type: 'order_cancelled', aggregateId: 'order:o-gone' },
      { ...notification('ret-open', '2026-08-20T03:00:00.000Z'), type: 'return_updated', aggregateId: 'order:o-ret' },
      { ...notification('ret-done', '2026-08-20T04:00:00.000Z'), type: 'return_updated', aggregateId: 'order:o-done' },
    ] as never);
    vi.mocked(CommerceController.getMarketplaceOrders).mockResolvedValue([
      orderRecord('o-new', 'pending_payment', 'buyer'),
      orderRecord('o-gone', 'cancelled', 'none'),
      orderRecord('o-ret', 'return_requested', 'seller'),
      orderRecord('o-done', 'refunded', 'none'),
    ] as never);

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(result.current).toBe(1));
  });

  it('counts only durable notifications newer than the device checkpoint', async () => {
    vi.mocked(CommerceController.getActivityReadCheckpoint).mockResolvedValue(Date.parse('2026-08-20T00:00:00.000Z'));
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([
      notification('old', '2026-08-19T23:00:00.000Z'),
      notification('new-1', '2026-08-20T01:00:00.000Z'),
      notification('new-2', '2026-08-21T09:30:00.000Z'),
    ]);

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(result.current).toBe(2));
  });

  it('does not badge informational rows such as a confirmed payment', async () => {
    vi.mocked(CommerceController.getActivityReadCheckpoint).mockResolvedValue(0);
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([
      notification('offer', '2026-08-20T01:00:00.000Z'),
      { ...notification('paid', '2026-08-21T09:30:00.000Z'), type: 'payment_confirmed' as const },
    ]);

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(CommerceController.getMarketplaceNotifications).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBe(1));
  });

  it('adds unseen watch alerts on top of the checkpoint count', async () => {
    vi.mocked(CommerceController.getActivityReadCheckpoint).mockResolvedValue(Date.parse('2026-08-20T00:00:00.000Z'));
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([
      notification('new-1', '2026-08-20T01:00:00.000Z'),
    ]);
    vi.mocked(CommerceController.getWatchAlerts).mockResolvedValue([
      watchAlert('a1', null),
      watchAlert('a2', null),
      watchAlert('a3', 999),
    ]);

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(result.current).toBe(3));
  });

  it('counts sandbox notifications by their real read state, never the checkpoint too', async () => {
    state.mode = 'sandbox';
    // Checkpoint of 0 would call every row "new" — a sandbox row that is both
    // unread and newer than the checkpoint must still count exactly once, and
    // a read row must not count at all.
    vi.mocked(CommerceController.getActivityReadCheckpoint).mockResolvedValue(0);
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([
      notification('unread', '2026-08-20T01:00:00.000Z', null),
      notification('read', '2026-08-21T09:30:00.000Z', '2026-08-21T10:00:00.000Z'),
    ]);

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(CommerceController.getMarketplaceNotifications).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBe(1));
  });

  it('zeroes once the checkpoint has advanced past every row — the effect of visiting', async () => {
    vi.mocked(CommerceController.getActivityReadCheckpoint).mockResolvedValue(Date.parse('2026-08-22T00:00:00.000Z'));
    vi.mocked(CommerceController.getMarketplaceNotifications).mockResolvedValue([
      notification('seen-1', '2026-08-20T01:00:00.000Z'),
      notification('seen-2', '2026-08-21T09:30:00.000Z'),
    ]);

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(CommerceController.getMarketplaceNotifications).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it('contributes zero service rows when the fetch fails, while local alerts still count', async () => {
    vi.mocked(CommerceController.getMarketplaceNotifications).mockRejectedValue(new Error('offline'));
    vi.mocked(CommerceController.getWatchAlerts).mockResolvedValue([watchAlert('a1', null)]);

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(result.current).toBe(1));
  });

  it('contributes zero when the local watch query throws', async () => {
    vi.mocked(CommerceController.getWatchAlerts).mockImplementation(() => {
      throw new TypeError('CommerceController.getWatchAlerts is not a function');
    });

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(CommerceController.getWatchAlerts).toHaveBeenCalled());
    expect(result.current).toBe(0);
    expect(CommerceController.getMarketplaceNotifications).not.toHaveBeenCalled();
  });

  it('contributes zero when the notification fetch throws before a promise', async () => {
    vi.mocked(CommerceController.getActivityReadCheckpoint).mockResolvedValue(0);
    vi.mocked(CommerceController.getMarketplaceNotifications).mockImplementation(() => {
      throw new TypeError('CommerceController.getMarketplaceNotifications is not a function');
    });

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(CommerceController.getMarketplaceNotifications).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it('returns zero without fetching when signed out', async () => {
    state.currentUserPubky = null;

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(result.current).toBe(0));
    expect(CommerceController.getMarketplaceNotifications).not.toHaveBeenCalled();
    expect(CommerceController.getWatchAlerts).not.toHaveBeenCalled();
  });

  it('never fetches service notifications when no marketplace backend is configured', async () => {
    state.mode = 'unavailable';
    vi.mocked(CommerceController.getWatchAlerts).mockResolvedValue([watchAlert('a1', null)]);

    const { result } = renderHook(() => useMarketplaceActivityUnread());

    await waitFor(() => expect(result.current).toBe(1));
    expect(CommerceController.getMarketplaceNotifications).not.toHaveBeenCalled();
  });
});
