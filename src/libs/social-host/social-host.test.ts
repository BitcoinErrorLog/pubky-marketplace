import { describe, expect, it } from 'vitest';
import { PUBKY_RUNTIME_ENV_NAMES } from '@/libs/runtime-config/runtime-config.schema';
import {
  buildSocialLinkOutRedirects,
  isValidSocialHost,
  parseSocialHost,
  resolveShopOrigins,
  SHOP_DEFAULT_URL_ENV_VAR,
  SOCIAL_LINK_OUT_SOURCES,
  toSocialHostUrl,
} from './social-host';

describe('isValidSocialHost', () => {
  it.each(['https://pubky.app', 'https://staging.pubky.app'])('accepts the exact origin %s', (value) => {
    expect(isValidSocialHost(value, 'production')).toBe(true);
  });

  it.each([
    'https://pubky.app/',
    'https://pubky.app/home',
    'pubky.app',
    'http://pubky.app',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (value) => {
    expect(isValidSocialHost(value, 'production')).toBe(false);
  });

  it('accepts http://localhost only outside production', () => {
    expect(isValidSocialHost('http://localhost:3000', 'development')).toBe(true);
    expect(isValidSocialHost('http://localhost:3000', 'production')).toBe(false);
  });
});

describe('parseSocialHost', () => {
  it('returns undefined when unset or empty', () => {
    expect(parseSocialHost(undefined, 'production', [])).toBeUndefined();
    expect(parseSocialHost('', 'production', [])).toBeUndefined();
  });

  it('returns a valid origin unchanged', () => {
    expect(parseSocialHost('https://staging.pubky.app', 'production', ['https://shop.pubky.app'])).toBe(
      'https://staging.pubky.app',
    );
  });

  it('throws on an invalid value', () => {
    expect(() => parseSocialHost('https://pubky.app/', 'production', [])).toThrow(/NEXT_PUBLIC_SOCIAL_HOST/);
  });

  it("rejects the Shop's own origin, which would redirect every social route to itself", () => {
    expect(() => parseSocialHost('https://shop.pubky.app', 'production', ['https://shop.pubky.app'])).toThrow(
      /not this Shop/,
    );
    expect(() =>
      parseSocialHost('https://pubky-marketplace-staging.vercel.app', 'production', [
        'https://shop.pubky.app',
        'https://pubky-marketplace-staging.vercel.app',
      ]),
    ).toThrow(/redirect to itself/);
  });

  it("rejects the Shop's own origin with or without a leading www. on either side", () => {
    expect(() => parseSocialHost('https://www.shop.pubky.app', 'production', ['https://shop.pubky.app'])).toThrow(
      /not this Shop/,
    );
    expect(() => parseSocialHost('https://shop.pubky.app', 'production', ['https://www.shop.pubky.app'])).toThrow(
      /not this Shop/,
    );
  });

  it('still accepts pubky.app and www.pubky.app when the Shop is at shop.pubky.app', () => {
    for (const shopOrigins of [['https://shop.pubky.app'], ['https://www.shop.pubky.app']]) {
      expect(parseSocialHost('https://pubky.app', 'production', shopOrigins)).toBe('https://pubky.app');
      expect(parseSocialHost('https://www.pubky.app', 'production', shopOrigins)).toBe('https://www.pubky.app');
    }
  });
});

describe('buildSocialLinkOutRedirects', () => {
  it('is empty when link-out is off', () => {
    expect(buildSocialLinkOutRedirects(undefined)).toEqual([]);
  });

  it('keeps profile notifications in the Shop ahead of the social profile redirect', () => {
    const redirects = buildSocialLinkOutRedirects('https://pubky.app');
    const notifications = redirects.findIndex((route) => route.source === '/profile/notifications');
    const profile = redirects.findIndex((route) => route.source === '/profile/:path*');

    expect(redirects[notifications]).toEqual({
      source: '/profile/notifications',
      destination: '/marketplace/notifications',
      permanent: false,
    });
    expect(notifications).toBeLessThan(profile);
  });

  it('sends every social source to the same path on the social host', () => {
    const redirects = buildSocialLinkOutRedirects('https://pubky.app');

    for (const source of SOCIAL_LINK_OUT_SOURCES) {
      expect(redirects).toContainEqual({ source, destination: `https://pubky.app${source}`, permanent: false });
    }
  });
});

describe('toSocialHostUrl', () => {
  it('joins the origin and path', () => {
    expect(toSocialHostUrl('https://pubky.app', '/profile/abc')).toBe('https://pubky.app/profile/abc');
  });
});

describe('resolveShopOrigins', () => {
  it('reads the runtime-config canonical URL by its real variable name', () => {
    expect(SHOP_DEFAULT_URL_ENV_VAR).toBe(PUBKY_RUNTIME_ENV_NAMES.defaultUrl);
  });

  it('collects the configured canonical URL and the Vercel hosts as origins', () => {
    expect(
      resolveShopOrigins({
        PUBKY_RUNTIME_DEFAULT_URL: 'https://shop.pubky.app/marketplace',
        VERCEL_PROJECT_PRODUCTION_URL: 'shop.pubky.app',
        VERCEL_BRANCH_URL: 'pubky-marketplace-git-main.vercel.app',
        VERCEL_URL: 'pubky-marketplace-abc123.vercel.app',
      }),
    ).toEqual([
      'https://shop.pubky.app',
      'https://pubky-marketplace-git-main.vercel.app',
      'https://pubky-marketplace-abc123.vercel.app',
    ]);
  });

  it('is empty when nothing names the Shop, so the upstream default URL never blocks pubky.app', () => {
    expect(resolveShopOrigins({})).toEqual([]);
    expect(resolveShopOrigins({ PUBKY_RUNTIME_DEFAULT_URL: 'not a url' })).toEqual([]);
  });
});
