import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { CommerceActionTypes, commerceInitialState, type CommerceStore } from './commerce.types';

export const useCommerceStore = create<CommerceStore>()(
  devtools(
    (set) => ({
      ...commerceInitialState,
      setQuery: (query) => set({ query }, false, CommerceActionTypes.SET_QUERY),
      // Attribute filters are scoped to a category, so changing it clears them.
      setCategoryId: (categoryId) => set({ categoryId, attributeFilters: {} }, false, CommerceActionTypes.SET_CATEGORY),
      setAttributeFilter: (key, value) =>
        set(
          (state) => ({
            attributeFilters:
              value === null
                ? Object.fromEntries(Object.entries(state.attributeFilters).filter(([entryKey]) => entryKey !== key))
                : { ...state.attributeFilters, [key]: value },
          }),
          false,
          CommerceActionTypes.SET_ATTRIBUTE_FILTER,
        ),
      setSaleFormat: (saleFormat) => set({ saleFormat }, false, CommerceActionTypes.SET_SALE_FORMAT),
      setConditions: (conditions) =>
        set({ conditions: [...new Set(conditions)] }, false, CommerceActionTypes.SET_CONDITIONS),
      setPriceRange: (minimumPriceMinor, maximumPriceMinor) =>
        set({ minimumPriceMinor, maximumPriceMinor }, false, CommerceActionTypes.SET_PRICE_RANGE),
      setCountryCode: (countryCode) => set({ countryCode }, false, CommerceActionTypes.SET_COUNTRY),
      setSort: (sort) => set({ sort }, false, CommerceActionTypes.SET_SORT),
      setLayout: (layout) => set({ layout }, false, CommerceActionTypes.SET_LAYOUT),
      setSelectedListingId: (selectedListingId) =>
        set({ selectedListingId }, false, CommerceActionTypes.SET_SELECTED_LISTING),
      setEntityPending: (entityId, isPending) =>
        set(
          (state) => ({
            pendingEntityIds: isPending
              ? state.pendingEntityIds.includes(entityId)
                ? state.pendingEntityIds
                : [...state.pendingEntityIds, entityId]
              : state.pendingEntityIds.filter((pendingId) => pendingId !== entityId),
          }),
          false,
          CommerceActionTypes.SET_ENTITY_PENDING,
        ),
      setMarketplaceSession: (marketplaceSession) =>
        set({ marketplaceSession }, false, CommerceActionTypes.SET_MARKETPLACE_SESSION),
      setInventorySession: (inventorySession) =>
        set({ inventorySession }, false, CommerceActionTypes.SET_INVENTORY_SESSION),
      setWatchlistSyncStatus: (watchlistSyncStatus) =>
        set({ watchlistSyncStatus }, false, CommerceActionTypes.SET_WATCHLIST_SYNC_STATUS),
      setReceiptsPublicationStatus: (receiptsPublicationStatus) =>
        set({ receiptsPublicationStatus }, false, CommerceActionTypes.SET_RECEIPTS_PUBLICATION_STATUS),
      resetFilters: () =>
        set(
          {
            query: commerceInitialState.query,
            categoryId: commerceInitialState.categoryId,
            attributeFilters: commerceInitialState.attributeFilters,
            saleFormat: commerceInitialState.saleFormat,
            conditions: commerceInitialState.conditions,
            minimumPriceMinor: commerceInitialState.minimumPriceMinor,
            maximumPriceMinor: commerceInitialState.maximumPriceMinor,
            countryCode: commerceInitialState.countryCode,
            sort: commerceInitialState.sort,
          },
          false,
          CommerceActionTypes.RESET_FILTERS,
        ),
      reset: () => set(commerceInitialState, false, CommerceActionTypes.RESET),
    }),
    {
      name: 'commerce-store',
      enabled: process.env.NODE_ENV === 'development',
    },
  ),
);
