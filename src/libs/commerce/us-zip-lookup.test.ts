import { describe, expect, it } from 'vitest';
import { lookupUsZip } from './us-zip-lookup';
import { zip3ToState } from './us-zip-prefixes';

describe('lookupUsZip', () => {
  it('maps GeoNames ZIP5 records to city and state', () => {
    expect(lookupUsZip('02740')).toEqual({ city: 'New Bedford', region: 'MA' });
    expect(lookupUsZip('02740-1234')).toEqual({ city: 'New Bedford', region: 'MA' });
    expect(lookupUsZip('10001')).toEqual({ city: 'New York', region: 'NY' });
    expect(lookupUsZip('10006')).toEqual({ city: 'New York', region: 'NY' });
  });

  it('returns null until five digits are present', () => {
    expect(lookupUsZip('')).toBeNull();
    expect(lookupUsZip('0274')).toBeNull();
    expect(lookupUsZip('abcde')).toBeNull();
  });

  it('falls back to USPS ZIP3 → state when the ZIP5 is absent', () => {
    expect(zip3ToState('027')).toBe('MA');
    expect(zip3ToState('100')).toBe('NY');
    const missing = lookupUsZip('00000');
    expect(missing).toBeNull();
  });
});
