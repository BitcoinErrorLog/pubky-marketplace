'use client';

import { useEffect, useState } from 'react';
import { Archive, ArrowLeft, Bell, CalendarClock, Search, ShieldCheck, Store, Users } from 'lucide-react';
import { APP_ROUTES, getMarketplaceDropRoute, getMarketplaceShopRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useCommerceShopFollow } from '@/hooks/useCommerceShopFollow/useCommerceShopFollow';
import {
  DROP_ENDED_DESCRIPTIONS,
  DROP_ENDED_LABELS,
  DROP_NO_FAKE_PROMISE,
} from '@/hooks/useMarketplaceDrop/drop-display';
import { useMarketplaceDrop } from '@/hooks/useMarketplaceDrop/useMarketplaceDrop';
import { useMarketplaceDropClaim } from '@/hooks/useMarketplaceDropClaim/useMarketplaceDropClaim';
import { useMarketplaceFirstMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { DropClaimPanel } from '@/organisms/Marketplace/DropClaimPanel';
import { DropCountdown } from '@/organisms/Marketplace/DropCountdown';
import { DropReadyCheckPanel } from '@/organisms/Marketplace/DropReadyCheckPanel';
import { DropRemindMe } from '@/organisms/Marketplace/DropRemindMe';
import { DropStockDisplay } from '@/organisms/Marketplace/DropStockDisplay';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export interface MarketplaceDropProps {
  sellerPubky: string;
  dropId: string;
}

const DISPLAY_STATE_BADGES: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  unregistered: { label: 'Announced · not registered yet', variant: 'outline' },
  announced: { label: 'Announced', variant: 'secondary' },
  live: { label: 'Live', variant: 'default' },
  ended_sold_out: { label: 'Sold out', variant: 'outline' },
  ended_closed: { label: 'Ended', variant: 'outline' },
  ended_cancelled: { label: 'Cancelled by seller', variant: 'outline' },
};

/**
 * The shopper drop page (drops design, "The shopper experience"). Every
 * state renders from ONE derivation (`displayState`), which itself comes
 * only from the transaction service's projection — the corrected clock
 * schedules polls and countdown text, never claims. `announced` shows the
 * countdown, ready check, and remind-me; `live` shows the claim surface;
 * ended states show the archive with honest final-state copy.
 */
export function MarketplaceDrop({ sellerPubky, dropId }: MarketplaceDropProps) {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const drop = useMarketplaceDrop(sellerPubky, dropId);
  const claim = useMarketplaceDropClaim(drop.refresh);
  const shopFollow = useCommerceShopFollow(sellerPubky);
  const [shopName, setShopName] = useState<string | null>(null);
  const teaserUrl = useMarketplaceFirstMediaUrl(drop.record?.media ?? []);

  useEffect(() => {
    let active = true;
    CommerceController.getOrFetchShop(sellerPubky)
      .then((shop) => {
        if (active) setShopName(shop.name);
      })
      .catch(() => {
        // No shop record: the page renders the bare seller key instead.
      });
    return () => {
      active = false;
    };
  }, [sellerPubky]);

  if (drop.isLoading) {
    return (
      <DropPageShell>
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </DropPageShell>
    );
  }

  if (!drop.record) {
    return (
      <DropPageShell>
        <Container className="min-h-96 items-center justify-center px-6 text-center">
          <CalendarClock className="mb-4 size-12 text-muted-foreground" />
          <Heading level={1} size="lg">
            Drop unavailable
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            {drop.recordError ?? 'This drop could not be loaded.'}
          </Typography>
          <Button asChild className="mt-6 rounded-full">
            <Link href={MARKETPLACE_ROUTES.DROPS} overrideDefaults>
              Back to drops
            </Link>
          </Button>
        </Container>
      </DropPageShell>
    );
  }

  const record = drop.record;
  const projection = drop.projection;
  const state = drop.displayState;
  const stateBadge = DISPLAY_STATE_BADGES[state];
  const isEnded = state === 'ended_sold_out' || state === 'ended_closed' || state === 'ended_cancelled';
  const dropUrl =
    (typeof window !== 'undefined' ? window.location.origin : '') + getMarketplaceDropRoute(sellerPubky, dropId);

  return (
    <DropPageShell>
      <Link
        href={MARKETPLACE_ROUTES.DROPS}
        overrideDefaults
        className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Drops
      </Link>

      {teaserUrl ? (
        <div className="relative h-48 w-full overflow-hidden rounded-2xl bg-linear-to-br from-brand/20 via-card to-card">
          {/* eslint-disable-next-line @next/next/no-img-element -- homeserver media bypasses Next image optimization */}
          <img
            src={teaserUrl}
            alt={`${record.title} teaser`}
            className="absolute inset-0 size-full object-cover object-center"
          />
        </div>
      ) : (
        <div className="flex h-48 w-full items-center justify-center rounded-2xl bg-linear-to-br from-brand/20 via-card to-card">
          <CalendarClock className="size-12 text-muted-foreground" />
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {stateBadge && <Badge variant={stateBadge.variant}>{stateBadge.label}</Badge>}
          {projection && <DropStockDisplay projection={projection} />}
          <Badge variant="secondary">
            <Users className="mr-1 size-3" />
            Limit {projection?.perBuyerLimit ?? record.perBuyerLimit} per buyer
          </Badge>
          <Badge variant="secondary">FCFS — first come, first served</Badge>
        </div>
        <Heading level={1} size="xl" className="text-3xl leading-tight sm:text-5xl">
          {record.title}
        </Heading>
        <Typography as="p" className="max-w-3xl text-base leading-7 text-muted-foreground">
          {record.description}
        </Typography>
      </div>

      <Card className="gap-4 border py-5">
        <CardContent className="flex items-center justify-between gap-4 px-5">
          <div>
            <Typography as="p" className="text-sm text-muted-foreground">
              Dropped by
            </Typography>
            <Typography as="p" className="font-semibold">
              {shopName ?? `${sellerPubky.slice(0, 10)}…`}
            </Typography>
          </div>
          <Button asChild variant="secondary" size="sm" className="rounded-full">
            <Link href={getMarketplaceShopRoute(sellerPubky)} overrideDefaults>
              <Store className="mr-2 size-4" />
              View shop
            </Link>
          </Button>
        </CardContent>
      </Card>

      {state === 'unavailable' && (
        <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          This drop cannot go live here. You can still view the announcement below.
        </div>
      )}

      {state === 'unregistered' && (
        <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          This drop is not ready yet. The start time is provisional, and availability is not confirmed.
        </div>
      )}

      {(state === 'announced' || state === 'unregistered' || state === 'unavailable') && (
        <DropCountdown
          startsAt={projection?.startsAt ?? record.startsAt}
          endsAt={projection?.endsAt ?? record.endsAt ?? null}
          clockOffsetMs={drop.clockOffsetMs}
          phaseLabel={projection ? 'Starts in' : 'Starts in (estimate)'}
        />
      )}

      {state === 'announced' && projection && (
        <Typography as="p" className="text-xs text-muted-foreground">
          Availability will update when the drop opens.
        </Typography>
      )}

      {(state === 'announced' || state === 'live') && currentUserPubky && (
        <DropReadyCheckPanel
          hasSession={marketplaceSession !== null}
          hasAddress={claim.claimAddress !== null}
          readyCheck={drop.readyCheck}
          returnTo={getMarketplaceDropRoute(sellerPubky, dropId)}
          onSessionConnected={drop.refresh}
        />
      )}

      {(state === 'announced' || state === 'unregistered') && (
        <DropRemindMe record={record} projection={projection} dropUrl={dropUrl} />
      )}

      {state === 'live' && (
        <>
          {projection?.endsAt && (
            <DropCountdown
              startsAt={projection.startsAt}
              endsAt={projection.endsAt}
              clockOffsetMs={drop.clockOffsetMs}
              phaseLabel="Ends in"
            />
          )}
          <DropClaimPanel
            record={record}
            claim={claim}
            remainingAllowance={drop.readyCheck?.remainingAllowance ?? null}
            isOwner={currentUserPubky === sellerPubky}
          />
        </>
      )}

      {isEnded && projection && (
        <section aria-label="Drop archive" className="flex flex-col gap-3 rounded-xl border bg-card p-5">
          <Heading level={2} size="md" className="flex items-center gap-2">
            <Archive className="size-5 text-muted-foreground" />
            {DROP_ENDED_LABELS[state as keyof typeof DROP_ENDED_LABELS]}
          </Heading>
          <Typography as="p" className="text-sm text-muted-foreground">
            {DROP_ENDED_DESCRIPTIONS[state as keyof typeof DROP_ENDED_DESCRIPTIONS]}
          </Typography>
          <div className="grid gap-3 sm:grid-cols-3">
            <ArchiveFact label="Total quantity" value={String(projection.totalQuantity)} />
            <ArchiveFact label="Per-buyer limit" value={String(projection.perBuyerLimit)} />
            <ArchiveFact
              label="Window"
              value={`${new Date(projection.startsAt).toLocaleString()}${
                projection.endsAt ? ` → ${new Date(projection.endsAt).toLocaleString()}` : ' → sold out / cancelled'
              }`}
            />
          </div>
          <Typography as="p" className="text-xs text-muted-foreground">
            The final terms and outcome remain publicly available.
          </Typography>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              className="rounded-full"
              disabled={shopFollow.isLoading || shopFollow.isMutating}
              onClick={shopFollow.toggle}
            >
              <Bell className={shopFollow.isFollowing ? 'mr-2 size-4 fill-brand text-brand' : 'mr-2 size-4'} />
              {shopFollow.isFollowing ? 'Watching seller' : 'Watch this seller'}
            </Button>
            <Button asChild className="rounded-full">
              <Link href={APP_ROUTES.MARKETPLACE} overrideDefaults>
                <Search className="mr-2 size-4" />
                Browse similar
              </Link>
            </Button>
          </div>
        </section>
      )}

      <footer className="mt-4 flex items-start gap-2 rounded-xl border border-dashed p-4">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
        <Typography as="p" className="text-xs text-muted-foreground">
          {DROP_NO_FAKE_PROMISE}
        </Typography>
      </footer>
    </DropPageShell>
  );
}

function ArchiveFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card/60 p-3">
      <Typography as="p" className="text-xs text-muted-foreground">
        {label}
      </Typography>
      <Typography as="p" className="text-sm font-semibold">
        {value}
      </Typography>
    </div>
  );
}

function DropPageShell({ children }: { children: React.ReactNode }) {
  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28 lg:pb-16"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6 px-4 sm:px-6 lg:px-8">
        {children}
      </Container>
    </ContentLayout>
  );
}
