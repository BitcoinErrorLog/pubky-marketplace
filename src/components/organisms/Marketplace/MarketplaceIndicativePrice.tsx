'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/atoms/Tooltip/Tooltip';
import { Typography } from '@/atoms/Typography/Typography';
import { useIndicativeBtcRate } from '@/hooks/useIndicativeBtcRate/useIndicativeBtcRate';
import { indicativeCounterpartLabel } from '@/libs/commerce/pricing';
import type { CommerceMoney } from '@/libs/commerce/transaction-contracts';
import { cn } from '@/libs/utils/utils';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';

/**
 * The approximate converted counterpart of a listing price: "≈ ₿N" under
 * a fiat price, "≈ $X" under a bitcoin price. Marked approximate and explained
 * in a tooltip because it is display-only — the amount a payment settles is
 * fixed by the payment rail, never by this estimate (docs/ecommerce/pricing.md).
 *
 * Renders NOTHING unless all of these hold: the user has the estimate toggle
 * on, the price's asset has a rate source (USD or BTC), and the rate fetch
 * succeeded. No rate, no estimate — never an error state, never a fallback.
 */
export function MarketplaceIndicativePrice({
  money,
  className,
  showApproximation = true,
}: {
  money: CommerceMoney;
  className?: string;
  showApproximation?: boolean;
}) {
  const showFxEstimate = useMarketplaceDisplayStore((state) => state.showFxEstimate);
  const isConvertible = money.currency === 'USD' || money.currency === 'BTC';
  const rate = useIndicativeBtcRate(showFxEstimate && isConvertible);
  if (rate === null) return null;

  const label = indicativeCounterpartLabel(money, rate.btcUsd);
  if (label === null) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Typography as="span" className={cn('cursor-help text-xs text-muted-foreground', className)}>
          {showApproximation ? label : label.replace(/^≈\s*/, '')}
        </Typography>
      </TooltipTrigger>
      <TooltipContent>At current rate, indicative only</TooltipContent>
    </Tooltip>
  );
}
