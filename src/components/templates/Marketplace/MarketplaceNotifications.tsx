'use client';

import { type ReactNode, useEffect } from 'react';
import { Bell, Eye, Gavel, HandCoins, MessageCircle } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Switch } from '@/atoms/Switch/Switch';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceNotifications } from '@/hooks/useMarketplaceNotifications/useMarketplaceNotifications';
import { type MarketplaceOrderView, useMarketplaceOrders } from '@/hooks/useMarketplaceOrders/useMarketplaceOrders';
import { useMarketplaceWatchAlertFeed } from '@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed';
import { useMarketplaceWatchDetection } from '@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection';
import { useRelativeTime } from '@/hooks/useRelativeTime/useRelativeTime';
import { activityRowHref } from '@/libs/commerce/activity-links';
import { formatBitcoinAwareMoney } from '@/libs/commerce/bitcoin-payment-code';
import { isBuyerCheckoutInProgress } from '@/libs/commerce/checkout-phase';
import { returnActivityTitles } from '@/libs/commerce/return-activity-titles';
import { Logger } from '@/libs/logger/logger';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import { MarketplaceSessionRequiredCard } from '@/organisms/Marketplace/MarketplaceSessionRequiredCard';
import {
  getWatchAlertDetail,
  getWatchAlertHeadline,
} from '@/organisms/MarketplaceWatchAlertItem/MarketplaceWatchAlertItem.utils';
import type { MarketplaceNotification } from '@/services/marketplace/marketplace';
import {
  bitcoinNotificationCopy,
  DIGITAL_DELIVERED_COPY,
  digitalDeliveryNotice,
  isIntegrityGapActivityType,
  MARKETPLACE_ACTIVITY_LABELS,
  marketplaceActivityLabel,
} from '@/services/marketplace/marketplace-activity-copy';
import { useAuthStore } from '@/stores/auth/auth.store';

/** Device-local alerts shown on this page before the service-delivered list. */
const WATCH_ALERTS_SECTION_LIMIT = 6;

export function MarketplaceNotifications() {
  const {
    notifications,
    preferences,
    unreadCount,
    isLoading,
    error,
    needsSession,
    canMarkRead,
    markAllRead,
    updatePreferences,
  } = useMarketplaceNotifications();
  const integrityGapCount = notifications.filter(
    (notification) => 'kind' in notification && isIntegrityGapActivityType(notification.type),
  ).length;
  const watchAlerts = useMarketplaceWatchAlertFeed();
  const { orders, isLoading: ordersLoading } = useMarketplaceOrders();
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const returnTitles = returnActivityTitles(
    notifications.flatMap((notification) =>
      'kind' in notification || notification.type !== 'return_updated'
        ? []
        : [
            {
              id: notification.id,
              aggregateId: notification.aggregateId,
              createdAt: notification.createdAt,
            },
          ],
    ),
    new Map(orders.map(({ order }) => [order.id, order.returnRequest?.reason ?? null])),
    !ordersLoading,
  );
  // Opening the commerce activity page also runs the bounded watchlist check.
  useMarketplaceWatchDetection();

  // Re-run once the session is restored, since the writes are account-scoped.
  const isAuthenticated = useAuthStore((state) => state.session !== null);

  // Visiting this surface clears the marketplace Activity badge: watch alerts
  // get their real local `seen_at` (the mount-frozen highlights above stay
  // visible), and the account's activity checkpoint advances to now on every
  // browser — the substitute for the read state the durable service does not
  // store. Sandbox service rows keep their REAL read state and clear only via
  // the Mark all read button.
  const markAllWatchAlertsSeen = watchAlerts.markAllSeen;
  useEffect(() => {
    if (!isAuthenticated) return;
    void markAllWatchAlertsSeen();
    CommerceController.markActivityRead().catch((error) => {
      Logger.warn('Failed to advance the activity read checkpoint', { error });
    });
  }, [isAuthenticated, markAllWatchAlertsSeen]);

  const setPreference = (key: 'messages' | 'offers' | 'bids' | 'auctions', checked: boolean) => {
    if (!preferences) return;
    void updatePreferences({
      messages: preferences.messages,
      offers: preferences.offers,
      bids: preferences.bids,
      auctions: preferences.auctions,
      [key]: checked,
    });
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
      <Container
        overrideDefaults
        className="flex w-full flex-col gap-6 px-4 sm:px-6"
        data-surface="marketplace-transaction-history"
      >
        <MarketplaceSectionNav />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
              Transaction history
            </Heading>
            <Typography as="p" className="mt-2 text-muted-foreground">
              Updates on your orders, payments, offers, and bids.
            </Typography>
          </div>
          {canMarkRead ? (
            <Button variant="secondary" className="rounded-full" disabled={unreadCount === 0} onClick={markAllRead}>
              Mark all read
            </Button>
          ) : null}
        </div>

        {preferences && (
          <Card className="border py-4">
            <CardContent className="grid gap-4 px-5 sm:grid-cols-2">
              {(
                [
                  ['messages', 'Messages'],
                  ['offers', 'Offers'],
                  ['bids', 'Bid updates'],
                  ['auctions', 'Auction results'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center justify-between gap-4 text-sm">
                  {label}
                  <Switch
                    checked={preferences[key]}
                    onCheckedChange={(checked) => setPreference(key, checked)}
                    aria-label={`${label} notifications`}
                  />
                </label>
              ))}
            </CardContent>
          </Card>
        )}

        {watchAlerts.items.length > 0 && (
          <section aria-label="Watchlist alerts" className="flex flex-col gap-3" data-cy="notifications-watch-alerts">
            <div className="flex flex-wrap items-center gap-2">
              <Eye className="size-4 text-brand" />
              <Heading level={2} size="sm" className="text-lg">
                Watchlist alerts
              </Heading>
              <Typography as="span" className="text-xs text-muted-foreground">
                Detected by checks this device runs when you visit — not server events.
              </Typography>
            </div>
            <Card className="border py-2">
              <CardContent className="flex flex-col gap-1 px-4 py-2">
                {watchAlerts.items.slice(0, WATCH_ALERTS_SECTION_LIMIT).map((alert) => (
                  <WatchAlertRow key={alert.id} alert={alert} />
                ))}
                <Link
                  href={MARKETPLACE_ROUTES.WATCHLIST}
                  overrideDefaults
                  className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  View the full watchlist
                </Link>
              </CardContent>
            </Card>
          </section>
        )}

        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : needsSession && error ? (
          <MarketplaceSessionRequiredCard />
        ) : error ? (
          <div role="alert" className="rounded-xl border border-destructive/40 p-4">
            {error}
          </div>
        ) : notifications.length ? (
          <div className="flex flex-col gap-3">
            {integrityGapCount > 0 && (
              <div role="status" className="rounded-xl border border-amber-500/40 p-4 text-sm">
                {integrityGapCount} unrecognized marketplace event{integrityGapCount === 1 ? '' : 's'} — history may be
                incomplete.
              </div>
            )}
            {notifications.map((notification) =>
              'kind' in notification ? (
                <KnownOrGapActivityRow
                  key={`unrecognized:${notification.type}:${notification.createdAt}:${notification.id}`}
                  type={notification.type}
                  createdAt={notification.createdAt}
                />
              ) : (
                <NotificationCard
                  key={notification.id}
                  notification={notification}
                  canCheckout={checkoutStartedCanContinue(notification, orders, currentUserPubky, ordersLoading)}
                  title={
                    notification.type === 'return_updated'
                      ? (returnTitles.get(notification.id) ?? 'Return updated')
                      : undefined
                  }
                />
              ),
            )}
          </div>
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed text-center">
            <Bell className="mb-3 size-10 text-muted-foreground" />
            <Heading level={2} size="md">
              No commerce updates
            </Heading>
          </div>
        )}
      </Container>
    </ContentLayout>
  );
}

function KnownOrGapActivityRow({ type, createdAt }: { type: string; createdAt: string }) {
  const label = marketplaceActivityLabel(type);
  if (!label) {
    return (
      <Card className="border py-4">
        <CardContent className="flex items-center gap-4 px-4">
          <div className="rounded-full bg-amber-500/15 p-3 text-amber-600">
            <Bell className="size-5" />
          </div>
          <Typography as="p" className="font-semibold">
            Unrecognized marketplace event
          </Typography>
          <Typography as="span" className="ml-auto text-xs text-muted-foreground">
            Integrity notice
          </Typography>
        </CardContent>
      </Card>
    );
  }
  const href = activityRowHref(type as MarketplaceNotification['type'], null);
  return (
    <ActivityRowLink href={href} label={label}>
      <Card className="border py-4">
        <CardContent className="flex items-center gap-4 px-4">
          <div className="rounded-full bg-brand/15 p-3 text-brand">
            <HandCoins className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <Typography as="p" className="font-semibold">
              {label}
            </Typography>
          </div>
          <time dateTime={createdAt} className="text-xs text-muted-foreground">
            {new Date(createdAt).toLocaleDateString('en-US')}
          </time>
        </CardContent>
      </Card>
    </ActivityRowLink>
  );
}

function checkoutStartedCanContinue(
  notification: MarketplaceNotification,
  orders: MarketplaceOrderView[],
  currentUserPubky: string | null,
  ordersLoading: boolean,
): boolean {
  if (ordersLoading || notification.type !== 'order_created' || !notification.aggregateId.startsWith('order:')) {
    return false;
  }
  const orderId = notification.aggregateId.slice('order:'.length);
  const order = orders.find((view) => view.order.id === orderId)?.order;
  return Boolean(order && isBuyerCheckoutInProgress(order, currentUserPubky));
}

function NotificationCard({
  notification,
  title,
  canCheckout,
}: {
  notification: MarketplaceNotification;
  title?: string;
  canCheckout: boolean;
}) {
  const label = title ?? notificationLabel(notification);
  const href = activityRowHref(notification.type, notification.aggregateId, { canCheckout });
  return (
    <ActivityRowLink href={href} label={label}>
      <Card className="border py-4">
        <CardContent className="flex items-center gap-4 px-4">
          <div className="rounded-full bg-brand/15 p-3 text-brand">
            <NotificationIcon type={notification.type} />
          </div>
          <div className="min-w-0 flex-1">
            <Typography as="p" className="font-semibold">
              {label}
              {/* §8-permitted monetary context (offer amount, auction
                            visible price), formatted per BIP-177 for bitcoin. */}
              {notification.amount ? ` · ${formatBitcoinAwareMoney(notification.amount)}` : ''}
            </Typography>
            <Typography as="p" className="truncate text-sm text-muted-foreground">
              From {notificationActorLabel(notification.actorPubky)}
            </Typography>
          </div>
          <time dateTime={notification.createdAt} className="text-xs text-muted-foreground">
            {new Date(notification.createdAt).toLocaleDateString('en-US')}
          </time>
        </CardContent>
      </Card>
    </ActivityRowLink>
  );
}

function ActivityRowLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      overrideDefaults
      aria-label={label}
      className="block rounded-xl outline-none hover:ring-1 hover:ring-brand/40 focus-visible:ring-2 focus-visible:ring-brand"
    >
      {children}
    </Link>
  );
}

function WatchAlertRow({ alert }: { alert: ReturnType<typeof useMarketplaceWatchAlertFeed>['items'][number] }) {
  const { formatRelativeTime } = useRelativeTime();
  const detail = getWatchAlertDetail(alert);
  return (
    <Link
      href={alert.href}
      overrideDefaults
      className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-background/60"
    >
      <div className="min-w-0">
        <Typography as="p" className="truncate text-sm font-medium">
          {getWatchAlertHeadline(alert)}: {alert.title}
        </Typography>
        <Typography as="p" className="truncate text-xs text-muted-foreground">
          {detail ? `${detail} · ` : ''}Observed {formatRelativeTime(new Date(alert.timestamp))} by this device
        </Typography>
      </div>
      {alert.isUnseen && <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden />}
    </Link>
  );
}

function NotificationIcon({ type }: { type: MarketplaceNotification['type'] }) {
  switch (type) {
    case 'message_received':
      return <MessageCircle className="size-5" />;
    case 'outbid':
    case 'auction_won':
    case 'auction_ended':
      return <Gavel className="size-5" />;
    default:
      return <HandCoins className="size-5" />;
  }
}

function notificationLabel(notification: MarketplaceNotification): string {
  const digital = digitalDeliveryNotice(notification);
  if (digital) return DIGITAL_DELIVERED_COPY[digital].label;
  const bitcoin = bitcoinNotificationCopy(notification);
  return bitcoin ? bitcoin.label : MARKETPLACE_ACTIVITY_LABELS[notification.type];
}

function notificationActorLabel(actorPubky: string): string {
  if (actorPubky === 'system') return 'System';
  if (actorPubky === 'paypal-ipn') return 'PayPal';
  return `${actorPubky.slice(0, 10)}…`;
}
