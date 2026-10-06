import type { MeasurementSystem } from '@/libs/commerce/units';

export interface MarketplaceDisplayState {
  /** Preferred device-local currency for catalog display only. */
  displayCurrency: 'USD' | 'BTC';
  /** Show the approximate converted secondary price (fiat ↔ bitcoin) beside listing prices. */
  showFxEstimate: boolean;
  /** Chosen measurement system; `null` means follow the browser locale (en-US → imperial, else metric). */
  measurementSystem: MeasurementSystem | null;
}

export interface MarketplaceDisplayActions {
  setDisplayCurrency: (currency: 'USD' | 'BTC') => void;
  setShowFxEstimate: (showFxEstimate: boolean) => void;
  setMeasurementSystem: (measurementSystem: MeasurementSystem | null) => void;
}

export type MarketplaceDisplayStore = MarketplaceDisplayState & MarketplaceDisplayActions;

export const marketplaceDisplayInitialState: MarketplaceDisplayState = {
  displayCurrency: 'USD',
  showFxEstimate: true,
  measurementSystem: null,
};

export enum MarketplaceDisplayActionTypes {
  SET_SHOW_FX_ESTIMATE = 'marketplaceDisplay/setShowFxEstimate',
  SET_MEASUREMENT_SYSTEM = 'marketplaceDisplay/setMeasurementSystem',
}
