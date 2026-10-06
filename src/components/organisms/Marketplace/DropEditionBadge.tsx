'use client';

import { Hash } from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceDropEdition } from '@/hooks/useMarketplaceDropEdition/useMarketplaceDropEdition';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

/**
 * The numbered-edition badge for a paid drop order (ADR 0026): the edition
 * comes ONLY from the order projection — assigned inside the exactly-once
 * payment confirmation — so an order without one renders nothing.
 */
export function DropEditionBadge({ order }: { order: MarketplaceOrder }) {
  const { edition } = useMarketplaceDropEdition(order);
  if (edition === null) return null;
  return (
    <Badge variant="secondary">
      <Hash className="mr-1 size-3" />
      Edition {edition}
    </Badge>
  );
}

/**
 * The receipt-context edition line: "Edition N of M" beside the portable
 * receipt facts. The same pair travels inside the receipt's
 * `pubky-drop-edition+v1` attestation, which the receipt publisher verified
 * OFFLINE before writing the record to the homeserver — this line renders
 * that already-verified fact and never re-verifies in the UI.
 */
export function DropEditionReceiptLine({ order }: { order: MarketplaceOrder }) {
  const { edition, of } = useMarketplaceDropEdition(order);
  if (edition === null) return null;
  return (
    <Typography as="p" className="text-sm text-muted-foreground">
      <Hash className="mr-1 inline size-3.5 text-brand" aria-hidden="true" />
      Edition {edition}
      {of !== null ? ` of ${of}` : ''} · verified offline before publishing
    </Typography>
  );
}
