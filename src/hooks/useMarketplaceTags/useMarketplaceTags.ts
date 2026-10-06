'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { TagKind } from '@/application/tag/tag.types';
import { CommerceController } from '@/controllers/commerce/commerce';
import { TagController } from '@/controllers/tag/tag';
import type { TagWithAvatars } from '@/molecules/TaggedItem/TaggedItem.types';
import { transformTagsForViewer } from '@/molecules/TaggedItem/TaggedItem.utils';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';

export type MarketplaceTagTarget =
  | { kind: TagKind.LISTING; sellerPubky: string; listingId: string }
  | { kind: TagKind.SHOP; ownerPubky: string };

export interface UseMarketplaceTagsResult {
  tags: TagWithAvatars[];
  isLoading: boolean;
  handleTagAdd: (label: string) => Promise<{ success: boolean; error?: string }>;
  handleTagToggle: (tag: { label: string; relationship?: boolean }) => Promise<void>;
}

function targetTaggedId(target: MarketplaceTagTarget): string {
  return target.kind === TagKind.LISTING ? `${target.sellerPubky}:${target.listingId}` : target.ownerPubky;
}

/**
 * Community tags for a marketplace target (listing or shop), reusing the same
 * local-first tag flow posts use:
 *
 * - Writes go through `TagController.commitCreate/commitDelete` — real
 *   `PubkyAppTag` records on the tagger's homeserver targeting the canonical
 *   listing/shop URI, with local write-through and rollback on failure.
 * - Reads come from the local `marketplace_tags` cache via `useLiveQuery`
 *   (the viewer's own tags render immediately), plus one fetch from the
 *   marketplace Nexus tag endpoint. Until that Nexus deploys tag aggregation
 *   the endpoint answers 404 and the fetch honestly yields nothing — no
 *   fabricated aggregates.
 */
export function useMarketplaceTags(target: MarketplaceTagTarget | null): UseMarketplaceTagsResult {
  const viewerId = useAuthStore((state) => state.currentUserPubky);
  const [hasFetched, setHasFetched] = useState(false);
  const targetKey = target ? `${target.kind}:${targetTaggedId(target)}` : null;
  const prevTargetKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevTargetKeyRef.current !== targetKey) {
      prevTargetKeyRef.current = targetKey;
      setHasFetched(false);
    }
  }, [targetKey]);

  const localTags = useLiveQuery(
    async () => {
      if (!target) return null;
      if (target.kind === TagKind.LISTING) {
        return await CommerceController.getListingTags(target.sellerPubky, target.listingId);
      }
      return await CommerceController.getShopTags(target.ownerPubky);
    },

    [targetKey],
    undefined,
  );

  useEffect(() => {
    if (!target || hasFetched) return;
    let stale = false;

    const fetchTags = async () => {
      try {
        if (target.kind === TagKind.LISTING) {
          await CommerceController.fetchListingTags(target.sellerPubky, target.listingId, viewerId ?? undefined);
        } else {
          await CommerceController.fetchShopTags(target.ownerPubky, viewerId ?? undefined);
        }
      } catch {
        // Silently degrade — local tags (if any) still render via useLiveQuery.
      } finally {
        if (!stale) setHasFetched(true);
      }
    };

    void fetchTags();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey encodes every field of target
  }, [targetKey, hasFetched, viewerId]);

  const isLoading = localTags === undefined;
  const tags = transformTagsForViewer(localTags ?? [], viewerId);

  const handleTagAdd = useCallback(
    async (tagString: string): Promise<{ success: boolean; error?: string }> => {
      const label = tagString.trim();

      if (!label) return { success: false, error: 'Tag label cannot be empty' };
      if (!target) return { success: false, error: 'Tag target is required' };
      if (!viewerId) return { success: false, error: 'You must be logged in to add tags' };

      const existingTag = (localTags ?? []).find((t) => t.label.toLowerCase() === label.toLowerCase());
      if (existingTag?.relationship || existingTag?.taggers?.includes(viewerId)) {
        return { success: false, error: 'You have already added this tag' };
      }

      try {
        await TagController.commitCreate({
          taggedId: targetTaggedId(target),
          label,
          taggerId: viewerId,
          taggedKind: target.kind,
        });
        toast({ title: `Tag added: ${label}` });
        return { success: true };
      } catch {
        toast({ variant: 'error', description: `Could not add tag: ${label}` });
        return { success: false, error: 'Failed to add tag' };
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey encodes every field of target
    [targetKey, viewerId, localTags],
  );

  const handleTagToggle = useCallback(
    async (tag: { label: string; relationship?: boolean }): Promise<void> => {
      if (!target || !viewerId) return;

      const currentTag = (localTags ?? []).find((t) => t.label === tag.label);
      const userIsTagger =
        tag.relationship ?? currentTag?.relationship ?? currentTag?.taggers?.includes(viewerId) ?? false;

      try {
        if (userIsTagger) {
          await TagController.commitDelete({
            taggedId: targetTaggedId(target),
            label: tag.label,
            taggerId: viewerId,
            taggedKind: target.kind,
          });
          toast({ title: `Tag removed: ${tag.label}` });
        } else {
          await TagController.commitCreate({
            taggedId: targetTaggedId(target),
            label: tag.label,
            taggerId: viewerId,
            taggedKind: target.kind,
          });
          toast({ title: `Tag added: ${tag.label}` });
        }
      } catch {
        toast({
          variant: 'error',
          description: userIsTagger ? `Could not remove tag: ${tag.label}` : `Could not add tag: ${tag.label}`,
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey encodes every field of target
    [targetKey, viewerId, localTags],
  );

  return { tags, isLoading, handleTagAdd, handleTagToggle };
}
