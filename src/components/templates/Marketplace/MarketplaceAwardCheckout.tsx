'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getMarketplaceOfferCheckoutRoute } from '@/libs/commerce/checkout-phase';

/** Leftover mounts of the retired award-checkout template join the one Checkout screen. */
export function MarketplaceAwardCheckout() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const offer = searchParams.get('offer');

  useEffect(() => {
    router.replace(getMarketplaceOfferCheckoutRoute(offer));
  }, [offer, router]);

  return null;
}
