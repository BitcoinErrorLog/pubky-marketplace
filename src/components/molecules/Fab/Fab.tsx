'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { Plus } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { useAuthStatus } from '@/hooks/useAuthStatus/useAuthStatus';
import { useFabAction } from '@/hooks/useFabAction/useFabAction';
import { useIsEmbedded } from '@/hooks/useIsEmbedded/useIsEmbedded';
import { usePublicRoute } from '@/hooks/usePublicRoute/usePublicRoute';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { cn } from '@/libs/utils/utils';
import { useCollectionReorderStore } from '@/stores/collectionReorder/collectionReorder.store';

// The Fab is in the root layout: loading the composers on demand keeps their editor,
// markdown and syntax-highlighting code out of every page's first-paint bundle.
const DialogNewPost = dynamic(
  () => import('@/organisms/DialogNewPost/DialogNewPost').then((module) => module.DialogNewPost),
  { ssr: false },
);
const DialogNewCollection = dynamic(
  () =>
    import('@/organisms/Collections/DialogNewCollection/DialogNewCollection').then(
      (module) => module.DialogNewCollection,
    ),
  { ssr: false },
);

/**
 * Floating Action Button (FAB).
 *
 * The button is always a `+`; its behavior is context-aware via
 * [`useFabAction`](src/hooks/useFabAction/useFabAction.ts):
 * - `/collections`                      -> create a new collection
 * - `/collections/bookmarks`            -> create a post and bookmark it
 * - `/collections/[ownPubky]/[postId]`  -> create a post inside that collection
 * - everywhere else (incl. non-owned)   -> create a new post
 *
 * Visibility rules:
 * - Shows for authenticated users (opens the context dialog)
 * - Shows for unauthenticated users on public explore routes (opens sign-in)
 * - Hidden on landing page and other non-public routes for unauthenticated users
 * - Hidden while a collection is in reorder mode (reorder mode is for
 *   reordering, not adding posts; the flag bridges from the page via the
 *   `collectionReorder` store since the FAB lives outside the page tree)
 *
 * Positioning:
 * - On small screens (sm), the button sits directly on top of the menu bar by design.
 * - `bottom-18` (72px) matches the height of the footer navigation bar.
 * - md breakpoint uses 80px (`bottom-20`) for additional spacing.
 */
export function Fab() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { isFullyAuthenticated, isLoading } = useAuthStatus();
  const { isPublicExploreRoute } = usePublicRoute();
  const { requireAuth } = useRequireAuth();
  const action = useFabAction();
  const isReorderActive = useCollectionReorderStore((state) => state.activeCollectionId !== null);
  const isEmbedded = useIsEmbedded();
  const hideOnCheckout =
    pathname === MARKETPLACE_ROUTES.CART ||
    pathname === MARKETPLACE_ROUTES.CHECKOUT ||
    pathname === MARKETPLACE_ROUTES.AWARD_CHECKOUT;

  // Show FAB for authenticated users OR unauthenticated users on public explore routes
  const shouldShow = isFullyAuthenticated || isPublicExploreRoute;
  if (
    isEmbedded ||
    isLoading ||
    !shouldShow ||
    isReorderActive ||
    hideOnCheckout ||
    pathname?.startsWith(`${MARKETPLACE_ROUTES.LISTING}/`)
  ) {
    return null;
  }
  const buttonClasses = cn(
    'fixed right-3 bottom-18 sm:right-10 md:bottom-20 lg:bottom-6',
    'size-20 rounded-full',
    'flex items-center justify-center',
    'bg-white/12 backdrop-blur-lg',
    'hover:bg-brand',
    'text-white',
    'shadow-xl transition-colors',
    'group cursor-pointer',
    'z-40',
  );
  const button = (
    <Button
      data-cy="new-post-btn"
      overrideDefaults
      data-testid="new-post-cta"
      className={buttonClasses}
      aria-label={action.ariaLabel}
      onClick={() => requireAuth(() => setOpen(true))}
    >
      <Plus className="size-10 transition-colors group-hover:text-black" strokeWidth={0.8} />
    </Button>
  );

  // Unauthenticated: button only opens the sign-in dialog via requireAuth
  if (!isFullyAuthenticated) {
    return button;
  }

  // Authenticated: render the button next to the context dialog it controls
  return (
    <>
      {button}
      {action.kind === 'createCollection' ? (
        <DialogNewCollection open={open} onOpenChange={setOpen} />
      ) : (
        <DialogNewPost open={open} onOpenChangeAction={setOpen} onPostCreated={action.onPostCreated} />
      )}
    </>
  );
}
