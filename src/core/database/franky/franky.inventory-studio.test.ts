import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '@/database/franky/franky';
import { clearDatabase } from '@/database/franky/franky.helpers';
import { INVENTORY_STUDIO_TABLE_NAMES } from '@/models/commerce/commerce.schema';
import { DexieWebhookStore } from '@/services/marketplace/marketplace-webhook-store';

describe('Inventory Studio Dexie tables', () => {
  afterEach(async () => {
    await db.close();
  });

  it('enumerates import and webhook table names against db.tables so a second Dexie instance cannot hide them', async () => {
    await db.open();
    const names = new Set(db.tables.map((table) => table.name));
    expect(INVENTORY_STUDIO_TABLE_NAMES).toEqual([
      'commerce_import_manifests',
      'commerce_import_rows',
      'commerce_import_mappings',
      'commerce_webhooks',
    ]);
    for (const tableName of INVENTORY_STUDIO_TABLE_NAMES) {
      expect(names.has(tableName)).toBe(true);
    }
  });

  it('wipes import manifests, rows, mappings, and webhook urls on clearDatabase', async () => {
    await db.open();
    const seller = 'y'.repeat(52);
    await db.commerce_import_manifests.put({
      id: 'manifest-w4',
      seller_id: seller,
      version: 1,
      created_at: Date.now(),
      summary_json: '{}',
    });
    await db.commerce_import_rows.put({
      manifestId: 'manifest-w4',
      rowIdentity: 'row-1',
      seller_id: seller,
      listingId: 'boots_01',
      planned_json: '{}',
      payload_json: '{}',
      checkpoint: 'planned',
      updated_at: Date.now(),
    });
    await db.commerce_import_mappings.put({
      seller_id: seller,
      mapping_json: '{}',
      updated_at: Date.now(),
    });
    const store = new DexieWebhookStore(seller);
    await store.put({ id: '11111111-1111-4111-8111-111111111111', url: 'https://example.com/hook' });
    expect(JSON.stringify(await db.commerce_webhooks.toArray())).not.toMatch(/secret/i);

    await clearDatabase();
    expect(await db.commerce_import_manifests.count()).toBe(0);
    expect(await db.commerce_import_rows.count()).toBe(0);
    expect(await db.commerce_import_mappings.count()).toBe(0);
    expect(await db.commerce_webhooks.count()).toBe(0);
  });
});
