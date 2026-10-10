import Dexie, { type Table } from 'dexie';
import { DB_NAME } from '@/config/database';
import { getStorageAdoptLegacy } from '@/config/storage-namespace';
import { AppDatabase } from '@/database/franky/franky';
import { KEYRING_DB_VERSION, KEYRING_STORE_NAME, messagingKeyringDbName } from '@/libs/crypto/messaging-keyring';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import {
  DATABASE_MIGRATION_MARKER_KEY,
  LEGACY_DB_NAME,
  type MigrationMarker,
  type MigrationMarkerStatus,
  parseMigrationMarker,
} from '@/libs/storage-namespace/storage-namespace';

/**
 * One-time move of an existing Shop user's IndexedDB data into the Shop namespace:
 * the Dexie database `franky` becomes `shop-franky`, and its messaging keyring database
 * (the AES-GCM key that unwraps the key material and history stored in that database)
 * moves with it. See `@/libs/storage-namespace/storage-namespace` for why.
 *
 * Properties the caller relies on:
 *  - Nothing is deleted before everything is copied and checked: the keyring first (the
 *    database rows are useless without its key), then every table, then a per-table row
 *    count. A failure anywhere leaves the legacy databases untouched and throws, and the
 *    next load retries from the start.
 *  - Idempotent: copies use add-if-absent, so a retry after a crash between copy and
 *    delete, or a second tab, never duplicates rows and never overwrites newer data in the
 *    namespaced database. A recorded outcome ends every later call at once.
 *  - Cross-tab safe: the whole move runs under one exclusive Web Lock.
 *  - Only the Shop's own data moves: the legacy database must contain Shop-only tables,
 *    and the origin must be one whose legacy names are the Shop's (`getStorageAdoptLegacy`).
 *    On an origin shared with the App, `franky` is the App's database and is never read.
 *
 * The legacy database is opened with `AppDatabase.initialize()`, the same path the previous
 * build used, so an old schema is upgraded (or recreated) exactly as it would have been,
 * before its rows are copied.
 */

const MIGRATION_LOCK_NAME = 'shop-storage-migration';
const COPY_CHUNK_SIZE = 250;
const DELETE_BLOCKED_TIMEOUT_MS = 5_000;
const SHOP_ONLY_TABLE = 'commerce_shops';

export interface DatabaseMigrationOptions {
  legacyName?: string;
  targetName?: string;
  adopt?: boolean;
  now?: number;
}

export type DatabaseMigrationResult =
  | { status: MigrationMarkerStatus; alreadyDone: boolean; rows: number }
  | { status: 'unavailable'; alreadyDone: false; rows: 0 };

function failure(operation: string, message: string, cause?: unknown) {
  return Err.database(DatabaseErrorCode.INIT_FAILED, message, {
    service: ErrorService.Local,
    operation,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Blocked storage (private modes, policy) cannot hold the marker. The migration still runs
 * safely without one, since every copy is add-if-absent; it just re-checks on each load.
 */
function readMarker(): MigrationMarker | null {
  try {
    return parseMigrationMarker(window.localStorage.getItem(DATABASE_MIGRATION_MARKER_KEY));
  } catch {
    return null;
  }
}

function writeMarker(status: MigrationMarkerStatus, now: number): void {
  const marker: MigrationMarker = { status, at: now };
  try {
    window.localStorage.setItem(DATABASE_MIGRATION_MARKER_KEY, JSON.stringify(marker));
  } catch (error) {
    Logger.warn('Could not record the Shop database migration outcome', { error });
  }
}

/** True when `error` is Dexie's BulkError and every failure is a duplicate key. */
function isOnlyDuplicateKeys(error: unknown): boolean {
  if (!(error instanceof Dexie.BulkError)) return false;
  return error.failures.every((entry) => (entry as { name?: string } | undefined)?.name === 'ConstraintError');
}

async function copyTable(source: Table, target: Table): Promise<number> {
  const outboundKeys = source.schema.primKey.keyPath === undefined || source.schema.primKey.keyPath === null;
  let copied = 0;
  for (let offset = 0; ; offset += COPY_CHUNK_SIZE) {
    const page = () => source.toCollection().offset(offset).limit(COPY_CHUNK_SIZE);
    const rows = await page().toArray();
    if (rows.length === 0) break;
    const keys = outboundKeys ? await page().primaryKeys() : undefined;
    try {
      await (keys === undefined ? target.bulkAdd(rows) : target.bulkAdd(rows, keys));
    } catch (error) {
      if (!isOnlyDuplicateKeys(error)) throw error;
    }
    copied += rows.length;
  }
  return copied;
}

async function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let created = false;
    request.onupgradeneeded = () => {
      // Opening a database that does not exist would create it; abort so it stays absent.
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      if (created) {
        resolve(null);
        return;
      }
      reject(request.error ?? new Error(`Failed to open ${name}`));
    };
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function readAllRecords(store: IDBObjectStore): Promise<Array<[IDBValidKey, unknown]>> {
  return new Promise((resolve, reject) => {
    const records: Array<[IDBValidKey, unknown]> = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(records);
        return;
      }
      records.push([cursor.key, cursor.value]);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to read the keyring'));
  });
}

async function openKeyringTarget(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, KEYRING_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEYRING_STORE_NAME)) {
        request.result.createObjectStore(KEYRING_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Failed to open ${name}`));
  });
}

/**
 * Copies the keyring records (the wrapping key and its epoch) that the target does not hold
 * yet. Returns how many legacy records exist; 0 when there is no legacy keyring.
 */
async function copyKeyring(legacyName: string, targetName: string): Promise<number> {
  const legacy = await openExistingDatabase(legacyName);
  if (!legacy) return 0;
  try {
    if (!legacy.objectStoreNames.contains(KEYRING_STORE_NAME)) return 0;
    const records = await readAllRecords(
      legacy.transaction(KEYRING_STORE_NAME, 'readonly').objectStore(KEYRING_STORE_NAME),
    );
    if (records.length === 0) return 0;

    const target = await openKeyringTarget(targetName);
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = target.transaction(KEYRING_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(KEYRING_STORE_NAME);
        for (const [key, value] of records) {
          const request = store.add(value, key);
          request.onerror = (event) => {
            // A record the target already holds is kept: destination wins.
            if (request.error?.name === 'ConstraintError') event.preventDefault();
          };
        }
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('Keyring write aborted'));
      });

      const check = target.transaction(KEYRING_STORE_NAME, 'readonly').objectStore(KEYRING_STORE_NAME);
      for (const [key] of records) {
        if ((await requestToPromise(check.count(key))) === 0) {
          throw failure('migrateLegacyDatabases', `The messaging keyring record ${String(key)} did not copy`);
        }
      }
      return records.length;
    } finally {
      target.close();
    }
  } finally {
    legacy.close();
  }
}

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    const timeout = window.setTimeout(() => {
      Logger.warn('Legacy database deletion is blocked by an open tab; it will be left in place', { name });
      resolve();
    }, DELETE_BLOCKED_TIMEOUT_MS);
    const settle = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    request.onsuccess = settle;
    request.onerror = () => {
      Logger.warn('Could not delete a legacy database', { name, error: request.error });
      settle();
    };
  });
}

async function hasShopOnlyTable(name: string): Promise<boolean> {
  const probe = new Dexie(name);
  try {
    await probe.open();
    return probe.tables.some((table) => table.name === SHOP_ONLY_TABLE);
  } finally {
    probe.close();
  }
}

async function moveDatabase(
  legacyName: string,
  targetName: string,
): Promise<{ status: MigrationMarkerStatus; rows: number }> {
  if (!(await Dexie.exists(legacyName))) {
    // A keyring can only exist next to a database; stale ones are not ours to carry over.
    return { status: 'nothing', rows: 0 };
  }
  if (!(await hasShopOnlyTable(legacyName))) {
    return { status: 'foreign', rows: 0 };
  }

  const legacyKeyringName = messagingKeyringDbName(legacyName);
  const targetKeyringName = messagingKeyringDbName(targetName);
  const legacyKeyringRecords = await copyKeyring(legacyKeyringName, targetKeyringName);

  const legacyDb = new AppDatabase(legacyName);
  const targetDb = new AppDatabase(targetName);
  let rows = 0;
  try {
    await legacyDb.initialize();
    await targetDb.initialize();

    const counts = new Map<string, number>();
    for (const table of legacyDb.tables) {
      if (!targetDb.tables.some((candidate) => candidate.name === table.name)) continue;
      counts.set(table.name, await copyTable(table, targetDb.table(table.name)));
    }
    for (const [name, expected] of counts) {
      const actual = await targetDb.table(name).count();
      if (actual < expected) {
        throw failure('migrateLegacyDatabases', `Table ${name} holds ${actual} rows after copying ${expected}`);
      }
      rows += expected;
    }
  } finally {
    legacyDb.close();
    targetDb.close();
  }

  await deleteIndexedDb(legacyName);
  if (legacyKeyringRecords > 0) await deleteIndexedDb(legacyKeyringName);
  return { status: rows > 0 || legacyKeyringRecords > 0 ? 'migrated' : 'nothing', rows };
}

async function withMigrationLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks || typeof locks.request !== 'function') return run();
  return locks.request(MIGRATION_LOCK_NAME, { mode: 'exclusive' }, run);
}

/**
 * Runs the migration if this origin has not recorded an outcome yet. Call it before
 * `AppDatabase.initialize()` on the namespaced database.
 */
export async function migrateLegacyDatabases(options: DatabaseMigrationOptions = {}): Promise<DatabaseMigrationResult> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return { status: 'unavailable', alreadyDone: false, rows: 0 };
  }
  const legacyName = options.legacyName ?? LEGACY_DB_NAME;
  const targetName = options.targetName ?? DB_NAME;
  const adopt = options.adopt ?? getStorageAdoptLegacy();
  const now = options.now ?? Date.now();

  const recorded = readMarker();
  if (recorded) return { status: recorded.status, alreadyDone: true, rows: 0 };

  if (legacyName === targetName) {
    // A deployment that pinned NEXT_PUBLIC_DB_NAME to the old name has nothing to move.
    writeMarker('nothing', now);
    return { status: 'nothing', alreadyDone: false, rows: 0 };
  }

  if (!adopt) {
    writeMarker('skipped', now);
    return { status: 'skipped', alreadyDone: false, rows: 0 };
  }

  return withMigrationLock(async () => {
    // Another tab may have finished while this one waited for the lock.
    const raced = readMarker();
    if (raced) return { status: raced.status, alreadyDone: true, rows: 0 } as const;

    try {
      const { status, rows } = await moveDatabase(legacyName, targetName);
      writeMarker(status, now);
      return { status, alreadyDone: false, rows } as const;
    } catch (error) {
      throw failure('migrateLegacyDatabases', 'Failed to migrate the existing database to the Shop namespace', error);
    }
  });
}
