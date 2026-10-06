import { beforeEach, describe, expect, it } from 'vitest';
import { COMMERCE_CONTRACT_VERSION, COMMERCE_TAXONOMY_VERSION } from '@/config/commerce';
import { db } from '@/database/franky/franky';
import type { CommerceListingRecord, CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import {
  CommerceCartItemModel,
  CommerceFavoriteModel,
  CommerceListingDraftModel,
  CommerceListingModel,
  CommerceListingProjectionModel,
  CommerceShopFollowModel,
  CommerceShopModel,
  CommerceSyncJobModel,
} from './commerce.models';
import type {
  CommerceListingModelSchema,
  CommerceListingProjectionModelSchema,
  CommerceShopModelSchema,
  CommerceSyncJobModelSchema,
} from './commerce.schema';

const SELLER_PUBKY = 'y'.repeat(52);
const OTHER_SELLER_PUBKY = 'b'.repeat(52);
const CREATED_AT = '2026-08-19T20:00:00.000Z';
const UPDATED_AT = '2026-08-19T21:00:00.000Z';

function makeShop(): CommerceShopRecord {
  return {
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
}

function makeListingRecord(listingId = 'boots_01'): CommerceListingRecord {
  return {
    schemaVersion: COMMERCE_CONTRACT_VERSION,
    recordType: 'listing',
    ownerPubky: SELLER_PUBKY,
    revision: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    listingId,
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
        url: `pubky://${SELLER_PUBKY}/pub/pubky.app/marketplace/v1/media/image_01`,
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
    fulfillmentMethods: ['pickup'],
    shippingOptions: [],
    returnPolicy: {
      acceptsReturns: true,
      returnWindowDays: 30,
      buyerPaysReturnShipping: true,
    },
    adultOnly: false,
  };
}

function makeListingModel(
  listingId: string,
  updatedAt: number,
  categoryId = 'fashion-shoes-boots',
): CommerceListingModelSchema {
  const record = makeListingRecord(listingId);
  record.categoryId = categoryId;
  const price = record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice;
  return {
    id: `${SELLER_PUBKY}:${listingId}`,
    seller_id: SELLER_PUBKY,
    listing_id: listingId,
    record,
    revision: record.revision,
    state: record.state,
    category_id: categoryId,
    format: record.sale.format,
    currency: price.currency,
    price_minor: price.amountMinor,
    sync_status: 'synced',
    updated_at: updatedAt,
  };
}

function makeProjection(): CommerceListingProjectionModelSchema {
  return {
    id: `${SELLER_PUBKY}:boots_01`,
    seller_id: SELLER_PUBKY,
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
  };
}

function makeSyncJob(overrides: Partial<CommerceSyncJobModelSchema> = {}): CommerceSyncJobModelSchema {
  return {
    id: '018f47d2-6a27-7c23-a49d-6b21bb770120',
    owner_id: SELLER_PUBKY,
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

describe('commerce Dexie models', () => {
  beforeEach(async () => {
    await db.initialize();
    await Promise.all([
      CommerceShopModel.table.clear(),
      CommerceListingModel.table.clear(),
      CommerceListingDraftModel.table.clear(),
      CommerceListingProjectionModel.table.clear(),
      CommerceSyncJobModel.table.clear(),
      CommerceFavoriteModel.table.clear(),
      CommerceShopFollowModel.table.clear(),
      CommerceCartItemModel.table.clear(),
    ]);
  });

  it('persists and materializes a shop record', async () => {
    const record = makeShop();
    const shopRecord: CommerceShopModelSchema = {
      id: SELLER_PUBKY,
      owner_id: SELLER_PUBKY,
      record,
      revision: record.revision,
      sync_status: 'synced',
      updated_at: 1_000,
    };
    await CommerceShopModel.upsert(shopRecord);

    const shop = await CommerceShopModel.findById(SELLER_PUBKY);

    expect(shop).toBeInstanceOf(CommerceShopModel);
    expect(shop?.record.name).toBe('Satoshi Vintage');
    expect(shop?.revision).toBe(1);
  });

  it('queries seller and category listings newest first', async () => {
    await CommerceListingModel.bulkSave([
      makeListingModel('older', 1_000),
      makeListingModel('newest', 3_000),
      makeListingModel('middle', 2_000, 'collectibles-coins'),
      {
        ...makeListingModel('other-seller', 4_000),
        id: `${OTHER_SELLER_PUBKY}:other-seller`,
        seller_id: OTHER_SELLER_PUBKY,
      },
    ]);

    const sellerListings = await CommerceListingModel.findBySeller(SELLER_PUBKY);
    const categoryListings = await CommerceListingModel.findByCategory('fashion-shoes-boots');

    expect(sellerListings.map(({ listing_id }) => listing_id)).toEqual(['newest', 'middle', 'older']);
    expect(categoryListings.map(({ listing_id }) => listing_id)).toEqual(['other-seller', 'newest', 'older']);
  });

  it('stores drafts per owner and sorts the newest first', async () => {
    await CommerceListingDraftModel.bulkSave([
      {
        id: `${SELLER_PUBKY}:older`,
        owner_id: SELLER_PUBKY,
        listing_id: 'older',
        data: { ownerPubky: SELLER_PUBKY, listingId: 'older', title: 'Old draft' },
        created_at: 100,
        updated_at: 100,
      },
      {
        id: `${SELLER_PUBKY}:newer`,
        owner_id: SELLER_PUBKY,
        listing_id: 'newer',
        data: { ownerPubky: SELLER_PUBKY, listingId: 'newer', title: 'New draft' },
        created_at: 200,
        updated_at: 300,
      },
      {
        id: `${OTHER_SELLER_PUBKY}:private`,
        owner_id: OTHER_SELLER_PUBKY,
        listing_id: 'private',
        data: { ownerPubky: OTHER_SELLER_PUBKY, listingId: 'private', title: 'Other account' },
        created_at: 400,
        updated_at: 400,
      },
    ]);

    const drafts = await CommerceListingDraftModel.findByOwner(SELLER_PUBKY);

    expect(drafts.map(({ listing_id }) => listing_id)).toEqual(['newer', 'older']);
  });

  it('persists the authoritative listing projection independently from public terms', async () => {
    const projection = makeProjection();
    await CommerceListingProjectionModel.upsert(projection);

    const stored = await CommerceListingProjectionModel.findById(projection.id);

    expect(stored).toBeInstanceOf(CommerceListingProjectionModel);
    expect(stored).toMatchObject({
      listing_revision: 1,
      server_revision: 3,
      available_quantity: 1,
      state: 'available',
    });
  });

  it('stores and removes pending sync jobs by id', async () => {
    const job = makeSyncJob();
    await CommerceSyncJobModel.upsert(job);
    expect(await CommerceSyncJobModel.findById(job.id)).toMatchObject({
      entity_id: 'boots_01',
      operation: 'publish',
      status: 'pending',
    });

    await CommerceSyncJobModel.deleteById(job.id);
    expect(await CommerceSyncJobModel.findById(job.id)).toBeNull();
  });

  it('stores favorites and shop follows under the active owner', async () => {
    await CommerceFavoriteModel.bulkSave([
      {
        id: `${SELLER_PUBKY}|${OTHER_SELLER_PUBKY}:boots_01`,
        owner_id: SELLER_PUBKY,
        listing_id: `${OTHER_SELLER_PUBKY}:boots_01`,
        created_at: 100,
      },
    ]);
    await CommerceShopFollowModel.bulkSave([
      {
        id: `${SELLER_PUBKY}|${OTHER_SELLER_PUBKY}`,
        owner_id: SELLER_PUBKY,
        seller_id: OTHER_SELLER_PUBKY,
        created_at: 200,
      },
    ]);

    expect(await CommerceFavoriteModel.findByOwner(SELLER_PUBKY)).toHaveLength(1);
    expect(await CommerceShopFollowModel.findByOwner(SELLER_PUBKY)).toHaveLength(1);
    expect(await CommerceFavoriteModel.findByOwner(OTHER_SELLER_PUBKY)).toEqual([]);
  });
});
