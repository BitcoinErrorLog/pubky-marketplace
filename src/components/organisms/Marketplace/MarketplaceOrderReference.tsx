'use client';

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Link } from '@/atoms/Link/Link';
import { formatOrderInstant } from '@/libs/commerce/checkout-hold';
import { copyToClipboard } from '@/libs/utils/utils';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { sellerPaypalActivityUrl, shortOrderReference } from './order-reference';

export function MarketplaceOrderReference({
  order,
  isBuyer,
  showPlacedAt = false,
}: {
  order: MarketplaceOrder;
  isBuyer: boolean;
  showPlacedAt?: boolean;
}) {
  const reference = shortOrderReference(order.id);
  const paypalUrl = sellerPaypalActivityUrl(order, isBuyer);
  const placedAt = showPlacedAt ? formatOrderInstant(order.createdAt) : null;
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="order-reference">
      <span className="text-sm font-medium" data-testid="order-reference-label">
        Order {reference}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        data-testid="order-reference-copy"
        onClick={() => {
          void copyToClipboard({ text: reference })
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {placedAt ? (
        <time dateTime={order.createdAt} className="text-sm text-muted-foreground" data-testid="order-placed-at">
          Placed {placedAt}
        </time>
      ) : null}
      {paypalUrl ? (
        <Link
          href={paypalUrl}
          overrideDefaults
          data-testid="open-in-paypal"
          className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
        >
          Open in PayPal
          <ExternalLink className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}
