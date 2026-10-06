import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMERCE_LISTING_MAX_QUANTITY } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { commerceListingRecordSchema } from '@/libs/commerce/marketplace-records';
import { toast } from '@/molecules/Toaster/use-toast';
import { useEditMarketplaceListing } from './useEditMarketplaceListing';

const OWNER = 'y'.repeat(52);
const OTHER = 'z'.repeat(52);
const LISTING_ID = 'listing01';

const existingMedia = {
  id: 'image_01',
  type: 'image' as const,
  url: `pubky://${OWNER}/pub/pubky.app/marketplace/v1/media/image_01`,
  contentHash: 'a'.repeat(64),
  mimeType: 'image/jpeg',
  byteSize: 3,
  width: 1200,
  height: 1600,
  altText: 'Brown leather boots',
};

const publishedRecord = {
  schemaVersion: 1 as const,
  recordType: 'listing' as const,
  ownerPubky: OWNER,
  revision: 2,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
  listingId: LISTING_ID,
  state: 'active' as const,
  title: 'Vintage leather boots',
  description: 'Well cared for boots with light wear.',
  taxonomyVersion: 1 as const,
  categoryId: 'fashion',
  condition: 'good' as const,
  tags: ['vintage', 'leather', 'boots'],
  location: { countryCode: 'US', region: 'NY' },
  media: [existingMedia],
  variants: [
    {
      id: 'variant_1',
      options: { size: '42' },
      quantity: 3,
      mediaIds: ['image_01'],
      enabled: true,
    },
  ],
  sale: {
    format: 'fixed_price' as const,
    unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
    acceptsOffers: true,
  },
  fulfillmentMethods: ['pickup' as const],
  shippingOptions: [],
  returnPolicy: { acceptsReturns: true, returnWindowDays: 30, buyerPaysReturnShipping: true },
  adultOnly: false,
};

const authState = vi.hoisted(() => ({ currentUserPubky: 'y'.repeat(52) }));
const commerceState = vi.hoisted(() => ({ marketplaceSession: {} }));

vi.mock('@/config/commerce', async () => ({
  ...(await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce')),
  getCommerceAdapterMode: () => 'transaction-service',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (store: { currentUserPubky: string }) => unknown) => selector(authState),
}));

vi.mock('@/stores/commerce/commerce.store', () => ({
  useCommerceStore: (selector: (store: typeof commerceState) => unknown) => selector(commerceState),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getOrFetchListing: vi.fn(),
    getMarketplaceSellerListingProjection: vi.fn(),
    commitCreateMedia: vi.fn(),
    commitUpsertListing: vi.fn(async () => ({ registered: true, verified: true })),
    getMarketplaceMediaOwnerHomeserver: vi.fn(async () => null),
    getSellerPaymentConfig: vi.fn(async () => ({
      bitcoinAvailable: true,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    })),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

describe('useEditMarketplaceListing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.currentUserPubky = OWNER;
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue(structuredClone(publishedRecord));
    vi.mocked(CommerceController.getMarketplaceSellerListingProjection).mockResolvedValue(null);
    vi.mocked(CommerceController.getSellerPaymentConfig).mockResolvedValue({
      bitcoinAvailable: true,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    });
  });

  it('hydrates the form and photos from the published record', async () => {
    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));

    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.form.getValues()).toMatchObject({
      title: 'Vintage leather boots',
      price: '125.00',
      fulfillment: 'pickup',
      returnDays: '30',
      variants: [{ size: '42', quantity: '3' }],
    });
    expect(result.current.media.items).toEqual([
      expect.objectContaining({ kind: 'existing', key: 'image_01', altText: 'Brown leather boots' }),
    ]);
    expect(result.current.saleTermsLocked).toBe(false);
    expect(CommerceController.getMarketplaceSellerListingProjection).not.toHaveBeenCalled();
  });

  it('republishes the same listing with a bumped revision and reused media', async () => {
    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => {
      result.current.form.setValue('title', 'Vintage leather boots — resoled');
      result.current.form.setValue('price', '150.00');
    });

    let savedId: string | null = null;
    await act(async () => {
      savedId = await result.current.submit();
    });

    expect(savedId).toBe(`${OWNER}:${LISTING_ID}`);
    // No new photos were added, so nothing re-uploads.
    expect(CommerceController.commitCreateMedia).not.toHaveBeenCalled();
    const updated = vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][0];
    expect(commerceListingRecordSchema.safeParse(updated).success).toBe(true);
    expect(updated).toMatchObject({
      ownerPubky: OWNER,
      listingId: LISTING_ID,
      revision: 3,
      createdAt: publishedRecord.createdAt,
      state: 'active',
      title: 'Vintage leather boots — resoled',
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 15_000 }, acceptsOffers: true },
      media: [{ id: 'image_01' }],
    });
  });

  it('reports an acked edit whose read-back lags as saved and pending, never as failed', async () => {
    vi.mocked(CommerceController.commitUpsertListing).mockResolvedValueOnce({ registered: false, verified: false });
    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let savedId: string | null = null;
    await act(async () => {
      savedId = await result.current.submit();
    });

    expect(savedId).toBe(`${OWNER}:${LISTING_ID}`);
    expect(toast).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Changes saved — confirmation pending' }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
  });

  it('refuses to publish when the seller has no payment method', async () => {
    vi.mocked(CommerceController.getSellerPaymentConfig).mockResolvedValue({
      bitcoinAvailable: false,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    });
    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.publishBlocked).toBe('no-method');
    expect(CommerceController.commitUpsertListing).not.toHaveBeenCalled();
  });

  it('refuses to publish when the public payment-config request is rejected', async () => {
    vi.mocked(CommerceController.getSellerPaymentConfig).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.publishBlocked).toBe('unverified');
    expect(CommerceController.commitUpsertListing).not.toHaveBeenCalled();
  });

  it('hydrates a free-shipping listing and re-emits the free variant (no price) on save', async () => {
    const freeShippingRecord = {
      ...structuredClone(publishedRecord),
      fulfillmentMethods: ['shipping' as const],
      package: { weightGrams: 500, lengthMillimeters: 300, widthMillimeters: 200, heightMillimeters: 100 },
      shippingOptions: [
        {
          id: 'seller_flat_rate',
          pricing: 'free' as const,
          label: 'Free shipping',
          estimatedMinDays: 2,
          estimatedMaxDays: 5,
        },
      ],
    };
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue(freeShippingRecord);

    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.form.getValues()).toMatchObject({
      fulfillment: 'shipping',
      freeShipping: true,
      shippingLabel: 'Free shipping',
      shippingPrice: '',
      shippingMinDays: '2',
      shippingMaxDays: '5',
    });

    let savedId: string | null = null;
    await act(async () => {
      savedId = await result.current.submit();
    });

    expect(savedId).toBe(`${OWNER}:${LISTING_ID}`);
    const updated = commerceListingRecordSchema.parse(
      vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][0],
    );
    expect(updated.shippingOptions).toEqual([
      expect.objectContaining({ pricing: 'free', label: 'Free shipping', estimatedMinDays: 2, estimatedMaxDays: 5 }),
    ]);
    expect(updated.shippingOptions[0]).not.toHaveProperty('price');
  });

  it('round-trips unknown record members through an edit (open-world records)', async () => {
    // A member added by a newer writer that this client knows nothing about
    // must survive a read-modify-write untouched (social/v1 alignment).
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue(
      structuredClone({ ...publishedRecord, futureField: { promo: 'launch-week' } }),
    );
    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => {
      result.current.form.setValue('title', 'Vintage leather boots — resoled');
    });
    await act(async () => {
      await result.current.submit();
    });

    const updated = vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][0] as Record<string, unknown>;
    expect(updated.futureField).toEqual({ promo: 'launch-week' });
    expect(updated.title).toBe('Vintage leather boots — resoled');
  });

  it('hydrates structured attributes into the form and preserves foreign attributes verbatim', async () => {
    const recordWithAttributes = {
      ...structuredClone(publishedRecord),
      taxonomyVersion: 2,
      categoryId: 'fashion-men-tops-hoodies',
      attributes: {
        size: 'L',
        brand: 'Champion',
        color: ['grey', 'navy'],
        // A vocabulary value this build does not know: not form-manageable.
        source: 'estate-sale',
        // A key this build's taxonomy does not define at all.
        'graded-by': 'PSA 9',
      },
    };
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue(recordWithAttributes);

    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.form.getValues()).toMatchObject({
      categoryId: 'fashion-men-tops-hoodies',
      attrSize: 'L',
      attrBrand: 'Champion',
      attrColors: ['grey', 'navy'],
      // The foreign source value stays out of the form (it would fail the
      // vocabulary validation) — it is preserved outside it instead.
      attrSource: '',
    });

    act(() => {
      result.current.form.setValue('title', 'Heavyweight varsity fleece — washed');
      result.current.form.setValue('attrSize', 'XL');
    });

    await act(async () => {
      await result.current.submit();
    });

    const updated = vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][0];
    expect(commerceListingRecordSchema.safeParse(updated).success).toBe(true);
    expect(updated).toMatchObject({
      revision: 3,
      attributes: {
        size: 'XL',
        brand: 'Champion',
        color: ['grey', 'navy'],
        source: 'estate-sale',
        'graded-by': 'PSA 9',
      },
    });
  });

  it('preserves auction sale terms verbatim when editing an auction', async () => {
    // Auctions are shipping-only (local pickup design §A2), so the auction
    // record carries the shipped-listing vocabulary with its package facts.
    const auctionRecord = {
      ...structuredClone(publishedRecord),
      sale: {
        format: 'auction' as const,
        startingPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        minimumIncrement: { amountMinor: 625, currency: 'USD', exponent: 2 },
        startsAt: '2026-08-01T10:00:00.000Z',
        endsAt: '2026-08-08T10:00:00.000Z',
        antiSnipingWindowSeconds: 120,
        antiSnipingExtensionSeconds: 120,
      },
      fulfillmentMethods: ['physical' as const],
      package: { weightGrams: 1_200, lengthMillimeters: 350, widthMillimeters: 250, heightMillimeters: 150 },
      shippingOptions: [
        {
          id: 'seller_flat_rate',
          pricing: 'flat' as const,
          label: 'Standard shipping',
          price: { amountMinor: 1_200, currency: 'USD', exponent: 2 },
          estimatedMinDays: 3,
          estimatedMaxDays: 7,
        },
      ],
    };
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue(auctionRecord);
    vi.mocked(CommerceController.getMarketplaceSellerListingProjection).mockResolvedValue({
      reservePrice: { amountMinor: 200_000, currency: 'USD', exponent: 2 },
    } as never);

    const { result, unmount } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.saleTermsLocked).toBe(true);
    expect(result.current.form.getValues('reservePrice')).toBe('2000.00');

    act(() => {
      result.current.form.setValue('description', 'Updated description with more provenance detail.');
      // A hostile or accidental price change must not alter published terms.
      result.current.form.setValue('price', '999.00');
    });

    await act(async () => {
      await result.current.submit();
    });

    const updated = vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][0];
    expect(updated).toMatchObject({ revision: 3, sale: auctionRecord.sale });
    expect(vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][1]).toEqual({
      amountMinor: 200_000,
      currency: 'USD',
      exponent: 2,
    });

    act(() => {
      result.current.form.setValue('reservePrice', '');
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(vi.mocked(CommerceController.commitUpsertListing).mock.calls[1][1]).toBeNull();

    unmount();
    vi.mocked(CommerceController.commitUpsertListing).mockClear();
    vi.mocked(CommerceController.getMarketplaceSellerListingProjection).mockResolvedValue(null);
    const withoutProjection = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(withoutProjection.result.current.status).toBe('ready'));
    await act(async () => {
      await withoutProjection.result.current.submit();
    });
    expect(vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][1]).toBeUndefined();
  });

  it('refuses to edit another seller’s listing', async () => {
    authState.currentUserPubky = OTHER;
    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));

    await waitFor(() => expect(result.current.status).toBe('not-owner'));
    expect(CommerceController.getOrFetchListing).not.toHaveBeenCalled();
  });

  it('hydrates unlimited stock only when a digital-only variant is at the quantity cap', async () => {
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue({
      ...structuredClone(publishedRecord),
      fulfillmentMethods: ['digital' as const],
      package: undefined,
      shippingOptions: [],
      variants: [{ ...publishedRecord.variants[0], quantity: COMMERCE_LISTING_MAX_QUANTITY }],
    });
    const digital = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(digital.result.current.status).toBe('ready'));
    // No number is carried: leaving digital-only must not inherit the cap as physical stock.
    expect(digital.result.current.form.getValues('variants')[0]).toMatchObject({ unlimited: true, quantity: '' });
    digital.unmount();

    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue({
      ...structuredClone(publishedRecord),
      variants: [{ ...publishedRecord.variants[0], quantity: COMMERCE_LISTING_MAX_QUANTITY }],
    });
    const physical = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(physical.result.current.status).toBe('ready'));
    expect(physical.result.current.form.getValues('variants')[0].unlimited).toBe(false);
  });

  it('hydrates a digital-only listing (digital delivery design §2)', async () => {
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue({
      ...structuredClone(publishedRecord),
      fulfillmentMethods: ['digital' as const],
      package: undefined,
      shippingOptions: [],
    });

    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.form.getValues('fulfillment')).toBe('digital');
  });

  it('hydrates a listing that ships and delivers digitally', async () => {
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue({
      ...structuredClone(publishedRecord),
      fulfillmentMethods: ['physical' as const, 'shipping' as const, 'digital' as const],
    });

    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.form.getValues('fulfillment')).toBe('shipping_and_digital');
  });

  it('refuses Locks listings the studio cannot author', async () => {
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue({
      ...structuredClone(publishedRecord),
      fulfillmentMethods: ['digital' as const],
      digitalLock: {
        policyUri: `pubky://${OWNER}/pub/locks.app/policy.json`,
        criterionId: 'criterion-1',
        contentPath: 'content/file.bin',
        resourceHash: 'b'.repeat(64),
        minimumConfirmations: 1,
      },
    });

    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));
    await waitFor(() => expect(result.current.status).toBe('unsupported'));
  });

  it('reports not-found when the record cannot be loaded', async () => {
    vi.mocked(CommerceController.getOrFetchListing).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useEditMarketplaceListing(OWNER, LISTING_ID));

    await waitFor(() => expect(result.current.status).toBe('not-found'));
  });
});
