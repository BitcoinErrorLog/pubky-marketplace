import { describe, expect, it } from 'vitest';
import {
  isValidAssetPrefix,
  isValidBasePath,
  normalizeAssetPrefix,
  normalizeBasePath,
  prefixWithBasePath,
  stripBasePath,
} from './base-path';

describe('isValidBasePath', () => {
  it('accepts the root mount and plain sub-paths', () => {
    expect(isValidBasePath('')).toBe(true);
    expect(isValidBasePath('/shop')).toBe(true);
    expect(isValidBasePath('/shop-app')).toBe(true);
    expect(isValidBasePath('/apps/shop_v2')).toBe(true);
  });

  it('rejects trailing slashes, relative and traversal segments, and reserved characters', () => {
    expect(isValidBasePath('/')).toBe(false);
    expect(isValidBasePath('/shop/')).toBe(false);
    expect(isValidBasePath('shop')).toBe(false);
    expect(isValidBasePath('//shop')).toBe(false);
    expect(isValidBasePath('/shop//app')).toBe(false);
    expect(isValidBasePath('/a/../b')).toBe(false);
    expect(isValidBasePath('/a/./b')).toBe(false);
    expect(isValidBasePath('/shop?x=1')).toBe(false);
    expect(isValidBasePath('/shop#x')).toBe(false);
    expect(isValidBasePath('/sh op')).toBe(false);
    expect(isValidBasePath('/shop"onload=1')).toBe(false);
  });
});

describe('isValidAssetPrefix', () => {
  it('accepts a path or an absolute http(s) URL without trailing slash', () => {
    expect(isValidAssetPrefix('/shop-static')).toBe(true);
    expect(isValidAssetPrefix('https://cdn.example.com')).toBe(true);
    expect(isValidAssetPrefix('https://cdn.example.com/shop')).toBe(true);
    expect(isValidAssetPrefix('http://localhost:3001')).toBe(true);
  });

  it('rejects empty, trailing slash, query, fragment and other schemes', () => {
    expect(isValidAssetPrefix('')).toBe(false);
    expect(isValidAssetPrefix('/shop-static/')).toBe(false);
    expect(isValidAssetPrefix('https://cdn.example.com/')).toBe(false);
    expect(isValidAssetPrefix('https://cdn.example.com?x=1')).toBe(false);
    expect(isValidAssetPrefix('https://cdn.example.com#x')).toBe(false);
    expect(isValidAssetPrefix('ftp://cdn.example.com')).toBe(false);
    expect(isValidAssetPrefix('cdn.example.com')).toBe(false);
  });
});

describe('normalize helpers', () => {
  it('treats blank values as unset', () => {
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath('  ')).toBe('');
    expect(normalizeBasePath(' /shop ')).toBe('/shop');
    expect(normalizeAssetPrefix(undefined)).toBeUndefined();
    expect(normalizeAssetPrefix('   ')).toBeUndefined();
    expect(normalizeAssetPrefix(' /shop-static ')).toBe('/shop-static');
  });
});

describe('prefixWithBasePath', () => {
  it('returns the input unchanged for the root mount', () => {
    expect(prefixWithBasePath('', '/api/feedback')).toBe('/api/feedback');
    expect(prefixWithBasePath('', '/images/x.webp')).toBe('/images/x.webp');
  });

  it('prefixes app-absolute paths, keeping query and fragment', () => {
    expect(prefixWithBasePath('/shop', '/api/feedback')).toBe('/shop/api/feedback');
    expect(prefixWithBasePath('/shop', '/api/og-metadata?url=a')).toBe('/shop/api/og-metadata?url=a');
    expect(prefixWithBasePath('/shop', '/')).toBe('/shop/');
  });

  it('leaves absolute, protocol-relative, relative and already-prefixed values alone', () => {
    expect(prefixWithBasePath('/shop', 'https://example.com/x')).toBe('https://example.com/x');
    expect(prefixWithBasePath('/shop', '//cdn.example.com/x')).toBe('//cdn.example.com/x');
    expect(prefixWithBasePath('/shop', 'images/x.webp')).toBe('images/x.webp');
    expect(prefixWithBasePath('/shop', 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(prefixWithBasePath('/shop', '#section')).toBe('#section');
    expect(prefixWithBasePath('/shop', '/shop')).toBe('/shop');
    expect(prefixWithBasePath('/shop', '/shop/api/x')).toBe('/shop/api/x');
    expect(prefixWithBasePath('/shop', '/shop?a=1')).toBe('/shop?a=1');
  });

  it('does not mistake a sibling path that merely starts with the mount path for a prefixed one', () => {
    expect(prefixWithBasePath('/shop', '/shopping/cart')).toBe('/shop/shopping/cart');
  });

  it('is idempotent', () => {
    const once = prefixWithBasePath('/shop', '/api/x');
    expect(prefixWithBasePath('/shop', once)).toBe(once);
  });
});

describe('stripBasePath', () => {
  it('inverts the prefix', () => {
    expect(stripBasePath('', '/marketplace')).toBe('/marketplace');
    expect(stripBasePath('/shop', '/shop/marketplace')).toBe('/marketplace');
    expect(stripBasePath('/shop', '/shop')).toBe('/');
    expect(stripBasePath('/shop', '/other')).toBe('/other');
    expect(stripBasePath('/shop', '/shopping')).toBe('/shopping');
  });
});
