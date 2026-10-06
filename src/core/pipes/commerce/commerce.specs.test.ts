import { PubkySpecsBuilder } from 'pubky-app-specs';
import { describe, expect, it } from 'vitest';
import {
  COMMERCE_FIXTURE_SELLER,
  createCommerceListingFixture,
  createCommerceShopFixture,
} from '@/test/fixtures/commerce/commerce';
import { CommerceRecordNormalizer } from './commerce.normalizer';

/**
 * Contract tests between this client's Zod record schemas and the marketplace
 * object definitions in pubky-app-specs, so the client cannot drift into writing
 * records that other Pubky clients and Nexus cannot parse.
 *
 * Note the asymmetry these tests pin down: required and malformed fields are
 * rejected, but a field the spec does not define is silently **stripped** rather
 * than refused, because the wasm boundary does not carry serde's
 * deny_unknown_fields through. So adding a record field on the client alone
 * loses it on write instead of failing loudly — the spec has to be changed first.
 */
describe('commerce records against pubky-app-specs', () => {
  const builder = () => new PubkySpecsBuilder(COMMERCE_FIXTURE_SELLER);

  it('accepts a client shop record and returns the canonical singleton path', () => {
    const result = builder().createShop(createCommerceShopFixture());

    expect(result.meta.url).toBe(CommerceRecordNormalizer.shopUri(COMMERCE_FIXTURE_SELLER));
    expect(result.meta.url).toContain('/pub/pubky.app/marketplace/v1/shop.json');
  });

  it('accepts a client listing record and assigns a spec-generated timestamp id', () => {
    const result = builder().createListing(createCommerceListingFixture());

    // The spec owns id generation; ids are 13-char Crockford base32 like posts.
    expect(result.meta.id).toMatch(/^[0-9A-Z]{13}$/);
    expect(result.meta.url).toBe(CommerceRecordNormalizer.listingUri(COMMERCE_FIXTURE_SELLER, result.meta.id));
    // Listing paths carry no .json suffix, matching posts and tags.
    expect(result.meta.url).not.toContain('.json');
  });

  it('strips a listing field the spec does not define instead of rejecting it', () => {
    const record = { ...createCommerceListingFixture(), unexpectedField: 'nope' };

    const result = builder().createListing(record);
    const serialized = JSON.parse(JSON.stringify(result.listing)) as Record<string, unknown>;

    // Documents the limitation deliberately: client-only fields are dropped on
    // write, so a new record field must land in pubky-app-specs first.
    expect('unexpectedField' in serialized).toBe(false);
  });

  it('round-trips the attributes container and both taxonomy versions through the spec', () => {
    const attributes = { size: 'US 9', color: ['brown', 'black'], 'graded-by': 'PSA 9' };
    const result = builder().createListing({ ...createCommerceListingFixture(), attributes });
    const serialized = result.listing.toJson() as Record<string, unknown>;
    // The wasm boundary renders Rust maps as JS Maps (same as variant
    // options); the wire format is still a plain JSON object.
    expect(Object.fromEntries(serialized.attributes as Map<string, unknown>)).toEqual(attributes);

    // v1 records (no attributes) remain spec-valid alongside v2 records.
    expect(() =>
      builder().createListing({ ...createCommerceListingFixture(), taxonomyVersion: 1, attributes: undefined }),
    ).not.toThrow();
  });

  it('rejects spec-invalid attributes at the wasm boundary', () => {
    expect(() =>
      builder().createListing({ ...createCommerceListingFixture(), attributes: { 'Not-Kebab': 'value' } }),
    ).toThrow();
    expect(() =>
      builder().createListing({ ...createCommerceListingFixture(), attributes: { color: ['brown', 'brown'] } }),
    ).toThrow();
  });

  it('rejects a listing record whose field violates a spec rule', () => {
    const record = { ...createCommerceListingFixture(), title: '' };

    expect(() => builder().createListing(record)).toThrow();
  });

  it('rejects a shop record missing a spec-required field', () => {
    const { schemaVersion: _schemaVersion, ...incomplete } = createCommerceShopFixture();

    expect(() => builder().createShop(incomplete)).toThrow();
  });
});
