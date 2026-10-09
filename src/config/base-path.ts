import { getDefaultUrl } from '@/config/metadata';
import { prefixWithBasePath, stripBasePath } from '@/libs/base-path/base-path';
import { Env } from '@/libs/env/env';

/**
 * Mount path the Shop is served under (`''` when served from the origin root).
 * Read per call rather than captured at import, so one artifact holds a single
 * baked value and tests can exercise both states.
 */
export function getBasePath(): string {
  return Env.NEXT_PUBLIC_BASE_PATH;
}

/**
 * Prefix an app-absolute path with the mount path. Use it for every URL the
 * Next.js router does not rewrite for us: `fetch('/api/...')`, `<img src>`,
 * `<video src>`, CSS `url()`, metadata icons and `window.location` targets.
 * `next/link`, `router.push` and `next/image` loaders handle it themselves.
 */
export function withBasePath(path: string): string {
  return prefixWithBasePath(getBasePath(), path);
}

/** The pathname without the mount path (what `usePathname()` reports). */
export function withoutBasePath(pathname: string): string {
  return stripBasePath(getBasePath(), pathname);
}

/**
 * The Shop's public base URL: the configured site origin (`PUBKY_RUNTIME_DEFAULT_URL`) plus
 * the mount path. `PUBKY_RUNTIME_DEFAULT_URL` stays an origin; the mount path is appended
 * here so canonical, share and structured-data URLs point at the mounted Shop.
 */
export function getShopBaseUrl(): string {
  return `${getDefaultUrl()}${getBasePath()}`;
}
