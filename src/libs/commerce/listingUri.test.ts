import { PubkySpecsBuilder } from 'pubky-app-specs';
import { describe, expect, it } from 'vitest';
import { isListingUri, parseListingUri } from './listingUri';

const SELLER = 'pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy';
const LISTING_ID = '0034A0X7NJ52A';
const LONG_LISTING_ID = '1061cf08aaad4c8f99d996f3c2c092ba';
const CANONICAL = `pubky://${SELLER}/pub/pubky.app/marketplace/v1/listings/${LISTING_ID}`;

describe('parseListingUri', () => {
  it('parses a canonical listing URI', () => {
    expect(parseListingUri(CANONICAL)).toEqual({ sellerPubky: SELLER, listingId: LISTING_ID });
  });

  it.each([
    ['post URI', `pubky://${SELLER}/pub/pubky.app/posts/${LISTING_ID}`],
    ['shop URI', `pubky://${SELLER}/pub/pubky.app/marketplace/v1/shop.json`],
    ['extra path segment', `${CANONICAL}/extra`],
    ['trailing slash', `${CANONICAL}/`],
    ['query string', `${CANONICAL}?x=1`],
    ['short pubky id', `pubky://short/pub/pubky.app/marketplace/v1/listings/${LISTING_ID}`],
    ['invalid short listing id', `pubky://${SELLER}/pub/pubky.app/marketplace/v1/listings/short!1234567`],
    ['http scheme', `https://${SELLER}/pub/pubky.app/marketplace/v1/listings/${LISTING_ID}`],
    ['empty string', ''],
  ])('returns null for %s', (_, uri) => {
    expect(parseListingUri(uri)).toBeNull();
  });

  it('parses a 32-character commerce entity id', () => {
    expect(parseListingUri(`pubky://${SELLER}/pub/pubky.app/marketplace/v1/listings/${LONG_LISTING_ID}`)).toEqual({
      sellerPubky: SELLER,
      listingId: LONG_LISTING_ID,
    });
  });
});

describe('isListingUri', () => {
  it('accepts the canonical form and rejects everything else', () => {
    expect(isListingUri(CANONICAL)).toBe(true);
    expect(isListingUri(`pubky://${SELLER}/pub/pubky.app/posts/${LISTING_ID}`)).toBe(false);
  });
});

describe('listing URI agreement with pubky-app-specs', () => {
  const builder = new PubkySpecsBuilder(SELLER);

  it.each([
    ['32-hex entity id', '1061cf08aaad4c8f99d996f3c2c092ba'],
    ['Crockford timestamp id', '0034A0X7NJ52A'],
    ['one-character entity id', 'a'],
    ['128-character entity id', 'a'.repeat(128)],
  ])('accepts %s in both validators', (_, listingId) => {
    const uri = `pubky://${SELLER}/pub/pubky.app/marketplace/v1/listings/${listingId}`;

    expect(parseListingUri(uri)).toEqual({ sellerPubky: SELLER, listingId });
    expect(() => builder.createCollectionPost('Saved', '', [uri])).not.toThrow();
  });

  it.each([
    ['slash', 'listing/id'],
    ['dot', 'listing.id'],
    ['empty', ''],
    ['129-character entity id', 'a'.repeat(129)],
  ])('rejects %s in both validators', (_, listingId) => {
    const uri = `pubky://${SELLER}/pub/pubky.app/marketplace/v1/listings/${listingId}`;

    expect(parseListingUri(uri)).toBeNull();
    expect(() => builder.createCollectionPost('Saved', '', [uri])).toThrow();
  });
});
