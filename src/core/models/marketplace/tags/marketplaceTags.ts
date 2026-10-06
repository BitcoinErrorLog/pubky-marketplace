import { Table } from 'dexie';
import { db } from '@/database/franky/franky';
import type { TagCollectionModelSchema } from '@/models/shared/tag/tag.schema';
import { TagCollection } from '@/models/shared/tag/tagCollection';

export type MarketplaceTagsModelSchema = TagCollectionModelSchema<string>;

/**
 * Community tags on marketplace targets (listings and shops), keyed by a
 * kind-prefixed target id so both target types share one table without
 * ambiguity:
 *
 * - listing rows: `listing:{sellerPubky}:{listingId}`
 * - shop rows:    `shop:{ownerPubky}`
 *
 * Rows hold the same `NexusTag[]` aggregate shape as `post_tags` /
 * `user_tags` (label, taggers sample, taggers_count, viewer relationship).
 */
export class MarketplaceTagsModel
  extends TagCollection<string, MarketplaceTagsModelSchema>
  implements MarketplaceTagsModelSchema
{
  static table: Table<MarketplaceTagsModelSchema> = db.table('marketplace_tags');

  constructor(data: MarketplaceTagsModelSchema) {
    super(data);
  }
}
