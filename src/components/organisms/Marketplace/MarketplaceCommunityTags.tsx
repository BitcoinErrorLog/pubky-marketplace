'use client';

import { useMemo } from 'react';
import { Tags } from 'lucide-react';
import { TagKind } from '@/application/tag/tag.types';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Typography } from '@/atoms/Typography/Typography';
import { type MarketplaceTagTarget, useMarketplaceTags } from '@/hooks/useMarketplaceTags/useMarketplaceTags';
import { ClickableTagsList } from '@/organisms/ClickableTagsList/ClickableTagsList';

export interface MarketplaceCommunityTagsProps {
  target: MarketplaceTagTarget;
  /**
   * `card` (default) renders the labeled section with its explainer.
   * `inline` renders only the feed-style tag row, for embedding in an
   * existing line (e.g. the shop header's location row).
   */
  variant?: 'card' | 'inline' | 'info-card';
}

/**
 * Community tag row for a marketplace listing or shop — the SAME visual
 * component the feed uses on posts (`ClickableTagsList`: horizontal pills
 * with tagger counts, character-budgeted display limiting, and the compact
 * add button that expands into an input). Only the data source differs:
 * marketplace tags are real `PubkyAppTag` records targeting the canonical
 * listing/shop URI, supplied through `useMarketplaceTags` instead of the
 * post/user tag stores (the enriched taggers are flattened back to pubkys —
 * `ClickableTagsList` re-enriches internally).
 *
 * Read honesty: the viewer's own tags render immediately from the local
 * write-through; aggregates from other users appear only once the marketplace
 * Nexus serves tag aggregation for these targets — never fabricated counts.
 *
 * This is the community layer, deliberately separate from the seller-declared
 * keywords in the listing record (`record.tags`), which stay labeled as the
 * seller's own metadata.
 */
export function MarketplaceCommunityTags({ target, variant = 'card' }: MarketplaceCommunityTagsProps) {
  const { tags, handleTagAdd, handleTagToggle } = useMarketplaceTags(target);
  const taggedId = target.kind === TagKind.LISTING ? `${target.sellerPubky}:${target.listingId}` : target.ownerPubky;

  const nexusTags = useMemo(
    () => tags.map((tag) => ({ ...tag, taggers: tag.taggers.map((tagger) => tagger.id) })),
    [tags],
  );

  const row = (
    <ClickableTagsList
      taggedId={taggedId}
      taggedKind={target.kind}
      tags={nexusTags}
      showCount
      showAddButton
      addMode
      onTagClick={(tag) => void handleTagToggle(tag)}
      onTagAdd={(label) => void handleTagAdd(label)}
    />
  );

  if (variant === 'info-card') {
    return (
      <div
        data-cy="marketplace-community-tags"
        className="marketplace-item-details flex min-w-0 items-start gap-3 rounded-xl bg-card p-5 text-card-foreground shadow-sm sm:col-span-2"
      >
        <Tags className="size-5 shrink-0 text-brand" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Heading level={2} size="sm" className="text-sm leading-5 font-semibold">
            Community tags
          </Heading>
          <Typography as="p" overrideDefaults className="text-sm leading-5 font-medium text-muted-foreground">
            {tags.length > 0 ? 'Tagged by anyone on Pubky' : 'No tags yet'}
          </Typography>
          <div className="mt-2">{row}</div>
        </div>
      </div>
    );
  }

  if (variant === 'inline') {
    return (
      <Container
        overrideDefaults
        data-cy="marketplace-community-tags"
        title="Community tags — added by anyone on Pubky, separate from the seller's own keywords."
        className="flex flex-wrap items-center gap-2"
      >
        {row}
      </Container>
    );
  }

  return (
    <Container overrideDefaults data-cy="marketplace-community-tags" className="flex w-full flex-col gap-2">
      <Heading level={2} size="lg" className="font-medium text-muted-foreground">
        Community tags
      </Heading>
      <Typography as="p" overrideDefaults className="text-xs text-muted-foreground">
        {tags.length > 0 ? 'Tagged by anyone on Pubky' : 'No tags yet'}
      </Typography>
      {row}
    </Container>
  );
}
