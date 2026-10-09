'use client';

import { useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';

/**
 * The single gate for every new USDT offer (docs/ecommerce/usdt-payments.md):
 * true only when the Shop's `usdtPaymentsEnabled` flag is on AND the service
 * reports `usdt_payments.available` on `/health`. False while loading and on a
 * failed read, so no USDT affordance appears on an unreadable service. It
 * never gates how an existing USDT order is displayed.
 */
export function useUsdtPaymentsAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
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
  }, []);
  return available;
}
