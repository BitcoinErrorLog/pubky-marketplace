import { describe, expect, it } from 'vitest';
import { COMMERCE_LISTING_MAX_QUANTITY } from '@/config/commerce';
import { UNLIMITED_STOCK_RESERVED_MESSAGE } from '@/libs/commerce/unlimited-stock';
import {
  CREATE_MARKETPLACE_LISTING_SCHEMA_KEYS,
  type CreateMarketplaceListingData,
  createMarketplaceListingDefaults,
  createMarketplaceListingDraftSchema,
  createMarketplaceListingPublishChecklist,
  createMarketplaceListingSchema,
  createMarketplaceListingValuesFromWatch,
  fulfillmentFlags,
  fulfillmentFormValueFromRecord,
  fulfillmentFromFlags,
  fulfillmentMethodsFromForm,
  fulfillmentRequiresShipping,
  isCreateMarketplaceListingPublishReady,
  type ListingFulfillment,
  listingFulfillmentSchema,
  UNLIMITED_STOCK_FORM_MESSAGE,
} from './useCreateMarketplaceListing.types';

/**
 * The form defaults deliberately ship no category (the seller must pick
 * one); these tests exercise the rest of the schema with a resolvable
 * category that requires no attributes.
 */
const formDefaults = { ...createMarketplaceListingDefaults, categoryId: 'fashion' };

describe('createMarketplaceListingSchema', () => {
  it('defaults to physical shipping and final sale', () => {
    expect(createMarketplaceListingDefaults.fulfillment).toBe('shipping');
    expect(createMarketplaceListingDefaults.returnDays).toBe('none');
    expect(createMarketplaceListingDefaults.variants[0].unlimited).toBe(false);
  });

  it('accepts complete physical delivery terms', () => {
    expect(
      createMarketplaceListingSchema.safeParse({
        ...formDefaults,
        fulfillment: 'shipping',
        title: 'Vintage leather boots',
        description: 'Well cared for boots with light wear.',
        price: '125.00',
        shippingPrice: '12.00',
        packageWeight: '1200',
        packageLength: '35.0',
        packageWidth: '25.0',
        packageHeight: '15.0',
      }).success,
    ).toBe(true);
  });

  it('accepts imperial package inputs with one decimal', () => {
    expect(
      createMarketplaceListingSchema.safeParse({
        ...formDefaults,
        fulfillment: 'shipping',
        title: 'Vintage leather boots',
        description: 'Well cared for boots with light wear.',
        price: '125.00',
        shippingPrice: '12.00',
        measurementSystem: 'imperial',
        packageWeight: '42.3',
        packageLength: '13.8',
        packageWidth: '9.8',
        packageHeight: '5.9',
      }).success,
    ).toBe(true);
  });

  it('rejects fractional grams in metric but allows one-decimal ounces in imperial', () => {
    const base = {
      ...formDefaults,
      fulfillment: 'shipping' as const,
      title: 'Vintage leather boots',
      description: 'Well cared for boots with light wear.',
      price: '125.00',
      shippingPrice: '12.00',
      packageLength: '35.0',
      packageWidth: '25.0',
      packageHeight: '15.0',
    };
    expect(createMarketplaceListingSchema.safeParse({ ...base, packageWeight: '1200.5' }).success).toBe(false);
    expect(
      createMarketplaceListingSchema.safeParse({ ...base, measurementSystem: 'imperial', packageWeight: '42.3' })
        .success,
    ).toBe(true);
  });

  it('accepts whole-base-unit bitcoin pricing and rejects decimals', () => {
    const base = {
      ...formDefaults,
      title: 'Vintage leather boots',
      description: 'Well cared for boots with light wear.',
      currency: 'BTC' as const,
      fulfillment: 'pickup' as const,
    };
    expect(createMarketplaceListingSchema.safeParse({ ...base, price: '150000' }).success).toBe(true);
    expect(createMarketplaceListingSchema.safeParse({ ...base, price: '150000.5' }).success).toBe(false);
    expect(createMarketplaceListingSchema.safeParse({ ...base, price: '0' }).success).toBe(false);
  });

  it('validates variant price overrides and shipping in the chosen currency', () => {
    const base = {
      ...formDefaults,
      fulfillment: 'shipping' as const,
      title: 'Vintage leather boots',
      description: 'Well cared for boots with light wear.',
      currency: 'BTC' as const,
      price: '150000',
      shippingPrice: '15000',
      packageWeight: '1200',
      packageLength: '35.0',
      packageWidth: '25.0',
      packageHeight: '15.0',
    };
    const baseUnitOverride = [
      { sku: '', size: '', color: '', style: '', quantity: '1', unlimited: false, priceOverride: '175000' },
    ];
    const decimalOverride = [
      { sku: '', size: '', color: '', style: '', quantity: '1', unlimited: false, priceOverride: '175000.50' },
    ];
    expect(createMarketplaceListingSchema.safeParse({ ...base, variants: baseUnitOverride }).success).toBe(true);
    expect(createMarketplaceListingSchema.safeParse({ ...base, variants: decimalOverride }).success).toBe(false);
    expect(createMarketplaceListingSchema.safeParse({ ...base, shippingPrice: '15000.50' }).success).toBe(false);
  });

  it('allows pickup without package or shipping fields', () => {
    expect(
      createMarketplaceListingSchema.safeParse({
        ...formDefaults,
        title: 'Vintage leather boots',
        description: 'Well cared for boots with light wear.',
        price: '125',
        fulfillment: 'pickup',
      }).success,
    ).toBe(true);
  });

  it('allows free shipping without a shipping price, but never a zero price', () => {
    const base = {
      ...formDefaults,
      title: 'Vintage leather boots',
      description: 'Well cared for boots with light wear.',
      price: '125',
      fulfillment: 'shipping' as const,
      packageWeight: '1200',
      packageLength: '350',
      packageWidth: '250',
      packageHeight: '150',
    };
    // Free shipping: no price needed at all.
    expect(createMarketplaceListingSchema.safeParse({ ...base, freeShipping: true, shippingPrice: '' }).success).toBe(
      true,
    );
    // Still rejected when priced: zero is not a price, and the record's flat
    // option must never carry one (the free variant exists for that).
    expect(createMarketplaceListingSchema.safeParse({ ...base, freeShipping: false, shippingPrice: '0' }).success).toBe(
      false,
    );
    expect(
      createMarketplaceListingSchema.safeParse({ ...base, freeShipping: false, shippingPrice: '0.00' }).success,
    ).toBe(false);
  });

  it('supports multiple fixed-price variants but only one auction variant', () => {
    const variants = [
      { sku: 'BOOTS-42', size: '42', color: 'Brown', style: '', quantity: '1', unlimited: false, priceOverride: '' },
      {
        sku: 'BOOTS-43',
        size: '43',
        color: 'Brown',
        style: '',
        quantity: '2',
        unlimited: false,
        priceOverride: '135.00',
      },
    ];
    const base = {
      ...formDefaults,
      title: 'Vintage leather boots',
      description: 'Well cared for boots with light wear.',
      price: '125',
      fulfillment: 'pickup' as const,
      variants,
    };

    expect(createMarketplaceListingSchema.safeParse(base).success).toBe(true);
    expect(createMarketplaceListingSchema.safeParse({ ...base, saleFormat: 'auction' }).success).toBe(false);
  });

  it('requires unique non-empty seller SKUs', () => {
    const duplicate = {
      sku: 'BOOTS',
      size: '',
      color: '',
      style: '',
      quantity: '1',
      unlimited: false,
      priceOverride: '',
    };
    expect(
      createMarketplaceListingSchema.safeParse({
        ...formDefaults,
        title: 'Vintage leather boots',
        description: 'Well cared for boots with light wear.',
        price: '125',
        fulfillment: 'pickup',
        variants: [duplicate, { ...duplicate, size: '43' }],
      }).success,
    ).toBe(false);
  });

  it('requires a category that resolves in the taxonomy', () => {
    const base = {
      ...formDefaults,
      title: 'Vintage leather boots',
      description: 'Well cared for boots with light wear.',
      price: '125',
      fulfillment: 'pickup' as const,
    };
    expect(createMarketplaceListingSchema.safeParse({ ...base, categoryId: '' }).success).toBe(false);
    expect(createMarketplaceListingSchema.safeParse({ ...base, categoryId: 'not-a-category' }).success).toBe(false);
    // Legacy v1 ids still resolve, so editing older records stays possible.
    expect(createMarketplaceListingSchema.safeParse({ ...base, categoryId: 'fashion-shoes-boots' }).success).toBe(true);
    expect(createMarketplaceListingSchema.safeParse({ ...base, categoryId: 'collectibles-music-vinyl' }).success).toBe(
      true,
    );
  });

  it('requires a chart size for fashion leaves that have a size chart', () => {
    const base = {
      ...formDefaults,
      title: 'Hiking boots',
      description: 'Sturdy leather hiking boots.',
      price: '125',
      fulfillment: 'pickup' as const,
      categoryId: 'fashion-men-footwear-boots',
    };
    expect(createMarketplaceListingSchema.safeParse(base).success).toBe(false);
    expect(createMarketplaceListingSchema.safeParse({ ...base, attrSize: 'US 9' }).success).toBe(true);
    // The size must come from the leaf's chart, not be free text.
    expect(createMarketplaceListingSchema.safeParse({ ...base, attrSize: 'gigantic' }).success).toBe(false);
    // Chartless fashion leaves (e.g. accessories) have no size requirement.
    expect(
      createMarketplaceListingSchema.safeParse({ ...base, categoryId: 'fashion-men-accessories-belt' }).success,
    ).toBe(true);
  });

  it('bounds and vocab-checks multi-value attributes', () => {
    const base = {
      ...formDefaults,
      title: 'Varsity fleece',
      description: 'Boxy 90s collegiate fleece.',
      price: '72',
      fulfillment: 'pickup' as const,
      categoryId: 'fashion-men-tops-hoodies',
      attrSize: 'L',
    };
    expect(createMarketplaceListingSchema.safeParse({ ...base, attrColors: ['grey', 'navy'] }).success).toBe(true);
    expect(createMarketplaceListingSchema.safeParse({ ...base, attrColors: ['grey', 'navy', 'black'] }).success).toBe(
      false,
    );
    expect(createMarketplaceListingSchema.safeParse({ ...base, attrColors: ['taupe'] }).success).toBe(false);
    expect(
      createMarketplaceListingSchema.safeParse({ ...base, attrStyles: ['retro', 'sportswear', 'grunge'] }).success,
    ).toBe(true);
    expect(createMarketplaceListingSchema.safeParse({ ...base, attrSource: 'vintage' }).success).toBe(true);
    expect(createMarketplaceListingSchema.safeParse({ ...base, attrSource: 'stolen' }).success).toBe(false);
  });

  it('leaves free-text attributes unconstrained beyond length', () => {
    const base = {
      ...formDefaults,
      title: 'Program-mode SLR',
      description: 'Clean film SLR body.',
      price: '210',
      fulfillment: 'pickup' as const,
      categoryId: 'electronics-cameras-film',
    };
    expect(
      createMarketplaceListingSchema.safeParse({ ...base, attrBrand: 'Canon', attrModel: 'AE-1 Program' }).success,
    ).toBe(true);
    expect(createMarketplaceListingSchema.safeParse({ ...base, attrModel: 'x'.repeat(81) }).success).toBe(false);
  });

  it.each([
    ['zero price', { price: '0' }],
    ['fractional cents', { price: '1.001' }],
    [
      'zero quantity',
      {
        variants: [
          {
            ...formDefaults.variants[0],
            quantity: '0',
          },
        ],
      },
    ],
    ['invalid country', { countryCode: 'USA' }],
  ])('rejects %s', (_label, changes) => {
    const result = createMarketplaceListingSchema.safeParse({
      ...formDefaults,
      title: 'Vintage leather boots',
      description: 'Well cared for boots with light wear.',
      price: '125',
      fulfillment: 'pickup',
      ...changes,
    });

    expect(result.success).toBe(false);
  });
});

const pickupReady = {
  ...formDefaults,
  title: 'Vintage leather boots',
  description: 'Well cared for boots with light wear.',
  price: '125.00',
  fulfillment: 'pickup' as const,
};

const physicalReady = {
  ...pickupReady,
  fulfillment: 'shipping' as const,
  shippingPrice: '12.00',
  packageWeight: '1200',
  packageLength: '35.0',
  packageWidth: '25.0',
  packageHeight: '15.0',
};

describe('isCreateMarketplaceListingPublishReady', () => {
  it.each([
    ['pickup with photos', pickupReady, 1, true],
    ['physical shipping with photos', physicalReady, 1, true],
    ['empty description', { ...pickupReady, description: '   ' }, 1, false],
    ['physical without shipping fields', { ...pickupReady, fulfillment: 'shipping' as const }, 1, false],
    ['schema-valid pickup without photos', pickupReady, 0, false],
    ['title too short', { ...pickupReady, title: 'ab' }, 1, false],
  ] as const)('gate matches schema plus photos: %s', (_label, values, photoCount, expected) => {
    const schemaValid = createMarketplaceListingSchema.safeParse(values).success;
    const ready = isCreateMarketplaceListingPublishReady(values, photoCount);
    expect(ready).toBe(expected);
    expect(ready).toBe(schemaValid && photoCount > 0);
  });

  it('lists description and shipping until they satisfy the schema', () => {
    expect(createMarketplaceListingPublishChecklist({ ...pickupReady, description: '' }, 1)).toContain('Description');
    expect(createMarketplaceListingPublishChecklist({ ...pickupReady, fulfillment: 'shipping' }, 1)).toContain(
      'Shipping details',
    );
    expect(createMarketplaceListingPublishChecklist(physicalReady, 0)).toEqual(['At least one photo']);
    expect(createMarketplaceListingPublishChecklist(physicalReady, 1)).toEqual([]);
  });

  it('rebuilds full form values from a scoped useWatch tuple', () => {
    const tuple = CREATE_MARKETPLACE_LISTING_SCHEMA_KEYS.map((key) => pickupReady[key]) as unknown[];
    expect(createMarketplaceListingPublishChecklist(tuple as never, 1)).toEqual([
      'Invalid input: expected object, received array',
    ]);
    const zipped = createMarketplaceListingValuesFromWatch(tuple, () => createMarketplaceListingDefaults);
    expect(zipped.title).toBe(pickupReady.title);
    expect(zipped.price).toBe(pickupReady.price);
    expect(zipped.categoryId).toBe(pickupReady.categoryId);
    expect(createMarketplaceListingPublishChecklist(zipped, 1)).toEqual([]);
  });
});

describe('delivery options record encoding (digital delivery design §2)', () => {
  const table: Array<[ListingFulfillment, string[]]> = [
    ['shipping', ['physical']],
    ['pickup', ['pickup']],
    ['shipping_and_pickup', ['physical', 'shipping', 'pickup']],
    ['digital', ['digital']],
    ['shipping_and_digital', ['physical', 'shipping', 'digital']],
    ['pickup_and_digital', ['pickup', 'digital']],
    ['shipping_pickup_and_digital', ['physical', 'shipping', 'pickup', 'digital']],
  ];

  it('writes every combination exactly as the design table', () => {
    for (const [value, methods] of table) {
      expect(fulfillmentMethodsFromForm(value), value).toEqual(methods);
    }
    expect(table.map(([value]) => value).sort()).toEqual([...listingFulfillmentSchema.options].sort());
  });

  it('reads every written record back to the same choice', () => {
    for (const [value, methods] of table) {
      expect(fulfillmentFormValueFromRecord(methods as never), value).toBe(value);
    }
  });

  it('reads records the studio never wrote as the service sells them', () => {
    expect(fulfillmentFormValueFromRecord(['physical', 'pickup'])).toBe('pickup');
    expect(fulfillmentFormValueFromRecord(['physical', 'digital'])).toBe('digital');
    expect(fulfillmentFormValueFromRecord([])).toBe('shipping');
  });

  it('maps checkboxes to values and back, with no value for none checked', () => {
    for (const value of listingFulfillmentSchema.options) {
      expect(fulfillmentFromFlags(fulfillmentFlags(value))).toBe(value);
    }
    expect(fulfillmentFromFlags({ ship: false, pickup: false, digital: false })).toBeNull();
  });

  it('requires the shipping fields exactly when the listing ships', () => {
    for (const value of listingFulfillmentSchema.options) {
      expect(fulfillmentRequiresShipping(value), value).toBe(fulfillmentFlags(value).ship);
    }
  });

  it('auction_with_digital_refused: auctions allow shipping only', () => {
    for (const value of listingFulfillmentSchema.options) {
      const parsed = createMarketplaceListingSchema.safeParse({
        ...formDefaults,
        title: 'Field guide',
        description: 'A guide.',
        saleFormat: 'auction',
        price: '10.00',
        fulfillment: value,
      });
      const fulfillmentIssue = parsed.success
        ? undefined
        : parsed.error.issues.find((issue) => issue.path[0] === 'fulfillment');
      expect(Boolean(fulfillmentIssue), value).toBe(value !== 'shipping');
    }
  });

  it('accepts an empty quantity when the variant is unlimited on a digital-only listing', () => {
    const parsed = createMarketplaceListingSchema.safeParse({
      ...formDefaults,
      title: 'Field guide',
      description: 'A printable guide.',
      price: '10.00',
      fulfillment: 'digital',
      variants: [{ sku: '', size: '', color: '', style: '', quantity: '', unlimited: true, priceOverride: '' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unlimited stock on a listing that is not digital-only', () => {
    const variant = { sku: '', size: '', color: '', style: '', quantity: '2', unlimited: true, priceOverride: '' };
    for (const fulfillment of ['shipping', 'shipping_and_digital', 'pickup_and_digital'] as const) {
      const parsed = createMarketplaceListingSchema.safeParse({
        ...formDefaults,
        title: 'Field guide',
        description: 'A printable guide.',
        price: '10.00',
        fulfillment,
        shippingPrice: '12.00',
        packageWeight: '1200',
        packageLength: '35.0',
        packageWidth: '25.0',
        packageHeight: '15.0',
        variants: [variant],
      });
      expect(parsed.success, fulfillment).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.message === UNLIMITED_STOCK_FORM_MESSAGE)).toBe(true);
      }
    }
  });

  it('refuses the unlimited cap as a typed quantity on any line that ships or offers pickup', () => {
    const listing = (fulfillment: CreateMarketplaceListingData['fulfillment'], quantity: string) =>
      createMarketplaceListingSchema.safeParse({
        ...formDefaults,
        title: 'Field guide',
        description: 'A printable guide.',
        price: '10.00',
        fulfillment,
        shippingPrice: '12.00',
        packageWeight: '1200',
        packageLength: '35.0',
        packageWidth: '25.0',
        packageHeight: '15.0',
        variants: [{ sku: '', size: '', color: '', style: '', quantity, unlimited: false, priceOverride: '' }],
      });
    const reserved = (parsed: ReturnType<typeof listing>) =>
      !parsed.success &&
      parsed.error.issues.some(
        (issue) => issue.path.join('.') === 'variants.0.quantity' && issue.message === UNLIMITED_STOCK_RESERVED_MESSAGE,
      );
    for (const fulfillment of [
      'shipping',
      'pickup',
      'shipping_and_pickup',
      'shipping_and_digital',
      'pickup_and_digital',
      'shipping_pickup_and_digital',
    ] as const) {
      expect(reserved(listing(fulfillment, String(COMMERCE_LISTING_MAX_QUANTITY))), fulfillment).toBe(true);
      expect(reserved(listing(fulfillment, ` ${COMMERCE_LISTING_MAX_QUANTITY} `)), fulfillment).toBe(true);
      expect(reserved(listing(fulfillment, String(COMMERCE_LISTING_MAX_QUANTITY - 1))), fulfillment).toBe(false);
    }
    expect(listing('digital', String(COMMERCE_LISTING_MAX_QUANTITY)).success).toBe(true);
  });

  it('accepts an optional unlimited flag so an older draft still loads', () => {
    const older = createMarketplaceListingDraftSchema.safeParse({
      title: 'Field guide',
      variants: [{ sku: '', size: '', color: '', style: '', quantity: '1', priceOverride: '' }],
    });
    expect(older.success).toBe(true);
    if (older.success) expect(older.data.variants?.[0].unlimited).toBeUndefined();
    const flagged = createMarketplaceListingDraftSchema.safeParse({
      variants: [{ sku: '', size: '', color: '', style: '', quantity: '1', priceOverride: '', unlimited: true }],
    });
    expect(flagged.success).toBe(true);
    if (flagged.success) expect(flagged.data.variants?.[0].unlimited).toBe(true);
  });

  it('a digital-only listing needs no shipping or package fields', () => {
    const parsed = createMarketplaceListingSchema.safeParse({
      ...formDefaults,
      title: 'Field guide',
      description: 'A printable guide.',
      price: '10.00',
      fulfillment: 'digital',
      shippingLabel: '',
      shippingPrice: '',
      packageWeight: '',
    });
    expect(parsed.success).toBe(true);
  });
});
