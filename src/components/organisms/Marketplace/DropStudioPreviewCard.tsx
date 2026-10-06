'use client';

import { useState } from 'react';
import { Clock3 } from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Typography } from '@/atoms/Typography/Typography';
import { useDropStudioCountdown } from '@/hooks/useDropStudio/useDropStudioCountdown';
import { useMarketplaceMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';

export interface DropStudioPreviewCardProps {
  title: string;
  description: string;
  /** First teaser media URI (pubky:// or http), or null for the gradient fallback. */
  mediaUri: string | null;
  startsAtIso: string;
  endsAtIso: string | null;
  listingCount: number;
}

/**
 * The composer's preview-as-shopper rendering of the ANNOUNCED-state drop
 * card, prominently labeled PREVIEW: there is no service aggregate yet, so
 * the countdown runs from the seller's stated schedule on the device clock
 * (offset 0) and claims nothing authoritative — exactly what a shopper would
 * see between announcement and the service's first projection.
 */
export function DropStudioPreviewCard({
  title,
  description,
  mediaUri,
  startsAtIso,
  endsAtIso,
  listingCount,
}: DropStudioPreviewCardProps) {
  const countdown = useDropStudioCountdown(startsAtIso, endsAtIso, 0);
  const [mediaFailed, setMediaFailed] = useState(false);
  const mediaUrl = useMarketplaceMediaUrl(mediaUri);
  const showMedia = mediaUrl !== null && !mediaFailed;

  return (
    <Card className="overflow-hidden border-dashed py-0" aria-label="Preview of the announced drop card">
      <div className="relative aspect-[2/1] w-full bg-gradient-to-br from-brand/25 via-muted to-background">
        {showMedia && (
          // eslint-disable-next-line @next/next/no-img-element -- teaser media comes from arbitrary homeservers; next/image cannot optimize them.
          <img
            src={mediaUrl}
            alt=""
            className="size-full object-cover object-center"
            onError={() => setMediaFailed(true)}
          />
        )}
        <Badge className="absolute top-3 left-3 bg-background/90 text-foreground">PREVIEW</Badge>
        <Badge variant="secondary" className="absolute top-3 right-3">
          Upcoming drop
        </Badge>
      </div>
      <CardContent className="flex flex-col gap-2 px-5 py-4">
        <Typography as="p" className="text-lg font-semibold">
          {title.trim() === '' ? 'Untitled drop' : title}
        </Typography>
        {description.trim() !== '' && (
          <Typography as="p" className="line-clamp-2 text-sm text-muted-foreground">
            {description}
          </Typography>
        )}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1.5 font-mono tabular-nums motion-reduce:transition-none">
            <Clock3 className="size-4 text-brand" aria-hidden />
            <span aria-hidden>
              {countdown.reading.phase === 'before_start' ? `Starts in ${countdown.label}` : 'Launch time has passed'}
            </span>
          </span>
          <Typography as="span" className="text-sm text-muted-foreground">
            {listingCount === 1 ? '1 listing' : `${listingCount} listings`}
          </Typography>
        </div>
        <span aria-live="polite" className="sr-only">
          {countdown.reading.phase === 'before_start'
            ? `Preview countdown: starts in ${countdown.announcedLabel}`
            : 'Preview countdown: launch time has passed'}
        </span>
        <Typography as="p" className="text-xs text-muted-foreground">
          Estimated from your device clock — once published, shoppers see a countdown corrected to the transaction
          service&apos;s clock, and &ldquo;live&rdquo; only ever comes from the service.
        </Typography>
      </CardContent>
    </Card>
  );
}
