import { z } from 'zod';
import {
  COMMERCE_LISTING_DESCRIPTION_MAX_CHARS,
  COMMERCE_LISTING_MAX_QUANTITY,
  COMMERCE_LISTING_TITLE_MAX_CHARS,
  COMMERCE_LISTING_TITLE_MIN_CHARS,
} from '@/config/commerce';
import {
  COMMERCE_ATTRIBUTE_VALUE_MAX_CHARS,
  commerceAttributeFieldsFor,
  resolveCommerceCategory,
} from '@/config/taxonomy/taxonomy';
import { DIGITAL_DELIVERY_COPY } from '@/libs/commerce/digital';
import { commerceListingFulfillmentMethods, type CommerceListingRecord } from '@/libs/commerce/marketplace-records';
import {
  amountInputSchemaForAsset,
  amountInputToMoney,
  assetForListingCurrency,
  type ListingCurrencyChoice,
} from '@/libs/commerce/pricing';
import { gramsFromWeightInput, type MeasurementSystem, millimetersFromDimensionInput } from '@/libs/commerce/units';
import { isUnlimitedStockSentinel, UNLIMITED_STOCK_RESERVED_MESSAGE } from '@/libs/commerce/unlimited-stock';

export const CREATE_MARKETPLACE_LISTING_FIELDS = {
  TITLE: 'title',
  DESCRIPTION: 'description',
  CATEGORY: 'categoryId',
  ATTR_SIZE: 'attrSize',
  ATTR_BRAND: 'attrBrand',
  ATTR_COLORS: 'attrColors',
  ATTR_SOURCE: 'attrSource',
  ATTR_AGE: 'attrAge',
  ATTR_STYLES: 'attrStyles',
  ATTR_MODEL: 'attrModel',
  ATTR_MEDIUM: 'attrMedium',
  ATTR_AUTHOR: 'attrAuthor',
  ATTR_FORMAT: 'attrFormat',
  ATTR_MATERIAL: 'attrMaterial',
  CONDITION: 'condition',
  COUNTRY_CODE: 'countryCode',
  REGION: 'region',
  SALE_FORMAT: 'saleFormat',
  CURRENCY: 'currency',
  PRICE: 'price',
  RESERVE_PRICE: 'reservePrice',
  VARIANTS: 'variants',
  FULFILLMENT: 'fulfillment',
  SHIPPING_LABEL: 'shippingLabel',
  FREE_SHIPPING: 'freeShipping',
  SHIPPING_PRICE: 'shippingPrice',
  SHIPPING_MIN_DAYS: 'shippingMinDays',
  SHIPPING_MAX_DAYS: 'shippingMaxDays',
  MEASUREMENT_SYSTEM: 'measurementSystem',
  PACKAGE_WEIGHT: 'packageWeight',
  PACKAGE_LENGTH: 'packageLength',
  PACKAGE_WIDTH: 'packageWidth',
  PACKAGE_HEIGHT: 'packageHeight',
  RETURN_DAYS: 'returnDays',
} as const;

/** Canonical record bounds — the form validates converted values against these. */
const PACKAGE_WEIGHT_MAX_GRAMS = 1_000_000;
const PACKAGE_DIMENSION_MAX_MM = 100_000;

/** Form field per taxonomy attribute key (see `commerceAttributeFieldsFor`). */
export const LISTING_ATTRIBUTE_FORM_FIELDS = {
  size: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_SIZE,
  brand: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_BRAND,
  color: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_COLORS,
  source: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_SOURCE,
  age: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_AGE,
  style: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_STYLES,
  model: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_MODEL,
  medium: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_MEDIUM,
  author: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_AUTHOR,
  format: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_FORMAT,
  material: CREATE_MARKETPLACE_LISTING_FIELDS.ATTR_MATERIAL,
} as const;

export type ListingAttributeFormField =
  (typeof LISTING_ATTRIBUTE_FORM_FIELDS)[keyof typeof LISTING_ATTRIBUTE_FORM_FIELDS];

export function listingAttributeFormField(key: string): ListingAttributeFormField | null {
  return key in LISTING_ATTRIBUTE_FORM_FIELDS
    ? LISTING_ATTRIBUTE_FORM_FIELDS[key as keyof typeof LISTING_ATTRIBUTE_FORM_FIELDS]
    : null;
}

const attributeTextSchema = z.string().trim().max(COMMERCE_ATTRIBUTE_VALUE_MAX_CHARS, 'Keep this under 80 characters.');
const attributeMultiSchema = z.array(z.string().trim().min(1).max(COMMERCE_ATTRIBUTE_VALUE_MAX_CHARS));

export const UNLIMITED_STOCK_FORM_MESSAGE = 'Unlimited stock is for digital-only listings. Enter a number of copies.';

const listingVariantSchema = z
  .object({
    sku: z.string().trim().max(64, 'SKU must be 64 characters or fewer.'),
    size: z.string().trim().max(80, 'Size is too long.'),
    color: z.string().trim().max(80, 'Color is too long.'),
    style: z.string().trim().max(80, 'Style is too long.'),
    quantity: z.string(),
    unlimited: z.boolean(),
    priceOverride: z.string().trim(),
  })
  .superRefine((variant, context) => {
    if (variant.unlimited) return;
    const quantity = variant.quantity.trim();
    if (!/^[1-9]\d*$/.test(quantity)) {
      context.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'Quantity must be a positive whole number.',
      });
      return;
    }
    if (Number(quantity) > COMMERCE_LISTING_MAX_QUANTITY) {
      context.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'Quantity is too large.',
      });
    }
  });

/**
 * The category must resolve in the taxonomy (the picker only offers leaves;
 * records hydrated for editing may legitimately carry v1 or legacy ids,
 * which also resolve). Structured attribute values must satisfy the
 * category's field definitions: required size must come from the leaf's
 * chart, vocabulary-backed selects must use vocabulary values.
 */
function validateCategoryAndAttributes(
  data: {
    categoryId: string;
    attrSize: string;
    attrBrand: string;
    attrColors: string[];
    attrSource: string;
    attrAge: string;
    attrStyles: string[];
    attrModel: string;
    attrMedium: string;
    attrAuthor: string;
    attrFormat: string;
    attrMaterial: string;
  },
  context: z.RefinementCtx,
): void {
  if (!resolveCommerceCategory(data.categoryId)) {
    context.addIssue({
      code: 'custom',
      path: [CREATE_MARKETPLACE_LISTING_FIELDS.CATEGORY],
      message: 'Choose a category.',
    });
    return;
  }
  for (const field of commerceAttributeFieldsFor(data.categoryId)) {
    const formField = listingAttributeFormField(field.key);
    if (!formField) continue;
    const value = data[formField];
    if (field.input === 'multi-select' && Array.isArray(value)) {
      if (field.maxValues !== undefined && value.length > field.maxValues) {
        context.addIssue({
          code: 'custom',
          path: [formField],
          message: `Choose at most ${field.maxValues} ${field.label.toLowerCase()} values.`,
        });
      }
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (value.some((entry) => !allowed.has(entry))) {
        context.addIssue({
          code: 'custom',
          path: [formField],
          message: `Choose ${field.label.toLowerCase()} values from the list.`,
        });
      }
      continue;
    }
    if (typeof value !== 'string') continue;
    if (field.required && value === '') {
      context.addIssue({
        code: 'custom',
        path: [formField],
        message: `Choose a ${field.label.toLowerCase()}.`,
      });
    }
    if (field.input === 'select' && value !== '') {
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (!allowed.has(value)) {
        context.addIssue({
          code: 'custom',
          path: [formField],
          message: `Choose a ${field.label.toLowerCase()} from the list.`,
        });
      }
    }
  }
}

function validateMoneyField(
  value: string,
  currency: ListingCurrencyChoice,
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  const parsed = amountInputSchemaForAsset(assetForListingCurrency(currency)).safeParse(value);
  if (!parsed.success) {
    context.addIssue({
      code: 'custom',
      path,
      message: parsed.error.issues[0]?.message ?? 'Enter a valid amount.',
    });
  }
}

function validatePackageWeight(value: string, system: MeasurementSystem, context: z.RefinementCtx): void {
  const pattern = system === 'imperial' ? /^\d+(?:\.\d)?$/ : /^\d+$/;
  const grams = pattern.test(value) ? gramsFromWeightInput(Number(value), system) : Number.NaN;
  if (!(grams >= 1 && grams <= PACKAGE_WEIGHT_MAX_GRAMS)) {
    context.addIssue({
      code: 'custom',
      path: [CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_WEIGHT],
      message:
        system === 'imperial'
          ? 'Enter a package weight in ounces (one decimal allowed).'
          : 'Enter a package weight in whole grams.',
    });
  }
}

function validatePackageDimension(
  value: string,
  field: string,
  system: MeasurementSystem,
  context: z.RefinementCtx,
): void {
  const millimeters = /^\d+(?:\.\d)?$/.test(value) ? millimetersFromDimensionInput(Number(value), system) : Number.NaN;
  if (!(millimeters >= 1 && millimeters <= PACKAGE_DIMENSION_MAX_MM)) {
    context.addIssue({
      code: 'custom',
      path: [field],
      message:
        system === 'imperial'
          ? 'Enter a package dimension in inches (one decimal allowed).'
          : 'Enter a package dimension in centimeters (one decimal allowed).',
    });
  }
}

/** Every combination of the studio's three delivery options (at least one). */
export const listingFulfillmentSchema = z.enum([
  'shipping',
  'pickup',
  'shipping_and_pickup',
  'digital',
  'shipping_and_digital',
  'pickup_and_digital',
  'shipping_pickup_and_digital',
]);
export type ListingFulfillment = z.infer<typeof listingFulfillmentSchema>;

/** The three delivery checkboxes (§2): Ship, Local pickup, Digital delivery. */
export type ListingFulfillmentFlags = { ship: boolean; pickup: boolean; digital: boolean };

const FULFILLMENT_FLAGS: Readonly<Record<ListingFulfillment, ListingFulfillmentFlags>> = {
  shipping: { ship: true, pickup: false, digital: false },
  pickup: { ship: false, pickup: true, digital: false },
  shipping_and_pickup: { ship: true, pickup: true, digital: false },
  digital: { ship: false, pickup: false, digital: true },
  shipping_and_digital: { ship: true, pickup: false, digital: true },
  pickup_and_digital: { ship: false, pickup: true, digital: true },
  shipping_pickup_and_digital: { ship: true, pickup: true, digital: true },
};

export function fulfillmentFlags(fulfillment: ListingFulfillment): ListingFulfillmentFlags {
  return FULFILLMENT_FLAGS[fulfillment];
}

/** The form value for a checkbox combination, or null when none is checked. */
export function fulfillmentFromFlags(flags: ListingFulfillmentFlags): ListingFulfillment | null {
  const match = (Object.keys(FULFILLMENT_FLAGS) as ListingFulfillment[]).find((value) => {
    const candidate = FULFILLMENT_FLAGS[value];
    return candidate.ship === flags.ship && candidate.pickup === flags.pickup && candidate.digital === flags.digital;
  });
  return match ?? null;
}

export const createMarketplaceListingSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(COMMERCE_LISTING_TITLE_MIN_CHARS, 'Title must be at least 3 characters.')
      .max(COMMERCE_LISTING_TITLE_MAX_CHARS, 'Title must be 80 characters or fewer.'),
    description: z
      .string()
      .trim()
      .min(1, 'Description is required.')
      .max(COMMERCE_LISTING_DESCRIPTION_MAX_CHARS, 'Description is too long.'),
    categoryId: z.string().min(1, 'Choose a category.'),
    attrSize: attributeTextSchema,
    attrBrand: attributeTextSchema,
    attrColors: attributeMultiSchema.max(2, 'Choose at most 2 colors.'),
    attrSource: attributeTextSchema,
    attrAge: attributeTextSchema,
    attrStyles: attributeMultiSchema.max(3, 'Choose at most 3 styles.'),
    attrModel: attributeTextSchema,
    attrMedium: attributeTextSchema,
    attrAuthor: attributeTextSchema,
    attrFormat: attributeTextSchema,
    attrMaterial: attributeTextSchema,
    condition: z.enum(['new', 'like_new', 'excellent', 'good', 'fair', 'for_parts']),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'Enter a two-letter country code.'),
    region: z.string().trim().max(100, 'Region is too long.'),
    saleFormat: z.enum(['fixed_price', 'auction']),
    currency: z.enum(['USD', 'BTC']),
    price: z.string().trim(),
    reservePrice: z.string().trim(),
    variants: z.array(listingVariantSchema).min(1, 'Add at least one variant.').max(100, 'Too many variants.'),
    fulfillment: listingFulfillmentSchema,
    shippingLabel: z.string().trim().max(100, 'Keep the shipping label under 100 characters.'),
    /** When true the listing ships free: the price field is skipped and the record emits a `pricing: 'free'` option. */
    freeShipping: z.boolean(),
    shippingPrice: z.string().trim(),
    shippingMinDays: z.string().trim(),
    shippingMaxDays: z.string().trim(),
    measurementSystem: z.enum(['metric', 'imperial']),
    packageWeight: z.string().trim(),
    packageLength: z.string().trim(),
    packageWidth: z.string().trim(),
    packageHeight: z.string().trim(),
    returnDays: z.enum(['none', '14', '30']),
  })
  .superRefine((data, context) => {
    validateCategoryAndAttributes(data, context);
    validateMoneyField(data.price, data.currency, [CREATE_MARKETPLACE_LISTING_FIELDS.PRICE], context);
    if (data.saleFormat === 'auction' && data.reservePrice !== '') {
      validateMoneyField(data.reservePrice, data.currency, [CREATE_MARKETPLACE_LISTING_FIELDS.RESERVE_PRICE], context);
      const asset = assetForListingCurrency(data.currency);
      const priceValid = amountInputSchemaForAsset(asset).safeParse(data.price).success;
      const reserveValid = amountInputSchemaForAsset(asset).safeParse(data.reservePrice).success;
      if (
        priceValid &&
        reserveValid &&
        amountInputToMoney(data.reservePrice, asset).amountMinor < amountInputToMoney(data.price, asset).amountMinor
      ) {
        context.addIssue({
          code: 'custom',
          path: [CREATE_MARKETPLACE_LISTING_FIELDS.RESERVE_PRICE],
          message: 'Reserve price cannot be below the starting price.',
        });
      }
    }
    data.variants.forEach((variant, index) => {
      if (variant.priceOverride) {
        validateMoneyField(variant.priceOverride, data.currency, ['variants', index, 'priceOverride'], context);
      }
    });
    if (fulfillmentFlags(data.fulfillment).ship) {
      // Free shipping emits the record's `pricing: 'free'` option — there is
      // no price to validate. The label is still required either way.
      if (!data.freeShipping) {
        validateMoneyField(
          data.shippingPrice,
          data.currency,
          [CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_PRICE],
          context,
        );
      }
      if (!data.shippingLabel) {
        context.addIssue({
          code: 'custom',
          path: ['shippingLabel'],
          message: 'Give the shipping option a label buyers will see.',
        });
      }
      const minDaysValid = /^\d+$/.test(data.shippingMinDays) && Number(data.shippingMinDays) <= 365;
      const maxDaysValid = /^\d+$/.test(data.shippingMaxDays) && Number(data.shippingMaxDays) <= 365;
      if (!minDaysValid) {
        context.addIssue({
          code: 'custom',
          path: ['shippingMinDays'],
          message: 'Enter an estimate in whole days (0\u2013365).',
        });
      }
      if (!maxDaysValid) {
        context.addIssue({
          code: 'custom',
          path: ['shippingMaxDays'],
          message: 'Enter an estimate in whole days (0\u2013365).',
        });
      }
      if (minDaysValid && maxDaysValid && Number(data.shippingMaxDays) < Number(data.shippingMinDays)) {
        context.addIssue({
          code: 'custom',
          path: ['shippingMaxDays'],
          message: 'The maximum estimate cannot precede the minimum.',
        });
      }
      validatePackageWeight(data.packageWeight, data.measurementSystem, context);
      for (const field of [
        CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_LENGTH,
        CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_WIDTH,
        CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_HEIGHT,
      ] as const) {
        validatePackageDimension(data[field], field, data.measurementSystem, context);
      }
    }
    // Auctions are shipping-only (local pickup design §A2; digital delivery
    // design §6 A5): an auction order carries no address and no checkout
    // step, so neither a pickup nor a digital choice could be expressed. The
    // studio coerces the field on format switch; this rule is the schema
    // backstop (and drives the publish checklist).
    if (data.saleFormat === 'auction' && data.fulfillment !== 'shipping') {
      context.addIssue({
        code: 'custom',
        path: [CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT],
        message: DIGITAL_DELIVERY_COPY.auctionsShipOnly,
      });
    }
    if (data.saleFormat === 'auction' && data.variants.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['variants'],
        message: 'Auction listings require exactly one variant.',
      });
    }
    const skus = data.variants.map(({ sku }) => sku).filter(Boolean);
    if (new Set(skus).size !== skus.length) {
      context.addIssue({
        code: 'custom',
        path: ['variants'],
        message: 'Variant SKUs must be unique.',
      });
    }
    if (data.fulfillment !== 'digital') {
      data.variants.forEach((variant, index) => {
        if (variant.unlimited) {
          context.addIssue({
            code: 'custom',
            path: ['variants', index, 'unlimited'],
            message: UNLIMITED_STOCK_FORM_MESSAGE,
          });
          return;
        }
        if (isUnlimitedStockSentinel(variant.quantity)) {
          context.addIssue({
            code: 'custom',
            path: ['variants', index, 'quantity'],
            message: UNLIMITED_STOCK_RESERVED_MESSAGE,
          });
        }
      });
    }
  });

export const createMarketplaceListingDraftSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    categoryId: z.string(),
    attrSize: z.string(),
    attrBrand: z.string(),
    attrColors: z.array(z.string()),
    attrSource: z.string(),
    attrAge: z.string(),
    attrStyles: z.array(z.string()),
    attrModel: z.string(),
    attrMedium: z.string(),
    attrAuthor: z.string(),
    attrFormat: z.string(),
    attrMaterial: z.string(),
    condition: z.enum(['new', 'like_new', 'excellent', 'good', 'fair', 'for_parts']),
    countryCode: z.string(),
    region: z.string(),
    saleFormat: z.enum(['fixed_price', 'auction']),
    /** Legacy drafts stored the bitcoin choice as 'SATS'; accepted here and migrated to 'BTC' on restore. */
    currency: z.enum(['USD', 'BTC', 'SATS']),
    price: z.string(),
    reservePrice: z.string(),
    variants: z.array(
      z.object({
        sku: z.string(),
        size: z.string(),
        color: z.string(),
        style: z.string(),
        quantity: z.string(),
        /** Older drafts omit this; a missing flag is a numbered quantity. */
        unlimited: z.boolean().optional(),
        priceOverride: z.string(),
      }),
    ),
    /** Legacy drafts stored the shipping choice as 'physical'; accepted here and migrated to 'shipping' on restore. */
    fulfillment: z.union([listingFulfillmentSchema, z.literal('physical')]),
    shippingLabel: z.string(),
    freeShipping: z.boolean(),
    shippingPrice: z.string(),
    shippingMinDays: z.string(),
    shippingMaxDays: z.string(),
    measurementSystem: z.enum(['metric', 'imperial']),
    packageWeight: z.string(),
    packageLength: z.string(),
    packageWidth: z.string(),
    packageHeight: z.string(),
    returnDays: z.enum(['none', '14', '30']),
    /** Legacy single-photo drafts carried one alt text; tolerated so they still hydrate. */
    altText: z.string(),
    /** Legacy drafts stored package fields as raw millimeters/grams; tolerated and converted on restore. */
    weightGrams: z.string(),
    lengthMillimeters: z.string(),
    widthMillimeters: z.string(),
    heightMillimeters: z.string(),
    /** Present when this draft was seeded by duplicating a published listing. */
    seededFromTitle: z.string(),
    /** Present when the source listing was an auction copied as fixed price. */
    seededAuctionAsFixedPrice: z.boolean(),
    /** Composer photo refs. New-file blobs sit on the Dexie row, not here. */
    mediaRefs: z.array(z.unknown()),
    /** Last open wizard section (`listing-section-*`). */
    activeSectionId: z.string(),
  })
  .partial()
  .strict();

export type CreateMarketplaceListingData = z.infer<typeof createMarketplaceListingSchema>;
export type CreateMarketplaceListingDraftData = z.infer<typeof createMarketplaceListingDraftSchema>;

/**
 * The studio's delivery options (local pickup design §A2; digital delivery
 * design §2). The record vocabulary couples `physical` to package facts and
 * a shipping option (the record schema's own rule), and the service derives
 * its methods from the record (`commerceListingFulfillmentMethods`), so:
 *
 * | Seller picks            | `fulfillmentMethods` written                  |
 * |-------------------------|-----------------------------------------------|
 * | Ship                    | `['physical']`                                |
 * | Pickup                  | `['pickup']`                                  |
 * | Ship + Pickup           | `['physical', 'shipping', 'pickup']`          |
 * | Digital                 | `['digital']`                                 |
 * | Ship + Digital          | `['physical', 'shipping', 'digital']`         |
 * | Pickup + Digital        | `['pickup', 'digital']`                       |
 * | Ship + Pickup + Digital | `['physical', 'shipping', 'pickup', 'digital']` |
 *
 * `shipping` is written explicitly whenever another method is present,
 * because the service's derivation would otherwise drop shipping.
 */
export function fulfillmentMethodsFromForm(
  fulfillment: CreateMarketplaceListingData['fulfillment'],
): CommerceListingRecord['fulfillmentMethods'] {
  const { ship, pickup, digital } = fulfillmentFlags(fulfillment);
  if (ship && !pickup && !digital) return ['physical'];
  return [
    ...(ship ? (['physical', 'shipping'] as const) : []),
    ...(pickup ? (['pickup'] as const) : []),
    ...(digital ? (['digital'] as const) : []),
  ];
}

/**
 * The inverse mapping for edit/duplicate hydration: the form reads back the
 * methods the service derives from the record, so a record reads exactly as
 * it sells. Records published before the fulfillment choice existed derive
 * to shipping; a legacy pickup-only record (`['pickup']` or
 * `['physical','pickup']`) reads as pickup; `['physical','digital']`
 * without an explicit `shipping` reads as digital-only.
 */
export function fulfillmentFormValueFromRecord(
  methods: readonly CommerceListingRecord['fulfillmentMethods'][number][],
): CreateMarketplaceListingData['fulfillment'] {
  const derived = commerceListingFulfillmentMethods(methods);
  return (
    fulfillmentFromFlags({
      ship: derived.includes('shipping'),
      pickup: derived.includes('pickup'),
      digital: derived.includes('digital'),
    }) ?? 'shipping'
  );
}

/** True when the fulfillment choice includes shipping (the shipping/package fields stay required). */
export function fulfillmentRequiresShipping(fulfillment: CreateMarketplaceListingData['fulfillment']): boolean {
  return fulfillmentFlags(fulfillment).ship;
}

/** Schema field names for a scoped `useWatch` — keep this derived, never hand-typed. */
export const CREATE_MARKETPLACE_LISTING_SCHEMA_KEYS = Object.keys(createMarketplaceListingSchema.shape) as Array<
  keyof CreateMarketplaceListingData
>;

/**
 * `useWatch({ name: keys })` returns a tuple, not a form object. Passing that
 * tuple to `safeParse` fails on every required key. Zip it back onto a full
 * `getValues()` snapshot so the publish checklist tracks the current fields.
 */
export function createMarketplaceListingValuesFromWatch(
  watched: unknown,
  getValues: () => CreateMarketplaceListingData,
): CreateMarketplaceListingData {
  const current = getValues();
  const keys = CREATE_MARKETPLACE_LISTING_SCHEMA_KEYS;
  if (Array.isArray(watched) && watched.length === keys.length) {
    const next = { ...current };
    for (let index = 0; index < keys.length; index++) {
      (next as Record<string, unknown>)[keys[index]] = watched[index];
    }
    return next;
  }
  if (watched && typeof watched === 'object' && !Array.isArray(watched) && 'title' in watched) {
    return { ...current, ...(watched as Partial<CreateMarketplaceListingData>) };
  }
  return current;
}

export const createMarketplaceListingDefaults: CreateMarketplaceListingData = {
  title: '',
  description: '',
  categoryId: '',
  attrSize: '',
  attrBrand: '',
  attrColors: [],
  attrSource: '',
  attrAge: '',
  attrStyles: [],
  attrModel: '',
  attrMedium: '',
  attrAuthor: '',
  attrFormat: '',
  attrMaterial: '',
  condition: 'good',
  countryCode: 'US',
  region: '',
  saleFormat: 'fixed_price',
  currency: 'USD',
  price: '',
  reservePrice: '',
  variants: [{ sku: '', size: '', color: '', style: '', quantity: '1', unlimited: false, priceOverride: '' }],
  fulfillment: 'shipping',
  shippingLabel: 'Seller shipping',
  freeShipping: false,
  shippingPrice: '',
  shippingMinDays: '3',
  shippingMaxDays: '7',
  measurementSystem: 'metric',
  packageWeight: '',
  packageLength: '',
  packageWidth: '',
  packageHeight: '',
  returnDays: 'none',
};

const PUBLISH_SHIPPING_PATHS = new Set<string>([
  CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_LABEL,
  CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_PRICE,
  CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_MIN_DAYS,
  CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_MAX_DAYS,
  CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_WEIGHT,
  CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_LENGTH,
  CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_WIDTH,
  CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_HEIGHT,
]);

const PUBLISH_CHECKLIST_LABELS: Record<string, string> = {
  [CREATE_MARKETPLACE_LISTING_FIELDS.TITLE]: 'Title',
  [CREATE_MARKETPLACE_LISTING_FIELDS.DESCRIPTION]: 'Description',
  [CREATE_MARKETPLACE_LISTING_FIELDS.CATEGORY]: 'Category',
  [CREATE_MARKETPLACE_LISTING_FIELDS.PRICE]: 'Price',
  [CREATE_MARKETPLACE_LISTING_FIELDS.COUNTRY_CODE]: 'Country',
  [CREATE_MARKETPLACE_LISTING_FIELDS.VARIANTS]: 'Inventory',
  [CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT]: 'Choose shipping or pickup',
};

/**
 * Publish is allowed only when the create schema accepts the current values
 * and at least one photo is attached (photos are outside the Zod object).
 */
export function isCreateMarketplaceListingPublishReady(
  values: CreateMarketplaceListingData,
  photoCount: number,
): boolean {
  return photoCount > 0 && createMarketplaceListingSchema.safeParse(values).success;
}

/** Remaining required items until `isCreateMarketplaceListingPublishReady`. */
export function createMarketplaceListingPublishChecklist(
  values: CreateMarketplaceListingData,
  photoCount: number,
): string[] {
  const items: string[] = [];
  if (photoCount < 1) items.push('At least one photo');
  const parsed = createMarketplaceListingSchema.safeParse(values);
  if (parsed.success) return items;

  const labels = new Set<string>();
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (PUBLISH_SHIPPING_PATHS.has(key)) {
      labels.add('Shipping details');
      continue;
    }
    if (key.startsWith('attr')) {
      labels.add('Required item specifics');
      continue;
    }
    labels.add(PUBLISH_CHECKLIST_LABELS[key] ?? issue.message);
  }
  items.push(...labels);
  return items;
}
