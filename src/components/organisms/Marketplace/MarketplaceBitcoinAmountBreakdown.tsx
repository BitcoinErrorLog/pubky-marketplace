import { Typography } from '@/atoms/Typography/Typography';
import {
  bitcoinPaymentBreakdown,
  bitcoinPaymentCodeExplanation,
  formatBitcoinAmountBreakdown,
  formatBitcoinAwareMoney,
} from '@/libs/commerce/bitcoin-payment-code';
import { cn } from '@/libs/utils/utils';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

/**
 * Items + shipping + payment code = the exact bitcoin amount. The code is
 * the small unique amount added so the payment can be matched.
 */
export function MarketplaceBitcoinAmountBreakdown({
  order,
  showExact = false,
  explainCode = false,
  className,
}: {
  order: MarketplaceOrder;
  /** The payment step names the figure the buyer sends. */
  showExact?: boolean;
  /** The payment step says what the payment code is. Lists show the equation alone. */
  explainCode?: boolean;
  className?: string;
}) {
  const breakdown = bitcoinPaymentBreakdown(order);
  if (!breakdown) return null;

  return (
    <div className={cn('grid gap-1', className)} data-testid="bitcoin-amount-breakdown">
      {showExact ? (
        <Typography as="p" className="text-lg font-semibold text-brand" data-testid="bitcoin-amount-due">
          Pay exactly {formatBitcoinAwareMoney(breakdown.payable)}
        </Typography>
      ) : null}
      <Typography as="p" className="text-xs text-muted-foreground">
        {formatBitcoinAmountBreakdown(breakdown)}
      </Typography>
      {explainCode ? (
        <Typography as="p" className="text-xs text-muted-foreground" data-testid="bitcoin-payment-code-explanation">
          {bitcoinPaymentCodeExplanation(breakdown.paymentCode)}
        </Typography>
      ) : null}
    </div>
  );
}
