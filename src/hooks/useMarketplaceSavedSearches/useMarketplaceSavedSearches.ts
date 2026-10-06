'use client';

import { useCallback, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  COMMERCE_SAVED_SEARCH_CHECK_MAX,
  COMMERCE_WATCH_CHECK_MIN_INTERVAL_MS,
  getCommerceAdapterMode,
} from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import { Logger } from '@/libs/logger/logger';
import type { CommerceSavedSearchModelSchema, CommerceSavedSearchParams } from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { buildMarketplaceCatalogItems } from '../useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { matchSavedSearch, summarizeSavedSearchMatches } from './useMarketplaceSavedSearches.utils';

/** Check passes already run this session, per account — same spacing rationale as watch detection. */
const lastCheckRunAt = new Map<string, number>();

async function loadCatalogItems() {
  const [listings, entries] = await Promise.all([
    CommerceController.getAllListings(),
    CommerceController.getAllCatalogEntries(),
  ]);
  return buildMarketplaceCatalogItems(listings, entries);
}

/**
 * Runs every saved search (bounded) against the freshest catalog the client
 * can obtain and records how many matches are NEW past each search's
 * acknowledged watermark. Non-sandbox modes first refresh discovery from the
 * Nexus listing stream — one request per distinct server-side filter combo,
 * deduplicated across searches; sandbox mode checks its locally seeded
 * catalog (it never queries Nexus). Counting is done client-side with the
 * exact filter the catalog page uses, so a NEW badge always corresponds to
 * rows the user would actually see by opening the search.
 */
async function runSavedSearchChecks(): Promise<void> {
  const searches = await CommerceController.getSavedSearches();
  const toCheck = searches.slice(0, COMMERCE_SAVED_SEARCH_CHECK_MAX);
  if (toCheck.length === 0) return;

  const serverCombos = new Map<string, CommerceSavedSearchParams>();
  for (const search of toCheck) {
    const key = [
      search.params.saleFormat,
      search.params.conditions.length === 1 ? search.params.conditions[0] : '*',
      search.params.sort === 'ending_soon' ? 'ends_at' : 'timeline',
    ].join('|');
    if (!serverCombos.has(key)) serverCombos.set(key, search.params);
  }
  const refreshes = await Promise.allSettled(
    [...serverCombos.values()].map((params) =>
      CommerceController.fetchCatalogListings({
        saleFormat: params.saleFormat,
        conditions: params.conditions,
        sort: params.sort,
      }),
    ),
  );
  for (const refresh of refreshes) {
    if (refresh.status === 'rejected') {
      // Checks proceed against the cache; badges may lag, they never lie.
      Logger.warn('Saved-search discovery refresh failed; checking against the cached catalog', {
        error: refresh.reason,
      });
    }
  }

  const items = await loadCatalogItems();
  const checkedAt = Date.now();
  for (const search of toCheck) {
    const summary = summarizeSavedSearchMatches(matchSavedSearch(items, search.params), search.watermark_updated_at);
    await CommerceController.recordSavedSearchCheck(search.id, {
      newCount: summary.newCount,
      latestMatchUpdatedAt: summary.latestMatchUpdatedAt,
      checkedAt,
    });
  }
}

/**
 * Saved catalog searches for the marketplace page: live rows from Dexie, a
 * visit/focus-triggered NEW check (bounded and spaced — no background
 * daemon), and the save/apply/delete actions. Applying a search sets the
 * shared catalog filter state and acknowledges its watermark, so the NEW
 * badge clears exactly when the user has actually seen the results.
 */
export function useMarketplaceSavedSearches() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const enabled = Boolean(currentUserPubky) && getCommerceAdapterMode() !== 'unavailable';

  const searches =
    useLiveQuery(() => (currentUserPubky ? CommerceController.getSavedSearches() : []), [currentUserPubky]) ?? [];

  useEffect(() => {
    if (!enabled || !currentUserPubky) return;

    const runPass = () => {
      const lastRunAt = lastCheckRunAt.get(currentUserPubky) ?? 0;
      const now = Date.now();
      if (now - lastRunAt < COMMERCE_WATCH_CHECK_MIN_INTERVAL_MS) return;
      lastCheckRunAt.set(currentUserPubky, now);
      void runSavedSearchChecks().catch((error) => {
        Logger.warn('Saved-search check pass failed', { error });
      });
    };

    runPass();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') runPass();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', runPass);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', runPass);
    };
  }, [enabled, currentUserPubky]);

  /**
   * Saves the CURRENT catalog filter state under `name`. The initial
   * watermark is the newest `updated_at` among the search's current local
   * matches — the user just looked at those, so only later arrivals can
   * ever badge as NEW.
   */
  const saveCurrentSearch = useCallback(async (name: string): Promise<boolean> => {
    const state = useCommerceStore.getState();
    const params: CommerceSavedSearchParams = {
      query: state.query,
      categoryId: state.categoryId,
      saleFormat: state.saleFormat,
      conditions: state.conditions,
      minimumPriceMinor: state.minimumPriceMinor,
      maximumPriceMinor: state.maximumPriceMinor,
      countryCode: state.countryCode,
      sort: state.sort,
    };
    try {
      const items = await loadCatalogItems();
      const { latestMatchUpdatedAt } = summarizeSavedSearchMatches(matchSavedSearch(items, params), 0);
      await CommerceController.commitCreateSavedSearch(name, params, latestMatchUpdatedAt);
      return true;
    } catch (error) {
      toast({
        variant: 'error',
        description: marketplaceFailureMessage(marketplaceErrorCode(error), MARKETPLACE_FAILURE_MESSAGES.savedSearch),
      });
      return false;
    }
  }, []);

  /** Restores the saved filters into the shared catalog state and acknowledges the watermark. */
  const applySearch = useCallback(async (search: CommerceSavedSearchModelSchema): Promise<void> => {
    const store = useCommerceStore.getState();
    store.setQuery(search.params.query);
    store.setCategoryId(search.params.categoryId);
    store.setSaleFormat(search.params.saleFormat);
    store.setConditions(search.params.conditions);
    store.setPriceRange(search.params.minimumPriceMinor, search.params.maximumPriceMinor);
    store.setCountryCode(search.params.countryCode ?? null);
    store.setSort(search.params.sort);
    try {
      await CommerceController.acknowledgeSavedSearch(search.id);
    } catch (error) {
      Logger.warn('Failed to acknowledge a saved search', { error });
    }
  }, []);

  const deleteSearch = useCallback(async (id: string): Promise<void> => {
    try {
      await CommerceController.commitDeleteSavedSearch(id);
    } catch {
      toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.savedSearchDelete });
    }
  }, []);

  return { searches, isSignedIn: Boolean(currentUserPubky), saveCurrentSearch, applySearch, deleteSearch };
}
