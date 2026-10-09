'use client';

import { Package } from 'lucide-react';
import { getMarketplaceListingRoute } from '@/app/routes';
import { Image } from '@/atoms/Image/Image';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceOrderItemMedia } from '@/hooks/useMarketplaceOrderItemMedia/useMarketplaceOrderItemMedia';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { parseListingAggregateId } from '@/libs/commerce/marketplace-conversation-query';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

export function MarketplaceCheckoutItem({ line }: { line: MarketplaceOrder['lines'][number] }) {
  const coverUrl = useMarketplaceOrderItemMedia(line.listingAggregateId);
  const listing = parseListingAggregateId(line.listingAggregateId);
  const variantLabel = line.variantOptions?.map(({ name, value }) => `${name}: ${value}`).join(' · ');

  return (
    <div className="flex items-center gap-4 rounded-md bg-background p-4">
      <div className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand/15">
        <Package className="size-7 text-brand" aria-hidden="true" />
        {coverUrl && <Image src={coverUrl} alt="" fill sizes="80px" className="object-cover object-center" />}
      </div>
      <div className="grid min-w-0 flex-1 gap-1">
        <Typography as="p" className="font-semibold break-words">
          {listing ? (
            <Link
              href={getMarketplaceListingRoute(listing.sellerPubky, listing.listingId)}
              overrideDefaults
              className="hover:text-brand"
            >
              {line.title}
            </Link>
          ) : (
            line.title
          )}
        </Typography>
        {variantLabel && (
          <Typography as="p" className="text-sm text-muted-foreground">
            {variantLabel}
          </Typography>
        )}
        <Typography as="p" className="text-sm text-muted-foreground">
          Quantity {line.quantity}
        </Typography>
        <Typography as="p" className="font-semibold text-brand">
          {formatCommerceMoney(line.subtotal)}
        </Typography>
      </div>
    </div>
  );
}
