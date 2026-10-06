import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceOffer } from '@/services/marketplace/marketplace';
import { useMarketplaceOffers } from './useMarketplaceOffers';

const SELLER = 'y'.repeat(52);
const BUYER = 'b'.repeat(52);
const offer: MarketplaceOffer = {
  id: '00000000-0000-4000-8000-000000000940',
  aggregateId: 'offer:00000000-0000-4000-8000-000000000940',
  listingAggregateId: `listing:${SELLER}_boots_01`,
  buyerPubky: BUYER,
  sellerPubky: SELLER,
  revision: 1,
  state: 'pending',
  offeredBy: BUYER,
  amount: { amountMinor: 10_000, currency: 'USD', exponent: 2 },
  quantity: 1,
  message: 'Would you take this?',
  expiresAt: '2026-08-20T23:00:00.000Z',
  updatedAt: '2026-08-19T23:00:00.000Z',
};

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommercePollIntervalMs: () => 60_000 };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) => selector({ currentUserPubky: SELLER }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceOffers: vi.fn(),
    executeMarketplaceCommand: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

describe('useMarketplaceOffers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CommerceController.getMarketplaceOffers).mockResolvedValue([offer]);
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000941',
      aggregateId: offer.aggregateId,
      revision: 2,
      eventIds: ['00000000-0000-4000-8000-000000000942'],
      result: { kind: 'offer' },
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000941');
  });

  it('accepts an incoming offer at its current revision', async () => {
    const { result } = renderHook(() => useMarketplaceOffers());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(() => result.current.act(offer, 'offer.accept'));

    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: offer.aggregateId,
        expectedRevision: 1,
        kind: 'offer.accept',
        payload: { offerId: offer.id },
      }),
    );
  });

  it('confirms a decline in one line', async () => {
    const { result } = renderHook(() => useMarketplaceOffers());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(() => result.current.act(offer, 'offer.reject'));

    expect(toast).toHaveBeenCalledWith({ title: 'Offer declined.' });
  });

  it('submits revised private counteroffer terms', async () => {
    const { result } = renderHook(() => useMarketplaceOffers());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => {
      result.current.form.setValue('amount', '110.00');
      result.current.form.setValue('quantity', '1');
      result.current.form.setValue('message', 'Meet me here.');
    });

    await act(() => result.current.counter(offer));

    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'offer.counter',
        payload: expect.objectContaining({
          offerId: offer.id,
          amount: { amountMinor: 11_000, currency: 'USD', exponent: 2 },
        }),
      }),
    );
  });

  it('refetches offers and asks for a retry on a revision conflict', async () => {
    const { result } = renderHook(() => useMarketplaceOffers());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.', currentRevision: 2 },
    });
    vi.mocked(CommerceController.getMarketplaceOffers).mockClear();

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.act(offer, 'offer.accept');
    });

    expect(succeeded).toBe(false);
    expect(CommerceController.getMarketplaceOffers).toHaveBeenCalled();
    const { toast } = await import('@/molecules/Toaster/use-toast');
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('reloaded') }),
    );
  });

  it('maps server and thrown sentinel failures to static copy', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_offers';
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const { result } = renderHook(() => useMarketplaceOffers());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INVALID_STATE', message: sentinel },
    });
    await act(async () => {
      await result.current.act(offer, 'offer.accept');
    });
    expect(vi.mocked(toast).mock.calls[0]?.[0]?.description).toBeTypeOf('string');
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);

    vi.mocked(CommerceController.executeMarketplaceCommand).mockRejectedValueOnce(
      new AppError({
        category: ErrorCategory.Client,
        code: ClientErrorCode.CONFLICT,
        message: sentinel,
        service: ErrorService.Marketplace,
        operation: 'respondToOffer',
      }),
    );
    await act(async () => {
      await result.current.act(offer, 'offer.accept');
    });
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);
  });
});
