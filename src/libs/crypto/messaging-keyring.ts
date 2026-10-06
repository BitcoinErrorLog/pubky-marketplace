/**
 * Custody for the messaging at-rest wrapping key.
 *
 * A single AES-GCM-256 CryptoKey, generated on first use as
 * NON-EXTRACTABLE (the raw key bytes can never leave WebCrypto into JS),
 * persisted in its own tiny IndexedDB database — separate from the main
 * Dexie database so this module stays free of database-layer cycles
 * (the main database's migrations depend on this key). Same design as the
 * sibling product's proven WebKeyStore, adapted to this repo's layering:
 * pure AEAD helpers live in `./secret-wrapping`; services compose both.
 *
 * FAIL CLOSED, always: if WebCrypto or IndexedDB is unavailable, every
 * operation throws an `Err.database` AppError — there is NO plaintext
 * fallback. Losing this key (profile wipe without the database, targeted
 * deletion) makes every wrapped row unrecoverable; the service layer
 * treats such rows as lost and the user re-enables messaging.
 */

import { DB_NAME } from '@/config/database';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';

const KEYRING_DB_NAME = `${DB_NAME}-messaging-keyring`;
const KEYRING_DB_VERSION = 1;
const KEYRING_STORE_NAME = 'wrapping-key';
const WRAPPING_KEY_RECORD_ID = 'wrapping-key';
/**
 * Random id stored next to the key and replaced in the same transaction
 * whenever a new key record is stored (created or healed). Deleting the
 * keyring deletes it too, so it identifies one persisted key: a tab whose
 * cached epoch no longer matches holds a key that was cleared or replaced.
 */
const KEY_EPOCH_RECORD_ID = 'wrapping-key-epoch';

/**
 * Web Lock every tab takes around each read or write of key-wrapped
 * messaging state: shared by readers and writers, exclusive for teardown
 * (see {@link withCurrentWrappingKey} and {@link tearDownMessagingKeys}).
 */
const KEY_FENCE_LOCK = 'pubky-messaging-keys';
/**
 * How long sign-out waits for in-flight wrapped reads and writes before it
 * returns. It never clears without the fence: the teardown stays queued and
 * runs when they finish, or on the next load (see {@link tearDownMessagingKeys}).
 */
const TEARDOWN_LOCK_WAIT_MS = 10_000;
/** `localStorage` flag set before a teardown is queued and removed once it has run. */
const TEARDOWN_PENDING_STORAGE_KEY = 'pubky-messaging-keys-teardown-pending';
let teardownLockWaitMs = TEARDOWN_LOCK_WAIT_MS;
const KEYRING_CHANGED_REASON = 'messaging_keyring_changed';

let cachedKey: CryptoKey | null = null;
let cachedEpoch: string | null = null;
let keyringDbPromise: Promise<IDBDatabase> | null = null;
let wrappingKeyPromise: Promise<CryptoKey> | null = null;

/**
 * Fail-closed precondition for every custody operation: AES-GCM wrapping
 * needs `crypto.subtle`, IVs need a CSPRNG, and persistence needs IDB.
 * Throws an AppError (never returns a degraded mode) when any is missing.
 */
function assertMessagingCryptoAvailable(operation: string): void {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.subtle !== 'object' || crypto.subtle === null) {
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'WebCrypto (crypto.subtle) is unavailable; messaging key custody cannot operate and never falls back to plaintext.',
      { service: ErrorService.Local, operation },
    );
  }
  if (typeof crypto.getRandomValues !== 'function') {
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'crypto.getRandomValues is unavailable; messaging key custody cannot operate without a CSPRNG.',
      { service: ErrorService.Local, operation },
    );
  }
  if (typeof indexedDB === 'undefined') {
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'IndexedDB is unavailable; the messaging wrapping key has nowhere to persist.',
      { service: ErrorService.Local, operation },
    );
  }
}

function openKeyringDb(): Promise<IDBDatabase> {
  keyringDbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(KEYRING_DB_NAME, KEYRING_DB_VERSION);
    request.onerror = () => {
      // A failed open must stay retryable on the next call.
      keyringDbPromise = null;
      reject(request.error ?? new Error('Failed to open the messaging keyring database'));
    };
    request.onsuccess = () => {
      const connection = request.result;
      // Another tab deleting the keyring must not wait for this tab to
      // close. What this tab cached is then checked against the epoch on
      // its next fenced use ({@link withCurrentWrappingKey}).
      connection.onversionchange = () => {
        connection.close();
        keyringDbPromise = null;
      };
      resolve(connection);
    };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEYRING_STORE_NAME)) {
        request.result.createObjectStore(KEYRING_STORE_NAME);
      }
    };
  });
  return keyringDbPromise;
}

function isUsableWrappingKey(candidate: unknown): candidate is CryptoKey {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    (candidate as CryptoKey).type === 'secret' &&
    (candidate as CryptoKey).algorithm?.name === 'AES-GCM' &&
    Array.isArray((candidate as CryptoKey).usages) &&
    (candidate as CryptoKey).usages.includes('encrypt') &&
    (candidate as CryptoKey).usages.includes('decrypt')
  );
}

/**
 * Loads the persisted wrapping key, generating and persisting a fresh
 * NON-EXTRACTABLE AES-GCM-256 key on first use. The resolved key is cached
 * in memory for the session (one IDB read per load, zero per wrap).
 *
 * Creation is race-proof in both directions: the whole load-or-create is
 * single-flighted behind one module-level promise (two concurrent in-tab
 * first-use callers share it, so exactly one key is ever generated per
 * tab), and the read + write run inside ONE `readwrite` transaction as
 * get-then-`add` — a `ConstraintError` means another tab won the create
 * race, in which case this caller re-reads and adopts the STORED key
 * (persisting its own would orphan every row wrapped under the winner).
 * When the platform offers Web Locks, the create path additionally runs
 * inside a named lock for hard cross-tab exclusion.
 *
 * Throws (fail closed) when WebCrypto/IDB is unavailable or persistence
 * fails — callers must never see a "keyless" mode.
 */
export async function getOrCreateWrappingKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  if (!wrappingKeyPromise) {
    const pending = loadOrCreateWrappingKey().then(({ key, epoch }) => {
      cachedKey = key;
      cachedEpoch = epoch;
      return key;
    });
    // A failed load stays retryable on the next call — but only clear the
    // slot if no newer attempt has already taken it.
    pending.catch(() => {
      if (wrappingKeyPromise === pending) wrappingKeyPromise = null;
    });
    wrappingKeyPromise = pending;
  }
  return wrappingKeyPromise;
}

async function loadOrCreateWrappingKey(): Promise<{ key: CryptoKey; epoch: string }> {
  assertMessagingCryptoAvailable('getOrCreateWrappingKey');
  const load = () => readOrAddWrappingKey();
  try {
    // Hard cross-tab exclusion when available: two tabs racing first use
    // (e.g. the boot sweep) serialize on this lock, so the loser's read
    // below sees the winner's key and epoch. Falls back cleanly to the
    // get-then-add guard when Web Locks is unavailable.
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks && typeof locks.request === 'function') {
      return await locks.request(KEYRING_DB_NAME, load);
    }
    return await load();
  } catch (error) {
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'Failed to load or create the messaging wrapping key; refusing to operate without it.',
      { service: ErrorService.Local, operation: 'getOrCreateWrappingKey', cause: error },
    );
  }
}

/**
 * The read-modify-write behind {@link getOrCreateWrappingKey}: get-then-`add`
 * (never `put`) inside ONE `readwrite` transaction, so a concurrent creator
 * in another tab surfaces as a `ConstraintError` instead of silently
 * overwriting the stored key. The unusable-record heal path deletes the dead
 * record first and still `add`s, keeping that same adoption guard. The fresh
 * key is generated BEFORE the transaction opens — an awaited WebCrypto call
 * between two requests would let the transaction auto-commit and close.
 *
 * The key's epoch is read and written in the same transaction: a stored key
 * without one (stored before epochs existed) gets one, and every newly
 * stored key record, created or healed, gets a fresh one, so an epoch never
 * outlives the key record it was minted for.
 */
function readOrAddWrappingKey(): Promise<{ key: CryptoKey; epoch: string }> {
  return (async () => {
    const db = await openKeyringDb();
    const generated = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    return new Promise<{ key: CryptoKey; epoch: string }>((resolve, reject) => {
      const transaction = db.transaction(KEYRING_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(KEYRING_STORE_NAME);
      let result: { key: CryptoKey; epoch: string } | null = null;
      transaction.oncomplete = () => {
        if (result) resolve(result);
        else reject(new Error('Messaging keyring transaction completed without a key'));
      };
      transaction.onabort = () => reject(transaction.error ?? new Error('Messaging keyring transaction aborted'));

      const adoptStored = () => {
        const keyRequest = store.get(WRAPPING_KEY_RECORD_ID);
        const epochRequest = store.get(KEY_EPOCH_RECORD_ID);
        epochRequest.onsuccess = () => {
          if (!isUsableWrappingKey(keyRequest.result)) {
            reject(new Error('Messaging keyring create race lost, but the winning record is unusable'));
            return;
          }
          const epoch = typeof epochRequest.result === 'string' ? epochRequest.result : crypto.randomUUID();
          if (epoch !== epochRequest.result) store.put(epoch, KEY_EPOCH_RECORD_ID);
          result = { key: keyRequest.result, epoch };
        };
      };

      const adoptExistingOrAdd = (existing: unknown, storedEpoch: unknown) => {
        if (isUsableWrappingKey(existing)) {
          const epoch = typeof storedEpoch === 'string' ? storedEpoch : crypto.randomUUID();
          if (epoch !== storedEpoch) store.put(epoch, KEY_EPOCH_RECORD_ID);
          result = { key: existing, epoch };
          return;
        }
        if (existing !== undefined) {
          // A record that is not a usable AES-GCM key can never unwrap
          // anything; replace it rather than failing every row read forever.
          // `delete` then `add` (NOT `put`): clearing the dead record first
          // keeps the cross-tab adoption guard below intact — a racing tab
          // whose `add` lands between our delete and our add still surfaces
          // as a ConstraintError, and we adopt its key instead of clobbering
          // it (which a blind `put` would do, orphaning its wrapped rows).
          Logger.warn('Messaging keyring held an unusable record; replacing it with a fresh wrapping key');
          store.delete(WRAPPING_KEY_RECORD_ID);
        }
        const addRequest = store.add(generated, WRAPPING_KEY_RECORD_ID);
        addRequest.onsuccess = () => {
          const epoch = crypto.randomUUID();
          store.put(epoch, KEY_EPOCH_RECORD_ID);
          result = { key: generated, epoch };
        };
        addRequest.onerror = (event) => {
          if (addRequest.error?.name !== 'ConstraintError') {
            reject(addRequest.error ?? new Error('Failed to persist the messaging wrapping key'));
            return;
          }
          // Another tab won the create race between our read and this add.
          // Keep the transaction alive (a request error aborts it by default)
          // and adopt the stored key and its epoch — NEVER persist ours.
          event.preventDefault();
          adoptStored();
        };
      };

      const getRequest = store.get(WRAPPING_KEY_RECORD_ID);
      const getEpochRequest = store.get(KEY_EPOCH_RECORD_ID);
      getEpochRequest.onsuccess = () => adoptExistingOrAdd(getRequest.result, getEpochRequest.result);
      getRequest.onerror = () => reject(getRequest.error ?? new Error('Messaging keyring read failed'));
      getEpochRequest.onerror = () => reject(getEpochRequest.error ?? new Error('Messaging keyring read failed'));
    });
  })();
}

/** The persisted key's epoch, read from the keyring itself; `null` when there is none (deleted or never created). */
function readPersistedKeyEpoch(): Promise<string | null> {
  return (async () => {
    const db = await openKeyringDb();
    return await new Promise<string | null>((resolve, reject) => {
      const request = db
        .transaction(KEYRING_STORE_NAME, 'readonly')
        .objectStore(KEYRING_STORE_NAME)
        .get(KEY_EPOCH_RECORD_ID);
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error('Messaging keyring epoch read failed'));
    });
  })();
}

/**
 * Deletes the wrapping key and its database. Best-effort: called from
 * `clearDatabase()` on sign-out/account switch, where every wrapped row is
 * being wiped anyway — a key that outlives its ciphertexts protects nothing,
 * so a deletion failure is logged, never fatal.
 */
export async function deleteWrappingKeyStore(): Promise<void> {
  cachedKey = null;
  cachedEpoch = null;
  wrappingKeyPromise = null;
  if (keyringDbPromise) {
    try {
      (await keyringDbPromise).close();
    } catch {
      // Closing is hygiene; deletion below is the operation that matters.
    }
    keyringDbPromise = null;
  }
  if (typeof indexedDB === 'undefined') return;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(KEYRING_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Failed to delete the messaging keyring database'));
      request.onblocked = () => resolve();
    });
  } catch (error) {
    Logger.warn('Could not delete the messaging keyring database', { error });
  }
}

/** True when an error means this tab's wrapping key was cleared or replaced by another tab. */
export function isMessagingKeyringChanged(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { context?: { reason?: unknown } }).context?.reason === KEYRING_CHANGED_REASON
  );
}

/**
 * Runs `run` with the persisted wrapping key while holding the key fence in
 * shared mode. Every read and write of key-wrapped messaging state goes
 * through here, and teardown takes the fence exclusively, so no teardown
 * can happen between the check below and the end of `run`.
 *
 * Holding the fence, the tab's cached key must still be the persisted one:
 * its epoch must equal the epoch stored with the key in the keyring, which
 * changes whenever a new key record is stored and disappears when the
 * keyring is deleted. Otherwise the cache is dropped and this throws, so a tab
 * never writes state under a key that was cleared or replaced, and never
 * mistakes rows it can no longer open for corrupt ones. The next call
 * loads the persisted key afresh.
 *
 * Without the Web Locks API this fails closed, unless `whenUnavailable` is
 * `'run'` (the boot wrap sweep, which runs where no other messaging reader
 * or writer can, since they all fail closed without it).
 *
 * `run` must not call this again: a shared request queued behind a waiting
 * teardown would wait on the fence this call holds.
 */
export async function withCurrentWrappingKey<T>(
  run: (key: CryptoKey) => Promise<T>,
  { whenUnavailable = 'refuse' }: { whenUnavailable?: 'refuse' | 'run' } = {},
): Promise<T> {
  const fenced = async () => {
    if (isMessagingKeyTeardownPending()) {
      Logger.warn('A sign-out is still clearing messaging keys; nothing was read or written', {
        reason: KEYRING_CHANGED_REASON,
      });
      throw Err.database(
        DatabaseErrorCode.WRITE_FAILED,
        'Private messages were reset in another tab. Reload to continue.',
        {
          service: ErrorService.Local,
          operation: 'withCurrentWrappingKey',
          context: { reason: KEYRING_CHANGED_REASON },
        },
      );
    }
    const key = await getOrCreateWrappingKey();
    const expected = cachedEpoch;
    const persisted = await readPersistedKeyEpoch();
    if (expected === null || persisted !== expected) {
      cachedKey = null;
      cachedEpoch = null;
      wrappingKeyPromise = null;
      Logger.warn('The messaging wrapping key was cleared or replaced in another tab; nothing was read or written', {
        reason: KEYRING_CHANGED_REASON,
      });
      throw Err.database(
        DatabaseErrorCode.WRITE_FAILED,
        'Private messages were reset in another tab. Reload to continue.',
        {
          service: ErrorService.Local,
          operation: 'withCurrentWrappingKey',
          context: { reason: KEYRING_CHANGED_REASON },
        },
      );
    }
    return await run(key);
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (typeof locks?.request !== 'function') {
    if (whenUnavailable === 'run') return await fenced();
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'Private messages are paused: this browser cannot keep your open tabs from sending at the same time.',
      { service: ErrorService.Local, operation: 'withCurrentWrappingKey', context: { reason: 'lock_unsupported' } },
    );
  }
  let granted = false;
  try {
    return await locks.request(KEY_FENCE_LOCK, { mode: 'shared' }, async () => {
      granted = true;
      return await fenced();
    });
  } catch (error) {
    if (granted) throw error;
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'Private messages are paused: this tab could not coordinate with your other tabs. Try again.',
      { service: ErrorService.Local, operation: 'withCurrentWrappingKey', context: { reason: 'lock_refused' } },
    );
  }
}

/**
 * Sign-out and identity teardown of key-wrapped messaging state: deletes the
 * wrapping key and its epoch, then runs `clearWrappedRows`, holding the key
 * fence exclusively. It never runs while any tab holds the fence: a writer
 * that is part-way through a fenced write, even one suspended for a long
 * time, finishes first, and its rows are then cleared with the rest. Web
 * Locks grants in order, so fenced requests made after this one wait behind
 * it.
 *
 * A pending flag is set in `localStorage` before the request is queued and
 * removed once the teardown has run. While it is set, every fenced read and
 * write refuses. Sign-out must not hang on another tab, so this returns after
 * {@link TEARDOWN_LOCK_WAIT_MS} with the request still queued; if this tab
 * closes before it is granted, {@link resumeMessagingKeyTeardown} completes it
 * on the next load. When the flag cannot be set, this waits for the teardown
 * to run.
 *
 * Without the Web Locks API no messaging reader or writer runs at all, so the
 * teardown runs directly. If the browser refuses the lock, nothing is
 * deleted: the flag stays set, every fenced operation keeps refusing, and the
 * next load tries again.
 */
export async function tearDownMessagingKeys(clearWrappedRows: () => Promise<void>): Promise<void> {
  const flagged = markTeardownPending();
  const teardown = async () => {
    await deleteWrappingKeyStore();
    await clearWrappedRows();
    clearTeardownPending();
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (typeof locks?.request !== 'function') {
    await teardown();
    return;
  }
  let granted = false;
  const done = locks
    .request(KEY_FENCE_LOCK, { mode: 'exclusive' }, async () => {
      granted = true;
      await teardown();
    })
    .catch((error: unknown) => {
      if (granted) throw error;
      Logger.warn('The messaging key lock was refused; messaging keys are cleared on a later load', {
        reason: 'teardown_lock_refused',
      });
    });
  if (!flagged) {
    await done;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    done.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), teardownLockWaitMs);
    }),
  ]);
  clearTimeout(timer);
  if (!finished) {
    Logger.warn('Another tab is still using messaging keys; they are cleared as soon as it finishes', {
      reason: 'teardown_waiting',
    });
    void done.catch(() => undefined);
  }
}

/** Completes a teardown a closed tab left pending; a no-op when none is. */
export async function resumeMessagingKeyTeardown(clearWrappedRows: () => Promise<void>): Promise<void> {
  if (!isMessagingKeyTeardownPending()) return;
  await tearDownMessagingKeys(clearWrappedRows);
}

/** True while a sign-out's teardown of messaging keys has not run yet. */
export function isMessagingKeyTeardownPending(): boolean {
  try {
    return window.localStorage.getItem(TEARDOWN_PENDING_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function markTeardownPending(): boolean {
  try {
    window.localStorage.setItem(TEARDOWN_PENDING_STORAGE_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

function clearTeardownPending(): void {
  try {
    window.localStorage.removeItem(TEARDOWN_PENDING_STORAGE_KEY);
  } catch {
    // Without localStorage the flag was never set.
  }
}

/** Test seam: shortens how long sign-out waits for other tabs. Never used in production. */
export function setTeardownLockWaitForTests(ms: number | null): void {
  teardownLockWaitMs = ms ?? TEARDOWN_LOCK_WAIT_MS;
}

/**
 * Test seam: drops the in-memory cache AND the persisted key, simulating a
 * lost wrapping key (profile wipe without the main database). Never used in
 * production — sign-out goes through {@link tearDownMessagingKeys}.
 */
export async function resetMessagingKeyringForTests(): Promise<void> {
  await deleteWrappingKeyStore();
}

/**
 * Test seam: drops ONLY the in-memory cache, simulating a browser reload
 * (the persisted key survives and must be reloaded). Never used in production.
 */
export function dropCachedWrappingKeyForTests(): void {
  cachedKey = null;
  cachedEpoch = null;
  wrappingKeyPromise = null;
}

/**
 * Test seam: closes this module's keyring connection and drops its cache,
 * simulating a closed tab, so another copy of the module can delete the
 * keyring. The persisted key stays. Never used in production.
 */
export async function closeWrappingKeyStoreForTests(): Promise<void> {
  cachedKey = null;
  cachedEpoch = null;
  wrappingKeyPromise = null;
  const pending = keyringDbPromise;
  keyringDbPromise = null;
  if (pending) (await pending).close();
}
