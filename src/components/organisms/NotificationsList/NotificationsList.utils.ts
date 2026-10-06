import { type FlatNotification, NotificationType } from '@/models/notification/notification.types';
import {
  getNotificationKindBucket,
  getUserIdFromNotification,
} from '@/organisms/NotificationItem/NotificationItem.utils';
import type { MarketplaceFeedNotification } from '@/pipes/marketplaceNotification/marketplaceNotification.types';
import type { MarketplaceWatchAlertFeedItem } from '@/pipes/marketplaceWatch/marketplaceWatchAlert.types';
import type { GroupableNotification, NotificationListEntry } from './NotificationsList.types';

/** A run shorter than this renders as ungrouped NotificationItem rows. */
const MIN_NOTIFICATION_GROUP_SIZE = 2;

/** Deleted and edited notifications arrive one per affected post, so bursts flood the list. */
function isGroupable(notification: FlatNotification): notification is GroupableNotification {
  return notification.type === NotificationType.PostDeleted || notification.type === NotificationType.PostEdited;
}

/**
 * Whether `notification` continues the run headed by `head`.
 *
 * Kept separate from the walk below so the rule can change — a time window, say — without
 * touching the traversal.
 */
function continuesRun(head: GroupableNotification, notification: GroupableNotification): boolean {
  return (
    head.type === notification.type &&
    getUserIdFromNotification(head) === getUserIdFromNotification(notification) &&
    getNotificationKindBucket(head) === getNotificationKindBucket(notification)
  );
}

/**
 * URI of the post whose change the notification reports — the identity repeated
 * notifications about the same post share.
 */
function getChangedPostUri(notification: GroupableNotification): string {
  return notification.type === NotificationType.PostDeleted ? notification.deleted_uri : notification.edited_uri;
}

/**
 * Collapses consecutive runs of deleted/edited notifications that share an actor and a
 * post kind into single rows.
 *
 * Within a run, repeats about the same post (the same post edited several times, or one
 * deletion reported once per interaction) keep only their newest occurrence, so the row
 * count and the title list reflect distinct posts. Order is otherwise preserved, and runs
 * shorter than MIN_NOTIFICATION_GROUP_SIZE come back as individual `single` entries.
 */
export function groupNotifications(notifications: FlatNotification[]): NotificationListEntry[] {
  const entries: NotificationListEntry[] = [];
  let run: GroupableNotification[] = [];
  let runPostUris = new Set<string>();

  const flush = () => {
    if (run.length >= MIN_NOTIFICATION_GROUP_SIZE) {
      entries.push({ kind: 'group', notifications: run });
    } else {
      entries.push(...run.map((notification) => ({ kind: 'single' as const, notification })));
    }
    run = [];
    runPostUris = new Set();
  };

  for (const notification of notifications) {
    if (!isGroupable(notification)) {
      flush();
      entries.push({ kind: 'single', notification });
      continue;
    }

    if (run.length > 0 && !continuesRun(run[0], notification)) flush();

    // The list is newest-first, so the occurrence already in the run is the newer one.
    const postUri = getChangedPostUri(notification);
    if (runPostUris.has(postUri)) continue;
    runPostUris.add(postUri);

    run.push(notification);
  }

  flush();

  return entries;
}

/** Timestamp a row sorts by: the head (newest) member for grouped runs. */
function getEntryTimestamp(entry: NotificationListEntry): number {
  if (entry.kind === 'group') return entry.notifications[0].timestamp;
  if (entry.kind === 'watch-alert') return entry.item.timestamp;
  return entry.notification.timestamp;
}

/**
 * Interleaves marketplace notifications into the grouped social entries by
 * timestamp, newest first.
 *
 * The social list paginates by timestamp cursor while the marketplace feed
 * arrives whole, so while older social pages remain unloaded
 * (`hasMoreSocial`), marketplace rows older than the oldest loaded social
 * row are withheld — otherwise they would pin to the bottom of the list and
 * then jump upward as each social page loads under them. They surface in
 * order once pagination reaches their timestamps or the social history is
 * exhausted. An empty social list shows every marketplace row: there is no
 * cursor to respect.
 */
export function mergeMarketplaceNotifications(
  socialEntries: NotificationListEntry[],
  marketplaceItems: MarketplaceFeedNotification[],
  { hasMoreSocial }: { hasMoreSocial: boolean },
): NotificationListEntry[] {
  return interleaveEntries(
    socialEntries,
    marketplaceItems,
    (item) => ({ kind: 'marketplace', notification: item }),
    hasMoreSocial,
  );
}

/**
 * Interleaves device-local watchlist alerts by timestamp, under the same
 * withholding rule as {@link mergeMarketplaceNotifications} (the alert store
 * also arrives whole while social pages load incrementally). Runs after the
 * marketplace merge, so `entries` may already contain marketplace rows.
 */
export function mergeWatchAlerts(
  entries: NotificationListEntry[],
  alertItems: MarketplaceWatchAlertFeedItem[],
  { hasMoreSocial }: { hasMoreSocial: boolean },
): NotificationListEntry[] {
  return interleaveEntries(entries, alertItems, (item) => ({ kind: 'watch-alert', item }), hasMoreSocial);
}

function interleaveEntries<T extends { timestamp: number }>(
  entries: NotificationListEntry[],
  items: T[],
  toEntry: (item: T) => NotificationListEntry,
  hasMoreOlderEntries: boolean,
): NotificationListEntry[] {
  if (items.length === 0) return entries;

  const sortedItems = [...items].sort((a, b) => b.timestamp - a.timestamp);
  const oldestEntryTimestamp = entries.length > 0 ? getEntryTimestamp(entries[entries.length - 1]) : undefined;
  const visibleItems =
    hasMoreOlderEntries && oldestEntryTimestamp !== undefined
      ? sortedItems.filter((item) => item.timestamp >= oldestEntryTimestamp)
      : sortedItems;

  const merged: NotificationListEntry[] = [];
  let itemIndex = 0;
  for (const entry of entries) {
    const entryTimestamp = getEntryTimestamp(entry);
    while (itemIndex < visibleItems.length && visibleItems[itemIndex].timestamp > entryTimestamp) {
      merged.push(toEntry(visibleItems[itemIndex]));
      itemIndex += 1;
    }
    merged.push(entry);
  }
  while (itemIndex < visibleItems.length) {
    merged.push(toEntry(visibleItems[itemIndex]));
    itemIndex += 1;
  }
  return merged;
}
