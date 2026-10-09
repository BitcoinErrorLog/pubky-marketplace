import { Check } from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import {
  bitcoinPaidConfirmation,
  bitcoinSeenBadgeLabel,
  PAYMENT_CONFIRMED_ON_CHAIN_LABEL,
  PAYMENT_SELLER_CONFIRMED_LABEL,
} from '@/libs/commerce/bitcoin-buyer-status';
import { type BuyerVisiblePaymentStatus, buyerVisiblePaymentStatus } from '@/libs/commerce/locks-payment';
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
  const visibleStatusLabel =
    seenBadge ??
    paidBitcoinBadge ??
    (isTerminal && visibleStatus === 'awaiting_entitlement'
      ? order.state === 'cancelled'
        ? 'Order cancelled'
        : 'Not paid'
      : BUYER_VISIBLE_STATUS_LABELS[visibleStatus]);

  return (
    <Badge
      variant={visibleStatus === 'confirmed' ? 'default' : 'outline'}
      className={visibleStatus === 'confirmed' ? 'bg-brand text-primary-foreground' : undefined}
    >
      {visibleStatus === 'confirmed' && <Check aria-hidden="true" />}
      {visibleStatusLabel}
    </Badge>
  );
}
