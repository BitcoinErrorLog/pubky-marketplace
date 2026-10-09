import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRuntimeConfigForTests } from '@/libs/runtime-config/runtime-config';
import { PUBKY_RUNTIME_ENV_NAMES } from '@/libs/runtime-config/runtime-config.schema';
import ringCookie from '@/test/fixtures/auth/ring-cookie-signin.pubky-common-0.11.json';
import {
  CAPABILITIES,
  capabilitiesMatchFullGrant,
  capabilitiesMatchRingCookieGrant,
  isPrivKeysRequested,
  KEYED_CAPABILITIES,
  PRIV_KEYS_SCOPE,
  PRIV_KEYS_SCOPE_DECLINED,
  RING_COOKIE_CAPABILITIES,
} from './app';
import { getHomeserver } from './network';

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

describe('scoped encryption keys in the grant request', () => {
  it('asks for e on the Shop private tree only, keeping every existing scope', () => {
    expect(PRIV_KEYS_SCOPE).toBe('/priv/pubky.app/marketplace/:rwe');
    expect(KEYED_CAPABILITIES).toBe(`${CAPABILITIES},${PRIV_KEYS_SCOPE}`);
    const withE = KEYED_CAPABILITIES.split(',').filter((entry) => entry.split(':')[1]?.includes('e'));
    expect(withE).toEqual([PRIV_KEYS_SCOPE]);
  });

  it('keeps the Ring cookie set free of e: a cookie session cannot carry keys', () => {
    expect(RING_COOKIE_CAPABILITIES).not.toContain(':rwe');
    expect(RING_COOKIE_CAPABILITIES.split(',').every((entry) => !entry.split(':')[1]?.includes('e'))).toBe(true);
  });

  describe('capabilitiesMatchFullGrant', () => {
    it('accepts a session approved without keys, with keys, and with e declined', () => {
      expect(capabilitiesMatchFullGrant(CAPABILITIES.split(','))).toBe(true);
      expect(capabilitiesMatchFullGrant(KEYED_CAPABILITIES.split(','))).toBe(true);
      expect(capabilitiesMatchFullGrant([...CAPABILITIES.split(','), PRIV_KEYS_SCOPE_DECLINED])).toBe(true);
      expect(capabilitiesMatchFullGrant([...KEYED_CAPABILITIES.split(',')].reverse())).toBe(true);
    });

    it('still refuses a grant that lacks a Shop scope, adds another e scope, or widens e', () => {
      expect(capabilitiesMatchFullGrant(KEYED_CAPABILITIES.split(',').slice(1))).toBe(false);
      expect(capabilitiesMatchFullGrant([...CAPABILITIES.split(','), '/priv/pubky.app/:rwe'])).toBe(false);
      expect(capabilitiesMatchFullGrant([...CAPABILITIES.split(','), '/priv/pubky.app/marketplace/:e'])).toBe(false);
      expect(capabilitiesMatchFullGrant([...KEYED_CAPABILITIES.split(','), '/pub/other/:rw'])).toBe(false);
    });
  });

  describe('isPrivKeysRequested', () => {
    beforeEach(() => resetRuntimeConfigForTests());
    afterEach(() => {
      delete process.env[PUBKY_RUNTIME_ENV_NAMES.privEncryptionKeys];
      delete process.env[PUBKY_RUNTIME_ENV_NAMES.privEncryptionKeysHomeservers];
      resetRuntimeConfigForTests();
    });

    const HOMESERVER = getHomeserver();
    const listed = () => JSON.stringify([HOMESERVER]);
    const unlisted = () => JSON.stringify(['another-homeserver-key']);

    it('is off by default', () => {
      expect(isPrivKeysRequested()).toBe(false);
    });

    it('needs the switch and the deploy homeserver on the list', () => {
      process.env[PUBKY_RUNTIME_ENV_NAMES.privEncryptionKeys] = 'true';
      expect(isPrivKeysRequested()).toBe(false);

      resetRuntimeConfigForTests();
      process.env[PUBKY_RUNTIME_ENV_NAMES.privEncryptionKeys] = 'true';
      process.env[PUBKY_RUNTIME_ENV_NAMES.privEncryptionKeysHomeservers] = unlisted();
      expect(isPrivKeysRequested()).toBe(false);

      resetRuntimeConfigForTests();
      process.env[PUBKY_RUNTIME_ENV_NAMES.privEncryptionKeys] = 'true';
      process.env[PUBKY_RUNTIME_ENV_NAMES.privEncryptionKeysHomeservers] = listed();
      expect(isPrivKeysRequested()).toBe(true);
    });

    it('stays off when the list names the homeserver but the switch is off', () => {
      process.env[PUBKY_RUNTIME_ENV_NAMES.privEncryptionKeysHomeservers] = listed();
      expect(isPrivKeysRequested()).toBe(false);

      resetRuntimeConfigForTests();
      process.env[PUBKY_RUNTIME_ENV_NAMES.privEncryptionKeys] = 'false';
      process.env[PUBKY_RUNTIME_ENV_NAMES.privEncryptionKeysHomeservers] = listed();
      expect(isPrivKeysRequested()).toBe(false);
    });
  });
});
