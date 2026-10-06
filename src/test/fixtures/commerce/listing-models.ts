import type { CommerceListingRecord, CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import type { CommerceListingModelSchema, CommerceShopModelSchema } from '@/models/commerce/commerce.schema';

/** Wrap an owner-signed listing record in the Dexie cache-model shape the UI reads. */
export function toCommerceListingModel(record: CommerceListingRecord): CommerceListingModelSchema {
  const price = record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice;
  return {
    id: `${record.ownerPubky}:${record.listingId}`,
    seller_id: record.ownerPubky,
    listing_id: record.listingId,
    record,
    revision: record.revision,
    state: record.state,
    category_id: record.categoryId,
    format: record.sale.format,
    currency: price.currency,
    price_minor: price.amountMinor,
    sync_status: 'synced',
    updated_at: Date.parse(record.updatedAt),
  };
}

/** Wrap an owner-signed shop record in the Dexie cache-model shape the UI reads. */
export function toCommerceShopModel(record: CommerceShopRecord): CommerceShopModelSchema {
  return {
    id: record.ownerPubky,
    owner_id: record.ownerPubky,
    record,
    revision: record.revision,
    sync_status: 'synced',
    updated_at: Date.parse(record.updatedAt),
  };
}
