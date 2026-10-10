'use client';

import { useEffect } from 'react';
import { Button, ButtonVariant } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll/useInfiniteScroll';
import { useMarketplaceNotificationFeed } from '@/hooks/useMarketplaceNotificationFeed/useMarketplaceNotificationFeed';
import { useMarketplaceWatchAlertFeed } from '@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed';
import { useNotifications } from '@/hooks/useNotifications/useNotifications';
import { Logger } from '@/libs/logger/logger';
import { NotificationType } from '@/models/notification/notification.types';
import { NotificationsEmpty } from '@/molecules/NotificationsEmpty/NotificationsEmpty';
import type { MarketplaceNotification } from '@/services/marketplace/marketplace';
import { isIntegrityGapActivityType } from '@/services/marketplace/marketplace-activity-copy';
import { useAuthStore } from '@/stores/auth/auth.store';
import { NotificationsList } from '../NotificationsList/NotificationsList';
import {
  groupNotifications,
  mergeMarketplaceNotifications,
  mergeWatchAlerts,
} from '../NotificationsList/NotificationsList.utils';
import { NotificationsContainerSkeleton, NotificationsLoadMoreSkeleton } from './NotificationsContainer.skeleton';

/** Consecutive automatic loads allowed without the rendered list getting any longer. */
const MAX_UNPRODUCTIVE_AUTO_LOADS = 3;
/**
 * Exhaustive by construction: adding a `MarketplaceNotification['type']` fails
 * compilation here until it is classified into the Marketplace tab.
 */
const MARKETPLACE_TAB_NOTIFICATION_TYPES = {
  message_received: true,
  offer_received: true,
  offer_countered: true,
  offer_accepted: true,
  offer_rejected: true,
  outbid: true,
  auction_won: true,
  auction_ended: true,
  order_created: true,
  payment_method_bound: true,
  fiat_payment_reported: true,
  payment_confirmed: true,
  bitcoin_manual_review: true,
  bitcoin_payment_seen: true,
  bitcoin_prepare_voided: true,
  order_cancelled: true,
  order_cancelled_terms_change: true,
  order_shipped: true,
  order_delivery_assumed: true,
  order_delivered: true,
  order_completed: true,
  return_updated: true,
  refund_recorded: true,
  refund_destination_confirmed: true,
  review_received: true,
  pickup_details_updated: true,
  pickup_details_cleared: true,
  pickup_ready: true,
  payment_refund_required: true,
  drop_sold_out: true,
  payment_reversal_cancelled: true,
} as const satisfies Record<MarketplaceNotification['type'], true>;

const SOCIAL_TAB_NOTIFICATION_TYPES = {
  [NotificationType.Follow]: true,
  [NotificationType.NewFriend]: true,
  [NotificationType.TagPost]: true,
  [NotificationType.TagProfile]: true,
  [NotificationType.Reply]: true,
  [NotificationType.Repost]: true,
  [NotificationType.Mention]: true,
  [NotificationType.PostDeleted]: true,
  [NotificationType.PostEdited]: true,
} as const satisfies Record<NotificationType, true>;

export function isMarketplaceNotificationType(type: string): type is MarketplaceNotification['type'] {
  return Object.hasOwn(MARKETPLACE_TAB_NOTIFICATION_TYPES, type);
}

export function classifyGeneralNotificationTab(type: string): 'marketplace' | 'social' | 'unclassified' {
  if (isMarketplaceNotificationType(type)) return 'marketplace';
  if (Object.hasOwn(SOCIAL_TAB_NOTIFICATION_TYPES, type)) return 'social';
  return 'unclassified';
}

/**
 * Organism that handles all notification business logic:
 * - Fetching notifications via useNotifications
 * - Marking as read
 * - Infinite scroll pagination
 * - Loading/error/empty states
 */
export function NotificationsContainer() {
  const {
    notifications,
    unreadNotifications,
    isLoading,
    isLoadingMore,
    hasMore,
    error,
    loadMore,
    refresh,
    markAllAsRead,
  } = useNotifications();

  // Marketplace notifications from the transactional backend, interleaved by
  // timestamp so commerce activity shows up here instead of only on the
  // separate marketplace page. Empty when signed out or when no marketplace
  // backend is configured, leaving the social-only surface untouched.
  const marketplaceFeed = useMarketplaceNotificationFeed();

  // Device-local watchlist alerts — rows this device's own checks produced,
  // interleaved after the marketplace merge and visibly labeled as local
  // checks by their row component.
  const watchAlertFeed = useMarketplaceWatchAlertFeed();

  const socialEntries = groupNotifications(notifications);
  const allEntries = mergeWatchAlerts(
    mergeMarketplaceNotifications(socialEntries, marketplaceFeed.items, {
      hasMoreSocial: hasMore,
    }),
    watchAlertFeed.items,
    { hasMoreSocial: hasMore },
  );
  const unreadMarketplaceCount =
    marketplaceFeed.items.filter((item) => item.isUnread).length +
    watchAlertFeed.items.filter((item) => item.isUnseen).length;
  const unrecognizedMarketplaceCount = marketplaceFeed.items.filter(
    (item) => item.kind === 'unrecognized' && isIntegrityGapActivityType(item.type),
  ).length;

  // Grouping collapses many notifications into few rows, so a page can leave the scroll
  // sentinel on screen and immediately trigger the next one. A page that merges entirely
  // into existing groups adds no rows at all, which would loop to the end of the user's
  // history. The hook budgets the loads that fail to make the list longer, then hands
  // the decision back to the user via the manual button below.
  const { sentinelRef, isStalled, resumeAutoLoad } = useInfiniteScroll({
    onLoadMore: loadMore,
    hasMore,
    isLoading: isLoadingMore,
    itemCount: allEntries.length,
    maxUnproductiveLoads: MAX_UNPRODUCTIVE_AUTO_LOADS,
  });

  // Re-run once the session is restored, since the write needs an authenticated session.
  const isAuthenticated = useAuthStore((state) => state.session !== null);

  // Mark all notifications as read when entering the page (once authenticated), so the
  // tab counter shows 0 while viewing. Marketplace mark-read is sandbox-only (the
  // durable service stores no read state), which the controller enforces — in
  // transaction-service mode the call writes nothing and the marketplace badge
  // contribution is already 0.
  const markAllMarketplaceRead = marketplaceFeed.markAllRead;
  // Watch alerts live only on this device, so their read state is real and
  // clears here exactly like the social list's.
  const markAllWatchAlertsSeen = watchAlertFeed.markAllSeen;
  useEffect(() => {
    if (!isAuthenticated) return;
    markAllAsRead();
    void markAllMarketplaceRead();
    void markAllWatchAlertsSeen();
    // This surface shows the same commerce rows the marketplace Activity
    // page does, so seeing them here also advances the device-local activity
    // read checkpoint — the marketplace nav badge must not keep claiming
    // "new" for rows this device already displayed.
    CommerceController.markActivityRead().catch((error) => {
      Logger.warn('Failed to advance the activity read checkpoint', { error });
    });
  }, [markAllAsRead, markAllMarketplaceRead, markAllWatchAlertsSeen, isAuthenticated]);

  if (isLoading) {
    return <NotificationsContainerSkeleton />;
  }

  // A failure with nothing loaded yet is a dead end, so it owns the page. A failure
  // with rows on screen must not throw them away — it renders inline below the list.
  // Marketplace rows count as "on screen": a social fetch failure must not blank
  // out commerce activity that already rendered.
  if (error && allEntries.length === 0) {
    return (
      <Container overrideDefaults={true} className="flex flex-col items-center justify-center gap-4 py-12">
        <p className="text-muted-foreground">{error}</p>
        <Button variant={ButtonVariant.SECONDARY} type="button" onClick={refresh} data-cy="notifications-retry">
          {'Try again'}
        </Button>
      </Container>
    );
  }

  // Empty state — only when neither the social feed nor the marketplace feed
  // has anything to show.
  if (allEntries.length === 0) {
    return <NotificationsEmpty />;
  }

  const totalUnreadCount = unreadNotifications.length + unreadMarketplaceCount;

  return (
    <>
      <Heading level={5} size="lg" className="leading-normal font-light text-muted-foreground lg:hidden">
        Notifications {totalUnreadCount > 0 && `(${totalUnreadCount})`}
      </Heading>
      {unrecognizedMarketplaceCount > 0 && (
        <Container role="status" overrideDefaults={true} className="rounded-md border border-amber-500/40 p-4 text-sm">
          {unrecognizedMarketplaceCount} unrecognized marketplace event
          {unrecognizedMarketplaceCount === 1 ? '' : 's'} — history may be incomplete.
        </Container>
      )}
      <NotificationsList entries={allEntries} unreadNotifications={unreadNotifications} />

      {/* Infinite scroll sentinel - triggers loadMore when visible. Unmounted while an
          error shows so the observer cannot loop retries against a failing network;
          recovery goes through the Try again button instead. */}
      {!error && <div ref={sentinelRef} className="h-10" data-cy="notifications-sentinel" />}

      {error && (
        <Container overrideDefaults={true} className="flex flex-col items-center gap-2 py-4">
          <p className="text-muted-foreground">{error}</p>
          <Button variant={ButtonVariant.SECONDARY} type="button" onClick={refresh} data-cy="notifications-retry">
            {'Try again'}
          </Button>
        </Container>
      )}

      {isLoadingMore && <NotificationsLoadMoreSkeleton />}

      {hasMore && isStalled && !isLoadingMore && (
        <Container overrideDefaults={true} className="flex justify-center py-2">
          <Button
            variant={ButtonVariant.SECONDARY}
            type="button"
            onClick={resumeAutoLoad}
            data-cy="notifications-load-more"
          >
            {'Load more'}
          </Button>
        </Container>
      )}
    </>
  );
}
