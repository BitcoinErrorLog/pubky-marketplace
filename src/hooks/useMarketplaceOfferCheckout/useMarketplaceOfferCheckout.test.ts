import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceOffer } from '@/services/marketplace/marketplace';
import { useMarketplaceOfferCheckout } from './useMarketplaceOfferCheckout';

const errorState = vi.hoisted(() => ({ sessionRequired: false }));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceOffers: vi.fn(),
    commitOfferCheckout: vi.fn(),
    bindPaymentMethod: vi.fn(),
    executeMarketplaceCommand: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/libs/error/error.utils', () => ({
  isMarketplaceSessionRequiredError: () => errorState.sessionRequired,
}));

const offer: MarketplaceOffer = {
  id: '00000000-0000-4000-8000-000000000701',
  aggregateId: 'offer:00000000-0000-4000-8000-000000000701',
  listingAggregateId: `listing:${'s'.repeat(52)}_boots`,
  buyerPubky: 'b'.repeat(52),
  sellerPubky: 's'.repeat(52),
  revision: 7,
  state: 'accepted',
  offeredBy: 'b'.repeat(52),
  amount: { amountMinor: 600, currency: 'USD', exponent: 2 },
  quantity: 2,
  message: 'Accepted',
  expiresAt: '2026-09-15T12:00:00.000Z',
  updatedAt: '2026-09-15T10:00:00.000Z',
  award: {
    id: '00000000-0000-4000-8000-000000000702',
    state: 'active',
    listing: {
      aggregateId: `listing:${'s'.repeat(52)}_boots`,
      sellerPubky: 's'.repeat(52),
      listingId: 'boots',
      title: 'Vintage boots',
      listingRevision: 3,
      listingRecordSha256: 'a'.repeat(64),
    },
    variant: { id: 'variant_42', sku: 'boots-42', options: [{ name: 'Size', value: '42' }] },
    unitPrice: { amountMinor: 300, currency: 'USD', exponent: 2 },
    quantity: 2,
    acceptedAt: '2026-09-15T10:00:00.000Z',
    convertBy: '2026-09-15T12:00:00.000Z',
    convertedOrderId: null,
    subtotal: { amountMinor: 600, currency: 'USD', exponent: 2 },
    shipping: { amountMinor: 100, currency: 'USD', exponent: 2 },
    merchandiseTotal: { amountMinor: 700, currency: 'USD', exponent: 2 },
    fulfillmentMethods: ['shipping'],
  },
};

const address = {
  name: 'Alice Buyer',
  line1: '1 Market Street',
  line2: '',
  city: 'New York',
  region: 'NY',
  postalCode: '10001',
  countryCode: 'US',
};

function committedPayload(): Record<string, unknown> | undefined {
  const command = vi.mocked(CommerceController.commitOfferCheckout).mock.calls[0]?.[0] as
    | { payload: Record<string, unknown> }
    | undefined;
  return command?.payload;
}

describe('useMarketplaceOfferCheckout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    errorState.sessionRequired = false;
    vi.mocked(CommerceController.getMarketplaceOffers).mockResolvedValue([offer]);
    vi.mocked(CommerceController.commitOfferCheckout).mockResolvedValue({
      ok: true,
      result: { order: { id: '00000000-0000-4000-8000-000000000703' } },
    } as never);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000704');
  });

  it('re-reads the accepted projection and submits its locked award terms', async () => {
    const completed = vi.fn();
    const { result } = renderHook(() => useMarketplaceOfferCheckout(completed));

    await act(async () => {
      await expect(result.current.submit(offer, address)).resolves.toEqual({
        ok: true,
        orderId: '00000000-0000-4000-8000-000000000703',
        boundOrder: null,
      });
    });

    expect(CommerceController.getMarketplaceOffers).toHaveBeenCalledTimes(1);
    expect(CommerceController.commitOfferCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 7,
        payload: expect.objectContaining({
          offerId: offer.id,
          awardId: offer.award?.id,
          variantId: 'variant_42',
          quantity: 2,
        }),
      }),
    );
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('sends a shipped award exactly as before: the address and no fulfillment field', async () => {
    const { result } = renderHook(() => useMarketplaceOfferCheckout());
    await act(async () => {
      await result.current.submit(offer, address);
    });
    const payload = committedPayload();
    expect(payload).toMatchObject({ deliveryAddress: address });
    expect(payload).not.toHaveProperty('fulfillment');
  });

  it('settles a pickup award with fulfillment pickup and no delivery address', async () => {
    const { result } = renderHook(() => useMarketplaceOfferCheckout());
    await act(async () => {
      await expect(result.current.submit(offer, null)).resolves.toMatchObject({ ok: true });
    });
    const payload = committedPayload();
    expect(payload).toMatchObject({ fulfillment: 'pickup' });
    expect(payload).not.toHaveProperty('deliveryAddress');
  });

  it.each([
    ['AWARD_EXPIRED', 'This accepted offer expired before checkout. Nothing was reserved.'],
    ['AWARD_ALREADY_CONVERTED', 'This accepted offer has already been converted.'],
    ['REVISION_CONFLICT', 'This accepted offer has already been converted.'],
    ['AWARD_QUANTITY_MISMATCH', 'The checkout quantity does not match the accepted offer.'],
    ['AWARD_VARIANT_MISMATCH', 'The checkout variant does not match the accepted offer.'],
    ['AWARD_LISTING_CHANGED', 'The listing snapshot does not match the offer terms.'],
    ['AWARD_HOLD_MISSING', 'The inventory reserved for this accepted offer is no longer held.'],
    ['INVALID_STATE', 'Only an accepted offer can enter offer checkout.'],
    ['OTHER', 'Checkout could not be completed.'],
  ])('maps %s to static copy', async (code, description) => {
    vi.mocked(CommerceController.commitOfferCheckout).mockResolvedValue({
      ok: false,
      error: { code, message: 'server text must not escape' },
    } as never);
    const { result } = renderHook(() => useMarketplaceOfferCheckout());

    await act(async () => {
      await expect(result.current.submit(offer, address)).resolves.toEqual({ ok: false, code });
    });

    const { toast } = await import('@/molecules/Toaster/use-toast');
    expect(vi.mocked(toast)).toHaveBeenCalledWith({ variant: 'error', description });
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain('server text must not escape');
  });

  it('refuses an unavailable award without submitting', async () => {
    vi.mocked(CommerceController.getMarketplaceOffers).mockResolvedValue([
      { ...offer, award: { ...offer.award!, state: 'expired' } },
    ]);
    const { result } = renderHook(() => useMarketplaceOfferCheckout());

    await act(async () => {
      await expect(result.current.submit(offer, address)).resolves.toEqual({ ok: false, code: 'AWARD_UNAVAILABLE' });
    });

    expect(CommerceController.commitOfferCheckout).not.toHaveBeenCalled();
  });

  it('does not submit stale terms when the participant projection cannot be re-read', async () => {
    vi.mocked(CommerceController.getMarketplaceOffers).mockRejectedValue(new Error('projection unavailable'));
    const { result } = renderHook(() => useMarketplaceOfferCheckout());

    await act(async () => {
      await expect(result.current.submit(offer, address)).resolves.toEqual({ ok: false, code: 'AWARD_UNAVAILABLE' });
    });

    expect(CommerceController.commitOfferCheckout).not.toHaveBeenCalled();
  });

  it('surfaces reconnect when the participant projection re-read requires a session', async () => {
    errorState.sessionRequired = true;
    vi.mocked(CommerceController.getMarketplaceOffers).mockRejectedValue(new Error('session expired'));
    const { result } = renderHook(() => useMarketplaceOfferCheckout());

    await act(async () => {
      await expect(result.current.submit(offer, address)).resolves.toEqual({ ok: false, code: 'SESSION_REQUIRED' });
    });

    expect(CommerceController.commitOfferCheckout).not.toHaveBeenCalled();
  });

  it('does not submit when the refreshed projection no longer contains the offer', async () => {
    vi.mocked(CommerceController.getMarketplaceOffers).mockResolvedValue([]);
    const { result } = renderHook(() => useMarketplaceOfferCheckout());

    await act(async () => {
      await expect(result.current.submit(offer, address)).resolves.toEqual({ ok: false, code: 'AWARD_UNAVAILABLE' });
    });

    expect(CommerceController.commitOfferCheckout).not.toHaveBeenCalled();
  });

  it('allows only one in-flight checkout command', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    vi.mocked(CommerceController.commitOfferCheckout).mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }) as never,
    );
    const { result } = renderHook(() => useMarketplaceOfferCheckout());

    let first: Promise<unknown> | undefined;
    await act(async () => {
      first = result.current.submit(offer, address);
      await Promise.resolve();
      await expect(result.current.submit(offer, address)).resolves.toEqual({ ok: false, code: 'SUBMITTING' });
    });
    resolve?.({ ok: true, result: { order: { id: '00000000-0000-4000-8000-000000000703' } } });
    await act(async () => {
      await first;
    });
    expect(CommerceController.commitOfferCheckout).toHaveBeenCalledTimes(1);
  });
});
