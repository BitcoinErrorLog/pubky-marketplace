'use client';

import { ArrowLeft, Rocket } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { useDropStudio } from '@/hooks/useDropStudio/useDropStudio';
import { type OwnDropRow, useOwnDrops } from '@/hooks/useOwnDrops/useOwnDrops';
import type { DropState } from '@/libs/commerce/transaction-contracts';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { DropStudioComposer } from '@/organisms/Marketplace/DropStudioComposer';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';
import { useAuthStore } from '@/stores/auth/auth.store';

const NEW_DROP_ANCHOR = 'new-drop';

/**
 * The drops home in the sell area: the seller's drops (each row carrying the
 * AUTHORITATIVE state from the service's seller projection, or a Draft label
 * when the service has no aggregate) above the Drop Studio composer. Drops
 * are durable-mode only — server time is the feature — so every other mode
 * renders the affordance as unavailable, labeled.
 */
export function DropStudioHome() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const drops = useOwnDrops();
  const studio = useDropStudio();
  const needsSession =
    studio.isDurable &&
    Boolean(currentUserPubky) &&
    drops.rows.some((row) => row.projection.status === 'session-unavailable');

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28 lg:pb-16"
      classNameWrapperContent="max-w-4xl"
    >
      <Container
        overrideDefaults
        data-surface="drop-studio-home"
        className="flex w-full flex-col gap-6 px-4 sm:px-6 lg:px-8"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href={MARKETPLACE_ROUTES.SELL}
            overrideDefaults
            className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Sell
          </Link>
          {studio.isDurable && currentUserPubky ? (
            <Button asChild variant="secondary" className="shrink-0">
              <a href={`#${NEW_DROP_ANCHOR}`}>New drop</a>
            </Button>
          ) : null}
        </div>

        <div>
          <Badge className="mb-4">Seller studio · Drops</Badge>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Drops
          </Heading>
          <Typography as="p" className="mt-3 max-w-2xl text-muted-foreground">
            Create timed releases of your listings with limited quantities.
          </Typography>
        </div>

        {!studio.isDurable ? (
          <Card className="border-dashed py-5">
            <CardContent className="flex flex-col gap-2 px-5">
              <Typography as="p" className="font-semibold">
                Drops are unavailable in this mode
              </Typography>
              <Typography as="p" className="text-sm text-muted-foreground">
                Creating and managing drops is unavailable here.
              </Typography>
            </CardContent>
          </Card>
        ) : !currentUserPubky ? (
          <Card className="border-dashed py-5">
            <CardContent className="px-5">
              <Typography as="p" className="text-sm text-muted-foreground">
                Sign in to compose and run drops.
              </Typography>
            </CardContent>
          </Card>
        ) : (
          <>
            {needsSession ? (
              <div
                role="status"
                data-surface="drop-studio-session-bootstrap"
                className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <Typography as="p" className="text-sm">
                  Connect a marketplace session to read drop status.
                </Typography>
                <MarketplaceSessionConnectDialog
                  triggerLabel="Connect marketplace session"
                  onConnected={() => void drops.refresh()}
                />
              </div>
            ) : null}

            <section className="flex flex-col gap-3">
              <Typography as="h2" className="text-xl font-semibold">
                Your drops
              </Typography>
              {drops.isLoading && drops.rows.length === 0 ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-16 w-full rounded-lg" />
                  <Skeleton className="h-16 w-full rounded-lg" />
                </div>
              ) : drops.rows.length === 0 ? (
                <Card className="border-dashed py-4">
                  <CardContent className="px-5">
                    <Typography as="p" className="text-sm text-muted-foreground">
                      No drops published yet — compose your first one below.
                    </Typography>
                  </CardContent>
                </Card>
              ) : (
                <ul className="flex flex-col gap-2">
                  {drops.rows.map((row) => (
                    <DropStudioHomeRow key={row.dropId} row={row} onRetry={() => void drops.refresh()} />
                  ))}
                </ul>
              )}
              <Typography as="p" className="text-xs text-muted-foreground">
                Drops published from any device appear here.
              </Typography>
            </section>

            <section id={NEW_DROP_ANCHOR} className="flex scroll-mt-24 flex-col gap-4">
              <div className="flex items-center gap-2">
                <Rocket className="size-5 text-brand" aria-hidden />
                <Typography as="h2" className="text-xl font-semibold">
                  New drop
                </Typography>
              </div>
              <DropStudioComposer studio={studio} />
            </section>
          </>
        )}
      </Container>
    </ContentLayout>
  );
}

const DROP_STATE_LABELS: Record<DropState, string> = {
  announced: 'Scheduled',
  live: 'Live',
  ended_sold_out: 'Ended',
  ended_closed: 'Ended',
  ended_cancelled: 'Ended',
};

function DropStudioHomeRow({ row, onRetry }: { row: OwnDropRow; onRetry: () => void }) {
  const startsAtMs = row.record ? Date.parse(row.record.startsAt) : null;
  const endsAtMs = row.record?.endsAt !== undefined ? Date.parse(row.record.endsAt) : null;
  const projection = row.projection;
  const statusLine = projection.status === 'unavailable' ? "Could not read this drop's status." : null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4 hover:border-brand/50">
      <Link
        href={`${MARKETPLACE_ROUTES.SELL_DROPS}/${row.dropId}`}
        overrideDefaults
        className="flex min-w-0 flex-1 flex-col gap-1 hover:text-foreground"
      >
        <Typography as="p" className="truncate font-medium">
          {row.record?.title ?? `Drop ${row.dropId}`}
        </Typography>
        <Typography as="p" className="text-sm text-muted-foreground">
          {startsAtMs !== null
            ? `Launch ${new Date(startsAtMs).toLocaleString()}${endsAtMs !== null ? ` → ends ${new Date(endsAtMs).toLocaleString()}` : ' → runs until sell-out or cancel'}`
            : 'This drop could not be loaded.'}
        </Typography>
        {statusLine ? (
          <Typography as="p" className="text-sm text-muted-foreground">
            {statusLine}
          </Typography>
        ) : null}
      </Link>
      {projection.status === 'loaded' ? (
        <Badge variant={projection.drop.state === 'live' ? 'default' : 'secondary'}>
          {DROP_STATE_LABELS[projection.drop.state]}
        </Badge>
      ) : projection.status === 'unregistered' ? (
        <Badge variant="outline">Draft</Badge>
      ) : projection.status === 'unavailable' ? (
        <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </li>
  );
}
