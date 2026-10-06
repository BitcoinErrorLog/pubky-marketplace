import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase, db } from '@/database/franky/franky';
import { clearDatabase } from '@/database/franky/franky.helpers';
import { COMMERCE_WEBHOOK_TABLE_NAMES } from '@/models/commerce/commerce.schema';
import { DexieWebhookStore } from '@/services/marketplace/marketplace-webhook-store';

describe('Inventory Studio Dexie webhook table', () => {
  afterEach(async () => {
    await db.close();
  });

  it('enumerates webhook table names against db.tables so a second Dexie instance cannot hide them', async () => {
    await db.open();
    const names = new Set(db.tables.map((table) => table.name));
    for (const tableName of COMMERCE_WEBHOOK_TABLE_NAMES) {
      expect(names.has(tableName)).toBe(true);
    }
  });

  it('wipes webhook rows on clearDatabase and never stores a secret field', async () => {
    await db.open();
    const seller = 'y'.repeat(52);
    const store = new DexieWebhookStore(seller);
    await store.put({ id: '11111111-1111-4111-8111-111111111111', url: 'https://example.com/hook' });
    const stored = await db.commerce_webhooks.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      seller_id: seller,
      url: 'https://example.com/hook',
      created_at: expect.any(Number),
    });
    expect(JSON.stringify(stored)).not.toMatch(/secret/i);
    await clearDatabase();
    expect(await db.commerce_webhooks.count()).toBe(0);
  });

  it('upgrades 6 → 7 in place without wiping user state', async () => {
    const name = `franky-webhooks-${crypto.randomUUID()}`;
    const owner = 'a'.repeat(52);
    const v6 = new AppDatabase(name, 6);
    await v6.initialize();
    await v6.user_counts.put({ id: owner, followers: 9 } as never);
    v6.close();

    const v7 = new AppDatabase(name, 7);
    const result = await v7.initialize();
    expect(result.wasDbReset).toBe(false);
    await expect(v7.user_counts.get(owner)).resolves.toMatchObject({ followers: 9 });
    const names = new Set(v7.tables.map((table) => table.name));
    for (const tableName of COMMERCE_WEBHOOK_TABLE_NAMES) {
      expect(names.has(tableName)).toBe(true);
    }
    v7.close();
  });
});
