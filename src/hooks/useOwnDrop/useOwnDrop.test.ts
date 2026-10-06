import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { OWN_DROP_POLL_MS, useOwnDrop } from './useOwnDrop';

const SELLER = vi.hoisted(() => 'y'.repeat(52));

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'y'.repeat(52) }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getOwnDrop: vi.fn(),
    fetchDrop: vi.fn(),
    cancelDrop: vi.fn(),
    releaseDropListings: vi.fn(),
    syncDropRegistration: vi.fn(),
  },
}));

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

function sellerDrop(overrides: Record<string, unknown> = {}) {
  return {
    sellerPubky: SELLER,
    dropId: 'drop1',
    aggregateId: `drop:${SELLER}_drop1`,
    state: 'live',
    format: 'fcfs',
    startsAt: '2026-08-01T10:00:00.000Z',
    endsAt: '2026-08-02T10:00:00.000Z',
    stockDisplay: 'exact',
    totalQuantity: 100,
    perBuyerLimit: 2,
    remaining: 37,
    paidQuantity: 63,
    buyerCount: 51,
    revision: 3,
    serverTime: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('useOwnDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    config.mode = 'transaction-service';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    vi.mocked(CommerceController.getOwnDrop).mockResolvedValue(sellerDrop() as never);
    vi.mocked(CommerceController.fetchDrop).mockResolvedValue({ title: 'Winter capsule' } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads once, then polls every 15s while visible', async () => {
    const { result } = renderHook(() => useOwnDrop('drop1'));
    await flush();
    expect(CommerceController.getOwnDrop).toHaveBeenCalledTimes(1);
    expect(result.current.drop).toMatchObject({ state: 'live', remaining: 37 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWN_DROP_POLL_MS * 3);
    });
    expect(CommerceController.getOwnDrop).toHaveBeenCalledTimes(4);
  });

  it('stops polling while hidden and reloads immediately on return to visibility', async () => {
    renderHook(() => useOwnDrop('drop1'));
    await flush();
    expect(CommerceController.getOwnDrop).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWN_DROP_POLL_MS * 4);
    });
    expect(CommerceController.getOwnDrop).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await flush();
    expect(CommerceController.getOwnDrop).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWN_DROP_POLL_MS);
    });
    expect(CommerceController.getOwnDrop).toHaveBeenCalledTimes(3);
  });

  it('clears the poll on unmount — no background daemons', async () => {
    const { unmount } = renderHook(() => useOwnDrop('drop1'));
    await flush();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWN_DROP_POLL_MS * 4);
    });
    expect(CommerceController.getOwnDrop).toHaveBeenCalledTimes(1);
  });

  it('never reads in a non-durable mode — drops are durable-only', async () => {
    config.mode = 'sandbox';
    const { result } = renderHook(() => useOwnDrop('drop1'));
    await flush();
    expect(CommerceController.getOwnDrop).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.drop).toBeNull();
  });

  it('renders unregistered honestly when the service has no aggregate', async () => {
    vi.mocked(CommerceController.getOwnDrop).mockResolvedValue(null as never);
    const { result } = renderHook(() => useOwnDrop('drop1'));
    await flush();
    expect(result.current.drop).toBeNull();
    expect(result.current.record).toMatchObject({ title: 'Winter capsule' });
  });

  it('cancels with the freshly read revision and reloads on success', async () => {
    vi.mocked(CommerceController.cancelDrop).mockResolvedValue({ ok: true, revision: 4 } as never);
    const { result } = renderHook(() => useOwnDrop('drop1'));
    await flush();

    let outcome: Awaited<ReturnType<typeof result.current.cancel>> | undefined;
    await act(async () => {
      outcome = await result.current.cancel();
    });

    expect(CommerceController.cancelDrop).toHaveBeenCalledWith('drop1', 3);
    expect(outcome).toEqual({ ok: true, conflict: false, message: null });
    expect(CommerceController.getOwnDrop).toHaveBeenCalledTimes(2);
  });

  it('REVISION_CONFLICT → refetch fresh state, ask again, retry sends the new revision', async () => {
    vi.mocked(CommerceController.cancelDrop)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.', currentRevision: 5 },
      } as never)
      .mockResolvedValueOnce({ ok: true, revision: 6 } as never);
    const { result } = renderHook(() => useOwnDrop('drop1'));
    await flush();

    vi.mocked(CommerceController.getOwnDrop).mockResolvedValue(sellerDrop({ revision: 5, remaining: 20 }) as never);
    let outcome: Awaited<ReturnType<typeof result.current.cancel>> | undefined;
    await act(async () => {
      outcome = await result.current.cancel();
    });
    expect(outcome).toMatchObject({ ok: false, conflict: true });
    expect(result.current.drop).toMatchObject({ revision: 5, remaining: 20 });

    await act(async () => {
      outcome = await result.current.cancel();
    });
    expect(CommerceController.cancelDrop).toHaveBeenLastCalledWith('drop1', 5);
    expect(outcome).toMatchObject({ ok: true });
  });

  it('refuses to cancel an ended drop without touching the service', async () => {
    vi.mocked(CommerceController.getOwnDrop).mockResolvedValue(sellerDrop({ state: 'ended_closed' }) as never);
    const { result } = renderHook(() => useOwnDrop('drop1'));
    await flush();

    let outcome: Awaited<ReturnType<typeof result.current.cancel>> | undefined;
    await act(async () => {
      outcome = await result.current.cancel();
    });
    expect(CommerceController.cancelDrop).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, message: 'Only an announced or live drop can be cancelled.' });
  });

  it('gates release by state: refused while live, executed with the revision once ended', async () => {
    vi.mocked(CommerceController.releaseDropListings).mockResolvedValue({ ok: true, revision: 4 } as never);
    const { result } = renderHook(() => useOwnDrop('drop1'));
    await flush();

    let outcome: Awaited<ReturnType<typeof result.current.releaseListings>> | undefined;
    await act(async () => {
      outcome = await result.current.releaseListings();
    });
    expect(CommerceController.releaseDropListings).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, message: 'Listings release only after the drop ends.' });

    vi.mocked(CommerceController.getOwnDrop).mockResolvedValue(
      sellerDrop({ state: 'ended_sold_out', remaining: 0, paidQuantity: 100, revision: 9 }) as never,
    );
    await act(async () => {
      await result.current.refresh();
    });
    await act(async () => {
      outcome = await result.current.releaseListings();
    });
    expect(CommerceController.releaseDropListings).toHaveBeenCalledWith('drop1', 9);
    expect(outcome).toMatchObject({ ok: true });
  });

  it('measures the service clock offset from the projection\u2019s serverTime', async () => {
    vi.setSystemTime(new Date('2026-08-01T11:59:00.000Z'));
    const { result } = renderHook(() => useOwnDrop('drop1'));
    await flush();
    // serverTime is 12:00, device says 11:59 → the service runs +60s ahead.
    expect(result.current.offsetMs).toBe(60_000);
  });
  it('maps server and thrown sentinel failures to static copy', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_own_drop';
    const { result } = renderHook(() => useOwnDrop('drop1'));
    await flush();

    vi.mocked(CommerceController.cancelDrop).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INVALID_STATE', message: sentinel },
    } as never);
    let outcome: Awaited<ReturnType<typeof result.current.cancel>> | undefined;
    await act(async () => {
      outcome = await result.current.cancel();
    });
    expect(outcome?.message).toBeTypeOf('string');
    expect(outcome?.message).not.toContain(sentinel);

    vi.mocked(CommerceController.cancelDrop).mockRejectedValueOnce({
      name: 'AppError',
      code: 'INVALID_STATE',
      message: sentinel,
    });
    await act(async () => {
      outcome = await result.current.cancel();
    });
    expect(outcome?.message).toBeTypeOf('string');
    expect(outcome?.message).not.toContain(sentinel);
  });
});
