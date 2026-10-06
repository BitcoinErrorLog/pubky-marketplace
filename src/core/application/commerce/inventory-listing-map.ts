import { COMMERCE_CONTRACT_VERSION, COMMERCE_TAXONOMY_VERSION } from '@/config/commerce';
import {
  type CommerceListingRecord,
  commerceListingRecordSchema,
  commerceMediaSchema,
  commerceReturnPolicySchema,
  commerceSaleSchema,
  commerceShippingOptionSchema,
  commerceVariantSchema,
} from '@/libs/commerce/marketplace-records';
import { listingStockRefusal } from '@/libs/commerce/unlimited-stock';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';

type ImportJsonPrimitive = string | number | boolean | null;
export type ImportJsonValue = ImportJsonPrimitive | ImportJsonValue[] | { [key: string]: ImportJsonValue };

export type CanonicalImportRow = {
  readonly recordUri: string;
  readonly sellerPubky: string;
  readonly listingId: string;
  readonly sourceListingKey: string;
  readonly recordRevision: number | null;
  readonly variantId: string;
  readonly sku: string;
  readonly state: string;
  readonly title: string;
  readonly description: string;
  readonly taxonomy: ImportJsonValue;
  readonly category: string;
  readonly condition: string;
  readonly tags: ImportJsonValue;
  readonly amountMinor: number;
  readonly currency: string;
  readonly exponent: number;
  readonly variantQuantity: number;
  readonly variantEnabled: boolean;
  readonly options: ImportJsonValue;
  readonly media: ImportJsonValue;
  readonly shippingOptions: ImportJsonValue;
  readonly returnPolicy: ImportJsonValue;
  readonly sale: ImportJsonValue;
  readonly externalRefs: ImportJsonValue;
  readonly extraFields: Readonly<Record<string, string>>;
  readonly sourceRow?: number;
};

export type ListingMapResult = { ok: true; record: CommerceListingRecord } | { ok: false; message: string };

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asImportJson(value: unknown): ImportJsonValue {
  return JSON.parse(JSON.stringify(value)) as ImportJsonValue;
}

function kebabCategory(value: string): string {
  const kebab = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return kebab.length > 0 ? kebab : 'uncategorized';
}

function parseJsonField(raw: string | undefined): unknown {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function mapReturnPolicy(value: unknown): CommerceListingRecord['returnPolicy'] {
  const object = asObject(value);
  if (object && typeof object.acceptsReturns === 'boolean') {
    return commerceReturnPolicySchema.parse(object);
  }
  if (object && typeof object.accepted === 'boolean') {
    const accepts = object.accepted;
    const days = typeof object.days === 'number' ? object.days : 30;
    return commerceReturnPolicySchema.parse({
      acceptsReturns: accepts,
      ...(accepts ? { returnWindowDays: days } : {}),
      buyerPaysReturnShipping: true,
    });
  }
  return { acceptsReturns: false, buyerPaysReturnShipping: true };
}

function mapMedia(row: CanonicalImportRow): CommerceListingRecord['media'] {
  const fromExtra = parseJsonField(row.extraFields.media_json);
  const candidate = fromExtra ?? row.media;
  return commerceMediaSchema.array().min(1).parse(candidate);
}

function mapVariants(rows: readonly CanonicalImportRow[]): CommerceListingRecord['variants'] {
  return rows.map((row) =>
    commerceVariantSchema.parse({
      id: row.variantId,
      ...(row.sku.length > 0 ? { sku: row.sku } : {}),
      options: asObject(row.options) ?? { option: 'default' },
      quantity: row.variantQuantity,
      mediaIds: [],
      enabled: row.variantEnabled,
    }),
  );
}

function mapSale(row: CanonicalImportRow): CommerceListingRecord['sale'] {
  const object = asObject(row.sale);
  if (object && object.format === 'auction') {
    return commerceSaleSchema.parse(object);
  }
  if (object && object.format === 'fixed_price' && asObject(object.unitPrice)) {
    return commerceSaleSchema.parse(object);
  }
  return commerceSaleSchema.parse({
    format: 'fixed_price',
    unitPrice: { amountMinor: row.amountMinor, currency: row.currency, exponent: row.exponent },
    acceptsOffers: false,
  });
}

function mapShipping(row: CanonicalImportRow): CommerceListingRecord['shippingOptions'] {
  if (!Array.isArray(row.shippingOptions)) return [];
  return row.shippingOptions.map((option) => commerceShippingOptionSchema.parse(option));
}

function mapLocation(row: CanonicalImportRow): CommerceListingRecord['location'] {
  const fromJson = asObject(parseJsonField(row.extraFields.location_json));
  if (fromJson && typeof fromJson.countryCode === 'string') {
    return {
      countryCode: fromJson.countryCode,
      ...(typeof fromJson.region === 'string' ? { region: fromJson.region } : {}),
    };
  }
  const country = row.extraFields.country_code;
  if (typeof country === 'string' && country.length === 2) {
    return { countryCode: country.toUpperCase() };
  }
  throw new Error('A country_code extra field is required when record_json is absent.');
}

function listingState(value: string): CommerceListingRecord['state'] {
  if (value === 'active' || value === 'paused' || value === 'ended' || value === 'removed') {
    return value;
  }
  return 'active';
}

function fromRecordJson(row: CanonicalImportRow, ownerPubky: string): CommerceListingRecord | null {
  const parsed = parseJsonField(row.extraFields.record_json);
  if (!parsed) return null;
  const object = asObject(parsed);
  if (!object) return null;
  return commerceListingRecordSchema.parse({
    ...object,
    ownerPubky: typeof object.ownerPubky === 'string' ? object.ownerPubky : ownerPubky,
    listingId: typeof object.listingId === 'string' ? object.listingId : row.listingId,
  });
}

/** A mapped record the shared publish rule accepts, or that rule's refusal as the row's plan error. */
function publishable(record: CommerceListingRecord): ListingMapResult {
  const refusal = listingStockRefusal(record);
  return refusal === null ? { ok: true, record } : { ok: false, message: refusal };
}

/** Map one listing's canonical rows (variants) to a Shop `CommerceListingRecord`. */
export function mapCanonicalRowsToListing(rows: readonly CanonicalImportRow[], ownerPubky: string): ListingMapResult {
  if (rows.length === 0) {
    return { ok: false, message: 'No rows to map.' };
  }
  try {
    const first = rows[0];
    const fromJson = fromRecordJson(first, ownerPubky);
    if (fromJson) {
      return publishable(fromJson);
    }
    const now = new Date().toISOString();
    const shippingOptions = mapShipping(first);
    const record = commerceListingRecordSchema.parse({
      schemaVersion: COMMERCE_CONTRACT_VERSION,
      recordType: 'listing',
      ownerPubky,
      revision: first.recordRevision && first.recordRevision > 0 ? first.recordRevision : 1,
      createdAt: now,
      updatedAt: now,
      listingId: first.listingId,
      state: listingState(first.state),
      title: first.title,
      description: first.description,
      taxonomyVersion: COMMERCE_TAXONOMY_VERSION,
      categoryId: kebabCategory(first.category),
      condition: first.condition,
      tags: Array.isArray(first.tags) ? first.tags.filter((tag) => typeof tag === 'string') : [],
      location: mapLocation(first),
      media: mapMedia(first),
      variants: mapVariants(rows),
      sale: mapSale(first),
      fulfillmentMethods: ['physical'],
      ...(shippingOptions.length > 0
        ? {
            package: parseJsonField(first.extraFields.package_json) ?? {
              weightGrams: 500,
              lengthMillimeters: 200,
              widthMillimeters: 150,
              heightMillimeters: 80,
            },
            shippingOptions,
          }
        : {}),
      returnPolicy: mapReturnPolicy(first.returnPolicy),
      adultOnly: false,
    });
    return publishable(record);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'This file could not be planned. Nothing was published.',
    };
  }
}

/** Inverse of the import mapper: one canonical row per variant, with `record_json`. */
export function listingToCanonicalRows(record: CommerceListingRecord): CanonicalImportRow[] {
  const recordUri = CommerceRecordNormalizer.listingUri(record.ownerPubky, record.listingId);
  const recordJson = JSON.stringify(record);
  const unit = record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice;
  return record.variants.map((variant, index) => ({
    recordUri,
    sellerPubky: record.ownerPubky,
    listingId: record.listingId,
    sourceListingKey: '',
    recordRevision: record.revision,
    variantId: variant.id,
    sku: variant.sku ?? '',
    state: record.state,
    title: record.title,
    description: record.description,
    taxonomy: asImportJson({ taxonomyVersion: record.taxonomyVersion }),
    category: record.categoryId,
    condition: record.condition,
    tags: asImportJson(record.tags),
    amountMinor: unit.amountMinor,
    currency: unit.currency,
    exponent: unit.exponent,
    variantQuantity: variant.quantity,
    variantEnabled: variant.enabled,
    options: asImportJson(variant.options),
    media: asImportJson(record.media),
    shippingOptions: asImportJson(record.shippingOptions ?? []),
    returnPolicy: asImportJson({
      accepted: record.returnPolicy.acceptsReturns,
      ...(record.returnPolicy.returnWindowDays !== undefined ? { days: record.returnPolicy.returnWindowDays } : {}),
    }),
    sale: asImportJson({ format: record.sale.format }),
    externalRefs: {},
    extraFields: {
      record_json: recordJson,
      country_code: record.location.countryCode,
    },
    sourceRow: index + 2,
  }));
}
