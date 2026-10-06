import { afterEach, describe, expect, it, vi } from 'vitest';
import { marketplaceAddressFormSchema } from '@/hooks/useMarketplaceAddressBook/useMarketplaceAddressBook.types';
import { marketplaceCheckoutSchema } from '@/hooks/useMarketplaceCheckout/useMarketplaceCheckout.types';
import {
  addressCountryFromLocales,
  browserAddressCountry,
  canonicalizeRegion,
  commerceDeliveryAddressValueSchema,
  filterSubdivisions,
  isRegionRequired,
  postalErrorMessage,
  regionErrorMessage,
  regionLabelForCountry,
} from './postal-address';

const usBase = {
  name: 'Alice Buyer',
  line1: '42 Union Street',
  line2: '',
  city: 'New Bedford',
  region: 'MA',
  postalCode: '02740',
  countryCode: 'US',
};

describe('postal country table', () => {
  it('requires a labelled subdivision for US/CA/AU/BR/IN/MX and not for GB/DE/NL/FR/JP', () => {
    expect(isRegionRequired('US')).toBe(true);
    expect(isRegionRequired('CA')).toBe(true);
    expect(isRegionRequired('AU')).toBe(true);
    expect(isRegionRequired('BR')).toBe(true);
    expect(isRegionRequired('IN')).toBe(true);
    expect(isRegionRequired('MX')).toBe(true);
    expect(isRegionRequired('GB')).toBe(false);
    expect(isRegionRequired('DE')).toBe(false);
    expect(isRegionRequired('NL')).toBe(false);
    expect(isRegionRequired('FR')).toBe(false);
    expect(isRegionRequired('JP')).toBe(false);
    expect(regionLabelForCountry('US')).toBe('State');
    expect(regionLabelForCountry('CA')).toBe('Province');
    expect(regionLabelForCountry('AU')).toBe('State');
    expect(regionLabelForCountry('MX')).toBe('State');
    expect(regionLabelForCountry('BR')).toBe('State');
    expect(regionLabelForCountry('IN')).toBe('State');
    expect(regionLabelForCountry('JP')).toBe('Prefecture');
    expect(regionLabelForCountry('GB')).toBe('Region');
  });

  it('uses State is required for the New Bedford US case, not Region', () => {
    expect(regionErrorMessage('US', '')).toBe('State is required.');
    expect(regionErrorMessage('US', 'MA')).toBeNull();
    expect(regionErrorMessage('US', 'Massachusetts')).toBeNull();
    expect(canonicalizeRegion('US', 'Massachusetts')).toBe('MA');
    expect(regionErrorMessage('US', 'XX')).toBe('Choose a valid state.');
  });

  it('accepts CA provinces and AU states by code or name', () => {
    expect(canonicalizeRegion('CA', 'ontario')).toBe('ON');
    expect(regionErrorMessage('CA', '')).toBe('Province is required.');
    expect(canonicalizeRegion('AU', 'NSW')).toBe('NSW');
    expect(regionErrorMessage('AU', 'ZZ')).toBe('Choose a valid state.');
  });

  it('filters US states by name or code prefix', () => {
    const mass = filterSubdivisions('US', 'Mass');
    expect(mass).toEqual([{ code: 'MA', name: 'Massachusetts' }]);
    expect(filterSubdivisions('US', 'NY').map((option) => option.code)).toEqual(['NY']);
    expect(filterSubdivisions('GB', 'York')).toEqual([]);
  });

  it('allows empty region for GB/DE/NL/FR and still requires postal shape', () => {
    expect(regionErrorMessage('GB', '')).toBeNull();
    expect(regionErrorMessage('DE', '')).toBeNull();
    expect(postalErrorMessage('GB', 'SW1A 1AA')).toBeNull();
    expect(postalErrorMessage('DE', '10115')).toBeNull();
    expect(postalErrorMessage('NL', '1012AB')).toBeNull();
    expect(postalErrorMessage('US', '02740')).toBeNull();
    expect(postalErrorMessage('US', 'abc')).toBe('Use a valid ZIP code (e.g. 02740).');
    expect(postalErrorMessage('US', '')).toBe('ZIP code is required.');
  });
});

describe('commerceDeliveryAddressValueSchema', () => {
  it('stores the US state code and accepts the live New Bedford ZIP', () => {
    expect(commerceDeliveryAddressValueSchema.parse(usBase)).toMatchObject({
      region: 'MA',
      postalCode: '02740',
      countryCode: 'US',
    });
  });

  it('rejects a US address with no state', () => {
    const parsed = commerceDeliveryAddressValueSchema.safeParse({ ...usBase, region: '' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message === 'State is required.')).toBe(true);
  });

  it('accepts a GB address with no region', () => {
    expect(
      commerceDeliveryAddressValueSchema.parse({
        name: 'Ada',
        line1: '10 Downing Street',
        line2: '',
        city: 'London',
        region: '',
        postalCode: 'SW1A 2AA',
        countryCode: 'GB',
      }).region,
    ).toBe('');
  });
});

describe('form schemas', () => {
  it('flags the checkout US empty-region case with State is required', () => {
    const parsed = marketplaceCheckoutSchema.safeParse({
      name: 'Alice Buyer',
      line1: '42 Union Street',
      line2: '',
      city: 'New Bedford',
      region: '',
      postalCode: '02740',
      countryCode: 'US',
      requiresDeliveryAddress: true,
      deliveryEmail: '',
      requiresDeliveryEmail: false,
      acceptsGuarantee: true,
      saveAddress: false,
      saveLabel: '',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message === 'State is required.')).toBe(true);
  });

  it('lets a GB checkout omit region', () => {
    expect(
      marketplaceCheckoutSchema.safeParse({
        name: 'Ada',
        line1: '10 Downing Street',
        line2: '',
        city: 'London',
        region: '',
        postalCode: 'SW1A 2AA',
        countryCode: 'GB',
        requiresDeliveryAddress: true,
        deliveryEmail: '',
        requiresDeliveryEmail: false,
        acceptsGuarantee: true,
        saveAddress: false,
        saveLabel: '',
      }).success,
    ).toBe(true);
  });

  it('saves a US address-book row only with a real state', () => {
    const parsed = marketplaceAddressFormSchema.safeParse({
      label: 'Home',
      ...usBase,
      region: '',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the country a new address starts with', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is the region of the first locale that names one', () => {
    expect(addressCountryFromLocales(['en-GB', 'en-US'])).toBe('GB');
    expect(addressCountryFromLocales(['de', 'de-AT', 'en-US'])).toBe('AT');
    expect(addressCountryFromLocales(['pt-br'])).toBe('BR');
    expect(addressCountryFromLocales(['zh-Hant-TW'])).toBe('TW');
  });

  it('skips numeric, non-country and malformed regions, falling back to US', () => {
    expect(addressCountryFromLocales(['es-419', 'es-MX'])).toBe('MX');
    expect(addressCountryFromLocales(['en-150'])).toBe('US');
    expect(addressCountryFromLocales(['en-EU', 'en-UN', 'en-ZZ', 'en-XA', 'en-QO'])).toBe('US');
    expect(addressCountryFromLocales(['not a tag', ''])).toBe('US');
    expect(addressCountryFromLocales(['fr', 'ja'])).toBe('US');
    expect(addressCountryFromLocales([])).toBe('US');
  });

  it('reads the browser preferences, and navigator.language when the list is empty', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-CA', 'fr']);
    expect(browserAddressCountry()).toBe('CA');

    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([]);
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('nl-BE');
    expect(browserAddressCountry()).toBe('BE');
  });
});
