'use client';

import { useEffect, useState } from 'react';
import { defaultMeasurementSystemForLocale, type MeasurementSystem } from '@/libs/commerce/units';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';

/**
 * The measurement system dimensions and weight render in: the user's explicit
 * preference when set, otherwise the browser locale default (en-US →
 * imperial, else metric). The locale is read in an effect so server and
 * first client render agree (metric) before the locale-specific value lands.
 */
export function useMeasurementSystem(): MeasurementSystem {
  const chosen = useMarketplaceDisplayStore((state) => state.measurementSystem);
  const [localeDefault, setLocaleDefault] = useState<MeasurementSystem>('metric');

  useEffect(() => {
    setLocaleDefault(defaultMeasurementSystemForLocale(navigator.language));
  }, []);

  return chosen ?? localeDefault;
}
