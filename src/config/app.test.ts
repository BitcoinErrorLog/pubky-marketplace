import { describe, expect, it } from 'vitest';
import ringCookie from '@/test/fixtures/auth/ring-cookie-signin.pubky-common-0.11.json';
import {
  CAPABILITIES,
  capabilitiesMatchFullGrant,
  capabilitiesMatchRingCookieGrant,
  RING_COOKIE_CAPABILITIES,
} from './app';

describe('capabilitiesMatchFullGrant', () => {
  const full = CAPABILITIES.split(',');

  it('accepts the exact CAPABILITIES set', () => {
    expect(capabilitiesMatchFullGrant(full)).toBe(true);
  });

  it('accepts a reordered full grant', () => {
    expect(capabilitiesMatchFullGrant([...full].reverse())).toBe(true);
  });

  it('refuses empty capabilities', () => {
    expect(capabilitiesMatchFullGrant([])).toBe(false);
  });

  it('refuses a missing or extra entry', () => {
    expect(capabilitiesMatchFullGrant(full.slice(0, 2))).toBe(false);
    expect(capabilitiesMatchFullGrant([...full, '/extra/:rw'])).toBe(false);
  });

  it('refuses the Ring cookie set, so grant sessions keep the exact Shop grant', () => {
    expect(capabilitiesMatchFullGrant(RING_COOKIE_CAPABILITIES.split(','))).toBe(false);
  });
});

describe('RING_COOKIE_CAPABILITIES', () => {
  const entries = (capabilities: string) => capabilities.split(',');

  it("is exactly the union of the Shop grant and pubky.app's sign-in set", () => {
    const union = new Set([...entries(CAPABILITIES), ...entries(ringCookie.pubky_app_signin)]);
    expect(new Set(entries(RING_COOKIE_CAPABILITIES))).toEqual(union);
    expect(entries(RING_COOKIE_CAPABILITIES)).toHaveLength(union.size);
  });

  it('keeps the Shop grant first, in its own order', () => {
    expect(RING_COOKIE_CAPABILITIES.startsWith(`${CAPABILITIES},`)).toBe(true);
  });

  it('is what the signer is asked for and what the marketplace service stores after normalizing', () => {
    expect(RING_COOKIE_CAPABILITIES).toBe(ringCookie.requested);
    expect(RING_COOKIE_CAPABILITIES).toBe(ringCookie.service_normalized);
  });
});

describe('capabilitiesMatchRingCookieGrant', () => {
  const ring = RING_COOKIE_CAPABILITIES.split(',');

  it('accepts the exact Ring cookie set in any order', () => {
    expect(capabilitiesMatchRingCookieGrant(ring)).toBe(true);
    expect(capabilitiesMatchRingCookieGrant([...ring].reverse())).toBe(true);
    expect(capabilitiesMatchRingCookieGrant(ring.map((entry) => ` ${entry} `))).toBe(true);
  });

  it.each([
    ['empty', []],
    ['the Shop grant alone', CAPABILITIES.split(',')],
    ["pubky.app's own sign-in set", ringCookie.pubky_app_signin.split(',')],
    ['a missing Locks read', ring.filter((entry) => entry !== '/priv/app.locks/content/:r')],
    [
      'a widened Locks entry',
      ring.map((entry) => (entry === '/priv/app.locks/content/:r' ? '/priv/app.locks/:rw' : entry)),
    ],
    ['an extra entry', [...ring, '/:rw']],
  ])('refuses %s', (_label, capabilities) => {
    expect(capabilitiesMatchRingCookieGrant(capabilities)).toBe(false);
  });
});
