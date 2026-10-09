import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME } from '@/config/database';
import { AppDatabase } from '@/database/franky/franky';
import { clearDatabase, clearPrivateData } from '@/database/franky/franky.helpers';
import { migrateLegacyDatabases } from '@/database/franky/franky.namespace-migration';
import { deleteWrappingKeyStore } from '@/libs/crypto/messaging-keyring';
import { migrateLegacyLocalStorage } from '@/libs/storage-namespace/migrate-legacy-local-storage';

/**
 * The host app (pubky.app) keeps its own data on the origin the Shop is mounted on: its Dexie
 * database `franky`, its persisted keys, the SDK's session store. A database deleted from
 * inside a frame is gone for the top page too (verified on iOS Safari 26.1 and 26.2), so
 * nothing the Shop does at runtime may delete or clear a name outside its namespace.
 */

const HOST_DATABASES = ['franky', 'franky-messaging-keyring', 'pubky-auth'];
const HOST_LOCAL_STORAGE: Record<string, string> = {
  'auth-store': '{"state":{"currentUserPubky":"HOST"},"version":3}',
  'settings-storage': '{"state":{"theme":"host"}}',
  'pubky-feature-discovery:tour': 'seen',
  'pubky-app-session-failures': 'x',
};
/** Names only the Shop uses; nothing else can collide with them. */
const SHOP_ONLY_NAMES = new Set(['pubky-messaging-keys-teardown-pending']);

function isShopNamespaced(name: string): boolean {
  return name.startsWith('shop-') || SHOP_ONLY_NAMES.has(name);
}

async function createHostDatabases(): Promise<void> {
  const hostApp = new Dexie('franky');
  hostApp.version(30).stores({ user_details: '&id', post_details: '&id' });
  await hostApp.table('user_details').put({ id: 'host-user' });
  hostApp.close();
  for (const name of ['franky-messaging-keyring', 'pubky-auth']) {
    const raw = new Dexie(name);
    raw.version(1).stores({ records: '&id' });
    await raw.table('records').put({ id: 'host-record' });
    raw.close();
  }
}

async function expectHostDataIntact(): Promise<void> {
  for (const name of HOST_DATABASES) {
    expect(await Dexie.exists(name), `${name} still exists`).toBe(true);
  }
  const hostApp = new Dexie('franky');
  await hostApp.open();
  expect(await hostApp.table('user_details').toArray()).toEqual([{ id: 'host-user' }]);
  hostApp.close();
  for (const [key, value] of Object.entries(HOST_LOCAL_STORAGE)) {
    expect(window.localStorage.getItem(key), key).toBe(value);
  }
}

describe('Shop storage never touches names outside its namespace', () => {
  let deletedDatabases: string[];
  let removedKeys: string[];
  let clearedStorages: number;

  beforeEach(async () => {
    window.localStorage.clear();
    for (const name of HOST_DATABASES) await Dexie.delete(name);
    await createHostDatabases();
    for (const [key, value] of Object.entries(HOST_LOCAL_STORAGE)) window.localStorage.setItem(key, value);

    deletedDatabases = [];
    removedKeys = [];
    clearedStorages = 0;
    const deleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation((name: string) => {
      deletedDatabases.push(name);
      return deleteDatabase(name);
    });
    const removeItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      removedKeys.push(key);
      return removeItem.call(this, key);
    });
    const clear = Storage.prototype.clear;
    vi.spyOn(Storage.prototype, 'clear').mockImplementation(function (this: Storage) {
      clearedStorages += 1;
      return clear.call(this);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    for (const name of HOST_DATABASES) await Dexie.delete(name);
  });

  it('leaves the host app alone when migration is off for this origin', async () => {
    await migrateLegacyDatabases({ adopt: false });
    migrateLegacyLocalStorage(
      window.localStorage,
      { keys: { 'auth-store': 'shop-auth-store' }, prefixes: {} },
      {
        adopt: false,
      },
    );

    expect(deletedDatabases).toEqual([]);
    expect(removedKeys).toEqual([]);
    await expectHostDataIntact();
  });

  it("leaves the host app database alone when migration is on but the database is not the Shop's", async () => {
    const result = await migrateLegacyDatabases({ adopt: true });

    expect(result.status).toBe('foreign');
    expect(deletedDatabases).toEqual([]);
    await expectHostDataIntact();
  });

  it('only deletes Shop-namespaced databases and keys when signing out and wiping private data', async () => {
    await clearDatabase();
    await clearPrivateData();
    await deleteWrappingKeyStore();

    expect(deletedDatabases.length).toBeGreaterThan(0);
    for (const name of deletedDatabases) expect(isShopNamespaced(name), `deleted ${name}`).toBe(true);
    for (const key of removedKeys) expect(isShopNamespaced(key), `removed ${key}`).toBe(true);
    expect(clearedStorages).toBe(0);
    await expectHostDataIntact();
  });

  it('only recreates the Shop-namespaced database when its schema version changes', async () => {
    const newer = new AppDatabase(DB_NAME, 2);
    await newer.initialize();
    newer.close();

    expect(deletedDatabases.length).toBeGreaterThan(0);
    for (const name of deletedDatabases) expect(isShopNamespaced(name), `deleted ${name}`).toBe(true);
    await expectHostDataIntact();
  });

  it('keeps the Shop database name and keyring name inside the namespace', () => {
    expect(isShopNamespaced(DB_NAME)).toBe(true);
    expect(isShopNamespaced(`${DB_NAME}-messaging-keyring`)).toBe(true);
  });
});
