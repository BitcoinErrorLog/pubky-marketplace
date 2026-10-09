import { describe, expect, it } from 'vitest';
import {
  DATABASE_MIGRATION_MARKER_KEY,
  LEGACY_DB_NAME,
  legacyStorageKey,
  LOCAL_STORAGE_MIGRATION_MARKER_KEY,
  parseMigrationMarker,
  shopStorageKey,
} from './storage-namespace';

describe('storage namespace names', () => {
  it('prefixes a name with the Shop namespace and takes it off again', () => {
    expect(shopStorageKey('auth-store')).toBe('shop-auth-store');
    expect(legacyStorageKey('shop-auth-store')).toBe('auth-store');
    expect(legacyStorageKey('auth-store')).toBe('auth-store');
  });

  it('keeps the previous database name, which only the migration reads', () => {
    expect(LEGACY_DB_NAME).toBe('franky');
  });

  it('keeps the migration markers inside the Shop namespace', () => {
    expect(LOCAL_STORAGE_MIGRATION_MARKER_KEY.startsWith('shop-')).toBe(true);
    expect(DATABASE_MIGRATION_MARKER_KEY.startsWith('shop-')).toBe(true);
    expect(LOCAL_STORAGE_MIGRATION_MARKER_KEY).not.toBe(DATABASE_MIGRATION_MARKER_KEY);
  });
});

describe('parseMigrationMarker', () => {
  it('reads a recorded outcome', () => {
    expect(parseMigrationMarker(JSON.stringify({ status: 'migrated', at: 5 }))).toEqual({ status: 'migrated', at: 5 });
    expect(parseMigrationMarker(JSON.stringify({ status: 'skipped' }))).toEqual({ status: 'skipped', at: 0 });
  });

  it.each([null, '', 'not json', '"migrated"', '{}', '{"status":"done"}', 'null'])('rejects %s', (raw) => {
    expect(parseMigrationMarker(raw)).toBeNull();
  });
});
