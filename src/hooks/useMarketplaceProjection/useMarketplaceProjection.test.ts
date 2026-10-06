import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceProjection } from './useMarketplaceProjection';

const config = vi.hoisted(() => ({
  mode: 'sandbox' as string,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode, getCommercePollIntervalMs: () => 60_000 };
});

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceListingProjection: vi.fn(),
    syncListingRegistration: vi.fn(),
    cacheMarketplaceListingProjection: vi.fn(),
  },
}));

describe('useMarketplaceProjection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.mode = 'sandbox';
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue({
      aggregateId: 'listing:seller_item',
      sellerPubky: 'y'.repeat(52),
      listingId: 'item',
      listingRevision: 1,
      contentHash: 'c'.repeat(64),
      serverRevision: 2,
      state: 'available',
      availableQuantity: 1,
      reservedQuantity: 0,
      unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      saleFormat: 'auction',
      fulfillmentMethods: ['shipping'],
      auction: {
        startsAt: '2026-08-19T20:00:00.000Z',
        endsAt: '2026-08-29T20:00:00.000Z',
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        currentPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
        leaderPubky: null,
        bidCount: 0,
      },
    });
  });

  it('exposes the authoritative sandbox listing projection', async () => {
    const { result } = renderHook(() => useMarketplaceProjection('y'.repeat(52), 'item'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(CommerceController.getMarketplaceListingProjection).toHaveBeenCalled();
    expect(result.current.projection).toMatchObject({
      serverRevision: 2,
      auction: { currentPrice: { amountMinor: 4_500 }, bidCount: 0 },
    });
    expect(result.current.error).toBeNull();
  });

  it('loads the projection in transaction-service mode — the revision source for every command', async () => {
    config.mode = 'transaction-service';
    const { result } = renderHook(() => useMarketplaceProjection('y'.repeat(52), 'item'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(CommerceController.getMarketplaceListingProjection).toHaveBeenCalled();
    expect(result.current.projection).toMatchObject({ serverRevision: 2 });
  });

  it('caches zero available quantity so listing consumers render sold out', async () => {
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValueOnce({
      aggregateId: `listing:${'y'.repeat(52)}_item`,
      sellerPubky: 'y'.repeat(52),
      listingId: 'item',
      listingRevision: 1,
      contentHash: 'c'.repeat(64),
      serverRevision: 3,
      state: 'sold',
      availableQuantity: 0,
      reservedQuantity: 0,
      unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      saleFormat: 'fixed_price',
      fulfillmentMethods: ['shipping'],
      auction: null,
    });

    const { result } = renderHook(() => useMarketplaceProjection('y'.repeat(52), 'item'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(CommerceController.cacheMarketplaceListingProjection).toHaveBeenCalledWith(
      expect.objectContaining({ available_quantity: 0, state: 'sold' }),
    );
  });

  it('heals an unregistered listing with one service-side sync, then re-reads', async () => {
    config.mode = 'transaction-service';
    const registered = {
      aggregateId: `listing:${'y'.repeat(52)}_item`,
      listingRevision: 1,
      contentHash: 'c'.repeat(64),
      serverRevision: 1,
    };
    vi.mocked(CommerceController.getMarketplaceListingProjection)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(registered as never);
    vi.mocked(CommerceController.syncListingRegistration).mockResolvedValue({ ok: true, revision: 1 } as never);

    const { result } = renderHook(() => useMarketplaceProjection('y'.repeat(52), 'item'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(CommerceController.syncListingRegistration).toHaveBeenCalledTimes(1);
    expect(CommerceController.syncListingRegistration).toHaveBeenCalledWith('y'.repeat(52), 'item');
    expect(CommerceController.getMarketplaceListingProjection).toHaveBeenCalledTimes(2);
    expect(result.current.projection).toMatchObject({ serverRevision: 1 });
    expect(result.current.error).toBeNull();
  });

  it('shows the honest copy when the sync also fails — the seller is not required for it', async () => {
    config.mode = 'transaction-service';
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue(null);
    vi.mocked(CommerceController.syncListingRegistration).mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: "The seller's homeserver has no such listing record." },
    } as never);

    const { result } = renderHook(() => useMarketplaceProjection('y'.repeat(52), 'item'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(CommerceController.syncListingRegistration).toHaveBeenCalledTimes(1);
    expect(result.current.projection).toBeNull();
    expect(result.current.error).toBe(
      'This listing could not be prepared for checkout. It may have been removed by the seller.',
    );
    expect(result.current.listingRemoved).toBe(false);
  });

  it('says the listing was removed when the sync reports the seller deleted it', async () => {
    config.mode = 'transaction-service';
    const aggregateId = `listing:${'y'.repeat(52)}_item`;
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue(null);
    vi.mocked(CommerceController.syncListingRegistration).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '018f47d2-6a27-7c23-a62f-000000000750',
      aggregateId,
      revision: 2,
      eventIds: [],
      result: { kind: 'listing_deleted', listing: { aggregateId, serverRevision: 2 } },
    } as never);

    const { result } = renderHook(() => useMarketplaceProjection('y'.repeat(52), 'item'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(CommerceController.syncListingRegistration).toHaveBeenCalledTimes(1);
    expect(CommerceController.getMarketplaceListingProjection).toHaveBeenCalledTimes(1);
    expect(result.current.projection).toBeNull();
    expect(result.current.error).toBe('This listing was removed.');
    expect(result.current.listingRemoved).toBe(true);
  });

  it('never attempts a sync in sandbox mode', async () => {
    config.mode = 'sandbox';
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue(null);

    const { result } = renderHook(() => useMarketplaceProjection('y'.repeat(52), 'item'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(CommerceController.syncListingRegistration).not.toHaveBeenCalled();
    expect(result.current.error).toBe(
      'This listing could not be prepared for checkout. It may have been removed by the seller.',
    );
  });

  it('surfaces the durable session requirement instead of a generic failure', async () => {
    config.mode = 'transaction-service';
    const sessionError = Object.assign(new Error('A marketplace session is required.'), { name: 'AppError' });
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockRejectedValue(sessionError);

    const { result } = renderHook(() => useMarketplaceProjection('y'.repeat(52), 'item'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('A marketplace session is required.');
  });

  it('ignores a late projection after switching listings and refetches the new key on focus', async () => {
    config.mode = 'transaction-service';
    let resolveFirst: ((value: never) => void) | undefined;
    const first = new Promise<never>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecond: ((value: never) => void) | undefined;
    const secondPending = new Promise<never>((resolve) => {
      resolveSecond = resolve;
    });
    const second = {
      aggregateId: 'listing:seller_second',
      listingId: 'second',
      serverRevision: 7,
    };
    vi.mocked(CommerceController.getMarketplaceListingProjection)
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(secondPending)
      .mockResolvedValue(second as never);

    const { result, rerender } = renderHook(({ listingId }) => useMarketplaceProjection('y'.repeat(52), listingId), {
      initialProps: { listingId: 'first' },
    });
    rerender({ listingId: 'second' });

    await waitFor(() => expect(result.current.isLoading).toBe(true));
    resolveSecond?.(second as never);
    await waitFor(() => expect(result.current.projection).toMatchObject({ listingId: 'second' }));
    expect(result.current.isLoading).toBe(false);
    resolveFirst?.({ aggregateId: 'listing:seller_first', listingId: 'first' } as never);
    await Promise.resolve();
    expect(result.current.projection).toMatchObject({ listingId: 'second' });

    window.dispatchEvent(new Event('focus'));
    await waitFor(() =>
      expect(CommerceController.getMarketplaceListingProjection).toHaveBeenLastCalledWith('y'.repeat(52), 'second'),
    );
  });

  it('loads nothing in modes without a transaction backend', async () => {
    config.mode = 'unavailable';
    const { result } = renderHook(() => useMarketplaceProjection('y'.repeat(52), 'item'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(CommerceController.getMarketplaceListingProjection).not.toHaveBeenCalled();
  });
});
