import { beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyLocalStorage } from './migrate-legacy-local-storage';
import { LOCAL_STORAGE_MIGRATION_MARKER_KEY } from './storage-namespace';

const MAP = {
  keys: {
    'auth-store': 'shop-auth-store',
    'settings-storage': 'shop-settings-storage',
    'onboarding-storage': 'shop-onboarding-storage',
  },
  prefixes: { 'pubky-feature-discovery:': 'shop-pubky-feature-discovery:' },
};

const AUTH = JSON.stringify({ state: { currentUserPubky: 'o'.repeat(52) }, version: 0 });

describe('migrateLegacyLocalStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('moves every legacy key and prefixed key into the namespace and records the outcome', () => {
    window.localStorage.setItem('auth-store', AUTH);
    window.localStorage.setItem('settings-storage', '{"state":{"theme":"dark"}}');
    window.localStorage.setItem('pubky-feature-discovery:marketplace-promo-v1', 'dismissed');
    window.localStorage.setItem(`pubky-feature-discovery:${'o'.repeat(52)}:collections-nav-v1`, 'seen');

    const result = migrateLegacyLocalStorage(window.localStorage, MAP, { adopt: true, now: 7 });

    expect(result).toEqual({ status: 'migrated', moved: 4, alreadyDone: false });
    expect(window.localStorage.getItem('shop-auth-store')).toBe(AUTH);
    expect(window.localStorage.getItem('shop-settings-storage')).toBe('{"state":{"theme":"dark"}}');
    expect(window.localStorage.getItem('shop-pubky-feature-discovery:marketplace-promo-v1')).toBe('dismissed');
    expect(window.localStorage.getItem(`shop-pubky-feature-discovery:${'o'.repeat(52)}:collections-nav-v1`)).toBe(
      'seen',
    );
    expect(window.localStorage.getItem('auth-store')).toBeNull();
    expect(window.localStorage.getItem('settings-storage')).toBeNull();
    expect(window.localStorage.getItem('pubky-feature-discovery:marketplace-promo-v1')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_MIGRATION_MARKER_KEY) ?? '{}')).toEqual({
      status: 'migrated',
      at: 7,
    });
  });

  it('records that there was nothing to move so the Shop never adopts keys that appear later', () => {
    expect(migrateLegacyLocalStorage(window.localStorage, MAP, { adopt: true })).toEqual({
      status: 'nothing',
      moved: 0,
      alreadyDone: false,
    });

    // The App later runs on this origin and writes its own legacy-named keys.
    window.localStorage.setItem('auth-store', 'app-identity');
    const second = migrateLegacyLocalStorage(window.localStorage, MAP, { adopt: true });

    expect(second).toEqual({ status: 'nothing', moved: 0, alreadyDone: true });
    expect(window.localStorage.getItem('auth-store')).toBe('app-identity');
    expect(window.localStorage.getItem('shop-auth-store')).toBeNull();
  });

  it('is safe to run twice: the second run touches nothing', () => {
    window.localStorage.setItem('auth-store', AUTH);
    migrateLegacyLocalStorage(window.localStorage, MAP, { adopt: true });
    const afterFirst = JSON.stringify({ ...window.localStorage });

    const second = migrateLegacyLocalStorage(window.localStorage, MAP, { adopt: true });

    expect(second).toEqual({ status: 'migrated', moved: 0, alreadyDone: true });
    expect(JSON.stringify({ ...window.localStorage })).toBe(afterFirst);
  });

  it("leaves the host app alone when the legacy names are not the Shop's, and remembers the choice", () => {
    window.localStorage.setItem('auth-store', 'app-identity');
    window.localStorage.setItem('settings-storage', 'app-settings');

    expect(migrateLegacyLocalStorage(window.localStorage, MAP, { adopt: false })).toEqual({
      status: 'skipped',
      moved: 0,
      alreadyDone: false,
    });
    expect(window.localStorage.getItem('auth-store')).toBe('app-identity');
    expect(window.localStorage.getItem('settings-storage')).toBe('app-settings');
    expect(window.localStorage.getItem('shop-auth-store')).toBeNull();

    // Flipping the switch later must not start adopting the other app's entries.
    expect(migrateLegacyLocalStorage(window.localStorage, MAP, { adopt: true })).toEqual({
      status: 'skipped',
      moved: 0,
      alreadyDone: true,
    });
    expect(window.localStorage.getItem('auth-store')).toBe('app-identity');
  });

  it('never overwrites a namespaced entry with the legacy one, and drops the stale legacy entry', () => {
    window.localStorage.setItem('shop-auth-store', 'newer');
    window.localStorage.setItem('auth-store', 'stale');

    const result = migrateLegacyLocalStorage(window.localStorage, MAP, { adopt: true });

    expect(result.status).toBe('nothing');
    expect(window.localStorage.getItem('shop-auth-store')).toBe('newer');
    expect(window.localStorage.getItem('auth-store')).toBeNull();
  });

  it('recovers from a crash between copy and delete without duplicating or losing anything', () => {
    window.localStorage.setItem('auth-store', AUTH);
    window.localStorage.setItem('shop-auth-store', AUTH);

    const result = migrateLegacyLocalStorage(window.localStorage, MAP, { adopt: true });

    expect(result.status).toBe('nothing');
    expect(window.localStorage.getItem('shop-auth-store')).toBe(AUTH);
    expect(window.localStorage.getItem('auth-store')).toBeNull();
  });

  it('keeps unread legacy data and records no outcome when a write fails, then succeeds on retry', () => {
    window.localStorage.setItem('auth-store', AUTH);
    window.localStorage.setItem('settings-storage', 'settings');
    let failWrites = true;
    const flaky = {
      get length() {
        return window.localStorage.length;
      },
      key: (index: number) => window.localStorage.key(index),
      getItem: (key: string) => window.localStorage.getItem(key),
      removeItem: (key: string) => window.localStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        if (failWrites && key === 'shop-settings-storage') throw new DOMException('quota', 'QuotaExceededError');
        window.localStorage.setItem(key, value);
      },
    };

    const failed = migrateLegacyLocalStorage(flaky, MAP, { adopt: true });

    expect(failed.status).toBe('failed');
    expect(window.localStorage.getItem('settings-storage')).toBe('settings');
    expect(window.localStorage.getItem(LOCAL_STORAGE_MIGRATION_MARKER_KEY)).toBeNull();

    failWrites = false;
    const retried = migrateLegacyLocalStorage(flaky, MAP, { adopt: true });

    expect(retried.status).toBe('migrated');
    expect(window.localStorage.getItem('shop-auth-store')).toBe(AUTH);
    expect(window.localStorage.getItem('shop-settings-storage')).toBe('settings');
    expect(window.localStorage.getItem('settings-storage')).toBeNull();
    expect(window.localStorage.getItem(LOCAL_STORAGE_MIGRATION_MARKER_KEY)).not.toBeNull();
  });

  it('treats an unreadable marker as no outcome and migrates', () => {
    window.localStorage.setItem(LOCAL_STORAGE_MIGRATION_MARKER_KEY, '{not json');
    window.localStorage.setItem('auth-store', AUTH);

    expect(migrateLegacyLocalStorage(window.localStorage, MAP, { adopt: true }).status).toBe('migrated');
    expect(window.localStorage.getItem('shop-auth-store')).toBe(AUTH);
  });
});
