'use client';

import { useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';

/**
 * What the Shop knows about the service's USDT capability
 * (docs/ecommerce/usdt-payments.md):
 *
 * - `checking`: the first read is still in flight, or the surface opted out.
 * - `available`: the Shop flag is on and `/health` reports `usdt_payments.available`.
 * - `unavailable`: the Shop flag is off, or `/health` answered without the key.
 * - `unreadable`: the Shop flag is on but `/health` could not be read.
 *
 * `unreadable` is not `unavailable`: the service may well offer USDT, so a
 * surface that explains itself (the seller's settings) says "can't be checked
 * right now" instead of hiding.
 */
export type UsdtCapabilityStatus = 'checking' | 'available' | 'unavailable' | 'unreadable';

async function readCapability(): Promise<Exclude<UsdtCapabilityStatus, 'checking'>> {
  try {
    return (await CommerceController.fetchUsdtPaymentsAvailable()) ? 'available' : 'unavailable';
  } catch {
    return 'unreadable';
  }
}

export function useUsdtPaymentsCapability(enabled = true): {
  status: UsdtCapabilityStatus;
  recheck: () => Promise<void>;
} {
  const [status, setStatus] = useState<UsdtCapabilityStatus>('checking');
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void readCapability().then((next) => {
      if (active) setStatus(next);
    });
    return () => {
      active = false;
    };
  }, [enabled]);
  const recheck = async () => {
    setStatus(await readCapability());
  };
  return { status: enabled ? status : 'checking', recheck };
}
