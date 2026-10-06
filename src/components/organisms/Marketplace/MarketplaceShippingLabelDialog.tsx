'use client';

import { useState } from 'react';
import { LoaderCircle, Printer, Ship } from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { FORM_LABEL_CLASSES } from '@/config/forms';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import type { ShippingLabel, ShippoRate } from '@/libs/commerce/shipping';
import { Logger } from '@/libs/logger/logger';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

/**
 * Seller-side Shippo label purchase for a paid order: confirm the parcel,
 * quote REAL rates against the seller's own Shippo account, buy one (real
 * money, charged by Shippo to the seller), then print the label and reuse
 * its tracking number for the ship action. The label PDF embeds the buyer's
 * address, so the whole surface is seller-only — the service enforces it.
 */
export function MarketplaceShippingLabelDialog({
  order,
  actOnOrder,
}: {
  order: MarketplaceOrder;
  actOnOrder: (order: MarketplaceOrder, kind: string, payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [weightGrams, setWeightGrams] = useState('');
  const [lengthMm, setLengthMm] = useState('');
  const [widthMm, setWidthMm] = useState('');
  const [heightMm, setHeightMm] = useState('');
  const [rates, setRates] = useState<ShippoRate[] | null>(null);
  const [label, setLabel] = useState<ShippingLabel | null>(null);
  const [pending, setPending] = useState<'quote' | 'buy' | 'load' | 'ship' | null>(null);

  if (!isDurableCommerceMode(getCommerceAdapterMode())) return null;

  const openDialog = async () => {
    setOpen(true);
    setPending('load');
    try {
      const stored = await CommerceController.getShippingLabel(order.id);
      setLabel(stored);
    } catch (error) {
      Logger.error('Failed to load the stored shipping label', { error });
    } finally {
      setPending(null);
    }
  };

  const parcel = () => {
    const values = [weightGrams, lengthMm, widthMm, heightMm].map((value) => Number(value.trim()));
    if (values.some((value) => !Number.isInteger(value) || value <= 0)) return null;
    const [weight, length, width, height] = values;
    return { weightGrams: weight, lengthMm: length, widthMm: width, heightMm: height };
  };

  const quote = async () => {
    const body = parcel();
    if (!body) {
      toast({ description: 'Enter the parcel weight (g) and dimensions (mm) as whole numbers.' });
      return;
    }
    setPending('quote');
    setRates(null);
    try {
      setRates(await CommerceController.quoteShippingRates(order.id, body));
    } catch (error) {
      Logger.error('Failed to quote shipping rates', { error });
      toast({
        title: 'Could not quote rates',
        description: marketplaceFailureMessage(
          marketplaceErrorCode(error),
          MARKETPLACE_FAILURE_MESSAGES.shippingRates,
          error,
        ),
      });
    } finally {
      setPending(null);
    }
  };

  const buy = async (rate: ShippoRate) => {
    setPending('buy');
    try {
      const purchased = await CommerceController.purchaseShippingLabel(order.id, rate.rateId);
      setLabel(purchased);
      setRates(null);
      toast({ description: `Label purchased: ${purchased.carrier} ${purchased.servicelevel}.` });
    } catch (error) {
      Logger.error('Failed to purchase the shipping label', { error });
      toast({
        title: 'Label purchase failed',
        description: marketplaceFailureMessage(marketplaceErrorCode(error), MARKETPLACE_FAILURE_MESSAGES.shippingLabel),
      });
    } finally {
      setPending(null);
    }
  };

  const shipWithLabel = async () => {
    if (!label) return;
    setPending('ship');
    try {
      if (
        await actOnOrder(order, 'fulfillment.ship', {
          carrier: label.carrier,
          trackingNumber: label.trackingNumber,
        })
      ) {
        setOpen(false);
      }
    } finally {
      setPending(null);
    }
  };

  const canShip = ['paid', 'processing'].includes(order.state);

  return (
    <>
      <Button size="sm" variant="secondary" className="rounded-full" onClick={() => void openDialog()}>
        <Ship className="mr-2 size-4" />
        Shipping label
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border-border bg-popover">
          <DialogHeader>
            <DialogTitle>Shipping label</DialogTitle>
          </DialogHeader>
          {pending === 'load' ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Checking for a purchased label…
            </div>
          ) : label ? (
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  {label.carrier} {label.servicelevel}
                </Badge>
                <Badge variant="outline">
                  {label.amount} {label.currency}
                </Badge>
              </div>
              <Typography as="p" className="text-sm text-muted-foreground">
                Tracking {label.trackingNumber}. The label was purchased through your own Shippo account; keep this page
                seller-side — the PDF shows the buyer&rsquo;s address.
              </Typography>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" className="rounded-full">
                  <a href={label.labelUrl} target="_blank" rel="noopener noreferrer">
                    <Printer className="mr-2 size-4" />
                    Print label
                  </a>
                </Button>
                {canShip && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="rounded-full"
                    disabled={pending !== null}
                    onClick={() => void shipWithLabel()}
                  >
                    {pending === 'ship' ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
                    Mark shipped with this tracking
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              <Typography as="p" className="text-sm text-muted-foreground">
                Quote real rates from your own Shippo account for this order&rsquo;s delivery address. Buying a label
                charges your Shippo account — this marketplace never touches the money.
              </Typography>
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    ['Weight (g)', weightGrams, setWeightGrams, 'label-weight'],
                    ['Length (mm)', lengthMm, setLengthMm, 'label-length'],
                    ['Width (mm)', widthMm, setWidthMm, 'label-width'],
                    ['Height (mm)', heightMm, setHeightMm, 'label-height'],
                  ] as const
                ).map(([fieldLabel, value, setValue, id]) => (
                  <div key={id} className="grid gap-1">
                    <Label htmlFor={id} className={FORM_LABEL_CLASSES}>
                      {fieldLabel}
                    </Label>
                    <Input
                      id={id}
                      inputMode="numeric"
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      className="h-10"
                    />
                  </div>
                ))}
              </div>
              <Button size="sm" className="w-fit rounded-full" disabled={pending !== null} onClick={() => void quote()}>
                {pending === 'quote' ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
                Get rates
              </Button>
              {rates && (
                <div className="grid gap-2">
                  {rates.map((rate) => (
                    <div
                      key={rate.rateId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                    >
                      <div className="min-w-0">
                        <Typography as="p" className="text-sm font-medium">
                          {rate.provider} {rate.servicelevel}
                        </Typography>
                        <Typography as="p" className="text-xs text-muted-foreground">
                          {rate.amount} {rate.currency}
                          {rate.estimatedDays ? ` · ~${rate.estimatedDays} days` : ''}
                        </Typography>
                      </div>
                      <Button
                        size="sm"
                        className="rounded-full"
                        disabled={pending !== null}
                        onClick={() => void buy(rate)}
                      >
                        {pending === 'buy' ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
                        Buy for {rate.amount} {rate.currency}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" className="rounded-full" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
