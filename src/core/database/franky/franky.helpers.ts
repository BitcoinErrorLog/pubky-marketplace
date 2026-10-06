import { DB_NAME } from '@/config/database';
import { db } from '@/database/franky/franky';
import { resumeMessagingKeyTeardown, tearDownMessagingKeys } from '@/libs/crypto/messaging-keyring';

export const PUBLIC_CACHE_TABLES: ReadonlySet<string> = new Set([
  'user_counts',
  'user_details',
  'user_ttl',
  'post_counts',
  'post_details',
  'post_relationships',
  'post_ttl',
  'file_details',
  'tag_streams',
  'commerce_shops',
  'commerce_listings',
  'commerce_catalog_entries',
  'commerce_listing_projections',
]);

/**
 * Device-local rows keyed by `owner_id`. Identity switch and sign-out must
 * not wipe another identity's book — ADR-0019 keeps addresses off the
 * homeserver, so they live here across sessions on this device.
 */
export const IDENTITY_SCOPED_DEVICE_TABLES: ReadonlySet<string> = new Set(['commerce_delivery_addresses']);

/**
 * Tables whose rows are wrapped under the messaging wrapping key. They are
 * cleared together with the key, holding the key fence
 * (`tearDownMessagingKeys`), never alongside the other tables.
 */
const KEY_WRAPPED_MESSAGING_TABLES: ReadonlySet<string> = new Set([
  'commerce_messaging_receivers',
  'commerce_messaging_links',
  'commerce_messaging_messages',
  'commerce_messaging_outbox',
  'commerce_messaging_unprocessed',
]);

async function clearKeyWrappedMessagingTables(): Promise<void> {
  await Promise.all(
    db.tables.filter((table) => KEY_WRAPPED_MESSAGING_TABLES.has(table.name)).map((table) => table.clear()),
  );
}

function tablesClearedOnIdentitySwitch(includePublicCache: boolean) {
  return db.tables.filter((table) => {
    if (IDENTITY_SCOPED_DEVICE_TABLES.has(table.name)) return false;
    if (!includePublicCache && PUBLIC_CACHE_TABLES.has(table.name)) return false;
    return true;
  });
}

export async function clearDatabase(): Promise<void> {
  if (!db.isOpen()) {
    await db.open();
  }

  // The messaging wrapping key lives outside the Dexie tables; wipe it too so
  // sign-out/account switch leaves no key material behind. The teardown
  // holds the messaging key lock, so no other tab reads or writes wrapped
  // state between the clear and the key deletion, and every other tab's
  // cached key is known stale afterwards.
  await Promise.all(
    tablesClearedOnIdentitySwitch(true)
      .filter((table) => !KEY_WRAPPED_MESSAGING_TABLES.has(table.name))
      .map((table) => table.clear()),
  );
  await tearDownMessagingKeys(clearKeyWrappedMessagingTables);
}

export async function clearPrivateData(): Promise<void> {
  if (!db.isOpen()) {
    await db.open();
  }

  await Promise.all(
    tablesClearedOnIdentitySwitch(false)
      .filter((table) => !KEY_WRAPPED_MESSAGING_TABLES.has(table.name))
      .map((table) => table.clear()),
  );
  await tearDownMessagingKeys(clearKeyWrappedMessagingTables);
}

/**
 * Completes a messaging key teardown that a sign-out left queued when its
 * tab closed before other tabs let it run. Called once the database is open.
 */
export async function resumePendingMessagingTeardown(): Promise<void> {
  await resumeMessagingKeyTeardown(clearKeyWrappedMessagingTables);
}

export async function resetDatabase(): Promise<void> {
  const { indexedDB } = await import('fake-indexeddb');

  db.close();
  indexedDB.deleteDatabase(DB_NAME);
  await db.open();
}
