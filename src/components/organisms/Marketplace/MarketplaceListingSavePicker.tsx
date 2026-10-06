'use client';

import { useState } from 'react';
import { Library, SquareLibrary } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/atoms/DropdownMenu/DropdownMenu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/atoms/Sheet/Sheet';
import { useIsMobile } from '@/hooks/useIsMobile/useIsMobile';
import { useListingSaveTargets } from '@/hooks/useListingSaveTargets/useListingSaveTargets';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { SavePickerContent } from '@/organisms/PostSavePicker/SavePickerContent';

export interface MarketplaceListingSavePickerProps {
  sellerPubky: string;
  listingId: string;
}

/**
 * "Save to collection" affordance on the listing detail page — the same
 * picker posts use (`SavePickerContent`), minus the bookmark row (bookmarks
 * are post-scoped). Toggling writes the listing's canonical URI into the
 * collection envelope via the shared `commitUpdateCollectionItem` flow.
 */
export function MarketplaceListingSavePicker({ sellerPubky, listingId }: MarketplaceListingSavePickerProps) {
  const isMobile = useIsMobile();
  const { requireAuth } = useRequireAuth();
  const [open, setOpen] = useState(false);
  const saveTargets = useListingSaveTargets(sellerPubky, listingId);

  const trigger = (
    <Button
      size="icon"
      variant="secondary"
      className="size-10 rounded-full"
      aria-label={saveTargets.isSavedToAnyCollection ? 'Saved to collection' : 'Save to collection'}
      aria-pressed={saveTargets.isSavedToAnyCollection}
      data-cy="marketplace-listing-save-btn"
    >
      {saveTargets.isSavedToAnyCollection ? <SquareLibrary className="text-brand" /> : <Library />}
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
    collections: saveTargets.collections,
    isCollectionsLoading: saveTargets.isCollectionsLoading,
    isCreatingCollection: saveTargets.isCreatingCollection,
    toggleCollection: saveTargets.toggleCollection,
    createCollectionWithItem: saveTargets.createCollectionWithListing,
  };

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent side="bottom" aria-describedby={undefined} className="rounded-t-xl border-border bg-popover">
          <SheetHeader>
            <SheetTitle>{'Save listing'}</SheetTitle>
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
