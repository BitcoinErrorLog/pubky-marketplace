import { describe, expect, it } from 'vitest';
import {
  commerceListingFulfillmentMethods,
  commerceListingRecordSchema,
  commerceShopRecordSchema,
} from './marketplace-records';
import { createCommerceSandboxCatalog } from './sandbox-catalog';

describe('createCommerceSandboxCatalog', () => {
  it('builds a deterministic, schema-valid catalog with matching projections', () => {
    const first = createCommerceSandboxCatalog();
    const second = createCommerceSandboxCatalog();

    expect(first).toEqual(second);
    expect(first.shops).toHaveLength(10);
    expect(first.listings).toHaveLength(10);
    expect(first.projections).toHaveLength(10);
    expect(first.shops.every((shop) => commerceShopRecordSchema.safeParse(shop).success)).toBe(true);
    expect(first.listings.every((listing) => commerceListingRecordSchema.safeParse(listing).success)).toBe(true);

    const listingRevisions = new Map(
      first.listings.map((listing) => [`${listing.ownerPubky}:${listing.listingId}`, listing.revision]),
    );
    expect(
      first.projections.every((projection) => listingRevisions.get(projection.id) === projection.listing_revision),
    ).toBe(true);
  });

  it('covers fixed-price, auction, fashion, electronics, home, and collectibles discovery', () => {
    const { listings } = createCommerceSandboxCatalog();

    expect(new Set(listings.map(({ sale }) => sale.format))).toEqual(new Set(['fixed_price', 'auction']));
    expect(new Set(listings.map(({ categoryId }) => categoryId.split('-')[0]))).toEqual(
      new Set(['fashion', 'electronics', 'home', 'collectibles']),
    );
  });

  it('mixes taxonomy v1 records (no attributes) with v2 records carrying item specifics', () => {
    const { listings } = createCommerceSandboxCatalog();
    const v1 = listings.filter(({ taxonomyVersion }) => taxonomyVersion === 1);
    const v2 = listings.filter(({ taxonomyVersion }) => taxonomyVersion === 2);

    expect(v1.length).toBeGreaterThan(0);
    expect(v2.length).toBeGreaterThan(0);
    expect(v1.every(({ attributes }) => attributes === undefined)).toBe(true);
    expect(v2.every(({ attributes }) => attributes !== undefined && Object.keys(attributes).length > 0)).toBe(true);

    const fleece = listings.find(({ listingId }) => listingId === 'varsity_fleece');
    expect(fleece?.attributes).toMatchObject({ size: 'L', brand: 'Champion', color: ['grey', 'navy'] });
  });

  it('ships by default: auctions never publish pickup, shipped listings carry an option, all three badge states appear', () => {
    const { listings } = createCommerceSandboxCatalog();
    const methodsOf = (listing: (typeof listings)[number]) =>
      commerceListingFulfillmentMethods(listing.fulfillmentMethods);

    // Auctions and offers are shipping-only (local pickup design §A2): the
    // service refuses to register a pickup auction.
    const auctions = listings.filter(({ sale }) => sale.format === 'auction');
    expect(auctions.length).toBeGreaterThan(0);
    expect(auctions.map((listing) => methodsOf(listing).join('+'))).toEqual(auctions.map(() => 'shipping'));

    // Every listing whose published methods include shipping prices it.
    const shipped = listings.filter((listing) => methodsOf(listing).includes('shipping'));
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.every((listing) => listing.shippingOptions.length > 0)).toBe(true);

    // The catalog exercises all three badge labels: Shipping, Local pickup,
    // Pickup or shipping — via exactly two fixed-price pickup demos.
    const states = new Set(listings.map((listing) => methodsOf(listing).join('+')));
    expect(states).toContain('shipping');
    expect(states).toContain('pickup');
    expect(states).toContain('shipping+pickup');
    const pickupListings = listings.filter((listing) => methodsOf(listing).includes('pickup'));
    expect(pickupListings).toHaveLength(2);
    expect(pickupListings.every(({ sale }) => sale.format === 'fixed_price')).toBe(true);
  });
});
