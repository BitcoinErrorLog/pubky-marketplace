import type {
  CommerceListingRecord,
  CommerceReviewRecord,
  CommerceReviewResponseRecord,
  CommerceShopRecord,
} from '@/libs/commerce/marketplace-records';
import type { AuctionState, CommerceJsonValue, CommerceMoney } from '@/libs/commerce/transaction-contracts';

export type CommerceCacheStatus = 'local' | 'pending' | 'synced' | 'failed';
/**
 * `not_found`: the service refused registration because the seller's
 * homeserver has no record. Not pending, so nothing retries it; publishing
 * the listing again resets it to `unregistered`.
 */
export type CommerceListingRegistrationStatus = 'registered' | 'unregistered' | 'unavailable' | 'not_found';

/**
 * How long after an acked-but-unconfirmed publish a 404 still reads as lag.
 * Observed read-after-write lag is about a second (production 2026-09-30:
 * 404 at 410ms, served about a second later); ten minutes is far beyond it,
 * and after it a 404 is an authoritative deletion again.
 */
export const LISTING_READ_BACK_PENDING_WINDOW_MS = 10 * 60_000;

export function isListingReadBackPending(
  listing: Pick<CommerceListingModelSchema, 'read_back_pending_since'>,
  now = Date.now(),
): boolean {
  const since = listing.read_back_pending_since;
  return since !== undefined && since <= now && now - since < LISTING_READ_BACK_PENDING_WINDOW_MS;
}

export function isListingRegistrationPending(
  listing: Pick<CommerceListingModelSchema, 'registration_status'>,
): boolean {
  return listing.registration_status === undefined || listing.registration_status === 'unregistered';
}

export interface CommerceShopModelSchema {
  id: string;
  owner_id: string;
  record: CommerceShopRecord;
  revision: number;
  sync_status: CommerceCacheStatus;
  updated_at: number;
}

export const commerceShopTableSchema = '&id, revision, sync_status, updated_at';

export interface CommerceListingModelSchema {
  id: string;
  seller_id: string;
  listing_id: string;
  record: CommerceListingRecord;
  revision: number;
  state: CommerceListingRecord['state'];
  category_id: string;
  format: CommerceListingRecord['sale']['format'];
  currency: string;
  price_minor: number;
  sync_status: CommerceCacheStatus;
  registration_status?: CommerceListingRegistrationStatus;
  updated_at: number;
  /**
   * Fresh on every local write of the row, so a caller can apply a result
   * only if nothing wrote the row since it read it. Client-only; absent on
   * rows written before it existed.
   */
  write_id?: string;
  /**
   * The seller's pending `listing.register` for an auction. The service
   * replays a command id, so this is the only copy of that id; it survives
   * reload and is shared across tabs. Client-only, owner-scoped (wiped with
   * the row on sign-out), never sent to the homeserver. Written only by the
   * listing's registration lock holder.
   */
  auction_registration?: CommerceAuctionRegistrationCommand;
  /**
   * When the homeserver acked this row's publish without serving it back
   * (epoch ms). Until a registration succeeds, the row is rewritten, or
   * {@link LISTING_READ_BACK_PENDING_WINDOW_MS} passes, a homeserver or
   * service 404 is read lag, never a deletion, so the row stays pending
   * instead of settling `not_found`. Client-only.
   */
  read_back_pending_since?: number;
}

export interface CommerceAuctionRegistrationCommand {
  command_id: string;
  issued_at: string;
  listing_revision: number;
  reserve_price: CommerceMoney | null;
  expected_service_revision: number;
  expected_record_revision: number;
  record_revision: number;
}

export const commerceListingTableSchema = [
  '&id',
  'seller_id',
  'listing_id',
  'revision',
  'state',
  'category_id',
  'format',
  'currency',
  'price_minor',
  'sync_status',
  'updated_at',
  '[seller_id+state]',
  '[category_id+state]',
].join(', ');

/**
 * The compact reputation aggregate carried by the Nexus listing stream and
 * shop views (ADR 0024 §9). `avg` averages the overall stars of every
 * indexed review — verified and labeled-unverified alike (ratified D5);
 * `verifiedCount` is the subset whose embedded purchase attestation
 * cryptographically verified at ingest. `null` on a catalog entry means the
 * index reported no reviews (or predates reputation indexing) — honest
 * absence, rendered as nothing or "New seller", never as 0.0.
 */
export interface CommerceReputationSnippet {
  avg: number;
  count: number;
  verifiedCount: number;
}

/**
 * Auction sale terms as carried by the Nexus listing index. Money terms are
 * denominated in the listing's primary asset. `buyNowPrice` is an optional
 * public term of the auction itself; the other fields
 * are always present when the index knows the terms at all.
 */
export interface CommerceCatalogAuctionTerms {
  startsAt: string;
  endsAt: string;
  buyNowPrice: CommerceMoney | null;
  minimumIncrement: CommerceMoney;
}

/**
 * One discovered listing as projected by the Nexus marketplace index
 * (`GET v0/stream/listings`), cached locally so the catalog grid can render
 * without hydrating the owner-signed record from the seller's homeserver.
 *
 * This is a lossy discovery projection, never a substitute for the canonical
 * record (ADR-0020): it carries the record's media URIs (`media_urls`, enough
 * to render card images) but none of the per-media metadata (type, dimensions,
 * alt text), no variants, shipping options, or return policy, and no live
 * auction state (current bid, bid count) because bids are not part of the
 * listing record Nexus indexes.
 *
 * `auction` is `null` for fixed-price listings — and for auction listings
 * that Nexus indexed before it carried auction terms (stale index rows serve
 * null terms until re-indexed), so `sale_format === 'auction'` with a null
 * `auction` is a legal state the UI must render sanely.
 */
export interface CommerceCatalogEntryModelSchema {
  id: string;
  seller_id: string;
  listing_id: string;
  state: CommerceListingRecord['state'];
  title: string;
  description: string;
  category_id: string;
  condition: CommerceListingRecord['condition'];
  tags: string[];
  country_code: string;
  region: string | null;
  /** `pubky://.../marketplace/v1/media/<id>` URIs in record order (see `resolveMarketplaceMediaUrl`). */
  media_urls: string[];
  sale_format: CommerceListingRecord['sale']['format'];
  price: CommerceMoney;
  auction: CommerceCatalogAuctionTerms | null;
  /**
   * The record's fulfillment vocabulary as Nexus echoed it (item types plus
   * `shipping`/`pickup` methods). `null` for entries cached before the model
   * carried it — honest absence, and the card simply renders no fulfillment
   * badge rather than guessing.
   */
  fulfillment_methods: CommerceListingRecord['fulfillmentMethods'] | null;
  /**
   * Seller-scoped reputation from the stream projection (buyer reviews
   * across all the seller's listings). `null` for entries cached before the
   * model carried it and for sellers without indexed reviews.
   */
  reputation: CommerceReputationSnippet | null;
  /** Listing-scoped reputation (buyer reviews of this listing). Same absence semantics. */
  listing_reputation: CommerceReputationSnippet | null;
  revision: number;
  updated_at: number;
}

export const commerceCatalogEntryTableSchema = [
  '&id',
  'seller_id',
  'state',
  'sale_format',
  'revision',
  'updated_at',
  '[seller_id+state]',
].join(', ');

export type CommerceListingDraftData = Pick<CommerceListingRecord, 'listingId' | 'ownerPubky'> &
  Partial<
    Omit<
      CommerceListingRecord,
      'schemaVersion' | 'recordType' | 'listingId' | 'ownerPubky' | 'revision' | 'createdAt' | 'updatedAt' | 'state'
    >
  > & {
    form?: CommerceJsonValue;
  };

export interface CommerceListingDraftModelSchema {
  id: string;
  owner_id: string;
  listing_id: string;
  data: CommerceListingDraftData;
  created_at: number;
  updated_at: number;
  /**
   * Unindexed photo payload for unuploaded composer files. Callers see `Blob`s;
   * Dexie stores `{ type, bytes: Uint8Array }` because nested `Blob` maps are
   * dropped by Dexie's clone path. Not JSON. No extra index, no DB version bump.
   */
  media_blobs?: Record<string, Blob>;
}

export const commerceListingDraftTableSchema = '&id, owner_id, listing_id, updated_at, [owner_id+updated_at]';

export type CommerceListingProjectionState = 'available' | 'reserved' | 'sold' | 'ended' | 'suspended';

export interface CommerceListingProjectionModelSchema {
  id: string;
  seller_id: string;
  listing_id: string;
  listing_revision: number;
  content_hash: string;
  server_revision: number;
  state: CommerceListingProjectionState;
  available_quantity: number;
  current_price: CommerceMoney;
  auction_state: AuctionState | null;
  bid_count: number;
  sync_status: Exclude<CommerceCacheStatus, 'local'>;
  synced_at: number;
}

export const commerceListingProjectionTableSchema = [
  '&id',
  'seller_id',
  'listing_id',
  'listing_revision',
  'server_revision',
  'state',
  'auction_state',
  'sync_status',
  'synced_at',
  '[seller_id+state]',
].join(', ');

/**
 * The current user's own published marketplace review (the canonical record
 * lives on their homeserver; this row is the local-first copy plus
 * publication state). `attestation_verified` is the result of the offline
 * verification recipe (signature against the `iss` pubky + claim bindings
 * against the record) run at publication time — it never claims more than
 * "the embedded attestation verifiably covers this review".
 */
export interface CommerceReviewModelSchema {
  /** `${owner_id}:${review_id}` — one living review per (listing, subject, role). */
  id: string;
  owner_id: string;
  review_id: string;
  /** The service order the review (and its attestation) came from. */
  order_id: string;
  subject_id: string;
  record: CommerceReviewRecord;
  attestation_verified: boolean;
  /** Attestor pubky from the verified attestation's `iss`, null when unverified. */
  attestation_iss: string | null;
  sync_status: CommerceCacheStatus;
  updated_at: number;
}

export const commerceReviewTableSchema = [
  '&id',
  'owner_id',
  'review_id',
  'order_id',
  'subject_id',
  'sync_status',
  'updated_at',
  '[owner_id+order_id]',
].join(', ');

/**
 * The current user's own review-response record (`PubkyAppReviewResponse`,
 * published to their OWN homeserver — the subject owns their words,
 * symmetrically to the reviewer). The path ID equals the subject review's
 * ID, structurally capping responses at one revisable response per review
 * (ratified D7). There is no service command for responses: they are pure
 * homeserver records that Nexus indexes with the structural
 * `owner == subjectPubky` authorization check.
 */
export interface CommerceReviewResponseModelSchema {
  /** `${owner_id}:${review_id}` — one living response per review. */
  id: string;
  /** The responder (this user; the subject of the review). */
  owner_id: string;
  /** The subject review's ID (also the response record's path ID). */
  review_id: string;
  /** The reviewer whose homeserver hosts the subject review. */
  reviewer_id: string;
  record: CommerceReviewResponseRecord;
  sync_status: CommerceCacheStatus;
  updated_at: number;
}

export const commerceReviewResponseTableSchema = ['&id', 'owner_id', 'review_id', 'sync_status', 'updated_at'].join(
  ', ',
);

/**
 * One indexed review as rendered on public marketplace surfaces (listing
 * and shop review sections), normalized from the Nexus review stream.
 *
 * `verified` is exactly "the embedded purchase attestation parsed, its
 * Ed25519 signature verified against `attestorId`, and its claims bind to
 * this review" — a cryptographic fact recorded at ingest. Whether
 * `attestorId` is a TRUSTED attestor is this client's policy (see
 * `isTrustedMarketplaceAttestor`); unverified reviews render labeled, never
 * hidden (ratified D5).
 */
export interface CommerceIndexedReview {
  reviewId: string;
  reviewerId: string;
  subjectId: string;
  listingOwnerId: string;
  listingId: string;
  role: 'buyer_reviewing_seller' | 'seller_reviewing_buyer';
  ratingOverall: number;
  text: string;
  verified: boolean;
  attestorId: string | null;
  editedLate: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
  response: CommerceIndexedReviewResponse | null;
}

/** The subject's response joined beneath an indexed review (ratified D7). */
export interface CommerceIndexedReviewResponse {
  responderId: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/**
 * The full reputation aggregate of a subject, normalized from
 * `GET v0/shop/{seller}/reputation`. `histogram[0]` holds 1-star counts;
 * `attestors` maps attestor pubky → verified-review count so display can
 * state its verified basis per trust list.
 */
export interface CommerceReputationSummary {
  count: number;
  verifiedCount: number;
  avg: number;
  histogram: [number, number, number, number, number];
  responseCount: number;
  editedLateCount: number;
  attestors: Record<string, number>;
  lastReviewedAt: string | null;
}

export type CommerceSyncJobOperation = 'publish' | 'update' | 'remove';
export type CommerceSyncJobStatus = 'pending' | 'running' | 'failed';

export interface CommerceSyncJobModelSchema {
  id: string;
  owner_id: string;
  entity_type: 'shop' | 'listing' | 'review' | 'review_response' | 'collection' | 'watchlist';
  entity_id: string;
  operation: CommerceSyncJobOperation;
  status: CommerceSyncJobStatus;
  attempts: number;
  next_attempt_at: number;
  last_error_code: string | null;
  payload: CommerceJsonValue;
  created_at: number;
  updated_at: number;
}

export const commerceSyncJobTableSchema = [
  '&id',
  'owner_id',
  'entity_type',
  'entity_id',
  'operation',
  'status',
  'next_attempt_at',
  'updated_at',
  '[owner_id+status]',
].join(', ');

export interface CommerceFavoriteModelSchema {
  id: string;
  owner_id: string;
  listing_id: string;
  created_at: number;
}

export const commerceFavoriteTableSchema = '&id, owner_id, listing_id, created_at, [owner_id+created_at]';

/**
 * A removed watch, retained so a delete wins over a stale re-add when the
 * private watchlist document is merged across devices (see
 * `commerce.watchlist.ts` for the merge rule). Rows are pruned to the
 * document cap oldest-first during merge; the table only exists to make
 * unwatch operations mergeable, it renders nothing.
 */
export interface CommerceWatchTombstoneModelSchema {
  /** `${owner_id}|${listing_id}` — same identity scheme as the favorite row. */
  id: string;
  owner_id: string;
  /** Composite `seller:listingId`. */
  listing_id: string;
  /** Epoch milliseconds when the watch was removed — the LWW merge key. */
  removed_at: number;
}

export const commerceWatchTombstoneTableSchema = '&id, owner_id, listing_id, removed_at, [owner_id+removed_at]';

/**
 * The last state of a watched listing this device actually observed — the
 * baseline every watch alert is computed against. One row per watched
 * listing per account, written only from real reads: the `index_*` fields
 * come from a Nexus listing projection (or, in sandbox mode, the locally
 * seeded catalog), the `projection_*`/bid fields from the transaction
 * service's public listing projection. A field is `null` when that source
 * has never been observed for this listing, and detection treats a null
 * baseline as "no claim possible", never as a change.
 */
export interface CommerceWatchSnapshotModelSchema {
  /** `${owner_id}|${listing_id}` — same identity as the favorite row it shadows. */
  id: string;
  owner_id: string;
  /** Composite `seller:listingId`. */
  listing_id: string;
  /** Listing title at last observation, so alerts can name the item without a join. */
  title: string;
  index_revision: number | null;
  index_state: CommerceListingRecord['state'] | null;
  price_minor: number | null;
  price_currency: string | null;
  price_exponent: number | null;
  auction_ends_at: string | null;
  server_revision: number | null;
  projection_state: CommerceListingProjectionState | null;
  bid_count: number | null;
  bid_amount_minor: number | null;
  leader_pubky: string | null;
  /**
   * The `ends_at` value an "ending soon" alert was already raised for, so the
   * same deadline never alerts twice (anti-sniping extensions produce a new
   * `ends_at` and may legitimately alert again).
   */
  ending_soon_alerted_ends_at: string | null;
  checked_at: number;
}

export const commerceWatchSnapshotTableSchema = '&id, owner_id, listing_id, checked_at, [owner_id+checked_at]';

export type CommerceWatchAlertKind = 'ending_soon' | 'new_bid' | 'outbid' | 'price_change' | 'state_change';

/** Which real read produced the alert's observation. */
export type CommerceWatchAlertSource = 'index' | 'projection';

/**
 * A device-local watchlist alert. Every row states something this device
 * actually observed — a Nexus index revision change or a transaction-service
 * projection read — compared against the persisted snapshot baseline.
 * Deliberately NOT a server notification and never presented as one: the UI
 * must label these as local checks ("checked on this device"). Read state
 * (`seen_at`) is honest here precisely because it is local.
 */
export interface CommerceWatchAlertModelSchema {
  /** `${owner_id}|${listing_id}|${kind}|${dedupeKey}` — deterministic, so re-detection is idempotent. */
  id: string;
  owner_id: string;
  /** Composite `seller:listingId`. */
  listing_id: string;
  seller_id: string;
  kind: CommerceWatchAlertKind;
  /** Listing title at observation time. */
  title: string;
  source: CommerceWatchAlertSource;
  /** The index revision or server revision the observation carried. */
  observed_revision: number;
  /** `ending_soon`: the observed auction deadline. */
  ends_at: string | null;
  /** `price_change`/`new_bid`/`outbid`: money context in minor units. */
  previous_amount_minor: number | null;
  current_amount_minor: number | null;
  currency: string | null;
  exponent: number | null;
  /** `new_bid`/`outbid`: observed bid count. */
  bid_count: number | null;
  /** `state_change`: transition endpoints. */
  previous_state: string | null;
  next_state: string | null;
  created_at: number;
  seen_at: number | null;
}

export const commerceWatchAlertTableSchema =
  '&id, owner_id, listing_id, kind, created_at, seen_at, [owner_id+created_at]';

/**
 * The device-local read checkpoint behind the marketplace Activity badge —
 * the same doctrine as the messaging conversations' `last_read_at`: the
 * durable service stores no notification read state (a count the user could
 * never clear would be a lie), so the badge counts only service rows newer
 * than the last time THIS device opened an activity surface, and opening one
 * moves the checkpoint. One row per account; never synced anywhere.
 */
export interface CommerceActivityCheckpointModelSchema {
  /** The owner pubky — one checkpoint row per account on this device. */
  id: string;
  owner_id: string;
  /** Device-local read checkpoint (ms epoch): rows created after this count as new. */
  last_read_at: number;
}

export const commerceActivityCheckpointTableSchema = '&id, owner_id, last_read_at';

/** The catalog filter/search combination a saved search replays. */
export interface CommerceSavedSearchParams {
  query: string;
  categoryId: string | null;
  saleFormat: 'all' | 'fixed_price' | 'auction' | 'drops';
  conditions: ('new' | 'like_new' | 'excellent' | 'good' | 'fair' | 'for_parts')[];
  minimumPriceMinor: number | null;
  maximumPriceMinor: number | null;
  /**
   * Seller-declared item location (ISO-3166-1 alpha-2), null = anywhere.
   * Optional because rows persisted before the filter existed lack it;
   * readers coalesce to null.
   */
  countryCode?: string | null;
  sort: 'recommended' | 'newest' | 'price_low' | 'price_high' | 'ending_soon';
}

/**
 * A named catalog search saved for re-running. `watermark_updated_at` is the
 * newest catalog `updated_at` the user has acknowledged for this search;
 * `new_count` is how many current matches exceeded it at the last check —
 * counted from a real Nexus stream read (or the locally seeded sandbox
 * catalog), never estimated. `latest_match_updated_at` is where the
 * watermark moves when the user opens the search.
 */
export interface CommerceSavedSearchModelSchema {
  id: string;
  owner_id: string;
  name: string;
  params: CommerceSavedSearchParams;
  watermark_updated_at: number;
  latest_match_updated_at: number;
  new_count: number;
  last_checked_at: number | null;
  created_at: number;
}

export const commerceSavedSearchTableSchema = '&id, owner_id, created_at, [owner_id+created_at]';

export interface CommerceShopFollowModelSchema {
  id: string;
  owner_id: string;
  seller_id: string;
  created_at: number;
}

export const commerceShopFollowTableSchema = '&id, owner_id, seller_id, created_at, [owner_id+created_at]';

export interface CommerceCartItemModelSchema {
  id: string;
  owner_id: string;
  listing_id: string;
  variant_id: string;
  quantity: number;
  award_id?: string | null;
  award_offer_revision?: number | null;
  pricing_source?: 'listing' | 'offer';
  added_at: number;
  updated_at: number;
}

export const commerceCartItemTableSchema = '&id, owner_id, listing_id, variant_id, updated_at, [owner_id+updated_at]';

/**
 * The buyer's private record of a real Locks payment: the correlation between
 * a transaction-service payment and the Locks verification lifecycle the
 * buyer opened for it (`locks-paykit` mode).
 *
 * `bundle_id` is BEARER MATERIAL — whoever holds it can look up the lifecycle
 * and, once completed, obtain the content access credential. It therefore
 * lives only in this account-scoped table (never in public records, command
 * results, logs, or telemetry) and exists so the flow is resumable after a
 * reload: the payment status itself is re-read from the transaction service,
 * while the persisted bundle id lets the buyer retry a failed registration
 * and unlock the purchased content after confirmation.
 */
export interface CommerceLocksCorrelationModelSchema {
  /** `${owner_id}:${payment_id}` */
  id: string;
  owner_id: string;
  payment_id: string;
  order_id: string;
  seller_pubky: string;
  bundle_id: string;
  /** Public Locks policy URI (`pubky://<creator>/pub/<locks.app|app.locks>/<lock>.json`). */
  policy_uri: string;
  criterion_id: string;
  /** Guarded content path for the Lock Server proxy read, from the listing record. */
  content_path: string;
  /** Expected lowercase BLAKE3 hash of the guarded bytes, from the listing record. */
  resource_hash: string;
  /**
   * Marketplace payment window deadline reported by `payment.register_locks`,
   * bounding the client's status polling. Null until registration succeeds.
   */
  window_expires_at: string | null;
  /** True once `payment.register_locks` was accepted by the transaction service. */
  registered: boolean;
  created_at: number;
  updated_at: number;
}

export const commerceLocksCorrelationTableSchema = '&id, owner_id, payment_id, order_id, updated_at';

/**
 * One saved delivery address in the buyer's private address book.
 *
 * Addresses are PRIVATE DELIVERY DETAILS and live only in this account-scoped
 * table — never on the homeserver, never in public records, and never
 * readable back from the transaction service. The seller-only single-order
 * projection can read it while the order is paid/processing and shipping;
 * encryption to the seller key is scheduled (ADR-0019 §8 interim). The only
 * other place an address travels is inside the buyer's own `checkout.create`
 * command.
 *
 * Field limits mirror the checkout command contract exactly, so anything
 * saved here is guaranteed submittable.
 */
export interface CommerceDeliveryAddressModelSchema {
  /** `${owner_id}:${addressId}` */
  id: string;
  owner_id: string;
  /** Short user-facing name for the picker, e.g. "Home". */
  label: string;
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postal_code: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  country_code: string;
  is_default: boolean;
  /** Set when an order was placed with this address; drives "last used" ordering. */
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export const commerceDeliveryAddressTableSchema = '&id, owner_id, updated_at, [owner_id+updated_at]';

/**
 * A seller's reusable shipping option template. Pure authoring convenience:
 * applying a preset only fills the sell studio's shipping fields — the
 * published listing record keeps its existing single flat-rate
 * `shippingOptions` shape, and nothing about a preset is ever published.
 */
export interface CommerceShippingPresetModelSchema {
  /** `${owner_id}:${presetId}` */
  id: string;
  owner_id: string;
  /** Shipping option label, doubles as the preset's display name. */
  label: string;
  price_minor: number;
  currency: string;
  estimated_min_days: number;
  estimated_max_days: number;
  created_at: number;
  updated_at: number;
}

export const commerceShippingPresetTableSchema = '&id, owner_id, updated_at, [owner_id+updated_at]';

export const COMMERCE_IMPORT_TABLE_NAMES = [
  'commerce_import_manifests',
  'commerce_import_rows',
  'commerce_import_mappings',
] as const;

export const IMPORT_MANIFEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Dexie host for SDK `ManifestStore` summaries. Rows live in `commerce_import_rows`. */
export interface CommerceImportManifestModelSchema {
  id: string;
  seller_id: string;
  version: number;
  created_at: number;
  summary_json: string;
}

export const commerceImportManifestTableSchema = '&id, seller_id, created_at, version';

export interface CommerceImportRowModelSchema {
  manifestId: string;
  rowIdentity: string;
  seller_id: string;
  listingId: string;
  planned_json: string;
  payload_json: string;
  checkpoint: string;
  updated_at: number;
}

export const commerceImportRowTableSchema =
  '[manifestId+rowIdentity], manifestId, seller_id, listingId, checkpoint, updated_at';

export interface CommerceImportMappingModelSchema {
  seller_id: string;
  mapping_json: string;
  updated_at: number;
}

export const commerceImportMappingTableSchema = '&seller_id, updated_at';

export const COMMERCE_WEBHOOK_TABLE_NAMES = ['commerce_webhooks'] as const;

export const INVENTORY_STUDIO_TABLE_NAMES = [...COMMERCE_IMPORT_TABLE_NAMES, ...COMMERCE_WEBHOOK_TABLE_NAMES] as const;

/**
 * Local copy of a seller webhook the service will not list (`GET /v1/webhooks`
 * does not exist). `{id, url}` only — never the one-time secret.
 */
export interface CommerceWebhookModelSchema {
  id: string;
  seller_id: string;
  url: string;
  created_at: number;
}

export const commerceWebhookTableSchema = '&id, seller_id, created_at';
