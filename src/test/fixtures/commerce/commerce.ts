import { COMMERCE_CONTRACT_VERSION, COMMERCE_TAXONOMY_VERSION } from '@/config/commerce';
import type { CommerceListingRecord, CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import type {
  CommerceCatalogEntryModelSchema,
  CommerceListingProjectionModelSchema,
  CommerceSyncJobModelSchema,
} from '@/models/commerce/commerce.schema';
import type { NexusListingDetails } from '@/services/nexus/marketplace/marketplace.types';

export const COMMERCE_FIXTURE_SELLER = 'y'.repeat(52);
export const COMMERCE_FIXTURE_BUYER = 'b'.repeat(52);
export const COMMERCE_FIXTURE_CREATED_AT = '2026-08-19T20:00:00.000Z';
export const COMMERCE_FIXTURE_UPDATED_AT = '2026-08-19T21:00:00.000Z';

export function createCommerceShopFixture(overrides: Partial<CommerceShopRecord> = {}): CommerceShopRecord {
  return {
    schemaVersion: COMMERCE_CONTRACT_VERSION,
    recordType: 'shop',
    ownerPubky: COMMERCE_FIXTURE_SELLER,
    revision: 1,
    createdAt: COMMERCE_FIXTURE_CREATED_AT,
    updatedAt: COMMERCE_FIXTURE_UPDATED_AT,
    name: 'Satoshi Vintage',
    bio: 'Circular fashion and Bitcoin.',
    location: { countryCode: 'US', region: 'NY' },
    shippingPolicy: 'Ships within three business days.',
    returnPolicy: 'Returns accepted within 30 days.',
    vacationMode: false,
    ...overrides,
  };
}

export function createCommerceListingFixture(overrides: Partial<CommerceListingRecord> = {}): CommerceListingRecord {
  return {
    schemaVersion: COMMERCE_CONTRACT_VERSION,
    recordType: 'listing',
    ownerPubky: COMMERCE_FIXTURE_SELLER,
    revision: 1,
    createdAt: COMMERCE_FIXTURE_CREATED_AT,
    updatedAt: COMMERCE_FIXTURE_UPDATED_AT,
    listingId: 'boots_01',
    state: 'active',
    title: 'Vintage leather boots',
    description: 'Well cared for boots with light wear.',
    taxonomyVersion: COMMERCE_TAXONOMY_VERSION,
    categoryId: 'fashion-shoes-boots',
    condition: 'good',
    tags: ['vintage'],
    location: { countryCode: 'US', region: 'NY' },
    media: [
      {
        id: 'image_01',
        type: 'image',
        url: `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/image_01`,
        contentHash: 'a'.repeat(64),
        mimeType: 'image/jpeg',
        byteSize: 10_000,
        width: 1_200,
        height: 1_600,
        altText: 'Brown leather boots',
      },
    ],
    variants: [
      {
        id: 'variant_01',
        options: { size: '42' },
        quantity: 1,
        mediaIds: ['image_01'],
        enabled: true,
      },
    ],
    sale: {
      format: 'fixed_price',
      unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
      acceptsOffers: true,
    },
    // The production shipping default (§A2): a shipped listing publishes the
    // record's `physical` vocabulary, which the service reads as
    // shipping-only — and the record schema couples `physical` to package
    // facts and a shipping option, so the default carries both. Pickup
    // scenes must override this explicitly.
    fulfillmentMethods: ['physical'],
    package: { weightGrams: 800, lengthMillimeters: 320, widthMillimeters: 220, heightMillimeters: 120 },
    shippingOptions: [
      {
        id: 'ship_01',
        pricing: 'flat',
        label: 'Standard shipping',
        price: { amountMinor: 1_200, currency: 'USD', exponent: 2 },
        estimatedMinDays: 3,
        estimatedMaxDays: 7,
      },
    ],
    returnPolicy: {
      acceptsReturns: true,
      returnWindowDays: 30,
      buyerPaysReturnShipping: true,
    },
    adultOnly: false,
    ...overrides,
  };
}

/** The lossy Nexus index projection of the listing built by `createCommerceListingFixture`. */
export function createNexusListingDetailsFixture(overrides: Partial<NexusListingDetails> = {}): NexusListingDetails {
  return {
    id: 'boots_01',
    uri: `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/listings/boots_01`,
    owner_id: COMMERCE_FIXTURE_SELLER,
    indexed_at: Date.parse(COMMERCE_FIXTURE_UPDATED_AT),
    state: 'active',
    title: 'Vintage leather boots',
    description: 'Well cared for boots with light wear.',
    category_id: 'fashion-shoes-boots',
    condition: 'good',
    tags: ['vintage'],
    country_code: 'US',
    region: 'NY',
    media_urls: [`pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/image_01`],
    sale_format: 'fixed_price',
    price_amount_minor: 12_500,
    price_currency: 'USD',
    price_exponent: 2,
    auction_starts_at: null,
    auction_ends_at: null,
    auction_buy_now_price_minor: null,
    auction_minimum_increment_minor: null,
    // What the wire carries for the default shipped listing above: the
    // service derives `['shipping']` from the record's `physical`.
    fulfillment_methods: ['shipping'],
    adult_only: false,
    created_at: COMMERCE_FIXTURE_CREATED_AT,
    updated_at: COMMERCE_FIXTURE_UPDATED_AT,
    revision: 1,
    ...overrides,
  };
}

/** The Nexus projection of an auction listing whose index row carries the full auction terms. */
export function createNexusAuctionListingDetailsFixture(
  overrides: Partial<NexusListingDetails> = {},
): NexusListingDetails {
  return createNexusListingDetailsFixture({
    id: 'rangefinder_camera',
    uri: `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/listings/rangefinder_camera`,
    title: '35mm rangefinder camera',
    description: 'Recently serviced mechanical rangefinder with bright optics.',
    category_id: 'electronics-cameras-film',
    condition: 'excellent',
    tags: ['film', 'camera'],
    media_urls: [`pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/rangefinder_camera_image`],
    sale_format: 'auction',
    price_amount_minor: 4_500,
    auction_starts_at: '2026-08-19T20:00:00.000Z',
    auction_ends_at: '2026-08-29T20:00:00.000Z',
    auction_buy_now_price_minor: 12_500,
    auction_minimum_increment_minor: 500,
    ...overrides,
  });
}

/** The normalized catalog-entry model produced from `createNexusListingDetailsFixture`. */
export function createCommerceCatalogEntryFixture(
  overrides: Partial<CommerceCatalogEntryModelSchema> = {},
): CommerceCatalogEntryModelSchema {
  return {
    id: `${COMMERCE_FIXTURE_SELLER}:boots_01`,
    seller_id: COMMERCE_FIXTURE_SELLER,
    listing_id: 'boots_01',
    state: 'active',
    title: 'Vintage leather boots',
    description: 'Well cared for boots with light wear.',
    category_id: 'fashion-shoes-boots',
    condition: 'good',
    tags: ['vintage'],
    country_code: 'US',
    region: 'NY',
    media_urls: [`pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/image_01`],
    sale_format: 'fixed_price',
    price: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
    auction: null,
    // The normalized copy of the index row above: `['shipping']` for the
    // default shipped listing (the service-facing vocabulary, §A2).
    fulfillment_methods: ['shipping'],
    reputation: null,
    listing_reputation: null,
    revision: 1,
    updated_at: Date.parse(COMMERCE_FIXTURE_UPDATED_AT),
    ...overrides,
  };
}

export interface CommerceSandboxCatalogFixture {
  shops: CommerceShopRecord[];
  listings: CommerceListingRecord[];
  projections: CommerceListingProjectionModelSchema[];
}

export function createCommerceSandboxCatalogFixture(): CommerceSandboxCatalogFixture {
  const entries: Array<{
    seller: string;
    shopName: string;
    listingId: string;
    title: string;
    description: string;
    categoryId: string;
    condition: CommerceListingRecord['condition'];
    amountMinor: number;
    tags: string[];
    saleFormat: CommerceListingRecord['sale']['format'];
    colorHash: string;
  }> = [
    {
      seller: 'y'.repeat(52),
      shopName: 'Satoshi Vintage',
      listingId: 'leather_boots',
      title: 'Vintage leather boots',
      description: 'Hand-finished leather boots with a softly worn patina.',
      categoryId: 'fashion-shoes-boots',
      condition: 'good',
      amountMinor: 12_500,
      tags: ['vintage', 'leather'],
      saleFormat: 'fixed_price',
      colorHash: 'a',
    },
    {
      seller: 'b'.repeat(52),
      shopName: 'Block 9 Archive',
      listingId: 'selvedge_jacket',
      title: 'Selvedge denim jacket',
      description: 'Structured Japanese denim with copper hardware.',
      categoryId: 'fashion-jackets',
      condition: 'excellent',
      amountMinor: 8_900,
      tags: ['denim', 'archive'],
      saleFormat: 'fixed_price',
      colorHash: 'b',
    },
    {
      seller: 'n'.repeat(52),
      shopName: 'Proof of Film',
      listingId: 'rangefinder_camera',
      title: '35mm rangefinder camera',
      description: 'Recently serviced mechanical rangefinder with bright optics.',
      categoryId: 'electronics-cameras-film',
      condition: 'excellent',
      amountMinor: 4_500,
      tags: ['film', 'camera'],
      saleFormat: 'auction',
      colorHash: 'c',
    },
    {
      seller: 'd'.repeat(52),
      shopName: 'Soft Fork Studio',
      listingId: 'ceramic_vase',
      title: 'Hand-thrown ceramic vase',
      description: 'One-of-one stoneware vase with a reactive mineral glaze.',
      categoryId: 'home-decor-ceramics',
      condition: 'new',
      amountMinor: 6_400,
      tags: ['ceramics', 'handmade'],
      saleFormat: 'fixed_price',
      colorHash: 'd',
    },
    {
      seller: 'r'.repeat(52),
      shopName: 'Signal Records',
      listingId: 'jazz_first_press',
      title: 'Rare jazz first pressing',
      description: 'Clean first pressing in a preserved original sleeve.',
      categoryId: 'collectibles-music-vinyl',
      condition: 'good',
      amountMinor: 3_800,
      tags: ['vinyl', 'jazz'],
      saleFormat: 'fixed_price',
      colorHash: 'e',
    },
    {
      seller: 'f'.repeat(52),
      shopName: 'Open Trail',
      listingId: 'trail_runners',
      title: 'Technical trail runners',
      description: 'Lightweight grip-focused runners tested for one short trail.',
      categoryId: 'fashion-shoes-sneakers',
      condition: 'like_new',
      amountMinor: 9_500,
      tags: ['outdoor', 'running'],
      saleFormat: 'fixed_price',
      colorHash: 'f',
    },
    {
      seller: 'g'.repeat(52),
      shopName: 'Low Time Preference',
      listingId: 'silver_signet',
      title: 'Brutalist silver signet',
      description: 'Solid recycled silver ring cast and finished by hand.',
      categoryId: 'fashion-jewelry-rings',
      condition: 'new',
      amountMinor: 12_000,
      tags: ['silver', 'handmade'],
      saleFormat: 'auction',
      colorHash: '0',
    },
    {
      seller: '8'.repeat(52),
      shopName: 'Key Ceremony',
      listingId: 'mechanical_keyboard',
      title: 'Custom mechanical keyboard',
      description: 'Compact aluminum build with tactile switches and artisan caps.',
      categoryId: 'electronics-computers-keyboards',
      condition: 'excellent',
      amountMinor: 14_000,
      tags: ['keyboard', 'custom'],
      saleFormat: 'fixed_price',
      colorHash: '1',
    },
  ];

  const shops = entries.map(({ seller, shopName }, index) =>
    createCommerceShopFixture({
      ownerPubky: seller,
      name: shopName,
      bio: 'Independent seller on the Pubky marketplace.',
      updatedAt: `2026-08-19T21:${index.toString().padStart(2, '0')}:00.000Z`,
    }),
  );

  const listings = entries.map((entry, index) => {
    const imageId = `${entry.listingId}_image`;
    const sale: CommerceListingRecord['sale'] =
      entry.saleFormat === 'auction'
        ? {
            format: 'auction',
            startingPrice: { amountMinor: entry.amountMinor, currency: 'USD', exponent: 2 },
            buyNowPrice: { amountMinor: entry.amountMinor + 8_000, currency: 'USD', exponent: 2 },
            minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
            startsAt: '2026-08-19T20:00:00.000Z',
            endsAt: '2026-08-29T20:00:00.000Z',
            antiSnipingWindowSeconds: 120,
            antiSnipingExtensionSeconds: 120,
          }
        : {
            format: 'fixed_price',
            unitPrice: { amountMinor: entry.amountMinor, currency: 'USD', exponent: 2 },
            acceptsOffers: true,
          };

    return createCommerceListingFixture({
      ownerPubky: entry.seller,
      listingId: entry.listingId,
      title: entry.title,
      description: entry.description,
      categoryId: entry.categoryId,
      condition: entry.condition,
      tags: entry.tags,
      updatedAt: `2026-08-19T21:${index.toString().padStart(2, '0')}:00.000Z`,
      media: [
        {
          id: imageId,
          type: 'image',
          url: `pubky://${entry.seller}/pub/pubky.app/marketplace/v1/media/${imageId}`,
          contentHash: entry.colorHash.repeat(64),
          mimeType: 'image/jpeg',
          byteSize: 10_000,
          width: 1_200,
          height: 1_600,
          altText: entry.title,
        },
      ],
      variants: [
        {
          id: 'default',
          options: {},
          quantity: 1,
          mediaIds: [imageId],
          enabled: true,
        },
      ],
      sale,
    });
  });

  const projections = listings.map((listing, index) => {
    const price = listing.sale.format === 'fixed_price' ? listing.sale.unitPrice : listing.sale.startingPrice;
    return createCommerceProjectionFixture({
      id: `${listing.ownerPubky}:${listing.listingId}`,
      seller_id: listing.ownerPubky,
      listing_id: listing.listingId,
      listing_revision: listing.revision,
      content_hash: listing.media[0].contentHash,
      server_revision: 1,
      current_price: price,
      auction_state: listing.sale.format === 'auction' ? 'active' : null,
      bid_count: listing.sale.format === 'auction' ? index + 2 : 0,
      synced_at: Date.parse(listing.updatedAt),
    });
  });

  return { shops, listings, projections };
}

export function createCommerceProjectionFixture(
  overrides: Partial<CommerceListingProjectionModelSchema> = {},
): CommerceListingProjectionModelSchema {
  return {
    id: `${COMMERCE_FIXTURE_SELLER}:boots_01`,
    seller_id: COMMERCE_FIXTURE_SELLER,
    listing_id: 'boots_01',
    listing_revision: 1,
    content_hash: 'c'.repeat(64),
    server_revision: 3,
    state: 'available',
    available_quantity: 1,
    current_price: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
    auction_state: null,
    bid_count: 0,
    sync_status: 'synced',
    synced_at: 3_000,
    ...overrides,
  };
}

export function createCommerceSyncJobFixture(
  overrides: Partial<CommerceSyncJobModelSchema> = {},
): CommerceSyncJobModelSchema {
  return {
    id: '018f47d2-6a27-7c23-a49d-6b21bb770120',
    owner_id: COMMERCE_FIXTURE_SELLER,
    entity_type: 'listing',
    entity_id: 'boots_01',
    operation: 'publish',
    status: 'pending',
    attempts: 0,
    next_attempt_at: 1_000,
    last_error_code: null,
    payload: { listingId: 'boots_01' },
    created_at: 500,
    updated_at: 500,
    ...overrides,
  };
}
