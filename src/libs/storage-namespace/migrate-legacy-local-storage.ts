import {
  LOCAL_STORAGE_MIGRATION_MARKER_KEY,
  type MigrationMarker,
  type MigrationMarkerStatus,
  parseMigrationMarker,
} from './storage-namespace';

export interface LegacyLocalStorageMap {
  /** Exact keys: `legacy name -> namespaced name`. */
  keys: Readonly<Record<string, string>>;
  /** Key prefixes (per-account and per-device flags): `legacy prefix -> namespaced prefix`. */
  prefixes: Readonly<Record<string, string>>;
}

export type LocalStorageMigrationResult =
  | { status: MigrationMarkerStatus; moved: number; alreadyDone: boolean }
  | { status: 'failed'; moved: number; alreadyDone: false; error: unknown };

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function writeMarker(storage: StorageLike, status: MigrationMarkerStatus, now: number): void {
  const marker: MigrationMarker = { status, at: now };
  storage.setItem(LOCAL_STORAGE_MIGRATION_MARKER_KEY, JSON.stringify(marker));
}

function snapshotKeys(storage: StorageLike): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

/**
 * Moves the Shop's pre-namespace `localStorage` entries to their namespaced names, once.
 *
 * Properties the callers rely on:
 *  - Idempotent and re-entrant: a recorded outcome ends every later call at once, so a
 *    second run (another tab, another load) touches nothing. This is what keeps the Shop
 *    off the App's keys when the App later writes `auth-store` on the same origin.
 *  - No data loss: a legacy entry is deleted only after its namespaced copy reads back. A
 *    failure part-way (quota, storage disabled) records no outcome, leaves unread legacy
 *    entries in place, and the next load retries.
 *  - Destination wins: a namespaced entry that already exists is never overwritten by the
 *    legacy one, which is then dropped. Re-running after a crash between copy and delete
 *    therefore cannot resurrect stale data.
 *  - Opt-in per origin: with `adopt` false the legacy names belong to another app (the Shop
 *    is mounted on the App's origin) and nothing is read, moved or deleted. The decision is
 *    recorded, so flipping `adopt` later cannot start adopting the other app's entries.
 *
 * Synchronous on purpose: Zustand `persist` hydrates while its store module is evaluated.
 */
export function migrateLegacyLocalStorage(
  storage: StorageLike,
  map: LegacyLocalStorageMap,
  options: { adopt: boolean; now?: number },
): LocalStorageMigrationResult {
  const now = options.now ?? Date.now();
  let moved = 0;
  try {
    const recorded = parseMigrationMarker(storage.getItem(LOCAL_STORAGE_MIGRATION_MARKER_KEY));
    if (recorded) return { status: recorded.status, moved: 0, alreadyDone: true };

    if (!options.adopt) {
      writeMarker(storage, 'skipped', now);
      return { status: 'skipped', moved: 0, alreadyDone: false };
    }

    const pairs: Array<[string, string]> = Object.entries(map.keys);
    const prefixEntries = Object.entries(map.prefixes);
    if (prefixEntries.length > 0) {
      for (const key of snapshotKeys(storage)) {
        for (const [legacyPrefix, prefix] of prefixEntries) {
          if (key.startsWith(legacyPrefix)) pairs.push([key, `${prefix}${key.slice(legacyPrefix.length)}`]);
        }
      }
    }

    for (const [legacyKey, namespacedKey] of pairs) {
      const value = storage.getItem(legacyKey);
      if (value === null) continue;
      if (storage.getItem(namespacedKey) === null) {
        storage.setItem(namespacedKey, value);
        if (storage.getItem(namespacedKey) !== value) {
          throw new Error(`localStorage did not keep ${namespacedKey}`);
        }
        moved += 1;
      }
      storage.removeItem(legacyKey);
    }

    const status: MigrationMarkerStatus = moved > 0 ? 'migrated' : 'nothing';
    writeMarker(storage, status, now);
    return { status, moved, alreadyDone: false };
  } catch (error) {
    return { status: 'failed', moved, alreadyDone: false, error };
  }
}
