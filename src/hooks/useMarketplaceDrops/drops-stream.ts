import { z } from 'zod';
import { getMarketplaceNexusUrl } from '@/config/nexus';

/**
 * DELIBERATELY HOOK-LOCAL Nexus read (`GET v0/stream/drops`).
 *
 * The marketplace Nexus fork serves `GET v0/stream/drops` (ADR 0026 D1
 * indexing; shipped in `055cb099` and present in the deployed marketplace
 * Nexus). This fetcher stays beside its only consumer rather than in
 * `src/core/services/nexus/marketplace` until it is promoted to follow
 * `fetchListingStream` exactly.
 *
 * Degradation contract (same as every marketplace Nexus read): a 404 means
 * "drop discovery is not indexed on this deployment" and returns `null` so
 * the caller renders an honest empty state; any other failure throws.
 * Entries mirror the drop record's fields in Nexus snake_case; the stream
 * is a LOSSY discovery projection — its times feed ESTIMATE buckets only,
 * and the drop page hydrates the authoritative service projection before
 * claiming anything.
 */
export const nexusDropStreamEntrySchema = z
  .object({
    id: z.string().min(1),
    owner_id: z.string().min(1),
    title: z.string(),
    description: z.string().optional().default(''),
    media_urls: z.array(z.string()).optional().default([]),
    format: z.string(),
    starts_at: z.string(),
    ends_at: z.string().nullable().optional(),
    total_quantity: z.number().int().positive().optional(),
    per_buyer_limit: z.number().int().positive().optional(),
    stock_display: z.string().optional(),
    indexed_at: z.number().optional(),
  })
  .loose();

export type NexusDropStreamEntry = z.infer<typeof nexusDropStreamEntrySchema>;

export interface DropsStreamParams {
  skip?: number;
  limit?: number;
}

/**
 * Fetches the indexed drops stream, or `null` when the deployment does not
 * serve it (404). Individually malformed entries are dropped rather than
 * failing the page — the stream is best-effort discovery, never authority.
 */
export async function fetchDropsStream(params: DropsStreamParams = {}): Promise<NexusDropStreamEntry[] | null> {
  const query = new URLSearchParams();
  if (params.skip !== undefined) query.set('skip', String(params.skip));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : '';
  const url = `${getMarketplaceNexusUrl()}/v0/stream/drops${suffix}`;
  const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`The drops stream request failed with status ${response.status}.`);
  }
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) {
    throw new Error('The drops stream returned a non-array response.');
  }
  return raw.flatMap((entry) => {
    const parsed = nexusDropStreamEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * ESTIMATE-ONLY state bucket computed from indexed times and the device
 * clock (there is no server clock in index data — that is exactly why the
 * bucket is labeled an estimate everywhere it renders and why no card ever
 * shows a claim button). The authoritative state loads on the drop page.
 */
export type DropStreamBucket = 'upcoming' | 'live' | 'ended';

export function estimateDropBucket(entry: NexusDropStreamEntry, deviceNowMs: number): DropStreamBucket {
  const startMs = Date.parse(entry.starts_at);
  if (Number.isNaN(startMs) || deviceNowMs < startMs) return 'upcoming';
  const endMs = entry.ends_at ? Date.parse(entry.ends_at) : null;
  if (endMs !== null && !Number.isNaN(endMs) && deviceNowMs >= endMs) return 'ended';
  return 'live';
}
