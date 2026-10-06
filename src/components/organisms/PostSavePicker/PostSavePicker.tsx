'use client';

import { useEffect, useState } from 'react';
import { Library, SquareLibrary } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/atoms/DropdownMenu/DropdownMenu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/atoms/Sheet/Sheet';
import { Typography } from '@/atoms/Typography/Typography';
import { TIMELINE_FEED_VARIANT } from '@/config/feed';
import { useIsMobile } from '@/hooks/useIsMobile/useIsMobile';
import { usePostSaveTargets } from '@/hooks/usePostSaveTargets/usePostSaveTargets';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { cn } from '@/libs/utils/utils';
import { useTimelineFeedContext } from '@/organisms/Timeline/Feed/TimelineFeed/TimelineFeedContext';
import { SavePickerContent } from './SavePickerContent';

type PostSavePickerProps = {
  postId: string;
  /**
   * Class merged into the trigger Button. `PostActionsBar` passes its variant
   * styling (default vs. visual / overlay) so the save trigger stays visually
   * consistent with sibling action buttons.
   */
  buttonClassName: string;
};

type SaveTriggerIconState = 'default' | 'saved';

function SaveTriggerIcon({ state }: { state: SaveTriggerIconState }) {
  const iconClassName = (targetState: SaveTriggerIconState) =>
    cn(
      'absolute inset-0 transition-[opacity,transform] duration-150 ease-out',
      state === targetState ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
    );

  return (
    <Typography
      as="span"
      overrideDefaults
      data-cy="post-save-trigger-icon"
      data-state={state}
      className="relative size-4"
    >
      <Library aria-hidden="true" className={iconClassName('default')} />
      <SquareLibrary aria-hidden="true" className={cn(iconClassName('saved'), 'text-brand')} />
    </Typography>
  );
}

export function PostSavePicker({ postId, buttonClassName }: PostSavePickerProps) {
  const isMobile = useIsMobile();
  const { requireAuth } = useRequireAuth();
  const feed = useTimelineFeedContext();
  const feedVariant = feed?.variant;
  const feedCollectionId = feed?.collectionId;
  const removePosts = feed?.removePosts;
  const [open, setOpen] = useState(false);
  const saveTargets = usePostSaveTargets(postId);
  const isBookmarkBusy = saveTargets.isBookmarkLoading || saveTargets.isBookmarkToggling;
  const isBookmarkResolved = !saveTargets.isBookmarkLoading && !saveTargets.isBookmarkToggling;
  const shouldRemoveFromBookmarksFeed =
    feedVariant === TIMELINE_FEED_VARIANT.BOOKMARKS && !open && isBookmarkResolved && !saveTargets.isBookmarked;
  const currentCollectionTarget =
    feedVariant === TIMELINE_FEED_VARIANT.COLLECTION && feedCollectionId
      ? saveTargets.collections.find((collection) => collection.id === feedCollectionId)
      : undefined;
  const isSavedToLibrary = saveTargets.isBookmarked || saveTargets.collections.some((collection) => collection.isSaved);
  const triggerIconState: SaveTriggerIconState = isSavedToLibrary ? 'saved' : 'default';
  const shouldRemoveFromCollectionFeed =
    feedVariant === TIMELINE_FEED_VARIANT.COLLECTION &&
    !open &&
    !saveTargets.isCollectionsLoading &&
    currentCollectionTarget !== undefined &&
    !currentCollectionTarget.isUpdating &&
    !currentCollectionTarget.isSaved;

  // Closing the picker commits the save session. On finite library feeds, a post
  // that no longer belongs to the current target should leave the grid so the
  // visible list matches the live membership. While the picker stays open, the
  // user can freely toggle targets without the card shifting under them.
  useEffect(() => {
    if ((!shouldRemoveFromBookmarksFeed && !shouldRemoveFromCollectionFeed) || !removePosts) return;
    removePosts(postId);
  }, [postId, removePosts, shouldRemoveFromBookmarksFeed, shouldRemoveFromCollectionFeed]);

  const trigger = (
    <Button
      variant="secondary"
      size="sm"
      // `w-10` keeps the icon-only trigger the same width as sibling action
      // buttons in `PostActionsBar` (which carry an icon + count and grow naturally).
      className={cn(buttonClassName, 'w-10')}
      aria-label={'Save post'}
      data-cy="post-bookmark-btn"
    >
      <SaveTriggerIcon state={triggerIconState} />
    </Button>
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setOpen(false);
      return;
    }

    requireAuth(() => setOpen(true));
  };

  const contentProps = {
    bookmark: {
      isBookmarked: saveTargets.isBookmarked,
      isBookmarkBusy,
      toggleBookmark: saveTargets.toggleBookmark,
    },
    collections: saveTargets.collections,
    isCollectionsLoading: saveTargets.isCollectionsLoading,
    isCreatingCollection: saveTargets.isCreatingCollection,
    toggleCollection: saveTargets.toggleCollection,
    createCollectionWithItem: saveTargets.createCollectionWithPost,
  };

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent side="bottom" aria-describedby={undefined} className="rounded-t-xl border-border bg-popover">
          <SheetHeader>
            <SheetTitle>{'Save post'}</SheetTitle>
          </SheetHeader>
          <SavePickerContent layout="sheet" {...contentProps} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-70">
        <SavePickerContent layout="dropdown" {...contentProps} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
