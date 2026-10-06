import {
  dropUriBuilder,
  listingUriBuilder,
  marketplaceReviewUriBuilder,
  orderReceiptUriBuilder,
  reviewResponseUriBuilder,
  shopUriBuilder,
  watchlistUriBuilder,
} from 'pubky-app-specs';
import { z } from 'zod';
import {
  type CommerceCollectionRecord,
  commerceCollectionRecordSchema,
  type CommerceDropRecord,
  commerceDropRecordSchema,
  type CommerceListingRecord,
  commerceListingRecordSchema,
  type CommerceOrderReceiptRecord,
  commerceOrderReceiptRecordSchema,
  type CommerceReviewRecord,
  commerceReviewRecordSchema,
  type CommerceReviewResponseRecord,
  commerceReviewResponseRecordSchema,
  type CommerceShopRecord,
  commerceShopRecordSchema,
  type CommerceWatchlistRecord,
  commerceWatchlistRecordSchema,
  locksPublicUriSchema,
} from '@/libs/commerce/marketplace-records';
import { type MarketplacePickupDetails, pickupDetailsSchema } from '@/libs/commerce/pickup';
import { canonicalizePostalCode, canonicalizeRegion, refinePostalAddressFields } from '@/libs/commerce/postal-address';
import { type MarketplaceCommand, marketplaceCommandSchema } from '@/libs/commerce/transaction-commands';
import type { CommerceJsonValue, CommerceMoney } from '@/libs/commerce/transaction-contracts';
import {
  commerceAggregateIdSchema,
  commerceEntityIdSchema,
  commercePubkySchema,
  commerceTimestampSchema,
} from '@/libs/commerce/transaction-contracts';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import type {
  CommerceCatalogAuctionTerms,
  CommerceCatalogEntryModelSchema,
  CommerceIndexedReview,
  CommerceReputationSnippet,
  CommerceReputationSummary,
  CommerceSavedSearchParams,
} from '@/models/commerce/commerce.schema';
import type { NexusListingDetails } from '@/services/nexus/marketplace/marketplace.types';

const MARKETPLACE_BASE_PATH = '/pub/pubky.app/marketplace/v1';

/**
 * A delivery address as entered in the address book or checkout form. Field
 * limits mirror the `checkout.create` command contract exactly (see
 * `createMarketplaceCheckoutCommandSchema`), so a saved address is always
 * submittable; `label` is client-only picker metadata.
 */
const commerceDeliveryAddressInputSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(100),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().max(100),
    postalCode: z.string().trim().max(32),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((code) => code.toUpperCase()),
  })
  .strict()
  .superRefine((data, context) => refinePostalAddressFields(data, context))
  .transform((data) => ({
    ...data,
    region: canonicalizeRegion(data.countryCode, data.region),
    postalCode: canonicalizePostalCode(data.countryCode, data.postalCode),
  }));

export type CommerceDeliveryAddressInput = z.infer<typeof commerceDeliveryAddressInputSchema>;

/**
 * A seller shipping preset as entered in the sell studio or shipping
 * settings. Limits mirror the published record's flat shipping option
 * (label ≤ 100, day estimates 0–365, max ≥ min), so applying a preset always
 * yields a publishable listing.
 */
const commerceShippingPresetInputSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    priceMinor: z.number().int().positive().max(100_000_000),
    currency: z.literal('USD'),
    estimatedMinDays: z.number().int().min(0).max(365),
    estimatedMaxDays: z.number().int().min(0).max(365),
  })
  .strict()
  .superRefine((preset, context) => {
    if (preset.estimatedMaxDays < preset.estimatedMinDays) {
      context.addIssue({
        code: 'custom',
        path: ['estimatedMaxDays'],
        message: 'Maximum delivery estimate must not precede the minimum',
      });
    }
  });

export type CommerceShippingPresetInput = z.infer<typeof commerceShippingPresetInputSchema>;

const NEXUS_AUCTION_TERM_FIELDS = [
  'auction_starts_at',
  'auction_ends_at',
  'auction_buy_now_price_minor',
  'auction_minimum_increment_minor',
] as const;

/**
 * The compact reputation object embedded in Nexus listing projections and
 * shop views. Optional on the wire: a Nexus deployed before reputation
 * indexing omits it entirely, and a reputation-aware Nexus omits it for
 * scopes without any indexed review — both parse to `undefined` and
 * normalize to `null` (honest absence, never a fabricated 0.0).
 */
const nexusReputationSnippetSchema = z.object({
  avg: z.number().min(0).max(5),
  count: z.number().int().nonnegative(),
  verified_count: z.number().int().nonnegative(),
});

/**
 * Wire schema for one Nexus listing projection (`NexusListingDetails`).
 *
 * This intentionally does NOT reuse `commerceListingRecordSchema`: the Nexus
 * projection is lossy (bare `media_urls` without per-media metadata, no
 * variants, shipping options, or return policy), so it can never reconstruct
 * a `CommerceListingRecord` without fabricating fields. Identity fields reuse the shared record
 * schemas; the remaining fields are validated for type agreement with the
 * real Nexus response shape. Unknown extra keys are tolerated so additive
 * Nexus changes do not break discovery.
 *
 * The `auction_*` term fields must all be present as keys (a payload missing
 * them is not the Nexus marketplace shape), but null values are legal in two
 * states Nexus actually serves: fixed-price listings (always all null) and
 * auction listings indexed before Nexus carried auction terms (all null
 * until re-indexed). Any other partial combination is rejected — in
 * particular an auction claiming terms without an end time.
 */
const nexusListingDetailsSchema: z.ZodType<NexusListingDetails> = z
  .object({
    id: commerceEntityIdSchema,
    uri: z.string(),
    owner_id: commercePubkySchema,
    indexed_at: z.number().int(),
    state: z.enum(['active', 'paused', 'ended', 'removed']),
    title: z.string(),
    description: z.string(),
    category_id: z.string(),
    condition: z.enum(['new', 'like_new', 'excellent', 'good', 'fair', 'for_parts']),
    tags: z.array(z.string()),
    country_code: z.string(),
    region: z.string().nullable(),
    media_urls: z.array(z.string()),
    sale_format: z.enum(['fixed_price', 'auction']),
    price_amount_minor: z.number().int(),
    price_currency: z.string(),
    price_exponent: z.number().int(),
    auction_starts_at: commerceTimestampSchema.nullable(),
    auction_ends_at: commerceTimestampSchema.nullable(),
    auction_buy_now_price_minor: z.number().int().positive().nullable(),
    auction_minimum_increment_minor: z.number().int().positive().nullable(),
    // The record's fulfillment vocabulary, echoed: a both-ways pickup
    // listing carries `shipping` explicitly alongside `pickup` (§A2).
    fulfillment_methods: z.array(z.enum(['physical', 'digital', 'shipping', 'pickup'])),
    adult_only: z.boolean(),
    created_at: commerceTimestampSchema,
    updated_at: commerceTimestampSchema,
    revision: z.number().int().positive(),
    reputation: nexusReputationSnippetSchema.optional(),
    listing_reputation: nexusReputationSnippetSchema.optional(),
  })
  .superRefine((listing, context) => {
    if (listing.sale_format === 'fixed_price') {
      for (const field of NEXUS_AUCTION_TERM_FIELDS) {
        if (listing[field] !== null) {
          context.addIssue({
            code: 'custom',
            message: 'Fixed-price listings must not carry auction terms',
            path: [field],
          });
        }
      }
      return;
    }

    const hasCompleteTerms =
      listing.auction_starts_at !== null &&
      listing.auction_ends_at !== null &&
      listing.auction_minimum_increment_minor !== null;
    const hasNoTerms = NEXUS_AUCTION_TERM_FIELDS.every((field) => listing[field] === null);
    if (!hasCompleteTerms && !hasNoTerms) {
      context.addIssue({
        code: 'custom',
        message:
          'Auction terms must be complete (start, end, minimum increment) or entirely null for rows indexed before Nexus carried them',
        path: ['auction_ends_at'],
      });
    }
  });

const nexusListingStreamSchema = z.array(nexusListingDetailsSchema);

const nexusReviewRoleSchema = z.enum(['buyer_reviewing_seller', 'seller_reviewing_buyer']);

/**
 * Wire schema for one indexed review inside a Nexus review-stream entry.
 * `verified === true` requires `attestor_id` to name the signer — an entry
 * claiming verification without naming who verified is rejected as
 * malformed rather than rendered with an unattributable badge.
 */
const nexusReviewDetailsSchema = z
  .object({
    review_id: commerceEntityIdSchema,
    reviewer_id: commercePubkySchema,
    subject_id: commercePubkySchema,
    listing_owner_id: commercePubkySchema,
    listing_id: commerceEntityIdSchema,
    role: nexusReviewRoleSchema,
    rating_overall: z.number().int().min(1).max(5),
    text: z.string(),
    verified: z.boolean(),
    attestor_id: commercePubkySchema.nullable(),
    edited_late: z.boolean(),
    created_at: commerceTimestampSchema,
    updated_at: commerceTimestampSchema,
    revision: z.number().int().positive(),
  })
  .superRefine((review, context) => {
    if (review.verified && review.attestor_id === null) {
      context.addIssue({
        code: 'custom',
        message: 'A verified review must name its attestor',
        path: ['attestor_id'],
      });
    }
  });

const nexusReviewResponseDetailsSchema = z.object({
  review_id: commerceEntityIdSchema,
  responder_id: commercePubkySchema,
  text: z.string(),
  created_at: commerceTimestampSchema,
  updated_at: commerceTimestampSchema,
  revision: z.number().int().positive(),
});

const nexusReviewStreamSchema = z.array(
  z.object({
    review: nexusReviewDetailsSchema,
    response: nexusReviewResponseDetailsSchema.nullable(),
  }),
);

const nexusReputationSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  verified_count: z.number().int().nonnegative(),
  avg: z.number().min(0).max(5),
  histogram: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  response_count: z.number().int().nonnegative(),
  edited_late_count: z.number().int().nonnegative(),
  attestors: z.record(z.string(), z.number().int().nonnegative()),
  last_reviewed_at: z.string().nullable(),
});

/** The catalog filter state a saved search persists — mirrors the commerce store's filter fields. */
const commerceSavedSearchParamsSchema: z.ZodType<CommerceSavedSearchParams> = z.object({
  query: z.string().max(200),
  categoryId: z.string().min(1).max(100).nullable(),
  saleFormat: z.enum(['all', 'fixed_price', 'auction', 'drops']),
  conditions: z.array(z.enum(['new', 'like_new', 'excellent', 'good', 'fair', 'for_parts'])).max(6),
  minimumPriceMinor: z.number().int().nonnegative().nullable(),
  maximumPriceMinor: z.number().int().nonnegative().nullable(),
  sort: z.enum(['recommended', 'newest', 'price_low', 'price_high', 'ending_soon']),
});

export class CommerceRecordNormalizer {
  private constructor() {}

  static shop(input: unknown): CommerceShopRecord {
    return this.parse(commerceShopRecordSchema, input, 'shop');
  }

  static listing(input: unknown): CommerceListingRecord {
    return this.parse(commerceListingRecordSchema, input, 'listing');
  }

  static review(input: unknown): CommerceReviewRecord {
    return this.parse(commerceReviewRecordSchema, input, 'review');
  }

  static collection(input: unknown): CommerceCollectionRecord {
    return this.parse(commerceCollectionRecordSchema, input, 'collection');
  }

  static pubky(input: unknown): string {
    return this.parse(commercePubkySchema, input, 'pubky');
  }

  static pubkyList(input: unknown): string[] {
    return this.parse(z.array(commercePubkySchema), input, 'pubkyList');
  }

  static entityId(input: unknown): string {
    return this.parse(commerceEntityIdSchema, input, 'entityId');
  }

  static listingCompositeId(input: unknown): string {
    if (typeof input !== 'string') {
      return this.parse(commerceEntityIdSchema, input, 'listingCompositeId');
    }
    const separator = input.indexOf(':');
    const owner = this.pubky(input.slice(0, separator));
    const listingId = this.entityId(input.slice(separator + 1));
    return `${owner}:${listingId}`;
  }

  static jsonValue(input: unknown): CommerceJsonValue {
    return this.parse(z.json(), input, 'jsonValue');
  }

  static mediaBlobs(input: unknown): Record<string, Blob> {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Invalid commerce mediaBlobs.', {
        service: ErrorService.Local,
        operation: 'normalizeCommercemediaBlobs',
        context: { issues: [{ code: 'invalid_type', message: 'Expected a blob map.', path: '' }] },
      });
    }
    const blobs: Record<string, Blob> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (key.trim() === '' || !(value instanceof Blob)) {
        throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Invalid commerce mediaBlobs.', {
          service: ErrorService.Local,
          operation: 'normalizeCommercemediaBlobs',
          context: { issues: [{ code: 'invalid_type', message: 'Expected Blob values.', path: key }] },
        });
      }
      blobs[key] = value;
    }
    return blobs;
  }

  static deliveryAddressInput(input: unknown): CommerceDeliveryAddressInput {
    return this.parse(commerceDeliveryAddressInputSchema, input, 'deliveryAddressInput');
  }

  static shippingPresetInput(input: unknown): CommerceShippingPresetInput {
    return this.parse(commerceShippingPresetInputSchema, input, 'shippingPresetInput');
  }

  static marketplaceCommand(input: unknown): MarketplaceCommand {
    return this.parse(marketplaceCommandSchema, input, 'marketplaceCommand');
  }

  /**
   * Validates seller-authored pickup details against the pickup contract
   * (mirrors the service's `validate_pickup_details`), so a `pickup_details.set`
   * command always carries a payload the service accepts. Pure validation —
   * the details themselves are sealed service-side and never persisted here.
   */
  static pickupDetails(input: unknown): MarketplacePickupDetails {
    return this.parse(pickupDetailsSchema, input, 'pickupDetails');
  }

  /**
   * Validates a Nexus `v0/stream/listings` payload and normalizes it into
   * catalog entries the grid can render directly. Pure: persisting the
   * entries — and any later hydration of the canonical record from the owner
   * homeserver (ADR-0020) — happens in the application layer.
   */
  static nexusListingStream(input: unknown): CommerceCatalogEntryModelSchema[] {
    const listings = this.parse(nexusListingStreamSchema, input, 'nexusListingStream');
    return listings.map((listing) => this.toCatalogEntry(listing));
  }

  /**
   * Validates a single Nexus `v0/listing/{seller}/{listing}` payload — the
   * watchlist's per-item freshness read — and normalizes it into the same
   * catalog entry shape the stream produces.
   */
  static nexusListingDetails(input: unknown): CommerceCatalogEntryModelSchema {
    return this.toCatalogEntry(this.parse(nexusListingDetailsSchema, input, 'nexusListingDetails'));
  }

  static savedSearchParams(input: unknown): CommerceSavedSearchParams {
    return this.parse(commerceSavedSearchParamsSchema, input, 'savedSearchParams');
  }

  /**
   * Validates a Nexus review-stream payload (`v0/shop/{seller}/reviews` or
   * `v0/listing/{seller}/{listing}/reviews`) and normalizes it into the
   * camelCase review views the marketplace surfaces render. The `verified`
   * flag is passed through as the cryptographic fact Nexus recorded at
   * ingest; attestor TRUST is applied at display time, not here.
   */
  static nexusReviewStream(input: unknown): CommerceIndexedReview[] {
    const entries = this.parse(nexusReviewStreamSchema, input, 'nexusReviewStream');
    return entries.map(({ review, response }) => ({
      reviewId: review.review_id,
      reviewerId: review.reviewer_id,
      subjectId: review.subject_id,
      listingOwnerId: review.listing_owner_id,
      listingId: review.listing_id,
      role: review.role,
      ratingOverall: review.rating_overall,
      text: review.text,
      verified: review.verified,
      attestorId: review.attestor_id,
      editedLate: review.edited_late,
      createdAt: review.created_at,
      updatedAt: review.updated_at,
      revision: review.revision,
      response:
        response === null
          ? null
          : {
              responderId: response.responder_id,
              text: response.text,
              createdAt: response.created_at,
              updatedAt: response.updated_at,
              revision: response.revision,
            },
    }));
  }

  /** Validates a Nexus `v0/shop/{seller}/reputation` payload. */
  static nexusReputationSummary(input: unknown): CommerceReputationSummary {
    const summary = this.parse(nexusReputationSummarySchema, input, 'nexusReputationSummary');
    return {
      count: summary.count,
      verifiedCount: summary.verified_count,
      avg: summary.avg,
      histogram: summary.histogram,
      responseCount: summary.response_count,
      editedLateCount: summary.edited_late_count,
      attestors: summary.attestors,
      lastReviewedAt: summary.last_reviewed_at,
    };
  }

  private static toCatalogEntry(listing: NexusListingDetails): CommerceCatalogEntryModelSchema {
    return {
      id: `${listing.owner_id}:${listing.id}`,
      seller_id: listing.owner_id,
      listing_id: listing.id,
      state: listing.state,
      title: listing.title,
      description: listing.description,
      category_id: listing.category_id,
      condition: listing.condition,
      tags: listing.tags,
      country_code: listing.country_code,
      region: listing.region,
      media_urls: listing.media_urls,
      sale_format: listing.sale_format,
      price: this.toCatalogMoney(listing, listing.price_amount_minor),
      auction: this.toCatalogAuctionTerms(listing),
      fulfillment_methods: [...listing.fulfillment_methods],
      reputation: this.toReputationSnippet(listing.reputation),
      listing_reputation: this.toReputationSnippet(listing.listing_reputation),
      revision: listing.revision,
      updated_at: Date.parse(listing.updated_at),
    };
  }

  // `undefined` (index has no reviews for the scope, or predates reputation
  // indexing) becomes `null`: absence is a first-class state the UI renders
  // as nothing or "New seller", never as zeros.
  private static toReputationSnippet(snippet: NexusListingDetails['reputation']): CommerceReputationSnippet | null {
    if (!snippet) return null;
    return { avg: snippet.avg, count: snippet.count, verifiedCount: snippet.verified_count };
  }

  /**
   * Auction money terms arrive as minor units of the listing's primary asset
   * (`price_currency` / `price_exponent`); pubky-app-specs guarantees all
   * auction prices share that asset, so denominating them here reproduces the
   * record's terms rather than inventing values.
   */
  private static toCatalogMoney(listing: NexusListingDetails, amountMinor: number): CommerceMoney {
    return { amountMinor, currency: listing.price_currency, exponent: listing.price_exponent };
  }

  // Returns null both for fixed-price listings and for auction rows indexed
  // before Nexus carried auction terms (the schema guarantees no other
  // partial state can reach this point).
  private static toCatalogAuctionTerms(listing: NexusListingDetails): CommerceCatalogAuctionTerms | null {
    if (listing.sale_format !== 'auction') return null;
    const { auction_starts_at, auction_ends_at, auction_minimum_increment_minor } = listing;
    if (auction_starts_at === null || auction_ends_at === null || auction_minimum_increment_minor === null) {
      return null;
    }
    return {
      startsAt: auction_starts_at,
      endsAt: auction_ends_at,
      buyNowPrice:
        listing.auction_buy_now_price_minor === null
          ? null
          : this.toCatalogMoney(listing, listing.auction_buy_now_price_minor),
      minimumIncrement: this.toCatalogMoney(listing, auction_minimum_increment_minor),
    };
  }

  static aggregateId(input: unknown): string {
    return this.parse(commerceAggregateIdSchema, input, 'aggregateId');
  }

  static lockResource(input: unknown): string {
    return this.parse(locksPublicUriSchema, input, 'lockResource');
  }

  // Record paths come from pubky-app-specs so the client cannot drift from the
  // protocol definition. Media has no spec object yet and keeps a local path.
  static shopUri(ownerPubky: unknown): string {
    return shopUriBuilder(this.pubky(ownerPubky));
  }

  static listingUri(ownerPubky: unknown, listingId: unknown): string {
    return listingUriBuilder(this.pubky(ownerPubky), this.entityId(listingId));
  }

  static auctionReserveUri(ownerPubky: unknown, listingId: unknown): string {
    return `${this.auctionReserveDirectoryUri(ownerPubky)}${this.entityId(listingId)}.json`;
  }

  static auctionReserveDirectoryUri(ownerPubky: unknown): string {
    return `pubky://${this.pubky(ownerPubky)}/priv/pubky.app/marketplace/v1/auction_reserves/`;
  }

  /**
   * The owner's PRIVATE badge checkpoint directory for one side (`activity`
   * or `orders`). Each entry is named by the checkpoint it records.
   */
  static attentionSeenDirectoryUri(ownerPubky: unknown, side: 'activity' | 'orders'): string {
    return `pubky://${this.pubky(ownerPubky)}/priv/pubky.app/marketplace/v1/attention_seen/${side}/`;
  }

  static mediaUri(ownerPubky: unknown, mediaId: unknown): string {
    const owner = this.pubky(ownerPubky);
    const id = this.entityId(mediaId);
    return `pubky://${owner}${MARKETPLACE_BASE_PATH}/media/${id}`;
  }

  static reviewUri(ownerPubky: unknown, reviewId: unknown): string {
    return marketplaceReviewUriBuilder(this.pubky(ownerPubky), this.entityId(reviewId));
  }

  static reviewResponseUri(responderPubky: unknown, reviewId: unknown): string {
    return reviewResponseUriBuilder(this.pubky(responderPubky), this.entityId(reviewId));
  }

  /** The owner's PRIVATE watchlist document URI (`pubky://<owner>/priv/pubky.app/marketplace/v1/watchlist.json`). */
  static watchlistUri(ownerPubky: unknown): string {
    return watchlistUriBuilder(this.pubky(ownerPubky));
  }

  static watchlistRecord(input: unknown): CommerceWatchlistRecord {
    return this.parse(commerceWatchlistRecordSchema, input, 'watchlistRecord');
  }

  static orderReceiptUri(ownerPubky: unknown, receiptId: unknown): string {
    return orderReceiptUriBuilder(this.pubky(ownerPubky), z.uuid().parse(receiptId));
  }

  /** The owner's plaintext v1 receipt directory, read only to move its files into encrypted entries. */
  static orderReceiptDirectoryUri(ownerPubky: unknown): string {
    return `pubky://${this.pubky(ownerPubky)}/priv/pubky.app/marketplace/v1/receipts/`;
  }

  static orderReceiptRecord(input: unknown): CommerceOrderReceiptRecord {
    return this.parse(commerceOrderReceiptRecordSchema, input, 'orderReceiptRecord');
  }

  static dropUri(ownerPubky: unknown, dropId: unknown): string {
    return dropUriBuilder(this.pubky(ownerPubky), z.string().min(1).parse(dropId));
  }

  static drop(input: unknown): CommerceDropRecord {
    return this.parse(commerceDropRecordSchema, input, 'drop');
  }

  static reviewResponse(input: unknown): CommerceReviewResponseRecord {
    return this.parse(commerceReviewResponseRecordSchema, input, 'reviewResponse');
  }

  static collectionUri(ownerPubky: unknown, collectionId: unknown): string {
    const owner = this.pubky(ownerPubky);
    const id = this.entityId(collectionId);
    return `pubky://${owner}${MARKETPLACE_BASE_PATH}/collections/${id}.json`;
  }

  private static parse<T>(schema: z.ZodType<T>, input: unknown, operation: string): T {
    const result = schema.safeParse(input);
    if (result.success) return result.data;

    throw Err.validation(ValidationErrorCode.INVALID_INPUT, `Invalid commerce ${operation}.`, {
      service: ErrorService.Local,
      operation: `normalizeCommerce${operation}`,
      context: {
        issues: result.error.issues.map(({ code, message, path }) => ({
          code,
          message,
          path: path.join('.'),
        })),
      },
    });
  }
}
