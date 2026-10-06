'use client';

import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import { getHomeserver, getHomeserverUrl } from '@/config/network';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  getMarketplaceMediaOwner,
  isValidMarketplaceMediaUri,
  resolveMarketplaceMediaUrl,
} from '@/libs/commerce/media-url';

const OWNER_CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_MEDIA_CACHE_TTL_MS = 30 * 1000;
const OWNER_CACHE_LIMIT = 100;
const MEDIA_CACHE_LIMIT = 100;

type CacheEntry = { value: string | null; expiresAt: number };

const ownerCache = new Map<string, CacheEntry>();
const ownerRequests = new Map<string, Promise<string | null>>();
const mediaCache = new Map<string, CacheEntry>();
const mediaRequests = new Map<string, Promise<string | null>>();
/** Live `<img>` / hook holders of a blob URL. Revoke only when this hits 0 and the cache dropped the URL. */
const blobUrlRefs = new Map<string, number>();

function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function isBlobUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith('blob:');
}

function retainBlobUrl(url: string | null | undefined): void {
  if (!isBlobUrl(url)) return;
  blobUrlRefs.set(url, (blobUrlRefs.get(url) ?? 0) + 1);
}

function mediaCacheHolds(url: string): boolean {
  const now = Date.now();
  for (const entry of mediaCache.values()) {
    if (entry.value === url && entry.expiresAt > now) return true;
  }
  return false;
}

function maybeRevokeOrphanBlobUrl(url: string | null | undefined): void {
  if (!isBlobUrl(url)) return;
  if ((blobUrlRefs.get(url) ?? 0) > 0) return;
  if (mediaCacheHolds(url)) return;
  URL.revokeObjectURL(url);
}

function releaseBlobUrl(url: string | null | undefined): void {
  if (!isBlobUrl(url)) return;
  const next = (blobUrlRefs.get(url) ?? 0) - 1;
  if (next > 0) {
    blobUrlRefs.set(url, next);
    return;
  }
  blobUrlRefs.delete(url);
  maybeRevokeOrphanBlobUrl(url);
}

function useRetainedBlobUrls(urls: readonly (string | null)[]): void {
  const key = urls.map((url) => url ?? '').join('\u0000');
  useEffect(() => {
    for (const url of urls) retainBlobUrl(url);
    return () => {
      for (const url of urls) releaseBlobUrl(url);
    };
    // `urls` is rebuilt each render; `key` is the identity of the blob set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

function getCached(cache: Map<string, CacheEntry>, key: string): string | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    maybeRevokeOrphanBlobUrl(entry.value);
    return undefined;
  }
  return entry.value;
}

function cacheMedia(uri: string, value: string | null): void {
  const previous = mediaCache.get(uri)?.value;
  mediaCache.set(uri, {
    value,
    expiresAt: Date.now() + (value === null ? NEGATIVE_MEDIA_CACHE_TTL_MS : OWNER_CACHE_TTL_MS),
  });
  if (previous && previous !== value) maybeRevokeOrphanBlobUrl(previous);
  while (mediaCache.size > MEDIA_CACHE_LIMIT) {
    const oldestUri = mediaCache.keys().next().value;
    if (!oldestUri) return;
    const oldest = mediaCache.get(oldestUri)?.value;
    mediaCache.delete(oldestUri);
    maybeRevokeOrphanBlobUrl(oldest);
  }
}

async function getOwnerHomeserver(owner: string): Promise<string | null> {
  const cached = getCached(ownerCache, owner);
  if (cached !== undefined) return cached;

  const existing = ownerRequests.get(owner);
  if (existing) return await existing;

  const request = CommerceController.getMarketplaceMediaOwnerHomeserver(owner)
    .then((homeserver) => {
      ownerCache.set(owner, {
        value: homeserver,
        expiresAt: Date.now() + (homeserver === null ? NEGATIVE_MEDIA_CACHE_TTL_MS : OWNER_CACHE_TTL_MS),
      });
      while (ownerCache.size > OWNER_CACHE_LIMIT) {
        const oldestOwner = ownerCache.keys().next().value;
        if (!oldestOwner) break;
        ownerCache.delete(oldestOwner);
      }
      return homeserver;
    })
    .finally(() => ownerRequests.delete(owner));
  ownerRequests.set(owner, request);
  return await request;
}

export async function resolveMarketplaceMediaUrlAsync(uri: string): Promise<string | null> {
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  const owner = getMarketplaceMediaOwner(uri);
  if (!owner) return null;
  if (!isValidMarketplaceMediaUri(uri)) return null;

  const cached = getCached(mediaCache, uri);
  if (cached !== undefined) return cached;
  const existing = mediaRequests.get(uri);
  if (existing) return await existing;

  const request = getOwnerHomeserver(owner)
    .then(async (ownerHomeserver) => {
      if (!ownerHomeserver) {
        cacheMedia(uri, null);
        return null;
      }

      if (ownerHomeserver === getHomeserver()) {
        const url = resolveMarketplaceMediaUrl(uri, getHomeserverUrl());
        cacheMedia(uri, url);
        return url;
      }

      const blob = await CommerceController.fetchMarketplaceMedia(uri);
      const objectUrl = URL.createObjectURL(blob);
      cacheMedia(uri, objectUrl);
      return objectUrl;
    })
    .catch((error) => {
      cacheMedia(uri, null);
      throw error;
    })
    .finally(() => mediaRequests.delete(uri));
  mediaRequests.set(uri, request);
  return await request;
}

export function useMarketplaceMediaUrl(uri: string | null | undefined): string | null {
  const uriKey = uri ?? '';
  const [url, setUrl] = useState(() => (uri ? getSynchronousMediaUrl(uri) : null));
  useRetainedBlobUrls([url]);

  useEffect(() => {
    const currentUri = uriKey || null;
    if (!currentUri) {
      setUrl(null);
      return;
    }

    let active = true;
    void resolveMarketplaceMediaUrlAsync(currentUri)
      .then((resolvedUrl) => {
        if (active) setUrl(resolvedUrl);
      })
      .catch(() => {
        if (active) setUrl(null);
      });

    return () => {
      active = false;
    };
  }, [uriKey]);

  return url;
}

export function useMarketplaceFirstMediaUrl(uris: readonly string[]): string | null {
  const urisKey = uris.join('\u0000');
  const urisRef = useLatest(uris);
  const [url, setUrl] = useState(
    () => uris.map(getSynchronousMediaUrl).find((url): url is string => url !== null) ?? null,
  );
  useRetainedBlobUrls([url]);

  useEffect(() => {
    const urisSnapshot = urisRef.current;
    let active = true;
    if (urisSnapshot.length === 0) {
      setUrl(null);
      return;
    }

    void Promise.all(urisSnapshot.map((uri) => resolveMarketplaceMediaUrlAsync(uri)))
      .then((resolvedUrls) => {
        if (active) setUrl(resolvedUrls.find((resolvedUrl) => resolvedUrl !== null) ?? null);
      })
      .catch(() => {
        if (active) setUrl(null);
      });

    return () => {
      active = false;
    };
  }, [urisKey, urisRef]);

  return url;
}

export function useMarketplaceMediaUrls(uris: readonly string[]): readonly (string | null)[] {
  const urisKey = uris.join('\u0000');
  const urisRef = useLatest(uris);
  const [urls, setUrls] = useState<readonly (string | null)[]>(() => uris.map(getSynchronousMediaUrl));
  useRetainedBlobUrls(urls);

  useEffect(() => {
    const urisSnapshot = urisRef.current;
    let active = true;
    void Promise.all(urisSnapshot.map((uri) => resolveMarketplaceMediaUrlAsync(uri)))
      .then((resolvedUrls) => {
        if (active) setUrls(resolvedUrls);
      })
      .catch(() => {
        if (active) setUrls(urisSnapshot.map(() => null));
      });

    return () => {
      active = false;
    };
  }, [urisKey, urisRef]);

  return urls;
}

export function useMarketplaceFirstMediaUrls(uris: readonly (readonly string[])[]): readonly (string | null)[] {
  const flattened = uris.flat();
  const resolved = useMarketplaceMediaUrls(flattened);
  const result: (string | null)[] = [];
  let offset = 0;
  for (const group of uris) {
    const first = group.map((_, index) => resolved[offset + index]).find((url): url is string => url !== null);
    result.push(first ?? null);
    offset += group.length;
  }
  return result;
}

function isDirectUrl(uri: string): boolean {
  return uri.startsWith('http://') || uri.startsWith('https://');
}

function getSynchronousMediaUrl(uri: string): string | null {
  if (isDirectUrl(uri)) return uri;
  const owner = getMarketplaceMediaOwner(uri);
  if (!owner) return null;
  if (!isValidMarketplaceMediaUri(uri)) return null;
  const ownerHomeserver = getCached(ownerCache, owner);
  if (ownerHomeserver !== getHomeserver()) return null;
  return resolveMarketplaceMediaUrl(uri, getHomeserverUrl());
}

export function clearMarketplaceMediaCache(): void {
  for (const entry of mediaCache.values()) {
    if (entry.value?.startsWith('blob:')) URL.revokeObjectURL(entry.value);
  }
  for (const url of blobUrlRefs.keys()) {
    if (!mediaCacheHolds(url)) URL.revokeObjectURL(url);
  }
  blobUrlRefs.clear();
  ownerCache.clear();
  ownerRequests.clear();
  mediaRequests.clear();
  mediaCache.clear();
}
