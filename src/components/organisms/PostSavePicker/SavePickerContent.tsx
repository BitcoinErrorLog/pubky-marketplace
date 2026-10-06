'use client';

import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { Bookmark, Check, Library, Loader2, Plus } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/atoms/DropdownMenu/DropdownMenu';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { Typography } from '@/atoms/Typography/Typography';
import { COLLECTION_NAME_MAX_CHARACTER_LENGTH } from '@/config/posts';
import type { PostSaveCollectionTarget } from '@/hooks/usePostSaveTargets/usePostSaveTargets';
import { cn } from '@/libs/utils/utils';

export type SavePickerLayout = 'dropdown' | 'sheet';

type SaveTargetIconProps = {
  isSaved: boolean;
  isBusy: boolean;
};

/** Bookmark row state + action. Omit to hide the row (e.g. listing targets). */
export type SavePickerBookmarkSection = {
  isBookmarked: boolean;
  isBookmarkBusy: boolean;
  toggleBookmark: () => Promise<void>;
};

export type SavePickerContentProps = {
  layout: SavePickerLayout;
  bookmark?: SavePickerBookmarkSection;
  collections: PostSaveCollectionTarget[];
  isCollectionsLoading: boolean;
  isCreatingCollection: boolean;
  toggleCollection: (collectionId: string) => Promise<void>;
  createCollectionWithItem: (name: string) => Promise<void>;
};

function SaveTargetIcon({ isSaved, isBusy }: SaveTargetIconProps) {
  if (isBusy) {
    return <Loader2 className="size-4 animate-spin" />;
  }

  if (isSaved) {
    return <Check className="size-4 text-brand" />;
  }

  return null;
}

function SavePickerRow({
  layout,
  disabled,
  dataCy,
  onActivate,
  children,
}: {
  layout: SavePickerLayout;
  disabled?: boolean;
  dataCy?: string;
  onActivate: () => void;
  children: ReactNode;
}) {
  if (layout === 'dropdown') {
    return (
      <DropdownMenuItem
        disabled={disabled}
        onSelect={(event) => {
          event.preventDefault();
          onActivate();
        }}
        className="w-full gap-2 p-0 text-base font-medium text-muted-foreground"
        data-cy={dataCy}
      >
        {children}
      </DropdownMenuItem>
    );
  }

  return (
    <Button
      overrideDefaults
      disabled={disabled}
      onClick={onActivate}
      className="flex w-full cursor-pointer items-center gap-2 rounded-sm p-0 text-base font-medium text-muted-foreground disabled:opacity-50"
      data-cy={dataCy}
    >
      {children}
    </Button>
  );
}

function CollectionRow({
  layout,
  collection,
  onToggleCollection,
}: {
  layout: SavePickerLayout;
  collection: PostSaveCollectionTarget;
  onToggleCollection: (collectionId: string) => Promise<void>;
}) {
  return (
    <SavePickerRow
      layout={layout}
      disabled={collection.isUpdating}
      dataCy="post-save-collection-option"
      onActivate={() => void onToggleCollection(collection.id)}
    >
      <Library className="size-4" />
      <Typography
        as="span"
        overrideDefaults
        className={cn('min-w-0 flex-1 truncate', layout === 'sheet' && 'text-left')}
      >
        {collection.name}
      </Typography>
      <SaveTargetIcon isSaved={collection.isSaved} isBusy={collection.isUpdating} />
    </SavePickerRow>
  );
}

/**
 * The body of the save picker: an optional Bookmarks row, the viewer's
 * collections as toggle rows, and the inline "New Collection" creator.
 *
 * Shared between the post save picker (bookmark section present) and the
 * marketplace listing save picker (collections only — bookmarks target post
 * URIs and are deliberately not offered for listings).
 */
export function SavePickerContent({
  layout,
  bookmark,
  collections,
  isCollectionsLoading,
  isCreatingCollection,
  toggleCollection,
  createCollectionWithItem,
}: SavePickerContentProps) {
  const [newCollectionName, setNewCollectionName] = useState('');
  const canCreate = newCollectionName.trim().length > 0 && !isCreatingCollection;

  const handleCreate = async () => {
    if (!canCreate) return;
    await createCollectionWithItem(newCollectionName);
    setNewCollectionName('');
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Stop the menu/sheet from intercepting typing (e.g. type-ahead in
    // DropdownMenu, copy/paste shortcuts) so the inline name field behaves
    // like a normal text input even when nested inside the menu.
    event.stopPropagation();
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void handleCreate();
  };

  return (
    <Container overrideDefaults className={cn('flex w-full flex-col', layout === 'sheet' ? 'gap-4' : 'gap-3')}>
      {/* Bookmark + collections scroll as one region so a long collection list
          can't push the "New collection" creator off-screen and out of reach.
          `max-h-[50dvh]` keeps the picker within the viewport on both the
          desktop dropdown and the mobile sheet. */}
      <Container
        overrideDefaults
        className={cn('flex max-h-[50dvh] flex-col overflow-y-auto', layout === 'sheet' ? 'gap-4' : 'gap-3')}
      >
        {bookmark && (
          <SavePickerRow
            layout={layout}
            disabled={bookmark.isBookmarkBusy}
            dataCy="post-save-bookmarks-option"
            onActivate={() => void bookmark.toggleBookmark()}
          >
            <Bookmark className="size-4" />
            <Typography
              as="span"
              overrideDefaults
              className={cn('min-w-0 flex-1 truncate', layout === 'sheet' && 'text-left')}
            >
              {'Bookmarks'}
            </Typography>
            <SaveTargetIcon isSaved={bookmark.isBookmarked} isBusy={bookmark.isBookmarkBusy} />
          </SavePickerRow>
        )}

        {isCollectionsLoading ? (
          <Container overrideDefaults className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <Typography overrideDefaults className="text-base font-medium">
              {'Loading collections...'}
            </Typography>
          </Container>
        ) : (
          collections.map((collection) => (
            <CollectionRow
              key={collection.id}
              layout={layout}
              collection={collection}
              onToggleCollection={toggleCollection}
            />
          ))
        )}
      </Container>

      {layout === 'dropdown' ? <DropdownMenuSeparator /> : <Container overrideDefaults className="h-px bg-muted" />}

      <Container overrideDefaults className={cn('flex flex-col gap-2', layout === 'dropdown' && 'pt-1')}>
        <Label className="text-xs tracking-widest text-muted-foreground uppercase">{'New Collection'}</Label>
        <Container
          overrideDefaults
          className="flex items-center gap-2 rounded-md border border-dashed border-input px-4 py-3"
        >
          <Input
            value={newCollectionName}
            onChange={(event) => setNewCollectionName(event.target.value)}
            onKeyDown={handleInputKeyDown}
            maxLength={COLLECTION_NAME_MAX_CHARACTER_LENGTH}
            placeholder={'Collection name'}
            className="h-auto border-none p-0 shadow-none"
            disabled={isCreatingCollection}
            data-cy="post-save-new-collection-input"
          />
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="size-6"
            disabled={!canCreate}
            onClick={() => void handleCreate()}
            aria-label={'Create collection'}
            data-cy="post-save-new-collection-create-btn"
          >
            {isCreatingCollection ? <Loader2 className="animate-spin" /> : <Plus />}
          </Button>
        </Container>
      </Container>
    </Container>
  );
}
