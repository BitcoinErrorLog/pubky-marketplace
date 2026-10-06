'use client';

import { type CSSProperties, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { getMarketplaceDropRoute } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Image } from '@/atoms/Image/Image';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import type { DropStreamBucket, NexusDropStreamEntry } from '@/hooks/useMarketplaceDrops/drops-stream';
import { useMarketplaceFirstMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { cn } from '@/libs/utils/utils';
import type { CommerceLayout } from '@/stores/commerce/commerce.types';
import { DropCountdown } from './DropCountdown';

const BUCKET_BADGES: Record<DropStreamBucket, string> = {
  upcoming: 'Upcoming',
  live: 'Start time passed',
  ended: 'End time passed',
};

/**
 * One indexed drop on the shelf/calendar (drops design, "Discovery and hype
 * surfaces"). Everything here is INDEX data: the state chip and the
 * countdown are labeled estimates, and no claim affordance ever renders
 * from a card — opening the page hydrates the authoritative service
 * projection first.
 */
export function DropCard({
  entry,
  bucket,
  layout = 'grid',
  index = 0,
  shopName,
}: {
  entry: NexusDropStreamEntry;
  bucket: DropStreamBucket;
  layout?: CommerceLayout;
  index?: number;
  shopName?: string;
}) {
  const [mediaFailed, setMediaFailed] = useState(false);
  const [hoverRotation, setHoverRotation] = useState(0);
  const mediaUrl = useMarketplaceFirstMediaUrl(entry.media_urls);
  return (
    <Link
      href={getMarketplaceDropRoute(entry.owner_id, entry.id)}
      prefetch={false}
      overrideDefaults
      className="marketplace-card-enter group relative block rounded-xl transition-transform duration-300 ease-out outline-none hover:z-10 hover:scale-105 hover:rotate-(--card-hover-rotation) focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none motion-reduce:transition-none"
      style={
        {
          '--card-hover-rotation': `${hoverRotation}deg`,
          '--marketplace-card-index': index,
        } as CSSProperties
      }
      onMouseEnter={() => setHoverRotation(Math.random() * 14 - 7)}
      aria-label={`View ${entry.title}`}
    >
      <Card
        className={cn(
          'h-full gap-0 overflow-hidden border-0 py-0 transition-all group-hover:shadow-[0_24px_64px_-8px_rgba(0,0,0,0.8),0_8px_24px_rgba(0,0,0,0.5)]',
          layout === 'list' && 'flex-row',
        )}
      >
        <div
          className={cn(
            'relative flex aspect-square items-center justify-center overflow-hidden bg-linear-to-br from-brand/45 via-purple-500/20 to-background',
            layout === 'list' && 'aspect-square w-36 shrink-0 sm:w-48',
          )}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,rgba(255,255,255,0.16),transparent_32%)]" />
          <CalendarClock className="size-16 text-white opacity-80" aria-hidden="true" />
          {mediaUrl && !mediaFailed && (
            <Image
              src={mediaUrl}
              alt={entry.title}
              fill
              sizes="(max-width: 640px) 50vw, 300px"
              className="absolute inset-0 object-cover object-center transition-transform duration-300 ease-out motion-safe:group-hover:scale-120 motion-reduce:transition-none"
              onError={() => setMediaFailed(true)}
            />
          )}
          <Badge className="absolute top-3 left-3 gap-1 bg-background/85 text-foreground shadow-sm backdrop-blur-md">
            <CalendarClock aria-hidden="true" className="size-3" />
            Drop
          </Badge>
          <Badge className="absolute right-3 bottom-3 bg-background/85 text-foreground shadow-sm backdrop-blur-md">
            {BUCKET_BADGES[bucket]}
          </Badge>
        </div>
        <CardContent className="flex min-w-0 flex-1 flex-col gap-3 p-4">
          <div className="space-y-1">
            <Typography as="h2" className="line-clamp-2 text-base leading-6 font-bold text-foreground">
              {entry.title}
            </Typography>
          </div>
          <div className="space-y-1">
            <Typography as="p" className="truncate text-base text-secondary-foreground">
              {shopName ?? `${entry.owner_id.slice(0, 8)}…`}
            </Typography>
          </div>
          {bucket === 'upcoming' && (
            <DropCountdown
              startsAt={entry.starts_at}
              endsAt={entry.ends_at ?? null}
              clockOffsetMs={null}
              phaseLabel="Starts in (estimate)"
              compact
            />
          )}
          <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
            <Typography as="span" className="text-xs text-secondary-foreground">
              View drop
            </Typography>
            {entry.total_quantity != null && (
              <Badge variant="secondary" className="ml-auto shrink-0">
                {entry.total_quantity} {entry.total_quantity === 1 ? 'edition' : 'editions'}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
