import { COMMERCE_CONTRACT_VERSION } from '@/config/commerce';
import type { CommerceListingProjectionModelSchema } from '@/models/commerce/commerce.schema';
import {
  type CommerceListingRecord,
  commerceListingRecordSchema,
  type CommerceShopRecord,
  commerceShopRecordSchema,
} from './marketplace-records';

export interface CommerceSandboxCatalog {
  shops: CommerceShopRecord[];
  listings: CommerceListingRecord[];
  projections: CommerceListingProjectionModelSchema[];
}

type CatalogEntry = {
  seller: string;
  shopName: string;
  listingId: string;
  title: string;
  description: string;
  /**
   * Entries without an explicit version simulate records published under
   * taxonomy v1 (flat categories, no attributes) — they exercise the
   * legacy-id resolution path. v2 entries carry item specifics.
   */
  taxonomyVersion?: number;
  categoryId: string;
  attributes?: Record<string, string | string[]>;
  condition: CommerceListingRecord['condition'];
  amountMinor: number;
  tags: string[];
  saleFormat: CommerceListingRecord['sale']['format'];
  /**
   * Pickup demo axis (local pickup design §A2): listings ship by default and
   * auctions are ALWAYS shipping-only (the service refuses to register a
   * pickup auction), so exactly two fixed-price entries opt into pickup —
   * one pickup-only, one shipping-and-pickup — exercising all three badge
   * states. Record vocabulary mirrors the studio's fulfillmentMethodsFromForm.
   */
  pickup?: 'only' | 'also';
  colorHash: string;
};

const CATALOG_ENTRIES: CatalogEntry[] = [
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
    pickup: 'only',
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
    pickup: 'also',
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
  {
    seller: 'p'.repeat(52),
    shopName: 'Ninetieth Percentile',
    listingId: 'varsity_fleece',
    title: 'Heavyweight varsity fleece',
    description: 'Boxy 90s collegiate fleece with an embroidered chest hit.',
    taxonomyVersion: 2,
    categoryId: 'fashion-men-tops-hoodies',
    attributes: {
      size: 'L',
      brand: 'Champion',
      color: ['grey', 'navy'],
      source: 'vintage',
      age: '90s',
      style: ['retro', 'sportswear'],
    },
    condition: 'good',
    amountMinor: 7_200,
    tags: ['vintage', 'fleece'],
    saleFormat: 'fixed_price',
    colorHash: '3',
  },
  {
    seller: 'q'.repeat(52),
    shopName: 'Shutter Priority',
    listingId: 'slr_program',
    title: 'Program-mode 35mm SLR',
    description: 'Clean program-mode SLR body with a fresh light seal service.',
    taxonomyVersion: 2,
    categoryId: 'electronics-cameras-film',
    attributes: {
      brand: 'Canon',
      model: 'AE-1 Program',
      color: ['black'],
    },
    condition: 'excellent',
    amountMinor: 21_000,
    tags: ['film', 'slr'],
    saleFormat: 'fixed_price',
    colorHash: '5',
  },
];

export function createCommerceSandboxCatalog(): CommerceSandboxCatalog {
  const shops = CATALOG_ENTRIES.map(({ seller, shopName }, index) =>
    commerceShopRecordSchema.parse({
      schemaVersion: COMMERCE_CONTRACT_VERSION,
      recordType: 'shop',
      ownerPubky: seller,
      revision: 1,
      createdAt: '2026-08-19T20:00:00.000Z',
      updatedAt: `2026-08-19T21:${index.toString().padStart(2, '0')}:00.000Z`,
      name: shopName,
      bio: 'Independent seller on the Pubky marketplace.',
      location: { countryCode: 'US' },
      shippingPolicy: 'Ships within three business days.',
      returnPolicy: 'Returns accepted within 30 days.',
      vacationMode: false,
    }),
  );

  const listings = CATALOG_ENTRIES.map((entry, index) => createListing(entry, index));
  const projections = listings.map((listing, index) => {
    const price = listing.sale.format === 'fixed_price' ? listing.sale.unitPrice : listing.sale.startingPrice;
    return {
      id: `${listing.ownerPubky}:${listing.listingId}`,
      seller_id: listing.ownerPubky,
      listing_id: listing.listingId,
      listing_revision: listing.revision,
      content_hash: listing.media[0].contentHash,
      server_revision: 1,
      state: 'available' as const,
      available_quantity: 1,
      current_price: price,
      auction_state: listing.sale.format === 'auction' ? ('active' as const) : null,
      bid_count: listing.sale.format === 'auction' ? index + 2 : 0,
      sync_status: 'synced' as const,
      synced_at: Date.parse(listing.updatedAt),
    };
  });

  return { shops, listings, projections };
}

function createListing(entry: CatalogEntry, index: number): CommerceListingRecord {
  const imageId = `${entry.listingId}_image`;
  // Auctions never reach this helper with pickup set (see CatalogEntry), so
  // the default branch covers them: shipped physical goods with one flat
  // ground option, matching the studio's shipping publish shape.
  const fulfillmentMethods: CommerceListingRecord['fulfillmentMethods'] =
    entry.pickup === 'only' ? ['pickup'] : entry.pickup === 'also' ? ['physical', 'shipping', 'pickup'] : ['physical'];
  const ships = fulfillmentMethods.includes('physical');
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

  return commerceListingRecordSchema.parse({
    schemaVersion: COMMERCE_CONTRACT_VERSION,
    recordType: 'listing',
    ownerPubky: entry.seller,
    revision: 1,
    createdAt: '2026-08-19T20:00:00.000Z',
    updatedAt: `2026-08-19T21:${index.toString().padStart(2, '0')}:00.000Z`,
    listingId: entry.listingId,
    state: 'active',
    title: entry.title,
    description: entry.description,
    taxonomyVersion: entry.taxonomyVersion ?? 1,
    categoryId: entry.categoryId,
    attributes: entry.attributes,
    condition: entry.condition,
    tags: entry.tags,
    location: { countryCode: 'US' },
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
    fulfillmentMethods,
    ...(ships
      ? {
          package: {
            weightGrams: 1_200,
            lengthMillimeters: 350,
            widthMillimeters: 250,
            heightMillimeters: 150,
          },
          shippingOptions: [
            {
              id: 'ground',
              pricing: 'flat' as const,
              label: 'Ground shipping',
              price: { amountMinor: 1_200, currency: 'USD', exponent: 2 },
              estimatedMinDays: 3,
              estimatedMaxDays: 7,
            },
          ],
        }
      : { shippingOptions: [] }),
    returnPolicy: {
      acceptsReturns: true,
      returnWindowDays: 30,
      buyerPaysReturnShipping: true,
    },
    adultOnly: false,
  });
}
