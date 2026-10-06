import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { CommerceDigitalLock } from '@/libs/commerce/marketplace-records';
import { createOrderFixture, createPaymentFixture } from '@/test/fixtures/commerce/orders';
import { useMarketplaceLocksPayment } from './useMarketplaceLocksPayment';

const SELLER = 's'.repeat(52);

const config = vi.hoisted(() => ({ mode: 'locks-paykit' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => config.mode,
    getCommercePollIntervalMs: () => 50,
  };
});

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceLocksCorrelation: vi.fn(),
    beginMarketplaceLocksPayment: vi.fn(),
    getMarketplaceOrder: vi.fn(),
    unlockMarketplaceLocksContent: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

const digitalLock: CommerceDigitalLock = {
  policyUri: `pubky://${SELLER}/pub/locks.app/${'0'.repeat(52)}.json`,
  criterionId: 'criterion-1',
  contentPath: 'premium.txt',
  resourceHash: 'a'.repeat(64),
  minimumConfirmations: 1,
};

function makeCorrelation(registered: boolean, windowExpiresAt: string | null = null) {
  return {
    id: `b:${'p'}`,
    owner_id: 'b'.repeat(52),
    payment_id: '018f47d2-6a27-7c23-a49d-00000000012d',
    order_id: '018f47d2-6a27-7c23-a49d-000000000001',
    seller_pubky: SELLER,
    bundle_id: '000G40R40M30E209185GR38E1W',
    policy_uri: digitalLock.policyUri,
    criterion_id: 'criterion-1',
    content_path: 'premium.txt',
    resource_hash: 'a'.repeat(64),
    window_expires_at: windowExpiresAt,
    registered,
    created_at: 1,
    updated_at: 1,
  };
}

describe('useMarketplaceLocksPayment', () => {
  const order = createOrderFixture('pending_payment');
  const payment = createPaymentFixture('awaiting_entitlement');

  beforeEach(() => {
    vi.clearAllMocks();
    config.mode = 'locks-paykit';
    vi.mocked(CommerceController.getMarketplaceLocksCorrelation).mockResolvedValue(null);
  });

  it('is disabled outside locks-paykit mode and never touches the controller', async () => {
    config.mode = 'transaction-service';
    const { result } = renderHook(() =>
      useMarketplaceLocksPayment({ order, payment, digitalLock, isBuyer: true, onPaymentChanged: vi.fn() }),
    );
    expect(result.current.enabled).toBe(false);
    await act(async () => {
      expect(await result.current.start()).toBe(false);
      expect(await result.current.unlock()).toBe(false);
    });
    expect(CommerceController.beginMarketplaceLocksPayment).not.toHaveBeenCalled();
    expect(CommerceController.unlockMarketplaceLocksContent).not.toHaveBeenCalled();
  });

  it('starts the payment from a freshly-read projection and reloads the correlation', async () => {
    const freshPayment = { ...payment, revision: payment.revision + 3 };
    const freshOrder = { ...order, payment: freshPayment };
    vi.mocked(CommerceController.getMarketplaceOrder).mockResolvedValue(freshOrder as never);
    vi.mocked(CommerceController.beginMarketplaceLocksPayment).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: `payment:${payment.id}`,
      revision: freshPayment.revision + 1,
      eventIds: [],
      result: { kind: 'payment', verification: { state: 'pending', windowExpiresAt: null } },
    } as never);
    const onPaymentChanged = vi.fn();

    const { result } = renderHook(() =>
      useMarketplaceLocksPayment({ order, payment, digitalLock, isBuyer: true, onPaymentChanged }),
    );

    await act(async () => {
      expect(await result.current.start()).toBe(true);
    });

    // expected_revision comes from the fresh read, not the possibly stale prop.
    expect(CommerceController.beginMarketplaceLocksPayment).toHaveBeenCalledWith({
      order: freshOrder,
      payment: freshPayment,
      digitalLock,
    });
    expect(onPaymentChanged).toHaveBeenCalled();
  });

  it('handles a revision conflict by refetching and asking the user to retry', async () => {
    vi.mocked(CommerceController.getMarketplaceOrder).mockResolvedValue({ ...order, payment } as never);
    vi.mocked(CommerceController.beginMarketplaceLocksPayment).mockResolvedValue({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The payment revision is stale.', currentRevision: 9 },
    } as never);
    const onPaymentChanged = vi.fn();

    const { result } = renderHook(() =>
      useMarketplaceLocksPayment({ order, payment, digitalLock, isBuyer: true, onPaymentChanged }),
    );

    await act(async () => {
      expect(await result.current.start()).toBe(false);
    });

    expect(onPaymentChanged).toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('maps server and thrown sentinel failures to static copy', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_locks_payment';
    const { toast } = await import('@/molecules/Toaster/use-toast');
    vi.mocked(CommerceController.getMarketplaceOrder).mockResolvedValue({ ...order, payment } as never);
    const { result } = renderHook(() =>
      useMarketplaceLocksPayment({ order, payment, digitalLock, isBuyer: true, onPaymentChanged: vi.fn() }),
    );

    vi.mocked(CommerceController.beginMarketplaceLocksPayment).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INVALID_STATE', message: sentinel },
    } as never);
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.error).toBeTypeOf('string');
    expect(result.current.error).not.toContain(sentinel);
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);

    vi.mocked(CommerceController.beginMarketplaceLocksPayment).mockRejectedValueOnce({
      name: 'AppError',
      code: 'INVALID_STATE',
      message: sentinel,
    });
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.error).toBeTypeOf('string');
    expect(result.current.error).not.toContain(sentinel);
  });

  it('unlocks confirmed content and exposes the verified delivery', async () => {
    const confirmed = createPaymentFixture('confirmed');
    vi.mocked(CommerceController.getMarketplaceLocksCorrelation).mockResolvedValue(makeCorrelation(true) as never);
    vi.mocked(CommerceController.unlockMarketplaceLocksContent).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentPath: 'downloads/premium.txt',
    });
    const objectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');

    const { result } = renderHook(() =>
      useMarketplaceLocksPayment({
        order: createOrderFixture('paid'),
        payment: confirmed,
        digitalLock,
        isBuyer: true,
        onPaymentChanged: vi.fn(),
      }),
    );

    await act(async () => {
      expect(await result.current.unlock()).toBe(true);
    });

    expect(CommerceController.unlockMarketplaceLocksContent).toHaveBeenCalledWith(confirmed.id);
    expect(result.current.delivery).toEqual({ objectUrl: 'blob:mock-url', fileName: 'premium.txt', byteSize: 4 });
    objectUrlSpy.mockRestore();
  });

  it('polls the payment status boundedly while a registered correlation awaits verification', async () => {
    vi.mocked(CommerceController.getMarketplaceLocksCorrelation).mockResolvedValue(
      makeCorrelation(true, new Date(Date.now() + 60_000).toISOString()) as never,
    );
    const onPaymentChanged = vi.fn();

    const { unmount } = renderHook(() =>
      useMarketplaceLocksPayment({ order, payment, digitalLock, isBuyer: true, onPaymentChanged }),
    );

    await waitFor(() => expect(onPaymentChanged).toHaveBeenCalled());

    // Abortable: unmounting stops the poll.
    const callsAtUnmount = onPaymentChanged.mock.calls.length;
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(onPaymentChanged.mock.calls.length).toBe(callsAtUnmount);
  });

  it('stops polling once the payment window bound has elapsed and resumes on request', async () => {
    vi.mocked(CommerceController.getMarketplaceLocksCorrelation).mockResolvedValue(
      // A window that elapsed long ago (beyond the one-minute grace).
      makeCorrelation(true, new Date(Date.now() - 3_600_000).toISOString()) as never,
    );
    const onPaymentChanged = vi.fn();

    const { result } = renderHook(() =>
      useMarketplaceLocksPayment({ order, payment, digitalLock, isBuyer: true, onPaymentChanged }),
    );

    await waitFor(() => expect(result.current.pollExhausted).toBe(true));
    expect(onPaymentChanged).not.toHaveBeenCalled();

    act(() => result.current.resumePolling());
    expect(result.current.pollExhausted).toBe(false);
  });
});
