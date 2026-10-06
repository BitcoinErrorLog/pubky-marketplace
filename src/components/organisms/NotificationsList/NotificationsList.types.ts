import type { FlatNotification, NotificationType } from '@/models/notification/notification.types';
import type { MarketplaceFeedNotification } from '@/pipes/marketplaceNotification/marketplaceNotification.types';
import type { MarketplaceWatchAlertFeedItem } from '@/pipes/marketplaceWatch/marketplaceWatchAlert.types';

/** Notification types whose repeats collapse into a grouped row. */
export type GroupableNotificationType = NotificationType.PostDeleted | NotificationType.PostEdited;

export type GroupableNotification = Extract<FlatNotification, { type: GroupableNotificationType }>;

/**
 * One rendered row: a lone social notification, a run of consecutive ones that share a
 * type, an actor and a post kind, a marketplace notification interleaved by
 * timestamp, or a device-local watchlist alert (visibly labeled as a local
 * check, never as a server event). Grouped runs hold at least
 * MIN_NOTIFICATION_GROUP_SIZE members, newest first (mirroring the source order).
 */
export type NotificationListEntry =
  | { kind: 'single'; notification: FlatNotification }
  | { kind: 'group'; notifications: GroupableNotification[] }
  | { kind: 'marketplace'; notification: MarketplaceFeedNotification }
  | { kind: 'watch-alert'; item: MarketplaceWatchAlertFeedItem };

export interface NotificationsListProps {
  /** Rows to display, already grouped by `groupNotifications`. */
  entries: NotificationListEntry[];
  /** Used to decide which rows show the unread badge. */
  unreadNotifications: FlatNotification[];
}
