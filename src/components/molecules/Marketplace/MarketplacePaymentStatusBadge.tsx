import { Check } from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import {
  bitcoinPaidConfirmation,
  bitcoinSeenBadgeLabel,
  PAYMENT_CONFIRMED_ON_CHAIN_LABEL,
  PAYMENT_SELLER_CONFIRMED_LABEL,
} from '@/libs/commerce/bitcoin-buyer-status';
import { type BuyerVisiblePaymentStatus, buyerVisiblePaymentStatus } from '@/libs/commerce/locks-payment';
import { USDT_PHASE_BADGE_LABEL, usdtSettlementPhase } from '@/libs/commerce/usdt-buyer-status';
import type { MarketplaceOrder, MarketplacePayment } from '@/services/marketplace/marketplace';

const BUYER_VISIBLE_STATUS_LABELS: Record<BuyerVisiblePaymentStatus, string> = {
  awaiting_entitlement: 'Awaiting payment',
  confirmed: 'Payment confirmed',
  expired: 'Payment window expired',
  manual_review: 'Under manual review',
};

export function MarketplacePaymentStatusBadge({
  order,
  payment,
}: {
  order: MarketplaceOrder;
  payment: MarketplacePayment;
}) {
  const visibleStatus = buyerVisiblePaymentStatus(payment.state);
  const isTerminal = ['completed', 'cancelled', 'refunded_external', 'refunded_partial', 'closed'].includes(
    order.state,
  );
  const seenBadge =
    visibleStatus === 'awaiting_entitlement' && !isTerminal ? bitcoinSeenBadgeLabel(order, payment) : null;
  const paidBitcoin = bitcoinPaidConfirmation(order, payment);
  const paidBitcoinBadge = paidBitcoin
    ? paidBitcoin.sellerConfirmed
      ? PAYMENT_SELLER_CONFIRMED_LABEL
      : PAYMENT_CONFIRMED_ON_CHAIN_LABEL
    : null;
  const usdtPhase = usdtSettlementPhase(order, payment);
  const usdtBadge = usdtPhase !== null && usdtPhase !== 'awaiting' ? USDT_PHASE_BADGE_LABEL[usdtPhase] : null;
  // A reorged USDT payment stays paid but is not settled, so it never wears the confirmed check.
  const settled = visibleStatus === 'confirmed' && usdtPhase !== 'rechecking';
  const visibleStatusLabel =
    seenBadge ??
    paidBitcoinBadge ??
    usdtBadge ??
    (isTerminal && visibleStatus === 'awaiting_entitlement'
      ? order.state === 'cancelled'
        ? 'Order cancelled'
        : 'Not paid'
      : BUYER_VISIBLE_STATUS_LABELS[visibleStatus]);

  return (
    <Badge
      variant={settled ? 'default' : 'outline'}
      className={settled ? 'bg-brand text-primary-foreground' : undefined}
    >
      {settled && <Check aria-hidden="true" />}
      {visibleStatusLabel}
    </Badge>
  );
}
