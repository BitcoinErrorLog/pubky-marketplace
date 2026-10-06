'use client';

import { useState } from 'react';
import { ArrowLeft, Clock3, OctagonX, PackageOpen, RefreshCw } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/atoms/Dialog/Dialog';
import { Heading } from '@/atoms/Heading/Heading';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { useDropStudioCountdown } from '@/hooks/useDropStudio/useDropStudioCountdown';
import {
  DROP_CANCELLABLE_STATES,
  DROP_ENDED_STATES,
  useOwnDrop,
  type UseOwnDropResult,
} from '@/hooks/useOwnDrop/useOwnDrop';
import type { DropState } from '@/libs/commerce/transaction-contracts';
import { toast } from '@/molecules/Toaster/use-toast';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import type { MarketplaceSellerDrop } from '@/services/marketplace/marketplace-projections';

export interface DropMissionControlProps {
  dropId: string;
}

/**
 * Mission control for one of the seller's drops: the authoritative seller
 * projection polled while visible, a server-corrected countdown, the exact
 * numbers only the seller is entitled to, the CAS-guarded kill switch, and
 * the post-drop release/results panel. Every rendered state comes from the
 * service's projection — never from the record's stated schedule.
 */
export function DropMissionControl({ dropId }: DropMissionControlProps) {
  const ownDrop = useOwnDrop(dropId);

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28 lg:pb-16"
      classNameWrapperContent="max-w-4xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6 px-4 sm:px-6 lg:px-8">
        <Link
          href={MARKETPLACE_ROUTES.SELL_DROPS}
          overrideDefaults
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Drops
        </Link>

        <div>
          <Badge className="mb-4">Mission control</Badge>
          <Heading level={1} size="xl" className="text-3xl sm:text-5xl">
            {ownDrop.record?.title ?? `Drop ${dropId}`}
          </Heading>
        </div>

        {!ownDrop.isDurable ? (
          <Card className="border-dashed py-5">
            <CardContent className="px-5">
              <Typography as="p" className="text-sm text-muted-foreground">
                Drop management is unavailable here.
              </Typography>
            </CardContent>
          </Card>
        ) : ownDrop.isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
        ) : ownDrop.drop === null ? (
          <DropMissionControlUnregistered ownDrop={ownDrop} />
        ) : (
          <DropMissionControlPanel ownDrop={ownDrop} drop={ownDrop.drop} />
        )}
      </Container>
    </ContentLayout>
  );
}

function DropMissionControlUnregistered({ ownDrop }: { ownDrop: UseOwnDropResult }) {
  return (
    <Card className="border-dashed py-5">
      <CardContent className="flex flex-col gap-3 px-5">
        <div className="flex items-center gap-2">
          <Badge variant="outline">Unregistered</Badge>
          <Typography as="p" className="text-sm font-semibold">
            This drop is not ready to launch.
          </Typography>
        </div>
        <Typography as="p" className="text-sm text-muted-foreground">
          {ownDrop.record
            ? 'Your announcement is saved, but launch setup is incomplete. The schedule and stock limits are not active yet.'
            : 'This drop could not be loaded. It may have been deleted.'}
        </Typography>
        {ownDrop.record && (
          <Button
            className="w-fit rounded-full"
            disabled={ownDrop.isActing}
            onClick={() => void ownDrop.syncRegistration()}
          >
            <RefreshCw className="mr-2 size-4" />
            {ownDrop.isActing ? 'Registering…' : 'Register with the service'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

const DROP_STATE_LABELS: Record<DropState, string> = {
  announced: 'Announced',
  live: 'Live',
  ended_sold_out: 'Sold out',
  ended_closed: 'Ended',
  ended_cancelled: 'Cancelled',
};

const DROP_STATE_GUIDANCE: Record<DropState, string> = {
  announced:
    "The drop's terms are locked at launch. Buyers can prepare, but nothing can be purchased until the service's clock opens the window.",
  live: 'The window is open. FCFS is a race — the service answers instantly, and every number below is its truth, not an estimate.',
  ended_sold_out:
    'Every unit was paid for. Listings release only after the drop ends — you can return the remainder to your shop below (there is none to return for a sell-out, but the release also clears the drop binding).',
  ended_closed:
    'The scheduled end passed. Listings release only after the drop ends — return the unsold stock to your shop below.',
  ended_cancelled:
    'You cancelled this drop. Paid orders continue through normal fulfillment; the public drop page shows it as cancelled.',
};

function DropMissionControlPanel({ ownDrop, drop }: { ownDrop: UseOwnDropResult; drop: MarketplaceSellerDrop }) {
  const countdown = useDropStudioCountdown(drop.startsAt, drop.endsAt ?? null, ownDrop.offsetMs);
  const isEnded = DROP_ENDED_STATES.includes(drop.state);
  const isCancellable = DROP_CANCELLABLE_STATES.includes(drop.state);
  const paidShare = drop.totalQuantity > 0 ? Math.min(1, drop.paidQuantity / drop.totalQuantity) : 0;

  const countdownText =
    drop.state === 'announced'
      ? `Starts in ${countdown.label}`
      : drop.state === 'live'
        ? drop.endsAt
          ? `Ends in ${countdown.label}`
          : 'No scheduled end — runs until sell-out or cancel'
        : 'The window is closed.';

  return (
    <div className="flex flex-col gap-6">
      <Card className="py-5">
        <CardContent className="flex flex-col gap-4 px-5">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={drop.state === 'live' ? 'default' : isEnded ? 'outline' : 'secondary'}>
              {DROP_STATE_LABELS[drop.state]}
            </Badge>
            <span className="inline-flex items-center gap-1.5 font-mono text-sm tabular-nums">
              <Clock3 className="size-4 text-brand" aria-hidden />
              <span aria-hidden>{countdownText}</span>
            </span>
            <span aria-live="polite" className="sr-only">
              {drop.state === 'announced'
                ? `Drop starts in ${countdown.announcedLabel}`
                : drop.state === 'live' && drop.endsAt
                  ? `Drop ends in ${countdown.announcedLabel}`
                  : countdownText}
            </span>
          </div>
          <Typography as="p" className="text-sm text-muted-foreground">
            {DROP_STATE_GUIDANCE[drop.state]}
          </Typography>

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <DropMissionControlStat label="Remaining" value={drop.remaining.toLocaleString('en-US')} />
            <DropMissionControlStat label="Paid units" value={drop.paidQuantity.toLocaleString('en-US')} />
            <DropMissionControlStat label="Buyers" value={drop.buyerCount.toLocaleString('en-US')} />
            <DropMissionControlStat label="Total" value={drop.totalQuantity.toLocaleString('en-US')} />
          </dl>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-sm">
              <Typography as="span" className="text-sm text-muted-foreground">
                Paid {drop.paidQuantity.toLocaleString('en-US')} of {drop.totalQuantity.toLocaleString('en-US')}
              </Typography>
              <Typography as="span" className="text-sm text-muted-foreground">
                {Math.round(paidShare * 100)}%
              </Typography>
            </div>
            <div
              role="progressbar"
              aria-label="Paid units out of the drop total"
              aria-valuemin={0}
              aria-valuemax={drop.totalQuantity}
              aria-valuenow={drop.paidQuantity}
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-500 motion-reduce:transition-none"
                style={{ width: `${paidShare * 100}%` }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {isEnded && <DropMissionControlResults drop={drop} />}
      {isEnded && <DropMissionControlRelease ownDrop={ownDrop} />}
      {isCancellable && <DropMissionControlKillSwitch ownDrop={ownDrop} state={drop.state} />}
    </div>
  );
}

function DropMissionControlStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] leading-4 font-medium tracking-[1.2px] text-muted-foreground uppercase">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function DropMissionControlResults({ drop }: { drop: MarketplaceSellerDrop }) {
  return (
    <Card className="py-5">
      <CardContent className="flex flex-col gap-2 px-5">
        <Typography as="h2" className="text-lg font-semibold">
          Results
        </Typography>
        <Typography as="p" className="text-sm">
          Final paid count:{' '}
          <span className="font-semibold tabular-nums">{drop.paidQuantity.toLocaleString('en-US')}</span>
        </Typography>
        {drop.state === 'ended_sold_out' && (
          <Typography as="p" className="text-sm">
            Sold out — {drop.paidQuantity.toLocaleString('en-US')}/{drop.totalQuantity.toLocaleString('en-US')} paid.
          </Typography>
        )}
        <Typography as="p" className="text-sm">
          {drop.paidQuantity > 0
            ? `Editions 1–${drop.paidQuantity.toLocaleString('en-US')} issued.`
            : 'No editions issued — editions number paid orders only.'}
        </Typography>
      </CardContent>
    </Card>
  );
}

function DropMissionControlRelease({ ownDrop }: { ownDrop: UseOwnDropResult }) {
  const [message, setMessage] = useState<string | null>(null);
  const release = async () => {
    const outcome = await ownDrop.releaseListings();
    if (outcome.ok) {
      setMessage(null);
      toast({ title: 'Listings released', description: 'The remaining unsold stock is back in your shop.' });
    } else {
      setMessage(outcome.message);
    }
  };
  return (
    <Card className="py-5">
      <CardContent className="flex flex-col gap-3 px-5">
        <Typography as="h2" className="text-lg font-semibold">
          Release listings
        </Typography>
        <Typography as="p" className="text-sm text-muted-foreground">
          Returns the remaining unsold stock to your shop as ordinary listings.
        </Typography>
        <Button className="w-fit rounded-full" disabled={ownDrop.isActing} onClick={() => void release()}>
          <PackageOpen className="mr-2 size-4" />
          {ownDrop.isActing ? 'Releasing…' : 'Release listings'}
        </Button>
        {message && (
          <Typography as="p" role="alert" className="text-sm text-destructive">
            {message}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

const CANCEL_CONFIRM_WORD = 'CANCEL';

function DropMissionControlKillSwitch({ ownDrop, state }: { ownDrop: UseOwnDropResult; state: DropState }) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const closeDialog = (open: boolean) => {
    if (ownDrop.isActing) return;
    setIsDialogOpen(open);
    if (!open) {
      setConfirmText('');
      setMessage(null);
    }
  };

  const confirmCancel = async () => {
    const outcome = await ownDrop.cancel();
    if (outcome.ok) {
      setIsDialogOpen(false);
      setConfirmText('');
      setMessage(null);
      toast({ title: 'Drop cancelled', description: 'The drop is ended; paid orders continue through fulfillment.' });
    } else {
      // CAS conflict included: fresh state was refetched by the hook — the
      // dialog stays open with the honest explanation so the seller can
      // review the new numbers and confirm again.
      setMessage(outcome.message);
    }
  };

  return (
    <Card className="border-destructive/40 py-5">
      <CardContent className="flex flex-col gap-3 px-5">
        <Typography as="h2" className="text-lg font-semibold">
          Kill switch
        </Typography>
        <Typography as="p" className="text-sm text-muted-foreground">
          {state === 'live'
            ? 'Aborting a live drop refuses new checkouts immediately and ends the drop as cancelled.'
            : 'Cancelling before launch ends the drop cleanly — it will never go live.'}
        </Typography>
        <Button
          variant="destructive"
          className="w-fit rounded-full"
          disabled={ownDrop.isActing}
          onClick={() => setIsDialogOpen(true)}
        >
          <OctagonX className="mr-2 size-4" />
          Cancel drop
        </Button>
      </CardContent>

      <Dialog open={isDialogOpen} onOpenChange={closeDialog}>
        <DialogContent className="border-border bg-popover">
          <DialogHeader>
            <DialogTitle>Cancel this drop?</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-2">
                <span>Honestly, what happens:</span>
                <ul className="list-disc pl-5 text-sm">
                  <li>The drop ends as cancelled and new checkouts are refused immediately.</li>
                  <li>
                    Orders already paid continue through normal fulfillment — cancelling the drop does not cancel them.
                  </li>
                  <li>The public drop page shows the cancellation. No silent disappearing drops.</li>
                  <li>This cannot be undone.</li>
                </ul>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="drop-cancel-confirm" className="text-sm">
              Type {CANCEL_CONFIRM_WORD} to confirm
            </Label>
            <Input
              id="drop-cancel-confirm"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={CANCEL_CONFIRM_WORD}
              autoComplete="off"
              disabled={ownDrop.isActing}
            />
          </div>
          {message && (
            <Typography as="p" role="alert" className="text-sm text-destructive">
              {message}
            </Typography>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              className="rounded-full"
              disabled={ownDrop.isActing}
              onClick={() => closeDialog(false)}
            >
              Keep the drop
            </Button>
            <Button
              variant="destructive"
              className="rounded-full"
              disabled={ownDrop.isActing || confirmText !== CANCEL_CONFIRM_WORD}
              onClick={() => void confirmCancel()}
            >
              {ownDrop.isActing ? 'Cancelling…' : 'Cancel the drop'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
