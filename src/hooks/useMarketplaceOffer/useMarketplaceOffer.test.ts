import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { USD_ASSET } from '@/libs/commerce/pricing';
import { useMarketplaceOffer } from './useMarketplaceOffer';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    executeMarketplaceCommand: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

describe('useMarketplaceOffer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000800');
  });

  it('submits private offer terms against the current listing revision', async () => {
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000800',
      aggregateId: 'listing:seller_item',
      revision: 1,
      eventIds: ['00000000-0000-4000-8000-000000000801'],
      result: { kind: 'offer' },
    });
    const { result } = renderHook(() => useMarketplaceOffer('listing:seller_item', 3, vi.fn(), USD_ASSET));
    act(() => {
      result.current.form.setValue('amount', '100.00');
      result.current.form.setValue('quantity', '2');
      result.current.form.setValue('message', 'Would you take this?');
    });

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: 'listing:seller_item',
        expectedRevision: 3,
        kind: 'offer.create',
        payload: {
          amount: { amountMinor: 10_000, currency: 'USD', exponent: 2 },
          quantity: 2,
          expiresInSeconds: 86_400,
          message: 'Would you take this?',
        },
      }),
    );
  });

  it('does not submit without an authoritative revision', async () => {
    const { result } = renderHook(() => useMarketplaceOffer('listing:seller_item', null, vi.fn(), USD_ASSET));
    await expect(result.current.submit()).resolves.toBe(false);
    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });

  it('refuses an owned listing without calling the service', async () => {
    const { result } = renderHook(() => useMarketplaceOffer('listing:seller_item', 3, vi.fn(), USD_ASSET, true));
    await expect(result.current.submit()).resolves.toBe(false);
    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });

  it('refetches the projection and asks for a retry on a revision conflict', async () => {
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.', currentRevision: 4 },
    });
    const onConflict = vi.fn();
    const { result } = renderHook(() => useMarketplaceOffer('listing:seller_item', 3, onConflict, USD_ASSET));
    act(() => {
      result.current.form.setValue('amount', '100.00');
      result.current.form.setValue('quantity', '1');
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(onConflict).toHaveBeenCalledTimes(1);
    const { toast } = await import('@/molecules/Toaster/use-toast');
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('reloaded') }),
    );
  });

  it('maps server and thrown sentinel failures to static copy', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_offer';
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const { result } = renderHook(() => useMarketplaceOffer('listing:seller_item', 3, vi.fn(), USD_ASSET));
    act(() => {
      result.current.form.setValue('amount', '100.00');
      result.current.form.setValue('quantity', '1');
    });

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

  it('maps listing inventory refusals to listing copy, never drop sold-out copy', async () => {
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const { result } = renderHook(() => useMarketplaceOffer('listing:seller_item', 3, vi.fn(), USD_ASSET));
    act(() => {
      result.current.form.setValue('amount', '100.00');
      result.current.form.setValue('quantity', '1');
    });

    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INSUFFICIENT_INVENTORY', message: 'The drop is sold out.' },
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(vi.mocked(toast).mock.calls.at(-1)?.[0]?.description).toBe('This listing has sold out.');
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain('This drop is sold out.');
  });

  it('tells the buyer a pickup-only listing does not take offers', async () => {
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const { result } = renderHook(() => useMarketplaceOffer('listing:seller_item', 11, vi.fn(), USD_ASSET));
    act(() => {
      result.current.form.setValue('amount', '1.00');
      result.current.form.setValue('quantity', '1');
    });

    // The 409 production refused for issue #57 (offer.create, revision 11).
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INVALID_STATE', message: 'Offers are available only on listings that ship.' },
    });
    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(vi.mocked(toast).mock.calls.at(-1)?.[0]).toEqual({
      variant: 'error',
      description: 'This listing is local pickup only. Offers are available only on listings that ship.',
    });
  });
});
