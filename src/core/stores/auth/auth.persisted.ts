import { createJSONStorage } from 'zustand/middleware';
import { AUTH_PERSIST_KEY } from '@/stores/persistedKeys';

type PersistedAuthState = {
  currentUserPubky?: unknown;
  sessionExport?: unknown;
};

export type PersistedAuthIdentity = {
  pubky: string | null;
  present: boolean;
};

const EMPTY_PERSISTED_AUTH_IDENTITY: PersistedAuthIdentity = { pubky: null, present: false };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Parse a zustand persist JSON blob (`{ state, version }`) for the identity
 * that last wrote `AUTH_PERSIST_KEY`. Used both for lock-time re-reads and
 * for the persist `setItem` owner fence.
 */
export function parsePersistedAuthIdentityFromRaw(raw: string | null | undefined): PersistedAuthIdentity {
  if (!raw) return EMPTY_PERSISTED_AUTH_IDENTITY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY_PERSISTED_AUTH_IDENTITY;
    const state = (parsed as { state?: unknown }).state;
    if (!state || typeof state !== 'object') return EMPTY_PERSISTED_AUTH_IDENTITY;

    const authState = state as PersistedAuthState;
    const pubky = isNonEmptyString(authState.currentUserPubky) ? authState.currentUserPubky : null;
    return {
      pubky,
      present: isNonEmptyString(authState.sessionExport) || pubky !== null,
    };
  } catch {
    return EMPTY_PERSISTED_AUTH_IDENTITY;
  }
}

/**
 * Cross-tab source of truth for who last wrote `AUTH_PERSIST_KEY`.
 * Zustand persist does not sync across tabs; the live store in this tab can
 * still show A after Tab B's `init()` overwrote the blob with B.
 * Read this fresh inside the auth-finalization lock.
 */
export function readPersistedAuthIdentity(): PersistedAuthIdentity {
  try {
    return parsePersistedAuthIdentityFromRaw(globalThis.localStorage?.getItem(AUTH_PERSIST_KEY));
  } catch {
    return EMPTY_PERSISTED_AUTH_IDENTITY;
  }
}

export function readPersistedAuthPubky(): string | null {
  return readPersistedAuthIdentity().pubky;
}

export function hasPersistedAuthIdentity(): boolean {
  return readPersistedAuthIdentity().present;
}

/** The BrowserSessionStore record id a signed-in grant session (any tab) points at, if one is persisted. */
export function readPersistedGrantSessionRecordId(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(AUTH_PERSIST_KEY);
    if (!raw) return null;
    const state = (JSON.parse(raw) as { state?: { grantSessionRecordId?: unknown } }).state;
    return isNonEmptyString(state?.grantSessionRecordId) ? state.grantSessionRecordId : null;
  } catch {
    return null;
  }
}

/**
 * Drop the persist blob so a later `init` of a different pubky is not
 * treated as a foreign clobber. Only call this inside the finalization lock
 * after `shouldAbortIdentityPersist` has allowed the replace.
 */
export function clearPersistedAuthIdentity(): void {
  try {
    globalThis.localStorage?.removeItem(AUTH_PERSIST_KEY);
  } catch {
    // Storage unavailable (private mode) — nothing could have persisted.
  }
}

/**
 * A persist write that would replace a non-empty blob pubky with a
 * different non-empty pubky is a cross-tab clobber (Tab A `setIsLoggingOut`
 * / `setIsRestoringSession` after Tab B already owns `AUTH_PERSIST_KEY`).
 * Empty/reset (incoming null) and first write (existing null) are allowed.
 * Identity switch must `clearPersistedAuthIdentity()` first.
 */
export function shouldRefuseForeignAuthPersistWrite(
  existingPubky: string | null,
  incomingPubky: string | null,
): boolean {
  return existingPubky !== null && incomingPubky !== null && existingPubky !== incomingPubky;
}

type PersistedAuthSession = {
  /** Identity of the persisted session: account, Ring cookie export and Bitkit grant record. */
  key: string;
  pubky: string | null;
  present: boolean;
};

const NO_PERSISTED_SESSION: PersistedAuthSession = { key: '[null,null,null]', pubky: null, present: false };

function persistedAuthSessionFromRaw(raw: string | null | undefined): PersistedAuthSession {
  if (!raw) return NO_PERSISTED_SESSION;
  try {
    const state = (JSON.parse(raw) as { state?: PersistedAuthState & { grantSessionRecordId?: unknown } }).state;
    if (!state || typeof state !== 'object') return NO_PERSISTED_SESSION;
    const pubky = isNonEmptyString(state.currentUserPubky) ? state.currentUserPubky : null;
    const sessionExport = isNonEmptyString(state.sessionExport) ? state.sessionExport : null;
    const grantRecordId = isNonEmptyString(state.grantSessionRecordId) ? state.grantSessionRecordId : null;
    return {
      key: JSON.stringify([pubky, sessionExport, grantRecordId]),
      pubky,
      present: pubky !== null || sessionExport !== null || grantRecordId !== null,
    };
  } catch {
    return NO_PERSISTED_SESSION;
  }
}

/**
 * Compare-before-write for `AUTH_PERSIST_KEY`. `ownedKey` is the session this
 * tab last read (hydration) or wrote. A write that changes the stored session
 * is allowed only when:
 *  - the stored session is still the one this tab owns, or
 *  - the write carries a session this tab has just established (a sign-in or
 *    restore `init`, which runs under the auth finalization lock) and the slot
 *    holds nothing or the same account.
 * Everything else — a stale tab's flag update, reset or sign-out — would
 * overwrite or clear a newer session another tab saved, and no-ops. A
 * different account is never overwritten; identity switch clears first.
 */
export function mayWriteAuthPersist(existingRaw: string | null, incomingRaw: string, ownedKey: string): boolean {
  const existing = persistedAuthSessionFromRaw(existingRaw);
  const incoming = persistedAuthSessionFromRaw(incomingRaw);
  if (existing.key === incoming.key) return true;
  if (shouldRefuseForeignAuthPersistWrite(existing.pubky, incoming.pubky)) return false;
  if (existing.key === ownedKey) return true;
  const establishesNewSession = incoming.present && incoming.key !== ownedKey;
  return establishesNewSession && (!existing.present || existing.pubky === incoming.pubky);
}

/**
 * Zustand persist storage for the auth store, fenced by
 * {@link mayWriteAuthPersist}: `localStorage` is shared by every tab while
 * each tab's store is its own, and zustand persists the whole partial state
 * on every `set()`. Web Locks serialize wipe/persist; this fence covers every
 * other write, including a signed-out tab's UI flags. `removeItem` is not
 * fenced: zustand calls it only from `persist.clearStorage()`, which nothing
 * calls; removals go through {@link clearPersistedAuthIdentity} under the lock.
 */
export function createOwnerGuardedAuthJSONStorage() {
  let ownedKey = NO_PERSISTED_SESSION.key;
  return createJSONStorage(() => {
    const storage = globalThis.localStorage;
    if (!storage) {
      throw new Error('localStorage unavailable');
    }
    return {
      getItem: (name: string) => {
        const raw = storage.getItem(name);
        if (name === AUTH_PERSIST_KEY) ownedKey = persistedAuthSessionFromRaw(raw).key;
        return raw;
      },
      setItem: (name: string, value: string) => {
        if (name !== AUTH_PERSIST_KEY) {
          storage.setItem(name, value);
          return;
        }
        if (!mayWriteAuthPersist(storage.getItem(name), value, ownedKey)) return;
        storage.setItem(name, value);
        ownedKey = persistedAuthSessionFromRaw(value).key;
      },
      removeItem: (name: string) => storage.removeItem(name),
    };
  });
}
