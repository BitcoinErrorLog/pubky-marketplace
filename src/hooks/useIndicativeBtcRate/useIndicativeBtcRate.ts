'use client';

import { useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { BtcRate } from '@/services/exchangerate/exchangerate.types';

/**
 * The BTC/USD rate backing the indicative "≈" price estimates. Cached at the
 * service layer for five minutes.
 *
 * @param enabled Skip the fetch entirely (e.g. the estimate toggle is off or
 * the price's asset has no rate source).
 * @returns The rate, or `null` while loading, disabled, or when the rate is
 * unavailable — callers must render NO estimate on `null`, never a fallback.
 */
export function useIndicativeBtcRate(enabled: boolean): BtcRate | null {
  const [rate, setRate] = useState<BtcRate | null>(null);

  useEffect(() => {
    // Avoid fetching on server to prevent hydration errors
    if (typeof window === 'undefined') return;
    if (!enabled) return;

    let active = true;
    CommerceController.getIndicativeBtcRate()
      .then((fetched) => {
        if (active) setRate(fetched);
      })
      .catch(() => {
        if (active) setRate(null);
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  return enabled ? rate : null;
}
