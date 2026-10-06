import { db } from '@/database/franky/franky';
import type { CommerceWebhookModelSchema } from '@/models/commerce/commerce.schema';

type WebhookDatabase = Pick<typeof db, 'commerce_webhooks'>;

/**
 * Device-local webhook {id,url} rows. Wave 3a has no GET list; the secret from
 * POST/rotate is never written here.
 */
export class DexieWebhookStore {
  constructor(
    private readonly sellerId: string,
    private readonly database: WebhookDatabase = db,
  ) {}

  async list(): Promise<CommerceWebhookModelSchema[]> {
    const rows = await this.database.commerce_webhooks.where('seller_id').equals(this.sellerId).toArray();
    return rows.sort((left, right) => right.created_at - left.created_at);
  }

  async put(input: { id: string; url: string; createdAt?: number }): Promise<void> {
    await this.database.commerce_webhooks.put({
      id: input.id,
      seller_id: this.sellerId,
      url: input.url,
      created_at: input.createdAt ?? Date.now(),
    });
  }

  async remove(id: string): Promise<void> {
    const existing = await this.database.commerce_webhooks.get(id);
    if (existing && existing.seller_id !== this.sellerId) return;
    await this.database.commerce_webhooks.delete(id);
  }
}
