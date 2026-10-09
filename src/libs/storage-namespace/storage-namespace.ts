/**
 * Browser-storage namespace for the Shop.
 *
 * The Shop is a fork of pubky.app and shares its storage names: the Dexie database
 * `franky`, the Zustand persist keys (`auth-store`, `settings-storage`, ...) and a few
 * more. They are harmless while each app has its own origin, and collide the moment the
 * two share one (the Shop mounted under pubky.app/shop): the same database opened at two
 * schema versions, one app's sign-out sweep clearing the other's keys, one app reading the
 * other's identity as its own legacy data.
 *
 * Every name the App also defines carries the `shop-` prefix instead. Names that already
 * only exist in the Shop (`marketplace:*`, `pubky.marketplace.*`, the messaging keyring
 * flag, the Web Lock names) stay as they are, because nothing else can collide with them.
 * Existing Shop users keep their data through a one-time migration
 * (`migrateLegacyLocalStorage`, `migrateLegacyDatabases`).
 *
 * This module is a leaf with no `@/` imports, so config files and the env schema can use it.
 */

export const SHOP_STORAGE_NAMESPACE = 'shop-';

/** Name of the Dexie database before it was namespaced. */
export const LEGACY_DB_NAME = 'franky';

/** The Shop-namespaced form of a storage name that the App also defines. */
export function shopStorageKey(name: string): string {
  return `${SHOP_STORAGE_NAMESPACE}${name}`;
}

/** The name a namespaced storage name had before the namespace existed. */
export function legacyStorageKey(name: string): string {
  return name.startsWith(SHOP_STORAGE_NAMESPACE) ? name.slice(SHOP_STORAGE_NAMESPACE.length) : name;
}

/**
 * Migration progress markers. They live in `localStorage` (the only store that is both
 * synchronous and outside the databases being moved) under namespaced keys, so a marker
 * can never be mistaken for, or removed by, anything the App stores.
 */
export const LOCAL_STORAGE_MIGRATION_MARKER_KEY = shopStorageKey('storage-migration:local-v1');
export const DATABASE_MIGRATION_MARKER_KEY = shopStorageKey('storage-migration:database-v1');

export type MigrationMarkerStatus =
  /** Legacy data was found and moved into the namespace. */
  | 'migrated'
  /** There was no legacy data to move. */
  | 'nothing'
  /** This origin's legacy names do not belong to the Shop, so they were left alone. */
  | 'skipped'
  /** A legacy database exists but is not the Shop's (it has no Shop-only tables). */
  | 'foreign';

export interface MigrationMarker {
  status: MigrationMarkerStatus;
  at: number;
}

export function parseMigrationMarker(raw: string | null): MigrationMarker | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { status, at } = parsed as Partial<MigrationMarker>;
    if (status !== 'migrated' && status !== 'nothing' && status !== 'skipped' && status !== 'foreign') return null;
    return { status, at: typeof at === 'number' ? at : 0 };
  } catch {
    return null;
  }
}
