import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { USD_ASSET } from '@/libs/commerce/pricing';
import { useMarketplaceBid } from './useMarketplaceBid';
import { marketplaceBidMinimum } from './useMarketplaceBid.types';

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    executeMarketplaceCommand: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

describe('useMarketplaceBid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000810');
  });

  it('computes the visible-price floor for a first-time bidder', () => {
    expect(marketplaceBidMinimum(100, 1)).toBe(101);
  });

  it('accepts a maximum exactly equal to the minimum', async () => {
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000810',
      aggregateId: 'listing:seller_item',
      revision: 4,
      eventIds: ['00000000-0000-4000-8000-000000000811'],
      result: { kind: 'bid' },
    });
    const { result } = renderHook(() =>
      useMarketplaceBid('listing:seller_item', 3, vi.fn(), USD_ASSET, 'live', {
        currentPrice: { amountMinor: 100 },
        minimumIncrement: { amountMinor: 1 },
      }),
    );
    act(() => result.current.form.setValue('maximumAmount', '1.01'));

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalled();
  });

  it('uses the bidder viewer minimum and refuses one minor unit below it', async () => {
    const onConflict = vi.fn();
    const { result } = renderHook(() =>
      useMarketplaceBid('listing:seller_item', 3, onConflict, USD_ASSET, 'live', {
        currentPrice: { amountMinor: 4_500 },
        minimumIncrement: { amountMinor: 500 },
        viewerBid: {
          maximumAmount: { amountMinor: 7_000, currency: 'USD', exponent: 2 },
          minimumNextBid: { amountMinor: 7_001, currency: 'USD', exponent: 2 },
        },
      }),
    );
    act(() => result.current.form.setValue('maximumAmount', '70.00'));

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(result.current.form.getFieldState('maximumAmount').error?.message).toBe(
      'Your maximum must exceed your own current proxy maximum.',
    );
    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });

  it('accepts a maximum equal to the bidder viewer minimum', async () => {
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000810',
      aggregateId: 'listing:seller_item',
      revision: 4,
      eventIds: ['00000000-0000-4000-8000-000000000811'],
      result: { kind: 'bid' },
    });
    const { result } = renderHook(() =>
      useMarketplaceBid('listing:seller_item', 3, vi.fn(), USD_ASSET, 'live', {
        currentPrice: { amountMinor: 4_500 },
        minimumIncrement: { amountMinor: 500 },
        viewerBid: {
          maximumAmount: { amountMinor: 7_000, currency: 'USD', exponent: 2 },
          minimumNextBid: { amountMinor: 7_001, currency: 'USD', exponent: 2 },
        },
      }),
    );
    act(() => result.current.form.setValue('maximumAmount', '70.01'));

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalled();
  });

  it('submits a private proxy maximum at the authoritative auction revision', async () => {
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000810',
      aggregateId: 'listing:seller_item',
      revision: 4,
      eventIds: ['00000000-0000-4000-8000-000000000811'],
      result: { kind: 'bid' },
    });
    const { result } = renderHook(() => useMarketplaceBid('listing:seller_item', 3, vi.fn(), USD_ASSET));
    act(() => result.current.form.setValue('maximumAmount', '150.00'));

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: 'listing:seller_item',
        expectedRevision: 3,
        kind: 'auction.place_bid',
        payload: {
          maximumAmount: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
        },
      }),
    );
  });

  it('refuses to submit after the shared auction phase ends', async () => {
    const { result } = renderHook(() => useMarketplaceBid('listing:seller_item', 3, vi.fn(), USD_ASSET, 'ended'));
    act(() => result.current.form.setValue('maximumAmount', '150.00'));

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });

  it('refetches the projection and asks for a retry on a revision conflict', async () => {
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.', currentRevision: 5 },
    });
    const onConflict = vi.fn();
    const { result } = renderHook(() => useMarketplaceBid('listing:seller_item', 3, onConflict, USD_ASSET));
    act(() => result.current.form.setValue('maximumAmount', '150.00'));

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(onConflict).toHaveBeenCalledTimes(1);
    const { toast } = await import('@/molecules/Toaster/use-toast');
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('changed') }),
    );
  });

  it('maps server and thrown sentinel failures to static copy', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_bid';
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const { result } = renderHook(() => useMarketplaceBid('listing:seller_item', 3, vi.fn(), USD_ASSET));
    act(() => result.current.form.setValue('maximumAmount', '150.00'));

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

  it.each([
    ['BID_TOO_LOW', 'A new proxy maximum must exceed the bidder previous maximum.', 'Your new maximum'],
    ['UNAUTHORIZED', 'A seller cannot bid on their own auction.', 'You cannot bid'],
    ['REVISION_CONFLICT', 'The auction revision is stale.', 'auction changed'],
    ['INVALID_STATE', 'The auction is not open for bidding.', 'no longer open'],
  ] as const)('maps %s to typed static copy', async (code, message, expected) => {
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const { result } = renderHook(() => useMarketplaceBid('listing:seller_item', 3, vi.fn(), USD_ASSET));
    act(() => result.current.form.setValue('maximumAmount', '150.00'));
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValueOnce({
      ok: false,
      error: { code, message },
    });

    await act(async () => {
      await result.current.submit();
    });

    expect(vi.mocked(toast).mock.calls.at(-1)?.[0]?.description).toContain(expected);
  });
});
