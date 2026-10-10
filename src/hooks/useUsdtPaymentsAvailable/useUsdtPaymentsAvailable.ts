'use client';

import { useUsdtPaymentsCapability } from '@/hooks/useUsdtPaymentsCapability/useUsdtPaymentsCapability';

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
  return useUsdtPaymentsCapability(enabled).status === 'available';
}
