import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogItemFromCatalogEntry } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { COMMERCE_FIXTURE_SELLER, createCommerceCatalogEntryFixture } from '@/test/fixtures/commerce/commerce';
import { useMarketplaceHotListings } from './useMarketplaceHotListings';

const mockGetAllListings = vi.fn();
const mockGetAllCatalogEntries = vi.fn();
const mockGetAllShops = vi.fn();
const mockFetchCatalogListings = vi.fn();
vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getAllListings: () => mockGetAllListings(),
    getAllCatalogEntries: () => mockGetAllCatalogEntries(),
    getAllShops: () => mockGetAllShops(),
    fetchCatalogListings: (filters: unknown) => mockFetchCatalogListings(filters),
  },
}));

const mockGetCommerceAdapterMode = vi.fn();
vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return {
    ...actual,
    getCommerceAdapterMode: () => mockGetCommerceAdapterMode(),
  };
});

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (queryFn: () => unknown) => queryFn(),
}));

function auctionEntry(listingId: string, endsAt: string) {
  return createCommerceCatalogEntryFixture({
    id: `${COMMERCE_FIXTURE_SELLER}:${listingId}`,
    listing_id: listingId,
    sale_format: 'auction',
    auction: {
      startsAt: '2026-08-19T20:00:00.000Z',
      endsAt,
      buyNowPrice: null,
      minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
    },
  });
}

describe('useMarketplaceHotListings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The auction fixtures end in August 2026; run the hook while they are open.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-08-20T00:00:00.000Z'));
    mockGetCommerceAdapterMode.mockReturnValue('transaction-service');
    mockGetAllListings.mockReturnValue([]);
    mockGetAllCatalogEntries.mockReturnValue([]);
    mockGetAllShops.mockReturnValue([]);
    mockFetchCatalogListings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is inert when the marketplace adapter mode is unavailable (the nav-entry gate)', () => {
    mockGetCommerceAdapterMode.mockReturnValue('unavailable');
    mockGetAllCatalogEntries.mockReturnValue([createCommerceCatalogEntryFixture()]);

    const { result } = renderHook(() => useMarketplaceHotListings());

    expect(result.current.endingSoon).toEqual([]);
    expect(result.current.fresh).toEqual([]);
    expect(mockFetchCatalogListings).not.toHaveBeenCalled();
  });

  it('refreshes both streams and composes deduplicated ending-soon and fresh modules', async () => {
    const auction = auctionEntry('signet_auction', '2026-08-22T20:00:00.000Z');
    const fixedPrice = createCommerceCatalogEntryFixture();
    mockGetAllCatalogEntries.mockReturnValue([auction, fixedPrice]);

    const { result } = renderHook(() => useMarketplaceHotListings());

    await waitFor(() => expect(mockFetchCatalogListings).toHaveBeenCalledTimes(2));
    expect(mockFetchCatalogListings).toHaveBeenCalledWith({ saleFormat: 'all', conditions: [], sort: 'ending_soon' });
    expect(mockFetchCatalogListings).toHaveBeenCalledWith({ saleFormat: 'all', conditions: [], sort: 'newest' });
    expect(result.current.endingSoon).toEqual([catalogItemFromCatalogEntry(auction)]);
    // The auction is already shown by the ending-soon module, so "fresh"
    // holds only the remaining active listing.
    expect(result.current.fresh).toEqual([catalogItemFromCatalogEntry(fixedPrice)]);
  });

  it('leaves an auction that closed without a seller edit out of both modules', async () => {
    vi.setSystemTime(Date.parse('2026-09-29T12:00:00.000Z'));
    const closed = auctionEntry('closed_weeks_ago', '2026-08-29T08:00:00.000Z');
    const fixedPrice = createCommerceCatalogEntryFixture();
    mockGetAllCatalogEntries.mockReturnValue([closed, fixedPrice]);

    const { result } = renderHook(() => useMarketplaceHotListings());

    await waitFor(() => expect(mockFetchCatalogListings).toHaveBeenCalledTimes(2));
    expect(closed.state).toBe('active');
    expect(result.current.endingSoon).toEqual([]);
    expect(result.current.fresh).toEqual([catalogItemFromCatalogEntry(fixedPrice)]);
  });

  it('keeps rendering cached modules when both Nexus refreshes fail', async () => {
    const fixedPrice = createCommerceCatalogEntryFixture();
    mockGetAllCatalogEntries.mockReturnValue([fixedPrice]);
    mockFetchCatalogListings.mockRejectedValue(new Error('nexus unreachable'));

    const { result } = renderHook(() => useMarketplaceHotListings());

    await waitFor(() => expect(mockFetchCatalogListings).toHaveBeenCalledTimes(2));
    expect(result.current.fresh).toEqual([catalogItemFromCatalogEntry(fixedPrice)]);
    expect(result.current.endingSoon).toEqual([]);
  });

  it('returns empty modules over an empty index (for example while Nexus replays history)', async () => {
    const { result } = renderHook(() => useMarketplaceHotListings());

    await waitFor(() => expect(mockFetchCatalogListings).toHaveBeenCalledTimes(2));
    expect(result.current.endingSoon).toEqual([]);
    expect(result.current.fresh).toEqual([]);
  });
});
