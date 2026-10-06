'use client';

import { useState } from 'react';
import { Gavel } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceBid } from '@/hooks/useMarketplaceBid/useMarketplaceBid';
import { marketplaceBidMinimum } from '@/hooks/useMarketplaceBid/useMarketplaceBid.types';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import type { AuctionPhase } from '@/libs/commerce/auction-phase';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { amountInputUnitLabel, type CommerceAsset, isBitcoinAsset } from '@/libs/commerce/pricing';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import type { MarketplaceListingProjection } from '@/services/marketplace/marketplace';

export function MarketplaceBidDialog({
  aggregateId,
  projection,
  priceAsset,
  isSessionRequired = false,
  onSessionRequired,
  onAccepted,
  auctionPhase = 'live',
  isOwner = false,
}: {
  aggregateId: string;
  projection: MarketplaceListingProjection | null;
  /** The auction's own pricing asset — bids are made in it, never converted. */
  priceAsset: CommerceAsset;
  isSessionRequired?: boolean;
  onSessionRequired?: () => void;
  onAccepted: () => void | Promise<void>;
  auctionPhase?: AuctionPhase;
  isOwner?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // `onAccepted` refreshes the projection, which is exactly the recovery a
  // revision conflict needs: reload the price/revision, then the user rebids.
  const bid = useMarketplaceBid(
    aggregateId,
    projection?.serverRevision ?? null,
    onAccepted,
    priceAsset,
    auctionPhase,
    projection?.auction
      ? {
          ...projection.auction,
          viewerBid: projection.viewerBid,
        }
      : undefined,
    isOwner,
  );
  const { requireAuth } = useRequireAuth();

  const submit = async () => {
    if (!(await bid.submit())) return;
    setOpen(false);
    bid.reset();
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
        if (auctionPhase === 'ended') return;
        if (isSessionRequired) {
          requireAuth(() => onSessionRequired?.());
          return;
        }
        requireAuth(() => setOpen(true));
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="default"
          className="w-fit rounded-full"
          disabled={isOwner || auctionPhase === 'ended' || (!projection?.auction && !isSessionRequired)}
        >
          <Gavel className="mr-2 size-4" />
          {isOwner ? 'You cannot bid on your own listing' : auctionPhase === 'ended' ? 'Auction ended' : 'Place a bid'}
        </Button>
      </DialogTrigger>
      <DialogContent className="border-border bg-popover">
        <DialogHeader>
          <DialogTitle>Set your maximum bid</DialogTitle>
        </DialogHeader>
        {projection?.auction && (
          <div className="rounded-xl border bg-card p-4">
            <Typography as="p" className="text-sm text-muted-foreground">
              Current visible price
            </Typography>
            <Typography as="p" className="text-2xl font-bold text-brand">
              {formatCommerceMoney(projection.auction.currentPrice)}
            </Typography>
            <Typography as="p" className="mt-1 text-sm text-muted-foreground">
              {projection.auction.bidCount} {projection.auction.bidCount === 1 ? 'bid' : 'bids'}
            </Typography>
            <Typography as="p" className="mt-2 text-sm text-muted-foreground">
              Minimum maximum:{' '}
              {formatCommerceMoney({
                ...projection.auction.currentPrice,
                amountMinor: marketplaceBidMinimum(
                  projection.auction.currentPrice.amountMinor,
                  projection.auction.minimumIncrement.amountMinor,
                  projection.viewerBid?.minimumNextBid.amountMinor,
                ),
              })}{' '}
              {projection.viewerBid &&
              projection.viewerBid.minimumNextBid.amountMinor >
                projection.auction.currentPrice.amountMinor + projection.auction.minimumIncrement.amountMinor
                ? 'minimum required to exceed your own current proxy maximum.'
                : 'floor based on the visible price.'}
            </Typography>
            {projection.viewerBid && (
              <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                Your current proxy maximum: {formatCommerceMoney(projection.viewerBid.maximumAmount)}
              </Typography>
            )}
          </div>
        )}
        <ControlledInputField
          name="maximumAmount"
          control={bid.form.control}
          label={`Maximum bid (${amountInputUnitLabel(priceAsset)})`}
          placeholder={isBitcoinAsset(priceAsset) ? '100000' : '100.00'}
        />
        <Typography as="p" className="text-sm text-muted-foreground">
          We bid only what&apos;s needed to keep you ahead, up to your maximum.
        </Typography>
        <Typography as="p" className="text-sm text-muted-foreground">
          Your maximum stays private. The visible price advances only enough to keep you ahead.
        </Typography>
        <DialogFooter>
          <Button variant="secondary" className="rounded-full" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={submit} disabled={auctionPhase === 'ended'}>
            Confirm bid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
