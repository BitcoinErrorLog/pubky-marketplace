'use client';

import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Label } from '@/atoms/Label/Label';
import { Textarea } from '@/atoms/Textarea/Textarea';
import { usePackingSlipAddress } from '@/hooks/usePackingSlipAddress/usePackingSlipAddress';
import { bitcoinPaymentBreakdown, formatBitcoinAwareMoney } from '@/libs/commerce/bitcoin-payment-code';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { formatPublicKey } from '@/libs/utils/utils';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * A print-friendly packing slip for the seller, rendered purely from what the
 * seller's client legitimately holds: the order projection the transaction
 * service serves to participants.
 *
 * The seller's paid/processing shipping single-order projection can carry a
 * tagged `plaintext_v1` delivery address. Unknown and untagged formats are
 * treated as unavailable and never rendered.
 *
 * As a convenience for sellers shipping many orders, the dialog offers an
 * OPTIONAL paste field: the seller copies the destination the buyer sent
 * them directly (e.g. the encrypted conversation) and it is rendered onto
 * the printed slip. The pasted value lives only in component state — never
 * persisted, never logged, never sent anywhere — and is cleared on dialog
 * close, print completion, and route change (see `usePackingSlipAddress`).
 *
 * Printing uses plain browser print CSS (`@media print` rules in
 * `globals.css` keyed on `data-packing-slip`) — no PDF dependency.
 */
export function MarketplacePackingSlipDialog({ order }: { order: MarketplaceOrder }) {
  const [open, setOpen] = useState(false);
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const { address, setAddress, clear, sellerOrder } = usePackingSlipAddress({ order, enabled: open });
  const pastedAddress = address.trim();
  const serviceAddress =
    sellerOrder?.deliveryAddress?.format === 'plaintext_v1' ? sellerOrder.deliveryAddress.address : null;
  // Pickup orders (local pickup design §A5): nothing is posted, so the
  // delivery-address block and the paste field are suppressed — a pickup
  // order never had an address, and the meeting point is only ever visible
  // to the buyer in the app.
  const isPickup = order.fulfillment === 'pickup';
  const bitcoinBreakdown = bitcoinPaymentBreakdown(order);

  useEffect(() => {
    setOpen(false);
  }, [currentUserPubky]);

  const handleOpenChange = (next: boolean) => {
    // Closing the dialog always drops the staged address — it is staged for
    // one print job, not remembered.
    if (!next) clear();
    setOpen(next);
  };

  return (
    <>
      <Button
        size="icon"
        variant="secondary"
        className="rounded-full"
        aria-label="Packing slip"
        onClick={() => setOpen(true)}
      >
        <Printer className="size-4" />
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl border-border bg-popover" centered>
          <DialogHeader>
            <DialogTitle>Packing slip</DialogTitle>
          </DialogHeader>
          {/* Optional convenience: paste the destination the buyer sent you
              directly and it prints in the slip's "Deliver to" block. The
              value lives only in component state (usePackingSlipAddress) —
              never persisted, never sent — and Sentry Replay masks all
              inputs (`maskAllInputs`), with `data-sentry-mask` making that
              explicit for this field. Suppressed on pickup orders (§A5). */}
          {!isPickup && !serviceAddress && (
            <div className="space-y-1.5">
              <Label htmlFor="packing-slip-address">Paste delivery address (optional)</Label>
              <Textarea
                id="packing-slip-address"
                data-sentry-mask
                autoComplete="off"
                rows={3}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="Paste the destination the buyer sent you, exactly as you want it printed…"
              />
              <p className="text-xs text-muted-foreground">
                Kept only in this dialog on this device — not saved, not sent to the marketplace or any server. Anything
                you print (including print-to-PDF) will contain it.
              </p>
            </div>
          )}
          <div
            data-packing-slip
            className="rounded-lg border border-neutral-300 bg-white p-6 font-mono text-sm text-black"
          >
            <div className="flex items-start justify-between gap-4 border-b border-neutral-300 pb-4">
              <div>
                <p className="text-lg font-bold tracking-wide uppercase">Packing slip</p>
                <p className="mt-1">Order {order.id.slice(0, 8)}</p>
                <p className="text-neutral-600">{order.id}</p>
              </div>
              <div className="text-right">
                <p>Ordered {order.createdAt.slice(0, 10)}</p>
                <p className="mt-1">Buyer {formatPublicKey({ key: order.buyerPubky, length: 12 })}</p>
              </div>
            </div>

            <table className="mt-4 w-full border-collapse">
              <thead>
                <tr className="border-b border-neutral-300 text-left">
                  <th className="py-1 pr-2 font-semibold">Qty</th>
                  <th className="py-1 pr-2 font-semibold">Item</th>
                  <th className="py-1 text-right font-semibold">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.listingAggregateId} className="border-b border-neutral-200 align-top">
                    <td className="py-1.5 pr-2">{line.quantity}</td>
                    <td className="py-1.5 pr-2">
                      {line.title}
                      {/* The buyer's variant snapshot from checkout — the whole
                          point of a packing slip is packing the right variant. */}
                      {line.variantOptions?.length ? (
                        <span className="block text-xs text-neutral-800">
                          {line.variantOptions.map(({ name, value }) => `${name}: ${value}`).join(' · ')}
                        </span>
                      ) : null}
                      <span className="block text-xs text-neutral-600">{formatCommerceMoney(line.unitPrice)} each</span>
                    </td>
                    <td className="py-1.5 text-right">{formatCommerceMoney(line.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 ml-auto w-fit text-right">
              {bitcoinBreakdown ? (
                <>
                  <p>Items {formatBitcoinAwareMoney(bitcoinBreakdown.items)}</p>
                  <p>Shipping {formatBitcoinAwareMoney(bitcoinBreakdown.shipping)}</p>
                  <p>Payment code {formatBitcoinAwareMoney(bitcoinBreakdown.paymentCode)}</p>
                  <p className="font-bold">Total {formatBitcoinAwareMoney(bitcoinBreakdown.payable)}</p>
                </>
              ) : (
                <>
                  <p>Items {formatCommerceMoney(order.subtotal)}</p>
                  <p>Shipping {formatCommerceMoney(order.shipping)}</p>
                  <p className="font-bold">Total {formatCommerceMoney(order.total)}</p>
                </>
              )}
            </div>

            {order.shipment && (
              <div className="mt-4 border-t border-neutral-300 pt-3">
                <p className="font-semibold">Shipment</p>
                <p>
                  {order.shipment.carrier} · {order.shipment.trackingNumber}
                </p>
              </div>
            )}

            <div className="mt-4 border-t border-neutral-300 pt-3">
              <p className="font-semibold">Deliver to</p>
              {isPickup ? (
                <p className="mt-1 text-xs leading-relaxed text-neutral-700">
                  Local pickup — meeting point is only visible to the buyer in the app.
                </p>
              ) : serviceAddress ? (
                <div className="mt-1" data-sentry-mask>
                  <p>{serviceAddress.name}</p>
                  <p>{serviceAddress.line1}</p>
                  {serviceAddress.line2 ? <p>{serviceAddress.line2}</p> : null}
                  <p>
                    {serviceAddress.city}, {serviceAddress.region} {serviceAddress.postalCode}
                  </p>
                  <p>{serviceAddress.countryCode}</p>
                </div>
              ) : pastedAddress ? (
                // The seller pasted the destination they got from the buyer
                // directly — print it verbatim, preserving line breaks.
                <p className="mt-1 whitespace-pre-line">{pastedAddress}</p>
              ) : (
                <>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-700">
                    Delivery address unavailable for this order — paste it below.
                  </p>
                  <div className="mt-3 space-y-4" aria-hidden="true">
                    <div className="border-b border-neutral-400" />
                    <div className="border-b border-neutral-400" />
                    <div className="border-b border-neutral-400" />
                  </div>
                </>
              )}
            </div>

            <div className="mt-4 border-t border-neutral-300 pt-3">
              <p className="font-semibold">Notes</p>
              <div className="mt-3 space-y-4" aria-hidden="true">
                <div className="border-b border-neutral-400" />
                <div className="border-b border-neutral-400" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" className="rounded-full" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
            <Button className="rounded-full" onClick={() => window.print()}>
              <Printer className="mr-2 size-4" />
              Print
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
