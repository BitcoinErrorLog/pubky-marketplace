import { isSocialLinkOutEnabled } from '@/config/social';
import { isPubkyIdentifier } from '@/libs/utils/utils';

export const ROOT_ROUTES = '/';

export enum ONBOARDING_ROUTES {
  BACKUP = '/onboarding/backup',
  INSTALL = '/onboarding/install',
  PROFILE = '/onboarding/profile',
  PUBKY = '/onboarding/pubky',
  SCAN = '/onboarding/scan',
  HUMAN = '/onboarding/human',
}

export enum AUTH_ROUTES {
  SIGN_IN = '/sign-in',
  LOGOUT = '/logout',
}

export enum APP_ROUTES {
  HOME = '/home',
  FEED = '/feed',
  SEARCH = '/search',
  HOT = '/hot',
  COLLECTIONS = '/collections',
  MARKETPLACE = '/marketplace',
  MESSAGES = '/messages',
  SETTINGS = '/settings',
  PROFILE = '/profile',
  WHO_TO_FOLLOW = '/who-to-follow',
  SHARE = '/share',
}

export enum COLLECTION_ROUTES {
  BOOKMARKS = '/collections/bookmarks',
}

export enum MARKETPLACE_ROUTES {
  LISTING = '/marketplace/listing',
  SHOP = '/marketplace/shop',
  DROPS = '/marketplace/drops',
  DROP = '/marketplace/drop',
  SELL_DROPS = '/marketplace/sell/drops',
  MY_SHOP = '/marketplace/storefront',
  SELL = '/marketplace/sell',
  DASHBOARD = '/marketplace/dashboard',
  INVENTORY = '/marketplace/dashboard/inventory',
  INVENTORY_AUTOMATIONS = '/marketplace/dashboard/inventory/automations',
  CART = '/marketplace/cart',
  CHECKOUT = '/marketplace/checkout',
  AWARD_CHECKOUT = '/marketplace/award-checkout',
  ORDERS = '/marketplace/orders',
  MESSAGES = '/marketplace/messages',
  OFFERS = '/marketplace/offers',
  NOTIFICATIONS = '/marketplace/notifications',
  WATCHLIST = '/marketplace/watchlist',
  SETTINGS = '/marketplace/settings',
  SETTINGS_ADDRESSES = '/marketplace/settings/addresses',
  SETTINGS_SHIPPING = '/marketplace/settings/shipping',
}

export function getMarketplaceAddressSettingsRoute(returnTo?: string): string {
  if (!returnTo || !matchMarketplaceDropRoute(returnTo)) return MARKETPLACE_ROUTES.SETTINGS_ADDRESSES;
  return `${MARKETPLACE_ROUTES.SETTINGS_ADDRESSES}?returnTo=${encodeURIComponent(returnTo)}`;
}

export function isMarketplaceListingComposerReturnTo(returnTo: string): boolean {
  if (returnTo.startsWith('//') || !returnTo.startsWith('/') || /^[a-z][a-z\d+\-.]*:/i.test(returnTo)) {
    return false;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(returnTo);
  } catch {
    return false;
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    return false;
  }
  if (decoded === MARKETPLACE_ROUTES.SELL) return true;
  const segments = decoded.split('/').filter(Boolean);
  return (
    segments[0] === 'marketplace' &&
    segments[1] === 'listing' &&
    segments.length === 5 &&
    segments[4] === 'edit' &&
    isPubkyIdentifier(segments[2]) &&
    Boolean(segments[3])
  );
}

export function getMarketplacePaymentSettingsRoute(returnTo?: string): string {
  if (!returnTo || !isMarketplaceListingComposerReturnTo(returnTo)) return MARKETPLACE_ROUTES.SETTINGS;
  return `${MARKETPLACE_ROUTES.SETTINGS}?returnTo=${encodeURIComponent(returnTo)}`;
}

export function readMarketplaceListingComposerReturnTo(returnTo: string | null): string | null {
  return returnTo && isMarketplaceListingComposerReturnTo(returnTo) ? returnTo : null;
}

export enum PROFILE_ROUTES {
  PROFILE = '/profile',
  NOTIFICATIONS = '/profile/notifications',
  POSTS = '/profile/posts',
  REPLIES = '/profile/replies',
  FOLLOWERS = '/profile/followers',
  FOLLOWING = '/profile/following',
  FRIENDS = '/profile/friends',
  UNIQUE_TAGS = '/profile/tagged',
  PROFILE_PAGE = '/profile/profile',
  COLLECTIONS = '/profile/collections',
}

export enum SETTINGS_ROUTES {
  ACCOUNT = '/settings/account',
  EDIT = '/settings/edit',
  NOTIFICATIONS = '/settings/notifications',
  PRIVACY_SAFETY = '/settings/privacy-safety',
  MUTED_USERS = '/settings/muted-users',
  HELP = '/settings/help',
}

export enum POST_ROUTES {
  POST = '/post',
}

export enum COPYRIGHT_ROUTES {
  COPYRIGHT = '/copyright',
}

export enum DEV_ROUTES {
  /** Sentry verification harness — gated to non-production by the page itself. */
  SENTRY_TEST = '/sentry-test',
}

export const EXPLORE_ROUTES: string[] = [
  APP_ROUTES.HOME,
  APP_ROUTES.HOT,
  APP_ROUTES.SEARCH,
  APP_ROUTES.COLLECTIONS,
  APP_ROUTES.MARKETPLACE,
];

// Public routes are accessible regardless of authentication status.
// This includes routes that need to be accessible during auth transitions (like logout).
// Note: Dynamic public routes like /profile/[pubky] and /post/[userId]/[postId]
// are handled by isDynamicPublicRoute() in RouteGuardProvider.
// Core explore routes are intentionally not listed here so auth hydration can
// still finish before app shell routes render for logged-in users.
export const PUBLIC_ROUTES: string[] = [
  AUTH_ROUTES.LOGOUT,
  // Profile is public to prevent RouteGuard redirect during logout.
  // The profile page components handle unauthenticated state gracefully.
  APP_ROUTES.PROFILE,
  // Copyright page should be accessible without authentication
  COPYRIGHT_ROUTES.COPYRIGHT,
  // Sentry verification harness must be reachable without a session on preview deploys.
  // The page returns 404 in production via isSentryTestHarnessEnabled().
  DEV_ROUTES.SENTRY_TEST,
  // Catalog home is guest HTML (SSR of the public Nexus listing stream + OG).
  // Exact match only — `PUBLIC_ROUTES.includes(pathname)` — so writable
  // surfaces under `/marketplace/...` stay behind the auth gate.
  APP_ROUTES.MARKETPLACE,
];

export const ALLOWED_ROUTES = [
  ONBOARDING_ROUTES.PROFILE,
  APP_ROUTES.HOME,
  APP_ROUTES.FEED,
  APP_ROUTES.SEARCH,
  APP_ROUTES.HOT,
  APP_ROUTES.COLLECTIONS,
  APP_ROUTES.MARKETPLACE,
  APP_ROUTES.MESSAGES,
  APP_ROUTES.SETTINGS,
  APP_ROUTES.PROFILE,
  APP_ROUTES.WHO_TO_FOLLOW,
  APP_ROUTES.SHARE,
  POST_ROUTES.POST,
  AUTH_ROUTES.LOGOUT,
];

// Route guard configurations for different authentication states
export const UNAUTHENTICATED_ROUTES = {
  allowedRoutes: [
    ROOT_ROUTES,
    AUTH_ROUTES.SIGN_IN,
    ONBOARDING_ROUTES.INSTALL,
    ONBOARDING_ROUTES.SCAN,
    ONBOARDING_ROUTES.PUBKY,
    ONBOARDING_ROUTES.BACKUP,
    ONBOARDING_ROUTES.HUMAN,
    ...EXPLORE_ROUTES,
    AUTH_ROUTES.LOGOUT,
    COPYRIGHT_ROUTES.COPYRIGHT,
  ],
  redirectTo: ROOT_ROUTES,
};

export const NEEDS_PROFILE_CREATION_ROUTES = {
  allowedRoutes: [ONBOARDING_ROUTES.PROFILE, ONBOARDING_ROUTES.BACKUP],
  redirectTo: ONBOARDING_ROUTES.PROFILE,
};

/**
 * Where the Shop sends a user when it navigates "home" on its own (route guard,
 * logo, post-onboarding, not-found fallbacks). With social link-out on, `/home`
 * belongs to the social host, where a Shop session does not carry over, so the
 * Shop stays on its catalog instead.
 */
export function getShopHomeRoute(): APP_ROUTES.HOME | APP_ROUTES.MARKETPLACE {
  return isSocialLinkOutEnabled() ? APP_ROUTES.MARKETPLACE : APP_ROUTES.HOME;
}

export const AUTHENTICATED_ROUTES = {
  allowedRoutes: ALLOWED_ROUTES,
  get redirectTo() {
    return getShopHomeRoute();
  },
};

// Backwards compatibility
export const HOME_ROUTES = {
  HOME: APP_ROUTES.HOME,
};

// ============================================================================
// Dynamic Public Route Detection
// ============================================================================

/**
 * Checks if a pathname is a dynamic public route accessible without authentication.
 *
 * Dynamic public routes:
 * - /post/[userId]/[postId] - viewing a single post
 * - /profile/[pubky] - viewing another user's profile
 * - /collections/[userId]/[postId] - viewing a single collection
 */
export function isDynamicPublicRoute(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);

  switch (true) {
    case segments[0] === 'invite' && segments.length === 2:
    case segments[0] === 'post' && segments.length === 3:
    case segments[0] === 'profile' && segments.length === 2 && isPubkyIdentifier(segments[1]):
    case matchSingleCollectionRoute(pathname) !== null:
    case matchMarketplaceListingRoute(pathname) !== null:
    case matchMarketplaceShopRoute(pathname) !== null:
    // Drop pages are public hype surfaces, like listings and shops.
    // The drops index is the same read surface. Guests who open /marketplace/drops
    // must stay on that list, not bounce to the unfiltered catalog.
    case pathname === MARKETPLACE_ROUTES.DROPS:
    case matchMarketplaceDropRoute(pathname) !== null:
      return true;
    default:
      return false;
  }
}

type MatchesAllowedRouteOptions = {
  /**
   * When true, explore routes (`EXPLORE_ROUTES`) match exactly so `/collections`
   * does not expose auth-only sub-routes like `/collections/bookmarks` to guests.
   * Authenticated route checks should leave this false so prefix matching still
   * applies (e.g. `/collections/bookmarks` via the `/collections` allowed route).
   */
  restrictExploreSubRoutes?: boolean;
};

/**
 * Whether `pathname` is reachable via an allowed route entry.
 *
 * Non-explore routes keep prefix matching (e.g. onboarding sub-steps). Explore
 * routes optionally match exactly — see `restrictExploreSubRoutes`.
 */
export function matchesAllowedRoute(
  pathname: string,
  route: string,
  { restrictExploreSubRoutes = false }: MatchesAllowedRouteOptions = {},
): boolean {
  if (pathname === route) {
    return true;
  }
  if (restrictExploreSubRoutes && EXPLORE_ROUTES.includes(route)) {
    return false;
  }
  return pathname.startsWith(`${route}/`);
}

/**
 * Matches a single post route `/post/[userId]/[postId]` and returns its params,
 * or `null` for any other path. Shape-only matching — identifier validation is
 * the caller's concern (mirrors `matchSingleCollectionRoute`).
 */
export function matchPostRoute(pathname: string): { userId: string; postId: string } | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'post' || segments.length !== 3) {
    return null;
  }
  const [, userId, postId] = segments;
  return { userId, postId };
}

/** `/post/[userId]/[postId]` — browsable without auth; uses explore header chrome for guests. */
export function isPostRoute(pathname: string): boolean {
  return matchPostRoute(pathname) !== null;
}

export function isCoreExploreRoute(pathname: string): boolean {
  return EXPLORE_ROUTES.includes(pathname);
}

export function isPublicExploreRoute(pathname: string): boolean {
  return isCoreExploreRoute(pathname) || isDynamicPublicRoute(pathname);
}

/** Routes where the header logo links back to the landing page (`/`). */
export const LOGO_LANDING_ROUTES: readonly string[] = [
  ROOT_ROUTES,
  ...Object.values(AUTH_ROUTES),
  COPYRIGHT_ROUTES.COPYRIGHT,
  ...Object.values(ONBOARDING_ROUTES),
];

export function isLogoLandingRoute(pathname: string | null): boolean {
  return pathname != null && LOGO_LANDING_ROUTES.includes(pathname);
}

// ============================================================================
// Profile Route Helpers
// ============================================================================

/**
 * Generates a profile route for a specific user.
 * If no pubky is provided, returns the route for the logged-in user.
 *
 * @param route - The base profile route (e.g., PROFILE_ROUTES.FOLLOWERS)
 * @param pubky - Optional pubky for viewing another user's profile
 * @returns The full route path
 *
 * @example
 * ```ts
 * // For logged-in user
 * getProfileRoute(PROFILE_ROUTES.FOLLOWERS) // => '/profile/followers'
 *
 * // For specific user
 * getProfileRoute(PROFILE_ROUTES.FOLLOWERS, 'n1zpc53jzy') // => '/profile/n1zpc53jzy/followers'
 * ```
 */
export function getProfileRoute(route: PROFILE_ROUTES, pubky?: string): string {
  if (!pubky) {
    return route;
  }

  // Extract the sub-path after /profile
  const subPath = route.replace('/profile', '');

  // For other users, the base profile route is the canonical posts view.
  // Notifications only apply to the logged-in user, so they fall back to base profile.
  if (route === PROFILE_ROUTES.PROFILE || route === PROFILE_ROUTES.NOTIFICATIONS || route === PROFILE_ROUTES.POSTS) {
    return `/profile/${pubky}`;
  }

  return `/profile/${pubky}${subPath}`;
}

// ============================================================================
// Collection Route Helpers
// ============================================================================

/**
 * Builds the route to a single collection's detail page.
 *
 * @param authorPubky - The collection owner's pubky
 * @param postId - The collection post id (raw, not composite)
 * @returns The full route path (e.g. `/collections/<pubky>/<postId>`)
 */
export function getCollectionRoute(authorPubky: string, postId: string): string {
  return `${APP_ROUTES.COLLECTIONS}/${authorPubky}/${postId}`;
}

/** `/collections` exactly — the collections overview page (not a single collection or bookmarks). */
export function isCollectionsOverviewRoute(pathname: string): boolean {
  return pathname === APP_ROUTES.COLLECTIONS;
}

/**
 * Matches a single collection detail route `/collections/[userId]/[postId]` and
 * returns its params, or `null` for any other path. `bookmarks` is excluded so
 * `/collections/bookmarks` is never treated as a `userId`.
 */
export function matchSingleCollectionRoute(pathname: string): { userId: string; postId: string } | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'collections' || segments.length !== 3) {
    return null;
  }
  const [, userId, postId] = segments;
  if (userId === 'bookmarks') {
    return null;
  }
  return { userId, postId };
}

// ============================================================================
// Messages Route Helpers
// ============================================================================

/** The direct-message conversation with one counterparty: `/messages/{pubky}`. */
export function getDmConversationRoute(counterpartyPubky: string): string {
  return `${APP_ROUTES.MESSAGES}/${counterpartyPubky}`;
}

/**
 * Matches `/messages/[pubky]` and returns its param, or `null` for any other
 * path. Shape-only matching — identifier validation is the caller's concern
 * (mirrors `matchPostRoute`).
 */
export function matchDmConversationRoute(pathname: string): { counterpartyPubky: string } | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'messages' || segments.length !== 2) {
    return null;
  }
  return { counterpartyPubky: segments[1] };
}

export function getMarketplaceListingRoute(sellerPubky: string, listingId: string): string {
  return `${MARKETPLACE_ROUTES.LISTING}/${sellerPubky}/${listingId}`;
}

export function matchMarketplaceListingRoute(pathname: string): { sellerPubky: string; listingId: string } | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'marketplace' || segments[1] !== 'listing' || segments.length !== 4) {
    return null;
  }
  return { sellerPubky: segments[2], listingId: segments[3] };
}

export function getMarketplaceListingEditRoute(sellerPubky: string, listingId: string): string {
  return `${MARKETPLACE_ROUTES.LISTING}/${sellerPubky}/${listingId}/edit`;
}

export function getMarketplaceShopRoute(sellerPubky: string): string {
  return `${MARKETPLACE_ROUTES.SHOP}/${sellerPubky}`;
}

export function getMarketplaceDropRoute(sellerPubky: string, dropId: string): string {
  return `${MARKETPLACE_ROUTES.DROP}/${sellerPubky}/${dropId}`;
}

export function matchMarketplaceDropRoute(pathname: string): { sellerPubky: string; dropId: string } | null {
  if (pathname.startsWith('//') || !pathname.startsWith('/') || /^[a-z][a-z\d+\-.]*:/i.test(pathname)) {
    return null;
  }
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPathname.split('/').some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  const segments = decodedPathname.split('/').filter(Boolean);
  if (segments[0] !== 'marketplace' || segments[1] !== 'drop' || segments.length !== 4) {
    return null;
  }
  return { sellerPubky: segments[2], dropId: segments[3] };
}

export function matchMarketplaceShopRoute(pathname: string): { sellerPubky: string } | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'marketplace' || segments[1] !== 'shop' || segments.length !== 3) {
    return null;
  }
  return { sellerPubky: segments[2] };
}

// ============================================================================
// Navigation Active State
// ============================================================================

type NavItemActiveConfig = {
  href: string;
  activePrefix?: string;
};

/**
 * Returns whether a pathname should highlight a primary nav item.
 *
 * Uses `activePrefix` when set (e.g. Settings → any `/settings/*` route),
 * otherwise falls back to exact href match and sub-routes under `href`.
 */
export function isNavItemActive(pathname: string, item: NavItemActiveConfig): boolean {
  const activePath = item.activePrefix ?? item.href;
  return pathname === activePath || pathname.startsWith(`${activePath}/`);
}

/**
 * Returns the canonical profile URL for a given user.
 *
 * When the target pubky belongs to the logged-in user, the static own-profile
 * route (`/profile`) is returned. That route renders the Notifications-first
 * own-profile view, keeping the highlighted tab and the rendered content in
 * sync. For every other user the dynamic `/profile/{pubky}` route is used.
 *
 * Prefer this over hardcoding `/profile/${pubky}` for any link that might point
 * at the current user (post headers, mentions, search results, etc.) to avoid
 * the own-profile tab/content mismatch where `/profile/{ownPubky}` renders Posts
 * while the Notifications tab is highlighted.
 *
 * @param pubky - The target user's (prefix-stripped) pubky
 * @param currentUserPubky - The logged-in user's pubky, if any
 * @returns `/profile` for the logged-in user, otherwise `/profile/{pubky}`
 */
export function getUserProfileUrl(pubky: string, currentUserPubky?: string | null): string {
  if (currentUserPubky && pubky === currentUserPubky) {
    return APP_ROUTES.PROFILE;
  }

  return `/profile/${pubky}`;
}
