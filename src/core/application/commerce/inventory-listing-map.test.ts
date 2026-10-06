import { describe, expect, it } from 'vitest';
import { createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import { listingToCanonicalRows, mapCanonicalRowsToListing } from './inventory-listing-map';

describe('mapCanonicalRowsToListing', () => {
  it('prefers extraFields.record_json for a Shop-valid create', () => {
    const record = createCommerceListingFixture({ listingId: 'boots_01' });
    const rows = listingToCanonicalRows(record);
    const mapped = mapCanonicalRowsToListing(rows, record.ownerPubky);
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.record.listingId).toBe('boots_01');
      expect(mapped.record.media[0]?.url).toContain('/media/');
    }
  });

  it('maps canonical {accepted,days} return policy when record_json is absent', () => {
    const record = createCommerceListingFixture();
    const [row] = listingToCanonicalRows(record);
    const withoutJson = {
      ...row,
      extraFields: { country_code: 'US', media_json: JSON.stringify(record.media) },
    };
    const mapped = mapCanonicalRowsToListing([withoutJson], record.ownerPubky);
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.record.returnPolicy.acceptsReturns).toBe(true);
      expect(mapped.record.location.countryCode).toBe('US');
    }
  });
});
