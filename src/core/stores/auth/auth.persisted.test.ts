import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_PERSIST_KEY } from '../persistedKeys';
import {
  clearPersistedAuthIdentity,
  createOwnerGuardedAuthJSONStorage,
  hasPersistedAuthIdentity,
  readPersistedAuthIdentity,
  readPersistedAuthPubky,
  shouldRefuseForeignAuthPersistWrite,
} from './auth.persisted';

const ACCOUNT_A = '5a1diz4pghi47ywdfyfzpit5f3bdomzt4pugpbmq4rngdd4iub4y';
const ACCOUNT_B = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo';

function persistBlob(pubky: string | null, sessionExport: string | null = 'export') {
  return JSON.stringify({
    state: {
      currentUserPubky: pubky,
      sessionExport,
      hasProfile: pubky ? true : null,
      hasHydrated: false,
    },
    version: 0,
  });
}

describe('readPersistedAuthIdentity', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns empty when AUTH_PERSIST_KEY is missing', () => {
    expect(readPersistedAuthIdentity()).toEqual({ pubky: null, present: false });
    expect(hasPersistedAuthIdentity()).toBe(false);
    expect(readPersistedAuthPubky()).toBeNull();
  });

  it('reads currentUserPubky from the zustand persist blob', () => {
    window.localStorage.setItem(AUTH_PERSIST_KEY, persistBlob(ACCOUNT_B, 'account-b-session-export'));
    expect(readPersistedAuthPubky()).toBe(ACCOUNT_B);
    expect(hasPersistedAuthIdentity()).toBe(true);
  });

  it('treats sessionExport-only blobs as present without a pubky', () => {
    window.localStorage.setItem(
      AUTH_PERSIST_KEY,
      JSON.stringify({ state: { sessionExport: 'export-only', currentUserPubky: null }, version: 0 }),
    );
    expect(readPersistedAuthIdentity()).toEqual({ pubky: null, present: true });
  });

  it('returns empty on malformed JSON', () => {
    window.localStorage.setItem(AUTH_PERSIST_KEY, '{not-json');
    expect(readPersistedAuthIdentity()).toEqual({ pubky: null, present: false });
  });

  it('clearPersistedAuthIdentity drops AUTH_PERSIST_KEY', () => {
    window.localStorage.setItem(AUTH_PERSIST_KEY, persistBlob(ACCOUNT_A));
    clearPersistedAuthIdentity();
    expect(readPersistedAuthIdentity()).toEqual({ pubky: null, present: false });
  });
});

describe('owner-guarded AUTH_PERSIST_KEY writes', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('refuses a foreign non-empty overwrite and allows reset or first write', () => {
    expect(shouldRefuseForeignAuthPersistWrite(ACCOUNT_A, ACCOUNT_B)).toBe(true);
    expect(shouldRefuseForeignAuthPersistWrite(ACCOUNT_A, ACCOUNT_A)).toBe(false);
    expect(shouldRefuseForeignAuthPersistWrite(ACCOUNT_A, null)).toBe(false);
    expect(shouldRefuseForeignAuthPersistWrite(null, ACCOUNT_B)).toBe(false);
  });

  it('setItem no-ops over a different pubky, and a writer that never saw a session cannot clear it', () => {
    const storage = createOwnerGuardedAuthJSONStorage();
    expect(storage).toBeDefined();
    window.localStorage.setItem(AUTH_PERSIST_KEY, persistBlob(ACCOUNT_A, 'account-a-session-export'));

    storage!.setItem(AUTH_PERSIST_KEY, {
      state: {
        currentUserPubky: ACCOUNT_B,
        sessionExport: 'account-b-session-export',
        hasProfile: true,
        hasHydrated: false,
      },
      version: 0,
    });
    expect(readPersistedAuthPubky()).toBe(ACCOUNT_A);

    storage!.setItem(AUTH_PERSIST_KEY, {
      state: { currentUserPubky: null, sessionExport: null, hasProfile: null, hasHydrated: false },
      version: 0,
    });
    expect(readPersistedAuthPubky()).toBe(ACCOUNT_A);

    clearPersistedAuthIdentity();
    storage!.setItem(AUTH_PERSIST_KEY, {
      state: {
        currentUserPubky: ACCOUNT_B,
        sessionExport: 'account-b-session-export',
        hasProfile: true,
        hasHydrated: false,
      },
      version: 0,
    });
    expect(readPersistedAuthPubky()).toBe(ACCOUNT_B);
  });
});
