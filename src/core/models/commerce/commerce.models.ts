import type { Table } from 'dexie';
import { db } from '@/database/franky/franky';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { RecordModelBase } from '@/models/shared/base/record/baseRecord';
import type {
  CommerceActivityCheckpointModelSchema,
  CommerceCartItemModelSchema,
  CommerceCatalogEntryModelSchema,
  CommerceDeliveryAddressModelSchema,
  CommerceFavoriteModelSchema,
  CommerceListingDraftModelSchema,
  CommerceListingModelSchema,
  CommerceListingProjectionModelSchema,
  CommerceLocksCorrelationModelSchema,
  CommerceReviewModelSchema,
  CommerceReviewResponseModelSchema,
  CommerceSavedSearchModelSchema,
  CommerceShippingPresetModelSchema,
  CommerceShopFollowModelSchema,
  CommerceShopModelSchema,
  CommerceSyncJobModelSchema,
  CommerceWatchAlertModelSchema,
  CommerceWatchSnapshotModelSchema,
  CommerceWatchTombstoneModelSchema,
} from './commerce.schema';

export class CommerceShopModel
  extends RecordModelBase<string, CommerceShopModelSchema>
  implements CommerceShopModelSchema
{
  static table: Table<CommerceShopModelSchema> = db.table('commerce_shops');

  owner_id: string;
  record: CommerceShopModelSchema['record'];
  revision: number;
  sync_status: CommerceShopModelSchema['sync_status'];
  updated_at: number;

  constructor(shop: CommerceShopModelSchema) {
    super(shop);
    this.owner_id = shop.owner_id;
    this.record = shop.record;
    this.revision = shop.revision;
    this.sync_status = shop.sync_status;
    this.updated_at = shop.updated_at;
  }

  static async findAllSorted(): Promise<CommerceShopModelSchema[]> {
    try {
      return await this.table.orderBy('updated_at').reverse().toArray();
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to read sorted records from ${this.table.name}`, {
        service: ErrorService.Local,
        operation: 'findAllSorted',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceReviewModel
  extends RecordModelBase<string, CommerceReviewModelSchema>
  implements CommerceReviewModelSchema
{
  static table: Table<CommerceReviewModelSchema> = db.table('commerce_reviews');

  owner_id: string;
  review_id: string;
  order_id: string;
  subject_id: string;
  record: CommerceReviewModelSchema['record'];
  attestation_verified: boolean;
  attestation_iss: string | null;
  sync_status: CommerceReviewModelSchema['sync_status'];
  updated_at: number;

  constructor(review: CommerceReviewModelSchema) {
    super(review);
    this.owner_id = review.owner_id;
    this.review_id = review.review_id;
    this.order_id = review.order_id;
    this.subject_id = review.subject_id;
    this.record = review.record;
    this.attestation_verified = review.attestation_verified;
    this.attestation_iss = review.attestation_iss;
    this.sync_status = review.sync_status;
    this.updated_at = review.updated_at;
  }

  static async findByOwnerAndOrder(ownerId: string, orderId: string): Promise<CommerceReviewModelSchema | undefined> {
    try {
      return await this.table.where('[owner_id+order_id]').equals([ownerId, orderId]).first();
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to read own review from ${this.table.name}`, {
        service: ErrorService.Local,
        operation: 'findByOwnerAndOrder',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }

  static async findPendingByOwner(ownerId: string): Promise<CommerceReviewModelSchema[]> {
    try {
      return await this.table
        .where('owner_id')
        .equals(ownerId)
        .and((row) => row.sync_status === 'pending')
        .toArray();
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to read pending reviews from ${this.table.name}`, {
        service: ErrorService.Local,
        operation: 'findPendingByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }

  /** All of the user's own published review rows, newest update first. */
  static async findByOwner(ownerId: string): Promise<CommerceReviewModelSchema[]> {
    try {
      const rows = await this.table.where('owner_id').equals(ownerId).toArray();
      return rows.sort((left, right) => right.updated_at - left.updated_at);
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to read own reviews from ${this.table.name}`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceReviewResponseModel
  extends RecordModelBase<string, CommerceReviewResponseModelSchema>
  implements CommerceReviewResponseModelSchema
{
  static table: Table<CommerceReviewResponseModelSchema> = db.table('commerce_review_responses');

  owner_id: string;
  review_id: string;
  reviewer_id: string;
  record: CommerceReviewResponseModelSchema['record'];
  sync_status: CommerceReviewResponseModelSchema['sync_status'];
  updated_at: number;

  constructor(response: CommerceReviewResponseModelSchema) {
    super(response);
    this.owner_id = response.owner_id;
    this.review_id = response.review_id;
    this.reviewer_id = response.reviewer_id;
    this.record = response.record;
    this.sync_status = response.sync_status;
    this.updated_at = response.updated_at;
  }

  static async findPendingByOwner(ownerId: string): Promise<CommerceReviewResponseModelSchema[]> {
    try {
      return await this.table
        .where('owner_id')
        .equals(ownerId)
        .and((row) => row.sync_status === 'pending')
        .toArray();
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to read pending responses from ${this.table.name}`, {
        service: ErrorService.Local,
        operation: 'findPendingByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceListingModel
  extends RecordModelBase<string, CommerceListingModelSchema>
  implements CommerceListingModelSchema
{
  static table: Table<CommerceListingModelSchema> = db.table('commerce_listings');

  seller_id: string;
  listing_id: string;
  record: CommerceListingModelSchema['record'];
  revision: number;
  state: CommerceListingModelSchema['state'];
  category_id: string;
  format: CommerceListingModelSchema['format'];
  currency: string;
  price_minor: number;
  sync_status: CommerceListingModelSchema['sync_status'];
  registration_status: CommerceListingModelSchema['registration_status'];
  updated_at: number;
  write_id: CommerceListingModelSchema['write_id'];
  auction_registration: CommerceListingModelSchema['auction_registration'];
  read_back_pending_since: CommerceListingModelSchema['read_back_pending_since'];

  constructor(listing: CommerceListingModelSchema) {
    super(listing);
    this.seller_id = listing.seller_id;
    this.listing_id = listing.listing_id;
    this.record = listing.record;
    this.revision = listing.revision;
    this.state = listing.state;
    this.category_id = listing.category_id;
    this.format = listing.format;
    this.currency = listing.currency;
    this.price_minor = listing.price_minor;
    this.sync_status = listing.sync_status;
    this.registration_status = listing.registration_status;
    this.updated_at = listing.updated_at;
    this.write_id = listing.write_id;
    this.auction_registration = listing.auction_registration;
    this.read_back_pending_since = listing.read_back_pending_since;
  }

  static async findBySeller(sellerId: string): Promise<CommerceListingModelSchema[]> {
    return await this.findAndSort('seller_id', sellerId);
  }

  static async findByCompositeIds(ids: string[]): Promise<CommerceListingModelSchema[]> {
    return (await this.findByIdsPreserveOrder(ids)).filter(
      (listing): listing is CommerceListingModelSchema => listing !== undefined,
    );
  }

  static async findByCategory(categoryId: string): Promise<CommerceListingModelSchema[]> {
    return await this.findAndSort('category_id', categoryId);
  }

  static async findAllSorted(): Promise<CommerceListingModelSchema[]> {
    try {
      return await this.table.orderBy('updated_at').reverse().toArray();
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to read sorted records from ${this.table.name}`, {
        service: ErrorService.Local,
        operation: 'findAllSorted',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }

  private static async findAndSort(index: 'seller_id' | 'category_id', value: string) {
    try {
      const listings = await this.table.where(index).equals(value).toArray();
      return listings.sort((left, right) => right.updated_at - left.updated_at);
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by ${index}`, {
        service: ErrorService.Local,
        operation: 'findAndSort',
        context: { table: this.table.name, index },
        cause: error,
      });
    }
  }
}

export class CommerceCatalogEntryModel
  extends RecordModelBase<string, CommerceCatalogEntryModelSchema>
  implements CommerceCatalogEntryModelSchema
{
  static table: Table<CommerceCatalogEntryModelSchema> = db.table('commerce_catalog_entries');

  seller_id: string;
  listing_id: string;
  state: CommerceCatalogEntryModelSchema['state'];
  title: string;
  description: string;
  category_id: string;
  condition: CommerceCatalogEntryModelSchema['condition'];
  tags: string[];
  country_code: string;
  region: string | null;
  media_urls: string[];
  sale_format: CommerceCatalogEntryModelSchema['sale_format'];
  price: CommerceCatalogEntryModelSchema['price'];
  auction: CommerceCatalogEntryModelSchema['auction'];
  fulfillment_methods: CommerceCatalogEntryModelSchema['fulfillment_methods'];
  reputation: CommerceCatalogEntryModelSchema['reputation'];
  listing_reputation: CommerceCatalogEntryModelSchema['listing_reputation'];
  revision: number;
  updated_at: number;

  constructor(entry: CommerceCatalogEntryModelSchema) {
    super(entry);
    this.seller_id = entry.seller_id;
    this.listing_id = entry.listing_id;
    this.state = entry.state;
    this.title = entry.title;
    this.description = entry.description;
    this.category_id = entry.category_id;
    this.condition = entry.condition;
    this.tags = entry.tags;
    this.country_code = entry.country_code;
    this.region = entry.region;
    this.media_urls = entry.media_urls;
    this.sale_format = entry.sale_format;
    this.price = entry.price;
    this.auction = entry.auction;
    // Entries cached before the model carried the vocabulary: honest absence.
    this.fulfillment_methods = entry.fulfillment_methods ?? null;
    this.reputation = entry.reputation ?? null;
    this.listing_reputation = entry.listing_reputation ?? null;
    this.revision = entry.revision;
    this.updated_at = entry.updated_at;
  }

  static async findBySeller(sellerId: string): Promise<CommerceCatalogEntryModelSchema[]> {
    try {
      const entries = await this.table.where('seller_id').equals(sellerId).toArray();
      return entries.sort((left, right) => right.updated_at - left.updated_at);
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by seller`, {
        service: ErrorService.Local,
        operation: 'findBySeller',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }

  static async findAllSorted(): Promise<CommerceCatalogEntryModelSchema[]> {
    try {
      return await this.table.orderBy('updated_at').reverse().toArray();
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to read sorted records from ${this.table.name}`, {
        service: ErrorService.Local,
        operation: 'findAllSorted',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceListingDraftModel
  extends RecordModelBase<string, CommerceListingDraftModelSchema>
  implements CommerceListingDraftModelSchema
{
  static table: Table<CommerceListingDraftModelSchema> = db.table('commerce_listing_drafts');

  owner_id: string;
  listing_id: string;
  data: CommerceListingDraftModelSchema['data'];
  created_at: number;
  updated_at: number;
  media_blobs?: Record<string, Blob>;

  constructor(draft: CommerceListingDraftModelSchema) {
    super(draft);
    this.owner_id = draft.owner_id;
    this.listing_id = draft.listing_id;
    this.data = draft.data;
    this.created_at = draft.created_at;
    this.updated_at = draft.updated_at;
    this.media_blobs = draft.media_blobs;
  }

  static async findByOwner(ownerId: string): Promise<CommerceListingDraftModelSchema[]> {
    try {
      const drafts = await this.table.where('owner_id').equals(ownerId).toArray();
      return drafts.sort((left, right) => right.updated_at - left.updated_at);
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceListingProjectionModel
  extends RecordModelBase<string, CommerceListingProjectionModelSchema>
  implements CommerceListingProjectionModelSchema
{
  static table: Table<CommerceListingProjectionModelSchema> = db.table('commerce_listing_projections');

  seller_id: string;
  listing_id: string;
  listing_revision: number;
  content_hash: string;
  server_revision: number;
  state: CommerceListingProjectionModelSchema['state'];
  available_quantity: number;
  current_price: CommerceListingProjectionModelSchema['current_price'];
  auction_state: CommerceListingProjectionModelSchema['auction_state'];
  bid_count: number;
  sync_status: CommerceListingProjectionModelSchema['sync_status'];
  synced_at: number;

  constructor(projection: CommerceListingProjectionModelSchema) {
    super(projection);
    this.seller_id = projection.seller_id;
    this.listing_id = projection.listing_id;
    this.listing_revision = projection.listing_revision;
    this.content_hash = projection.content_hash;
    this.server_revision = projection.server_revision;
    this.state = projection.state;
    this.available_quantity = projection.available_quantity;
    this.current_price = projection.current_price;
    this.auction_state = projection.auction_state;
    this.bid_count = projection.bid_count;
    this.sync_status = projection.sync_status;
    this.synced_at = projection.synced_at;
  }
}

export class CommerceSyncJobModel
  extends RecordModelBase<string, CommerceSyncJobModelSchema>
  implements CommerceSyncJobModelSchema
{
  static table: Table<CommerceSyncJobModelSchema> = db.table('commerce_sync_jobs');

  owner_id: string;
  entity_type: CommerceSyncJobModelSchema['entity_type'];
  entity_id: string;
  operation: CommerceSyncJobModelSchema['operation'];
  status: CommerceSyncJobModelSchema['status'];
  attempts: number;
  next_attempt_at: number;
  last_error_code: string | null;
  payload: CommerceSyncJobModelSchema['payload'];
  created_at: number;
  updated_at: number;

  constructor(job: CommerceSyncJobModelSchema) {
    super(job);
    this.owner_id = job.owner_id;
    this.entity_type = job.entity_type;
    this.entity_id = job.entity_id;
    this.operation = job.operation;
    this.status = job.status;
    this.attempts = job.attempts;
    this.next_attempt_at = job.next_attempt_at;
    this.last_error_code = job.last_error_code;
    this.payload = job.payload;
    this.created_at = job.created_at;
    this.updated_at = job.updated_at;
  }
}

export class CommerceFavoriteModel
  extends RecordModelBase<string, CommerceFavoriteModelSchema>
  implements CommerceFavoriteModelSchema
{
  static table: Table<CommerceFavoriteModelSchema> = db.table('commerce_favorites');

  owner_id: string;
  listing_id: string;
  created_at: number;

  constructor(favorite: CommerceFavoriteModelSchema) {
    super(favorite);
    this.owner_id = favorite.owner_id;
    this.listing_id = favorite.listing_id;
    this.created_at = favorite.created_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceFavoriteModelSchema[]> {
    try {
      return await this.table.where('owner_id').equals(ownerId).sortBy('created_at');
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceWatchTombstoneModel
  extends RecordModelBase<string, CommerceWatchTombstoneModelSchema>
  implements CommerceWatchTombstoneModelSchema
{
  static table: Table<CommerceWatchTombstoneModelSchema> = db.table('commerce_watch_tombstones');

  owner_id: string;
  listing_id: string;
  removed_at: number;

  constructor(tombstone: CommerceWatchTombstoneModelSchema) {
    super(tombstone);
    this.owner_id = tombstone.owner_id;
    this.listing_id = tombstone.listing_id;
    this.removed_at = tombstone.removed_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceWatchTombstoneModelSchema[]> {
    try {
      return await this.table.where('owner_id').equals(ownerId).sortBy('removed_at');
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceShopFollowModel
  extends RecordModelBase<string, CommerceShopFollowModelSchema>
  implements CommerceShopFollowModelSchema
{
  static table: Table<CommerceShopFollowModelSchema> = db.table('commerce_shop_follows');

  owner_id: string;
  seller_id: string;
  created_at: number;

  constructor(follow: CommerceShopFollowModelSchema) {
    super(follow);
    this.owner_id = follow.owner_id;
    this.seller_id = follow.seller_id;
    this.created_at = follow.created_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceShopFollowModelSchema[]> {
    try {
      return await this.table.where('owner_id').equals(ownerId).sortBy('created_at');
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceCartItemModel
  extends RecordModelBase<string, CommerceCartItemModelSchema>
  implements CommerceCartItemModelSchema
{
  static table: Table<CommerceCartItemModelSchema> = db.table('commerce_cart_items');

  owner_id: string;
  listing_id: string;
  variant_id: string;
  quantity: number;
  award_id?: string | null;
  award_offer_revision?: number | null;
  pricing_source?: 'listing' | 'offer';
  added_at: number;
  updated_at: number;

  constructor(item: CommerceCartItemModelSchema) {
    super(item);
    this.owner_id = item.owner_id;
    this.listing_id = item.listing_id;
    this.variant_id = item.variant_id;
    this.quantity = item.quantity;
    this.award_id = item.award_id ?? null;
    this.award_offer_revision = item.award_offer_revision ?? null;
    this.pricing_source = item.pricing_source ?? 'listing';
    this.added_at = item.added_at;
    this.updated_at = item.updated_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceCartItemModelSchema[]> {
    try {
      return await this.table.where('owner_id').equals(ownerId).sortBy('updated_at');
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceWatchSnapshotModel
  extends RecordModelBase<string, CommerceWatchSnapshotModelSchema>
  implements CommerceWatchSnapshotModelSchema
{
  static table: Table<CommerceWatchSnapshotModelSchema> = db.table('commerce_watch_snapshots');

  owner_id: string;
  listing_id: string;
  title: string;
  index_revision: number | null;
  index_state: CommerceWatchSnapshotModelSchema['index_state'];
  price_minor: number | null;
  price_currency: string | null;
  price_exponent: number | null;
  auction_ends_at: string | null;
  server_revision: number | null;
  projection_state: CommerceWatchSnapshotModelSchema['projection_state'];
  bid_count: number | null;
  bid_amount_minor: number | null;
  leader_pubky: string | null;
  ending_soon_alerted_ends_at: string | null;
  checked_at: number;

  constructor(snapshot: CommerceWatchSnapshotModelSchema) {
    super(snapshot);
    this.owner_id = snapshot.owner_id;
    this.listing_id = snapshot.listing_id;
    this.title = snapshot.title;
    this.index_revision = snapshot.index_revision;
    this.index_state = snapshot.index_state;
    this.price_minor = snapshot.price_minor;
    this.price_currency = snapshot.price_currency;
    this.price_exponent = snapshot.price_exponent;
    this.auction_ends_at = snapshot.auction_ends_at;
    this.server_revision = snapshot.server_revision;
    this.projection_state = snapshot.projection_state;
    this.bid_count = snapshot.bid_count;
    this.bid_amount_minor = snapshot.bid_amount_minor;
    this.leader_pubky = snapshot.leader_pubky;
    this.ending_soon_alerted_ends_at = snapshot.ending_soon_alerted_ends_at;
    this.checked_at = snapshot.checked_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceWatchSnapshotModelSchema[]> {
    try {
      return await this.table.where('owner_id').equals(ownerId).toArray();
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceWatchAlertModel
  extends RecordModelBase<string, CommerceWatchAlertModelSchema>
  implements CommerceWatchAlertModelSchema
{
  static table: Table<CommerceWatchAlertModelSchema> = db.table('commerce_watch_alerts');

  owner_id: string;
  listing_id: string;
  seller_id: string;
  kind: CommerceWatchAlertModelSchema['kind'];
  title: string;
  source: CommerceWatchAlertModelSchema['source'];
  observed_revision: number;
  ends_at: string | null;
  previous_amount_minor: number | null;
  current_amount_minor: number | null;
  currency: string | null;
  exponent: number | null;
  bid_count: number | null;
  previous_state: string | null;
  next_state: string | null;
  created_at: number;
  seen_at: number | null;

  constructor(alert: CommerceWatchAlertModelSchema) {
    super(alert);
    this.owner_id = alert.owner_id;
    this.listing_id = alert.listing_id;
    this.seller_id = alert.seller_id;
    this.kind = alert.kind;
    this.title = alert.title;
    this.source = alert.source;
    this.observed_revision = alert.observed_revision;
    this.ends_at = alert.ends_at;
    this.previous_amount_minor = alert.previous_amount_minor;
    this.current_amount_minor = alert.current_amount_minor;
    this.currency = alert.currency;
    this.exponent = alert.exponent;
    this.bid_count = alert.bid_count;
    this.previous_state = alert.previous_state;
    this.next_state = alert.next_state;
    this.created_at = alert.created_at;
    this.seen_at = alert.seen_at;
  }

  static async findByOwnerNewestFirst(ownerId: string): Promise<CommerceWatchAlertModelSchema[]> {
    try {
      const alerts = await this.table.where('owner_id').equals(ownerId).sortBy('created_at');
      return alerts.reverse();
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwnerNewestFirst',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceActivityCheckpointModel
  extends RecordModelBase<string, CommerceActivityCheckpointModelSchema>
  implements CommerceActivityCheckpointModelSchema
{
  static table: Table<CommerceActivityCheckpointModelSchema> = db.table('commerce_activity_checkpoints');

  owner_id: string;
  last_read_at: number;

  constructor(checkpoint: CommerceActivityCheckpointModelSchema) {
    super(checkpoint);
    this.owner_id = checkpoint.owner_id;
    this.last_read_at = checkpoint.last_read_at;
  }
}

export class CommerceSavedSearchModel
  extends RecordModelBase<string, CommerceSavedSearchModelSchema>
  implements CommerceSavedSearchModelSchema
{
  static table: Table<CommerceSavedSearchModelSchema> = db.table('commerce_saved_searches');

  owner_id: string;
  name: string;
  params: CommerceSavedSearchModelSchema['params'];
  watermark_updated_at: number;
  latest_match_updated_at: number;
  new_count: number;
  last_checked_at: number | null;
  created_at: number;

  constructor(search: CommerceSavedSearchModelSchema) {
    super(search);
    this.owner_id = search.owner_id;
    this.name = search.name;
    this.params = search.params;
    this.watermark_updated_at = search.watermark_updated_at;
    this.latest_match_updated_at = search.latest_match_updated_at;
    this.new_count = search.new_count;
    this.last_checked_at = search.last_checked_at;
    this.created_at = search.created_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceSavedSearchModelSchema[]> {
    try {
      return await this.table.where('owner_id').equals(ownerId).sortBy('created_at');
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceLocksCorrelationModel
  extends RecordModelBase<string, CommerceLocksCorrelationModelSchema>
  implements CommerceLocksCorrelationModelSchema
{
  static table: Table<CommerceLocksCorrelationModelSchema> = db.table('commerce_locks_correlations');

  owner_id: string;
  payment_id: string;
  order_id: string;
  seller_pubky: string;
  bundle_id: string;
  policy_uri: string;
  criterion_id: string;
  content_path: string;
  resource_hash: string;
  window_expires_at: string | null;
  registered: boolean;
  created_at: number;
  updated_at: number;

  constructor(correlation: CommerceLocksCorrelationModelSchema) {
    super(correlation);
    this.owner_id = correlation.owner_id;
    this.payment_id = correlation.payment_id;
    this.order_id = correlation.order_id;
    this.seller_pubky = correlation.seller_pubky;
    this.bundle_id = correlation.bundle_id;
    this.policy_uri = correlation.policy_uri;
    this.criterion_id = correlation.criterion_id;
    this.content_path = correlation.content_path;
    this.resource_hash = correlation.resource_hash;
    this.window_expires_at = correlation.window_expires_at;
    this.registered = correlation.registered;
    this.created_at = correlation.created_at;
    this.updated_at = correlation.updated_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceLocksCorrelationModelSchema[]> {
    try {
      return await this.table.where('owner_id').equals(ownerId).sortBy('updated_at');
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceDeliveryAddressModel
  extends RecordModelBase<string, CommerceDeliveryAddressModelSchema>
  implements CommerceDeliveryAddressModelSchema
{
  static table: Table<CommerceDeliveryAddressModelSchema> = db.table('commerce_delivery_addresses');

  owner_id: string;
  label: string;
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postal_code: string;
  country_code: string;
  is_default: boolean;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;

  constructor(address: CommerceDeliveryAddressModelSchema) {
    super(address);
    this.owner_id = address.owner_id;
    this.label = address.label;
    this.name = address.name;
    this.line1 = address.line1;
    this.line2 = address.line2;
    this.city = address.city;
    this.region = address.region;
    this.postal_code = address.postal_code;
    this.country_code = address.country_code;
    this.is_default = address.is_default;
    this.last_used_at = address.last_used_at;
    this.created_at = address.created_at;
    this.updated_at = address.updated_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceDeliveryAddressModelSchema[]> {
    try {
      return await this.table.where('owner_id').equals(ownerId).sortBy('updated_at');
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceShippingPresetModel
  extends RecordModelBase<string, CommerceShippingPresetModelSchema>
  implements CommerceShippingPresetModelSchema
{
  static table: Table<CommerceShippingPresetModelSchema> = db.table('commerce_shipping_presets');

  owner_id: string;
  label: string;
  price_minor: number;
  currency: string;
  estimated_min_days: number;
  estimated_max_days: number;
  created_at: number;
  updated_at: number;

  constructor(preset: CommerceShippingPresetModelSchema) {
    super(preset);
    this.owner_id = preset.owner_id;
    this.label = preset.label;
    this.price_minor = preset.price_minor;
    this.currency = preset.currency;
    this.estimated_min_days = preset.estimated_min_days;
    this.estimated_max_days = preset.estimated_max_days;
    this.created_at = preset.created_at;
    this.updated_at = preset.updated_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceShippingPresetModelSchema[]> {
    try {
      return await this.table.where('owner_id').equals(ownerId).sortBy('updated_at');
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}
