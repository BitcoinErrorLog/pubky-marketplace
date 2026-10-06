'use client';

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';

export function useCommerceShopFollow(sellerPubky: string) {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const { requireAuth } = useRequireAuth();
  const [isMutating, setIsMutating] = useState(false);
  const followed = useLiveQuery(
    () => (currentUserPubky ? CommerceController.isShopFollowed(sellerPubky) : false),
    [currentUserPubky, sellerPubky],
  );

  const toggle = async (): Promise<void> => {
    const mutation = requireAuth(async () => {
      setIsMutating(true);
      try {
        if (followed) {
          await CommerceController.commitDeleteShopFollow(sellerPubky);
        } else {
          await CommerceController.commitCreateShopFollow(sellerPubky);
        }
      } catch {
        toast({ variant: 'error', description: 'Could not update this shop follow.' });
      } finally {
        setIsMutating(false);
      }
    });
    await mutation;
  };

  return {
    isFollowing: followed ?? false,
    isLoading: Boolean(currentUserPubky) && followed === undefined,
    isMutating,
    toggle,
  };
}
