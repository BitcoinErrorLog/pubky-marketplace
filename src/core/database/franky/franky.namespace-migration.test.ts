import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '@/database/franky/franky';
import { migrateLegacyDatabases } from '@/database/franky/franky.namespace-migration';
import { KEYRING_STORE_NAME, messagingKeyringDbName } from '@/libs/crypto/messaging-keyring';
import { DATABASE_MIGRATION_MARKER_KEY } from '@/libs/storage-namespace/storage-namespace';
import { asOpaque } from '@/test-utils/type-assertions';

const LEGACY = 'franky-legacy-test';
const TARGET = 'shop-franky-target-test';

type Row = Record<string, unknown>;

async function openRaw(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEYRING_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedKeyring(dbName: string, records: Record<string, unknown>): Promise<void> {
  const keyring = await openRaw(messagingKeyringDbName(dbName));
  await new Promise<void>((resolve, reject) => {
    const transaction = keyring.transaction(KEYRING_STORE_NAME, 'readwrite');
    for (const [key, value] of Object.entries(records)) transaction.objectStore(KEYRING_STORE_NAME).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  keyring.close();
}

async function readKeyring(dbName: string): Promise<Record<string, unknown> | null> {
  if (!(await Dexie.exists(messagingKeyringDbName(dbName)))) return null;
  const keyring = await openRaw(messagingKeyringDbName(dbName));
  const result: Record<string, unknown> = {};
  await new Promise<void>((resolve, reject) => {
    const request = keyring.transaction(KEYRING_STORE_NAME, 'readonly').objectStore(KEYRING_STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      result[String(cursor.key)] = cursor.value;
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  keyring.close();
  return result;
}

async function seedLegacy(shops: Row[], cartItems: Row[] = []): Promise<void> {
  const legacy = new AppDatabase(LEGACY);
  await legacy.initialize();
  await legacy.commerce_shops.bulkPut(shops as never);
  await legacy.commerce_cart_items.bulkPut(cartItems as never);
  legacy.close();
}

async function readTarget(): Promise<{ shops: Row[]; cartItems: Row[] }> {
  const target = new AppDatabase(TARGET);
  await target.initialize();
  const result = {
    shops: asOpaque<Row[]>(await target.commerce_shops.toArray()),
    cartItems: asOpaque<Row[]>(await target.commerce_cart_items.toArray()),
  };
  target.close();
  return result;
}

/**
 * Makes one `table(name)` lookup on the target database (the `occurrence`th, from 0) return a
 * table whose `method` is replaced, to fail or distort one step of the migration. The copy
 * looks a table up once, then the verification looks it up again to count its rows.
 */
function overrideTargetTable(
  name: string,
  method: 'bulkAdd' | 'count',
  replacement: () => Promise<unknown>,
  occurrence = 0,
) {
  const original = Dexie.prototype.table;
  let lookups = 0;
  return vi.spyOn(Dexie.prototype, 'table').mockImplementation(function (this: Dexie, ...args: unknown[]) {
    const tableName = String(args[0]);
    const table = original.call(this, tableName);
    if (this.name !== TARGET || tableName !== name) return table;
    if (lookups++ !== occurrence) return table;
    return new Proxy(table, {
      get: (target, prop) => (prop === method ? replacement : Reflect.get(target, prop, target)),
    });
  });
}

const shop = (id: string, extra: Row = {}): Row => ({
  id,
  revision: 1,
  sync_status: 'synced',
  updated_at: 1,
  ...extra,
});
const cartItem = (id: string): Row => ({ id, owner_id: 'o', listing_id: 'l', variant_id: 'v', updated_at: 1 });

async function deleteAll(): Promise<void> {
  for (const name of [LEGACY, TARGET, 'franky-foreign-test']) {
    await Dexie.delete(name);
    await Dexie.delete(messagingKeyringDbName(name));
  }
}

describe('migrateLegacyDatabases', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await deleteAll();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await deleteAll();
  });

  it('moves every table and the messaging keyring into the namespaced databases and removes the legacy ones', async () => {
    await seedLegacy([shop('s1'), shop('s2')], [cartItem('c1')]);
    await seedKeyring(LEGACY, { 'wrapping-key': 'KEY', 'wrapping-key-epoch': 'EPOCH' });

    const result = await migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true });

    expect(result).toMatchObject({ status: 'migrated', alreadyDone: false, rows: 3 });
    const moved = await readTarget();
    expect(moved.shops.map((row) => row.id).sort()).toEqual(['s1', 's2']);
    expect(moved.cartItems.map((row) => row.id)).toEqual(['c1']);
    expect(await readKeyring(TARGET)).toEqual({ 'wrapping-key': 'KEY', 'wrapping-key-epoch': 'EPOCH' });
    expect(await Dexie.exists(LEGACY)).toBe(false);
    expect(await Dexie.exists(messagingKeyringDbName(LEGACY))).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(DATABASE_MIGRATION_MARKER_KEY) ?? '{}')).toMatchObject({
      status: 'migrated',
    });
  });

  it('copies more rows than one chunk', async () => {
    const shops = Array.from({ length: 600 }, (_, index) => shop(`s${String(index).padStart(4, '0')}`));
    await seedLegacy(shops);

    const result = await migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true });

    expect(result).toMatchObject({ status: 'migrated', rows: 600 });
    expect((await readTarget()).shops).toHaveLength(600);
  });

  it('records "nothing" and creates no database when there is no legacy data', async () => {
    const result = await migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true });

    expect(result).toMatchObject({ status: 'nothing', alreadyDone: false });
    expect(await Dexie.exists(TARGET)).toBe(false);
    expect(await Dexie.exists(LEGACY)).toBe(false);
  });

  it('is safe to run twice: the second run reads the recorded outcome and touches nothing', async () => {
    await seedLegacy([shop('s1')]);
    await migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true });

    // A tab on the previous build recreates the legacy database afterwards.
    await seedLegacy([shop('late')]);
    const second = await migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true });

    expect(second).toMatchObject({ status: 'migrated', alreadyDone: true });
    expect((await readTarget()).shops.map((row) => row.id)).toEqual(['s1']);
    expect(await Dexie.exists(LEGACY)).toBe(true);
  });

  it('recovers from a crash between copy and delete: no duplicates, newer namespaced data wins', async () => {
    await seedLegacy([shop('s1', { revision: 1 }), shop('s2')]);
    // A previous run copied s1, the user then edited it in the namespaced database, and the run died.
    const target = new AppDatabase(TARGET);
    await target.initialize();
    await target.commerce_shops.put(shop('s1', { revision: 9 }) as never);
    target.close();
    await seedKeyring(TARGET, { 'wrapping-key': 'KEY' });
    await seedKeyring(LEGACY, { 'wrapping-key': 'OLD-COPY' });

    const result = await migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true });

    expect(result.status).toBe('migrated');
    const moved = await readTarget();
    expect(moved.shops).toHaveLength(2);
    expect(moved.shops.find((row) => row.id === 's1')).toMatchObject({ revision: 9 });
    expect(await readKeyring(TARGET)).toEqual({ 'wrapping-key': 'KEY' });
    expect(await Dexie.exists(LEGACY)).toBe(false);
  });

  it('keeps the legacy databases and records nothing when a copy fails, then succeeds on retry', async () => {
    await seedLegacy([shop('s1')]);
    await seedKeyring(LEGACY, { 'wrapping-key': 'KEY' });
    const lookup = overrideTargetTable('commerce_shops', 'bulkAdd', () => Promise.reject(new Error('disk full')));

    await expect(migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true })).rejects.toThrow(
      /migrate the existing database/,
    );

    expect(lookup).toHaveBeenCalled();
    lookup.mockRestore();
    expect(await Dexie.exists(LEGACY)).toBe(true);
    expect(await Dexie.exists(messagingKeyringDbName(LEGACY))).toBe(true);
    expect(window.localStorage.getItem(DATABASE_MIGRATION_MARKER_KEY)).toBeNull();

    const retried = await migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true });

    expect(retried).toMatchObject({ status: 'migrated', alreadyDone: false });
    expect((await readTarget()).shops.map((row) => row.id)).toEqual(['s1']);
    expect(await Dexie.exists(LEGACY)).toBe(false);
  });

  it('refuses to delete the legacy database when the copy is short of the source', async () => {
    await seedLegacy([shop('s1'), shop('s2')]);
    overrideTargetTable('commerce_shops', 'count', async () => 1, 1);

    await expect(migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true })).rejects.toThrow(
      /migrate the existing database/,
    );

    vi.restoreAllMocks();
    expect(await Dexie.exists(LEGACY)).toBe(true);
    expect(window.localStorage.getItem(DATABASE_MIGRATION_MARKER_KEY)).toBeNull();
  });

  it("leaves a legacy database that is not the Shop's alone", async () => {
    const foreign = new Dexie('franky-foreign-test');
    foreign.version(1).stores({ user_details: '&id' });
    await foreign.table('user_details').put({ id: 'app-user' });
    foreign.close();

    const result = await migrateLegacyDatabases({ legacyName: 'franky-foreign-test', targetName: TARGET, adopt: true });

    expect(result).toMatchObject({ status: 'foreign' });
    expect(await Dexie.exists('franky-foreign-test')).toBe(true);
    expect(await Dexie.exists(TARGET)).toBe(false);
    const reopened = new Dexie('franky-foreign-test');
    await reopened.open();
    expect(await reopened.table('user_details').toArray()).toEqual([{ id: 'app-user' }]);
    reopened.close();
  });

  it("does not read or touch the legacy databases on an origin where those names are another app's", async () => {
    await seedLegacy([shop('app-owned')]);
    const exists = vi.spyOn(Dexie, 'exists');

    const result = await migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: false });

    expect(result).toMatchObject({ status: 'skipped', alreadyDone: false });
    expect(exists).not.toHaveBeenCalled();
    expect(await Dexie.exists(LEGACY)).toBe(true);
    expect(await Dexie.exists(TARGET)).toBe(false);

    // Flipping the switch later must not start adopting the other app's database.
    const again = await migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true });
    expect(again).toMatchObject({ status: 'skipped', alreadyDone: true });
  });

  it('has nothing to do when the database name was never namespaced', async () => {
    const result = await migrateLegacyDatabases({ legacyName: LEGACY, targetName: LEGACY, adopt: true });

    expect(result).toMatchObject({ status: 'nothing' });
  });

  it('never leaves two tabs migrating at once: concurrent runs agree on one outcome', async () => {
    await seedLegacy([shop('s1'), shop('s2')]);

    const [first, second] = await Promise.all([
      migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true }),
      migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true }),
    ]);

    expect([first.status, second.status]).toEqual(['migrated', 'migrated']);
    expect((await readTarget()).shops).toHaveLength(2);
    expect(await Dexie.exists(LEGACY)).toBe(false);
  });

  it('still migrates, without a recorded outcome, when localStorage is unavailable', async () => {
    await seedLegacy([shop('s1')]);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    const result = await migrateLegacyDatabases({ legacyName: LEGACY, targetName: TARGET, adopt: true });

    expect(result).toMatchObject({ status: 'migrated' });
    vi.restoreAllMocks();
    expect((await readTarget()).shops.map((row) => row.id)).toEqual(['s1']);
  });
});
