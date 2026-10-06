'use client';

import { useState } from 'react';
import { MapPin } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import { usePickupReveal } from '@/hooks/usePickupReveal/usePickupReveal';
import type { MarketplacePickupAddress, MarketplacePickupAvailabilityWindow } from '@/libs/commerce/pickup';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

const WEEKDAY_LABELS: Record<MarketplacePickupAvailabilityWindow['day'], string> = {
  mon: 'Mondays',
  tue: 'Tuesdays',
  wed: 'Wednesdays',
  thu: 'Thursdays',
  fri: 'Fridays',
  sat: 'Saturdays',
  sun: 'Sundays',
};

/**
 * The buyer's meeting-point reveal (local pickup design §A3): the pinned
 * per-line snapshot recorded at payment — never the listing's current
 * details — fetched from the entitled reveal read each time the dialog
 * opens and held in component memory only. Closing the dialog drops it.
 * Nothing here is persisted, copied into notes, or sent to telemetry: the
 * content carries `data-sentry-mask` (§7.2 binding), and the payload arrives
 * structurally redacted (`MaskedPickupDetails`) until this render unwraps it.
 *
 * Typed refusals (unpaid, terminal, sandbox-confirmed, no pinned snapshot,
 * unavailable deployment) render as plain-language messages in the dialog —
 * never raw errors, never toasts.
 */
export function MarketplacePickupRevealDialog({ order }: { order: MarketplaceOrder }) {
  const [open, setOpen] = useState(false);
  const reveal = usePickupReveal(order.id);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      void reveal.load();
    } else {
      // The in-memory copy is dropped on close — the next open re-fetches.
      reveal.reset();
    }
  };

  return (
    <>
      <Button size="sm" variant="secondary" className="rounded-full" onClick={() => handleOpenChange(true)}>
        <MapPin className="mr-2 size-4" />
        Show meeting point
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="border-border bg-popover" data-surface="pickup-reveal-dialog">
          <DialogHeader>
            <DialogTitle>Meeting point</DialogTitle>
          </DialogHeader>
          <div data-sentry-mask className="grid gap-4">
            {reveal.state === 'loading' && (
              <Typography as="p" className="text-sm text-muted-foreground">
                Checking your entitlement and loading the pinned meeting point…
              </Typography>
            )}
            {reveal.state === 'refused' && (
              <Typography as="p" role="alert" className="text-sm text-muted-foreground">
                {reveal.refusalMessage}
              </Typography>
            )}
            {reveal.state === 'ready' &&
              reveal.reveal?.lines.map((line) => {
                const orderLine = order.lines.find(
                  (candidate) => candidate.listingAggregateId === line.listingAggregateId,
                );
                // The pinned snapshot is the ONLY thing served — the entitled
                // render surface unwraps it here and nowhere else.
                const details = line.details.value;
                return (
                  <div key={line.lineIndex} className="grid gap-2 rounded-xl border bg-card/60 p-4">
                    {orderLine && (
                      <Typography as="p" className="text-sm font-semibold">
                        {orderLine.title} × {orderLine.quantity}
                      </Typography>
                    )}
                    {line.updatedSincePayment && (
                      <Typography as="p" role="status" className="text-sm text-amber-300">
                        Seller changed the pickup terms since you paid — you&apos;re seeing the terms pinned at your
                        payment, and you can cancel this order instantly from the order actions.
                      </Typography>
                    )}
                    {line.withdrawnBySeller && (
                      <Typography as="p" role="status" className="text-sm text-amber-300">
                        Details withdrawn by seller — you&apos;re seeing the terms pinned at your payment, and you can
                        cancel this order instantly from the order actions.
                      </Typography>
                    )}
                    {details.kind === 'spot' ? (
                      <Typography as="p" className="text-sm whitespace-pre-line">
                        {details.spot}
                      </Typography>
                    ) : (
                      details.address && <PickupAddressBlock address={details.address} />
                    )}
                    {details.instructions && (
                      <Typography as="p" className="text-xs whitespace-pre-line text-muted-foreground">
                        {details.instructions}
                      </Typography>
                    )}
                    <div className="text-xs text-muted-foreground">
                      <Typography as="p" className="font-medium text-foreground">
                        When the seller is usually around (read-only)
                      </Typography>
                      {details.availability.windows?.length ? (
                        <ul className="mt-1 list-disc pl-5">
                          {details.availability.windows.map((window, index) => (
                            <li key={index}>
                              {WEEKDAY_LABELS[window.day]} {window.start}–{window.end}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <Typography as="p" className="mt-1">
                          No set windows — arrange a time with the seller.
                        </Typography>
                      )}
                      <Typography as="p" className="mt-1">
                        Times are local to {details.availability.zone}.
                      </Typography>
                    </div>
                    <Typography as="p" className="text-xs text-muted-foreground">
                      Pinned as terms version {line.version} at payment · updated {line.updatedAt.slice(0, 10)}
                    </Typography>
                  </div>
                );
              })}
            {reveal.state === 'ready' && (
              <Typography as="p" className="text-xs text-muted-foreground">
                Shown only to you as the paying buyer, and only while this order is open. It is never stored on this
                device — opening this dialog fetches it again.
              </Typography>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PickupAddressBlock({ address }: { address: MarketplacePickupAddress }) {
  const lines = [
    address.name,
    address.line1,
    address.line2,
    `${address.city}, ${address.region} ${address.postalCode}`,
    address.countryCode,
  ].filter((line) => line.trim().length > 0);
  return (
    <Typography as="p" className="text-sm whitespace-pre-line">
      {lines.join('\n')}
    </Typography>
  );
}
