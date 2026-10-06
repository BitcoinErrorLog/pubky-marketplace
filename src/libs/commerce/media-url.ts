import { getHomeserverUrl } from '@/libs/runtime-config/runtime-config';

const PUBKY_PROTOCOL = 'pubky://';
const PUBKY_Z32_LENGTH = 52;
const PUBKY_Z32_PATTERN = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const MARKETPLACE_MEDIA_PATH_PREFIX = '/pub/pubky.app/marketplace/';

export function getMarketplaceMediaOwner(uri: string): string | null {
  if (!uri.startsWith(PUBKY_PROTOCOL)) return null;
  const rest = uri.slice(PUBKY_PROTOCOL.length);
  const owner = rest.slice(0, PUBKY_Z32_LENGTH);
  return PUBKY_Z32_PATTERN.test(owner) ? owner : null;
}

/**
 * Resolves a marketplace media URI to a URL the browser can load directly.
 *
 * Marketplace media files are raw bytes the seller uploaded to their own
 * homeserver under `/pub/pubky.app/marketplace/v1/media/<id>` (see
 * `useListingMediaManager` for the upload side). `/pub/*` paths are publicly
 * readable over the homeserver's plain HTTPS endpoint without authentication;
 * the homeserver identifies the tenant from the `pubky-host` QUERY PARAMETER
 * (its `PubkyHostLayer` checks the `host` header, the `pubky-host` header,
 * then the `pubky-host` query param — only the query param is expressible in
 * an `<img src>`). Verified against the live staging homeserver:
 * `GET https://homeserver.staging.pubky.app/pub/...?pubky-host=<z32>` → 200.
 *
 * @param uri - A `pubky://<z32>/pub/...` media URI (record `media[].url` or an
 *   index `media_urls` entry). Plain http(s) URLs pass through unchanged.
 * @param homeserverBase - The verified homeserver URL for the URI owner.
 * @returns A fetchable URL, or null when the URI has no browser-loadable form.
 */
export function resolveMarketplaceMediaUrl(uri: string, homeserverBase = getHomeserverUrl()): string | null {
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  if (!uri.startsWith(PUBKY_PROTOCOL) || !isValidMarketplaceMediaUri(uri)) return null;

  const rest = uri.slice(PUBKY_PROTOCOL.length);
  const owner = getMarketplaceMediaOwner(uri);
  const path = rest.slice(PUBKY_Z32_LENGTH);
  if (!owner) return null;

  const base = homeserverBase.replace(/\/$/, '');
  return `${base}${path}?pubky-host=${owner}`;
}

export function isValidMarketplaceMediaUri(uri: string): boolean {
  if (!uri.startsWith(PUBKY_PROTOCOL)) return false;
  const rest = uri.slice(PUBKY_PROTOCOL.length);
  const owner = rest.slice(0, PUBKY_Z32_LENGTH);
  const path = rest.slice(PUBKY_Z32_LENGTH);
  if (!PUBKY_Z32_PATTERN.test(owner) || !path.startsWith('/')) return false;
  if ([...path].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    return false;
  }
  if (/[?#\\]/.test(path) || /%(?:2e|2f|5c)/i.test(path)) return false;

  const segments = path.split('/');
  if (segments.some((segment, index) => (index > 0 && segment.length === 0) || segment === '.' || segment === '..')) {
    return false;
  }
  const normalizedPath = new URL(`https://media.invalid${path}`).pathname;
  return normalizedPath.startsWith(MARKETPLACE_MEDIA_PATH_PREFIX);
}
