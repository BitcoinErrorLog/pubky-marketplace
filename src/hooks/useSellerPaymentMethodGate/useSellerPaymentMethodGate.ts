'use client';

import { useEffect, useState } from 'react';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  evaluateSellerPaymentMethodGate,
  type SellerPaymentMethodGateReason,
} from '@/libs/commerce/listing-publish-guards';
import { useAuthStore } from '@/stores/auth/auth.store';

export function useSellerPaymentMethodGate(): {
  isDurable: boolean;
  ready: boolean;
  reason: SellerPaymentMethodGateReason | null;
} {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isDurable = isDurableCommerceMode(getCommerceAdapterMode());
  const [ready, setReady] = useState(!isDurable);
  const [reason, setReason] = useState<SellerPaymentMethodGateReason | null>(null);

  useEffect(() => {
    if (!isDurable) {
      setReason(null);
      setReady(true);
      return;
    }
    let active = true;
    setReady(false);
    void evaluateSellerPaymentMethodGate({
      ownerPubky: currentUserPubky,
      loadPaymentConfig: (pubky) => CommerceController.getSellerPaymentConfig(pubky),
    }).then((next) => {
      if (!active) return;
      setReason(next);
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, [currentUserPubky, isDurable]);

  return { isDurable, ready, reason };
}
