import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME } from '@/config/database';
import { isAppError } from '@/libs/error/error';
import {
  deleteWrappingKeyStore,
  dropCachedWrappingKeyForTests,
  getOrCreateWrappingKey,
  resetMessagingKeyringForTests,
} from './messaging-keyring';

const KEYRING_DB_NAME = `${DB_NAME}-messaging-keyring`;
const KEYRING_STORE_NAME = 'wrapping-key';
const WRAPPING_KEY_RECORD_ID = 'wrapping-key';

/** Writes a record directly into the keyring store, as a racing second tab would. */
async function seedKeyringStore(key: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(KEYRING_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEYRING_STORE_NAME)) {
        request.result.createObjectStore(KEYRING_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open the keyring database'));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(KEYRING_STORE_NAME, 'readwrite');
      transaction.objectStore(KEYRING_STORE_NAME).put(key, WRAPPING_KEY_RECORD_ID);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Failed to seed the keyring store'));
    });
  } finally {
    db.close();
  }
}

describe('messaging keyring (wrapping-key custody)', () => {
  beforeEach(async () => {
    await resetMessagingKeyringForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('generates a non-extractable AES-GCM-256 key with encrypt/decrypt usages', async () => {
    const key = await getOrCreateWrappingKey();
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));
  });

  it('caches the key in memory for the session', async () => {
    const first = await getOrCreateWrappingKey();
    const second = await getOrCreateWrappingKey();
    expect(second).toBe(first);
  });

  it('persists the key so a cache drop (reload) reloads an equivalent key', async () => {
    const first = await getOrCreateWrappingKey();
    dropCachedWrappingKeyForTests();
    const reloaded = await getOrCreateWrappingKey();
    // Same persisted key material: data wrapped by the first key must unwrap
    // under the reloaded one.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, first, new Uint8Array([9, 8, 7]));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, reloaded, ciphertext);
    expect([...new Uint8Array(plaintext)]).toEqual([9, 8, 7]);
  });

  it('deletes the persisted key (sign-out wipe): the next load generates a fresh one', async () => {
    const first = await getOrCreateWrappingKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, first, new Uint8Array([1]));
    await deleteWrappingKeyStore();
    const fresh = await getOrCreateWrappingKey();
    expect(fresh).not.toBe(first);
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, fresh, ciphertext)).rejects.toThrow();
  });

  it('single-flights concurrent first-use callers: one key generated, both callers get it', async () => {
    const generateSpy = vi.spyOn(globalThis.crypto.subtle, 'generateKey');
    const [first, second] = await Promise.all([getOrCreateWrappingKey(), getOrCreateWrappingKey()]);
    expect(second).toBe(first);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    generateSpy.mockRestore();
  });

  it('adopts a concurrently persisted key (cross-tab create-race loser) instead of its own', async () => {
    // Another tab wins the create race: its key lands in the store while THIS
    // caller is generating its own (after its read found the store empty).
    // The `add` must hit ConstraintError and the caller must adopt the stored
    // key — persisting its own would orphan rows wrapped under the winner.
    const foreignKey = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const realGenerateKey = globalThis.crypto.subtle.generateKey.bind(globalThis.crypto.subtle);
    let seeded = false;
    const generateSpy = vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockImplementation(((
      algorithm: AlgorithmIdentifier,
      extractable: boolean,
      keyUsages: KeyUsage[],
    ) => {
      const generated = realGenerateKey(algorithm, extractable, keyUsages) as Promise<CryptoKey>;
      if (!seeded) {
        seeded = true;
        return generated.then(async (key) => {
          await seedKeyringStore(foreignKey);
          return key;
        });
      }
      return generated;
    }) as typeof globalThis.crypto.subtle.generateKey);

    const adopted = await getOrCreateWrappingKey();
    expect(generateSpy).toHaveBeenCalledTimes(1);
    generateSpy.mockRestore();

    // The returned key must be the foreign (stored) key: data wrapped under
    // it unwraps, and a reload re-reads the same stored key.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, foreignKey, new Uint8Array([5, 4, 3]));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, adopted, ciphertext);
    expect([...new Uint8Array(plaintext)]).toEqual([5, 4, 3]);

    dropCachedWrappingKeyForTests();
    const reloaded = await getOrCreateWrappingKey();
    const reloadedPlaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, reloaded, ciphertext);
    expect([...new Uint8Array(reloadedPlaintext)]).toEqual([5, 4, 3]);
  });

  it('adopts the stored key when the add loses the create race (ConstraintError)', async () => {
    // Force the loser path precisely: the winning tab's key is ALREADY in the
    // store, but this caller's read is doctored to look empty, so it proceeds
    // to `add` — which must hit ConstraintError, after which the caller
    // re-reads and adopts the stored key instead of its own.
    const foreignKey = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await seedKeyringStore(foreignKey);

    const realGet = IDBObjectStore.prototype.get;
    let doctored = false;
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['get']>
    ) {
      const request = realGet.apply(this, args);
      if (!doctored && this.name === KEYRING_STORE_NAME) {
        doctored = true;
        // Hide the seeded record from THIS request only: fake-indexeddb
        // assigns `result` internally, so swallow the write and always read
        // back undefined (an empty store, as the racing loser saw it).
        Object.defineProperty(request, 'result', {
          get: () => undefined,
          set: () => {},
          configurable: true,
        });
      }
      return request;
    });

    const addSpy = vi.spyOn(IDBObjectStore.prototype, 'add');
    const adopted = await getOrCreateWrappingKey();
    getSpy.mockRestore();
    // The doctored (empty) read forced the create path: `add` ran, hit
    // ConstraintError, and the caller recovered via the re-read.
    expect(addSpy).toHaveBeenCalledTimes(1);
    addSpy.mockRestore();

    // Data wrapped under the winning key unwraps under the adopted key —
    // proving the caller never persisted (or kept) its own generated key.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, foreignKey, new Uint8Array([2, 1]));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, adopted, ciphertext);
    expect([...new Uint8Array(plaintext)]).toEqual([2, 1]);
  });

  it('replaces an unusable stored record with a fresh key instead of bricking init', async () => {
    // A corrupted keyring record (anything that is not a usable AES-GCM
    // CryptoKey) can never unwrap a single row; init must heal it in place —
    // replacing the record inside the same transaction — not fail forever.
    await seedKeyringStore({ corrupted: 'not-a-crypto-key' });

    const healed = await getOrCreateWrappingKey();
    expect(healed.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(healed.extractable).toBe(false);
    expect(healed.usages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));

    // Exactly one key record, the fresh key (the dead one is gone), next to
    // the fresh epoch minted with it.
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = indexedDB.open(KEYRING_DB_NAME, 1);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(KEYRING_STORE_NAME, 'readonly');
        const getAllRequest = transaction.objectStore(KEYRING_STORE_NAME).getAll();
        getAllRequest.onsuccess = () => resolve(getAllRequest.result);
        getAllRequest.onerror = () => reject(getAllRequest.error ?? new Error('Failed to inspect the keyring store'));
        transaction.oncomplete = () => db.close();
      };
      request.onerror = () => reject(request.error ?? new Error('Failed to open the keyring database'));
    });
    expect(records.filter((record) => typeof record !== 'string')).toHaveLength(1);
    expect(records.filter((record) => typeof record === 'string')).toHaveLength(1);

    // A reload (cache drop) adopts the healed key: data wrapped now unwraps.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, healed, new Uint8Array([6, 6, 6]));
    dropCachedWrappingKeyForTests();
    const reloaded = await getOrCreateWrappingKey();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, reloaded, ciphertext);
    expect([...new Uint8Array(plaintext)]).toEqual([6, 6, 6]);
  });

  it('fails closed (AppError, never plaintext) when crypto.subtle is unavailable', async () => {
    const { subtle: _subtle, ...rest } = globalThis.crypto;
    vi.stubGlobal('crypto', rest);
    await expect(getOrCreateWrappingKey()).rejects.toSatisfy(
      (error) => isAppError(error) && /never falls back to plaintext/.test(error.message),
    );
  });

  it('fails closed when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(getOrCreateWrappingKey()).rejects.toSatisfy(
      (error) => isAppError(error) && /nowhere to persist/.test(error.message),
    );
  });
});
