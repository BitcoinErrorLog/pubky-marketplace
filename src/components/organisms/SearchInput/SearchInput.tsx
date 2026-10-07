'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { APP_ROUTES, getUserProfileUrl } from '@/app/routes';
import { Container } from '@/atoms/Container/Container';
import { SEARCH_CLOSED_STYLE } from '@/config/search';
import { getSocialHostUrl } from '@/config/social';
import { CLICKABLE_TAGS_DEFAULT_MAX_LENGTH } from '@/config/tags';
import { useHotTags } from '@/hooks/useHotTags/useHotTags';
import { useIsMobile } from '@/hooks/useIsMobile/useIsMobile';
import { useSearchAutocomplete } from '@/hooks/useSearchAutocomplete/useSearchAutocomplete';
import { useSearchInput } from '@/hooks/useSearchInput/useSearchInput';
import { useTagSearch } from '@/hooks/useTagSearch/useTagSearch';
import { isValidTagLabel } from '@/libs/utils/utils';
import type { Pubky } from '@/models/models.types';
import { SearchInputBar } from '@/molecules/SearchInputBar/SearchInputBar';
import { SearchSuggestions } from '@/molecules/SearchSuggestions/SearchSuggestions';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useSearchStore } from '@/stores/search/search.store';
import { SearchInputProps } from './SearchInput.types';
import { parseTagsFromUrl } from './SearchInput.utils';

/**
 * Mirrors `?tags=` into the search store. It is the only `useSearchParams` read,
 * isolated behind its own Suspense boundary so pages rendering the header
 * (for example the ISR marketplace catalog) can still prerender.
 */
function SearchInputUrlTagsSync() {
  const tagsParam = useSearchParams().get('tags');
  const { setActiveTags } = useSearchStore();
  useEffect(() => {
    setActiveTags(parseTagsFromUrl(tagsParam));
  }, [tagsParam, setActiveTags]);
  return null;
}

export function SearchInput(props: SearchInputProps) {
  const socialSearchUrl = getSocialHostUrl(APP_ROUTES.SEARCH);
  if (socialSearchUrl) {
    return (
      <a
        href={socialSearchUrl}
        aria-label="Search"
        data-cy="header-search"
        className="flex h-12 min-w-0 flex-1 items-center gap-3 rounded-full border border-border px-6 py-3 text-base font-medium text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        style={SEARCH_CLOSED_STYLE}
      >
        <span className="min-w-20 flex-1">Search</span>
        <span className="-mr-2 flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
          <Search className="size-4" />
        </span>
      </a>
    );
  }
  return <LocalSearchInput {...props} />;
}

// Mount social search hooks only when the social app is served on this origin.
function LocalSearchInput({ autoFocus = false }: SearchInputProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { addTagToSearch, removeTagFromSearch, activeTags, isReadOnly } = useTagSearch();
  const { recentUsers, recentTags, addUser, clearRecentSearches } = useSearchStore();
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isMobile = useIsMobile();

  const handleEnter = (value: string) => {
    if (!isValidTagLabel(value.trim().toLowerCase())) {
      toast({ variant: 'error', description: 'Tags can be max 20 chars and cannot contain special characters' });
      return false;
    }

    addTagToSearch(value, { addToRecent: true });
    if (pathname !== APP_ROUTES.SEARCH) {
      setFocus(false);
    }
  };

  const {
    inputValue,
    isFocused,
    containerRef,
    inputRef,
    handleInputChange,
    handleKeyDown,
    handleFocus,
    clearInputValue,
    setFocus,
  } = useSearchInput({ onEnter: handleEnter });

  const { tags: hotTags } = useHotTags({ limit: CLICKABLE_TAGS_DEFAULT_MAX_LENGTH });

  const hasInput = inputValue.trim().length > 0;
  const { tags: autocompleteTags, users: autocompleteUserData } = useSearchAutocomplete({
    query: inputValue,
    enabled: isFocused && hasInput,
  });

  const handleUserClick = (userId: Pubky) => {
    addUser(userId);
    clearInputValue();
    setFocus(false);
    router.push(getUserProfileUrl(userId, currentUserPubky));
  };

  const handleTagClick = (tag: string) => {
    addTagToSearch(tag, { addToRecent: true });
    clearInputValue();

    if (isMobile || pathname !== APP_ROUTES.SEARCH) {
      setFocus(false);
    }
  };

  // Show dropdown immediately when focused
  // The dropdown will display hot tags, recent searches, or empty state
  const hasSuggestions = isFocused;
  const suggestionsId = 'search-suggestions';

  return (
    <Container ref={containerRef} data-testid="search-input" className="relative min-w-0">
      <Suspense fallback={null}>
        <SearchInputUrlTagsSync />
      </Suspense>
      {/* Input bar with active tags */}
      <SearchInputBar
        activeTags={activeTags}
        inputValue={inputValue}
        isFocused={isFocused}
        isReadOnly={isReadOnly}
        isExpanded={hasSuggestions}
        suggestionsId={hasSuggestions ? suggestionsId : undefined}
        inputRef={inputRef}
        onTagRemove={removeTagFromSearch}
        onInputChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        autoFocus={autoFocus}
      />

      {/* Suggestions dropdown */}
      {hasSuggestions && (
        <SearchSuggestions
          id={suggestionsId}
          aria-label="Search suggestions"
          hotTags={hotTags}
          hasInput={hasInput}
          autocompleteTags={autocompleteTags}
          autocompleteUsers={autocompleteUserData}
          recentUsers={recentUsers}
          recentTags={recentTags}
          onTagClick={handleTagClick}
          onUserClick={handleUserClick}
          onClearRecentSearches={clearRecentSearches}
        />
      )}
    </Container>
  );
}
