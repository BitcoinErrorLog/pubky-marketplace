import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase, db } from '@/database/franky/franky';
import { clearDatabase } from '@/database/franky/franky.helpers';
import { COMMERCE_IMPORT_TABLE_NAMES } from '@/models/commerce/commerce.schema';
import {
  DexieManifestStore,
  type HostImportManifest,
  MANIFEST_CONFLICT,
} from '@/services/marketplace/marketplace-import-store';

describe('Inventory Studio Dexie import tables', () => {
  afterEach(async () => {
    await db.close();
  });

  it('enumerates import table names against db.tables so a second Dexie instance cannot hide them', async () => {
    await db.open();
    const names = new Set(db.tables.map((table) => table.name));
    for (const tableName of COMMERCE_IMPORT_TABLE_NAMES) {
      expect(names.has(tableName)).toBe(true);
    }
  });

  it('wipes import manifests, rows, and mappings on clearDatabase', async () => {
    await db.open();
    await db.commerce_import_manifests.put({
      id: 'manifest-1',
      seller_id: 'y'.repeat(52),
      version: 1,
      created_at: Date.now(),
      summary_json: '{}',
    });
    await db.commerce_import_rows.put({
      manifestId: 'manifest-1',
      rowIdentity: 'row-1',
      seller_id: 'y'.repeat(52),
      listingId: 'boots_01',
      planned_json: '{}',
      payload_json: '{}',
      checkpoint: 'planned',
      updated_at: Date.now(),
    });
    await db.commerce_import_mappings.put({
      seller_id: 'y'.repeat(52),
      mapping_json: '{}',
      updated_at: Date.now(),
    });
    await clearDatabase();
    expect(await db.commerce_import_manifests.count()).toBe(0);
    expect(await db.commerce_import_rows.count()).toBe(0);
    expect(await db.commerce_import_mappings.count()).toBe(0);
  });

  it('upgrades 5 → 6 in place without wiping user state', async () => {
    const name = `franky-import-${crypto.randomUUID()}`;
    const owner = 'a'.repeat(52);
    const v5 = new AppDatabase(name, 5);
    await v5.initialize();
    await v5.user_counts.put({ id: owner, followers: 9 } as never);
    v5.close();

    const v6 = new AppDatabase(name, 6);
    const result = await v6.initialize();
    expect(result.wasDbReset).toBe(false);
    await expect(v6.user_counts.get(owner)).resolves.toMatchObject({ followers: 9 });
    const names = new Set(v6.tables.map((table) => table.name));
    for (const tableName of COMMERCE_IMPORT_TABLE_NAMES) {
      expect(names.has(tableName)).toBe(true);
    }
    v6.close();
  });

  it('throws manifest_conflict from Dexie compareAndSwap on a version mismatch', async () => {
    await db.open();
    const store = new DexieManifestStore('y'.repeat(52));
    const manifest: HostImportManifest = {
      schemaVersion: 2,
      kind: 'pubky-shop-import-manifest',
      manifestId: 'cas-1',
      manifestVersion: 1,
      sourceSha256: 'a'.repeat(64),
      sourceByteLength: '1',
      rowCount: 1,
      parserVersion: '1',
      mappingVersion: '1',
      recordSchemaVersion: '1',
      createdAt: new Date(0).toISOString(),
      rows: [
        {
          sourceRow: 1,
          sourceIdentity: 'src',
          rowIdentity: 'row-1',
          normalizedHash: 'b'.repeat(64),
          listingIdentity: 'listing:boots_01',
          listingId: 'boots_01',
          generatedListingId: null,
          variantId: 'default',
          sku: '',
          intendedAction: 'create',
          idempotencyKey: '00000000-0000-5000-8000-000000000001',
          checkpoint: 'planned',
        },
      ],
    };
    await store.create(manifest);
    await expect(store.compareAndSwap('cas-1', 99, (current) => current)).rejects.toThrow(MANIFEST_CONFLICT);
  });
});
