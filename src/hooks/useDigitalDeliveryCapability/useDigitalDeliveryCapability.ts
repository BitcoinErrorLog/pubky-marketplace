'use client';

import { useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceDigitalDeliveryCapability } from '@/libs/commerce/digital';
import { availablePaymentMethods } from '@/libs/commerce/payment-methods';
import { useAuthStore } from '@/stores/auth/auth.store';

const UNAVAILABLE: MarketplaceDigitalDeliveryCapability = { available: false, maxBytes: null };

/**
 * The deployment's digital delivery capability (digital delivery design §6
 * B5), read once from `/health`. Null while loading; a failed read is
 * unavailable, so no digital affordance appears on an unreadable service.
 */
export function useDigitalDeliveryCapability(): MarketplaceDigitalDeliveryCapability | null {
  const [capability, setCapability] = useState<MarketplaceDigitalDeliveryCapability | null>(null);
  useEffect(() => {
    let active = true;
    CommerceController.fetchDigitalDeliveryCapability()
      .then((next) => {
        if (active) setCapability(next);
      })
      .catch(() => {
        if (active) setCapability(UNAVAILABLE);
      });
    return () => {
      active = false;
    };
  }, []);
  return capability;
}

/**
 * True when the signed-in seller's shop accepts PayPal (§5): digital
 * listings then carry the reversal warning. A failed read shows no warning
 * rather than a wrong one.
 */
export function useSellerAcceptsPaypal(): boolean {
  const sellerPubky = useAuthStore((state) => state.currentUserPubky);
  const [acceptsPaypal, setAcceptsPaypal] = useState(false);
  useEffect(() => {
    if (!sellerPubky) {
      setAcceptsPaypal(false);
      return;
    }
    let active = true;
    CommerceController.getSellerPaymentConfig(sellerPubky)
      .then((config) => {
        if (active) setAcceptsPaypal(availablePaymentMethods(config).includes('paypal'));
      })
      .catch(() => {
        if (active) setAcceptsPaypal(false);
      });
    return () => {
      active = false;
    };
  }, [sellerPubky]);
  return acceptsPaypal;
}
