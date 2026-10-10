import { z } from 'zod';
import {
  COMMERCE_CONTRACT_VERSION,
  COMMERCE_LISTING_DESCRIPTION_MAX_CHARS,
  COMMERCE_LISTING_MAX_IMAGES,
  COMMERCE_LISTING_MAX_MEDIA,
  COMMERCE_LISTING_MAX_OPTION_DIMENSIONS,
  COMMERCE_LISTING_MAX_QUANTITY,
  COMMERCE_LISTING_MAX_TAGS,
  COMMERCE_LISTING_MAX_VARIANTS,
  COMMERCE_LISTING_MAX_VIDEOS,
  COMMERCE_LISTING_TITLE_MAX_CHARS,
  COMMERCE_LISTING_TITLE_MIN_CHARS,
  COMMERCE_MEDIA_ALT_TEXT_MAX_CHARS,
  COMMERCE_REVIEW_TEXT_MAX_CHARS,
  COMMERCE_SHOP_BIO_MAX_CHARS,
  COMMERCE_SHOP_NAME_MAX_CHARS,
  COMMERCE_SHOP_POLICY_MAX_CHARS,
  COMMERCE_TAXONOMY_VERSION_MAX,
  COMMERCE_TAXONOMY_VERSION_MIN,
} from '@/config/commerce';
import {
  COMMERCE_ATTRIBUTE_KEY_MAX_CHARS,
  COMMERCE_ATTRIBUTE_KEY_PATTERN,
  COMMERCE_ATTRIBUTE_MAX_VALUES_PER_KEY,
  COMMERCE_ATTRIBUTE_VALUE_MAX_CHARS,
  COMMERCE_LISTING_MAX_ATTRIBUTES,
} from '@/config/taxonomy/taxonomy';
import type { MarketplaceFulfillmentMethod } from './pickup';
import {
  commerceEntityIdSchema,
  commerceMoneySchema,
  commercePositiveMoneySchema,
  commercePubkySchema,
  commerceTimestampSchema,
} from './transaction-contracts';

export const MARKETPLACE_FORBIDDEN_PUBLIC_RESERVE_KEYS = [
  'reservePrice',
  'reserve_price',
  'reserveMet',
  'reserve_met',
] as const;

const marketplaceForbiddenPublicReserveKeys = new Set<string>(MARKETPLACE_FORBIDDEN_PUBLIC_RESERVE_KEYS);

export function findForbiddenPublicReserveKey(input: unknown): string | null {
  if (Array.isArray(input)) {
    for (const value of input) {
      const found = findForbiddenPublicReserveKey(value);
      if (found) return found;
    }
    return null;
  }
  if (input === null || typeof input !== 'object') return null;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (marketplaceForbiddenPublicReserveKeys.has(key)) return key;
    const found = findForbiddenPublicReserveKey(value);
    if (found) return found;
  }
  return null;
}

export function stripForbiddenPublicReserveKeys(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(stripForbiddenPublicReserveKeys);
  if (input === null || typeof input !== 'object') return input;
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([key]) => !marketplaceForbiddenPublicReserveKeys.has(key))
      .map(([key, value]) => [key, stripForbiddenPublicReserveKeys(value)]),
  );
}

export function assertReserveFreePublicRecord(input: unknown): void {
  const forbiddenKey = findForbiddenPublicReserveKey(input);
  if (forbiddenKey) {
    throw new TypeError(`Public marketplace records cannot contain ${forbiddenKey}`);
  }
}

const reserveFreePublicRecordInputSchema = z.unknown().superRefine((input, context) => {
  const forbiddenKey = findForbiddenPublicReserveKey(input);
  if (forbiddenKey) {
    context.addIssue({
      code: 'custom',
      message: `Public marketplace records cannot contain ${forbiddenKey}`,
    });
  }
});

// Forward-compat contract (social/v1 alignment): every record schema in this
// file is OPEN-WORLD — unknown members pass through parsing and MUST survive
// a read-modify-write (edit paths spread the fetched record before applying
// form values). This is what lets record shapes grow additively without
// breaking older clients. The transaction-service command schemas
// (transaction-commands.ts) are a service API contract, not records, and
// remain strict.

const commercePublicRecordBaseSchema = z
  .object({
    schemaVersion: z.literal(COMMERCE_CONTRACT_VERSION),
    ownerPubky: commercePubkySchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: commerceTimestampSchema,
    updatedAt: commerceTimestampSchema,
  })
  .passthrough();

export const commerceCountryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'Expected an ISO 3166-1 alpha-2 code');

export const commercePublicLocationSchema = z
  .object({
    countryCode: commerceCountryCodeSchema,
    region: z.string().trim().min(1).max(100).optional(),
  })
  .passthrough();

export const marketplacePublicUriSchema = z
  .string()
  .regex(
    /^pubky:\/\/[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\/pub\/pubky\.app\/marketplace\/v1\/[A-Za-z0-9_./-]+$/,
    'Expected a Pubky marketplace v1 URI',
  );

/** `/pub/locks.app/` (fork Lock Server) or `/pub/app.locks/` (pubky/locks rc10 and later). */
export const locksPublicUriSchema = z
  .string()
  .regex(
    /^pubky:\/\/[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\/pub\/(?:locks\.app|app\.locks)\/[A-Za-z0-9_./-]+\.json$/,
    'Expected a public Locks policy URI',
  );

export const commerceMediaSchema = z
  .object({
    id: commerceEntityIdSchema,
    type: z.enum(['image', 'video']),
    url: marketplacePublicUriSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase BLAKE3 hash'),
    mimeType: z.string().regex(/^(image|video)\/[a-z0-9.+-]+$/i, 'Expected an image or video MIME type'),
    byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationMs: z.number().int().positive().optional(),
    altText: z.string().trim().min(1).max(COMMERCE_MEDIA_ALT_TEXT_MAX_CHARS),
  })
  .passthrough()
  .superRefine((media, context) => {
    if (media.type === 'video' && media.durationMs === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Video media requires durationMs',
        path: ['durationMs'],
      });
    }
    if (media.type === 'image' && media.durationMs !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Image media cannot declare durationMs',
        path: ['durationMs'],
      });
    }
  });

export const commerceVariantSchema = z
  .object({
    id: commerceEntityIdSchema,
    sku: z.string().trim().min(1).max(64).optional(),
    options: z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(80)),
    priceOverride: commercePositiveMoneySchema.optional(),
    quantity: z.number().int().min(0).max(COMMERCE_LISTING_MAX_QUANTITY),
    mediaIds: z.array(commerceEntityIdSchema).max(COMMERCE_LISTING_MAX_MEDIA).default([]),
    enabled: z.boolean().default(true),
  })
  .passthrough()
  .superRefine((variant, context) => {
    if (Object.keys(variant.options).length > COMMERCE_LISTING_MAX_OPTION_DIMENSIONS) {
      context.addIssue({
        code: 'custom',
        message: `Variants support at most ${COMMERCE_LISTING_MAX_OPTION_DIMENSIONS} option dimensions`,
        path: ['options'],
      });
    }
  });

const fixedPriceSaleSchema = z
  .object({
    format: z.literal('fixed_price'),
    unitPrice: commercePositiveMoneySchema,
    acceptsOffers: z.boolean(),
  })
  .passthrough();

const auctionSaleSchema = z
  .object({
    format: z.literal('auction'),
    startingPrice: commercePositiveMoneySchema,
    buyNowPrice: commercePositiveMoneySchema.optional(),
    minimumIncrement: commercePositiveMoneySchema,
    startsAt: commerceTimestampSchema,
    endsAt: commerceTimestampSchema,
    antiSnipingWindowSeconds: z.number().int().min(0).max(3_600),
    antiSnipingExtensionSeconds: z.number().int().min(0).max(3_600),
  })
  .passthrough();

export const commerceSaleSchema = z.discriminatedUnion('format', [fixedPriceSaleSchema, auctionSaleSchema]);

const freeShippingOptionSchema = z
  .object({
    id: commerceEntityIdSchema,
    pricing: z.literal('free'),
    label: z.string().trim().min(1).max(100),
    estimatedMinDays: z.number().int().min(0).max(365),
    estimatedMaxDays: z.number().int().min(0).max(365),
  })
  .passthrough();

const flatShippingOptionSchema = z
  .object({
    id: commerceEntityIdSchema,
    pricing: z.literal('flat'),
    label: z.string().trim().min(1).max(100),
    price: commerceMoneySchema,
    estimatedMinDays: z.number().int().min(0).max(365),
    estimatedMaxDays: z.number().int().min(0).max(365),
  })
  .passthrough();

const calculatedShippingOptionSchema = z
  .object({
    id: commerceEntityIdSchema,
    pricing: z.literal('calculated'),
    label: z.string().trim().min(1).max(100),
    provider: z.string().trim().min(1).max(50),
    serviceCode: z.string().trim().min(1).max(100),
    estimatedMinDays: z.number().int().min(0).max(365),
    estimatedMaxDays: z.number().int().min(0).max(365),
  })
  .passthrough();

export const commerceShippingOptionSchema = z
  .discriminatedUnion('pricing', [freeShippingOptionSchema, flatShippingOptionSchema, calculatedShippingOptionSchema])
  .superRefine((option, context) => {
    if (option.estimatedMaxDays < option.estimatedMinDays) {
      context.addIssue({
        code: 'custom',
        message: 'Maximum delivery estimate must not precede the minimum',
        path: ['estimatedMaxDays'],
      });
    }
  });

export type CommerceShippingOption = z.infer<typeof commerceShippingOptionSchema>;

/**
 * The flat shipping the transaction service charges per order line for this
 * listing, in the listing currency's minor units: the cheapest PRICEABLE
 * option the seller signed — `free` is 0, `flat` is its price. `calculated`
 * options cannot be priced client- or service-side yet and are skipped.
 * No options (digital goods) or none priceable means no shipping charge.
 * Mirrors the service's `shipping_minor_from_options` derivation exactly.
 */
export function commerceListingShippingMinor(shippingOptions: readonly CommerceShippingOption[]): number {
  const priceable = shippingOptions
    .map((option) => (option.pricing === 'free' ? 0 : option.pricing === 'flat' ? option.price.amountMinor : null))
    .filter((amount): amount is number => amount !== null && amount >= 0);
  return priceable.length > 0 ? Math.min(...priceable) : 0;
}

/**
 * The service-facing fulfillment methods a listing record publishes
 * (`shipping` | `pickup` | `digital`), derived from the record's
 * `fulfillmentMethods` EXACTLY as the durable service derives them from a
 * fetched record (`homeserver.rs::registration_payload_from_record`, digital
 * delivery design §6 A1–A3): `shipping`, `pickup` and `digital` map, except
 * that a Locks listing (one carrying `digitalLock`) skips `digital`;
 * first-seen dedup (not just adjacent); an empty result defaults to
 * shipping-only. So records predating pickup, and Locks listings, register
 * as shipping-only, and `['physical', 'digital']` (no explicit `shipping`)
 * registers as digital-only. The register payload validation mirrors the
 * service (non-empty, known values, deduped), so this derivation's output
 * always validates.
 */
export function commerceListingFulfillmentMethods(
  methods: readonly CommerceListingRecord['fulfillmentMethods'][number][],
  hasDigitalLock = false,
): MarketplaceFulfillmentMethod[] {
  const derived: MarketplaceFulfillmentMethod[] = [];
  for (const method of methods) {
    const maps = method === 'shipping' || method === 'pickup' || (method === 'digital' && !hasDigitalLock);
    if (maps && !derived.includes(method)) {
      derived.push(method);
    }
  }
  return derived.length > 0 ? derived : ['shipping'];
}

/**
 * Whether the listing offers **Make offer**: a fixed-price sale that accepts
 * offers and publishes a physical fulfillment (shipping or pickup). Digital
 * items take no offers; the service refuses them
 * (`offers_unavailable_for_digital`). A Locks listing publishes only
 * `digital`, so it takes none either, although the service registers it as
 * shipping.
 */
export function commerceListingTakesOffers(
  record: Pick<CommerceListingRecord, 'sale' | 'fulfillmentMethods'>,
): boolean {
  return (
    record.sale.format === 'fixed_price' &&
    record.sale.acceptsOffers &&
    commerceListingFulfillmentMethods(record.fulfillmentMethods).some(
      (method) => method === 'shipping' || method === 'pickup',
    )
  );
}

export const commercePackageSchema = z
  .object({
    weightGrams: z.number().int().positive().max(1_000_000),
    lengthMillimeters: z.number().int().positive().max(100_000),
    widthMillimeters: z.number().int().positive().max(100_000),
    heightMillimeters: z.number().int().positive().max(100_000),
  })
  .passthrough();

export const commerceReturnPolicySchema = z
  .object({
    acceptsReturns: z.boolean(),
    returnWindowDays: z.number().int().min(1).max(365).optional(),
    buyerPaysReturnShipping: z.boolean(),
    details: z.string().trim().max(COMMERCE_SHOP_POLICY_MAX_CHARS).optional(),
  })
  .passthrough()
  .superRefine((policy, context) => {
    if (policy.acceptsReturns && policy.returnWindowDays === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A return window is required when returns are accepted',
        path: ['returnWindowDays'],
      });
    }
    if (!policy.acceptsReturns && policy.returnWindowDays !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A return window cannot be set when returns are not accepted',
        path: ['returnWindowDays'],
      });
    }
  });

export const commerceDigitalLockSchema = z
  .object({
    policyUri: locksPublicUriSchema,
    criterionId: commerceEntityIdSchema.default('criterion-1'),
    /**
     * Lock-Server-relative path of the guarded content under the creator's
     * private content namespace (served by the guarded proxy read
     * `GET /priv-resources/content/<contentPath>` with an access credential).
     * A path, not a secret: access is enforced by the credential.
     */
    contentPath: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/, 'Expected a relative guarded content path')
      .refine((path) => !path.includes('..'), 'Guarded content paths cannot traverse directories'),
    resourceHash: z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase BLAKE3 hash'),
    minimumConfirmations: z.number().int().min(0).max(6),
  })
  .passthrough();

/**
 * The seller-declared transaction-service authority (specs
 * `0.6.2-marketplace.7`, `shop.transactionService`): an HTTPS base URL with
 * no credentials, query, or fragment. Mirrors the specs fork's validation so
 * a record either parses identically on both sides or on neither.
 */
const commerceTransactionServiceSchema = z
  .string()
  .max(300)
  .refine((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  }, 'Expected a plain https URL without credentials, query, or fragment');

const commerceShopRecordSchemaInner = commercePublicRecordBaseSchema
  .extend({
    recordType: z.literal('shop'),
    name: z.string().trim().min(1).max(COMMERCE_SHOP_NAME_MAX_CHARS),
    bio: z.string().trim().max(COMMERCE_SHOP_BIO_MAX_CHARS),
    location: commercePublicLocationSchema,
    avatarUrl: marketplacePublicUriSchema.optional(),
    bannerUrl: marketplacePublicUriSchema.optional(),
    shippingPolicy: z.string().trim().max(COMMERCE_SHOP_POLICY_MAX_CHARS),
    returnPolicy: z.string().trim().max(COMMERCE_SHOP_POLICY_MAX_CHARS),
    vacationMode: z.boolean(),
    // Optional since 0.6.2-marketplace.7; absent on every earlier record.
    // See docs/ecommerce/multi-operator.md for the routing semantics.
    transactionService: commerceTransactionServiceSchema.optional(),
    createdAt: commerceTimestampSchema,
    updatedAt: commerceTimestampSchema,
  })
  .passthrough()
  .superRefine(validateRecordDates);

const commerceAttributeValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(COMMERCE_ATTRIBUTE_VALUE_MAX_CHARS, 'Attribute values must be 80 characters or fewer');

/**
 * Item specifics: the bounded, generic key/value container from the specs
 * fork (0.6.2-marketplace.4). Which keys a category expects (and their
 * allowed values) is client configuration keyed by `taxonomyVersion` — the
 * record only enforces shape bounds, so records from other taxonomies stay
 * valid and render as plain label:value pairs.
 */
export const commerceListingAttributesSchema = z
  .record(
    z
      .string()
      .max(COMMERCE_ATTRIBUTE_KEY_MAX_CHARS)
      .regex(COMMERCE_ATTRIBUTE_KEY_PATTERN, 'Expected a lowercase alphanumeric attribute key'),
    z.union([
      commerceAttributeValueSchema,
      z.array(commerceAttributeValueSchema).min(1).max(COMMERCE_ATTRIBUTE_MAX_VALUES_PER_KEY),
    ]),
  )
  .superRefine((attributes, context) => {
    if (Object.keys(attributes).length > COMMERCE_LISTING_MAX_ATTRIBUTES) {
      context.addIssue({
        code: 'custom',
        message: `Listings support at most ${COMMERCE_LISTING_MAX_ATTRIBUTES} attributes`,
      });
    }
    for (const [key, value] of Object.entries(attributes)) {
      if (Array.isArray(value) && new Set(value).size !== value.length) {
        context.addIssue({
          code: 'custom',
          message: 'Attribute values must be unique',
          path: [key],
        });
      }
    }
  });

const commerceListingRecordSchemaInner = commercePublicRecordBaseSchema
  .extend({
    recordType: z.literal('listing'),
    listingId: commerceEntityIdSchema,
    state: z.enum(['active', 'paused', 'ended', 'removed']),
    title: z.string().trim().min(COMMERCE_LISTING_TITLE_MIN_CHARS).max(COMMERCE_LISTING_TITLE_MAX_CHARS),
    description: z.string().trim().min(1).max(COMMERCE_LISTING_DESCRIPTION_MAX_CHARS),
    taxonomyVersion: z.number().int().min(COMMERCE_TAXONOMY_VERSION_MIN).max(COMMERCE_TAXONOMY_VERSION_MAX),
    categoryId: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected a kebab-case category id'),
    attributes: commerceListingAttributesSchema.optional(),
    condition: z.enum(['new', 'like_new', 'excellent', 'good', 'fair', 'for_parts']),
    conditionDetails: z.string().trim().max(1_000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(COMMERCE_LISTING_MAX_TAGS),
    location: commercePublicLocationSchema,
    media: z.array(commerceMediaSchema).min(1).max(COMMERCE_LISTING_MAX_MEDIA),
    variants: z.array(commerceVariantSchema).min(1).max(COMMERCE_LISTING_MAX_VARIANTS),
    sale: commerceSaleSchema,
    /**
     * One public array carrying two orthogonal vocabularies (local pickup
     * design §A2): the ITEM TYPE (`physical` | `digital`) this client and
     * the Nexus index read, and the FULFILLMENT METHODS (`shipping` |
     * `pickup`) the transaction service reads. The service's homeserver
     * derivation maps only `shipping`/`pickup` and deliberately ignores
     * every other value ("an unrecognized method is not a parse failure"),
     * so item types and fulfillment methods coexist here without either
     * side misreading the other: a shipped listing is `['physical']` (the
     * service defaults it to shipping-only), a pickup-offering listing adds
     * `'pickup'`, and a listing offering BOTH carries `'shipping'`
     * explicitly alongside `'pickup'` (without it the service derivation
     * would converge to pickup-only). Records predating pickup need no
     * migration — their array contains no fulfillment vocabulary and
     * derives to `['shipping']` (see {@link commerceListingFulfillmentMethods}).
     */
    fulfillmentMethods: z
      .array(z.enum(['physical', 'digital', 'shipping', 'pickup']))
      .min(1)
      .max(4),
    package: commercePackageSchema.optional(),
    shippingOptions: z.array(commerceShippingOptionSchema).max(20),
    returnPolicy: commerceReturnPolicySchema,
    digitalLock: commerceDigitalLockSchema.optional(),
    adultOnly: z.boolean(),
  })
  .passthrough()
  .superRefine((listing, context) => {
    validateRecordDates(listing, context);
    validateUniqueValues(
      listing.media.map(({ id }) => id),
      ['media'],
      'Media ids must be unique',
      context,
    );
    validateUniqueValues(
      listing.variants.map(({ id }) => id),
      ['variants'],
      'Variant ids must be unique',
      context,
    );
    validateUniqueValues(
      listing.variants.flatMap(({ sku }) => (sku ? [sku] : [])),
      ['variants'],
      'Variant SKUs must be unique',
      context,
    );
    validateUniqueValues(listing.tags, ['tags'], 'Tags must be unique', context);
    validateUniqueValues(
      listing.fulfillmentMethods,
      ['fulfillmentMethods'],
      'Fulfillment methods must be unique',
      context,
    );
    validateUniqueValues(
      listing.shippingOptions.map(({ id }) => id),
      ['shippingOptions'],
      'Shipping option ids must be unique',
      context,
    );

    const imageCount = listing.media.filter(({ type }) => type === 'image').length;
    const videoCount = listing.media.filter(({ type }) => type === 'video').length;
    if (imageCount === 0 || imageCount > COMMERCE_LISTING_MAX_IMAGES) {
      context.addIssue({
        code: 'custom',
        message: `Listings require 1-${COMMERCE_LISTING_MAX_IMAGES} images`,
        path: ['media'],
      });
    }
    if (videoCount > COMMERCE_LISTING_MAX_VIDEOS) {
      context.addIssue({
        code: 'custom',
        message: `Listings support at most ${COMMERCE_LISTING_MAX_VIDEOS} video`,
        path: ['media'],
      });
    }

    const mediaIds = new Set(listing.media.map(({ id }) => id));
    listing.variants.forEach((variant, variantIndex) => {
      variant.mediaIds.forEach((mediaId, mediaIndex) => {
        if (!mediaIds.has(mediaId)) {
          context.addIssue({
            code: 'custom',
            message: 'Variant references unknown media',
            path: ['variants', variantIndex, 'mediaIds', mediaIndex],
          });
        }
      });
    });

    if (listing.state === 'active' && !listing.variants.some(({ enabled, quantity }) => enabled && quantity > 0)) {
      context.addIssue({
        code: 'custom',
        message: 'An active listing requires available intended quantity',
        path: ['variants'],
      });
    }

    const hasPhysical = listing.fulfillmentMethods.includes('physical');
    const hasDigital = listing.fulfillmentMethods.includes('digital');
    if (hasPhysical && listing.package === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Physical fulfillment requires package facts',
        path: ['package'],
      });
    }
    if (hasPhysical && listing.shippingOptions.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Physical fulfillment requires a shipping option',
        path: ['shippingOptions'],
      });
    }
    if (!hasPhysical && (listing.package !== undefined || listing.shippingOptions.length > 0)) {
      context.addIssue({
        code: 'custom',
        message: 'Package and shipping options require physical fulfillment',
        path: ['fulfillmentMethods'],
      });
    }
    // Digital delivery design §6 A6–A8, A13: a digital listing may carry no
    // lock (marketplace-held delivery); a lock still requires `digital`.
    if (listing.digitalLock !== undefined && !hasDigital) {
      context.addIssue({
        code: 'custom',
        message: 'digitalLock requires digital fulfillment',
        path: ['digitalLock'],
      });
    }

    if (listing.sale.format === 'auction') {
      validateAuction(listing.sale, context);
      if (listing.variants.length !== 1) {
        context.addIssue({
          code: 'custom',
          message: 'Auction listings require exactly one variant',
          path: ['variants'],
        });
      }
    }

    const primaryMoney = listing.sale.format === 'fixed_price' ? listing.sale.unitPrice : listing.sale.startingPrice;
    listing.variants.forEach((variant, variantIndex) => {
      if (variant.priceOverride && !hasSameAsset(primaryMoney, variant.priceOverride)) {
        context.addIssue({
          code: 'custom',
          message: 'Variant price must use the listing asset and exponent',
          path: ['variants', variantIndex, 'priceOverride'],
        });
      }
    });
    listing.shippingOptions.forEach((option, optionIndex) => {
      if (option.pricing === 'flat' && !hasSameAsset(primaryMoney, option.price)) {
        context.addIssue({
          code: 'custom',
          message: 'Shipping price must use the listing asset and exponent',
          path: ['shippingOptions', optionIndex, 'price'],
        });
      }
    });

    const mediaPrefix = `pubky://${listing.ownerPubky}/pub/pubky.app/marketplace/v1/media/`;
    listing.media.forEach((media, mediaIndex) => {
      if (!media.url.startsWith(mediaPrefix)) {
        context.addIssue({
          code: 'custom',
          message: 'Listing media must be owned by the listing seller',
          path: ['media', mediaIndex, 'url'],
        });
      }
    });
  });

const commerceReviewRecordSchemaInner = commercePublicRecordBaseSchema
  .extend({
    recordType: z.literal('review'),
    reviewId: commerceEntityIdSchema,
    subjectPubky: commercePubkySchema,
    listingOwnerPubky: commercePubkySchema,
    listingId: commerceEntityIdSchema,
    role: z.enum(['buyer_reviewing_seller', 'seller_reviewing_buyer']),
    ratings: z
      .object({
        overall: z.number().int().min(1).max(5),
        itemAccuracy: z.number().int().min(1).max(5).optional(),
        shipping: z.number().int().min(1).max(5).optional(),
        communication: z.number().int().min(1).max(5).optional(),
      })
      .passthrough(),
    text: z.string().trim().min(1).max(COMMERCE_REVIEW_TEXT_MAX_CHARS),
    eligibilityAttestation: z
      .string()
      .min(32)
      .max(4_096)
      .regex(/^[A-Za-z0-9._~-]+$/),
  })
  .passthrough()
  .superRefine(validateRecordDates);

/**
 * The subject's response to a marketplace review (`PubkyAppReviewResponse`,
 * specs fork v0.6.2-marketplace.3), published on the SUBJECT's homeserver at
 * `/pub/pubky.app/marketplace/v1/review_responses/{review_id}` — the path ID
 * equals the subject review's ID, structurally capping responses at one
 * revisable response per review (ratified D7). Authorization is structural:
 * indexers accept the record only when its owner equals the review's
 * `subjectPubky`; there is no attestation and no service command.
 */
const commerceReviewResponseRecordSchemaInner = commercePublicRecordBaseSchema
  .extend({
    recordType: z.literal('review_response'),
    reviewId: commerceEntityIdSchema,
    reviewUri: z
      .string()
      .regex(
        /^pubky:\/\/[a-z0-9]{52}\/pub\/pubky\.app\/marketplace\/v1\/reviews\/[0-9A-HJKMNP-TV-Z]+$/,
        'reviewUri must be a canonical marketplace review URI',
      ),
    text: z.string().trim().min(1).max(COMMERCE_REVIEW_TEXT_MAX_CHARS),
  })
  .passthrough()
  .superRefine(validateRecordDates);

const commerceCollectionRecordSchemaInner = commercePublicRecordBaseSchema
  .extend({
    recordType: z.literal('collection'),
    collectionId: commerceEntityIdSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1_000),
    listingIds: z.array(commerceEntityIdSchema).max(200),
    coverMediaUrl: marketplacePublicUriSchema.optional(),
  })
  .passthrough()
  .superRefine((collection, context) => {
    validateRecordDates(collection, context);
    validateUniqueValues(collection.listingIds, ['listingIds'], 'Collection listing ids must be unique', context);
  });

// Deletion note (social/v1 alignment, ADR 0020 as amended): ABSENCE is the
// tombstone. Deletes remove the record file; no tombstone record type exists.
// The substrate cannot enforce a tombstone against the owner's own writes,
// public tombstones would leak deletion metadata forever, and receipt JWSes
// keep a buyer's history verifiable after a listing disappears.

export const commercePublicRecordSchema = reserveFreePublicRecordInputSchema
  .transform(stripSerializedNulls)
  .pipe(
    z.union([
      commerceShopRecordSchemaInner,
      commerceListingRecordSchemaInner,
      commerceReviewRecordSchemaInner,
      commerceCollectionRecordSchemaInner,
    ]),
  );

function validateRecordDates(record: { createdAt: string; updatedAt: string }, context: z.RefinementCtx): void {
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    context.addIssue({
      code: 'custom',
      message: 'updatedAt must not precede createdAt',
      path: ['updatedAt'],
    });
  }
}

function validateUniqueValues(values: string[], path: PropertyKey[], message: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message, path });
  }
}

function hasSameAsset(
  left: { currency: string; exponent: number },
  right: { currency: string; exponent: number },
): boolean {
  return left.currency === right.currency && left.exponent === right.exponent;
}

function validateAuction(auction: z.infer<typeof auctionSaleSchema>, context: z.RefinementCtx): void {
  if (Date.parse(auction.endsAt) <= Date.parse(auction.startsAt)) {
    context.addIssue({
      code: 'custom',
      message: 'Auction end must follow its start',
      path: ['sale', 'endsAt'],
    });
  }

  const prices = [
    ['buyNowPrice', auction.buyNowPrice],
    ['minimumIncrement', auction.minimumIncrement],
  ] as const;
  for (const [field, price] of prices) {
    if (price && !hasSameAsset(auction.startingPrice, price)) {
      context.addIssue({
        code: 'custom',
        message: 'Auction prices must use one asset and exponent',
        path: ['sale', field],
      });
    }
  }

  if (auction.buyNowPrice && auction.buyNowPrice.amountMinor <= auction.startingPrice.amountMinor) {
    context.addIssue({
      code: 'custom',
      message: 'Buy-now price must exceed the starting price',
      path: ['sale', 'buyNowPrice'],
    });
  }
}

export type CommerceDigitalLock = z.infer<typeof commerceDigitalLockSchema>;
/**
 * The studios serialize unset optional form fields as explicit `null`s, and
 * published records keep them forever. The specs crate accepts those nulls,
 * so canonical records on homeservers legitimately contain them — but every
 * optional field in these schemas means "absent", never "meaningfully null",
 * so reads normalize `null` to absent before validation. Without this, a
 * record becomes unloadable for everyone except the seller whose local cache
 * already holds it.
 */
function stripSerializedNulls(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(stripSerializedNulls);
  if (input !== null && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => [key, stripSerializedNulls(value)]),
    );
  }
  return input;
}

const commerceEpochMillisSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const commerceWatchlistItemSchema = z
  .object({
    listingOwnerPubky: commercePubkySchema,
    listingId: commerceEntityIdSchema,
    watchedAtMs: commerceEpochMillisSchema,
  })
  .passthrough();

const commerceWatchlistTombstoneSchema = z
  .object({
    listingOwnerPubky: commercePubkySchema,
    listingId: commerceEntityIdSchema,
    removedAtMs: commerceEpochMillisSchema,
  })
  .passthrough();

/**
 * The PRIVATE watchlist document at `/priv/pubky.app/marketplace/v1/watchlist.json`
 * (pubky-app-specs 0.6.2-marketplace.6). Entry timestamps are integer epoch
 * milliseconds — they are last-write-wins merge keys compared numerically.
 * Every listing key appears at most once across items AND tombstones: the
 * document is the post-merge resolved state.
 */
const commerceWatchlistRecordSchemaInner = commercePublicRecordBaseSchema
  .extend({
    recordType: z.literal('watchlist'),
    items: z.array(commerceWatchlistItemSchema).max(500),
    tombstones: z.array(commerceWatchlistTombstoneSchema).max(500),
  })
  .passthrough()
  .superRefine((watchlist, context) => {
    validateRecordDates(watchlist, context);
    const keys = [...watchlist.items, ...watchlist.tombstones].map(
      (entry) => `${entry.listingOwnerPubky}:${entry.listingId}`,
    );
    validateUniqueValues(keys, ['items'], 'Watchlist listing keys must be unique across items and tombstones', context);
  });

/**
 * The public drop record (specs `0.6.2-marketplace.8`, ADR 0026): the
 * seller-signed announcement of a timed, limited release at
 * `/pub/pubky.app/marketplace/v1/drops/{dropId}`. `startsAt`/`endsAt` are
 * the seller's stated intent — the transaction service's drop aggregate is
 * the enforced schedule, and the UI must never render `live`, remaining
 * stock, or `sold out` from this record alone.
 */
const commerceDropRecordSchemaInner = commercePublicRecordBaseSchema
  .extend({
    recordType: z.literal('drop'),
    dropId: commerceEntityIdSchema,
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000),
    media: z.array(marketplacePublicUriSchema).max(10).default([]),
    format: z.literal('fcfs'),
    startsAt: commerceTimestampSchema,
    endsAt: commerceTimestampSchema.optional(),
    listingIds: z.array(commerceEntityIdSchema).min(1).max(20),
    totalQuantity: z.number().int().min(1).max(1_000_000),
    perBuyerLimit: z.number().int().min(1).max(100),
    stockDisplay: z.enum(['exact', 'bands', 'hidden']),
    createdAt: commerceTimestampSchema,
    updatedAt: commerceTimestampSchema,
  })
  .passthrough()
  .superRefine((drop, context) => {
    validateRecordDates(drop, context);
    if (drop.endsAt !== undefined && Date.parse(drop.endsAt) <= Date.parse(drop.startsAt)) {
      context.addIssue({ code: 'custom', path: ['endsAt'], message: 'endsAt must be after startsAt' });
    }
    if (drop.perBuyerLimit > drop.totalQuantity) {
      context.addIssue({
        code: 'custom',
        path: ['perBuyerLimit'],
        message: 'perBuyerLimit cannot exceed totalQuantity',
      });
    }
    validateUniqueValues(drop.listingIds, ['listingIds'], 'Drop listing ids must be unique', context);
  });

/**
 * The portable order receipt (specs `0.6.2-marketplace.7`): a PRIVATE
 * record at `/priv/pubky.app/marketplace/v1/receipts/{receiptId}` the buyer
 * or seller writes to their OWN homeserver, carrying the service-signed
 * `pubky-order-receipt+v1` or `+v2` JWS so purchase history stays verifiable after
 * the marketplace operator disappears. Never indexed, never public.
 */
const commerceOrderReceiptRecordSchemaInner = commercePublicRecordBaseSchema
  .extend({
    recordType: z.literal('order_receipt'),
    role: z.enum(['buyer', 'seller']),
    receiptId: z.uuid(),
    orderId: z.uuid(),
    buyerPubky: commercePubkySchema,
    sellerPubky: commercePubkySchema,
    total: commerceMoneySchema,
    settlementTotal: commerceMoneySchema.optional(),
    paidAt: commerceTimestampSchema,
    receiptAttestation: z
      .string()
      .min(32)
      .max(4_096)
      .regex(/^[A-Za-z0-9._~-]+$/),
    // Both optional fields arrived in specs 0.6.2-marketplace.8 (ADR 0026):
    // a drop order's edition proof. Present together or absent together.
    editionAttestation: z
      .string()
      .min(32)
      .max(4_096)
      .regex(/^[A-Za-z0-9._~-]+$/)
      .optional(),
    drop: z
      .object({
        dropId: commerceEntityIdSchema,
        edition: z.number().int().min(1),
        of: z.number().int().min(1),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((receipt, context) => {
    validateRecordDates(receipt, context);
    const partyForRole = receipt.role === 'buyer' ? receipt.buyerPubky : receipt.sellerPubky;
    if (receipt.ownerPubky !== partyForRole) {
      context.addIssue({
        code: 'custom',
        path: ['role'],
        message: 'The record owner must be the party its role names',
      });
    }
    if (receipt.buyerPubky === receipt.sellerPubky) {
      context.addIssue({ code: 'custom', path: ['sellerPubky'], message: 'Buyer and seller must differ' });
    }
    if ((receipt.editionAttestation === undefined) !== (receipt.drop === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['editionAttestation'],
        message: 'editionAttestation and drop must be present together',
      });
    }
    if (receipt.drop !== undefined && receipt.drop.of < receipt.drop.edition) {
      context.addIssue({ code: 'custom', path: ['drop'], message: 'of cannot be less than edition' });
    }
  });

export const commerceShopRecordSchema = z.preprocess(stripSerializedNulls, commerceShopRecordSchemaInner);
export const commerceListingRecordSchema = reserveFreePublicRecordInputSchema
  .transform(stripSerializedNulls)
  .pipe(commerceListingRecordSchemaInner);
export const commerceReviewRecordSchema = z.preprocess(stripSerializedNulls, commerceReviewRecordSchemaInner);
export const commerceReviewResponseRecordSchema = z.preprocess(
  stripSerializedNulls,
  commerceReviewResponseRecordSchemaInner,
);
export const commerceCollectionRecordSchema = z.preprocess(stripSerializedNulls, commerceCollectionRecordSchemaInner);
export const commerceWatchlistRecordSchema = z.preprocess(stripSerializedNulls, commerceWatchlistRecordSchemaInner);
export const commerceOrderReceiptRecordSchema = z.preprocess(
  stripSerializedNulls,
  commerceOrderReceiptRecordSchemaInner,
);
export const commerceDropRecordSchema = z.preprocess(stripSerializedNulls, commerceDropRecordSchemaInner);

export const commerceAuctionReserveRecordSchema = z
  .object({
    schemaVersion: z.literal(COMMERCE_CONTRACT_VERSION),
    recordType: z.literal('auction_reserve'),
    ownerPubky: commercePubkySchema,
    listingId: commerceEntityIdSchema,
    listingRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    recordRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    writeId: z.uuid(),
    reservePrice: commercePositiveMoneySchema.nullable(),
    createdAt: commerceTimestampSchema,
    updatedAt: commerceTimestampSchema,
    ext: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((record, context) => validateRecordDates(record, context));

export type CommerceShopRecord = z.infer<typeof commerceShopRecordSchema>;
export type CommerceListingRecord = z.infer<typeof commerceListingRecordSchema>;
export type CommerceReviewRecord = z.infer<typeof commerceReviewRecordSchema>;
export type CommerceReviewResponseRecord = z.infer<typeof commerceReviewResponseRecordSchema>;
export type CommerceCollectionRecord = z.infer<typeof commerceCollectionRecordSchema>;
export type CommerceWatchlistRecord = z.infer<typeof commerceWatchlistRecordSchema>;
export type CommerceOrderReceiptRecord = z.infer<typeof commerceOrderReceiptRecordSchema>;
export type CommerceDropRecord = z.infer<typeof commerceDropRecordSchema>;
export type CommerceAuctionReserveRecord = z.infer<typeof commerceAuctionReserveRecordSchema>;
export type CommerceWatchlistRecordItem = CommerceWatchlistRecord['items'][number];
export type CommerceWatchlistRecordTombstone = CommerceWatchlistRecord['tombstones'][number];
export type CommercePublicRecord = z.infer<typeof commercePublicRecordSchema>;
