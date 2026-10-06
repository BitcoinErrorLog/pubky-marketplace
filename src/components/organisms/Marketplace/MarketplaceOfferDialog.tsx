'use client';

import { useState } from 'react';
import { HandCoins } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceOffer } from '@/hooks/useMarketplaceOffer/useMarketplaceOffer';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { amountInputToMoney, amountInputUnitLabel, type CommerceAsset, isBitcoinAsset } from '@/libs/commerce/pricing';
import type { CommerceMoney } from '@/libs/commerce/transaction-contracts';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { ControlledTextareaField } from '@/molecules/ControlledTextareaField/ControlledTextareaField';

export function MarketplaceOfferDialog({
  aggregateId,
  expectedRevision,
  priceAsset,
  askingPrice = null,
  isSessionRequired = false,
  onSessionRequired,
  onAccepted,
  isOwner = false,
  holdDisabled = false,
  holdLabel,
}: {
  aggregateId: string;
  expectedRevision: number | null;
  /** The listing's own pricing asset — offers are made in it, never converted. */
  priceAsset: CommerceAsset;
  askingPrice?: CommerceMoney | null;
  isSessionRequired?: boolean;
  onSessionRequired?: () => void;
  onAccepted: () => void | Promise<void>;
  isOwner?: boolean;
  holdDisabled?: boolean;
  holdLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // `onAccepted` refreshes the projection, which is exactly the recovery a
  // revision conflict needs: reload the terms/revision, then the user re-offers.
  const offer = useMarketplaceOffer(aggregateId, expectedRevision, onAccepted, priceAsset, isOwner);
  const { requireAuth } = useRequireAuth();
  const amount = offer.form.watch('amount');
  const comparableAsking = askingPriceComparableToAsset(askingPrice, priceAsset);
  const askingPriceLine = formatAskingPriceLine(comparableAsking);
  const comparisonLine = formatOfferComparisonLine(amount, comparableAsking, priceAsset);

  const submit = async () => {
    if (!(await offer.submit())) return;
    setOpen(false);
    offer.reset();
    await onAccepted();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setOpen(false);
          return;
        }
        if (isSessionRequired) {
          requireAuth(() => onSessionRequired?.());
          return;
        }
        if (holdDisabled) return;
        requireAuth(() => setOpen(true));
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="default"
          variant="secondary"
          className="w-fit rounded-full"
          disabled={isOwner || holdDisabled || (expectedRevision === null && !isSessionRequired)}
        >
          <HandCoins className="mr-2 size-4" />
          {isOwner ? 'You cannot buy your own listing' : holdDisabled ? (holdLabel ?? 'Held') : 'Make offer'}
        </Button>
      </DialogTrigger>
      <DialogContent className="border-border bg-popover">
        <DialogHeader>
          <DialogTitle>Make a private offer</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <ControlledInputField
            name="amount"
            control={offer.form.control}
            label={`Offer amount (${amountInputUnitLabel(priceAsset)})`}
            placeholder={isBitcoinAsset(priceAsset) ? '100000' : '100.00'}
          />
          {(askingPriceLine || comparisonLine) && (
            <div className="-mt-2 grid gap-1">
              {askingPriceLine && (
                <Typography as="p" className="text-sm text-muted-foreground">
                  {askingPriceLine}
                </Typography>
              )}
              {comparisonLine && (
                <Typography as="p" className="text-sm text-brand">
                  {comparisonLine}
                </Typography>
              )}
            </div>
          )}
          <ControlledInputField name="quantity" control={offer.form.control} label="Quantity" placeholder="1" />
          <ControlledTextareaField
            name="message"
            control={offer.form.control}
            label="Message (optional)"
            placeholder="Add context for the seller"
            rows={4}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" className="rounded-full" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={submit}>
            Send offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function askingPriceComparableToAsset(
  askingPrice: CommerceMoney | null,
  priceAsset: CommerceAsset,
): CommerceMoney | null {
  if (!askingPrice || askingPrice.currency !== priceAsset.currency) return null;
  return askingPrice;
}

function formatAskingPriceLine(askingPrice: CommerceMoney | null): string | null {
  return askingPrice ? `Asking price: ${formatCommerceMoney(askingPrice)}` : null;
}

function formatOfferComparisonLine(
  amount: string,
  askingPrice: CommerceMoney | null,
  priceAsset: CommerceAsset,
): string | null {
  if (!askingPrice || askingPrice.amountMinor <= 0 || amount.trim() === '') return null;

  const offerAmount = amountInputToMoney(amount, priceAsset);
  if (!Number.isFinite(offerAmount.amountMinor) || offerAmount.amountMinor <= 0) return null;

  const difference = offerAmount.amountMinor - askingPrice.amountMinor;
  if (difference === 0) return 'Matches asking';

  const percent = Math.max(1, Math.round((Math.abs(difference) / askingPrice.amountMinor) * 100));
  return `${percent}% ${difference < 0 ? 'below' : 'above'} asking`;
}
