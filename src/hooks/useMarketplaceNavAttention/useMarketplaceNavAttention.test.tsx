import { useEffect, useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceActivityUnread } from '@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread';
import { useMarketplaceNavAttention } from '@/hooks/useMarketplaceNavAttention/useMarketplaceNavAttention';
import { useMarketplaceOrdersAttention } from '@/hooks/useMarketplaceOrdersAttention/useMarketplaceOrdersAttention';

const ACCOUNT_A = 'a'.repeat(52);
const ACCOUNT_B = 'b'.repeat(52);
const SELLER = 's'.repeat(52);

const state = vi.hoisted(() => ({
  currentUserPubky: 'a'.repeat(52) as string | null,
  mode: 'transaction-service' as string,
  listeners: new Set<() => void>(),
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => state.mode };
});

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
  useAuthStore: (selector: (store: { currentUserPubky: string | null }) => unknown) => {
    const [, setTick] = useState(0);
    useEffect(() => {
      const listener = () => setTick((tick) => tick + 1);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    }, []);
    return selector({ currentUserPubky: state.currentUserPubky });
  },
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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const reads = {
  alerts: deferred<Array<{ id: string; owner_id: string; seen_at: number | null }>>(),
  checkpoint: deferred<number>(),
  notifications: deferred<Array<Record<string, unknown>>>(),
  orders: deferred<Array<Record<string, unknown>>>(),
  offers: deferred<Array<Record<string, unknown>>>(),
};

function armReads() {
  reads.alerts = deferred();
  reads.checkpoint = deferred();
  reads.notifications = deferred();
  reads.orders = deferred();
  reads.offers = deferred();
}

function notification(id: string, recipientPubky: string) {
  return {
    id,
    recipientPubky,
    actorPubky: SELLER,
    type: 'offer_received',
    aggregateId: `offer:${id}`,
    createdAt: '2026-09-23T12:00:00.000Z',
    readAt: null,
  };
}

function openOffer(id: string, sellerPubky: string) {
  return {
    id,
    buyerPubky: SELLER,
    sellerPubky,
    state: 'pending',
    offeredBy: SELLER,
    expiresAt: '2099-01-01T00:00:00.000Z',
    award: null,
  };
}

function order(id: string, buyerPubky: string) {
  return {
    id,
    state: 'pending_payment',
    holdExpiresAt: null,
    nextActor: 'buyer' as const,
    buyerPubky,
    sellerPubky: SELLER,
    updatedAt: '2026-09-23T12:00:00.000Z',
  };
}

function BadgeProbe() {
  const activity = useMarketplaceActivityUnread();
  const orders = useMarketplaceOrdersAttention();
  const nav = useMarketplaceNavAttention();
  return (
    <>
      <span data-testid="activity-badge">{activity}</span>
      <span data-testid="orders-badge">{orders}</span>
      <span data-testid="marketplace-nav-badge">{nav}</span>
    </>
  );
}

function badge(testId: string) {
  return screen.getByTestId(testId).textContent;
}

describe('marketplace badge identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentUserPubky = ACCOUNT_A;
    state.mode = 'transaction-service';
    state.listeners.clear();
    armReads();
    vi.mocked(CommerceController.getWatchAlerts).mockImplementation(() => reads.alerts.promise as never);
    vi.mocked(CommerceController.getActivityReadCheckpoint).mockImplementation(() => reads.checkpoint.promise);
    vi.mocked(CommerceController.getMarketplaceNotifications).mockImplementation(
      () => reads.notifications.promise as never,
    );
    vi.mocked(CommerceController.getMarketplaceOrders).mockImplementation(() => reads.orders.promise as never);
    vi.mocked(CommerceController.getMarketplaceOffers).mockImplementation(() => reads.offers.promise as never);
    vi.mocked(CommerceController.syncAttentionSeen).mockResolvedValue();
  });

  it('counts an order once when both its return row and the order itself need the account', async () => {
    render(<BadgeProbe />);

    await act(async () => {
      reads.alerts.resolve([]);
      reads.checkpoint.resolve(0);
      reads.notifications.resolve([
        { ...notification('r1', ACCOUNT_A), type: 'return_updated', aggregateId: 'order:o1' },
        notification('a1', ACCOUNT_A),
      ]);
      reads.orders.resolve([order('o1', ACCOUNT_A)]);
      reads.offers.resolve([openOffer('a1', ACCOUNT_A)]);
    });

    await waitFor(() => {
      expect(badge('activity-badge')).toBe('2');
      expect(badge('orders-badge')).toBe('1');
      expect(badge('marketplace-nav-badge')).toBe('2');
    });
  });

  it('shows zero while account B is loading after account A had counts', async () => {
    render(<BadgeProbe />);

    await act(async () => {
      reads.alerts.resolve([{ id: 'alert-a', owner_id: ACCOUNT_A, seen_at: null }]);
      reads.checkpoint.resolve(0);
      reads.notifications.resolve([notification('a1', ACCOUNT_A), notification('a2', ACCOUNT_A)]);
      reads.orders.resolve([order('o1', ACCOUNT_A), order('o2', ACCOUNT_A)]);
      reads.offers.resolve([openOffer('a1', ACCOUNT_A), openOffer('a2', ACCOUNT_A)]);
    });

    await waitFor(() => {
      expect(badge('activity-badge')).toBe('3');
      expect(badge('orders-badge')).toBe('2');
      expect(badge('marketplace-nav-badge')).toBe('5');
    });

    const staleNotifications = reads.notifications;
    const staleOrders = reads.orders;
    const staleOffers = reads.offers;
    armReads();

    await act(async () => {
      state.currentUserPubky = ACCOUNT_B;
      for (const listener of state.listeners) listener();
    });

    expect(badge('activity-badge')).toBe('0');
    expect(badge('orders-badge')).toBe('0');
    expect(badge('marketplace-nav-badge')).toBe('0');

    await act(async () => {
      staleNotifications.resolve([notification('late-a', ACCOUNT_A), notification('late-a2', ACCOUNT_A)]);
      staleOrders.resolve([order('late-o', ACCOUNT_A), order('late-o2', ACCOUNT_A)]);
      staleOffers.resolve([openOffer('late-a', ACCOUNT_A), openOffer('late-a2', ACCOUNT_A)]);
      await Promise.resolve();
    });

    expect(badge('activity-badge')).toBe('0');
    expect(badge('orders-badge')).toBe('0');
    expect(badge('marketplace-nav-badge')).toBe('0');

    await act(async () => {
      reads.alerts.resolve([]);
      reads.checkpoint.resolve(0);
      reads.notifications.resolve([notification('b1', ACCOUNT_B)]);
      reads.orders.resolve([order('b-order', ACCOUNT_B)]);
      reads.offers.resolve([openOffer('b1', ACCOUNT_B)]);
    });

    await waitFor(() => {
      expect(badge('activity-badge')).toBe('1');
      expect(badge('orders-badge')).toBe('1');
      expect(badge('marketplace-nav-badge')).toBe('2');
    });
  });
});
