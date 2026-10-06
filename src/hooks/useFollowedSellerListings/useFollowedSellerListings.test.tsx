import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKETPLACE_FOLLOWED_SHELF_FOLLOWS_LIMIT } from '@/config/commerce';
import { catalogItemFromCatalogEntry } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { Pubky } from '@/models/models.types';
import { useAuthStore } from '@/stores/auth/auth.store';
import { COMMERCE_FIXTURE_SELLER, createCommerceCatalogEntryFixture } from '@/test/fixtures/commerce/commerce';
import { useFollowedSellerListings } from './useFollowedSellerListings';

const VIEWER = 'v'.repeat(52) as Pubky;
const UNFOLLOWED_SELLER = 'u'.repeat(52);

const mockGetAllListings = vi.fn();
const mockGetAllCatalogEntries = vi.fn();
const mockGetAllShops = vi.fn();
const mockFetchFollowedSellerListings = vi.fn();
vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getAllListings: () => mockGetAllListings(),
    getAllCatalogEntries: () => mockGetAllCatalogEntries(),
    getAllShops: () => mockGetAllShops(),
    fetchFollowedSellerListings: (follows: unknown) => mockFetchFollowedSellerListings(follows),
  },
}));

const mockGetOrFetchStreamSlice = vi.fn();
vi.mock('@/controllers/stream/users/users', () => ({
  StreamUserController: {
    getOrFetchStreamSlice: (params: unknown) => mockGetOrFetchStreamSlice(params),
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

// The mocked controller reads return plain values, so the live query can hand
// them straight back.
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (queryFn: () => unknown) => queryFn(),
}));

describe('useFollowedSellerListings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ currentUserPubky: VIEWER });
    mockGetCommerceAdapterMode.mockReturnValue('transaction-service');
    mockGetAllListings.mockReturnValue([]);
    mockGetAllCatalogEntries.mockReturnValue([]);
    mockGetAllShops.mockReturnValue([]);
    mockGetOrFetchStreamSlice.mockResolvedValue({ nextPageIds: [], skip: 0, isExhausted: true });
    mockFetchFollowedSellerListings.mockResolvedValue(undefined);
  });

  it('is inert when the marketplace adapter mode is unavailable (the nav-entry gate)', () => {
    mockGetCommerceAdapterMode.mockReturnValue('unavailable');
    mockGetAllCatalogEntries.mockReturnValue([createCommerceCatalogEntryFixture()]);

    const { result } = renderHook(() => useFollowedSellerListings());

    expect(result.current.listings).toEqual([]);
    expect(mockGetOrFetchStreamSlice).not.toHaveBeenCalled();
    expect(mockFetchFollowedSellerListings).not.toHaveBeenCalled();
  });

  it('is inert when signed out — the shelf is defined by the viewer follows', () => {
    useAuthStore.setState({ currentUserPubky: null });
    mockGetAllCatalogEntries.mockReturnValue([createCommerceCatalogEntryFixture()]);

    const { result } = renderHook(() => useFollowedSellerListings());

    expect(result.current.listings).toEqual([]);
    expect(mockGetOrFetchStreamSlice).not.toHaveBeenCalled();
  });

  it('reads one bounded follow slice, refreshes the shelf, and intersects follows with the cache', async () => {
    const followedEntry = createCommerceCatalogEntryFixture();
    const unfollowedEntry = createCommerceCatalogEntryFixture({
      id: `${UNFOLLOWED_SELLER}:jacket_01`,
      seller_id: UNFOLLOWED_SELLER,
      listing_id: 'jacket_01',
    });
    mockGetAllCatalogEntries.mockReturnValue([followedEntry, unfollowedEntry]);
    mockGetOrFetchStreamSlice.mockResolvedValue({
      nextPageIds: [COMMERCE_FIXTURE_SELLER],
      skip: 1,
      isExhausted: true,
    });

    const { result } = renderHook(() => useFollowedSellerListings());

    expect(mockGetOrFetchStreamSlice).toHaveBeenCalledExactlyOnceWith({
      streamId: `${VIEWER}:following`,
      limit: MARKETPLACE_FOLLOWED_SHELF_FOLLOWS_LIMIT,
      skip: 0,
    });
    await waitFor(() => expect(mockFetchFollowedSellerListings).toHaveBeenCalledWith([COMMERCE_FIXTURE_SELLER]));
    await waitFor(() => expect(result.current.listings).toEqual([catalogItemFromCatalogEntry(followedEntry)]));
  });

  it('renders the cached intersection when the index refresh fails', async () => {
    const followedEntry = createCommerceCatalogEntryFixture();
    mockGetAllCatalogEntries.mockReturnValue([followedEntry]);
    mockGetOrFetchStreamSlice.mockResolvedValue({
      nextPageIds: [COMMERCE_FIXTURE_SELLER],
      skip: 1,
      isExhausted: true,
    });
    mockFetchFollowedSellerListings.mockRejectedValue(new Error('nexus unreachable'));

    const { result } = renderHook(() => useFollowedSellerListings());

    await waitFor(() => expect(result.current.listings).toEqual([catalogItemFromCatalogEntry(followedEntry)]));
  });

  it('renders nothing when the follow stream itself is unreachable', async () => {
    mockGetAllCatalogEntries.mockReturnValue([createCommerceCatalogEntryFixture()]);
    mockGetOrFetchStreamSlice.mockRejectedValue(new Error('nexus unreachable'));

    const { result } = renderHook(() => useFollowedSellerListings());

    await waitFor(() => expect(mockGetOrFetchStreamSlice).toHaveBeenCalled());
    expect(result.current.listings).toEqual([]);
    expect(mockFetchFollowedSellerListings).not.toHaveBeenCalled();
  });
});
