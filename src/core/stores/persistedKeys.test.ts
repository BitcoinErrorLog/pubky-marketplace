import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_STORAGE_MIGRATION_MARKER_KEY } from '@/libs/storage-namespace/storage-namespace';

const AUTH = JSON.stringify({ state: { currentUserPubky: 'o'.repeat(52) }, version: 0 });

describe('persisted store keys', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it('lives in the Shop namespace so the Shop and pubky.app can share an origin', async () => {
    const keys = await import('./persistedKeys');

    expect(keys.PERSISTED_STORE_KEYS.length).toBeGreaterThan(0);
    for (const key of keys.PERSISTED_STORE_KEYS) {
      expect(key.startsWith('shop-'), key).toBe(true);
    }
    expect(keys.AUTH_PERSIST_KEY).toBe('shop-auth-store');
    expect(new Set(keys.PERSISTED_STORE_KEYS).size).toBe(keys.PERSISTED_STORE_KEYS.length);
  });

  it("moves an existing Shop user's keys into the namespace before any store can hydrate", async () => {
    window.localStorage.setItem('auth-store', AUTH);
    window.localStorage.setItem('settings-storage', '{"state":{}}');
    window.localStorage.setItem('onboarding-storage', '{"state":{}}');

    await import('./persistedKeys');

    expect(window.localStorage.getItem('shop-auth-store')).toBe(AUTH);
    expect(window.localStorage.getItem('shop-settings-storage')).toBe('{"state":{}}');
    expect(window.localStorage.getItem('shop-onboarding-storage')).toBe('{"state":{}}');
    expect(window.localStorage.getItem('auth-store')).toBeNull();
    expect(window.localStorage.getItem('settings-storage')).toBeNull();
    expect(window.localStorage.getItem('onboarding-storage')).toBeNull();
    expect(window.localStorage.getItem(LOCAL_STORAGE_MIGRATION_MARKER_KEY)).not.toBeNull();
  });

  it('hydrates the auth store from the migrated key', async () => {
    window.localStorage.setItem('auth-store', AUTH);

    const { useAuthStore } = await import('@/stores/auth/auth.store');

    expect(useAuthStore.getState().currentUserPubky).toBe('o'.repeat(52));
  });

  it("migrates only once: keys the App writes afterwards stay the App's", async () => {
    window.localStorage.setItem('auth-store', AUTH);
    await import('./persistedKeys');
    window.localStorage.setItem('auth-store', 'app-identity');

    vi.resetModules();
    await import('./persistedKeys');

    expect(window.localStorage.getItem('auth-store')).toBe('app-identity');
    expect(window.localStorage.getItem('shop-auth-store')).toBe(AUTH);
  });

  it("does not touch another app's keys when the Shop is mounted under a base path", async () => {
    const { setBasePath } = await import('@/test-utils/base-path');
    setBasePath('/shop');
    try {
      window.localStorage.setItem('auth-store', 'app-identity');
      window.localStorage.setItem('settings-storage', 'app-settings');

      await import('./persistedKeys');

      expect(window.localStorage.getItem('auth-store')).toBe('app-identity');
      expect(window.localStorage.getItem('settings-storage')).toBe('app-settings');
      expect(window.localStorage.getItem('shop-auth-store')).toBeNull();
    } finally {
      setBasePath('');
    }
  });

  it('does not throw when browser storage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    try {
      await expect(import('./persistedKeys')).resolves.toBeDefined();
    } finally {
      getItem.mockRestore();
    }
  });
});
