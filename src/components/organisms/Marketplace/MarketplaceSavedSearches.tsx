'use client';

import { useState } from 'react';
import { Bookmark, BookmarkPlus, X } from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Input } from '@/atoms/Input/Input';
import { Popover, PopoverContent, PopoverTrigger } from '@/atoms/Popover/Popover';
import { Typography } from '@/atoms/Typography/Typography';
import { COMMERCE_SAVED_SEARCH_NAME_MAX_CHARS } from '@/config/commerce';
import { useMarketplaceSavedSearches } from '@/hooks/useMarketplaceSavedSearches/useMarketplaceSavedSearches';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import type { CommerceSavedSearchModelSchema } from '@/models/commerce/commerce.schema';

/**
 * Saved searches as a compact popover in the marketplace filter row: the
 * trigger shows an honest aggregate NEW badge (matches counted past the
 * acknowledged watermark from a real catalog check — see
 * `useMarketplaceSavedSearches`); the popover holds apply-on-click rows, a
 * delete affordance per search, and the save-current-search flow. Prompts
 * sign-in when signed out: saved searches are account-scoped local data.
 */
export function MarketplaceSavedSearches() {
  const { searches, isSignedIn, saveCurrentSearch, applySearch, deleteSearch } = useMarketplaceSavedSearches();
  const { requireAuth } = useRequireAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [isNaming, setIsNaming] = useState(false);
  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  if (!isSignedIn) {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="-mr-px shrink-0 rounded-full text-xs font-bold"
        aria-label="Saved searches"
        data-cy="marketplace-saved-searches"
        onClick={() => requireAuth(() => setIsOpen(true))}
      >
        <Bookmark className="size-4" />
      </Button>
    );
  }

  const totalNew = searches.reduce((sum, search) => sum + search.new_count, 0);

  const submitSave = async () => {
    if (name.trim().length === 0 || isSaving) return;
    setIsSaving(true);
    try {
      const saved = await saveCurrentSearch(name);
      if (saved) {
        setName('');
        setIsNaming(false);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const apply = async (search: CommerceSavedSearchModelSchema) => {
    await applySearch(search);
    setIsOpen(false);
    document.getElementById('marketplace-catalog')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className="-mr-px shrink-0 rounded-full text-xs font-bold"
          aria-label={totalNew > 0 ? `Saved searches, ${totalNew} new matches` : 'Saved searches'}
          data-cy="marketplace-saved-searches"
        >
          <Bookmark className="size-4" />
          {totalNew > 0 && (
            <Badge className="ml-1.5 bg-brand px-1.5 py-0 text-[10px] text-primary-foreground">{totalNew} NEW</Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-5">
        <div className="flex flex-col gap-4">
          <Typography as="h2" className="text-sm font-semibold">
            Saved searches
          </Typography>
          {!isNaming && (
            <Button
              size="sm"
              variant="secondary"
              className="gap-2 self-start rounded-full"
              onClick={() => setIsNaming(true)}
            >
              <BookmarkPlus className="size-4" />
              Save Current Search
            </Button>
          )}

          {isNaming && (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitSave();
              }}
            >
              <Input
                autoFocus
                value={name}
                maxLength={COMMERCE_SAVED_SEARCH_NAME_MAX_CHARS}
                placeholder="Name this search"
                aria-label="Saved search name"
                className="h-8 flex-1"
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="submit" size="sm" className="rounded-full" disabled={name.trim().length === 0 || isSaving}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="rounded-full"
                onClick={() => {
                  setIsNaming(false);
                  setName('');
                }}
              >
                Cancel
              </Button>
            </form>
          )}

          {searches.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {searches.map((search) => (
                <li key={search.id} className="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-muted/60">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm hover:text-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    data-cy="marketplace-saved-search-apply"
                    onClick={() => void apply(search)}
                  >
                    <span className="truncate">{search.name}</span>
                    {search.new_count > 0 && (
                      <Badge className="shrink-0 bg-brand px-1.5 py-0 text-[10px] text-primary-foreground">
                        {search.new_count} NEW
                      </Badge>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete saved search ${search.name}`}
                    className="rounded-full p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => void deleteSearch(search.id)}
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Typography as="p" className="text-sm text-muted-foreground">
              No saved searches yet. Set filters or a search term, then save the combination.
            </Typography>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
