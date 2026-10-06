import { describe, expect, it } from 'vitest';
import { COMMERCE_CONTRACT_VERSION, COMMERCE_TAXONOMY_VERSION } from '@/config/commerce';
import { createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import receiptAttestationV1 from '@/test/fixtures/commerce/receipt-attestation-v1.json';
import receiptAttestationV2Bitcoin from '@/test/fixtures/commerce/receipt-attestation-v2-bitcoin.json';
import receiptAttestationV2SameCurrency from '@/test/fixtures/commerce/receipt-attestation-v2-same-currency.json';
import { asInvalid } from '@/test-utils/type-assertions';
import { verifyOrderReceiptClaims, verifyOwnOrderReceipt } from './attestation';
import {
  commerceAuctionReserveRecordSchema,
  commerceCollectionRecordSchema,
  commerceDropRecordSchema,
  commerceListingFulfillmentMethods,
  type CommerceListingRecord,
  commerceListingRecordSchema,
  commerceListingShippingMinor,
  commerceListingTakesOffers,
  commerceOrderReceiptRecordSchema,
  commercePublicRecordSchema,
  commerceReviewRecordSchema,
  commerceShopRecordSchema,
  locksPublicUriSchema,
  marketplacePublicUriSchema,
} from './marketplace-records';
import { toCamelCaseWire } from './wire-casing';

const SELLER_PUBKY = 'y'.repeat(52);
const BUYER_PUBKY = 'b'.repeat(52);
const CREATED_AT = '2026-08-19T20:00:00.000Z';
const UPDATED_AT = '2026-08-19T21:00:00.000Z';
const IMAGE_URL = `pubky://${SELLER_PUBKY}/pub/pubky.app/marketplace/v1/media/image_01`;
type ReceiptFixtureClaims = {
  v: 1 | 2;
  iss: string;
  buyer: string;
  seller: string;
  order: string;
  receipt: string;
  paidAt: string;
  totalMinor?: number;
  currency?: string;
  exponent?: number;
  merchandiseTotal?: { amountMinor: number; currency: string; exponent: number };
  settlementTotal?: { amountMinor: number; currency: string; exponent: number };
};
const LOCK_URL = `pubky://${SELLER_PUBKY}/pub/locks.app/boots_01.json`;

function usd(amountMinor: number) {
  return { amountMinor, currency: 'USD', exponent: 2 };
}

function makeFixedListing(): CommerceListingRecord {
  return {
    schemaVersion: COMMERCE_CONTRACT_VERSION,
    recordType: 'listing',
    ownerPubky: SELLER_PUBKY,
    revision: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    listingId: 'boots_01',
    state: 'active',
    title: 'Vintage leather boots',
    description: 'Well cared for boots with light wear.',
    taxonomyVersion: COMMERCE_TAXONOMY_VERSION,
    categoryId: 'fashion-shoes-boots',
    condition: 'good',
    conditionDetails: 'Light sole wear shown in the photos.',
    tags: ['vintage', 'leather'],
    location: {
      countryCode: 'US',
      region: 'NY',
    },
    media: [
      {
        id: 'image_01',
        type: 'image',
        url: IMAGE_URL,
        contentHash: 'a'.repeat(64),
        mimeType: 'image/jpeg',
        byteSize: 10_000,
        width: 1_200,
        height: 1_600,
        altText: 'Brown leather boots viewed from the side',
      },
    ],
    variants: [
      {
        id: 'variant_01',
        sku: 'BOOTS-42',
        options: {
          size: '42',
          color: 'Brown',
        },
        quantity: 1,
        mediaIds: ['image_01'],
        enabled: true,
      },
    ],
    sale: {
      format: 'fixed_price',
      unitPrice: usd(12_500),
      acceptsOffers: true,
    },
    fulfillmentMethods: ['physical'],
    package: {
      weightGrams: 1_200,
      lengthMillimeters: 350,
      widthMillimeters: 250,
      heightMillimeters: 150,
    },
    shippingOptions: [
      {
        id: 'ground',
        pricing: 'flat',
        label: 'Ground shipping',
        price: usd(1_200),
        estimatedMinDays: 3,
        estimatedMaxDays: 7,
      },
    ],
    returnPolicy: {
      acceptsReturns: true,
      returnWindowDays: 30,
      buyerPaysReturnShipping: true,
      details: 'Return in the original condition.',
    },
    adultOnly: false,
  };
}

function makeAuctionListing(): CommerceListingRecord {
  const listing = makeFixedListing();
  listing.sale = {
    format: 'auction',
    startingPrice: usd(5_000),
    buyNowPrice: usd(20_000),
    minimumIncrement: usd(500),
    startsAt: '2026-08-20T20:00:00.000Z',
    endsAt: '2026-08-27T20:00:00.000Z',
    antiSnipingWindowSeconds: 120,
    antiSnipingExtensionSeconds: 120,
  };
  return listing;
}

describe('commerceListingShippingMinor', () => {
  it('picks the cheapest priceable option, skipping calculated ones', () => {
    expect(
      commerceListingShippingMinor([
        {
          id: 'calc',
          pricing: 'calculated',
          label: 'Carrier calculated',
          provider: 'ups',
          serviceCode: 'ground',
          estimatedMinDays: 2,
          estimatedMaxDays: 7,
        },
        { id: 'flat_a', pricing: 'flat', label: 'Standard', price: usd(500), estimatedMinDays: 2, estimatedMaxDays: 7 },
        {
          id: 'flat_b',
          pricing: 'flat',
          label: 'Express',
          price: usd(1_500),
          estimatedMinDays: 1,
          estimatedMaxDays: 2,
        },
      ]),
    ).toBe(500);
  });

  it('treats a free option as zero and no options as zero', () => {
    expect(
      commerceListingShippingMinor([
        { id: 'free', pricing: 'free', label: 'Free shipping', estimatedMinDays: 2, estimatedMaxDays: 7 },
        { id: 'flat', pricing: 'flat', label: 'Express', price: usd(1_500), estimatedMinDays: 1, estimatedMaxDays: 2 },
      ]),
    ).toBe(0);
    expect(commerceListingShippingMinor([])).toBe(0);
  });
});

describe('commerceListingRecordSchema', () => {
  it('accepts a complete fixed-price physical listing', () => {
    expect(commerceListingRecordSchema.parse(makeFixedListing())).toEqual(makeFixedListing());
  });

  it('accepts explicit nulls for optional fields, as the sell studio serializes them', () => {
    // Regression: real published records carry `region: null`, `sku: null`,
    // and `priceOverride: null` (JSON.stringify of undefined-less form state).
    // The specs crate accepts them; a stricter read schema made every such
    // listing unloadable for anyone but its cached seller.
    const listing = makeFixedListing() as Record<string, unknown>;
    const location = { ...(listing.location as Record<string, unknown>), region: null };
    const returnPolicy = {
      ...(listing.returnPolicy as Record<string, unknown>),
      acceptsReturns: false,
      returnWindowDays: null,
    };
    const variants = (listing.variants as Record<string, unknown>[]).map((variant) => ({
      ...variant,
      sku: null,
      priceOverride: null,
    }));
    const parsed = commerceListingRecordSchema.parse({ ...listing, location, returnPolicy, variants });
    expect(parsed.location.region).toBeUndefined();
    expect(parsed.returnPolicy.returnWindowDays).toBeUndefined();
    expect(parsed.variants[0]?.sku).toBeUndefined();
    expect(parsed.variants[0]?.priceOverride).toBeUndefined();
  });

  it('accepts any taxonomy version in the spec range, and rejects out-of-range values', () => {
    const listing = makeFixedListing() as Record<string, unknown>;
    expect(commerceListingRecordSchema.safeParse({ ...listing, taxonomyVersion: 1 }).success).toBe(true);
    expect(commerceListingRecordSchema.safeParse({ ...listing, taxonomyVersion: 2 }).success).toBe(true);
    expect(commerceListingRecordSchema.safeParse({ ...listing, taxonomyVersion: 999 }).success).toBe(true);
    expect(commerceListingRecordSchema.safeParse({ ...listing, taxonomyVersion: 0 }).success).toBe(false);
    expect(commerceListingRecordSchema.safeParse({ ...listing, taxonomyVersion: 1.5 }).success).toBe(false);
    expect(commerceListingRecordSchema.safeParse({ ...listing, taxonomyVersion: 1_000_001 }).success).toBe(false);
  });

  it('accepts a bounded attributes container with string and string-list values', () => {
    const listing = {
      ...makeFixedListing(),
      attributes: {
        size: 'US 9',
        color: ['brown', 'black'],
        'age-era': '90s',
        graded_by: 'PSA 9',
      },
    };
    const parsed = commerceListingRecordSchema.parse(listing);
    expect(parsed.attributes).toEqual(listing.attributes);
    // Absent attributes remain valid — v1 records never carry them.
    expect(commerceListingRecordSchema.safeParse(makeFixedListing()).success).toBe(true);
  });

  it('rejects malformed attributes: bad keys, oversized or duplicate values, too many keys', () => {
    const base = makeFixedListing();
    const withAttributes = (attributes: unknown) =>
      commerceListingRecordSchema.safeParse({ ...base, attributes }).success;

    expect(withAttributes({ 'Not-Kebab': 'value' })).toBe(false);
    expect(withAttributes({ 'double--dash': 'value' })).toBe(false);
    expect(withAttributes({ size: '' })).toBe(false);
    expect(withAttributes({ size: 'x'.repeat(81) })).toBe(false);
    expect(withAttributes({ color: [] })).toBe(false);
    expect(withAttributes({ color: ['brown', 'brown'] })).toBe(false);
    expect(withAttributes({ style: Array.from({ length: 11 }, (_, index) => `style-${index}`) })).toBe(false);
    expect(
      withAttributes(Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key-${index}`, 'value']))),
    ).toBe(false);
  });

  it('accepts and preserves unknown members (open-world records, social/v1 alignment)', () => {
    const listing = {
      ...makeFixedListing(),
      futureField: { anything: true },
    };

    const parsed = commerceListingRecordSchema.parse(listing);
    // Round-trip: the unknown member survives parse so a read-modify-write
    // by this client never strips what a newer writer added.
    expect((parsed as Record<string, unknown>).futureField).toEqual({ anything: true });
  });

  it('rejects an updated timestamp before creation', () => {
    const listing = makeFixedListing();
    listing.updatedAt = '2026-08-18T20:00:00.000Z';

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
  });

  it('requires unique media, variant, SKU, tag, fulfillment, and shipping ids', () => {
    const listing = makeFixedListing();
    listing.media.push({ ...listing.media[0] });
    listing.variants.push({ ...listing.variants[0], id: 'variant_02' });
    listing.tags.push('vintage');
    listing.fulfillmentMethods.push('physical');
    listing.shippingOptions.push({ ...listing.shippingOptions[0] });

    const result = commerceListingRecordSchema.safeParse(listing);

    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(({ message }) => message);
      expect(messages).toEqual(
        expect.arrayContaining([
          'Media ids must be unique',
          'Variant SKUs must be unique',
          'Tags must be unique',
          'Fulfillment methods must be unique',
          'Shipping option ids must be unique',
        ]),
      );
    }
  });

  it('limits variant option dimensions to three', () => {
    const listing = makeFixedListing();
    listing.variants[0].options = {
      size: '42',
      color: 'Brown',
      width: 'Regular',
      material: 'Leather',
    };

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
  });

  it('rejects variants that reference unknown media', () => {
    const listing = makeFixedListing();
    listing.variants[0].mediaIds = ['missing'];

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
  });

  it('requires intended quantity for an active listing', () => {
    const listing = makeFixedListing();
    listing.variants[0].quantity = 0;

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
  });

  it('requires physical package facts and shipping options', () => {
    const listing = makeFixedListing();
    listing.package = undefined;
    listing.shippingOptions = [];

    const result = commerceListingRecordSchema.safeParse(listing);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ message }) => message)).toEqual(
        expect.arrayContaining([
          'Physical fulfillment requires package facts',
          'Physical fulfillment requires a shipping option',
        ]),
      );
    }
  });

  // Digital delivery design §6 A6, A8, A13: the Shop predicate matches the
  // specs — only a lock without `digital` is refused.
  it('digital_without_lock_is_valid', () => {
    const listing = makeFixedListing();
    listing.fulfillmentMethods = ['digital'];
    listing.package = undefined;
    listing.shippingOptions = [];

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(true);
  });

  it('lock_without_digital_rejected', () => {
    const unexpectedLock = makeFixedListing();
    unexpectedLock.digitalLock = {
      policyUri: LOCK_URL,
      criterionId: 'criterion-1',
      contentPath: 'premium.txt',
      resourceHash: 'b'.repeat(64),
      minimumConfirmations: 1,
    };

    const result = commerceListingRecordSchema.safeParse(unexpectedLock);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ message }) => message)).toContain('digitalLock requires digital fulfillment');
  });

  it('shop_record_digital_predicate_matches_specs: every digital encoding the studio writes parses', () => {
    const shipped = makeFixedListing();
    const encodings: Array<CommerceListingRecord['fulfillmentMethods']> = [
      ['digital'],
      ['physical', 'shipping', 'digital'],
      ['pickup', 'digital'],
      ['physical', 'shipping', 'pickup', 'digital'],
    ];
    for (const fulfillmentMethods of encodings) {
      const physical = fulfillmentMethods.includes('physical');
      const listing = {
        ...shipped,
        fulfillmentMethods,
        package: physical ? shipped.package : undefined,
        shippingOptions: physical ? shipped.shippingOptions : [],
      };
      expect(commerceListingRecordSchema.safeParse(listing).success, fulfillmentMethods.join(',')).toBe(true);
    }
  });

  it('accepts digital fulfillment with a current Locks confirmation policy', () => {
    const listing = makeFixedListing();
    listing.fulfillmentMethods = ['digital'];
    listing.package = undefined;
    listing.shippingOptions = [];
    listing.digitalLock = {
      policyUri: LOCK_URL,
      criterionId: 'criterion-1',
      contentPath: 'premium.txt',
      resourceHash: 'b'.repeat(64),
      minimumConfirmations: 6,
    };

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(true);
  });

  it('rejects a Locks policy above Paykit Server finality', () => {
    const listing = makeFixedListing();
    listing.fulfillmentMethods = ['digital'];
    listing.package = undefined;
    listing.shippingOptions = [];
    listing.digitalLock = {
      policyUri: LOCK_URL,
      criterionId: 'criterion-1',
      contentPath: 'premium.txt',
      resourceHash: 'b'.repeat(64),
      minimumConfirmations: 7,
    };

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
  });

  it('requires media to be owned by the listing seller', () => {
    const listing = makeFixedListing();
    listing.media[0].url = `pubky://${BUYER_PUBKY}/pub/pubky.app/marketplace/v1/media/image_01`;

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
  });

  it('requires variant and shipping prices to use the listing asset', () => {
    const listing = makeFixedListing();
    listing.variants[0].priceOverride = { amountMinor: 100, currency: 'BTC', exponent: 8 };
    const shippingOption = listing.shippingOptions[0];
    if (shippingOption.pricing === 'flat') {
      shippingOption.price = { amountMinor: 1_000, currency: 'EUR', exponent: 2 };
    }

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
  });

  it('allows at most one video and requires video duration', () => {
    const listing = makeFixedListing();
    const video = {
      ...listing.media[0],
      id: 'video_01',
      type: 'video' as const,
      url: `pubky://${SELLER_PUBKY}/pub/pubky.app/marketplace/v1/media/video_01`,
      mimeType: 'video/mp4',
      durationMs: 10_000,
    };
    listing.media.push(video, { ...video, id: 'video_02', url: `${video.url}_2` });

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);

    listing.media = [listing.media[0], { ...video, durationMs: undefined }];
    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
  });
});

describe('auction listing rules', () => {
  it('accepts one-variant auction terms in one asset', () => {
    expect(commerceListingRecordSchema.safeParse(makeAuctionListing()).success).toBe(true);
  });

  it('rejects reversed dates, low buy-now, and mixed assets', () => {
    const listing = makeAuctionListing();
    if (listing.sale.format !== 'auction') throw new TypeError('Expected auction fixture');
    listing.sale.endsAt = listing.sale.startsAt;
    listing.sale.buyNowPrice = usd(5_000);
    listing.sale.minimumIncrement = { amountMinor: 1, currency: 'BTC', exponent: 8 };

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
  });

  it('rejects multiple auction variants', () => {
    const listing = makeAuctionListing();
    listing.variants.push({
      ...listing.variants[0],
      id: 'variant_02',
      sku: 'BOOTS-43',
    });

    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
  });

  it.each(['reservePrice', 'reserve_price', 'reserveMet', 'reserve_met'])(
    'rejects %s recursively, including a nested array smuggle',
    (key) => {
      const listing = asInvalid<Record<string, unknown>>(makeAuctionListing());
      listing.futureExtension = { nested: [{ [key]: null }] };
      expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);
      expect(commercePublicRecordSchema.safeParse(listing).success).toBe(false);
    },
  );

  it('accepts the seller-private reserve record while preserving unknown fields and null reserve', () => {
    const record = {
      schemaVersion: COMMERCE_CONTRACT_VERSION,
      recordType: 'auction_reserve',
      ownerPubky: SELLER_PUBKY,
      listingId: 'boots_01',
      listingRevision: 1,
      recordRevision: 1,
      writeId: '00000000-0000-4000-8000-000000000001',
      reservePrice: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      futureField: { value: null },
    };
    expect(commerceAuctionReserveRecordSchema.parse(record)).toEqual(record);
  });
});

describe('other public marketplace records', () => {
  it('accepts a public shop without precise location data', () => {
    expect(
      commerceShopRecordSchema.safeParse({
        schemaVersion: COMMERCE_CONTRACT_VERSION,
        recordType: 'shop',
        ownerPubky: SELLER_PUBKY,
        revision: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        name: 'Satoshi Vintage',
        bio: 'Circular fashion and Bitcoin.',
        location: { countryCode: 'US', region: 'NY' },
        shippingPolicy: 'Ships within three business days.',
        returnPolicy: 'Returns accepted within 30 days.',
        vacationMode: false,
      }).success,
    ).toBe(true);
  });

  it('accepts a valid drop record and rejects every cross-field violation', () => {
    const drop = {
      schemaVersion: COMMERCE_CONTRACT_VERSION,
      recordType: 'drop',
      ownerPubky: SELLER_PUBKY,
      revision: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      dropId: 'drop_summer_01',
      title: 'Summer Capsule',
      description: 'Ten pieces, one afternoon.',
      media: [],
      format: 'fcfs',
      startsAt: '2026-09-01T17:00:00.000Z',
      endsAt: '2026-09-01T19:00:00.000Z',
      listingIds: ['boots_01', 'boots_02'],
      totalQuantity: 10,
      perBuyerLimit: 2,
      stockDisplay: 'bands',
    };

    expect(commerceDropRecordSchema.safeParse(drop).success).toBe(true);
    // endsAt is optional (sell-out-only drops).
    expect(commerceDropRecordSchema.safeParse({ ...drop, endsAt: undefined }).success).toBe(true);

    expect(commerceDropRecordSchema.safeParse({ ...drop, endsAt: drop.startsAt }).success).toBe(false);
    expect(commerceDropRecordSchema.safeParse({ ...drop, perBuyerLimit: 11 }).success).toBe(false);
    expect(commerceDropRecordSchema.safeParse({ ...drop, listingIds: ['boots_01', 'boots_01'] }).success).toBe(false);
    expect(commerceDropRecordSchema.safeParse({ ...drop, listingIds: [] }).success).toBe(false);
    expect(commerceDropRecordSchema.safeParse({ ...drop, format: 'raffle' }).success).toBe(false);
    expect(commerceDropRecordSchema.safeParse({ ...drop, stockDisplay: 'fake' }).success).toBe(false);
    expect(commerceDropRecordSchema.safeParse({ ...drop, totalQuantity: 0 }).success).toBe(false);
    // Open-world: unknown members pass through (social/v1 alignment). The
    // SERVICE still rejects unknown drop fields at its signing boundary —
    // enforcement terms a seller did not sign are refused there, not here.
    expect(commerceDropRecordSchema.safeParse({ ...drop, surprise: true }).success).toBe(true);
  });

  it('accepts edition fields on a receipt only together and consistent', () => {
    const receipt = {
      schemaVersion: COMMERCE_CONTRACT_VERSION,
      recordType: 'order_receipt',
      ownerPubky: BUYER_PUBKY,
      revision: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      role: 'buyer',
      receiptId: '018f47d2-6a27-7c23-a49d-6b21bb770201',
      orderId: '018f47d2-6a27-7c23-a49d-6b21bb770200',
      buyerPubky: BUYER_PUBKY,
      sellerPubky: SELLER_PUBKY,
      total: { amountMinor: 14796, currency: 'USD', exponent: 2 },
      paidAt: CREATED_AT,
      receiptAttestation: 'a'.repeat(64),
    };
    const edition = { dropId: 'drop_summer_01', edition: 7, of: 100 };

    expect(commerceOrderReceiptRecordSchema.safeParse(receipt).success).toBe(true);
    expect(
      commerceOrderReceiptRecordSchema.safeParse({
        ...receipt,
        editionAttestation: 'b'.repeat(64),
        drop: edition,
      }).success,
    ).toBe(true);
    // One without the other, and inconsistent counts, are refused.
    expect(commerceOrderReceiptRecordSchema.safeParse({ ...receipt, editionAttestation: 'b'.repeat(64) }).success).toBe(
      false,
    );
    expect(commerceOrderReceiptRecordSchema.safeParse({ ...receipt, drop: edition }).success).toBe(false);
    expect(
      commerceOrderReceiptRecordSchema.safeParse({
        ...receipt,
        editionAttestation: 'b'.repeat(64),
        drop: { ...edition, of: 3 },
      }).success,
    ).toBe(false);
  });

  it('accepts a shop declaring its transaction-service authority, and rejects malformed declarations', () => {
    const shop = {
      schemaVersion: COMMERCE_CONTRACT_VERSION,
      recordType: 'shop',
      ownerPubky: SELLER_PUBKY,
      revision: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      name: 'Satoshi Vintage',
      bio: 'Circular fashion and Bitcoin.',
      location: { countryCode: 'US', region: 'NY' },
      shippingPolicy: 'Ships within three business days.',
      returnPolicy: 'Returns accepted within 30 days.',
      vacationMode: false,
    };

    expect(
      commerceShopRecordSchema.safeParse({ ...shop, transactionService: 'https://market.example.com' }).success,
    ).toBe(true);
    expect(
      commerceShopRecordSchema.safeParse({ ...shop, transactionService: 'https://market.example.com/api' }).success,
    ).toBe(true);
    // http, credentials, query, fragment, and oversized URLs are refused.
    expect(
      commerceShopRecordSchema.safeParse({ ...shop, transactionService: 'http://market.example.com' }).success,
    ).toBe(false);
    expect(
      commerceShopRecordSchema.safeParse({ ...shop, transactionService: 'https://a:b@market.example.com' }).success,
    ).toBe(false);
    expect(
      commerceShopRecordSchema.safeParse({ ...shop, transactionService: 'https://market.example.com/?x=1' }).success,
    ).toBe(false);
    expect(
      commerceShopRecordSchema.safeParse({ ...shop, transactionService: 'https://market.example.com/#frag' }).success,
    ).toBe(false);
    expect(
      commerceShopRecordSchema.safeParse({
        ...shop,
        transactionService: `https://market.example.com/${'a'.repeat(300)}`,
      }).success,
    ).toBe(false);
    expect(commerceShopRecordSchema.safeParse({ ...shop, transactionService: 'not a url' }).success).toBe(false);
  });

  it('accepts a transaction-attested public review', () => {
    expect(
      commerceReviewRecordSchema.safeParse({
        schemaVersion: COMMERCE_CONTRACT_VERSION,
        recordType: 'review',
        ownerPubky: BUYER_PUBKY,
        revision: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        reviewId: 'review_01',
        subjectPubky: SELLER_PUBKY,
        listingOwnerPubky: SELLER_PUBKY,
        listingId: 'boots_01',
        role: 'buyer_reviewing_seller',
        ratings: {
          overall: 5,
          itemAccuracy: 5,
          shipping: 4,
          communication: 5,
        },
        text: 'Accurate description and careful packaging.',
        eligibilityAttestation: 'signed.review.attestation_value_123456789',
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate entries in a public collection', () => {
    const result = commerceCollectionRecordSchema.safeParse({
      schemaVersion: COMMERCE_CONTRACT_VERSION,
      recordType: 'collection',
      ownerPubky: SELLER_PUBKY,
      revision: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      collectionId: 'summer',
      name: 'Summer',
      description: 'Warm weather favorites',
      listingIds: ['boots_01', 'boots_01'],
    });

    expect(result.success).toBe(false);
  });
});

describe('marketplace URI contracts', () => {
  it('accepts only marketplace and Locks Pubky paths', () => {
    expect(marketplacePublicUriSchema.safeParse(IMAGE_URL).success).toBe(true);
    expect(locksPublicUriSchema.safeParse(LOCK_URL).success).toBe(true);
    expect(marketplacePublicUriSchema.safeParse('https://example.com/image.jpg').success).toBe(false);
    expect(locksPublicUriSchema.safeParse(`${IMAGE_URL}.json`).success).toBe(false);
  });
});

describe('listing fulfillmentMethods — item type and fulfillment axes (§A2)', () => {
  it('accepts the fulfillment vocabulary alongside the item types in the one public array', () => {
    const listing = makeFixedListing();
    // A physical listing offering BOTH shipping and pickup: the explicit
    // 'shipping' keeps the service derivation from converging to pickup-only.
    listing.fulfillmentMethods = ['physical', 'shipping', 'pickup'];
    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(true);
  });

  it('keeps pre-pickup records valid unchanged (item-type values only)', () => {
    const listing = makeFixedListing();
    expect(listing.fulfillmentMethods).toEqual(['physical']);
    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(true);
  });

  it('rejects unknown values and repeats across both vocabularies', () => {
    const listing = makeFixedListing();
    listing.fulfillmentMethods = ['physical', 'drone'] as CommerceListingRecord['fulfillmentMethods'];
    expect(commerceListingRecordSchema.safeParse(listing).success).toBe(false);

    const repeated = makeFixedListing();
    repeated.fulfillmentMethods = ['physical', 'shipping', 'shipping'];
    expect(commerceListingRecordSchema.safeParse(repeated).success).toBe(false);
  });
});

describe('commerceListingFulfillmentMethods (mirrors the service homeserver derivation)', () => {
  it('maps only the shipping/pickup vocabulary, ignoring item types', () => {
    expect(commerceListingFulfillmentMethods(['physical'])).toEqual(['shipping']);
    expect(commerceListingFulfillmentMethods(['physical', 'pickup'])).toEqual(['pickup']);
    expect(commerceListingFulfillmentMethods(['physical', 'shipping', 'pickup'])).toEqual(['shipping', 'pickup']);
  });

  it('defaults records predating pickup to shipping-only', () => {
    expect(commerceListingFulfillmentMethods(['physical'])).toEqual(['shipping']);
    expect(commerceListingFulfillmentMethods([])).toEqual(['shipping']);
  });

  // Digital delivery design §6 A1–A3, mirroring the service's
  // `digital_without_lock_derives_digital_never_shipping`,
  // `locks_listing_derivation_unchanged` and `mixed_method_derivations`.
  it('digital_without_lock_derives_digital_never_shipping', () => {
    expect(commerceListingFulfillmentMethods(['digital'])).toEqual(['digital']);
    expect(commerceListingFulfillmentMethods(['physical', 'digital'])).toEqual(['digital']);
  });

  it('locks_listing_derivation_unchanged', () => {
    expect(commerceListingFulfillmentMethods(['digital'], true)).toEqual(['shipping']);
    expect(commerceListingFulfillmentMethods(['physical', 'shipping', 'digital'], true)).toEqual(['shipping']);
  });

  it('mixed_method_derivations', () => {
    expect(commerceListingFulfillmentMethods(['physical', 'shipping', 'digital'])).toEqual(['shipping', 'digital']);
    expect(commerceListingFulfillmentMethods(['pickup', 'digital'])).toEqual(['pickup', 'digital']);
    expect(commerceListingFulfillmentMethods(['physical', 'shipping', 'pickup', 'digital'])).toEqual([
      'shipping',
      'pickup',
      'digital',
    ]);
  });

  it('dedupes non-adjacent repeats preserving first-seen order, like the service', () => {
    // The service deliberately dedupes set-wise (not Vec::dedup's adjacent-only
    // collapse) so a non-adjacent repeat cannot fail registration validation.
    expect(commerceListingFulfillmentMethods(['shipping', 'pickup', 'shipping'])).toEqual(['shipping', 'pickup']);
  });
});

describe('commerceListingTakesOffers (offers settle through shipping or pickup)', () => {
  const listing = (overrides: Partial<CommerceListingRecord>) => createCommerceListingFixture(overrides);
  const lock = {
    policyUri: 'pubky://seller/pub/locks.app/v1/policies/policy-1',
    criterionId: 'criterion-1',
    contentPath: 'premium.txt',
    resourceHash: 'b'.repeat(64),
    minimumConfirmations: 6,
  };

  it('refuses digital-only listings and takes one that ships or offers pickup', () => {
    expect(commerceListingTakesOffers(listing({ fulfillmentMethods: ['digital'] }))).toBe(false);
    expect(commerceListingTakesOffers(listing({ fulfillmentMethods: ['physical', 'digital'] }))).toBe(false);
    expect(commerceListingTakesOffers(listing({ fulfillmentMethods: ['pickup'] }))).toBe(true);
    expect(commerceListingTakesOffers(listing({ fulfillmentMethods: ['pickup', 'digital'] }))).toBe(true);
    expect(commerceListingTakesOffers(listing({ fulfillmentMethods: ['physical', 'shipping', 'digital'] }))).toBe(true);
  });

  it('takes no offers on a Locks listing, which is digital-only to the buyer', () => {
    expect(commerceListingTakesOffers(listing({ fulfillmentMethods: ['digital'], digitalLock: lock }))).toBe(false);
  });
});

describe('portable v2 order receipt records', () => {
  it('keeps the opaque v2 JWS and verifies the parsed record', () => {
    const attestation = toCamelCaseWire(receiptAttestationV2Bitcoin.receipt_attestation) as {
      jws: string;
      claims: {
        iss: string;
        buyer: string;
        seller: string;
        order: string;
        receipt: string;
        paidAt: string;
        merchandiseTotal: { amountMinor: number; currency: string; exponent: number };
      };
    };
    const record = {
      schemaVersion: COMMERCE_CONTRACT_VERSION,
      recordType: 'order_receipt',
      ownerPubky: attestation.claims.buyer,
      revision: 1,
      createdAt: attestation.claims.paidAt,
      updatedAt: attestation.claims.paidAt,
      role: 'buyer',
      receiptId: attestation.claims.receipt,
      orderId: attestation.claims.order,
      buyerPubky: attestation.claims.buyer,
      sellerPubky: attestation.claims.seller,
      total: attestation.claims.merchandiseTotal,
      paidAt: attestation.claims.paidAt,
      receiptAttestation: attestation.jws,
    };

    const parsed = commerceOrderReceiptRecordSchema.parse(record);
    expect(parsed.receiptAttestation).toBe(attestation.jws);
    expect(verifyOwnOrderReceipt(parsed)).toBe(attestation.claims.iss);
  });
});

describe('portable order receipt attestation verification', () => {
  it.each([
    ['v1', receiptAttestationV1],
    ['v2 same-currency', receiptAttestationV2SameCurrency],
  ])('round-trips the verified claims for the %s fixture', (_name, fixture) => {
    const attestation = toCamelCaseWire(fixture.receipt_attestation) as {
      jws: string;
      claims: ReceiptFixtureClaims;
    };
    const record = receiptRecordForAttestation(attestation);

    const verified = verifyOrderReceiptClaims(record);

    expect(verified).not.toBeNull();
    expect(verified?.v).toBe(attestation.claims.v);
    expect(verified?.iss).toBe(attestation.claims.iss);
  });

  it('rejects a v2 receipt with a tampered signature', () => {
    const attestation = toCamelCaseWire(receiptAttestationV2SameCurrency.receipt_attestation) as {
      jws: string;
      claims: ReceiptFixtureClaims;
    };
    const record = receiptRecordForAttestation({
      ...attestation,
      jws: `${attestation.jws.slice(0, -1)}${attestation.jws.endsWith('A') ? 'B' : 'A'}`,
    });

    expect(verifyOrderReceiptClaims(record)).toBeNull();
  });
});

function receiptRecordForAttestation(attestation: { jws: string; claims: ReceiptFixtureClaims }) {
  const { claims } = attestation;
  const record = {
    schemaVersion: COMMERCE_CONTRACT_VERSION,
    recordType: 'order_receipt',
    ownerPubky: claims.buyer,
    revision: 1,
    createdAt: claims.paidAt,
    updatedAt: claims.paidAt,
    role: 'buyer',
    receiptId: claims.receipt,
    orderId: claims.order,
    buyerPubky: claims.buyer,
    sellerPubky: claims.seller,
    total:
      claims.v === 2
        ? claims.merchandiseTotal
        : { amountMinor: claims.totalMinor, currency: claims.currency, exponent: claims.exponent },
    ...(claims.v === 2 ? { settlementTotal: claims.settlementTotal } : {}),
    paidAt: claims.paidAt,
    receiptAttestation: attestation.jws,
  };
  return record;
}
