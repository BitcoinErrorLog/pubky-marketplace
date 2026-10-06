import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { DatabaseContext } from '@/providers/DatabaseProvider/DatabaseProvider';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  createCommerceCatalogEntryFixture,
  createCommerceListingFixture,
  createCommerceShopFixture,
} from '@/test/fixtures/commerce/commerce';
import { toCommerceListingModel } from '@/test/fixtures/commerce/listing-models';
import { useMarketplaceCatalog } from './useMarketplaceCatalog';
import {
  catalogItemFromCatalogEntry,
  catalogItemFromListingModel,
  type MarketplaceCatalogFilters,
} from './useMarketplaceCatalog.utils';

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

// The mocked controller reads return plain values, so the live query can hand
// them straight back; `undefined` models a cache read that has not resolved.
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (queryFn: () => unknown) => queryFn(),
}));

function toShopModel(record: CommerceShopRecord) {
  return { id: record.ownerPubky, owner_id: record.ownerPubky, record };
}

const readyWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseContext.Provider value={{ isReady: true, error: null, retry: async () => {} }}>
    {children}
  </DatabaseContext.Provider>
);

describe('useMarketplaceCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCommerceStore.getState().reset();
    mockGetCommerceAdapterMode.mockReturnValue('unavailable');
    mockGetAllListings.mockReturnValue([]);
    mockGetAllCatalogEntries.mockReturnValue([]);
    mockGetAllShops.mockReturnValue([]);
    mockFetchCatalogListings.mockResolvedValue(undefined);
  });

  it('uses independent category filters without changing the browse filters', () => {
    const cached = toCommerceListingModel(createCommerceListingFixture());
    mockGetAllListings.mockReturnValue([cached]);
    useCommerceStore.getState().setQuery('unrelated search');
    useCommerceStore.getState().setCategoryId('unrelated-category');
    useCommerceStore.getState().setAttributeFilter('color', 'unrelated');
    const filters: MarketplaceCatalogFilters = {
      query: '',
      categoryId: cached.record.categoryId,
      saleFormat: 'all',
      conditions: [],
      minimumPriceMinor: null,
      maximumPriceMinor: null,
      countryCode: null,
      sort: 'recommended',
    };
    const { result } = renderHook(() => useMarketplaceCatalog([], [], filters), { wrapper: readyWrapper });
    expect(result.current.listings).toEqual([catalogItemFromListingModel(cached)]);
    expect(useCommerceStore.getState().query).toBe('unrelated search');
    expect(useCommerceStore.getState().categoryId).toBe('unrelated-category');
  });

  it('seeds the grid from server listings while the Dexie cache is unresolved', () => {
    mockGetAllListings.mockReturnValue(undefined);
    mockGetAllCatalogEntries.mockReturnValue(undefined);
    mockGetAllShops.mockReturnValue(undefined);
    const seed = catalogItemFromListingModel(toCommerceListingModel(createCommerceListingFixture()));

    const { result } = renderHook(() => useMarketplaceCatalog([seed]), { wrapper: readyWrapper });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.listings).toEqual([seed]);
  });

  it('does not refresh or replace SSR listings before the database is ready', () => {
    const seed = catalogItemFromListingModel(toCommerceListingModel(createCommerceListingFixture()));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DatabaseContext.Provider value={{ isReady: false, error: null, retry: async () => {} }}>
        {children}
      </DatabaseContext.Provider>
    );

    const { result } = renderHook(() => useMarketplaceCatalog([seed]), { wrapper });

    expect(mockFetchCatalogListings).not.toHaveBeenCalled();
    expect(result.current.listings).toEqual([seed]);
  });

  it('renders cached listings immediately while the Nexus refresh is still in flight', async () => {
    const cached = toCommerceListingModel(createCommerceListingFixture());
    mockGetAllListings.mockReturnValue([cached]);
    mockGetAllShops.mockReturnValue([toShopModel(createCommerceShopFixture())]);
    mockFetchCatalogListings.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useMarketplaceCatalog(), { wrapper: readyWrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.listings).toEqual([catalogItemFromListingModel(cached)]);
    expect(result.current.shopsBySeller.get(cached.seller_id)?.name).toBe('Satoshi Vintage');
    await waitFor(() =>
      expect(mockFetchCatalogListings).toHaveBeenCalledWith({
        saleFormat: 'all',
        conditions: [],
        sort: 'recommended',
        countryCode: null,
      }),
    );
  });

  it('seeds shopsBySeller from SSR shop records before Dexie hydrates', () => {
    mockGetAllShops.mockReturnValue(undefined);
    const shop = createCommerceShopFixture({ name: 'Satoshi Vintage' });

    const { result } = renderHook(() => useMarketplaceCatalog([], [shop]), { wrapper: readyWrapper });

    expect(result.current.shopsBySeller.get(shop.ownerPubky)?.name).toBe('Satoshi Vintage');
  });

  it('renders index-discovered entries without any cached record', () => {
    const entry = createCommerceCatalogEntryFixture();
    mockGetAllCatalogEntries.mockReturnValue([entry]);

    const { result } = renderHook(() => useMarketplaceCatalog(), { wrapper: readyWrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.listings).toEqual([catalogItemFromCatalogEntry(entry)]);
  });

  it('stays in the loading state over an empty cache until the first refresh settles', async () => {
    let rejectRefresh: ((reason: Error) => void) | undefined;
    mockFetchCatalogListings.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      }),
    );

    const { result } = renderHook(() => useMarketplaceCatalog(), { wrapper: readyWrapper });

    expect(result.current.isLoading).toBe(true);

    act(() => rejectRefresh?.(new Error('nexus unreachable')));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.listings).toEqual([]);
  });

  it('keeps rendering the cached catalog when the Nexus refresh fails', async () => {
    const cached = toCommerceListingModel(createCommerceListingFixture());
    mockGetAllListings.mockReturnValue([cached]);
    mockFetchCatalogListings.mockRejectedValue(new Error('nexus unreachable'));

    const { result } = renderHook(() => useMarketplaceCatalog(), { wrapper: readyWrapper });

    await waitFor(() => expect(mockFetchCatalogListings).toHaveBeenCalled());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.listings).toEqual([catalogItemFromListingModel(cached)]);
  });

  it('never queries Nexus in sandbox mode and reads only the seeded cache', () => {
    mockGetCommerceAdapterMode.mockReturnValue('sandbox');
    const cached = toCommerceListingModel(createCommerceListingFixture());
    mockGetAllListings.mockReturnValue([cached]);

    const { result } = renderHook(() => useMarketplaceCatalog(), { wrapper: readyWrapper });

    expect(mockFetchCatalogListings).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.listings).toEqual([catalogItemFromListingModel(cached)]);
    expect(result.current.adapterMode).toBe('sandbox');
  });

  it('refetches from Nexus when server-side filters change', async () => {
    renderHook(() => useMarketplaceCatalog(), { wrapper: readyWrapper });

    await waitFor(() =>
      expect(mockFetchCatalogListings).toHaveBeenCalledWith({
        saleFormat: 'all',
        conditions: [],
        sort: 'recommended',
        countryCode: null,
      }),
    );

    act(() => useCommerceStore.getState().setSaleFormat('auction'));

    await waitFor(() =>
      expect(mockFetchCatalogListings).toHaveBeenLastCalledWith({
        saleFormat: 'auction',
        conditions: [],
        sort: 'recommended',
        countryCode: null,
      }),
    );
    expect(mockFetchCatalogListings).toHaveBeenCalledTimes(2);
  });

  it('refetches from Nexus when the sort switches to ending soon', async () => {
    renderHook(() => useMarketplaceCatalog(), { wrapper: readyWrapper });

    await waitFor(() => expect(mockFetchCatalogListings).toHaveBeenCalledTimes(1));

    act(() => useCommerceStore.getState().setSort('ending_soon'));

    await waitFor(() =>
      expect(mockFetchCatalogListings).toHaveBeenLastCalledWith({
        saleFormat: 'all',
        conditions: [],
        sort: 'ending_soon',
        countryCode: null,
      }),
    );
  });
});
