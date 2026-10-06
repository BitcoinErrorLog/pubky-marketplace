import { afterEach, describe, expect, it } from 'vitest';
import { setSocialHost } from '@/test-utils/social-host';
import {
  APP_ROUTES,
  AUTH_ROUTES,
  AUTHENTICATED_ROUTES,
  getCollectionRoute,
  getMarketplaceAddressSettingsRoute,
  getMarketplaceListingEditRoute,
  getMarketplaceListingRoute,
  getMarketplacePaymentSettingsRoute,
  getMarketplaceShopRoute,
  getProfileRoute,
  getShopHomeRoute,
  getUserProfileUrl,
  isCollectionsOverviewRoute,
  isCoreExploreRoute,
  isDynamicPublicRoute,
  isLogoLandingRoute,
  isNavItemActive,
  isPostRoute,
  isPublicExploreRoute,
  LOGO_LANDING_ROUTES,
  MARKETPLACE_ROUTES,
  matchesAllowedRoute,
  matchMarketplaceListingRoute,
  matchMarketplaceShopRoute,
  matchPostRoute,
  matchSingleCollectionRoute,
  ONBOARDING_ROUTES,
  PROFILE_ROUTES,
  PUBLIC_ROUTES,
  SETTINGS_ROUTES,
  UNAUTHENTICATED_ROUTES,
} from './routes';

describe('isDynamicPublicRoute', () => {
  describe('invite routes', () => {
    it('returns true for invite code route', () => {
      expect(isDynamicPublicRoute('/invite/abcdefghijkl')).toBe(true);
    });

    it('returns false for base invite route', () => {
      expect(isDynamicPublicRoute('/invite')).toBe(false);
    });

    it('returns false for invite route with extra segments', () => {
      expect(isDynamicPublicRoute('/invite/abcdefghijkl/extra')).toBe(false);
    });
  });

  describe('post routes', () => {
    it('returns true for valid single post route', () => {
      expect(isDynamicPublicRoute('/post/abc123/xyz789')).toBe(true);
    });

    it('returns true for post route with long pubky', () => {
      const longPubky = 'gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo';
      expect(isDynamicPublicRoute(`/post/${longPubky}/0034BBBDFK83G`)).toBe(true);
    });

    it('returns false for incomplete post route (missing postId)', () => {
      expect(isDynamicPublicRoute('/post/abc123')).toBe(false);
    });

    it('returns false for base post route', () => {
      expect(isDynamicPublicRoute('/post')).toBe(false);
    });

    it('returns false for post route with extra segments', () => {
      expect(isDynamicPublicRoute('/post/abc123/xyz789/extra')).toBe(false);
    });
  });

  describe('profile routes', () => {
    it('returns true for profile with long pubky', () => {
      const longPubky = 'gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo';
      expect(isDynamicPublicRoute(`/profile/${longPubky}`)).toBe(true);
    });

    it('returns false for profile with pubky and legacy posts sub-route (redirected at edge)', () => {
      const longPubky = 'gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo';
      expect(isDynamicPublicRoute(`/profile/${longPubky}/posts`)).toBe(false);
    });

    it('returns false for profile with pubky and other sub-routes', () => {
      const longPubky = 'gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo';
      expect(isDynamicPublicRoute(`/profile/${longPubky}/followers`)).toBe(false);
      expect(isDynamicPublicRoute(`/profile/${longPubky}/following`)).toBe(false);
      expect(isDynamicPublicRoute(`/profile/${longPubky}/friends`)).toBe(false);
      expect(isDynamicPublicRoute(`/profile/${longPubky}/replies`)).toBe(false);
      expect(isDynamicPublicRoute(`/profile/${longPubky}/tagged`)).toBe(false);
    });

    it('returns false for own profile sub-routes', () => {
      expect(isDynamicPublicRoute('/profile/posts')).toBe(false);
      expect(isDynamicPublicRoute('/profile/replies')).toBe(false);
      expect(isDynamicPublicRoute('/profile/followers')).toBe(false);
      expect(isDynamicPublicRoute('/profile/following')).toBe(false);
      expect(isDynamicPublicRoute('/profile/friends')).toBe(false);
      expect(isDynamicPublicRoute('/profile/tagged')).toBe(false);
      expect(isDynamicPublicRoute('/profile/notifications')).toBe(false);
      expect(isDynamicPublicRoute('/profile/profile')).toBe(false);
    });

    it('returns false for base profile route', () => {
      expect(isDynamicPublicRoute('/profile')).toBe(false);
    });

    it('returns false for segments that are not valid pubky format', () => {
      // Pubky must be exactly 52 lowercase alphanumeric characters
      expect(isDynamicPublicRoute('/profile/shortname')).toBe(false);
      expect(isDynamicPublicRoute('/profile/12345678901234567890')).toBe(false); // 20 chars
      expect(isDynamicPublicRoute('/profile/123456789012345678901234567890123456789012345678901')).toBe(false); // 51 chars
      expect(isDynamicPublicRoute('/profile/12345678901234567890123456789012345678901234567890123')).toBe(false); // 53 chars
    });

    it('returns false for 52-char segment with invalid characters', () => {
      // Uppercase characters are invalid
      expect(isDynamicPublicRoute('/profile/GUJX6QD8KSYDH1MAKDPHD3BXU351D9B8WAQKA8HFG6Q7HNQKXEXO')).toBe(false);
      // Special characters are invalid
      expect(isDynamicPublicRoute('/profile/gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxex!')).toBe(false);
    });

    it('returns true for valid 52-char lowercase alphanumeric pubky', () => {
      // Valid pubky format: exactly 52 lowercase alphanumeric characters
      const validPubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';
      expect(isDynamicPublicRoute(`/profile/${validPubky}`)).toBe(true);
    });
  });

  describe('collection routes', () => {
    const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';
    const postId = '0034BBBDFK83G';

    it('returns true for a single collection detail route', () => {
      expect(isDynamicPublicRoute(`/collections/${pubky}/${postId}`)).toBe(true);
    });

    it('returns false for the collections overview route', () => {
      expect(isDynamicPublicRoute('/collections')).toBe(false);
    });

    it('returns false for the bookmarks pseudo-collection route', () => {
      expect(isDynamicPublicRoute('/collections/bookmarks')).toBe(false);
    });
  });

  describe('marketplace routes', () => {
    const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';

    it('allows public listing and shop detail routes', () => {
      expect(isDynamicPublicRoute(`/marketplace/listing/${pubky}/boots_01`)).toBe(true);
      expect(isDynamicPublicRoute(`/marketplace/shop/${pubky}`)).toBe(true);
    });

    it('keeps seller tools private', () => {
      expect(isDynamicPublicRoute('/marketplace/sell')).toBe(false);
      expect(isDynamicPublicRoute('/marketplace/dashboard')).toBe(false);
      expect(isDynamicPublicRoute('/marketplace/orders')).toBe(false);
      expect(isDynamicPublicRoute('/marketplace/messages')).toBe(false);
      expect(isDynamicPublicRoute('/marketplace/notifications')).toBe(false);
    });

    it('registers the catalog home as a static public route, not a prefix', () => {
      expect(PUBLIC_ROUTES).toContain(APP_ROUTES.MARKETPLACE);
      expect(PUBLIC_ROUTES.includes('/marketplace')).toBe(true);
      expect(PUBLIC_ROUTES.includes('/marketplace/orders')).toBe(false);
      expect(PUBLIC_ROUTES.includes('/marketplace/sell')).toBe(false);
    });
  });

  describe('marketplace drops', () => {
    it('keeps the drops index public and leaves deeper drops paths gated', () => {
      expect(isDynamicPublicRoute('/marketplace/drops')).toBe(true);
      expect(isDynamicPublicRoute('/marketplace/drops/example-id')).toBe(false);
      expect(isDynamicPublicRoute('/marketplace/sell/drops')).toBe(false);
    });
  });

  describe('other routes', () => {
    it('returns false for home route', () => {
      expect(isDynamicPublicRoute('/home')).toBe(false);
    });

    it('returns false for root route', () => {
      expect(isDynamicPublicRoute('/')).toBe(false);
    });

    it('returns false for settings route', () => {
      expect(isDynamicPublicRoute('/settings')).toBe(false);
    });

    it('returns false for search route', () => {
      expect(isDynamicPublicRoute('/search')).toBe(false);
    });

    it('returns false for feed route', () => {
      expect(isDynamicPublicRoute('/feed')).toBe(false);
    });

    it('returns false for onboarding routes', () => {
      expect(isDynamicPublicRoute('/onboarding')).toBe(false);
      expect(isDynamicPublicRoute('/onboarding/profile')).toBe(false);
    });
  });
});

describe('getMarketplaceAddressSettingsRoute', () => {
  it.each([
    'https://evil.example/drop',
    '//evil.example/drop',
    'javascript:alert(1)',
    '/marketplace/drop/x',
    '/marketplace/drop/%2e%2e',
  ])('rejects unsafe return target %s', (returnTo) => {
    expect(getMarketplaceAddressSettingsRoute(returnTo)).toBe('/marketplace/settings/addresses');
  });
});

describe('getMarketplacePaymentSettingsRoute', () => {
  const seller = 'y'.repeat(52);
  const editPath = getMarketplaceListingEditRoute(seller, 'boots_01');

  it('attaches the listing composer return path', () => {
    expect(getMarketplacePaymentSettingsRoute(MARKETPLACE_ROUTES.SELL)).toBe(
      '/marketplace/settings?returnTo=%2Fmarketplace%2Fsell',
    );
    expect(getMarketplacePaymentSettingsRoute(editPath)).toBe(
      `/marketplace/settings?returnTo=${encodeURIComponent(editPath)}`,
    );
  });

  it.each([
    'https://evil.example/sell',
    '//evil.example/sell',
    'javascript:alert(1)',
    '/marketplace/settings',
    '/marketplace/listing/%2e%2e/edit',
    '/marketplace/drop/x',
  ])('rejects unsafe return target %s', (returnTo) => {
    expect(getMarketplacePaymentSettingsRoute(returnTo)).toBe('/marketplace/settings');
  });
});

describe('matchesAllowedRoute', () => {
  it('allows explore sub-routes when explore prefix restriction is disabled', () => {
    expect(
      matchesAllowedRoute('/collections/bookmarks', APP_ROUTES.COLLECTIONS, { restrictExploreSubRoutes: false }),
    ).toBe(true);
    expect(matchesAllowedRoute('/home/trending', APP_ROUTES.HOME, { restrictExploreSubRoutes: false })).toBe(true);
  });

  it('blocks explore sub-routes when explore prefix restriction is enabled', () => {
    expect(matchesAllowedRoute('/collections', APP_ROUTES.COLLECTIONS, { restrictExploreSubRoutes: true })).toBe(true);
    expect(
      matchesAllowedRoute('/collections/bookmarks', APP_ROUTES.COLLECTIONS, { restrictExploreSubRoutes: true }),
    ).toBe(false);
    expect(matchesAllowedRoute('/home/trending', APP_ROUTES.HOME, { restrictExploreSubRoutes: true })).toBe(false);
  });

  it('covers Inventory Studio automations via the /marketplace allowed prefix', () => {
    expect(MARKETPLACE_ROUTES.INVENTORY_AUTOMATIONS).toBe('/marketplace/dashboard/inventory/automations');
    expect(matchesAllowedRoute(MARKETPLACE_ROUTES.INVENTORY_AUTOMATIONS, APP_ROUTES.MARKETPLACE)).toBe(true);
  });

  it('keeps prefix matching for non-explore allowed routes when explore prefix restriction is enabled', () => {
    expect(
      matchesAllowedRoute('/onboarding/profile', ONBOARDING_ROUTES.PROFILE, { restrictExploreSubRoutes: true }),
    ).toBe(true);
    expect(matchesAllowedRoute('/onboarding', ONBOARDING_ROUTES.INSTALL, { restrictExploreSubRoutes: true })).toBe(
      false,
    );
  });
});

function isRouteAccessible(
  pathname: string,
  allowedRoutes: readonly string[],
  restrictExploreSubRoutes: boolean,
): boolean {
  return allowedRoutes.some((route) => matchesAllowedRoute(pathname, route, { restrictExploreSubRoutes }));
}

describe('route access matrix', () => {
  it('allows authenticated users to reach collections bookmarks via prefix matching', () => {
    expect(isRouteAccessible('/collections/bookmarks', AUTHENTICATED_ROUTES.allowedRoutes, false)).toBe(true);
  });

  it('blocks guests from collections bookmarks while allowing the overview', () => {
    expect(isRouteAccessible('/collections', UNAUTHENTICATED_ROUTES.allowedRoutes, true)).toBe(true);
    expect(isRouteAccessible('/collections/bookmarks', UNAUTHENTICATED_ROUTES.allowedRoutes, true)).toBe(false);
  });

  it('allows marketplace browsing while blocking guest seller tools', () => {
    expect(isRouteAccessible('/marketplace', UNAUTHENTICATED_ROUTES.allowedRoutes, true)).toBe(true);
    expect(isRouteAccessible('/marketplace/sell', UNAUTHENTICATED_ROUTES.allowedRoutes, true)).toBe(false);
    expect(isRouteAccessible('/marketplace/sell', AUTHENTICATED_ROUTES.allowedRoutes, false)).toBe(true);
  });

  it('allows guests to reach single collection pages via dynamic public route, not allowedRoutes prefix', () => {
    const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';
    const pathname = `/collections/${pubky}/0034BBBDFK83G`;

    expect(isDynamicPublicRoute(pathname)).toBe(true);
    expect(isRouteAccessible(pathname, UNAUTHENTICATED_ROUTES.allowedRoutes, true)).toBe(false);
  });
});

describe('getProfileRoute', () => {
  const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';

  it('returns unchanged own-profile routes when pubky is omitted', () => {
    expect(getProfileRoute(PROFILE_ROUTES.POSTS)).toBe(PROFILE_ROUTES.POSTS);
  });

  it('uses base profile URL for another user posts tab', () => {
    expect(getProfileRoute(PROFILE_ROUTES.POSTS, pubky)).toBe(`/profile/${pubky}`);
  });

  it('uses base profile URL for another user default profile route', () => {
    expect(getProfileRoute(PROFILE_ROUTES.PROFILE, pubky)).toBe(`/profile/${pubky}`);
  });

  it('uses base profile URL for notifications route with pubky (other user)', () => {
    expect(getProfileRoute(PROFILE_ROUTES.NOTIFICATIONS, pubky)).toBe(`/profile/${pubky}`);
  });

  it('preserves sub-paths other than posts', () => {
    expect(getProfileRoute(PROFILE_ROUTES.FOLLOWERS, pubky)).toBe(`/profile/${pubky}/followers`);
  });
});

describe('getCollectionRoute', () => {
  const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';
  const postId = '0034BBBDFK83G';

  it('joins the collections base route, author pubky, and post id', () => {
    expect(getCollectionRoute(pubky, postId)).toBe(`/collections/${pubky}/${postId}`);
  });

  it('is anchored on APP_ROUTES.COLLECTIONS', () => {
    expect(getCollectionRoute(pubky, postId).startsWith(`${APP_ROUTES.COLLECTIONS}/`)).toBe(true);
  });
});

describe('marketplace route helpers', () => {
  const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';

  it('builds and matches listing routes', () => {
    const pathname = getMarketplaceListingRoute(pubky, 'boots_01');
    expect(pathname).toBe(`/marketplace/listing/${pubky}/boots_01`);
    expect(matchMarketplaceListingRoute(pathname)).toEqual({ sellerPubky: pubky, listingId: 'boots_01' });
    expect(matchMarketplaceListingRoute('/marketplace/listing/incomplete')).toBeNull();
  });

  it('builds and matches shop routes', () => {
    const pathname = getMarketplaceShopRoute(pubky);
    expect(pathname).toBe(`/marketplace/shop/${pubky}`);
    expect(matchMarketplaceShopRoute(pathname)).toEqual({ sellerPubky: pubky });
    expect(matchMarketplaceShopRoute('/marketplace/shop')).toBeNull();
  });
});

describe('isCollectionsOverviewRoute', () => {
  it('returns true only for the exact /collections path', () => {
    expect(isCollectionsOverviewRoute(APP_ROUTES.COLLECTIONS)).toBe(true);
    expect(isCollectionsOverviewRoute('/collections')).toBe(true);
  });

  it('returns false for bookmarks, single collections, and unrelated paths', () => {
    const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';

    expect(isCollectionsOverviewRoute('/collections/bookmarks')).toBe(false);
    expect(isCollectionsOverviewRoute(`/collections/${pubky}/0034BBBDFK83G`)).toBe(false);
    expect(isCollectionsOverviewRoute('/collections/')).toBe(false);
    expect(isCollectionsOverviewRoute('/home')).toBe(false);
  });
});

describe('matchSingleCollectionRoute', () => {
  const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';
  const postId = '0034BBBDFK83G';

  it('extracts userId and postId from a single collection route', () => {
    expect(matchSingleCollectionRoute(`/collections/${pubky}/${postId}`)).toEqual({ userId: pubky, postId });
  });

  it('returns null for the bookmarks pseudo-collection route', () => {
    expect(matchSingleCollectionRoute('/collections/bookmarks')).toBeNull();
    expect(matchSingleCollectionRoute('/collections/bookmarks/extra')).toBeNull();
  });

  it('returns null for the overview route and wrong segment counts', () => {
    expect(matchSingleCollectionRoute('/collections')).toBeNull();
    expect(matchSingleCollectionRoute(`/collections/${pubky}`)).toBeNull();
    expect(matchSingleCollectionRoute(`/collections/${pubky}/${postId}/extra`)).toBeNull();
  });

  it('returns null for unrelated routes', () => {
    expect(matchSingleCollectionRoute('/home')).toBeNull();
    expect(matchSingleCollectionRoute(`/post/${pubky}/${postId}`)).toBeNull();
  });
});

describe('matchPostRoute', () => {
  const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';
  const postId = '0034BBBDFK83G';

  it('extracts userId and postId from a single post route', () => {
    expect(matchPostRoute(`/post/${pubky}/${postId}`)).toEqual({ userId: pubky, postId });
  });

  it('handles trailing slashes', () => {
    expect(matchPostRoute(`/post/${pubky}/${postId}/`)).toEqual({ userId: pubky, postId });
  });

  it('returns null for wrong segment counts', () => {
    expect(matchPostRoute('/post')).toBeNull();
    expect(matchPostRoute(`/post/${pubky}`)).toBeNull();
    expect(matchPostRoute(`/post/${pubky}/${postId}/extra`)).toBeNull();
  });

  it('returns null for unrelated routes', () => {
    expect(matchPostRoute('/home')).toBeNull();
    expect(matchPostRoute(`/collections/${pubky}/${postId}`)).toBeNull();
  });
});

describe('isNavItemActive', () => {
  it('matches exact href when activePrefix is omitted', () => {
    expect(isNavItemActive('/home', { href: APP_ROUTES.HOME })).toBe(true);
    expect(isNavItemActive('/hot', { href: APP_ROUTES.HOT })).toBe(true);
    expect(isNavItemActive('/search', { href: APP_ROUTES.HOT })).toBe(false);
  });

  it('matches sub-routes under href when activePrefix is omitted', () => {
    expect(isNavItemActive('/hot/trending', { href: APP_ROUTES.HOT })).toBe(true);
  });

  it('matches exact and nested routes under activePrefix', () => {
    const collectionsItem = { href: APP_ROUTES.COLLECTIONS, activePrefix: APP_ROUTES.COLLECTIONS };

    expect(isNavItemActive('/collections', collectionsItem)).toBe(true);
    expect(isNavItemActive('/collections/bookmarks', collectionsItem)).toBe(true);
    expect(isNavItemActive('/collections/other', collectionsItem)).toBe(true);
  });

  it('highlights settings from default account href using settings prefix', () => {
    const settingsItem = { href: SETTINGS_ROUTES.ACCOUNT, activePrefix: APP_ROUTES.SETTINGS };

    expect(isNavItemActive('/settings/account', settingsItem)).toBe(true);
    expect(isNavItemActive('/settings/notifications', settingsItem)).toBe(true);
    expect(isNavItemActive('/settings/edit', settingsItem)).toBe(true);
    expect(isNavItemActive('/home', settingsItem)).toBe(false);
  });
});

describe('getUserProfileUrl', () => {
  const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';
  const otherPubky = 'gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo';

  it('returns the static own-profile route when the pubky is the current user', () => {
    expect(getUserProfileUrl(pubky, pubky)).toBe('/profile');
  });

  it('returns the dynamic profile route for another user', () => {
    expect(getUserProfileUrl(otherPubky, pubky)).toBe(`/profile/${otherPubky}`);
  });

  it('returns the dynamic profile route when there is no current user', () => {
    expect(getUserProfileUrl(pubky)).toBe(`/profile/${pubky}`);
    expect(getUserProfileUrl(pubky, null)).toBe(`/profile/${pubky}`);
  });
});

describe('isPostRoute', () => {
  it('returns true for single post pages', () => {
    const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';
    expect(isPostRoute(`/post/${pubky}/0034BBBDFK83G`)).toBe(true);
  });

  it('returns false for non-post paths', () => {
    expect(isPostRoute('/post')).toBe(false);
    expect(isPostRoute('/post/user-only')).toBe(false);
    expect(isPostRoute('/home')).toBe(false);
  });
});

describe('isCoreExploreRoute', () => {
  it('returns true for core logged-out explore routes', () => {
    expect(isCoreExploreRoute('/home')).toBe(true);
    expect(isCoreExploreRoute('/hot')).toBe(true);
    expect(isCoreExploreRoute('/search')).toBe(true);
    expect(isCoreExploreRoute('/collections')).toBe(true);
  });

  it('returns false for dynamic public and protected routes', () => {
    const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';

    expect(isCoreExploreRoute(`/post/${pubky}/0034BBBDFK83G`)).toBe(false);
    expect(isCoreExploreRoute(`/profile/${pubky}`)).toBe(false);
    expect(isCoreExploreRoute(`/collections/${pubky}/0034BBBDFK83G`)).toBe(false);
    expect(isCoreExploreRoute('/collections/bookmarks')).toBe(false);
    expect(isCoreExploreRoute('/bookmarks')).toBe(false);
    expect(isCoreExploreRoute('/feed/custom-feed')).toBe(false);
    expect(isCoreExploreRoute('/settings/account')).toBe(false);
  });
});

describe('isPublicExploreRoute', () => {
  it('returns true for core explore routes and dynamic post/profile/collection pages', () => {
    const pubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzber7aezq6ror5a91j7dy';

    expect(isPublicExploreRoute('/home')).toBe(true);
    expect(isPublicExploreRoute('/hot')).toBe(true);
    expect(isPublicExploreRoute('/search')).toBe(true);
    expect(isPublicExploreRoute('/collections')).toBe(true);
    expect(isPublicExploreRoute(`/post/${pubky}/0034BBBDFK83G`)).toBe(true);
    expect(isPublicExploreRoute(`/profile/${pubky}`)).toBe(true);
    expect(isPublicExploreRoute(`/collections/${pubky}/0034BBBDFK83G`)).toBe(true);
  });

  it('returns false for protected routes', () => {
    expect(isPublicExploreRoute('/bookmarks')).toBe(false);
    expect(isPublicExploreRoute('/collections/bookmarks')).toBe(false);
    expect(isPublicExploreRoute('/feed/custom-feed')).toBe(false);
    expect(isPublicExploreRoute('/settings/account')).toBe(false);
    expect(isPublicExploreRoute('/profile/posts')).toBe(false);
    expect(isPublicExploreRoute('/share')).toBe(false);
    expect(isPublicExploreRoute('/who-to-follow')).toBe(false);
  });
});

describe('isLogoLandingRoute', () => {
  it('returns true for all logo landing routes', () => {
    for (const route of LOGO_LANDING_ROUTES) {
      expect(isLogoLandingRoute(route)).toBe(true);
    }
  });

  it('returns true for every onboarding route', () => {
    for (const route of Object.values(ONBOARDING_ROUTES)) {
      expect(isLogoLandingRoute(route)).toBe(true);
    }
  });

  it('returns true for every auth route', () => {
    for (const route of Object.values(AUTH_ROUTES)) {
      expect(isLogoLandingRoute(route)).toBe(true);
    }
  });

  it('returns false for app and explore routes', () => {
    expect(isLogoLandingRoute('/home')).toBe(false);
    expect(isLogoLandingRoute('/hot')).toBe(false);
    expect(isLogoLandingRoute('/bookmarks')).toBe(false);
    expect(isLogoLandingRoute(null)).toBe(false);
  });
});

describe('getShopHomeRoute', () => {
  afterEach(() => {
    setSocialHost(undefined);
  });

  it('is /home, and the route guard sends signed-in users there, while social link-out is off', () => {
    expect(getShopHomeRoute()).toBe(APP_ROUTES.HOME);
    expect(AUTHENTICATED_ROUTES.redirectTo).toBe(APP_ROUTES.HOME);
  });

  it('is the marketplace, and the route guard sends signed-in users there, while social link-out is on', () => {
    setSocialHost('https://pubky.app');
    expect(getShopHomeRoute()).toBe(APP_ROUTES.MARKETPLACE);
    expect(AUTHENTICATED_ROUTES.redirectTo).toBe(APP_ROUTES.MARKETPLACE);
  });

  it('stays inside the signed-in allowed routes in both states', () => {
    expect(AUTHENTICATED_ROUTES.allowedRoutes.some((route) => matchesAllowedRoute(getShopHomeRoute(), route))).toBe(
      true,
    );
    setSocialHost('https://pubky.app');
    expect(AUTHENTICATED_ROUTES.allowedRoutes.some((route) => matchesAllowedRoute(getShopHomeRoute(), route))).toBe(
      true,
    );
  });
});
