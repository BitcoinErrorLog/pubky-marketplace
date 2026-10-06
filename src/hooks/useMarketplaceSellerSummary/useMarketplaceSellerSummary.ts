'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import type { CommerceSellerReputationOverview } from '@/application/commerce/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useSellerReputation } from '@/hooks/useMarketplaceReviews/useMarketplaceReviews';
import type { CommerceShopModelSchema } from '@/models/commerce/commerce.schema';

export interface MarketplaceSellerSummary {
  shop: CommerceShopModelSchema | null | undefined;
  reputation: CommerceSellerReputationOverview | { status: 'loading' };
  displayName: string;
}

export function useMarketplaceSellerSummary(
  sellerPubky: string,
  options?: { includeReputation?: boolean },
): MarketplaceSellerSummary {
  const includeReputation = options?.includeReputation !== false;
  const shop = useLiveQuery(() => CommerceController.getShop(sellerPubky), [sellerPubky]);
  const reputation = useSellerReputation(sellerPubky, { enabled: includeReputation });

  return {
    shop,
    reputation,
    displayName: shop?.record.name ?? `${sellerPubky.slice(0, 10)}…`,
  };
}
