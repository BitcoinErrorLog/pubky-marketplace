'use client';

import { useState } from 'react';
import { Film, Gavel, PackageCheck } from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { Image } from '@/atoms/Image/Image';
import { useMarketplaceMediaUrls } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import type { AuctionPhase } from '@/libs/commerce/auction-phase';
import type { CommerceListingRecord } from '@/libs/commerce/marketplace-records';
import { cn } from '@/libs/utils/utils';

export interface MarketplaceMediaGalleryProps {
  media: CommerceListingRecord['media'];
  saleFormat: CommerceListingRecord['sale']['format'];
  auctionPhase?: AuctionPhase;
}

/**
 * The listing detail page's media area: a main viewer plus a thumbnail strip
 * when the record carries more than one viewable media item.
 *
 * Photos crop to fill the reserved frame (`object-cover` / `object-center`).
 * There is no lightbox on this surface; contain would letterbox portrait
 * shots against the page background. A per-image focal point can later
 * replace the centered `object-position` without changing the frame.
 *
 * Media URIs come from the owner-signed record (`record.media[].url`,
 * `pubky://.../marketplace/v1/media/<id>`) and resolve to the homeserver's
 * public HTTPS read URL via `resolveMarketplaceMediaUrl`. Items that do not
 * resolve or fail to load are dropped from the strip rather than rendered as
 * broken images; when nothing remains viewable the gallery honestly falls
 * back to the same gradient+icon hero that media-less rendering always used.
 */
export function MarketplaceMediaGallery({ media, saleFormat, auctionPhase = 'live' }: MarketplaceMediaGalleryProps) {
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const urls = useMarketplaceMediaUrls(media.map(({ url }) => url));

  const viewable = media
    .map((item, index) => ({ item, url: urls[index] }))
    .filter((entry): entry is { item: (typeof media)[number]; url: string } => {
      return entry.url !== null && !failedIds.has(entry.item.id);
    });

  const selected = viewable.find(({ item }) => item.id === selectedId) ?? viewable[0];

  const markFailed = (id: string) => {
    setFailedIds((previous) => new Set(previous).add(id));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex h-[min(28svh,240px)] min-h-48 items-center justify-center overflow-hidden rounded-2xl bg-linear-to-br from-brand/35 via-purple-500/15 to-card sm:h-[440px] lg:h-[600px]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,rgba(255,255,255,0.18),transparent_32%)]" />
        {selected ? (
          selected.item.type === 'video' ? (
            <video
              key={selected.item.id}
              src={selected.url}
              controls
              playsInline
              aria-label={selected.item.altText}
              className="absolute inset-0 size-full object-cover object-center"
              onError={() => markFailed(selected.item.id)}
            />
          ) : (
            <Image
              key={selected.item.id}
              src={selected.url}
              alt={selected.item.altText}
              fill
              sizes="(max-width: 1024px) 100vw, 720px"
              className="absolute inset-0 size-full object-cover object-center"
              onError={() => markFailed(selected.item.id)}
            />
          )
        ) : saleFormat === 'auction' ? (
          <Gavel className="size-32 text-foreground/75 drop-shadow-2xl" />
        ) : (
          <PackageCheck className="size-32 text-foreground/75 drop-shadow-2xl" />
        )}
        <Badge className="absolute top-4 left-4 bg-background/85 text-foreground backdrop-blur-md">
          {saleFormat === 'auction' ? (auctionPhase === 'ended' ? 'Auction ended' : 'Live auction') : 'Buy now'}
        </Badge>
      </div>

      {viewable.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Listing media">
          {viewable.map(({ item, url }) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedId(item.id)}
              aria-label={`Show ${item.altText}`}
              aria-pressed={selected?.item.id === item.id}
              className={cn(
                'relative size-16 cursor-pointer overflow-hidden rounded-lg border transition-colors',
                selected?.item.id === item.id ? 'border-brand' : 'border-border/60 hover:border-brand/50',
              )}
            >
              {item.type === 'video' ? (
                <span className="flex size-full items-center justify-center bg-card">
                  <Film aria-hidden="true" className="size-6 text-foreground/75" />
                </span>
              ) : (
                <Image
                  src={url}
                  alt={item.altText}
                  fill
                  sizes="64px"
                  className="object-cover object-center"
                  onError={() => markFailed(item.id)}
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
