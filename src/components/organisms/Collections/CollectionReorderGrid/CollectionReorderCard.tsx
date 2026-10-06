'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useLiveQuery } from 'dexie-react-hooks';
import { PackageX } from 'lucide-react';
import { Card } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import { catalogItemFromListingModel } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { type ListingUriRef, parseListingUri } from '@/libs/commerce/listingUri';
import { cn } from '@/libs/utils/utils';
import { PostUnavailable } from '@/molecules/PostUnavailable/PostUnavailable';
import { MarketplaceListingCard } from '@/organisms/Marketplace/MarketplaceListingCard';
import { PostMain } from '@/organisms/PostMain/PostMain';
import type { CollectionReorderCardProps } from './CollectionReorderGrid.types';

/**
 * Reorder cell for a marketplace listing item: renders the listing card from
 * the local commerce cache (warmed by `CollectionListingItems` on the page
 * below), or an explicit unavailable placeholder — never a fake post cell.
 */
function ReorderListingCell({ listingRef }: { listingRef: ListingUriRef }) {
  const cached = useLiveQuery(
    () => CommerceController.getListing(listingRef.sellerPubky, listingRef.listingId),
    [listingRef.sellerPubky, listingRef.listingId],
  );

  if (cached) {
    return <MarketplaceListingCard listing={catalogItemFromListingModel(cached)} />;
  }

  return (
    <Card className="min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-md py-6">
      <PackageX className="size-6 text-muted-foreground" />
      <Typography as="p" overrideDefaults className="text-sm text-muted-foreground">
        Marketplace listing
      </Typography>
    </Card>
  );
}

/**
 * CollectionReorderCard
 *
 * One sortable cell of the reorder grid. The OUTER container is the entire
 * drag surface (dnd-kit's `attributes` make it a focusable button with
 * screen-reader drag instructions); the INNER wrapper is `inert` +
 * `pointer-events-none` so nothing inside the post card — reply, repost, tags,
 * remove-from-collection — is reachable while reordering.
 *
 * Cell markup mirrors `TimelineGridPosts` (`@container/grid`,
 * `[&>*:first-child]:flex-1`) plus the design's white dashed border. Deleted /
 * missing posts render through `PostMain`'s own `PostDeleted` / `PostMissing`
 * branches and stay draggable; entries whose URI cannot be converted to a
 * composite post id fall back to a bare `PostMissing` card so they keep their
 * slot in the draft.
 */
export function CollectionReorderCard({ entry, disabled = false }: CollectionReorderCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.uri,
    disabled,
  });
  const listingRef = entry.postId ? null : parseListingUri(entry.uri);

  return (
    <Container
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-cy="collection-reorder-card"
      // Translate (not Transform): the full transform includes scaleX/scaleY
      // that stretch the dragged card to the hovered slot's dimensions, which
      // distorts the preview when rows have different heights.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        '@container/grid rounded-md border border-dashed border-foreground/60',
        'cursor-grab touch-manipulation outline-none select-none focus-visible:ring-2 focus-visible:ring-ring',
        '[&>*:first-child]:flex-1',
        isDragging && 'relative z-10 cursor-grabbing opacity-80',
        disabled && 'cursor-default opacity-60',
      )}
    >
      <Container inert overrideDefaults className="pointer-events-none flex min-w-0 flex-col [&>*:first-child]:flex-1">
        {entry.postId ? (
          <PostMain postId={entry.postId} isReply={false} isNavigable={false} />
        ) : listingRef ? (
          <ReorderListingCell listingRef={listingRef} />
        ) : (
          <Card className="min-w-0 flex-1 justify-center gap-0 rounded-md py-2">
            <PostUnavailable message={'Post not found.'} />
          </Card>
        )}
      </Container>
    </Container>
  );
}
