import { describe, expect, it } from 'vitest';
import { isPlausibleShippoApiKey, shipFromAddressSchema, shippingParcelSchema } from '@/libs/commerce/shipping';

describe('isPlausibleShippoApiKey', () => {
  it('accepts Shippo-shaped tokens', () => {
    expect(isPlausibleShippoApiKey('shippo_test_1234567890abcdef')).toBe(true);
    expect(isPlausibleShippoApiKey('shippo_live_1234567890abcdef')).toBe(true);
  });

  it('refuses non-Shippo secrets so they never leave the browser', () => {
    expect(isPlausibleShippoApiKey('sk_live_1234567890')).toBe(false);
    expect(isPlausibleShippoApiKey('rk_test_1234567890')).toBe(false);
    expect(isPlausibleShippoApiKey('shippo_')).toBe(false);
    expect(isPlausibleShippoApiKey('shippo_ with spaces')).toBe(false);
  });
});

describe('shipFromAddressSchema', () => {
  const base = {
    name: 'Olive Farm',
    line1: 'Maslinska 1',
    line2: '',
    city: 'Split',
    region: '',
    postalCode: '21000',
    countryCode: 'HR',
    phone: '',
    email: '',
  };

  it('accepts a complete address and refuses a non-ISO country', () => {
    expect(shipFromAddressSchema.safeParse(base).success).toBe(true);
    expect(shipFromAddressSchema.safeParse({ ...base, countryCode: 'Croatia' }).success).toBe(false);
    expect(shipFromAddressSchema.safeParse({ ...base, name: '' }).success).toBe(false);
  });
});

describe('shippingParcelSchema', () => {
  it('bounds the metric parcel', () => {
    const parcel = { weightGrams: 900, lengthMm: 300, widthMm: 200, heightMm: 150 };
    expect(shippingParcelSchema.safeParse(parcel).success).toBe(true);
    expect(shippingParcelSchema.safeParse({ ...parcel, weightGrams: 0 }).success).toBe(false);
    expect(shippingParcelSchema.safeParse({ ...parcel, lengthMm: 10_001 }).success).toBe(false);
  });
});
