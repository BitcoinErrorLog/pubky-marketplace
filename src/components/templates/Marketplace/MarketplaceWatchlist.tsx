'use client';

import { useState } from 'react';
import { Bell, Eye, Gavel, Heart, Package, RefreshCw } from 'lucide-react';
import { APP_ROUTES, getMarketplaceListingRoute } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Image } from '@/atoms/Image/Image';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useCommerceFavorite } from '@/hooks/useCommerceFavorite/useCommerceFavorite';
import { useMarketplaceLiveBid } from '@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid';
import { useMarketplaceFirstMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { useMarketplaceNotificationFeed } from '@/hooks/useMarketplaceNotificationFeed/useMarketplaceNotificationFeed';
import { useMarketplaceSellerSummary } from '@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary';
import { useMarketplaceWatchAlertFeed } from '@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed';
import { useMarketplaceWatchDetection } from '@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection';
import {
  type MarketplaceWatchlistEntry,
  useMarketplaceWatchlist,
} from '@/hooks/useMarketplaceWatchlist/useMarketplaceWatchlist';
import { useRelativeTime } from '@/hooks/useRelativeTime/useRelativeTime';
import { effectiveListingState } from '@/libs/commerce/auction-phase';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { Logger } from '@/libs/logger/logger';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceReauthDialog } from '@/organisms/Marketplace/MarketplaceReauthDialog';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import { MarketplaceNotificationItem } from '@/organisms/MarketplaceNotificationItem/MarketplaceNotificationItem';
import {
  getWatchAlertDetail,
  getWatchAlertHeadline,
} from '@/organisms/MarketplaceWatchAlertItem/MarketplaceWatchAlertItem.utils';

/** Auction lifecycle kinds the transaction service actually emits to this user. */
const SERVICE_AUCTION_KINDS = new Set(['outbid', 'auction_won', 'auction_ended']);

const WATCH_ALERTS_PAGE_LIMIT = 8;

export function MarketplaceWatchlist() {
  const { entries, isLoading, isSignedIn, watchlistSyncStatus, syncWatchlist } = useMarketplaceWatchlist();
  const alertFeed = useMarketplaceWatchAlertFeed();
  const serviceFeed = useMarketplaceNotificationFeed();
  const [isCheckingNow, setIsCheckingNow] = useState(false);
  // Visiting the watchlist runs the bounded detection pass (spaced; no daemon).
  useMarketplaceWatchDetection();

  const serviceAuctionRows = serviceFeed.items.filter((item) => SERVICE_AUCTION_KINDS.has(item.type)).slice(0, 5);
  const localAlerts = alertFeed.items.slice(0, WATCH_ALERTS_PAGE_LIMIT);
  const lastCheckedAt = entries.reduce((newest, entry) => Math.max(newest, entry.snapshot?.checked_at ?? 0), 0);

  const checkNow = async () => {
    setIsCheckingNow(true);
    try {
      await CommerceController.runWatchlistDetection();
    } catch (error) {
      Logger.warn('Manual watchlist check failed', { error });
    } finally {
      setIsCheckingNow(false);
    }
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6 px-4 sm:px-6">
        <MarketplaceSectionNav />

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
              Watchlist
            </Heading>
            <Typography as="p" className="mt-2 text-muted-foreground">
              {entries.length} watched {entries.length === 1 ? 'item' : 'items'}. Changes are detected by checks this
              device runs when you visit — there is no background process.
            </Typography>
          </div>
          {isSignedIn && entries.length > 0 && (
            <div className="flex items-center gap-3">
              {lastCheckedAt > 0 && <LastCheckedLabel checkedAt={lastCheckedAt} />}
              <Button
                variant="secondary"
                className="rounded-full"
                disabled={isCheckingNow}
                onClick={() => void checkNow()}
                data-cy="watchlist-check-now"
              >
                <RefreshCw className={`mr-2 size-4 ${isCheckingNow ? 'animate-spin' : ''}`} />
                Check now
              </Button>
            </div>
          )}
        </div>

        {isSignedIn && watchlistSyncStatus === 'needs_reauth' && (
          <Card className="border border-amber-500/40 bg-amber-500/5" data-cy="watchlist-sync-reauth-notice">
            <CardContent className="flex flex-col gap-1 py-4">
              <Typography as="p" className="font-medium">
                Sync across devices needs a fresh sign-in approval
              </Typography>
              <Typography as="p" className="text-sm text-muted-foreground">
                Your watchlist keeps working on this device. To sync it privately through your homeserver, sign in again
                and approve the private-storage permission — sessions approved before that permission existed cannot
                write it.
              </Typography>
              <div className="mt-2">
                <MarketplaceReauthDialog
                  triggerLabel="Sign in again to enable sync"
                  refusal="homeserver"
                  onReauthenticated={syncWatchlist}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {isSignedIn && watchlistSyncStatus === 'needs_marketplace_approval' && (
          <Card
            className="border border-amber-500/40 bg-amber-500/5"
            data-cy="watchlist-sync-marketplace-approval-notice"
          >
            <CardContent className="flex flex-col gap-1 py-4">
              <Typography as="p" className="font-medium">
                Sync across devices needs a marketplace approval
              </Typography>
              <Typography as="p" className="text-sm text-muted-foreground">
                Your watchlist keeps working on this device. It syncs encrypted through your homeserver, and the
                marketplace releases the key only to a purchase session that includes your private Shop data. Approve
                one to turn sync on.
              </Typography>
              <div className="mt-2">
                <MarketplaceReauthDialog
                  triggerLabel="Approve private sync"
                  refusal="purchase_session"
                  onReauthenticated={syncWatchlist}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {isSignedIn && watchlistSyncStatus === 'unavailable' && (
          <Card className="border border-muted-foreground/30" data-cy="watchlist-sync-unavailable-notice">
            <CardContent className="flex flex-col gap-1 py-4">
              <Typography as="p" className="font-medium">
                Private sync is unavailable right now
              </Typography>
              <Typography as="p" className="text-sm text-muted-foreground">
                Your watchlist keeps working on this device. It syncs encrypted through your homeserver once the
                marketplace can provide your private data key again.
              </Typography>
            </CardContent>
          </Card>
        )}

        {isSignedIn && watchlistSyncStatus === 'unsupported' && (
          <Card className="border border-muted-foreground/30" data-cy="watchlist-sync-unsupported-notice">
            <CardContent className="flex flex-col gap-1 py-4">
              <Typography as="p" className="font-medium">
                This browser cannot sync your watchlist
              </Typography>
              <Typography as="p" className="text-sm text-muted-foreground">
                Your watchlist keeps working on this device. Syncing it across devices needs a browser that can
                coordinate its open tabs, so no change is lost. Update this browser or use a current one to sync.
              </Typography>
            </CardContent>
          </Card>
        )}

        {!isSignedIn ? (
          <Card className="border py-10">
            <CardContent className="flex flex-col items-center gap-3 text-center">
              <Eye className="size-10 text-muted-foreground" />
              <Heading level={2} size="md">
                Sign in to keep a watchlist
              </Heading>
              <Typography as="p" className="max-w-md text-muted-foreground">
                Watched items are stored with your account on this device and synced privately across your devices
                through your homeserver. Alerts come from checks the app runs while you browse.
              </Typography>
            </CardContent>
          </Card>
        ) : (
          <>
            {serviceAuctionRows.length > 0 && (
              <section aria-label="Auction notifications" className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Gavel className="size-4 text-brand" />
                  <Heading level={2} size="sm" className="text-lg">
                    Auction notifications
                  </Heading>
                  <Typography as="span" className="text-xs text-muted-foreground">
                    Delivered by the marketplace service — you are notified when a bid displaces you.
                  </Typography>
                </div>
                <Card className="border py-2">
                  <CardContent className="flex flex-col gap-3 px-4 py-2">
                    {serviceAuctionRows.map((notification) => (
                      <MarketplaceNotificationItem key={notification.id} notification={notification} />
                    ))}
                  </CardContent>
                </Card>
              </section>
            )}

            {localAlerts.length > 0 && (
              <section aria-label="Watchlist alerts" className="flex flex-col gap-3" data-cy="watchlist-alerts">
                <div className="flex items-center gap-2">
                  <Bell className="size-4 text-brand" />
                  <Heading level={2} size="sm" className="text-lg">
                    Detected on this device
                  </Heading>
                  <Typography as="span" className="text-xs text-muted-foreground">
                    From this device&apos;s own checks of the listing index and public auction state — not server
                    events.
                  </Typography>
                </div>
                <Card className="border py-2">
                  <CardContent className="flex flex-col gap-1 px-4 py-2">
                    {localAlerts.map((alert) => {
                      const detail = getWatchAlertDetail(alert);
                      return (
                        <Link
                          key={alert.id}
                          href={alert.href}
                          overrideDefaults
                          className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-background/60"
                        >
                          <div className="min-w-0">
                            <Typography as="p" className="truncate text-sm font-medium">
                              {getWatchAlertHeadline(alert)}: {alert.title}
                            </Typography>
                            <Typography as="p" className="truncate text-xs text-muted-foreground">
                              {detail ? `${detail} · ` : ''}
                              <CheckedAtLabel timestamp={alert.timestamp} />
                            </Typography>
                          </div>
                          {alert.isUnseen && <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden />}
                        </Link>
                      );
                    })}
                  </CardContent>
                </Card>
              </section>
            )}

            {isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : entries.length > 0 ? (
              <section aria-label="Watched items" className="flex flex-col gap-3">
                {entries.map((entry) => (
                  <WatchlistItemRow key={entry.listingId} entry={entry} />
                ))}
              </section>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed text-center">
                <Heart className="mb-3 size-10 text-muted-foreground" />
                <Heading level={2} size="md">
                  Nothing watched yet
                </Heading>
                <Typography as="p" className="mt-2 max-w-md text-muted-foreground">
                  Tap the heart on a listing — or the bell on an auction — and it will show up here with its latest
                  observed price, state, and deadline.
                </Typography>
                <Button asChild className="mt-6 rounded-full">
                  <Link href={APP_ROUTES.MARKETPLACE} overrideDefaults>
                    Browse the marketplace
                  </Link>
                </Button>
              </div>
            )}
          </>
        )}
      </Container>
    </ContentLayout>
  );
}

function LastCheckedLabel({ checkedAt }: { checkedAt: number }) {
  const { formatRelativeTime } = useRelativeTime();
  return (
    <Typography as="span" className="text-xs text-muted-foreground">
      Checked {formatCheckedRelativeTime(formatRelativeTime(new Date(checkedAt)))}
    </Typography>
  );
}

function CheckedAtLabel({ timestamp }: { timestamp: number }) {
  const { formatRelativeTime } = useRelativeTime();
  return <>Observed {formatRelativeTime(new Date(timestamp))} by this device</>;
}

function WatchlistItemRow({ entry }: { entry: MarketplaceWatchlistEntry }) {
  const { item, snapshot, sellerId, rawListingId, listingId } = entry;
  const isAuction = item ? item.saleFormat === 'auction' : snapshot?.auction_ends_at !== null;
  const watch = useCommerceFavorite(listingId);
  const seller = useMarketplaceSellerSummary(sellerId, { includeReputation: false });
  const { ref: liveBidRef, bid } = useMarketplaceLiveBid(sellerId, rawListingId, Boolean(item && isAuction));
  const [mediaFailed, setMediaFailed] = useState(false);

  const hasLiveBid = bid !== null && bid.bidCount > 0;
  const title = item?.title ?? snapshot?.title ?? rawListingId;
  const mediaUrl = useMarketplaceFirstMediaUrl(item?.mediaUrls ?? []);
  const endsAt = item?.auction?.endsAt ?? snapshot?.auction_ends_at ?? null;
  const state = deriveWatchlistState(entry);

  return (
    <Card ref={liveBidRef} className="border py-3" data-cy="watchlist-item">
      <CardContent className="flex items-center gap-4 px-4">
        <Link
          href={getMarketplaceListingRoute(sellerId, rawListingId)}
          overrideDefaults
          className="flex min-w-0 flex-1 items-center gap-4"
        >
          <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-background/60">
            {mediaUrl && !mediaFailed ? (
              <div className="relative size-16">
                <Image
                  src={mediaUrl}
                  alt={title}
                  fill
                  sizes="64px"
                  className="object-cover object-center"
                  onError={() => setMediaFailed(true)}
                />
              </div>
            ) : (
              <Package className="size-7 text-muted-foreground" aria-hidden="true" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <Typography as="h3" className="truncate text-base font-semibold">
              {title}
            </Typography>
            <Typography as="p" className="truncate text-xs text-muted-foreground">
              {seller.displayName}
            </Typography>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{isAuction ? 'Auction' : 'Buy now'}</Badge>
              {state && (
                <Badge
                  variant="outline"
                  className={state.tone === 'warn' ? 'border-amber-500/50 text-amber-300' : undefined}
                >
                  {state.label}
                </Badge>
              )}
              {endsAt && <EndsAtBadge endsAt={endsAt} />}
              {!item && (
                <Typography as="span" className="text-xs text-muted-foreground">
                  Not in the local catalog cache yet — open the listing or wait for the next check.
                </Typography>
              )}
            </div>
          </div>

          {item && (
            <div className="flex shrink-0 flex-col items-end">
              {isAuction && (
                <Typography
                  as="span"
                  className="text-[11px] leading-4 font-medium tracking-[1.2px] text-muted-foreground uppercase"
                >
                  {hasLiveBid ? 'Current bid' : 'Starting bid'}
                </Typography>
              )}
              <Typography as="p" className="text-base font-bold text-brand">
                {formatCommerceMoney(hasLiveBid ? bid.currentPrice : item.price)}
              </Typography>
              {hasLiveBid && (
                <Typography as="span" className="text-xs text-muted-foreground">
                  {bid.bidCount} {bid.bidCount === 1 ? 'bid' : 'bids'}
                </Typography>
              )}
            </div>
          )}
        </Link>

        <Button
          size="icon"
          variant="ghost"
          aria-label="Remove from watchlist"
          disabled={watch.isMutating}
          onClick={() => void watch.toggle()}
          data-cy="watchlist-item-unwatch"
        >
          {isAuction ? (
            <Bell className="size-4 fill-brand text-brand" />
          ) : (
            <Heart className="size-4 fill-brand text-brand" />
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function EndsAtBadge({ endsAt }: { endsAt: string }) {
  // Captured once per mount: the countdown label reflects when the row
  // rendered, matching the page's visit-triggered freshness model.
  const [nowMs] = useState(() => Date.now());
  const endsMs = Date.parse(endsAt);
  const remaining = endsMs - nowMs;
  if (remaining <= 0) {
    return <Badge variant="outline">Ended</Badge>;
  }
  const label =
    remaining < 48 * 60 * 60 * 1_000
      ? `Ends in ${formatRemaining(remaining)}`
      : `Ends ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(endsMs))}`;
  const isEndingSoon = remaining < 24 * 60 * 60 * 1_000;
  return (
    <Badge variant="outline" className={isEndingSoon ? 'border-amber-500/50 text-amber-300' : undefined}>
      {label}
    </Badge>
  );
}

function formatRemaining(remainingMs: number): string {
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function deriveWatchlistState(entry: MarketplaceWatchlistEntry): { label: string; tone: 'normal' | 'warn' } | null {
  // The projection's sale state (a real per-listing read) wins over the
  // index state when this device has observed one.
  const projectionState = entry.snapshot?.projection_state;
  if (projectionState === 'sold') return { label: 'Sold out', tone: 'warn' };
  if (projectionState === 'reserved') return { label: 'Reserved', tone: 'warn' };

  const endsAt = entry.item?.auction?.endsAt ?? entry.snapshot?.auction_ends_at ?? null;
  const indexState = entry.item?.state ?? entry.snapshot?.index_state ?? null;
  const state = indexState ? effectiveListingState(indexState, endsAt) : null;
  switch (state) {
    case 'active':
      return { label: 'Active', tone: 'normal' };
    case 'paused':
      return { label: 'Unlisted', tone: 'warn' };
    case 'ended':
      return { label: 'Ended', tone: 'warn' };
    case 'removed':
      return { label: 'Removed', tone: 'warn' };
    default:
      return null;
  }
}

function formatCheckedRelativeTime(relativeTime: string): string {
  if (relativeTime === '0s') return 'just now';

  const seconds = relativeTime.match(/^(\d+)s$/);
  if (seconds) return `${seconds[1]} sec ago`;

  return relativeTime.endsWith('ago') ? relativeTime : `${relativeTime} ago`;
}
