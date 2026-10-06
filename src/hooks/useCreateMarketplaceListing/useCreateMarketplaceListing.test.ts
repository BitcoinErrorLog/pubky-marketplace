import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMERCE_LISTING_MAX_QUANTITY } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  LISTING_DRAFT_AUTOSAVE_MS,
  LISTING_DRAFT_RESUME_STORAGE_KEY,
  markListingDraftResumeId,
} from '@/libs/commerce/listing-drafts';
import { commerceListingRecordSchema } from '@/libs/commerce/marketplace-records';
import type { CommerceListingDraftModelSchema } from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import {
  buildListingVariants,
  normalizeDraftForm,
  seedDraftFormFromListing,
  useCreateMarketplaceListing,
} from './useCreateMarketplaceListing';
import { createMarketplaceListingSchema } from './useCreateMarketplaceListing.types';

const OWNER = 'y'.repeat(52);

vi.mock('@/config/commerce', async () => ({
  ...(await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce')),
  getCommerceAdapterMode: () => 'transaction-service',
}));
const mediaState = vi.hoisted(() => ({
  prepared: true,
  items: [] as Array<{
    key: string;
    kind: 'new';
    file: File;
    previewUrl: string;
    altText: string;
  }>,
}));
const mediaFns = vi.hoisted(() => ({
  restore: vi.fn(),
  reset: vi.fn(),
}));

const coverRecord = {
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

const secondRecord = {
  ...coverRecord,
  id: 'image_02',
  url: `pubky://${OWNER}/pub/pubky.app/marketplace/v1/media/image_02`,
  contentHash: 'b'.repeat(64),
  altText: 'Boot soles showing light wear',
};

const commerceState = vi.hoisted(() => ({
  marketplaceSession: {
    pubky: 'y'.repeat(52),
    capabilities: '/pub/pubky.app/:rw',
    issuedAt: '2026-08-21T12:00:00.000Z',
    expiresAt: '2026-09-21T12:00:00.000Z',
  } as { pubky: string; capabilities: string; issuedAt: string; expiresAt: string } | null,
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (store: { currentUserPubky: string }) => unknown) => selector({ currentUserPubky: OWNER }),
}));

vi.mock('@/stores/commerce/commerce.store', () => ({
  useCommerceStore: Object.assign((selector: (store: typeof commerceState) => unknown) => selector(commerceState), {
    getState: () => commerceState,
  }),
}));

vi.mock('@/hooks/useListingMediaManager/useListingMediaManager', () => ({
  useListingMediaManager: () => ({
    items: mediaState.items,
    maxPhotos: 8,
    error: null,
    inputRef: { current: null },
    onInputChange: vi.fn(),
    choose: vi.fn(),
    removeItem: vi.fn(),
    moveItem: vi.fn(),
    setAltText: vi.fn(),
    seed: vi.fn(),
    restore: mediaFns.restore,
    reset: mediaFns.reset,
    prepare: vi.fn(async () =>
      mediaState.prepared
        ? {
            ok: true,
            media: [coverRecord, secondRecord],
            uploads: [
              { record: coverRecord, bytes: new Uint8Array([1, 2, 3]) },
              { record: secondRecord, bytes: new Uint8Array([4, 5, 6]) },
            ],
          }
        : { ok: false, reason: 'no-photos' },
    ),
  }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getListingDrafts: vi.fn(async () => []),
    commitUpdateListingDraft: vi.fn(),
    commitDeleteListingDraft: vi.fn(),
    commitCreateMedia: vi.fn(),
    commitUpsertListing: vi.fn(async () => ({ registered: true, verified: true })),
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

describe('useCreateMarketplaceListing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([]);
    mediaState.prepared = true;
    mediaState.items = [];
    sessionStorage.removeItem(LISTING_DRAFT_RESUME_STORAGE_KEY);
    commerceState.marketplaceSession = {
      pubky: OWNER,
      capabilities: '/pub/pubky.app/:rw',
      issuedAt: '2026-08-21T12:00:00.000Z',
      expiresAt: '2026-09-21T12:00:00.000Z',
    };
    vi.mocked(CommerceController.getSellerPaymentConfig).mockResolvedValue({
      bitcoinAvailable: true,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('018f47d2-6a27-7c23-a49d-6b21bb770121');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uploads every prepared photo and publishes a schema-valid owner listing in media order', async () => {
    const { result } = renderHook(() => useCreateMarketplaceListing());
    act(() => {
      result.current.form.setValue('title', 'Vintage leather boots');
      result.current.form.setValue('description', 'Well cared for boots with light wear.');
      result.current.form.setValue('categoryId', 'fashion-men-footwear-boots');
      result.current.form.setValue('attrSize', 'US 9');
      result.current.form.setValue('price', '125.00');
      result.current.form.setValue('fulfillment', 'pickup');
      result.current.form.setValue('countryCode', 'US');
    });

    let createdId: string | null = null;
    await act(async () => {
      createdId = await result.current.submit();
    });

    expect(CommerceController.commitCreateMedia).toHaveBeenNthCalledWith(1, 'image_01', new Uint8Array([1, 2, 3]));
    expect(CommerceController.commitCreateMedia).toHaveBeenNthCalledWith(2, 'image_02', new Uint8Array([4, 5, 6]));
    expect(CommerceController.commitUpsertListing).toHaveBeenCalledOnce();
    const listing = vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][0];
    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(true);
    expect(listing).toMatchObject({
      ownerPubky: OWNER,
      listingId: '018f47d26a277c23a49d6b21bb770121',
      title: 'Vintage leather boots',
      fulfillmentMethods: ['pickup'],
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 } },
      media: [{ id: 'image_01' }, { id: 'image_02' }],
      variants: [{ id: 'variant_1', quantity: 1, mediaIds: ['image_01', 'image_02'] }],
      taxonomyVersion: 2,
      categoryId: 'fashion-men-footwear-boots',
      attributes: { size: 'US 9' },
    });
    expect(createdId).toBe(`${OWNER}:018f47d26a277c23a49d6b21bb770121`);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Listing published' }));
  });

  it('blocks publishing when the seller has no payment method', async () => {
    vi.mocked(CommerceController.getSellerPaymentConfig).mockResolvedValue({
      bitcoinAvailable: false,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    });
    const { result } = renderHook(() => useCreateMarketplaceListing());

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.publishBlocked).toBe('no-method');
    expect(CommerceController.commitUpsertListing).not.toHaveBeenCalled();
  });

  it('blocks publishing when the public payment-config request is rejected', async () => {
    vi.mocked(CommerceController.getSellerPaymentConfig).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useCreateMarketplaceListing());

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.publishBlocked).toBe('unverified');
    expect(CommerceController.commitUpsertListing).not.toHaveBeenCalled();
  });

  it('reports the two truths separately when the record published but service registration failed', async () => {
    vi.mocked(CommerceController.commitUpsertListing).mockResolvedValueOnce({ registered: false, verified: true });
    const { result } = renderHook(() => useCreateMarketplaceListing());
    act(() => {
      result.current.form.setValue('title', 'Vintage leather boots');
      result.current.form.setValue('description', 'Well cared for boots with light wear.');
      result.current.form.setValue('categoryId', 'fashion-men-footwear-boots');
      result.current.form.setValue('attrSize', 'US 9');
      result.current.form.setValue('price', '125.00');
      result.current.form.setValue('fulfillment', 'pickup');
      result.current.form.setValue('countryCode', 'US');
    });

    let createdId: string | null = null;
    await act(async () => {
      createdId = await result.current.submit();
    });

    // Publishing SUCCEEDED — the submit reports it as such, with the honest
    // registration caveat, and the draft is consumed (no duplicate on retry).
    expect(createdId).toBe(`${OWNER}:018f47d26a277c23a49d6b21bb770121`);
    expect(toast).toHaveBeenCalledWith({
      description: 'Published, but not yet registered for checkout — retry from your listing',
    });
    expect(CommerceController.commitDeleteListingDraft).toHaveBeenCalled();
  });

  it('reports confirmation pending — never a failed publish — while the homeserver has not served the listing back', async () => {
    vi.mocked(CommerceController.commitUpsertListing).mockResolvedValueOnce({ registered: true, verified: false });
    const { result } = renderHook(() => useCreateMarketplaceListing());
    act(() => {
      result.current.form.setValue('title', 'Vintage leather boots');
      result.current.form.setValue('description', 'Well cared for boots with light wear.');
      result.current.form.setValue('categoryId', 'fashion-men-footwear-boots');
      result.current.form.setValue('attrSize', 'US 9');
      result.current.form.setValue('price', '125.00');
      result.current.form.setValue('fulfillment', 'pickup');
      result.current.form.setValue('countryCode', 'US');
    });

    let createdId: string | null = null;
    await act(async () => {
      createdId = await result.current.submit();
    });

    // The write was acked — the submit reports it as published with the
    // honest confirmation caveat ("do not publish it again" is the point),
    // and the draft is consumed so a retry cannot duplicate the listing.
    expect(createdId).toBe(`${OWNER}:018f47d26a277c23a49d6b21bb770121`);
    expect(toast).toHaveBeenCalledWith({
      title: 'Listing published — confirmation pending',
      description:
        'Your homeserver accepted the listing but has not served it back yet. Check your seller dashboard in a moment before publishing it again.',
    });
    expect(CommerceController.commitDeleteListingDraft).toHaveBeenCalled();
  });

  it('emits a free shipping option (no price) when free shipping is on', async () => {
    const { result } = renderHook(() => useCreateMarketplaceListing());
    act(() => {
      result.current.form.setValue('title', 'Vintage leather boots');
      result.current.form.setValue('description', 'Well cared for boots with light wear.');
      result.current.form.setValue('categoryId', 'fashion-men-footwear-boots');
      result.current.form.setValue('attrSize', 'US 9');
      result.current.form.setValue('price', '125.00');
      result.current.form.setValue('fulfillment', 'shipping');
      result.current.form.setValue('freeShipping', true);
      result.current.form.setValue('countryCode', 'US');
      result.current.form.setValue('packageWeight', '1200');
      result.current.form.setValue('packageLength', '350');
      result.current.form.setValue('packageWidth', '250');
      result.current.form.setValue('packageHeight', '150');
    });

    let createdId: string | null = null;
    await act(async () => {
      createdId = await result.current.submit();
    });

    expect(createdId).not.toBeNull();
    expect(CommerceController.commitUpsertListing).toHaveBeenCalledOnce();
    const listing = vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][0];
    const parsed = commerceListingRecordSchema.parse(listing);
    // The free option carries no price at all — never a zero-priced flat one.
    expect(parsed.shippingOptions).toEqual([
      expect.objectContaining({ id: 'seller_flat_rate', pricing: 'free', label: 'Seller shipping' }),
    ]);
    expect(parsed.shippingOptions[0]).not.toHaveProperty('price');
  });

  it('reuses the same listing id when a failed submit is retried — never a duplicate record', async () => {
    let uuidCounter = 0;
    vi.mocked(globalThis.crypto.randomUUID).mockImplementation(
      () => `018f47d2-6a27-7c23-a49d-6b21bb7702${String(20 + uuidCounter++).padStart(2, '0')}`,
    );
    vi.mocked(CommerceController.commitUpsertListing)
      .mockRejectedValueOnce(new Error('homeserver unreachable'))
      .mockResolvedValueOnce({ registered: true, verified: true });
    const { result } = renderHook(() => useCreateMarketplaceListing());
    act(() => {
      result.current.form.setValue('title', 'Vintage leather boots');
      result.current.form.setValue('description', 'Well cared for boots with light wear.');
      result.current.form.setValue('categoryId', 'fashion-men-footwear-boots');
      result.current.form.setValue('attrSize', 'US 9');
      result.current.form.setValue('price', '125.00');
      result.current.form.setValue('fulfillment', 'pickup');
      result.current.form.setValue('countryCode', 'US');
    });

    await act(async () => {
      await result.current.submit();
    });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'error', description: 'Could not publish this listing.' }),
    );
    expect(CommerceController.commitDeleteListingDraft).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.submit();
    });

    const firstAttempt = vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][0] as { listingId: string };
    const retryAttempt = vi.mocked(CommerceController.commitUpsertListing).mock.calls[1][0] as { listingId: string };
    expect(retryAttempt.listingId).toBe(firstAttempt.listingId);
  });

  it('publishes a bitcoin-priced listing as BTC money with exponent 8', async () => {
    const { result } = renderHook(() => useCreateMarketplaceListing());
    act(() => {
      result.current.form.setValue('title', 'Vintage leather boots');
      result.current.form.setValue('description', 'Well cared for boots with light wear.');
      result.current.form.setValue('categoryId', 'fashion-men-footwear-boots');
      result.current.form.setValue('attrSize', 'US 9');
      result.current.form.setValue('currency', 'BTC');
      result.current.form.setValue('price', '15000');
      result.current.form.setValue('fulfillment', 'pickup');
      result.current.form.setValue('countryCode', 'US');
    });

    await act(async () => {
      await result.current.submit();
    });

    const listing = vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][0];
    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(true);
    expect(listing).toMatchObject({
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 15_000, currency: 'BTC', exponent: 8 } },
    });
  });

  it('converts imperial package inputs to exact millimeters and grams on publish', async () => {
    const { result } = renderHook(() => useCreateMarketplaceListing());
    act(() => {
      result.current.form.setValue('title', 'Vintage leather boots');
      result.current.form.setValue('description', 'Well cared for boots with light wear.');
      result.current.form.setValue('categoryId', 'fashion-men-footwear-boots');
      result.current.form.setValue('attrSize', 'US 9');
      result.current.form.setValue('price', '125.00');
      result.current.form.setValue('fulfillment', 'shipping');
      result.current.form.setValue('shippingPrice', '12.00');
      result.current.form.setValue('packageWeight', '42.3');
      result.current.form.setValue('packageLength', '13.8');
      result.current.form.setValue('packageWidth', '9.8');
      result.current.form.setValue('packageHeight', '5.9');
      result.current.form.setValue('measurementSystem', 'imperial');
      result.current.form.setValue('countryCode', 'US');
    });

    await act(async () => {
      await result.current.submit();
    });

    const listing = vi.mocked(CommerceController.commitUpsertListing).mock.calls[0][0];
    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(true);
    expect(listing).toMatchObject({
      package: {
        weightGrams: 1_199, // 42.3 oz × 28.349523125
        lengthMillimeters: 351, // 13.8 in × 25.4
        widthMillimeters: 249, // 9.8 in × 25.4
        heightMillimeters: 150, // 5.9 in × 25.4
      },
    });
  });

  it('does not publish when media preparation fails', async () => {
    mediaState.prepared = false;
    const { result } = renderHook(() => useCreateMarketplaceListing());
    act(() => {
      result.current.form.setValue('title', 'Vintage leather boots');
      result.current.form.setValue('description', 'Well cared for boots with light wear.');
      result.current.form.setValue('categoryId', 'fashion-men-footwear-boots');
      result.current.form.setValue('attrSize', 'US 9');
      result.current.form.setValue('price', '125.00');
      result.current.form.setValue('fulfillment', 'pickup');
    });

    await act(() => result.current.submit());

    expect(CommerceController.commitCreateMedia).not.toHaveBeenCalled();
    expect(CommerceController.commitUpsertListing).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
  });

  it('autosaves draft form values after local hydration', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCreateMarketplaceListing());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.form.setValue('title', 'Autosaved boots');
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(LISTING_DRAFT_AUTOSAVE_MS);
    });

    expect(CommerceController.commitUpdateListingDraft).toHaveBeenCalledWith(
      '018f47d26a277c23a49d6b21bb770121',
      expect.objectContaining({ title: 'Autosaved boots' }),
      {},
    );
  });

  it('autosaves a draft even when publishing has no payment method', async () => {
    vi.useFakeTimers();
    vi.mocked(CommerceController.getSellerPaymentConfig).mockResolvedValue({
      bitcoinAvailable: false,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    });
    const { result } = renderHook(() => useCreateMarketplaceListing());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.form.setValue('title', 'Draft without payment settings');
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(LISTING_DRAFT_AUTOSAVE_MS);
    });

    expect(CommerceController.commitUpdateListingDraft).toHaveBeenCalledWith(
      '018f47d26a277c23a49d6b21bb770121',
      expect.objectContaining({ title: 'Draft without payment settings' }),
      {},
    );
  });

  it('prompts instead of silently hydrating a contentful draft', async () => {
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([
      listingDraftRow('draftlisting01', { title: 'Draft boots' }),
    ]);
    const { result } = renderHook(() => useCreateMarketplaceListing());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.restoredDraft).toBe(false);
    expect(result.current.form.getValues('title')).toBe('');
    expect(result.current.pendingRestore).toMatchObject({
      listingId: 'draftlisting01',
      title: 'Draft boots',
      extraCount: 0,
    });
    expect(CommerceController.commitUpdateListingDraft).not.toHaveBeenCalled();
  });

  it('hydrates form and photos after Resume and discards the pending listing id', async () => {
    const photo = new File([new Uint8Array([1, 2, 3])], 'front.jpg', { type: 'image/jpeg', lastModified: 42 });
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([
      listingDraftRow(
        'draftlisting01',
        {
          title: 'Draft boots',
          mediaRefs: [
            {
              kind: 'new',
              key: 'photo_front',
              altText: 'Front',
              name: 'front.jpg',
              type: 'image/jpeg',
              lastModified: 42,
            },
          ],
          activeSectionId: 'listing-section-item',
        },
        { media_blobs: { photo_front: photo } },
      ),
    ]);
    const { result } = renderHook(() => useCreateMarketplaceListing());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.resumeDraft());
    await waitFor(() => expect(result.current.restoredDraft).toBe(true));

    expect(result.current.pendingRestore).toBeNull();
    expect(result.current.form.getValues('title')).toBe('Draft boots');
    expect(result.current.activeSectionId).toBe('listing-section-item');
    expect(mediaFns.restore).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'new', key: 'photo_front', altText: 'Front' }),
    ]);

    act(() => result.current.reset());

    expect(result.current.restoredDraft).toBe(false);
    expect(result.current.form.getValues('title')).toBe('');
    expect(CommerceController.commitDeleteListingDraft).toHaveBeenCalledWith('draftlisting01');
    expect(CommerceController.commitDeleteListingDraft).not.toHaveBeenCalledWith('018f47d26a277c23a49d6b21bb770121');
  });

  it("migrates a legacy draft's 'SATS' currency to the canonical 'BTC' on targeted resume", async () => {
    markListingDraftResumeId('draftlisting02');
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([
      listingDraftRow('draftlisting02', { title: 'Legacy bitcoin draft', currency: 'SATS', price: '15000' }),
    ]);
    const { result } = renderHook(() => useCreateMarketplaceListing());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.pendingRestore).toBeNull();
    expect(result.current.restoredDraft).toBe(true);
    expect(result.current.form.getValues('currency')).toBe('BTC');
    expect(result.current.form.getValues('price')).toBe('15000');
  });

  // Sol re-review P1: a duplicate drafted on the pre-fix head could be saved
  // after adding Ship or Local pickup with the cap still in its quantity.
  it.each(['shipping_and_digital', 'pickup_and_digital'] as const)(
    'resumes a pre-fix %s duplicate draft holding the unlimited cap without letting it publish',
    async (fulfillment) => {
      markListingDraftResumeId('draftlisting09');
      vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([
        listingDraftRow('draftlisting09', {
          title: 'Field guide',
          description: 'A printable guide.',
          price: '10.00',
          fulfillment,
          seededFromTitle: 'Field guide',
          seededAuctionAsFixedPrice: false,
          variants: [
            {
              sku: '',
              size: 'pdf',
              color: '',
              style: '',
              quantity: String(COMMERCE_LISTING_MAX_QUANTITY),
              unlimited: false,
              priceOverride: '',
            },
          ],
        }),
      ]);
      const { result } = renderHook(() => useCreateMarketplaceListing());
      await act(async () => {
        await Promise.resolve();
      });
      const quantityBlocked = () => {
        const parsed = createMarketplaceListingSchema.safeParse(result.current.form.getValues());
        return !parsed.success && parsed.error.issues.some((issue) => issue.path.join('.') === 'variants.0.quantity');
      };

      expect(result.current.restoredDraft).toBe(true);
      expect(result.current.form.getValues('fulfillment')).toBe(fulfillment);
      expect(result.current.form.getValues('variants.0')).toMatchObject({ quantity: '', unlimited: false });
      expect(quantityBlocked()).toBe(true);

      act(() => result.current.form.setValue('variants.0.quantity', '3'));
      expect(quantityBlocked()).toBe(false);
    },
  );

  it('restores a duplicated listing draft with source title metadata', async () => {
    markListingDraftResumeId('draftlisting03');
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([
      listingDraftRow('draftlisting03', {
        title: 'Vintage leather boots',
        saleFormat: 'fixed_price',
        seededFromTitle: 'Vintage leather boots',
        seededAuctionAsFixedPrice: true,
      }),
    ]);
    const { result } = renderHook(() => useCreateMarketplaceListing());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.restoredDraft).toBe(true);
    expect(result.current.seededFromTitle).toBe('Vintage leather boots');
    expect(result.current.seededAuctionAsFixedPrice).toBe(true);
    expect(result.current.form.getValues('saleFormat')).toBe('fixed_price');
  });

  it('autosaves photo blobs with the form JSON', async () => {
    vi.useFakeTimers();
    const photo = new File([new Uint8Array([9, 8, 7])], 'front.jpg', { type: 'image/jpeg', lastModified: 7 });
    mediaState.items = [
      { key: 'photo_front', kind: 'new', file: photo, previewUrl: 'blob:front', altText: 'Front of the boots' },
    ];
    const { result } = renderHook(() => useCreateMarketplaceListing());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.form.setValue('title', 'Boots with photos');
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(LISTING_DRAFT_AUTOSAVE_MS);
    });

    expect(CommerceController.commitUpdateListingDraft).toHaveBeenCalledWith(
      '018f47d26a277c23a49d6b21bb770121',
      expect.objectContaining({
        title: 'Boots with photos',
        mediaRefs: [expect.objectContaining({ kind: 'new', key: 'photo_front', name: 'front.jpg' })],
      }),
      { photo_front: photo },
    );
  });

  it('skips empty autosave while a restore prompt is open', async () => {
    vi.useFakeTimers();
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([
      listingDraftRow('draftlisting01', { title: 'Keep me' }),
    ]);
    const { result } = renderHook(() => useCreateMarketplaceListing());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.pendingRestore?.listingId).toBe('draftlisting01');
    act(() => {
      vi.advanceTimersByTime(LISTING_DRAFT_AUTOSAVE_MS);
    });
    expect(CommerceController.commitUpdateListingDraft).not.toHaveBeenCalled();
  });

  it('flushes the draft on pagehide before the debounce fires', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCreateMarketplaceListing());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.form.setValue('title', 'Flushed on hide');
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });

    expect(CommerceController.commitUpdateListingDraft).toHaveBeenCalledWith(
      '018f47d26a277c23a49d6b21bb770121',
      expect.objectContaining({ title: 'Flushed on hide' }),
      {},
    );
  });
});

function listingDraftRow(
  listingId: string,
  form: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): CommerceListingDraftModelSchema {
  return {
    id: `${OWNER}:${listingId}`,
    owner_id: OWNER,
    listing_id: listingId,
    data: { ownerPubky: OWNER, listingId, form: JSON.parse(JSON.stringify(form)) },
    created_at: 1_000,
    updated_at: 2_000,
    ...extra,
  } as CommerceListingDraftModelSchema;
}

describe('seedDraftFormFromListing', () => {
  it('copies sellable fields and excludes ids, revision, and photos', () => {
    const source = createCommerceListingFixture({
      listingId: 'boots_01',
      revision: 4,
      variants: [
        {
          id: 'variant_keep',
          sku: 'BOOTS',
          options: { size: '42', color: 'Brown' },
          quantity: 2,
          mediaIds: ['image_01'],
          enabled: true,
        },
      ],
    });
    const draft = seedDraftFormFromListing(source, 'metric');
    expect(draft).toMatchObject({
      title: source.title,
      description: source.description,
      categoryId: source.categoryId,
      condition: source.condition,
      saleFormat: 'fixed_price',
      price: '125.00',
      seededFromTitle: source.title,
      seededAuctionAsFixedPrice: false,
      variants: [{ sku: 'BOOTS-copy', size: '42', color: 'Brown', style: '', quantity: '2', priceOverride: '' }],
    });
    expect(draft).not.toHaveProperty('listingId');
    expect(draft).not.toHaveProperty('revision');
    expect(draft).not.toHaveProperty('media');
  });

  it('converts an auction source to fixed price', () => {
    const source = createCommerceListingFixture({
      sale: {
        format: 'auction',
        startingPrice: { amountMinor: 10_000, currency: 'USD', exponent: 2 },
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        startsAt: '2026-08-19T20:00:00.000Z',
        endsAt: '2026-08-29T20:00:00.000Z',
        antiSnipingWindowSeconds: 120,
        antiSnipingExtensionSeconds: 120,
      },
    });
    const draft = seedDraftFormFromListing(source, 'metric');
    expect(draft.saleFormat).toBe('fixed_price');
    expect(draft.seededAuctionAsFixedPrice).toBe(true);
    expect(draft.price).toBe('100.00');
  });

  it('duplicates a digital listing with its delivery options', () => {
    const source = createCommerceListingFixture({
      fulfillmentMethods: ['pickup', 'digital'],
      package: undefined,
      shippingOptions: [],
    });
    expect(seedDraftFormFromListing(source, 'metric').fulfillment).toBe('pickup_and_digital');
  });

  it('refuses to duplicate a Locks listing', () => {
    const source = createCommerceListingFixture({
      fulfillmentMethods: ['digital'],
      package: undefined,
      shippingOptions: [],
      digitalLock: {
        policyUri: `pubky://${fixtureSellerPubky()}/pub/locks.app/policy.json`,
        criterionId: 'criterion-1',
        contentPath: 'content/file.bin',
        resourceHash: 'b'.repeat(64),
        minimumConfirmations: 1,
      },
    });
    expect(() => seedDraftFormFromListing(source, 'metric')).toThrow('unsupported-fulfillment');
  });

  it('copies unlimited stock only for a digital-only listing at the quantity cap', () => {
    const variant = {
      id: 'variant_01',
      options: { size: 'pdf' },
      quantity: COMMERCE_LISTING_MAX_QUANTITY,
      mediaIds: ['image_01'],
      enabled: true,
    };
    const digital = seedDraftFormFromListing(
      createCommerceListingFixture({
        fulfillmentMethods: ['digital'],
        package: undefined,
        shippingOptions: [],
        variants: [variant],
      }),
      'metric',
    );
    expect(digital.variants[0]).toMatchObject({ unlimited: true, quantity: '' });
    const physical = seedDraftFormFromListing(
      createCommerceListingFixture({ variants: [{ ...variant, options: { size: '42' } }] }),
      'metric',
    );
    expect(physical.variants[0]).toMatchObject({ unlimited: false, quantity: String(COMMERCE_LISTING_MAX_QUANTITY) });
    const mixed = seedDraftFormFromListing(
      createCommerceListingFixture({
        fulfillmentMethods: ['physical', 'shipping', 'digital'],
        variants: [variant],
      }),
      'metric',
    );
    expect(mixed.variants[0].unlimited).toBe(false);
  });
});

describe('buildListingVariants', () => {
  it('writes the quantity cap for an unlimited variant and the entered number otherwise', () => {
    const media = [] as Parameters<typeof buildListingVariants>[1];
    const base = { sku: '', size: '', color: '', style: '', priceOverride: '' };
    expect(
      buildListingVariants({ currency: 'USD', variants: [{ ...base, quantity: '3', unlimited: true }] }, media)[0]
        .quantity,
    ).toBe(COMMERCE_LISTING_MAX_QUANTITY);
    expect(
      buildListingVariants({ currency: 'USD', variants: [{ ...base, quantity: '4', unlimited: false }] }, media)[0]
        .quantity,
    ).toBe(4);
  });
});

describe('normalizeDraftForm', () => {
  it('loads an older draft variant without unlimited as a numbered quantity', () => {
    const older = normalizeDraftForm({
      variants: [{ sku: '', size: '', color: '', style: '', quantity: '2', priceOverride: '' }],
    });
    expect(older.variants?.[0].unlimited).toBe(false);
    const flagged = normalizeDraftForm({
      variants: [{ sku: '', size: '', color: '', style: '', quantity: '2', priceOverride: '', unlimited: true }],
    });
    expect(flagged.variants?.[0].unlimited).toBe(true);
  });
});

function fixtureSellerPubky(): string {
  return createCommerceListingFixture().ownerPubky;
}
