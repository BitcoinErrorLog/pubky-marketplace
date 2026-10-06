'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, Gavel, type LucideIcon, Tag, Timer } from 'lucide-react';
import { Container } from '@/atoms/Container/Container';
import { Typography } from '@/atoms/Typography/Typography';
import { useRelativeTime } from '@/hooks/useRelativeTime/useRelativeTime';
import { RelativeTimestamp } from '@/molecules/RelativeTimestamp/RelativeTimestamp';
import type { MarketplaceWatchAlertFeedItem } from '@/pipes/marketplaceWatch/marketplaceWatchAlert.types';
import { getWatchAlertDetail, getWatchAlertHeadline } from './MarketplaceWatchAlertItem.utils';

/** Same dimensions as the social NotificationIcon so mixed rows align. */
const ICON_SIZE = 24;
const BADGE_SIZE = 11;

interface MarketplaceWatchAlertItemProps {
  item: MarketplaceWatchAlertFeedItem;
  isMobile?: boolean;
}

/**
 * A device-local watch alert row inside the general notification list.
 * Deliberately NOT dressed as a server event: there is no actor (nobody sent
 * this), the leading mark is a watchlist icon instead of an avatar, and the
 * row says "Watchlist · checked on this device" so the origin — a check this
 * device ran against real reads — is visible at a glance.
 */
export function MarketplaceWatchAlertItem({ item, isMobile = false }: MarketplaceWatchAlertItemProps) {
  const router = useRouter();
  const { formatRelativeTime } = useRelativeTime();
  const timestampDate = new Date(item.timestamp);
  const detail = getWatchAlertDetail(item);

  const handleRowClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button')) return;
    router.push(item.href);
  };

  return (
    <Container
      overrideDefaults={true}
      className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-2"
      onClick={handleRowClick}
      data-cy="marketplace-watch-alert-item"
    >
      <Container overrideDefaults={true} className="flex min-w-0 flex-1 items-center gap-2">
        <Container
          overrideDefaults={true}
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand lg:size-8"
        >
          <Eye className="size-4" />
        </Container>

        <Container overrideDefaults={true} className="min-w-0 flex-1">
          <Typography
            as="p"
            className="min-w-0 truncate text-sm leading-normal font-medium text-foreground lg:text-base"
          >
            <Link href={item.href} className="text-foreground hover:underline">
              {getWatchAlertHeadline(item)}: {item.title}
            </Link>
          </Typography>
          <Typography as="p" className="truncate text-xs text-muted-foreground">
            {detail ? `${detail} · ` : ''}Watchlist · checked on this device
          </Typography>
        </Container>
      </Container>

      <Link href={item.href} className="flex shrink-0 items-center gap-2 transition-opacity hover:opacity-80">
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
          <WatchAlertKindIcon kind={item.kind} />
          {item.isUnseen && (
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

function WatchAlertKindIcon({ kind }: { kind: MarketplaceWatchAlertFeedItem['kind'] }) {
  const Icon: LucideIcon = kind === 'ending_soon' ? Timer : kind === 'new_bid' || kind === 'outbid' ? Gavel : Tag;
  return <Icon className="text-foreground" size={ICON_SIZE} />;
}
