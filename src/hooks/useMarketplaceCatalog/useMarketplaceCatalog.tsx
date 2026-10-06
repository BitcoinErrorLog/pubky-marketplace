'use client';

import { useContext, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getCommerceAdapterMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { Logger } from '@/libs/logger/logger';
import { DatabaseContext } from '@/providers/DatabaseProvider/DatabaseProvider';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  applyMarketplaceAttributeFilters,
  buildMarketplaceCatalogItems,
  filterMarketplaceCatalog,
  type MarketplaceCatalogFilters,
  type MarketplaceCatalogItem,
} from './useMarketplaceCatalog.utils';

export function useMarketplaceCatalog(
  initialListings: MarketplaceCatalogItem[] = [],
  initialShops: CommerceShopRecord[] = [],
  filters?: MarketplaceCatalogFilters,
) {
  const { isReady: isDatabaseReady } = useContext(DatabaseContext);
  const storedQuery = useCommerceStore((state) => state.query);
  const query = filters ? filters.query : storedQuery;
  const storedCategoryId = useCommerceStore((state) => state.categoryId);
  const categoryId = filters ? filters.categoryId : storedCategoryId;
  const attributeFilters = useCommerceStore((state) => state.attributeFilters);
  const storedSaleFormat = useCommerceStore((state) => state.saleFormat);
  const saleFormat = filters ? filters.saleFormat : storedSaleFormat;
  const storedConditions = useCommerceStore((state) => state.conditions);
  const conditions = filters ? filters.conditions : storedConditions;
  const storedMinimumPriceMinor = useCommerceStore((state) => state.minimumPriceMinor);
  const minimumPriceMinor = filters ? filters.minimumPriceMinor : storedMinimumPriceMinor;
  const storedMaximumPriceMinor = useCommerceStore((state) => state.maximumPriceMinor);
  const maximumPriceMinor = filters ? filters.maximumPriceMinor : storedMaximumPriceMinor;
  const storedCountryCode = useCommerceStore((state) => state.countryCode);
  const countryCode = filters ? filters.countryCode : storedCountryCode;
  const storedSort = useCommerceStore((state) => state.sort);
  const sort = filters ? filters.sort : storedSort;
  const adapterMode = getCommerceAdapterMode();

  // Sandbox catalogs are seeded locally and never query Nexus (see
  // docs/ecommerce/RUNNING.md), so in that mode there is no refresh to wait for.
  const [isRefreshing, setIsRefreshing] = useState(adapterMode !== 'sandbox');

  useEffect(() => {
    if (adapterMode === 'sandbox' || !isDatabaseReady) return;

    let active = true;
    setIsRefreshing(true);
    CommerceController.fetchCatalogListings({ saleFormat, conditions, sort, countryCode })
      .catch((error) => {
        // The catalog keeps rendering from the local cache when the index is
        // unreachable; discovery just does not widen until it comes back.
        Logger.warn('[useMarketplaceCatalog] Nexus catalog refresh failed; rendering cached catalog', { error });
      })
      .finally(() => {
        if (active) setIsRefreshing(false);
      });

    return () => {
      active = false;
    };
  }, [adapterMode, isDatabaseReady, saleFormat, conditions, sort, countryCode]);

  // The grid renders from both catalog sources: index projections cached by
  // discovery (no homeserver round-trips) and canonical records that are
  // already local (opened listings, own listings, sandbox seeds).
  const localListings = useLiveQuery(
    () => (isDatabaseReady ? CommerceController.getAllListings() : undefined),
    [isDatabaseReady],
  );
  const catalogEntries = useLiveQuery(
    () => (isDatabaseReady ? CommerceController.getAllCatalogEntries() : undefined),
    [isDatabaseReady],
  );
  const localShops = useLiveQuery(
    () => (isDatabaseReady ? CommerceController.getAllShops() : undefined),
    [isDatabaseReady],
  );
  // While a refresh is in flight over an empty cache, stay in the loading
  // state so the skeleton shows instead of flashing "No listings match"
  // before the first discovery results land.
  const isCacheUnresolved = localListings === undefined || catalogEntries === undefined || localShops === undefined;
  const isCacheEmpty =
    localListings !== undefined && catalogEntries !== undefined && localListings.length + catalogEntries.length === 0;
  const isLoading = isCacheUnresolved || (isCacheEmpty && isRefreshing);
  // SSR and the first client paint have no Dexie snapshot yet. Keep the
  // server-fetched catalog mounted so hydration does not replace it with a
  // skeleton.
  const sourceItems =
    isLoading && initialListings.length > 0
      ? initialListings
      : buildMarketplaceCatalogItems(localListings ?? [], catalogEntries ?? []);
  // The facet pool matches every filter EXCEPT the attribute filters, so the
  // facet chips keep offering alternatives to the active value.
  const facetPool = filterMarketplaceCatalog(sourceItems, {
    query,
    categoryId,
    saleFormat,
    conditions,
    minimumPriceMinor,
    maximumPriceMinor,
    countryCode,
    sort,
  });
  const countryFacetPool = filterMarketplaceCatalog(sourceItems, {
    query,
    categoryId,
    saleFormat,
    conditions,
    minimumPriceMinor,
    maximumPriceMinor,
    countryCode: null,
    sort,
  });
  const listings = applyMarketplaceAttributeFilters(facetPool, filters ? {} : attributeFilters);
  const shopsBySeller = new Map<string, (typeof initialShops)[number]>(
    initialShops.map((shop) => [shop.ownerPubky, shop]),
  );
  for (const { owner_id, record } of localShops ?? []) {
    shopsBySeller.set(owner_id, record);
  }

  return {
    listings,
    facetPool,
    countryFacetPool,
    shopsBySeller,
    isLoading,
    adapterMode,
  };
}
