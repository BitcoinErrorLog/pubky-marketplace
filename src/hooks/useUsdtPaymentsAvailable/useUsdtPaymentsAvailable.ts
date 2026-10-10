'use client';

import { useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';

/**
 * The single gate for every new USDT offer (docs/ecommerce/usdt-payments.md):
 * true only when the Shop's `usdtPaymentsEnabled` flag is on AND the service
 * reports `usdt_payments.available` on `/health`. False while loading and on a
 * failed read, so no USDT affordance appears on an unreadable service. It
 * never gates how an existing USDT order is displayed. A surface that has no
 * use for the answer (a sandbox checkout, an already-bound order) passes
 * `enabled = false` and the capability is never read.
 */
export function useUsdtPaymentsAvailable(enabled = true): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    CommerceController.fetchUsdtPaymentsAvailable()
      .then((next) => {
        if (active) setAvailable(next);
      })
      .catch(() => {
        if (active) setAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [enabled]);
  return enabled && available;
}
