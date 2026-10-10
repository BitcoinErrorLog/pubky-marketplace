import { Typography } from '@/atoms/Typography/Typography';
import {
  USDT_NETWORK_LABEL,
  usdtAmountLabel,
  usdtPaidAsLine,
  usdtPhaseCopy,
  usdtSettlementPhase,
} from '@/libs/commerce/usdt-buyer-status';
import { cn } from '@/libs/utils/utils';
import type { MarketplaceOrder, MarketplacePayment } from '@/services/marketplace/marketplace';

/**
 * What a USDT order is worth and where it stands, for the viewing party: the
 * exact USDT due while unpaid, "$25.00, paid as 25.000000 USDT" once paid, the
 * network, and the received / final / re-checking sentence. Renders nothing
 * for an order that is not a USDT order, so Bitcoin and PayPal surfaces are
 * unchanged. It reads the order as the service sent it and is never gated on
 * the flag: an existing USDT order always displays.
 */
export function MarketplaceUsdtPaymentSummary({
  order,
  payment,
  isBuyer,
  className,
}: {
  order: MarketplaceOrder;
  payment: MarketplacePayment | null;
  isBuyer: boolean;
  className?: string;
}) {
  const phase = usdtSettlementPhase(order, payment);
  if (phase === null) return null;
  const amount = usdtAmountLabel(order);
  const paidAs = usdtPaidAsLine(order);
  const copy = usdtPhaseCopy(order, payment, isBuyer);
  const awaiting = phase === 'awaiting';
  // The buyer's awaiting sentence rides the status card's progress line; review copy rides its review paragraph.
  const showCopy = phase !== 'review' && (!awaiting || !isBuyer);

  return (
    <div className={cn('grid gap-1', className)} data-testid="usdt-payment-summary">
      {awaiting && isBuyer && amount ? (
        <Typography as="p" className="text-lg font-semibold text-brand" data-testid="usdt-amount-due">
          Pay exactly {amount}
        </Typography>
      ) : null}
      {!awaiting && paidAs ? (
        <Typography as="p" className="text-sm font-medium" data-testid="usdt-paid-as">
          {paidAs}
        </Typography>
      ) : null}
      {amount ? (
        <Typography as="p" className="text-xs text-muted-foreground" data-testid="usdt-network">
          {USDT_NETWORK_LABEL}
        </Typography>
      ) : null}
      {showCopy && copy ? (
        <Typography as="p" className="text-sm text-muted-foreground" data-testid="usdt-phase-copy">
          {copy}
        </Typography>
      ) : null}
    </div>
  );
}
