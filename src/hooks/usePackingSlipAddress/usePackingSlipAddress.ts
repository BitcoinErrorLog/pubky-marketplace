'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';

export type UsePackingSlipAddressResult = {
  /** The pasted delivery address, or '' when nothing is staged. */
  address: string;
  /** Stage the next value (wire to the textarea's onChange). */
  setAddress: (next: string) => void;
  /** Drop the staged address (the dialog calls this on close). */
  clear: () => void;
  /** The seller-only order detail, held in memory for this print dialog. */
  sellerOrder: MarketplaceOrder | null;
};

/**
 * Local-only staging for a delivery address the seller pastes into the
 * packing slip so it prints on the slip instead of being hand-copied.
 *
 * PRIVACY INVARIANT: the value lives ONLY in this component state. It is
 * never persisted (no Dexie, no localStorage/sessionStorage, no URL), never
 * logged, and never sent anywhere — it exists only so `window.print()` can
 * put it on paper. It is cleared on print completion and on route change;
 * the dialog clears it on close.
 *
 * This does not weaken the delivery-address boundary (ADR-0019 §8,
 * docs/ecommerce/shipping.md): a service-provided address is accepted only
 * from the seller's paid/processing shipping order projection. The pasted
 * fallback remains local-only and is never sent anywhere.
 */
export function usePackingSlipAddress({
  order,
  enabled = false,
}: {
  order?: MarketplaceOrder;
  enabled?: boolean;
} = {}): UsePackingSlipAddressResult {
  const [address, setAddress] = useState('');
  const [sellerOrder, setSellerOrder] = useState<MarketplaceOrder | null>(null);
  const pathname = usePathname();
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);

  // Route change: the address must not outlive the screen it was pasted on.
  // This also fires on mount, which is a no-op against the initial ''.
  useEffect(() => {
    setAddress('');
    setSellerOrder(null);
  }, [pathname, currentUserPubky]);

  useEffect(() => {
    setSellerOrder(null);
    if (
      !enabled ||
      !order ||
      currentUserPubky !== order.sellerPubky ||
      order.fulfillment !== 'shipping' ||
      !['paid', 'processing'].includes(order.state)
    ) {
      return;
    }

    let active = true;
    void CommerceController.getMarketplaceOrder(order.id)
      .then((freshOrder) => {
        if (
          active &&
          freshOrder &&
          freshOrder.sellerPubky === currentUserPubky &&
          freshOrder.fulfillment === 'shipping' &&
          ['paid', 'processing'].includes(freshOrder.state)
        ) {
          setSellerOrder(freshOrder);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [currentUserPubky, enabled, order]);

  // Print completion: the address's only job was the printed slip.
  useEffect(() => {
    const clearAfterPrint = () => setAddress('');
    window.addEventListener('afterprint', clearAfterPrint);
    return () => window.removeEventListener('afterprint', clearAfterPrint);
  }, []);

  const clear = () => {
    setAddress('');
    setSellerOrder(null);
  };

  return { address, setAddress, clear, sellerOrder };
}
