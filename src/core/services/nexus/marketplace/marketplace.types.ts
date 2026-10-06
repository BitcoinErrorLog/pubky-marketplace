/**
 * Nexus marketplace types
 *
 * Mirror the response shapes served by the Nexus marketplace index
 * (`nexus-common/src/models/marketplace/*` on the `feat/marketplace-indexing`
 * branch of pubky-nexus). Field names are snake_case exactly as serialized by
 * Nexus; enum values follow the snake_case serde renames in `pubky-app-specs`.
 *
 * These are lossy read projections of the owner-signed homeserver records —
 * they carry the record's media URIs (`media_urls`) but none of the per-media
 * metadata (type, dimensions, alt text), no variants, shipping options, or
 * return policy, so they can never be written into the `commerce_listings` /
 * `commerce_shops` record caches directly. The homeserver stays canonical for record content
 * (ADR-0020); Nexus provides discovery, ordering, and revision freshness.
 *
 * The projection does carry the sale terms a catalog card needs: the primary
 * price (the unit price for fixed-price listings, the starting price for
 * auctions) and, for auctions, the `auction_*` term fields. It never carries
 * live auction state (current bid, bid count) — bids live in the transaction
 * service's listing projection, not in the listing record Nexus indexes.
 */

export type NexusListingState = 'active' | 'paused' | 'ended' | 'removed';

/**
 * The compact reputation object Nexus embeds in listing stream entries, the
 * single-listing projection, and shop views (ADR 0024 §9): cards render
 * stars with zero additional requests.
 *
 * Truth basis: `count` covers every indexed review of the scope;
 * `verified_count` is the subset whose embedded purchase attestation
 * cryptographically verified at ingest (compact-JWS parse, Ed25519
 * signature against the self-certifying `iss` pubky, claims bound to the
 * review). `avg` averages the overall stars of ALL indexed reviews —
 * verified and labeled-unverified alike (ratified D5). Absence of the whole
 * object means "no indexed reviews", the explicit New-seller state — never
 * to be rendered as 0.0.
 */
export type NexusReputationSnippet = {
  avg: number;
  count: number;
  verified_count: number;
};

/** Review direction as serialized by pubky-app-specs. */
export type NexusReviewRole = 'buyer_reviewing_seller' | 'seller_reviewing_buyer';

/**
 * One indexed marketplace review as served inside `GET v0/shop/{seller}/reviews`
 * and `GET v0/listing/{seller}/{listing}/reviews` entries.
 *
 * `verified` is a cryptographic fact — the attestation parsed, verified
 * against `attestor_id` (its `iss` pubky), and bound to this review — never
 * a trust statement: WHO counts as a trusted attestor is client policy.
 * `edited_late` flags records revised beyond the marketplace's 24h edit
 * window (the window is app policy; the record is user property; Nexus
 * surfaces the divergence instead of hiding it).
 */
export type NexusReviewDetails = {
  review_id: string;
  uri: string;
  reviewer_id: string;
  subject_id: string;
  listing_owner_id: string;
  listing_id: string;
  role: NexusReviewRole;
  rating_overall: number;
  rating_item_accuracy: number | null;
  rating_shipping: number | null;
  rating_communication: number | null;
  text: string;
  verified: boolean;
  attestor_id: string | null;
  order_ref: string | null;
  edited_late: boolean;
  created_at: string;
  updated_at: string;
  revision: number;
  indexed_at: number;
};

/**
 * The subject's response record joined to a review (subject-only, one
 * revisable response per review — ratified D7; Nexus only indexes responses
 * whose owner is the review's subject).
 */
export type NexusReviewResponseDetails = {
  review_id: string;
  responder_id: string;
  reviewer_id: string;
  review_uri: string;
  text: string;
  created_at: string;
  updated_at: string;
  revision: number;
  indexed_at: number;
};

/** One entry of a paged review list: the review plus its joined response. */
export type NexusReviewView = {
  review: NexusReviewDetails;
  response: NexusReviewResponseDetails | null;
};

/**
 * The full reputation aggregate from `GET v0/shop/{seller}/reputation`.
 * `histogram[0]` holds 1-star counts. `attestors` breaks verified counts
 * down per attestor pubky so consumers can apply their own trust list.
 * The endpoint answers 404 when no review is indexed for the subject —
 * the explicit New-seller state.
 */
export type NexusReputationSummary = {
  count: number;
  verified_count: number;
  avg: number;
  histogram: [number, number, number, number, number];
  avg_item_accuracy: number | null;
  avg_shipping: number | null;
  avg_communication: number | null;
  response_count: number;
  edited_late_count: number;
  attestors: Record<string, number>;
  last_reviewed_at: string | null;
};

export type NexusListingCondition = 'new' | 'like_new' | 'excellent' | 'good' | 'fair' | 'for_parts';

export type NexusListingSaleFormat = 'fixed_price' | 'auction';

/**
 * The fulfillment vocabulary Nexus echoes from the listing record: item
 * types (`physical` | `digital`) plus fulfillment methods (`shipping` |
 * `pickup`). A both-ways pickup listing carries `shipping` explicitly
 * alongside `pickup` (local pickup design §A1/§A2), so the wire accepts it.
 */
export type NexusFulfillmentMethod = 'physical' | 'digital' | 'shipping' | 'pickup';

export type NexusSortOrder = 'ascending' | 'descending';

/**
 * Property the listing stream is sorted by. `timeline` (the server default)
 * orders by indexing time; `ends_at` orders auction listings by auction end
 * time and excludes fixed-price listings entirely.
 */
export type NexusListingStreamSorting = 'timeline' | 'ends_at';

/**
 * One indexed listing as returned by `GET v0/stream/listings` and `GET v0/listing/{seller_id}/{listing_id}`.
 *
 * The five `auction_*` fields are the auction sale terms and are all `null`
 * for fixed-price listings. The `*_minor` amounts are minor units of the
 * listing's primary asset (`price_currency` / `price_exponent`). Auction
 * listings indexed before Nexus carried these fields serve `null` for all
 * five until re-indexed, so an auction row with null terms is a legal stale
 * state, not a protocol violation.
 *
 * `state` is the state the index serves. A seller's record keeps `active`
 * after an auction closes, so an index that derives state reports the auction
 * as `ended` from `auction_ends_at` on, while an index that does not still
 * reports `active`. Read it through `effectiveListingState`, which applies the
 * same rule on the client.
 */
export type NexusListingDetails = {
  id: string;
  uri: string;
  owner_id: string;
  indexed_at: number;
  state: NexusListingState;
  title: string;
  description: string;
  category_id: string;
  condition: NexusListingCondition;
  tags: string[];
  country_code: string;
  region: string | null;
  media_urls: string[];
  sale_format: NexusListingSaleFormat;
  price_amount_minor: number;
  price_currency: string;
  price_exponent: number;
  auction_starts_at: string | null;
  auction_ends_at: string | null;
  auction_buy_now_price_minor: number | null;
  auction_minimum_increment_minor: number | null;
  fulfillment_methods: NexusFulfillmentMethod[];
  adult_only: boolean;
  created_at: string;
  updated_at: string;
  revision: number;
  /**
   * Seller-scoped reputation (buyer reviews across all their listings).
   * Omitted entirely by Nexus when the seller has no indexed review, and
   * absent from rows served by a Nexus deployed before reputation indexing —
   * both are the honest-absence state, never zeros.
   */
  reputation?: NexusReputationSnippet;
  /** Listing-scoped reputation (buyer reviews of this listing). Same absence semantics. */
  listing_reputation?: NexusReputationSnippet;
};

/**
 * Query parameters accepted by `GET v0/stream/listings`.
 *
 * `min_price` / `max_price` are expressed in major units and Nexus rejects
 * them unless `currency` is also provided. `category` is an exact match on
 * the kebab-case category id. `limit` is capped server-side at 30.
 * `sorting=ends_at` returns only auction listings; combine with
 * `order=ascending` for an "ending soon" stream. `state=active` excludes an
 * auction whose end time has passed on an index that derives state; the
 * catalog also drops such rows itself because cached rows outlive the query.
 */
export type TListingStreamParams = {
  seller_id?: string;
  category?: string;
  condition?: NexusListingCondition;
  sale_format?: NexusListingSaleFormat;
  state?: NexusListingState;
  min_price?: number;
  max_price?: number;
  currency?: string;
  /** Seller-declared item location: ISO-3166-1 alpha-2 country code. */
  country?: string;
  order?: NexusSortOrder;
  sorting?: NexusListingStreamSorting;
  skip?: number;
  limit?: number;
  start?: number;
  end?: number;
};

/** Path params for `GET v0/listing/{seller_id}/{listing_id}` (single indexed listing). */
export type TListingDetailsParams = {
  seller_id: string;
  listing_id: string;
};

/**
 * Query parameters for `GET v0/listing/{seller_id}/{listing_id}/tags`.
 * Mirrors the post tag endpoint's pagination/viewer contract
 * (`GET v0/post/{author}/{post}/tags`).
 */
export type TListingTagsParams = {
  seller_id: string;
  listing_id: string;
  limit_tags?: number;
  skip_tags?: number;
  viewer_id?: string;
};

/** Query parameters for `GET v0/shop/{seller_id}/tags`. */
export type TShopTagsParams = {
  seller_id: string;
  limit_tags?: number;
  skip_tags?: number;
  viewer_id?: string;
};

/** Path params excluded from tag endpoint query strings. */
export const MARKETPLACE_TAGS_PATH_PARAMS = ['seller_id', 'listing_id'];

/**
 * Query parameters for `GET v0/shop/{seller_id}/reviews`. `role` defaults
 * server-side to `buyer_reviewing_seller` (the public seller-reputation
 * surface); `seller_reviewing_buyer` exists for negotiation contexts only
 * (ratified D8) and must never build public buyer profiles.
 */
export type TShopReviewsParams = {
  seller_id: string;
  role?: NexusReviewRole;
  skip?: number;
  limit?: number;
};

/** Path/query params for `GET v0/shop/{seller_id}/reputation`. */
export type TShopReputationParams = {
  seller_id: string;
  role?: NexusReviewRole;
};

/** Path/query params for `GET v0/listing/{seller_id}/{listing_id}/reviews`. */
export type TListingReviewsParams = {
  seller_id: string;
  listing_id: string;
  skip?: number;
  limit?: number;
};
