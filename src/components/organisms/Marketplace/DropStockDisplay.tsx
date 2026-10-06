'use client';

import { Boxes } from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { deriveDropStockDisplay, DROP_STOCK_BAND_LABELS } from '@/hooks/useMarketplaceDrop/drop-display';
import type { MarketplacePublicDrop } from '@/services/marketplace/marketplace';

/**
 * Truthful, seller-configurable stock display (ADR 0026): an exact number
 * when the projection carries `remaining`, a band label when it carries
 * `remainingBand`, and NOTHING when the seller hides stock — never an
 * invented level, never "high demand" theater. Renders null for `hidden`
 * on purpose: absence is the honest display.
 */
export function DropStockDisplay({ projection }: { projection: MarketplacePublicDrop }) {
  const stock = deriveDropStockDisplay(projection);
  if (stock.kind === 'hidden') return null;
  return (
    <Badge variant={stock.kind === 'exact' && stock.remaining === 0 ? 'outline' : 'secondary'}>
      <Boxes className="mr-1 size-3" />
      {stock.kind === 'exact'
        ? `${stock.remaining} of ${projection.totalQuantity} left`
        : DROP_STOCK_BAND_LABELS[stock.band]}
    </Badge>
  );
}
