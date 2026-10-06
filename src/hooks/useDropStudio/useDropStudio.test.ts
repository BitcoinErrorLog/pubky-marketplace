import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { readOwnDropIndex } from './drop-index';
import { buildDropRecord, useDropStudio } from './useDropStudio';
import { type DropStudioData, dropStudioSchema } from './useDropStudio.types';

const SELLER = vi.hoisted(() => 'y'.repeat(52));

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

const listingsFixture = vi.hoisted(() => [
  {
    id: `${'y'.repeat(52)}:item1`,
    seller_id: 'y'.repeat(52),
    listing_id: 'item1',
    record: {
      title: 'Numbered print',
      media: [
        {
          id: 'media1',
          type: 'image',
          url: `pubky://${'y'.repeat(52)}/pub/pubky.app/marketplace/v1/media/media1`,
        },
      ],
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 } },
    },
    revision: 1,
    state: 'active',
    category_id: 'art',
    format: 'fixed_price',
    currency: 'USD',
    price_minor: 4_500,
    sync_status: 'synced',
    updated_at: 0,
  },
]);
const localListings = vi.hoisted(() => ({ value: listingsFixture }));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => localListings.value,
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'y'.repeat(52) }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    refreshListingsBySeller: vi.fn(),
    getMarketplaceListingProjection: vi.fn(),
    ensureListingRegistered: vi.fn(),
    syncListingRegistration: vi.fn(),
    publishDrop: vi.fn(),
    syncDropRegistration: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

const validFormData: DropStudioData = {
  title: 'Winter capsule',
  description: 'One hundred numbered pieces.',
  listingIds: ['item1'],
  startsAtLocal: '2099-01-01T10:00',
  endsAtLocal: '2099-01-02T10:00',
  totalQuantity: '100',
  perBuyerLimit: '2',
  stockDisplay: 'exact',
};

async function fillValidForm(form: ReturnType<typeof useDropStudio>['form']) {
  await act(async () => {
    for (const [name, value] of Object.entries(validFormData)) {
      form.setValue(name as keyof DropStudioData, value as never, { shouldValidate: true });
    }
  });
}

describe('dropStudioSchema — composer validation mirrors the record contract', () => {
  const base = validFormData;

  it.each([
    ['', false, 'Total quantity is required.'],
    ['0', false, 'Total quantity must be a positive whole number.'],
    ['-1', false, 'Total quantity must be a positive whole number.'],
    ['1.5', false, 'Total quantity must be a positive whole number.'],
    ['abc', false, 'Total quantity must be a positive whole number.'],
    ['1000001', false, 'Total quantity can be at most 1,000,000.'],
    ['1', true, undefined],
  ])('validates total quantity %j', (totalQuantity, success, message) => {
    const result = dropStudioSchema.safeParse({
      ...base,
      totalQuantity,
      ...(totalQuantity === '1' ? { perBuyerLimit: '1' } : {}),
    });
    expect(result.success).toBe(success);
    if (!success) {
      expect(result.error!.issues.find(({ path }) => path.join('.') === 'totalQuantity')?.message).toBe(message);
    }
  });

  it('accepts a complete, in-bounds drop', () => {
    expect(dropStudioSchema.safeParse(base).success).toBe(true);
  });

  it('requires a title, a launch time, and at least one listing', () => {
    const result = dropStudioSchema.safeParse({ ...base, title: '  ', startsAtLocal: '', listingIds: [] });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map(({ path }) => path.join('.'));
    expect(paths).toContain('title');
    expect(paths).toContain('startsAtLocal');
    expect(paths).toContain('listingIds');
  });

  it('uses the launch-time required message before date-format validation', () => {
    const result = dropStudioSchema.safeParse({ ...base, startsAtLocal: '' });
    expect(result.success).toBe(false);
    expect(result.error!.issues.find(({ path }) => path.join('.') === 'startsAtLocal')?.message).toBe(
      'Set a launch time.',
    );
  });

  it('rejects invalid calendar dates and accepts leap-day dates', () => {
    const invalid = dropStudioSchema.safeParse({ ...base, startsAtLocal: '2024-02-30T10:00' });
    expect(invalid.success).toBe(false);
    expect(invalid.error!.issues.find(({ path }) => path.join('.') === 'startsAtLocal')?.message).toBe(
      'Launch time is not a valid date.',
    );

    expect(dropStudioSchema.safeParse({ ...base, startsAtLocal: '2024-02-29T10:00' }).success).toBe(true);
  });

  it('rejects a per-buyer limit above the total quantity', () => {
    const result = dropStudioSchema.safeParse({ ...base, totalQuantity: '5', perBuyerLimit: '6' });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]?.message).toBe('The per-buyer limit cannot exceed the total quantity.');
  });

  it('rejects an end time at or before the launch time', () => {
    const result = dropStudioSchema.safeParse({ ...base, endsAtLocal: base.startsAtLocal });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]?.message).toBe('The end time must be after the launch time.');
  });

  it('rejects out-of-contract caps with plain-language bounds', () => {
    const tooMany = dropStudioSchema.safeParse({ ...base, totalQuantity: '1000001' });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error!.issues[0]?.message).toBe('Total quantity can be at most 1,000,000.');

    const tooGreedy = dropStudioSchema.safeParse({ ...base, perBuyerLimit: '101' });
    expect(tooGreedy.success).toBe(false);
    expect(tooGreedy.error!.issues.map(({ message }) => message)).toContain('Per-buyer limit can be at most 100.');
  });

  it('rejects datetime values with more than four year digits', () => {
    const result = dropStudioSchema.safeParse({
      ...base,
      endsAtLocal: '202222-09-14T12:00',
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map(({ path }) => path.join('.'))).toContain('endsAtLocal');
  });

  it('accepts an empty end time — the drop runs until sell-out or cancel', () => {
    expect(dropStudioSchema.safeParse({ ...base, endsAtLocal: '' }).success).toBe(true);
  });
});

describe('buildDropRecord', () => {
  it('builds a contract-valid record with the listing\u2019s first image as teaser media', () => {
    const result = buildDropRecord(SELLER, validFormData, listingsFixture as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toMatchObject({
      recordType: 'drop',
      ownerPubky: SELLER,
      revision: 1,
      format: 'fcfs',
      listingIds: ['item1'],
      totalQuantity: 100,
      perBuyerLimit: 2,
      stockDisplay: 'exact',
      media: [`pubky://${SELLER}/pub/pubky.app/marketplace/v1/media/media1`],
    });
    expect(result.record.startsAt).toBe(new Date('2099-01-01T10:00').toISOString());
    expect(result.record.endsAt).toBe(new Date('2099-01-02T10:00').toISOString());
    expect(result.record.dropId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('omits endsAt entirely when the seller sets no end', () => {
    const result = buildDropRecord(SELLER, { ...validFormData, endsAtLocal: '' }, listingsFixture as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('endsAt' in result.record).toBe(false);
  });

  it('maps contract violations to readable per-field messages', () => {
    const result = buildDropRecord(
      SELLER,
      { ...validFormData, totalQuantity: '1', perBuyerLimit: '5' },
      listingsFixture as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((message) => message.startsWith('perBuyerLimit:'))).toBe(true);
  });
});

describe('useDropStudio — two-truth publish state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    config.mode = 'transaction-service';
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue({
      aggregateId: `listing:${SELLER}_item1`,
      serverRevision: 1,
    } as never);
    vi.mocked(CommerceController.publishDrop).mockResolvedValue(undefined as never);
    vi.mocked(CommerceController.syncDropRegistration).mockResolvedValue({ ok: true, revision: 1 } as never);
    vi.mocked(CommerceController.refreshListingsBySeller).mockResolvedValue(undefined);
    localListings.value = listingsFixture;
  });

  it('reports record ✓ and service ✓ separately on a clean publish, remembering the drop id', async () => {
    const { result } = renderHook(() => useDropStudio());
    await fillValidForm(result.current.form);

    await act(async () => {
      await result.current.publish();
    });

    expect(CommerceController.publishDrop).toHaveBeenCalledTimes(1);
    expect(CommerceController.syncDropRegistration).toHaveBeenCalledTimes(1);
    expect(result.current.publishStatus).toEqual({ record: 'ok', sync: 'ok' });
    expect(result.current.publishedDropId).not.toBeNull();
    expect(readOwnDropIndex(SELLER)).toEqual([result.current.publishedDropId]);
    expect(CommerceController.syncDropRegistration).toHaveBeenCalledWith(SELLER, result.current.publishedDropId);
  });

  it('record ok + sync failed → retry affordance re-runs ONLY the sync', async () => {
    vi.mocked(CommerceController.syncDropRegistration).mockResolvedValueOnce({
      ok: false,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The homeserver fetch failed.' },
    } as never);

    const { result } = renderHook(() => useDropStudio());
    await fillValidForm(result.current.form);

    await act(async () => {
      await result.current.publish();
    });
    expect(result.current.publishStatus).toEqual({ record: 'ok', sync: 'failed' });
    // The record is a fact on the homeserver, so the id is already indexed.
    expect(readOwnDropIndex(SELLER)).toHaveLength(1);

    await act(async () => {
      await result.current.retrySync();
    });
    expect(CommerceController.publishDrop).toHaveBeenCalledTimes(1);
    expect(CommerceController.syncDropRegistration).toHaveBeenCalledTimes(2);
    expect(result.current.publishStatus).toEqual({ record: 'ok', sync: 'ok' });
  });

  it('submits an empty end without an endsAt field', async () => {
    const { result } = renderHook(() => useDropStudio());
    await fillValidForm(result.current.form);
    await act(async () => {
      result.current.form.setValue('endsAtLocal', '', { shouldValidate: true });
      await result.current.publish();
    });

    expect(CommerceController.publishDrop).toHaveBeenCalledWith(
      expect.not.objectContaining({ endsAt: expect.anything() }),
    );
  });

  it('record PUT failure never attempts the sync and never indexes the id', async () => {
    vi.mocked(CommerceController.publishDrop).mockRejectedValue(
      Object.assign(new Error('The homeserver refused the record.'), { name: 'AppError' }),
    );

    const { result } = renderHook(() => useDropStudio());
    await fillValidForm(result.current.form);

    await act(async () => {
      await result.current.publish();
    });

    expect(result.current.publishStatus).toEqual({ record: 'failed', sync: 'idle' });
    expect(result.current.publishedDropId).toBeNull();
    expect(result.current.publishErrors).toEqual(['The homeserver refused the record.']);
    expect(CommerceController.syncDropRegistration).not.toHaveBeenCalled();
    expect(readOwnDropIndex(SELLER)).toEqual([]);
  });

  it('an invalid form never reaches the controller', async () => {
    const { result } = renderHook(() => useDropStudio());

    await act(async () => {
      await result.current.publish();
    });

    expect(CommerceController.publishDrop).not.toHaveBeenCalled();
    expect(result.current.publishStatus).toEqual({ record: 'idle', sync: 'idle' });
  });

  it('checks registration for newly selected listings and heals through the register affordance', async () => {
    vi.mocked(CommerceController.getMarketplaceListingProjection)
      .mockResolvedValueOnce(null) // selection check → unregistered
      .mockResolvedValueOnce(null) // after ensureListingRegistered → still missing
      .mockResolvedValueOnce({ aggregateId: `listing:${SELLER}_item1`, serverRevision: 1 } as never);
    vi.mocked(CommerceController.ensureListingRegistered).mockResolvedValue(undefined as never);
    vi.mocked(CommerceController.syncListingRegistration).mockResolvedValue({ ok: true, revision: 1 } as never);

    const { result } = renderHook(() => useDropStudio());
    await act(async () => {
      result.current.form.setValue('listingIds', ['item1'], { shouldValidate: true });
    });
    await waitFor(() => expect(result.current.registration.item1).toBe('unregistered'));

    await act(async () => {
      await result.current.registerListing('item1');
    });

    expect(CommerceController.ensureListingRegistered).toHaveBeenCalledTimes(1);
    expect(CommerceController.syncListingRegistration).toHaveBeenCalledWith(SELLER, 'item1');
    expect(result.current.registration.item1).toBe('registered');
  });

  it('refreshes an incomplete local catalog so canonical active records are selectable', async () => {
    localListings.value = [];
    const activeListings = ['come and buy', 'Offer Test', 'Verify 10 Sep', "Casio AE-1200WHB-3BVDF Men's Watch"].map(
      (title, index) => ({
        ...listingsFixture[0],
        listing_id: `listing-${index}`,
        record: { ...listingsFixture[0].record, title },
      }),
    );
    vi.mocked(CommerceController.refreshListingsBySeller).mockImplementation(async () => {
      localListings.value = activeListings;
    });

    const { result } = renderHook(() => useDropStudio());
    await waitFor(() => expect(result.current.catalog).toBe('loaded'));

    expect(CommerceController.refreshListingsBySeller).toHaveBeenCalledWith(SELLER);
    expect(result.current.listings.map((listing) => listing.record.title)).toEqual(
      activeListings.map((listing) => listing.record.title),
    );
  });

  it('refreshes a non-empty partial cache before deriving picker eligibility', async () => {
    const staleListing = { ...listingsFixture[0], listing_id: 'stale-listing', state: 'inactive' as const };
    const canonicalListing = { ...listingsFixture[0], listing_id: 'canonical-listing' };
    localListings.value = [staleListing];
    vi.mocked(CommerceController.refreshListingsBySeller).mockImplementation(async () => {
      localListings.value = [staleListing, canonicalListing];
    });

    const { result } = renderHook(() => useDropStudio());
    await waitFor(() => expect(result.current.catalog).toBe('loaded'));

    expect(result.current.listings.map((listing) => listing.listing_id)).toEqual(['canonical-listing']);
  });

  it('removes a stale active listing from the picker after refresh', async () => {
    const staleActive = { ...listingsFixture[0], revision: 1, state: 'active' as const };
    const canonicalPaused = { ...listingsFixture[0], revision: 2, state: 'paused' as const };
    localListings.value = [staleActive];
    vi.mocked(CommerceController.refreshListingsBySeller).mockImplementation(async () => {
      localListings.value = [canonicalPaused];
    });

    const { result } = renderHook(() => useDropStudio());
    await waitFor(() => expect(result.current.catalog).toBe('loaded'));

    expect(result.current.listings).toEqual([]);
  });

  it('retries a failed catalog refresh', async () => {
    localListings.value = [];
    vi.mocked(CommerceController.refreshListingsBySeller)
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockImplementationOnce(async () => {
        localListings.value = listingsFixture;
      });

    const { result } = renderHook(() => useDropStudio());
    await waitFor(() => expect(result.current.catalog).toBe('unavailable'));
    act(() => result.current.retryCatalog());
    await waitFor(() => expect(result.current.catalog).toBe('loaded'));

    expect(CommerceController.refreshListingsBySeller).toHaveBeenCalledTimes(2);
  });

  it('excludes ended auctions from the picker even when the listing record is still active', async () => {
    const endedAuction = {
      ...listingsFixture[0],
      listing_id: 'ended-auction',
      format: 'auction',
      record: {
        ...listingsFixture[0].record,
        sale: {
          format: 'auction' as const,
          unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          startsAt: '2020-01-01T00:00:00.000Z',
          endsAt: '2020-01-02T00:00:00.000Z',
        },
      },
    };
    localListings.value = [listingsFixture[0], endedAuction];

    const { result } = renderHook(() => useDropStudio());
    await waitFor(() => expect(result.current.catalog).toBe('loaded'));

    expect(result.current.listings.map((listing) => listing.listing_id)).toEqual(['item1']);
  });
});
