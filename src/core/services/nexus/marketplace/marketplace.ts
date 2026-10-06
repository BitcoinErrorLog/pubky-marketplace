import { marketplaceApi } from '@/services/nexus/marketplace/marketplace.api';
import type {
  NexusListingDetails,
  NexusReputationSummary,
  NexusReviewView,
  TListingDetailsParams,
  TListingReviewsParams,
  TListingStreamParams,
  TListingTagsParams,
  TShopReputationParams,
  TShopReviewsParams,
  TShopTagsParams,
} from '@/services/nexus/marketplace/marketplace.types';
import type { NexusTag } from '@/services/nexus/nexus.types';
import { fetchNexus, queryNexus } from '@/services/nexus/nexus.utils';

/**
 * Nexus Marketplace Service
 *
 * Read-only access to the Nexus marketplace index. Responses are lossy
 * projections used for discovery; canonical record content is fetched from
 * the owner's homeserver (see `CommerceApplication`).
 */
export class NexusMarketplaceService {
  private constructor() {}

  /**
   * Fetches a page of indexed listings, newest-indexed first by default.
   *
   * @param params - Server-side filters and pagination (see `TListingStreamParams`)
   * @returns Array of listing projections; empty when nothing matches
   */
  static async fetchListingStream(params: TListingStreamParams = {}): Promise<NexusListingDetails[]> {
    return await queryNexus<NexusListingDetails[]>({ url: marketplaceApi.listingStream(params) });
  }

  /**
   * Fetches one indexed listing's projection — the watchlist's bounded
   * per-item freshness read (revision, price, state, auction deadline).
   * 404s propagate; the caller decides whether "not indexed" is meaningful.
   *
   * @param params - Seller/listing path params
   * @returns The listing projection as currently indexed by Nexus
   */
  static async fetchListingDetails(params: TListingDetailsParams): Promise<NexusListingDetails> {
    return await queryNexus<NexusListingDetails>({ url: marketplaceApi.listingDetails(params) });
  }

  /**
   * Single-attempt read of one indexed listing projection. `queryNexus`
   * retries a 404 five times with backoff because Nexus indexes
   * asynchronously; a caller that already holds a homeserver 404 and only
   * needs to know whether the index still lists the record cannot wait out
   * that backoff. Errors propagate unchanged.
   *
   * @param params - Seller/listing path params
   * @returns The listing projection as currently indexed by Nexus
   */
  static async fetchListingDetailsOnce(params: TListingDetailsParams): Promise<NexusListingDetails> {
    return await fetchNexus<NexusListingDetails>({ url: marketplaceApi.listingDetails(params) });
  }

  /**
   * Fetches the community tag aggregate for a listing.
   *
   * Served by the marketplace Nexus (tag aggregation deployed 2026-08-28,
   * `308b985e`); a 404 means this deployment lacks the endpoint and callers
   * degrade to local-only tags.
   *
   * @param params - Seller/listing path params plus pagination and viewer id
   * @returns Array of tag aggregates (empty when the listing has no tags)
   */
  static async fetchListingTags(params: TListingTagsParams): Promise<NexusTag[]> {
    return await queryNexus<NexusTag[]>({ url: marketplaceApi.listingTags(params) });
  }

  /**
   * Fetches the community tag aggregate for a shop.
   *
   * Same deployment caveat as `fetchListingTags`.
   *
   * @param params - Seller path param plus pagination and viewer id
   * @returns Array of tag aggregates (empty when the shop has no tags)
   */
  static async fetchShopTags(params: TShopTagsParams): Promise<NexusTag[]> {
    return await queryNexus<NexusTag[]>({ url: marketplaceApi.shopTags(params) });
  }

  /**
   * Fetches a page of indexed reviews about a subject (with joined subject
   * responses). Served once the reputation-indexing Nexus is deployed; a
   * 404 from an older deployment propagates and callers degrade to
   * rendering no review section at all.
   *
   * @param params - Subject path param plus role filter and pagination
   * @returns Review page entries, newest-indexed first (empty when none)
   */
  static async fetchShopReviews(params: TShopReviewsParams): Promise<NexusReviewView[]> {
    return await queryNexus<NexusReviewView[]>({ url: marketplaceApi.shopReviews(params) });
  }

  /**
   * Fetches the full reputation aggregate of a subject. Answers 404 when no
   * review is indexed for the subject in that role — the explicit
   * "New seller" state, which callers must render as absence, never 0.0.
   *
   * @param params - Subject path param plus role filter
   * @returns The reputation summary as currently indexed
   */
  static async fetchShopReputation(params: TShopReputationParams): Promise<NexusReputationSummary> {
    return await queryNexus<NexusReputationSummary>({ url: marketplaceApi.shopReputation(params) });
  }

  /**
   * Fetches a page of indexed buyer reviews of one listing (with joined
   * seller responses). Same deployment caveat as `fetchShopReviews`.
   *
   * @param params - Seller/listing path params plus pagination
   * @returns Review page entries, newest-indexed first (empty when none)
   */
  static async fetchListingReviews(params: TListingReviewsParams): Promise<NexusReviewView[]> {
    return await queryNexus<NexusReviewView[]>({ url: marketplaceApi.listingReviews(params) });
  }
}
