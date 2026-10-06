import { describe, expect, it } from 'vitest';
import { readGrantSigner } from './useGrantSigner';

describe('readGrantSigner', () => {
  it('is null without a session and for a cookie session', () => {
    expect(readGrantSigner({ session: null, grantSigner: 'passport' })).toBeNull();
    expect(readGrantSigner({ session: { grant: undefined }, grantSigner: 'passport' })).toBeNull();
  });

  it('names Pubky Passport only when the grant session is marked Passport-approved', () => {
    expect(readGrantSigner({ session: { grant: {} }, grantSigner: 'passport' })).toBe('passport');
  });

  it('treats an unmarked grant session (saved before Passport existed) as Bitkit', () => {
    expect(readGrantSigner({ session: { grant: {} }, grantSigner: null })).toBe('bitkit');
    expect(readGrantSigner({ session: { grant: {} }, grantSigner: 'bitkit' })).toBe('bitkit');
  });
});
