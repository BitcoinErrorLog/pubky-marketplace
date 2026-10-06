import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  DROP_OPEN_POLL_INTERVAL_MS,
  DROP_T0_POLL_INTERVAL_MS,
  dropProjectionPollDelayMs,
  useMarketplaceDrop,
} from './useMarketplaceDrop';

const SELLER = 's'.repeat(52);
const BUYER = 'b'.repeat(52);
const NOW = Date.parse('2026-08-23T12:00:00.000Z');

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchDrop: vi.fn(),
    getPublicDrop: vi.fn(),
    getDropReadyCheck: vi.fn(),
    syncDropRegistration: vi.fn(),
  },
}));

const authMock = vi.hoisted(() => {
  const state = { currentUserPubky: null as string | null };
  const useAuthStore = Object.assign((selector: (current: typeof state) => unknown) => selector(state), {
    getState: () => state,
  });
  return { state, useAuthStore };
});

vi.mock('@/stores/auth/auth.store', () => ({ useAuthStore: authMock.useAuthStore }));

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    recordType: 'drop',
    ownerPubky: SELLER,
    dropId: 'drop1',
    title: 'Vol 1',
    description: 'One hundred units.',
    media: [],
    format: 'fcfs',
    startsAt: new Date(NOW + 60 * 60_000).toISOString(),
    listingIds: ['listing1'],
    totalQuantity: 100,
    perBuyerLimit: 2,
    stockDisplay: 'exact',
    revision: 1,
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 86_400_000).toISOString(),
    ...overrides,
  };
}

/** serverTime tracks the (fake) device clock so the measured offset stays 0. */
function makeProjection(overrides: Record<string, unknown> = {}) {
  return {
    sellerPubky: SELLER,
    dropId: 'drop1',
    aggregateId: `drop:${SELLER}_drop1`,
    state: 'announced',
    format: 'fcfs',
    startsAt: new Date(NOW + 60 * 60_000).toISOString(),
    endsAt: null,
    stockDisplay: 'exact',
    totalQuantity: 100,
    perBuyerLimit: 2,
    remaining: 100,
    remainingBand: null,
    revision: 1,
    serverTime: new Date(Date.now()).toISOString(),
    ...overrides,
  };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('dropProjectionPollDelayMs', () => {
  const projection = (overrides: Record<string, unknown>) => makeProjection(overrides) as never;

  it('polls at 2s inside ±10s of server-time startsAt, on both sides of T-0', () => {
    const startsAt = new Date(NOW).toISOString();
    expect(dropProjectionPollDelayMs(projection({ startsAt }), 0, NOW - 10_000)).toBe(DROP_T0_POLL_INTERVAL_MS);
    expect(dropProjectionPollDelayMs(projection({ startsAt }), 0, NOW + 10_000)).toBe(DROP_T0_POLL_INTERVAL_MS);
  });

  it('polls at 30s inside the open window outside the T-0 spike', () => {
    const startsAt = new Date(NOW - 60_000).toISOString();
    expect(dropProjectionPollDelayMs(projection({ startsAt, state: 'live' }), 0, NOW)).toBe(DROP_OPEN_POLL_INTERVAL_MS);
    // A lazily-transitioned aggregate still says announced after startsAt:
    // the open-window cadence heals it on touch.
    expect(dropProjectionPollDelayMs(projection({ startsAt, state: 'announced' }), 0, NOW)).toBe(
      DROP_OPEN_POLL_INTERVAL_MS,
    );
  });

  it('polls nothing far from T-0 and never for terminal states', () => {
    const farFuture = new Date(NOW + 60 * 60_000).toISOString();
    expect(dropProjectionPollDelayMs(projection({ startsAt: farFuture }), 0, NOW)).toBeNull();
    const past = new Date(NOW - 60_000).toISOString();
    for (const state of ['ended_sold_out', 'ended_closed', 'ended_cancelled']) {
      expect(dropProjectionPollDelayMs(projection({ startsAt: past, state }), 0, NOW)).toBeNull();
    }
    // Past endsAt the window is closed even if the sweep has not run yet.
    expect(
      dropProjectionPollDelayMs(
        projection({ startsAt: new Date(NOW - 120_000).toISOString(), endsAt: new Date(NOW - 60_000).toISOString() }),
        0,
        NOW,
      ),
    ).toBeNull();
  });

  it('uses the CORRECTED clock: a skewed device inside the window still hits the T-0 cadence', () => {
    const startsAt = new Date(NOW).toISOString();
    // Device 5 minutes behind; offset corrects it into the ±10s window.
    expect(dropProjectionPollDelayMs(projection({ startsAt }), 5 * 60_000, NOW - 5 * 60_000)).toBe(
      DROP_T0_POLL_INTERVAL_MS,
    );
  });
});

describe('useMarketplaceDrop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    config.mode = 'transaction-service';
    authMock.state.currentUserPubky = null;
    useCommerceStore.getState().reset();
    setVisibilityQuietly('visible');
    vi.mocked(CommerceController.fetchDrop).mockResolvedValue(makeRecord() as never);
    vi.mocked(CommerceController.getPublicDrop).mockImplementation(async () => makeProjection() as never);
    vi.mocked(CommerceController.getDropReadyCheck).mockResolvedValue({
      purchased: 0,
      perBuyerLimit: 2,
      remainingAllowance: 2,
    } as never);
    vi.mocked(CommerceController.syncDropRegistration).mockResolvedValue({ ok: true } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setVisibilityQuietly(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  }

  it('loads the record and projection, measures the clock offset, and derives the display state', async () => {
    const { result, unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();

    expect(result.current.record).toMatchObject({ dropId: 'drop1', title: 'Vol 1' });
    expect(result.current.projection).toMatchObject({ state: 'announced' });
    expect(result.current.clockOffsetMs).toBe(0);
    expect(result.current.displayState).toBe('announced');
    expect(result.current.isLoading).toBe(false);
    unmount();
  });

  it('does NOT poll while the clock is far from startsAt', async () => {
    const { unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(1);

    await advance(10 * 60_000);
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('polls every 2s inside ±10s of startsAt — the reload-free T-0 transition', async () => {
    vi.mocked(CommerceController.getPublicDrop).mockImplementation(
      async () => makeProjection({ startsAt: new Date(NOW + 5_000).toISOString() }) as never,
    );
    const { result, unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(1);

    await advance(DROP_T0_POLL_INTERVAL_MS);
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(2);
    await advance(DROP_T0_POLL_INTERVAL_MS);
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(3);

    // The service flips the state: the page renders live from the
    // projection alone, with no reload and no clock claim.
    vi.mocked(CommerceController.getPublicDrop).mockImplementation(
      async () => makeProjection({ startsAt: new Date(NOW + 5_000).toISOString(), state: 'live' }) as never,
    );
    await advance(DROP_T0_POLL_INTERVAL_MS);
    expect(result.current.displayState).toBe('live');
    unmount();
  });

  it('relaxes to the 30s cadence inside the open window', async () => {
    vi.mocked(CommerceController.getPublicDrop).mockImplementation(
      async () =>
        makeProjection({
          startsAt: new Date(NOW - 60_000).toISOString(),
          endsAt: new Date(NOW + 60 * 60_000).toISOString(),
          state: 'live',
        }) as never,
    );
    const { unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(1);

    await advance(DROP_OPEN_POLL_INTERVAL_MS - 1_000);
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('stops polling while the page is hidden and re-reads on visibility regain', async () => {
    vi.mocked(CommerceController.getPublicDrop).mockImplementation(
      async () => makeProjection({ startsAt: new Date(NOW + 5_000).toISOString() }) as never,
    );
    const { unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    await advance(30_000);
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await settle();
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('stops polling entirely once the drop reaches a terminal state', async () => {
    vi.mocked(CommerceController.getPublicDrop).mockImplementation(
      async () => makeProjection({ startsAt: new Date(NOW - 60_000).toISOString(), state: 'ended_sold_out' }) as never,
    );
    const { result, unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();
    expect(result.current.displayState).toBe('ended_sold_out');

    await advance(10 * 60_000);
    expect(CommerceController.getPublicDrop).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('self-heals an unregistered drop with one drop.sync, then one re-read', async () => {
    authMock.state.currentUserPubky = BUYER;
    vi.mocked(CommerceController.getPublicDrop)
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => makeProjection() as never);

    const { result, unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();

    expect(CommerceController.syncDropRegistration).toHaveBeenCalledTimes(1);
    expect(CommerceController.syncDropRegistration).toHaveBeenCalledWith(SELLER, 'drop1');
    expect(result.current.projection).not.toBeNull();
    expect(result.current.displayState).toBe('announced');
    unmount();
  });

  it('leaves the honest unregistered state when the self-heal fails', async () => {
    authMock.state.currentUserPubky = BUYER;
    vi.mocked(CommerceController.getPublicDrop).mockResolvedValue(null);
    vi.mocked(CommerceController.syncDropRegistration).mockRejectedValue(new Error('service down'));

    const { result, unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();

    expect(result.current.projection).toBeNull();
    expect(result.current.displayState).toBe('unregistered');
    unmount();
  });

  it('loads the ready check only with a signed-in user AND a marketplace session', async () => {
    const { result, unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();
    expect(CommerceController.getDropReadyCheck).not.toHaveBeenCalled();
    expect(result.current.readyCheck).toBeNull();
    unmount();

    authMock.state.currentUserPubky = BUYER;
    useCommerceStore.getState().setMarketplaceSession({
      pubky: BUYER,
      capabilities: '/pub/pubky.app/:rw',
      expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
      issuedAt: new Date(NOW).toISOString(),
    });
    const second = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();
    expect(CommerceController.getDropReadyCheck).toHaveBeenCalledWith(SELLER, 'drop1');
    expect(second.result.current.readyCheck).toMatchObject({ remainingAllowance: 2 });
    second.unmount();
  });

  it('reports honest absence in sandbox mode — drops are durable-only', async () => {
    config.mode = 'sandbox';
    const { result, unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();

    expect(CommerceController.getPublicDrop).not.toHaveBeenCalled();
    expect(result.current.projection).toBeNull();
    expect(result.current.displayState).toBe('unavailable');
    unmount();
  });

  it('surfaces a missing homeserver record as an honest record error', async () => {
    const { Err } = await import('@/libs/error/error.factories');
    const { ClientErrorCode } = await import('@/libs/error/error.codes');
    const { ErrorService } = await import('@/libs/error/error.types');
    vi.mocked(CommerceController.fetchDrop).mockRejectedValue(
      Err.client(ClientErrorCode.NOT_FOUND, 'No such record.', { service: ErrorService.Homeserver, operation: 'x' }),
    );
    const { result, unmount } = renderHook(() => useMarketplaceDrop(SELLER, 'drop1'));
    await settle();

    expect(result.current.record).toBeNull();
    expect(result.current.recordError).toContain('does not exist');
    unmount();
  });
});
