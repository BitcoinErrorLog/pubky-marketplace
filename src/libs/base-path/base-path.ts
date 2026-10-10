/**
 * Mount-path support: the Shop can be served under a sub-path of another
 * origin (for example `https://pubky.app/shop`) behind a reverse proxy.
 *
 * Two build-time variables drive it, because Next.js bakes both into the
 * artifact (routes manifest, client bundles) and cannot change them without a
 * rebuild:
 *  - `NEXT_PUBLIC_BASE_PATH`: the mount path (`/shop`). Unset or empty means
 *    the Shop is served from the origin root, exactly as before.
 *  - `NEXT_PUBLIC_ASSET_PREFIX`: optional prefix for `/_next/*` assets. Either
 *    a path (`/shop-static`) or an absolute `http(s)` origin/path for a CDN.
 *    Unset keeps the Next.js default (the base path itself).
 *
 * This module has no `@/` imports so `next.config.ts` can load it.
 */

export const BASE_PATH_ENV_VAR = 'NEXT_PUBLIC_BASE_PATH';
export const ASSET_PREFIX_ENV_VAR = 'NEXT_PUBLIC_ASSET_PREFIX';

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/**
 * A mount path is `''` (root) or `/segment[/segment...]` with no trailing
 * slash, no empty, `.` or `..` segments, and only unreserved URL characters,
 * so it can be spliced into URLs and CSS without escaping.
 */
export function isValidBasePath(value: string): boolean {
  if (value === '') return true;
  if (!value.startsWith('/') || value.endsWith('/')) return false;
  const segments = value.slice(1).split('/');
  return segments.every((segment) => segment !== '.' && segment !== '..' && PATH_SEGMENT.test(segment));
}

/**
 * An asset prefix is a valid mount-style path, or an absolute `http(s)` URL
 * with no query, fragment or trailing slash.
 */
export function isValidAssetPrefix(value: string): boolean {
  if (isValidBasePath(value)) return value !== '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.search !== '' || url.hash !== '' || value.endsWith('/')) return false;
  return url.href === value || url.href === `${value}/`;
}

/** Trim and normalise the raw env value. Blank means "not set" (root mount). */
export function normalizeBasePath(raw: string | undefined): string {
  return raw?.trim() ?? '';
}

export function normalizeAssetPrefix(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Prefix an app-absolute path (`/api/feedback`, `/images/x.webp`) with the mount
 * path. Absolute URLs, protocol-relative URLs, hash/query-only references and
 * paths that already carry the prefix pass through untouched, so the helper is
 * idempotent and safe to apply to values of unknown origin. With an empty mount
 * path it returns its input unchanged.
 */
export function prefixWithBasePath(basePath: string, path: string): string {
  if (basePath === '') return path;
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  if (path === basePath || path.startsWith(`${basePath}/`) || path.startsWith(`${basePath}?`)) return path;
  return `${basePath}${path}`;
}

/** Inverse of {@link prefixWithBasePath} for a pathname the browser reports. */
export function stripBasePath(basePath: string, pathname: string): string {
  if (basePath === '') return pathname;
  if (pathname === basePath) return '/';
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}
