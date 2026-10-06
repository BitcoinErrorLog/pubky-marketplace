'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * Cart badge count for the marketplace navigation.
 *
 * HONESTY CONTRACT: this is the same number the cart page itself shows — the
 * total quantity across the account-scoped local cart lines whose listing
 * still resolves from the local catalog (a line whose listing vanished
 * renders nothing on the cart page, so it must not count here either).
 * Everything is read live from Dexie, so cart mutations refresh the badge
 * without any extra wiring. Zero renders no badge.
 */
export function useMarketplaceCartCount(): number {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);

  return (
    useLiveQuery(async () => {
      if (!currentUserPubky) return 0;
      const rows = await CommerceController.getCartItems();
      const listings = await CommerceController.getManyListings(rows.map((row) => row.listing_id));
      return rows.reduce((total, row) => total + (listings.has(row.listing_id) ? row.quantity : 0), 0);
    }, [currentUserPubky]) ?? 0
  );
}
