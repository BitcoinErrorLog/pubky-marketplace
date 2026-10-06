'use client';

import { useState } from 'react';
import { listingUriBuilder } from 'pubky-app-specs';
import { DEFAULT_COLLECTION_LAYOUT } from '@/config/collections';
import { PostController } from '@/controllers/post/post';
import { useAuthoredCollections } from '@/hooks/useAuthoredCollections/useAuthoredCollections';
import type { PostSaveCollectionTarget } from '@/hooks/usePostSaveTargets/usePostSaveTargets';
import { isAppError } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import { useToast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';

type UseListingSaveTargetsResult = {
  collections: PostSaveCollectionTarget[];
  isCollectionsLoading: boolean;
  isCreatingCollection: boolean;
  isSavedToAnyCollection: boolean;
  toggleCollection: (collectionId: string) => Promise<void>;
  createCollectionWithListing: (name: string) => Promise<void>;
};

/**
 * Save targets for a marketplace listing — the same collection flow
 * `usePostSaveTargets` gives posts, with the listing's canonical URI as the
 * collection item (accepted by pubky-app-specs since 0.6.2-marketplace.2).
 *
 * Bookmarks are deliberately absent: the bookmark flow is post-scoped, so
 * offering it here would be a fake affordance.
 *
 * @param sellerPubky - The listing owner's pubky
 * @param listingId - The listing's timestamp id
 */
export function useListingSaveTargets(sellerPubky: string, listingId: string): UseListingSaveTargetsResult {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const { collections, isLoading: isCollectionsLoading } = useAuthoredCollections(Boolean(currentUserPubky));
  const { toast } = useToast();
  const [updatingCollectionIds, setUpdatingCollectionIds] = useState<Set<string>>(new Set());
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);

  const compositeListingId = `${sellerPubky}:${listingId}`;
  const listingUri = listingUriBuilder(sellerPubky, listingId);

  const saveTargets: PostSaveCollectionTarget[] = collections.map((collection) => ({
    id: collection.details.id,
    name: collection.content.name,
    description: collection.content.description ?? '',
    isSaved: (collection.content.items ?? []).includes(listingUri),
    isUpdating: updatingCollectionIds.has(collection.details.id),
  }));

  const setCollectionUpdating = (collectionId: string, isUpdating: boolean) => {
    setUpdatingCollectionIds((current) => {
      const next = new Set(current);
      if (isUpdating) {
        next.add(collectionId);
      } else {
        next.delete(collectionId);
      }
      return next;
    });
  };

  const toggleCollection = async (collectionId: string) => {
    const target = saveTargets.find((collection) => collection.id === collectionId);
    if (!target || target.isUpdating) return;

    setCollectionUpdating(collectionId, true);

    try {
      await PostController.commitUpdateCollectionItem({
        collectionId,
        postId: compositeListingId,
        shouldAdd: !target.isSaved,
        itemKind: 'listing',
      });
      toast({
        title: target.isSaved ? 'Listing removed from collection.' : 'Listing added to collection.',
      });
    } catch (error) {
      Logger.error('[useListingSaveTargets] Failed to update collection membership', {
        error,
        collectionId,
        compositeListingId,
      });
      toast({
        variant: 'error',
        description: isAppError(error) ? error.message : 'Failed to update collection.',
      });
    } finally {
      setCollectionUpdating(collectionId, false);
    }
  };

  const createCollectionWithListing = async (name: string) => {
    if (!currentUserPubky || isCreatingCollection) return;

    setIsCreatingCollection(true);

    try {
      await PostController.commitCreateCollection({
        authorId: currentUserPubky,
        name,
        items: [listingUri],
        layout: DEFAULT_COLLECTION_LAYOUT,
      });
      toast({
        title: 'Collection created and listing saved.',
      });
    } catch (error) {
      Logger.error('[useListingSaveTargets] Failed to create collection', { error, compositeListingId });
      toast({
        variant: 'error',
        description: isAppError(error) ? error.message : 'Failed to create collection.',
      });
    } finally {
      setIsCreatingCollection(false);
    }
  };

  return {
    collections: saveTargets,
    isCollectionsLoading,
    isCreatingCollection,
    isSavedToAnyCollection: saveTargets.some((collection) => collection.isSaved),
    toggleCollection,
    createCollectionWithListing,
  };
}
