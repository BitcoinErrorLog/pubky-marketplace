import { Client, resolvePubky } from '@synonymdev/pubky';
import {
  type CommerceListingRecord,
  commerceListingRecordSchema,
  type CommerceShopRecord,
  commerceShopRecordSchema,
  marketplacePublicUriSchema,
} from '@/libs/commerce/marketplace-records';
import { commerceEntityIdSchema, commercePubkySchema } from '@/libs/commerce/transaction-contracts';
import { Logger } from '@/libs/logger/logger';
import { getPkarrRelays } from '@/libs/runtime-config/runtime-config';
import { fetchImageAsDataUri } from './ogData';

/**
 * Server-only fetchers for canonical marketplace records, used by
 * `generateMetadata` and the `opengraph-image` routes. Same constraints as
 * `ogData.ts`: no client/Dexie imports — only the pure record schemas and the
 * runtime config.
 *
 * Records are read from each seller's homeserver through the configured PKARR
 * relays, using the same `pubky://` resolution path as client reads. Both path
 * segments are validated against the commerce schemas before any URL is built,
 * so route params can never steer the server-side fetch outside the marketplace
 * namespace.
 */

/**
 * Revalidation window (seconds) for marketplace record/media fetches feeding
 * metadata and OG images. Shorter than the social OG_REVALIDATE hour because
 * listings change state (paused/ended/price) and stale previews would misstate
 * purchasability; still long enough that crawler bursts (each platform fetches
 * the page + image separately) hit the Data Cache instead of the homeserver.
 */
export const OG_COMMERCE_REVALIDATE = 300;

/**
 * Cache-Control for the rendered marketplace OG PNGs, matching the record
 * revalidate window (the social default in `OG_CACHE_HEADERS` is an hour).
 */
export const OG_COMMERCE_CACHE_HEADERS = {
  'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400',
} as const;

export const OG_NO_STORE_CACHE_HEADERS = {
  'cache-control': 'no-store',
} as const;

const MARKETPLACE_RECORD_BASE_PATH = '/pub/pubky.app/marketplace/v1';

const metadataClient = new Client({
  pkarr: {
    relays: getPkarrRelays(),
    requestTimeout: 4_000,
  },
});

const PUBKY_PROTOCOL = 'pubky://';

function buildRecordUrl(ownerPubky: string, recordPath: string): string {
  return resolvePubky(`pubky://${ownerPubky}${MARKETPLACE_RECORD_BASE_PATH}/${recordPath}`);
}

export type MetadataFetchResult<T> =
  | { kind: 'found'; record: T }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: string };

type RecordFetchResult = { kind: 'found'; value: unknown } | Exclude<MetadataFetchResult<never>, { kind: 'found' }>;

function reasonForError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  if (error instanceof Error && error.message) return error.message;
  return 'request_failed';
}

/** Default bound on PKARR resolution plus the record fetch for SSR. */
const RECORD_FETCH_TIMEOUT_MS = 4_000;

export interface RecordFetchOptions {
  timeoutMs?: number;
}

async function readRecordJson(url: string, operation: string, signal: AbortSignal): Promise<RecordFetchResult> {
  try {
    const res = await metadataClient.fetch(url, { credentials: 'include', signal });
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) {
      const reason = `http_${res.status}`;
      Logger.warn(`[ogCommerceData] ${operation} unavailable`, { status: res.status, reason });
      return { kind: 'unavailable', reason };
    }
    return { kind: 'found', value: await res.json() };
  } catch (error) {
    if (signal.aborted) return { kind: 'unavailable', reason: 'timeout' };
    const reason = reasonForError(error);
    Logger.warn(`[ogCommerceData] ${operation} unavailable`, { reason });
    return { kind: 'unavailable', reason };
  }
}

async function fetchRecordJson(
  url: string,
  operation: string,
  { timeoutMs = RECORD_FETCH_TIMEOUT_MS }: RecordFetchOptions = {},
): Promise<RecordFetchResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The deadline settles the wait even when the client does not settle after the abort.
  const deadline = new Promise<RecordFetchResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      Logger.warn(`[ogCommerceData] ${operation} unavailable`, { reason: 'timeout' });
      resolve({ kind: 'unavailable', reason: 'timeout' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([readRecordJson(url, operation, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches marketplace media through the homeserver resolved from the media
 * owner's PKARR record. Plain HTTP(S) media keeps the shared OG fetch path.
 */
export async function fetchOgMediaAsDataUri(uri: string | null | undefined): Promise<string | null> {
  if (!uri) return null;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return fetchImageAsDataUri(uri);
  if (!uri.startsWith(PUBKY_PROTOCOL)) return null;
  const parsedUri = marketplacePublicUriSchema.safeParse(uri);
  if (!parsedUri.success) return null;

  try {
    const url = resolvePubky(parsedUri.data);
    return fetchImageAsDataUri(url, (_input, init) =>
      metadataClient.fetch(url, {
        ...init,
        credentials: 'include',
        signal: AbortSignal.timeout(4_000),
      }),
    );
  } catch (error) {
    const reason = reasonForError(error);
    Logger.warn('[ogCommerceData] Marketplace media unavailable', { uri, reason });
    return null;
  }
}

/**
 * Fetches and validates the canonical listing record for metadata / OG image
 * generation. Returns `null` — the callers' cue to fall back to the generic
 * marketplace card — when the seller/listing params are malformed, the record
 * is missing, or the listing is in the `removed` state (a removed listing must
 * never be advertised in a preview). Network and validation failures return an
 * unavailable result so callers can preserve the page and avoid caching a
 * generic OG fallback.
 */
export async function fetchListingForMetadata(
  sellerPubky: string,
  listingId: string,
): Promise<MetadataFetchResult<CommerceListingRecord>> {
  const seller = commercePubkySchema.safeParse(sellerPubky);
  const id = commerceEntityIdSchema.safeParse(listingId);
  if (!seller.success || !id.success) return { kind: 'not_found' };

  let url: string;
  try {
    url = buildRecordUrl(seller.data, `listings/${id.data}`);
  } catch (error) {
    const reason = reasonForError(error);
    Logger.warn('[ogCommerceData] fetchListingRecord unavailable', { reason });
    return { kind: 'unavailable', reason };
  }
  const fetched = await fetchRecordJson(url, 'fetchListingRecord');
  if (fetched.kind !== 'found') return fetched;

  const record = commerceListingRecordSchema.safeParse(fetched.value);
  if (!record.success) {
    const reason = 'validation';
    Logger.warn('[ogCommerceData] Listing record failed validation', {
      issueCount: record.error.issues.length,
      reason,
    });
    return { kind: 'unavailable', reason };
  }
  if (record.data.state === 'removed') return { kind: 'not_found' };
  return { kind: 'found', record: record.data };
}

/**
 * Fetches and validates the canonical shop record (`shop.json`) for metadata /
 * OG image generation. Returns `not_found` on malformed params or a missing
 * record, and `unavailable` for fetch or validation failures.
 */
export async function fetchShopForMetadata(
  sellerPubky: string,
  options: RecordFetchOptions = {},
): Promise<MetadataFetchResult<CommerceShopRecord>> {
  const seller = commercePubkySchema.safeParse(sellerPubky);
  if (!seller.success) return { kind: 'not_found' };

  let url: string;
  try {
    url = buildRecordUrl(seller.data, 'shop.json');
  } catch (error) {
    const reason = reasonForError(error);
    Logger.warn('[ogCommerceData] fetchShopRecord unavailable', { reason });
    return { kind: 'unavailable', reason };
  }
  const fetched = await fetchRecordJson(url, 'fetchShopRecord', options);
  if (fetched.kind !== 'found') return fetched;

  const record = commerceShopRecordSchema.safeParse(fetched.value);
  if (!record.success) {
    const reason = 'validation';
    Logger.warn('[ogCommerceData] Shop record failed validation', {
      issueCount: record.error.issues.length,
      reason,
    });
    return { kind: 'unavailable', reason };
  }
  return { kind: 'found', record: record.data };
}
