'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Gavel, HandCoins, type LucideIcon, MessageCircle } from 'lucide-react';
import { Container } from '@/atoms/Container/Container';
import { useRelativeTime } from '@/hooks/useRelativeTime/useRelativeTime';
import { useUserProfile } from '@/hooks/useUserProfile/useUserProfile';
import {
  NotificationActorAvatar,
  NotificationActorHeading,
} from '@/molecules/NotificationRowChrome/NotificationRowChrome';
import { RelativeTimestamp } from '@/molecules/RelativeTimestamp/RelativeTimestamp';
import { getUserProfileLink } from '@/organisms/NotificationItem/NotificationItem.utils';
import type { MarketplaceFeedNotification } from '@/pipes/marketplaceNotification/marketplaceNotification.types';
import { isIntegrityGapActivityType, marketplaceActivityLabel } from '@/services/marketplace/marketplace-activity-copy';
import { getMarketplaceNotificationActionText } from './MarketplaceNotificationItem.utils';

/** Same dimensions as the social NotificationIcon so mixed rows align. */
const ICON_SIZE = 24;
const BADGE_SIZE = 11;

interface MarketplaceNotificationItemProps {
  notification: MarketplaceFeedNotification;
  isMobile?: boolean;
}

/**
 * A marketplace notification row inside the general notification list,
 * sharing the social rows' chrome (actor avatar, "<username> <action>"
 * heading, timestamp + icon cluster). The row renders nothing beyond the
 * redacted feed shape: an actor, an action phrase derived from the type, and
 * a deep link to the marketplace surface that shows the aggregate.
 */
export function MarketplaceNotificationItem({ notification, isMobile = false }: MarketplaceNotificationItemProps) {
  const router = useRouter();
  const { formatRelativeTime } = useRelativeTime();
  const actorPubky = 'kind' in notification ? '' : notification.actorPubky;

  // Marketplace actors are pubky users, so the same profile lookup the
  // social rows use resolves their display name and avatar.
  const { profile } = useUserProfile(actorPubky);

  if ('kind' in notification) {
    const label = marketplaceActivityLabel(notification.type);
    if (label && !isIntegrityGapActivityType(notification.type)) {
      return (
        <Container
          overrideDefaults={true}
          className="flex w-full min-w-0 items-center gap-3 rounded-md p-3"
          data-cy="marketplace-known-activity"
        >
          <Container overrideDefaults={true} className="size-6 shrink-0 rounded-full bg-brand/15" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{label}</p>
          </div>
        </Container>
      );
    }
    return (
      <Container
        overrideDefaults={true}
        className="flex w-full min-w-0 items-center gap-3 rounded-md border border-amber-500/40 p-3"
        data-cy="marketplace-unrecognized-notification"
      >
        <Container overrideDefaults={true} className="size-6 shrink-0 rounded-full bg-amber-500/15" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Unrecognized marketplace event</p>
          <p className="text-sm text-muted-foreground">History may be incomplete.</p>
        </div>
        <span className="shrink-0 text-xs font-medium tracking-widest text-muted-foreground">Integrity notice</span>
      </Container>
    );
  }

  const userName =
    notification.actorPubky === 'system'
      ? 'System'
      : notification.actorPubky === 'paypal-ipn'
        ? 'PayPal'
        : profile?.name || 'User';
  const userProfileLink =
    notification.actorPubky === 'system' || notification.actorPubky === 'paypal-ipn'
      ? null
      : getUserProfileLink(notification.actorPubky);
  const actionText = getMarketplaceNotificationActionText(notification);
  const timestampDate = new Date(notification.timestamp);

  const handleRowClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button')) return;
    router.push(notification.href);
  };

  return (
    <Container
      overrideDefaults={true}
      className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-2"
      onClick={handleRowClick}
      data-cy="marketplace-notification-item"
    >
      <Container overrideDefaults={true} className="flex min-w-0 flex-1 items-center gap-2">
        <NotificationActorAvatar
          avatarUrl={profile?.avatarUrl}
          userName={userName}
          fallbackSeed={notification.actorPubky}
          userProfileLink={userProfileLink}
        />

        <NotificationActorHeading
          userName={userName}
          userProfileLink={userProfileLink}
          actionText={actionText}
          actionLink={notification.href}
        />
      </Container>

      <Link href={notification.href} className="flex shrink-0 items-center gap-2 transition-opacity hover:opacity-80">
        <RelativeTimestamp
          timeAgo={formatRelativeTime(timestampDate)}
          date={timestampDate}
          isMobile={isMobile}
          className="text-xs font-medium tracking-widest text-muted-foreground"
        />
        <Container
          overrideDefaults={true}
          className="relative shrink-0"
          style={{ width: ICON_SIZE, height: ICON_SIZE }}
        >
          <MarketplaceNotificationTypeIcon type={notification.type} />
          {notification.isUnread && (
            <Container
              data-cy="notification-unread-dot"
              overrideDefaults={true}
              className="absolute right-0 bottom-0 rounded-full bg-brand"
              style={{ width: BADGE_SIZE, height: BADGE_SIZE }}
            />
          )}
        </Container>
      </Link>
    </Container>
  );
}

/** Mirrors the marketplace notifications page's icon buckets. */
function MarketplaceNotificationTypeIcon({ type }: { type: MarketplaceFeedNotification['type'] }) {
  const Icon: LucideIcon =
    type === 'message_received'
      ? MessageCircle
      : type === 'outbid' || type === 'auction_won' || type === 'auction_ended'
        ? Gavel
        : HandCoins;
  return <Icon className="text-foreground" size={ICON_SIZE} />;
}
