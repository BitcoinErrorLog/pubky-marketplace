'use client';

import { Button } from '@/atoms/Button/Button';
import { Heading } from '@/atoms/Heading/Heading';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { useSellerDigitalDelivery } from '@/hooks/useSellerDigitalDelivery/useSellerDigitalDelivery';
import { DIGITAL_SELLER_COPY, isDigitalOrderEnded } from '@/libs/commerce/digital';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

/**
 * The seller's delivery panel on a digital order (digital delivery design §3
 * "Seller's orders", §4.3): the delivery evidence; for email lines Show email,
 * then Mark emailed; Mark delivered for message lines. The address is masked from
 * session replay and dropped when hidden or once marked.
 */
export function MarketplaceSellerDigitalPanel({
  order,
  onChanged,
}: {
  order: MarketplaceOrder;
  onChanged?: () => Promise<void> | void;
}) {
  const delivery = useSellerDigitalDelivery(order, onChanged);
  const { email, evidence } = delivery;
  const evidenceLines = evidence.status === 'ready' ? evidence.lines : [];
  if (delivery.channels.length === 0 && evidence.status !== 'failed' && evidenceLines.length === 0) return null;
  const paid = order.state === 'paid';
  const canShowEmail =
    delivery.channels.includes('email') && order.receiptId !== null && !isDigitalOrderEnded(order.state);

  return (
    <section
      className="mt-3 grid gap-3 rounded-xl border bg-card/60 p-4"
      aria-label="Delivery"
      data-surface="order-seller-digital-panel"
    >
      <Heading level={3} size="sm" className="text-base font-semibold">
        Delivery
      </Heading>
      {evidenceLines.map((line) => (
        <Typography key={line} as="p" className="text-sm text-muted-foreground" data-testid="seller-digital-evidence">
          {line}
        </Typography>
      ))}
      {evidence.status === 'failed' && (
        <div className="flex flex-wrap items-center gap-2" data-testid="seller-digital-evidence-failed">
          <Typography as="p" role="alert" className="text-sm text-muted-foreground">
            {DIGITAL_SELLER_COPY.evidenceFailed}
          </Typography>
          <Button size="sm" variant="secondary" className="rounded-full" onClick={delivery.retryEvidence}>
            {DIGITAL_SELLER_COPY.evidenceRetry}
          </Button>
        </div>
      )}
      {email.status === 'loading' && <Skeleton className="h-5 w-64" aria-label="Loading the buyer's email" />}
      {email.status === 'shown' && (
        <div className="grid gap-2">
          <Typography
            as="p"
            className="text-sm font-medium break-all"
            data-sentry-mask
            data-testid="seller-delivery-email"
          >
            {email.email.deliveryEmail}
          </Typography>
          <Typography as="p" className="text-xs text-muted-foreground">
            {DIGITAL_SELLER_COPY.emailDisclosure}
          </Typography>
        </div>
      )}
      {email.status === 'refused' && (
        <Typography as="p" role="alert" className="text-sm text-muted-foreground">
          {email.message}
        </Typography>
      )}
      <div className="flex flex-wrap gap-2">
        {canShowEmail &&
          (email.status === 'shown' ? (
            <Button size="sm" variant="secondary" className="rounded-full" onClick={delivery.hideEmail}>
              {DIGITAL_SELLER_COPY.hideEmail}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              className="rounded-full"
              disabled={email.status === 'loading'}
              onClick={() => void delivery.showEmail()}
            >
              {DIGITAL_SELLER_COPY.showEmail}
            </Button>
          ))}
        {paid && delivery.channels.includes('email') && (
          <Button
            size="sm"
            className="rounded-full"
            disabled={delivery.acting}
            onClick={() => void delivery.mark('email')}
          >
            {DIGITAL_SELLER_COPY.markEmailed}
          </Button>
        )}
        {paid && delivery.channels.includes('message') && (
          <Button
            size="sm"
            className="rounded-full"
            disabled={delivery.acting}
            onClick={() => void delivery.mark('message')}
          >
            {DIGITAL_SELLER_COPY.markDelivered}
          </Button>
        )}
      </div>
      {delivery.message && (
        <Typography as="p" role="status" className="text-sm text-muted-foreground">
          {delivery.message}
        </Typography>
      )}
    </section>
  );
}
