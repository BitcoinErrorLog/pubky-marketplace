'use client';

import { getMarketplaceShopRoute } from '@/app/routes';
import { Link } from '@/atoms/Link/Link';
import { useMarketplaceSellerSummary } from '@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary';

export function MarketplaceSellerLink({ sellerPubky }: { sellerPubky: string }) {
  const seller = useMarketplaceSellerSummary(sellerPubky, { includeReputation: false });

  return (
    <Link
      href={getMarketplaceShopRoute(sellerPubky)}
      overrideDefaults
      className="block w-fit text-sm text-muted-foreground transition-colors hover:text-brand"
    >
      {seller.displayName}
    </Link>
  );
}
