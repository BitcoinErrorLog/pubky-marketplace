import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { MARKETPLACE_DISPLAY_PERSIST_KEY } from '../persistedKeys';
import {
  MarketplaceDisplayActionTypes,
  marketplaceDisplayInitialState,
  type MarketplaceDisplayStore,
} from './marketplace-display.types';

/**
 * Device-level marketplace display preferences: the approximate-conversion
 * toggle and the measurement system. Display-only state — nothing
 * transactional reads it — persisted in localStorage like the app's other
 * display settings.
 */
export const useMarketplaceDisplayStore = create<MarketplaceDisplayStore>()(
  devtools(
    persist(
      (set) => ({
        ...marketplaceDisplayInitialState,
        setDisplayCurrency: (displayCurrency) => set({ displayCurrency }),
        setShowFxEstimate: (showFxEstimate) =>
          set({ showFxEstimate }, false, MarketplaceDisplayActionTypes.SET_SHOW_FX_ESTIMATE),
        setMeasurementSystem: (measurementSystem) =>
          set({ measurementSystem }, false, MarketplaceDisplayActionTypes.SET_MEASUREMENT_SYSTEM),
      }),
      {
        name: MARKETPLACE_DISPLAY_PERSIST_KEY,
        partialize: (state) => ({
          displayCurrency: state.displayCurrency,
          showFxEstimate: state.showFxEstimate,
          measurementSystem: state.measurementSystem,
        }),
      },
    ),
    {
      name: 'marketplace-display-store',
      enabled: process.env.NODE_ENV === 'development',
    },
  ),
);
