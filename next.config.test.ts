import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redirects } from './next.config';

type ConfiguredRedirect = Awaited<ReturnType<typeof redirects>>[number];

const SHOP_ORIGIN = 'https://shop.pubky.app';

/**
 * Resolves a request URL against the configured redirects with the same
 * matcher and destination compiler the Next server uses for custom routes
 * (first match wins). Returns the absolute redirect target, or null when no
 * redirect applies.
 */
function resolveRedirect(configured: ConfiguredRedirect[], requestUrl: string): string | null {
  const url = new URL(requestUrl, SHOP_ORIGIN);
  for (const route of configured) {
    const params = getPathMatch(route.source, { strict: true, removeUnnamedParams: true })(url.pathname);
    if (!params) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: route.destination,
      params,
      query: Object.fromEntries(url.searchParams),
    });
    const search = new URLSearchParams(parsedDestination.query as Record<string, string>).toString();
    const origin = parsedDestination.hostname
      ? `${parsedDestination.protocol}//${parsedDestination.hostname}${parsedDestination.port ? `:${parsedDestination.port}` : ''}`
      : SHOP_ORIGIN;
    return `${origin}${parsedDestination.pathname}${search ? `?${search}` : ''}`;
  }
  return null;
}

const SOCIAL_PATHS = [
  '/home',
  '/feed/abc123',
  '/hot',
  '/search',
  '/who-to-follow',
  '/post/o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo/0034A0X7NJ52G',
  '/collections',
  '/collections/bookmarks',
  '/collections/o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo/0034A0X7NJ52G',
  '/profile',
  '/profile/posts',
  '/profile/o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo',
  '/profile/o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo/followers',
  '/settings',
  '/settings/account',
  '/settings/privacy-safety',
];

const SHOP_PATHS = [
  '/marketplace',
  '/marketplace/listing/o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo/abc',
  '/marketplace/settings',
  '/marketplace/notifications',
  '/messages',
  '/messages/o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo',
  '/sign-in',
  '/logout',
  '/onboarding/profile',
  '/copyright',
  '/invite/ABCD-1234',
  '/offline',
  '/share',
  '/homepage',
  '/profiles',
];

describe('Next redirects', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('redirects only the root to the marketplace', async () => {
    const configuredRedirects = await redirects();

    expect(configuredRedirects).toContainEqual({
      source: '/',
      destination: '/marketplace',
      permanent: false,
    });
    expect(configuredRedirects).not.toContainEqual(expect.objectContaining({ source: '/:path*' }));
  });

  describe('social link-out off (NEXT_PUBLIC_SOCIAL_HOST unset)', () => {
    it('keeps every social route in the Shop', async () => {
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', undefined);
      const configured = await redirects();

      expect(configured).toHaveLength(2);
      for (const path of SOCIAL_PATHS) {
        expect(resolveRedirect(configured, path), path).toBeNull();
      }
      expect(resolveRedirect(configured, '/profile/notifications')).toBeNull();
      expect(resolveRedirect(configured, '/profile/abc/posts')).toBe(`${SHOP_ORIGIN}/profile/abc`);
    });

    it('treats an empty value as unset', async () => {
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', '');
      expect(await redirects()).toHaveLength(2);
    });
  });

  describe('social link-out on', () => {
    it('maps every social route 1:1 onto the production social host, query included', async () => {
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://pubky.app');
      const configured = await redirects();

      for (const path of SOCIAL_PATHS) {
        expect(resolveRedirect(configured, path), path).toBe(`https://pubky.app${path}`);
      }
      expect(resolveRedirect(configured, '/search?tags=bitcoin,art')).toBe(
        `https://pubky.app/search?${new URLSearchParams({ tags: 'bitcoin,art' }).toString()}`,
      );
    });

    it('uses temporary redirects only', async () => {
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://pubky.app');
      const socialRedirects = (await redirects()).filter((route) => route.destination.startsWith('https://'));

      expect(socialRedirects.length).toBeGreaterThan(0);
      for (const route of socialRedirects) {
        expect(route.permanent, route.source).toBe(false);
      }
    });

    it('maps staging onto the staging social host', async () => {
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://staging.pubky.app');
      const configured = await redirects();

      expect(resolveRedirect(configured, '/home')).toBe('https://staging.pubky.app/home');
      expect(resolveRedirect(configured, '/profile/abc/tagged')).toBe('https://staging.pubky.app/profile/abc/tagged');
    });

    it('keeps profile notifications in the Shop', async () => {
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://pubky.app');
      expect(resolveRedirect(await redirects(), '/profile/notifications')).toBe(
        `${SHOP_ORIGIN}/marketplace/notifications`,
      );
    });

    it('sends the legacy posts URL to the social host in one hop', async () => {
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://pubky.app');
      expect(resolveRedirect(await redirects(), '/profile/abc/posts')).toBe('https://pubky.app/profile/abc/posts');
    });

    it('leaves marketplace, messages, auth, onboarding and utility routes in the Shop', async () => {
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://pubky.app');
      const configured = await redirects();

      for (const path of SHOP_PATHS) {
        expect(resolveRedirect(configured, path), path).toBeNull();
      }
      expect(resolveRedirect(configured, '/')).toBe(`${SHOP_ORIGIN}/marketplace`);
    });

    it("fails the build when the host is the Shop's configured canonical URL", async () => {
      vi.stubEnv('PUBKY_RUNTIME_DEFAULT_URL', 'https://shop.pubky.app');
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://shop.pubky.app');
      await expect(redirects()).rejects.toThrow(/redirect to itself/);
    });

    it("fails the build when the host is the Shop's canonical URL with a www. prefix", async () => {
      vi.stubEnv('PUBKY_RUNTIME_DEFAULT_URL', 'https://shop.pubky.app');
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://www.shop.pubky.app');
      await expect(redirects()).rejects.toThrow(/redirect to itself/);
    });

    it('fails the build when the host is this Vercel deployment', async () => {
      vi.stubEnv('PUBKY_RUNTIME_DEFAULT_URL', 'https://shop.pubky.app');
      vi.stubEnv('VERCEL_URL', 'pubky-marketplace-staging.vercel.app');
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://pubky-marketplace-staging.vercel.app');
      await expect(redirects()).rejects.toThrow(/redirect to itself/);
    });

    it('builds with the social host when the Shop runs elsewhere', async () => {
      vi.stubEnv('PUBKY_RUNTIME_DEFAULT_URL', 'https://shop.pubky.app');
      vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'shop.pubky.app');
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://pubky.app');
      expect(resolveRedirect(await redirects(), '/home')).toBe('https://pubky.app/home');
    });

    it('fails the build on an invalid host', async () => {
      vi.stubEnv('NEXT_PUBLIC_SOCIAL_HOST', 'https://pubky.app/');
      await expect(redirects()).rejects.toThrow(/NEXT_PUBLIC_SOCIAL_HOST/);
    });
  });
});
