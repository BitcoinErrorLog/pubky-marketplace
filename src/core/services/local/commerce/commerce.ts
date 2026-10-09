import { db } from '@/database/franky/franky';
import {
  decodeListingDraftBlobs,
  encodeListingDraftBlobs,
  listingDraftBlobBytes,
  parseListingDraftMediaRefs,
  planListingDraftBlobTrim,
  planListingDraftEviction,
} from '@/libs/commerce/listing-drafts';
import type { CommerceListingRecord, CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { DatabaseErrorCode, ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { isAppError } from '@/libs/error/error.utils';
import {
  CommerceActivityCheckpointModel,
  CommerceCartItemModel,
  CommerceCatalogEntryModel,
  CommerceDeliveryAddressModel,
  CommerceFavoriteModel,
  CommerceListingDraftModel,
  CommerceListingModel,
  CommerceListingProjectionModel,
  CommerceLocksCorrelationModel,
  CommerceReviewModel,
  CommerceReviewResponseModel,
  CommerceSavedSearchModel,
  CommerceShippingPresetModel,
  CommerceShopFollowModel,
  CommerceShopModel,
  CommerceSyncJobModel,
  CommerceWatchAlertModel,
  CommerceWatchSnapshotModel,
  CommerceWatchTombstoneModel,
} from '@/models/commerce/commerce.models';
import type {
  CommerceAuctionRegistrationCommand,
  CommerceCacheStatus,
  CommerceCatalogEntryModelSchema,
  CommerceDeliveryAddressModelSchema,
  CommerceListingDraftData,
  CommerceListingDraftModelSchema,
  CommerceListingModelSchema,
  CommerceListingProjectionModelSchema,
  CommerceListingRegistrationStatus,
  CommerceLocksCorrelationModelSchema,
  CommerceReviewModelSchema,
  CommerceReviewResponseModelSchema,
  CommerceSavedSearchModelSchema,
  CommerceShippingPresetModelSchema,
  CommerceShopModelSchema,
  CommerceSyncJobModelSchema,
  CommerceWatchAlertModelSchema,
  CommerceWatchSnapshotModelSchema,
  CommerceWatchTombstoneModelSchema,
} from '@/models/commerce/commerce.schema';
import { isListingReadBackPending } from '@/models/commerce/commerce.schema';
import type { CommerceDeliveryAddressInput, CommerceShippingPresetInput } from '@/pipes/commerce/commerce.normalizer';

/** A listing row's write id as read, or null when no row existed. */
export type CommerceListingRowGeneration = { writeId: string | undefined } | null;

/**
 * An absent row has no identity that survives delete and re-create, so an
 * observation of absence never matches: it could equal a later absence
 * after a create and a delete. Write ids are fresh per write, re-creates
 * included, so a present row's id never repeats.
 */
function sameListingRowGeneration(
  observed: CommerceListingRowGeneration,
  current: CommerceListingModelSchema | undefined,
): current is CommerceListingModelSchema {
  if (observed === null || current === undefined) return false;
  return current.write_id === observed.writeId;
}

function withoutAuctionRegistration(listing: CommerceListingModelSchema): CommerceListingModelSchema {
  const { auction_registration: _dropped, ...rest } = listing;
  return rest;
}

/** Alert rows kept per account; older rows are pruned when new alerts land. */
export const COMMERCE_WATCH_ALERTS_MAX_PER_OWNER = 100;

export class LocalCommerceService {
  private constructor() {}

  static async getShop(ownerId: string) {
    return await CommerceShopModel.findById(ownerId);
  }

  static async getAllShops(): Promise<CommerceShopModelSchema[]> {
    return await CommerceShopModel.findAllSorted();
  }

  static async isFavorite(ownerId: string, listingId: string): Promise<boolean> {
    return await CommerceFavoriteModel.exists(this.favoriteId(ownerId, listingId));
  }

  static async getCartItems(ownerId: string) {
    return await CommerceCartItemModel.findByOwner(ownerId);
  }

  static async upsertCartItem(
    ownerId: string,
    listingId: string,
    variantId: string,
    quantity: number,
    now: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Cart quantity must be a positive safe integer.', {
        service: ErrorService.Local,
        operation: 'upsertCartItem',
        context: { quantity },
      });
    }
    const listing = await CommerceListingModel.findById(listingId);
    const variant = listing?.record.variants.find(({ id, enabled }) => id === variantId && enabled);
    if (!listing || !variant || quantity > variant.quantity) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Cart item is unavailable in the requested quantity.', {
        service: ErrorService.Local,
        operation: 'upsertCartItem',
        context: { listingFound: Boolean(listing), variantFound: Boolean(variant), quantity },
      });
    }
    const id = this.cartItemId(ownerId, listingId, variantId);
    const current = await CommerceCartItemModel.findById(id);
    await CommerceCartItemModel.upsert({
      id,
      owner_id: ownerId,
      listing_id: listingId,
      variant_id: variantId,
      quantity,
      added_at: current?.added_at ?? now,
      updated_at: now,
    });
  }

  static async upsertAwardCartItem(
    ownerId: string,
    listingId: string,
    variantId: string,
    quantity: number,
    awardId: string,
    offerRevision: number,
    now: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Cart quantity must be a positive safe integer.', {
        service: ErrorService.Local,
        operation: 'upsertAwardCartItem',
        context: { quantity },
      });
    }
    const id = this.awardCartItemId(ownerId, awardId);
    const current = await CommerceCartItemModel.findById(id);
    await CommerceCartItemModel.upsert({
      id,
      owner_id: ownerId,
      listing_id: listingId,
      variant_id: variantId,
      quantity,
      award_id: awardId,
      award_offer_revision: offerRevision,
      pricing_source: 'offer',
      added_at: current?.added_at ?? now,
      updated_at: now,
    });
  }

  static async deleteCartItem(ownerId: string, listingId: string, variantId: string, awardId?: string): Promise<void> {
    await CommerceCartItemModel.deleteById(
      awardId ? this.awardCartItemId(ownerId, awardId) : this.cartItemId(ownerId, listingId, variantId),
    );
  }

  static async clearCart(ownerId: string): Promise<void> {
    try {
      await CommerceCartItemModel.table
        .where('owner_id')
        .equals(ownerId)
        .and(({ pricing_source }) => pricing_source !== 'offer')
        .delete();
    } catch (error) {
      throw Err.database(DatabaseErrorCode.DELETE_FAILED, 'Failed to clear commerce cart', {
        service: ErrorService.Local,
        operation: 'clearCart',
        context: { table: CommerceCartItemModel.table.name },
        cause: error,
      });
    }
  }

  static async getFavorites(ownerId: string) {
    return await CommerceFavoriteModel.findByOwner(ownerId);
  }

  static async createFavorite(ownerId: string, listingId: string, now: number): Promise<void> {
    const id = this.favoriteId(ownerId, listingId);
    // The watch and its tombstone are two halves of one mergeable fact, so
    // they must change together: a re-added watch clears its tombstone.
    await db.transaction('rw', CommerceFavoriteModel.table, CommerceWatchTombstoneModel.table, async () => {
      await CommerceFavoriteModel.upsert({
        id,
        owner_id: ownerId,
        listing_id: listingId,
        created_at: now,
      });
      await CommerceWatchTombstoneModel.deleteById(id);
    });
  }

  static async deleteFavorite(ownerId: string, listingId: string, now: number): Promise<void> {
    const id = this.favoriteId(ownerId, listingId);
    // The tombstone makes the removal mergeable across devices: without it a
    // pull would resurrect the row from another device's older watch.
    await db.transaction('rw', CommerceFavoriteModel.table, CommerceWatchTombstoneModel.table, async () => {
      await CommerceFavoriteModel.deleteById(id);
      await CommerceWatchTombstoneModel.upsert({
        id,
        owner_id: ownerId,
        listing_id: listingId,
        removed_at: now,
      });
    });
  }

  static async getWatchTombstones(ownerId: string): Promise<CommerceWatchTombstoneModelSchema[]> {
    return await CommerceWatchTombstoneModel.findByOwner(ownerId);
  }

  /**
   * Applies a merged watchlist state atomically: favorites and tombstones are
   * rewritten to exactly the merged rows, and observation baselines
   * (`commerce_watch_snapshots`) of listings the merge removed are deleted so
   * an unwatched item can never produce another alert (same invariant as a
   * direct unwatch).
   */
  static async applyWatchlistState(
    ownerId: string,
    items: ReadonlyMap<string, number>,
    tombstones: ReadonlyMap<string, number>,
  ): Promise<void> {
    await db.transaction(
      'rw',
      CommerceFavoriteModel.table,
      CommerceWatchTombstoneModel.table,
      CommerceWatchSnapshotModel.table,
      async () => {
        const existingFavorites = await CommerceFavoriteModel.table.where('owner_id').equals(ownerId).toArray();
        for (const favorite of existingFavorites) {
          if (!items.has(favorite.listing_id)) {
            await CommerceFavoriteModel.deleteById(favorite.id);
            await CommerceWatchSnapshotModel.deleteById(favorite.id);
          }
        }
        for (const [listingId, watchedAt] of items) {
          await CommerceFavoriteModel.upsert({
            id: this.favoriteId(ownerId, listingId),
            owner_id: ownerId,
            listing_id: listingId,
            created_at: watchedAt,
          });
        }

        const existingTombstones = await CommerceWatchTombstoneModel.table.where('owner_id').equals(ownerId).toArray();
        for (const tombstone of existingTombstones) {
          if (!tombstones.has(tombstone.listing_id)) {
            await CommerceWatchTombstoneModel.deleteById(tombstone.id);
          }
        }
        for (const [listingId, removedAt] of tombstones) {
          await CommerceWatchTombstoneModel.upsert({
            id: this.favoriteId(ownerId, listingId),
            owner_id: ownerId,
            listing_id: listingId,
            removed_at: removedAt,
          });
        }
      },
    );
  }

  static async getWatchSnapshots(ownerId: string): Promise<CommerceWatchSnapshotModelSchema[]> {
    return await CommerceWatchSnapshotModel.findByOwner(ownerId);
  }

  static async deleteWatchSnapshot(ownerId: string, listingId: string): Promise<void> {
    await CommerceWatchSnapshotModel.deleteById(this.favoriteId(ownerId, listingId));
  }

  static async getWatchAlerts(ownerId: string): Promise<CommerceWatchAlertModelSchema[]> {
    return await CommerceWatchAlertModel.findByOwnerNewestFirst(ownerId);
  }

  /**
   * Persists one detection pass atomically: the advanced snapshots and the
   * alerts they produced. Alert ids are deterministic, and an id that already
   * exists is skipped rather than re-put so a re-detection can never reset an
   * alert's `seen_at`. Old alerts beyond {@link COMMERCE_WATCH_ALERTS_MAX_PER_OWNER}
   * are pruned oldest-first in the same transaction.
   */
  static async saveWatchDetection(
    ownerId: string,
    snapshots: CommerceWatchSnapshotModelSchema[],
    alerts: CommerceWatchAlertModelSchema[],
  ): Promise<void> {
    try {
      await db.transaction('rw', CommerceWatchSnapshotModel.table, CommerceWatchAlertModel.table, async () => {
        if (snapshots.length > 0) {
          await CommerceWatchSnapshotModel.bulkSave(snapshots);
        }
        if (alerts.length > 0) {
          const existing = new Set(
            await CommerceWatchAlertModel.table
              .where('id')
              .anyOf(alerts.map(({ id }) => id))
              .primaryKeys(),
          );
          const fresh = alerts.filter(({ id }) => !existing.has(id));
          if (fresh.length > 0) {
            await CommerceWatchAlertModel.bulkSave(fresh);
          }
        }
        const all = await CommerceWatchAlertModel.table.where('owner_id').equals(ownerId).sortBy('created_at');
        const excess = all.length - COMMERCE_WATCH_ALERTS_MAX_PER_OWNER;
        if (excess > 0) {
          await CommerceWatchAlertModel.table.bulkDelete(all.slice(0, excess).map(({ id }) => id));
        }
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to persist a watchlist detection pass', {
        service: ErrorService.Local,
        operation: 'saveWatchDetection',
        context: { tables: [CommerceWatchSnapshotModel.table.name, CommerceWatchAlertModel.table.name] },
        cause: error,
      });
    }
  }

  static async markWatchAlertsSeen(ownerId: string, now: number): Promise<void> {
    try {
      await CommerceWatchAlertModel.table
        .where('owner_id')
        .equals(ownerId)
        .filter(({ seen_at }) => seen_at === null)
        .modify({ seen_at: now });
    } catch (error) {
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to mark watchlist alerts seen', {
        service: ErrorService.Local,
        operation: 'markWatchAlertsSeen',
        context: { table: CommerceWatchAlertModel.table.name },
        cause: error,
      });
    }
  }

  /**
   * The device-local activity read checkpoint (ms epoch); `0` means this
   * device never opened an activity surface for this account.
   */
  static async getActivityReadCheckpoint(ownerId: string): Promise<number> {
    const checkpoint = await CommerceActivityCheckpointModel.findById(ownerId);
    return checkpoint?.last_read_at ?? 0;
  }

  /**
   * Moves the device-local activity read checkpoint forward (never
   * backward). Called when an activity surface is actually showing its rows
   * — the honest substitute for the read state the durable service does not
   * store (same doctrine as the messaging conversations' `last_read_at`).
   */
  static async markActivityRead(ownerId: string, now: number): Promise<void> {
    const current = await CommerceActivityCheckpointModel.findById(ownerId);
    if (current && current.last_read_at >= now) return;
    await CommerceActivityCheckpointModel.upsert({ id: ownerId, owner_id: ownerId, last_read_at: now });
  }

  static async getSavedSearches(ownerId: string): Promise<CommerceSavedSearchModelSchema[]> {
    return await CommerceSavedSearchModel.findByOwner(ownerId);
  }

  static async createSavedSearch(search: CommerceSavedSearchModelSchema): Promise<void> {
    await CommerceSavedSearchModel.upsert(search);
  }

  static async deleteSavedSearch(id: string): Promise<void> {
    await CommerceSavedSearchModel.deleteById(id);
  }

  /**
   * Records a completed saved-search check: how many matches exceeded the
   * acknowledged watermark and the newest match timestamp the watermark can
   * advance to when the user opens the search. Never moves the watermark
   * itself — only {@link acknowledgeSavedSearch} does that.
   */
  static async recordSavedSearchCheck(
    id: string,
    result: { newCount: number; latestMatchUpdatedAt: number; checkedAt: number },
  ): Promise<void> {
    await CommerceSavedSearchModel.update(id, {
      new_count: result.newCount,
      latest_match_updated_at: result.latestMatchUpdatedAt,
      last_checked_at: result.checkedAt,
    });
  }

  /** Advances the watermark to the newest checked match and clears the NEW count. */
  static async acknowledgeSavedSearch(id: string): Promise<void> {
    const search = await CommerceSavedSearchModel.findById(id);
    if (!search) return;
    await CommerceSavedSearchModel.update(id, {
      watermark_updated_at: Math.max(search.watermark_updated_at, search.latest_match_updated_at),
      new_count: 0,
    });
  }

  static async isShopFollowed(ownerId: string, sellerId: string): Promise<boolean> {
    return await CommerceShopFollowModel.exists(this.shopFollowId(ownerId, sellerId));
  }

  static async getShopFollows(ownerId: string) {
    return await CommerceShopFollowModel.findByOwner(ownerId);
  }

  static async createShopFollow(ownerId: string, sellerId: string, now: number): Promise<void> {
    await CommerceShopFollowModel.upsert({
      id: this.shopFollowId(ownerId, sellerId),
      owner_id: ownerId,
      seller_id: sellerId,
      created_at: now,
    });
  }

  static async deleteShopFollow(ownerId: string, sellerId: string): Promise<void> {
    await CommerceShopFollowModel.deleteById(this.shopFollowId(ownerId, sellerId));
  }

  static async upsertShop(record: CommerceShopRecord, syncStatus: CommerceCacheStatus): Promise<void> {
    await CommerceShopModel.upsert({
      id: record.ownerPubky,
      owner_id: record.ownerPubky,
      record,
      revision: record.revision,
      sync_status: syncStatus,
      updated_at: Date.parse(record.updatedAt),
    });
  }

  static async cacheRefreshedShop(
    record: CommerceShopRecord,
    previousRecord: CommerceShopRecord | null,
  ): Promise<CommerceShopRecord> {
    try {
      return await db.transaction('rw', CommerceShopModel.table, async () => {
        // A publication may have started or completed while the read was in flight.
        const local = await this.getShop(record.ownerPubky);
        if (
          local &&
          (local.sync_status !== 'synced' ||
            local.revision > record.revision ||
            // Two open editors can publish different records at the same revision.
            (local.revision === record.revision && JSON.stringify(local.record) !== JSON.stringify(previousRecord)))
        )
          return local.record;
        await this.upsertShop(record, 'synced');
        return record;
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to cache refreshed shop', {
        service: ErrorService.Local,
        operation: 'cacheRefreshedShop',
        context: { table: CommerceShopModel.table.name, id: record.ownerPubky },
        cause: error,
      });
    }
  }

  static async stageShopSync(record: CommerceShopRecord, job: CommerceSyncJobModelSchema): Promise<void> {
    this.assertSyncJobIdentity(job, record.ownerPubky, record.ownerPubky, 'shop');
    const shop = {
      id: record.ownerPubky,
      owner_id: record.ownerPubky,
      record,
      revision: record.revision,
      sync_status: 'pending' as const,
      updated_at: Date.parse(record.updatedAt),
    };

    try {
      await db.transaction('rw', CommerceShopModel.table, CommerceSyncJobModel.table, async () => {
        await CommerceShopModel.upsert(shop);
        await CommerceSyncJobModel.upsert(job);
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to stage shop synchronization', {
        service: ErrorService.Local,
        operation: 'stageShopSync',
        context: { tables: [CommerceShopModel.table.name, CommerceSyncJobModel.table.name] },
        cause: error,
      });
    }
  }

  static async getListing(compositeListingId: string) {
    return await CommerceListingModel.findById(compositeListingId);
  }

  static async getListingsByIds(compositeListingIds: string[]) {
    return await CommerceListingModel.findByCompositeIds(compositeListingIds);
  }

  static async cacheListingProjection(projection: CommerceListingProjectionModelSchema): Promise<void> {
    await CommerceListingProjectionModel.upsert(projection);
  }

  static async getCatalogEntry(compositeListingId: string) {
    return await CommerceCatalogEntryModel.findById(compositeListingId);
  }

  static async getAllCatalogEntries(): Promise<CommerceCatalogEntryModelSchema[]> {
    return await CommerceCatalogEntryModel.findAllSorted();
  }

  static async getCatalogEntriesBySeller(sellerId: string): Promise<CommerceCatalogEntryModelSchema[]> {
    return await CommerceCatalogEntryModel.findBySeller(sellerId);
  }

  static async bulkUpsertCatalogEntries(entries: CommerceCatalogEntryModelSchema[]): Promise<void> {
    await CommerceCatalogEntryModel.bulkSave(entries);
  }

  static async commitSellerCatalogRefresh(
    entries: CommerceCatalogEntryModelSchema[],
    records: CommerceListingRecord[],
  ): Promise<void> {
    try {
      await db.transaction('rw', CommerceCatalogEntryModel.table, CommerceListingModel.table, async () => {
        const currentListings = await CommerceListingModel.table.bulkGet(
          records.map((record) => `${record.ownerPubky}:${record.listingId}`),
        );
        const listings = records.map((record, index) => this.toListingModel(record, 'synced', currentListings[index]));
        await CommerceCatalogEntryModel.table.bulkPut(entries);
        await CommerceListingModel.table.bulkPut(listings);
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to commit seller catalog refresh', {
        service: ErrorService.Local,
        operation: 'commitSellerCatalogRefresh',
        context: {
          tables: [CommerceCatalogEntryModel.table.name, CommerceListingModel.table.name],
        },
        cause: error,
      });
    }
  }

  static async getListingsBySeller(sellerId: string): Promise<CommerceListingModelSchema[]> {
    return await CommerceListingModel.findBySeller(sellerId);
  }

  static async getListingsByCategory(categoryId: string): Promise<CommerceListingModelSchema[]> {
    return await CommerceListingModel.findByCategory(categoryId);
  }

  static async getAllListings(): Promise<CommerceListingModelSchema[]> {
    return await CommerceListingModel.findAllSorted();
  }

  static async upsertListing(record: CommerceListingRecord, syncStatus: CommerceCacheStatus): Promise<void> {
    const current = await CommerceListingModel.findById(`${record.ownerPubky}:${record.listingId}`);
    await CommerceListingModel.upsert(this.toListingModel(record, syncStatus, current ?? undefined));
  }

  /**
   * Marks a published listing synced only if its row is still exactly the
   * publish's generation (`expected`, from staging or the publish's own
   * later writes), in one transaction. Returns the new generation, or null
   * when anything else wrote the row since (a delete, another tab's publish
   * of the same revision) and nothing was written. `readBackPending` marks a
   * write the homeserver acked but has not served back yet.
   */
  static async markPublishedListingSynced(
    record: CommerceListingRecord,
    expected: CommerceListingRowGeneration,
    readBackPending = false,
  ): Promise<CommerceListingRowGeneration> {
    return await db.transaction('rw', CommerceListingModel.table, async () => {
      const current = await CommerceListingModel.table.get(`${record.ownerPubky}:${record.listingId}`);
      if (!sameListingRowGeneration(expected, current)) return null;
      const synced: CommerceListingModelSchema = {
        ...this.toListingModel(record, 'synced', current),
        ...(readBackPending ? { read_back_pending_since: Date.now() } : {}),
      };
      await CommerceListingModel.table.put(synced);
      return { writeId: synced.write_id };
    });
  }

  /** What {@link settleListingRegistration} compares: the row's write id, or null when there is no row. */
  static async getListingRowGeneration(compositeListingId: string): Promise<CommerceListingRowGeneration> {
    const listing = await CommerceListingModel.table.get(compositeListingId);
    return listing ? { writeId: listing.write_id } : null;
  }

  /** The row's generation, its persisted auction command, and its read-back marker, read together. */
  static async getListingRegistrationState(compositeListingId: string): Promise<{
    generation: CommerceListingRowGeneration;
    auctionRegistration: CommerceAuctionRegistrationCommand | null;
    readBackPending: boolean;
  }> {
    const listing = await CommerceListingModel.table.get(compositeListingId);
    return {
      generation: listing ? { writeId: listing.write_id } : null,
      auctionRegistration: listing?.auction_registration ?? null,
      readBackPending: listing ? isListingReadBackPending(listing) : false,
    };
  }

  /**
   * Stores the auction command on the row if it is still the observed
   * generation. Returns the row's new generation, or null when another write
   * landed first (or there is no row) and nothing was stored.
   */
  static async persistAuctionRegistration(
    compositeListingId: string,
    observed: CommerceListingRowGeneration,
    command: CommerceAuctionRegistrationCommand,
  ): Promise<CommerceListingRowGeneration> {
    try {
      return await db.transaction('rw', CommerceListingModel.table, async () => {
        const listing = await CommerceListingModel.table.get(compositeListingId);
        if (!sameListingRowGeneration(observed, listing)) return null;
        const writeId = crypto.randomUUID();
        await CommerceListingModel.table.put({ ...listing, auction_registration: command, write_id: writeId });
        return { writeId };
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to store a listing registration command', {
        service: ErrorService.Local,
        operation: 'persistAuctionRegistration',
        context: { tables: [CommerceListingModel.table.name] },
        cause: error,
      });
    }
  }

  /**
   * Applies a registration outcome only if the row existed when the caller
   * read it and is still that generation; any write since (a republish, a
   * refresh, another attempt's outcome, a deletion) wins, and this returns
   * false. An outcome read against no row is always refused, so it never
   * creates one. `record_deleted` removes a row only when it is a synced
   * cache with no sync job for the listing; a row with pending publication
   * state is kept and marked `not_found`. A row whose acked write was never
   * read back refuses both while {@link isListingReadBackPending}, so read lag
   * stays pending; `registered` clears that marker.
   */
  static async settleListingRegistration(
    compositeListingId: string,
    observed: CommerceListingRowGeneration,
    outcome: { status: CommerceListingRegistrationStatus } | { recordDeleted: true },
  ): Promise<boolean> {
    try {
      return await db.transaction(
        'rw',
        CommerceListingModel.table,
        CommerceListingProjectionModel.table,
        CommerceCatalogEntryModel.table,
        CommerceSyncJobModel.table,
        async () => {
          const listing = await CommerceListingModel.table.get(compositeListingId);
          if (!sameListingRowGeneration(observed, listing)) return false;
          if (isListingReadBackPending(listing) && ('recordDeleted' in outcome || outcome.status === 'not_found')) {
            return false;
          }
          if ('recordDeleted' in outcome) {
            const syncJobs = await CommerceSyncJobModel.table
              .where('entity_id')
              .equals(listing.listing_id)
              .filter((job) => job.entity_type === 'listing' && job.owner_id === listing.seller_id)
              .count();
            if (listing.sync_status === 'synced' && syncJobs === 0) {
              await CommerceListingModel.table.delete(compositeListingId);
              await CommerceListingProjectionModel.table.delete(compositeListingId);
              await CommerceCatalogEntryModel.table.delete(compositeListingId);
              return true;
            }
            await CommerceListingModel.table.put({
              ...withoutAuctionRegistration(listing),
              registration_status: 'not_found',
              write_id: crypto.randomUUID(),
            });
            return true;
          }
          const settled: CommerceListingModelSchema = {
            ...(outcome.status === 'not_found' ? withoutAuctionRegistration(listing) : listing),
            registration_status: outcome.status,
            write_id: crypto.randomUUID(),
          };
          if (outcome.status === 'registered') delete settled.read_back_pending_since;
          await CommerceListingModel.table.put(settled);
          return true;
        },
      );
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to settle a listing registration', {
        service: ErrorService.Local,
        operation: 'settleListingRegistration',
        context: {
          tables: [
            CommerceListingModel.table.name,
            CommerceListingProjectionModel.table.name,
            CommerceCatalogEntryModel.table.name,
            CommerceSyncJobModel.table.name,
          ],
        },
        cause: error,
      });
    }
  }

  /**
   * Removes a listing from every local surface at once: the canonical record
   * cache, the transaction-service projection cache, and the Nexus discovery
   * cache — so a seller's deleted listing disappears from the catalog grid
   * immediately instead of waiting for the index to re-sync.
   */
  static async deleteListing(compositeListingId: string): Promise<void> {
    try {
      await db.transaction(
        'rw',
        CommerceListingModel.table,
        CommerceListingProjectionModel.table,
        CommerceCatalogEntryModel.table,
        async () => {
          await CommerceListingModel.table.delete(compositeListingId);
          await CommerceListingProjectionModel.table.delete(compositeListingId);
          await CommerceCatalogEntryModel.table.delete(compositeListingId);
        },
      );
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.DELETE_FAILED, 'Failed to delete the local listing caches', {
        service: ErrorService.Local,
        operation: 'deleteListing',
        context: {
          tables: [
            CommerceListingModel.table.name,
            CommerceListingProjectionModel.table.name,
            CommerceCatalogEntryModel.table.name,
          ],
        },
        cause: error,
      });
    }
  }

  static async stageListingSync(
    record: CommerceListingRecord,
    job: CommerceSyncJobModelSchema,
    registrationStatus?: CommerceListingModelSchema['registration_status'],
  ): Promise<CommerceListingRowGeneration> {
    this.assertSyncJobIdentity(job, record.ownerPubky, record.listingId, 'listing');

    try {
      // The staged row's write id, read in the same transaction that wrote it: the publish's own generation.
      return await db.transaction('rw', CommerceListingModel.table, CommerceSyncJobModel.table, async () => {
        const current = await CommerceListingModel.table.get(`${record.ownerPubky}:${record.listingId}`);
        const listing = this.toListingModel(record, 'pending', {
          registration_status: registrationStatus ?? current?.registration_status,
          auction_registration: current?.auction_registration,
        });
        await CommerceListingModel.table.put(listing);
        await CommerceSyncJobModel.upsert(job);
        return { writeId: listing.write_id };
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to stage listing synchronization', {
        service: ErrorService.Local,
        operation: 'stageListingSync',
        context: { tables: [CommerceListingModel.table.name, CommerceSyncJobModel.table.name] },
        cause: error,
      });
    }
  }

  static async getOwnReviewById(compositeReviewId: string): Promise<CommerceReviewModelSchema | undefined> {
    return (await CommerceReviewModel.findById(compositeReviewId)) ?? undefined;
  }

  static async getOwnReviewByOrder(ownerId: string, orderId: string): Promise<CommerceReviewModelSchema | undefined> {
    return await CommerceReviewModel.findByOwnerAndOrder(ownerId, orderId);
  }

  static async getPendingOwnReviews(ownerId: string): Promise<CommerceReviewModelSchema[]> {
    return await CommerceReviewModel.findPendingByOwner(ownerId);
  }

  static async upsertOwnReview(review: CommerceReviewModelSchema): Promise<void> {
    await CommerceReviewModel.upsert(review);
  }

  /**
   * Stages an own-review publication: the local-first row (status `pending`)
   * and its sync job land in one transaction, so an interrupted publication
   * is visible and retryable rather than silently lost — the same retryable
   * pattern listing publication established.
   */
  static async stageOwnReviewSync(review: CommerceReviewModelSchema, job: CommerceSyncJobModelSchema): Promise<void> {
    this.assertSyncJobIdentity(job, review.owner_id, review.review_id, 'review');
    try {
      await db.transaction('rw', CommerceReviewModel.table, CommerceSyncJobModel.table, async () => {
        await CommerceReviewModel.upsert(review);
        await CommerceSyncJobModel.upsert(job);
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to stage review synchronization', {
        service: ErrorService.Local,
        operation: 'stageOwnReviewSync',
        context: { tables: [CommerceReviewModel.table.name, CommerceSyncJobModel.table.name] },
        cause: error,
      });
    }
  }

  /** All of the user's own published review rows, newest update first. */
  static async getOwnReviews(ownerId: string): Promise<CommerceReviewModelSchema[]> {
    return await CommerceReviewModel.findByOwner(ownerId);
  }

  static async getOwnReviewResponse(
    ownerId: string,
    reviewId: string,
  ): Promise<CommerceReviewResponseModelSchema | undefined> {
    return (await CommerceReviewResponseModel.findById(`${ownerId}:${reviewId}`)) ?? undefined;
  }

  static async getPendingOwnReviewResponses(ownerId: string): Promise<CommerceReviewResponseModelSchema[]> {
    return await CommerceReviewResponseModel.findPendingByOwner(ownerId);
  }

  static async upsertOwnReviewResponse(response: CommerceReviewResponseModelSchema): Promise<void> {
    await CommerceReviewResponseModel.upsert(response);
  }

  /**
   * Stages an own review-response publication: local-first row plus sync job
   * in one transaction — the same visible retryable-outbox pattern reviews
   * and listings use.
   */
  static async stageOwnReviewResponseSync(
    response: CommerceReviewResponseModelSchema,
    job: CommerceSyncJobModelSchema,
  ): Promise<void> {
    this.assertSyncJobIdentity(job, response.owner_id, response.review_id, 'review_response');
    try {
      await db.transaction('rw', CommerceReviewResponseModel.table, CommerceSyncJobModel.table, async () => {
        await CommerceReviewResponseModel.upsert(response);
        await CommerceSyncJobModel.upsert(job);
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to stage review response synchronization', {
        service: ErrorService.Local,
        operation: 'stageOwnReviewResponseSync',
        context: { tables: [CommerceReviewResponseModel.table.name, CommerceSyncJobModel.table.name] },
        cause: error,
      });
    }
  }

  static async upsertListingAndProjection(
    record: CommerceListingRecord,
    syncStatus: CommerceCacheStatus,
    projection: CommerceListingProjectionModelSchema,
  ): Promise<void> {
    const listing = this.toListingModel(record, syncStatus);
    if (listing.id !== projection.id || listing.revision !== projection.listing_revision) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        'Listing projection must match the public listing identity and revision.',
        {
          service: ErrorService.Local,
          operation: 'upsertListingAndProjection',
          context: {
            identityMatches: listing.id === projection.id,
            revisionMatches: listing.revision === projection.listing_revision,
          },
        },
      );
    }

    try {
      await db.transaction('rw', CommerceListingModel.table, CommerceListingProjectionModel.table, async () => {
        await CommerceListingModel.upsert(listing);
        await CommerceListingProjectionModel.upsert(projection);
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to persist listing and projection atomically', {
        service: ErrorService.Local,
        operation: 'upsertListingAndProjection',
        context: { tables: [CommerceListingModel.table.name, CommerceListingProjectionModel.table.name] },
        cause: error,
      });
    }
  }

  static async seedSandboxCatalog({
    shops,
    listings,
    projections,
  }: {
    shops: CommerceShopRecord[];
    listings: CommerceListingRecord[];
    projections: CommerceListingProjectionModelSchema[];
  }): Promise<boolean> {
    try {
      return await db.transaction(
        'rw',
        CommerceShopModel.table,
        CommerceListingModel.table,
        CommerceListingProjectionModel.table,
        async () => {
          if ((await CommerceListingModel.table.count()) > 0) return false;

          const shopModels: CommerceShopModelSchema[] = shops.map((record) => ({
            id: record.ownerPubky,
            owner_id: record.ownerPubky,
            record,
            revision: record.revision,
            sync_status: 'synced',
            updated_at: Date.parse(record.updatedAt),
          }));
          const listingModels = listings.map((record) => this.toListingModel(record, 'synced'));
          const listingRevisions = new Map(listingModels.map(({ id, revision }) => [id, revision]));
          const projectionsMatch = projections.every(
            ({ id, listing_revision }) => listingRevisions.get(id) === listing_revision,
          );
          if (!projectionsMatch) {
            throw Err.validation(
              ValidationErrorCode.INVALID_INPUT,
              'Sandbox projections must match their listing identities and revisions.',
              {
                service: ErrorService.Local,
                operation: 'seedSandboxCatalog',
              },
            );
          }

          await CommerceShopModel.bulkSave(shopModels);
          await CommerceListingModel.bulkSave(listingModels);
          await CommerceListingProjectionModel.bulkSave(projections);
          return true;
        },
      );
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to seed the sandbox marketplace catalog', {
        service: ErrorService.Local,
        operation: 'seedSandboxCatalog',
        context: {
          tables: [
            CommerceShopModel.table.name,
            CommerceListingModel.table.name,
            CommerceListingProjectionModel.table.name,
          ],
        },
        cause: error,
      });
    }
  }

  static async getListingProjection(compositeListingId: string) {
    return await CommerceListingProjectionModel.findById(compositeListingId);
  }

  static async getDraft(compositeListingId: string) {
    const draft = await CommerceListingDraftModel.findById(compositeListingId);
    return draft ? this.hydrateDraftBlobs(draft) : draft;
  }

  static async getDraftsByOwner(ownerId: string): Promise<CommerceListingDraftModelSchema[]> {
    const drafts = await CommerceListingDraftModel.findByOwner(ownerId);
    return drafts.map((draft) => this.hydrateDraftBlobs(draft));
  }

  static async upsertDraft({
    ownerId,
    listingId,
    data,
    now,
    mediaBlobs = {},
  }: {
    ownerId: string;
    listingId: string;
    data: CommerceListingDraftData;
    now: number;
    mediaBlobs?: Record<string, Blob>;
  }): Promise<void> {
    if (data.ownerPubky !== ownerId || data.listingId !== listingId) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Draft identity must match its account and listing.', {
        service: ErrorService.Local,
        operation: 'upsertDraft',
        context: {
          ownerMatches: data.ownerPubky === ownerId,
          listingMatches: data.listingId === listingId,
        },
      });
    }
    const id = `${ownerId}:${listingId}`;
    const existing = await CommerceListingDraftModel.findById(id);
    await this.writeDraftRow({
      id,
      owner_id: ownerId,
      listing_id: listingId,
      data,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      media_blobs: mediaBlobs,
    });
    await this.evictOwnerListingDrafts(ownerId, listingId);
  }

  private static hydrateDraftBlobs(draft: CommerceListingDraftModelSchema): CommerceListingDraftModelSchema {
    return { ...draft, media_blobs: decodeListingDraftBlobs(draft.media_blobs) };
  }

  private static async writeDraftRow(draft: CommerceListingDraftModelSchema): Promise<void> {
    await CommerceListingDraftModel.upsert({
      ...draft,
      media_blobs: (await encodeListingDraftBlobs(
        decodeListingDraftBlobs(draft.media_blobs),
      )) as unknown as CommerceListingDraftModelSchema['media_blobs'],
    });
  }

  private static async evictOwnerListingDrafts(ownerId: string, keepListingId: string): Promise<void> {
    const drafts = await this.getDraftsByOwner(ownerId);
    const rows = drafts.map((draft) => ({
      id: draft.id,
      listing_id: draft.listing_id,
      updated_at: draft.updated_at,
      blobBytes: listingDraftBlobBytes(draft.media_blobs),
      blobKeys: Object.keys(draft.media_blobs ?? {}),
    }));
    const { deleteIds } = planListingDraftEviction(rows, keepListingId);
    await Promise.all(deleteIds.map((draftId) => this.deleteDraft(draftId)));

    const remaining = await this.getDraftsByOwner(ownerId);
    const keep = remaining.find((draft) => draft.listing_id === keepListingId);
    if (!keep?.media_blobs || Object.keys(keep.media_blobs).length === 0) return;
    const otherBytes = remaining
      .filter((draft) => draft.listing_id !== keepListingId)
      .reduce((sum, draft) => sum + listingDraftBlobBytes(draft.media_blobs), 0);
    const dropKeys = planListingDraftBlobTrim(keep.media_blobs, otherBytes);
    if (dropKeys.length === 0) return;
    const drop = new Set(dropKeys);
    const nextBlobs = Object.fromEntries(Object.entries(keep.media_blobs).filter(([key]) => !drop.has(key)));
    const form = keep.data.form;
    const nextForm =
      form && typeof form === 'object' && !Array.isArray(form)
        ? {
            ...(form as Record<string, unknown>),
            mediaRefs: parseListingDraftMediaRefs((form as Record<string, unknown>).mediaRefs).filter(
              (ref) => ref.kind === 'existing' || !drop.has(ref.key),
            ),
          }
        : form;
    await this.writeDraftRow({
      ...keep,
      data: { ...keep.data, form: nextForm as CommerceListingDraftData['form'] },
      media_blobs: nextBlobs,
    });
  }

  static async deleteDraft(compositeListingId: string): Promise<void> {
    await CommerceListingDraftModel.deleteById(compositeListingId);
  }

  static async upsertSyncJob(job: CommerceSyncJobModelSchema): Promise<void> {
    await CommerceSyncJobModel.upsert(job);
  }

  static async getSyncJob(id: string) {
    return await CommerceSyncJobModel.findById(id);
  }

  static async completeSyncJob(id: string): Promise<void> {
    await CommerceSyncJobModel.deleteById(id);
  }

  /**
   * Upserts a coalescing job whose `updated_at` strictly increases on every
   * re-stage, even within one millisecond, so it can serve as the
   * generation {@link completeSyncJobIfUnchanged} compares.
   */
  static async restageSyncJob(job: CommerceSyncJobModelSchema): Promise<void> {
    await db.transaction('rw', CommerceSyncJobModel.table, async () => {
      const current = await CommerceSyncJobModel.findById(job.id);
      await CommerceSyncJobModel.upsert({
        ...job,
        created_at: current?.created_at ?? job.created_at,
        updated_at: Math.max(job.updated_at, (current?.updated_at ?? 0) + 1),
      });
    });
  }

  /**
   * Completes a job only if nobody re-staged it since `stagedAt` (its
   * `updated_at` when the caller's round began, or null when there was no
   * job). A change staged by another tab mid-round keeps the job pending.
   */
  static async completeSyncJobIfUnchanged(id: string, stagedAt: number | null): Promise<boolean> {
    return await db.transaction('rw', CommerceSyncJobModel.table, async () => {
      const current = await CommerceSyncJobModel.findById(id);
      if (!current) return true;
      if (stagedAt === null || current.updated_at !== stagedAt) return false;
      await CommerceSyncJobModel.deleteById(id);
      return true;
    });
  }

  /** `local` carries the locally owned columns a whole-row write must keep. */
  private static toListingModel(
    record: CommerceListingRecord,
    syncStatus: CommerceCacheStatus,
    local?: Pick<CommerceListingModelSchema, 'registration_status' | 'auction_registration'>,
  ): CommerceListingModelSchema {
    const price = record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice;
    return {
      id: `${record.ownerPubky}:${record.listingId}`,
      seller_id: record.ownerPubky,
      listing_id: record.listingId,
      record,
      revision: record.revision,
      state: record.state,
      category_id: record.categoryId,
      format: record.sale.format,
      currency: price.currency,
      price_minor: price.amountMinor,
      sync_status: syncStatus,
      registration_status: local?.registration_status,
      updated_at: Date.parse(record.updatedAt),
      write_id: crypto.randomUUID(),
      ...(local?.auction_registration ? { auction_registration: local.auction_registration } : {}),
    };
  }

  private static assertSyncJobIdentity(
    job: CommerceSyncJobModelSchema,
    ownerId: string,
    entityId: string,
    entityType: CommerceSyncJobModelSchema['entity_type'],
  ): void {
    const ownerMatches = job.owner_id === ownerId;
    const entityMatches = job.entity_id === entityId;
    const typeMatches = job.entity_type === entityType;
    if (!ownerMatches || !entityMatches || !typeMatches) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Sync job identity must match its public record.', {
        service: ErrorService.Local,
        operation: 'assertSyncJobIdentity',
        context: { ownerMatches, entityMatches, typeMatches },
      });
    }
  }

  /**
   * The buyer's private Locks payment correlation (see
   * `CommerceLocksCorrelationModelSchema` — the bundle id it carries is
   * bearer material and stays in this account-scoped table only).
   */
  static async getLocksCorrelation(ownerId: string, paymentId: string) {
    return await CommerceLocksCorrelationModel.findById(this.locksCorrelationId(ownerId, paymentId));
  }

  static async upsertLocksCorrelation(correlation: Omit<CommerceLocksCorrelationModelSchema, 'id'>): Promise<void> {
    await CommerceLocksCorrelationModel.upsert({
      ...correlation,
      id: this.locksCorrelationId(correlation.owner_id, correlation.payment_id),
    });
  }

  static async markLocksCorrelationRegistered(
    ownerId: string,
    paymentId: string,
    windowExpiresAt: string | null,
    now: number,
  ): Promise<void> {
    const current = await CommerceLocksCorrelationModel.findById(this.locksCorrelationId(ownerId, paymentId));
    if (!current) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, 'No Locks correlation exists for this payment.', {
        service: ErrorService.Local,
        operation: 'markLocksCorrelationRegistered',
      });
    }
    await CommerceLocksCorrelationModel.upsert({
      ...current,
      registered: true,
      window_expires_at: windowExpiresAt,
      updated_at: now,
    });
  }

  /**
   * The buyer's private address book, picker-ordered: default first, then by
   * most recent use, then by most recent edit. Addresses never leave this
   * device except inside the owner's own `checkout.create` command.
   */
  static async getDeliveryAddresses(ownerId: string): Promise<CommerceDeliveryAddressModelSchema[]> {
    const addresses = await CommerceDeliveryAddressModel.findByOwner(ownerId);
    return addresses.sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      const aUsed = a.last_used_at ?? 0;
      const bUsed = b.last_used_at ?? 0;
      if (aUsed !== bUsed) return bUsed - aUsed;
      return b.updated_at - a.updated_at;
    });
  }

  static async upsertDeliveryAddress(
    ownerId: string,
    addressId: string,
    input: CommerceDeliveryAddressInput,
    now: number,
  ): Promise<void> {
    const id = this.deliveryAddressId(ownerId, addressId);
    const current = await CommerceDeliveryAddressModel.findById(id);
    const existing = await CommerceDeliveryAddressModel.findByOwner(ownerId);
    await CommerceDeliveryAddressModel.upsert({
      id,
      owner_id: ownerId,
      label: input.label,
      name: input.name,
      line1: input.line1,
      line2: input.line2,
      city: input.city,
      region: input.region,
      postal_code: input.postalCode,
      country_code: input.countryCode,
      // The first saved address becomes the default so the picker always has
      // one; later saves never steal it.
      is_default: current?.is_default ?? existing.length === 0,
      last_used_at: current?.last_used_at ?? null,
      created_at: current?.created_at ?? now,
      updated_at: now,
    });
  }

  static async deleteDeliveryAddress(ownerId: string, addressId: string): Promise<void> {
    await CommerceDeliveryAddressModel.deleteById(this.deliveryAddressId(ownerId, addressId));
  }

  static async setDefaultDeliveryAddress(ownerId: string, addressId: string, now: number): Promise<void> {
    const id = this.deliveryAddressId(ownerId, addressId);
    try {
      await db.transaction('rw', CommerceDeliveryAddressModel.table, async () => {
        const target = await CommerceDeliveryAddressModel.table.get(id);
        if (!target) {
          throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'No such delivery address to set as default.', {
            service: ErrorService.Local,
            operation: 'setDefaultDeliveryAddress',
          });
        }
        await CommerceDeliveryAddressModel.table
          .where('owner_id')
          .equals(ownerId)
          .modify((address) => {
            const shouldBeDefault = address.id === id;
            if (address.is_default !== shouldBeDefault) {
              address.is_default = shouldBeDefault;
              address.updated_at = now;
            }
          });
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to set the default delivery address', {
        service: ErrorService.Local,
        operation: 'setDefaultDeliveryAddress',
        context: { table: CommerceDeliveryAddressModel.table.name },
        cause: error,
      });
    }
  }

  /** Records that an order was just placed with this address (drives "last used" picker ordering). */
  static async markDeliveryAddressUsed(ownerId: string, addressId: string, now: number): Promise<void> {
    const id = this.deliveryAddressId(ownerId, addressId);
    const current = await CommerceDeliveryAddressModel.findById(id);
    if (!current) return;
    await CommerceDeliveryAddressModel.upsert({ ...current, last_used_at: now });
  }

  /** The seller's shipping preset templates, most recently edited first. */
  static async getShippingPresets(ownerId: string): Promise<CommerceShippingPresetModelSchema[]> {
    const presets = await CommerceShippingPresetModel.findByOwner(ownerId);
    return presets.sort((a, b) => b.updated_at - a.updated_at);
  }

  static async upsertShippingPreset(
    ownerId: string,
    presetId: string,
    input: CommerceShippingPresetInput,
    now: number,
  ): Promise<void> {
    const id = this.shippingPresetId(ownerId, presetId);
    const current = await CommerceShippingPresetModel.findById(id);
    await CommerceShippingPresetModel.upsert({
      id,
      owner_id: ownerId,
      label: input.label,
      price_minor: input.priceMinor,
      currency: input.currency,
      estimated_min_days: input.estimatedMinDays,
      estimated_max_days: input.estimatedMaxDays,
      created_at: current?.created_at ?? now,
      updated_at: now,
    });
  }

  static async deleteShippingPreset(ownerId: string, presetId: string): Promise<void> {
    await CommerceShippingPresetModel.deleteById(this.shippingPresetId(ownerId, presetId));
  }

  private static deliveryAddressId(ownerId: string, addressId: string): string {
    return `${ownerId}:${addressId}`;
  }

  private static shippingPresetId(ownerId: string, presetId: string): string {
    return `${ownerId}:${presetId}`;
  }

  private static locksCorrelationId(ownerId: string, paymentId: string): string {
    return `${ownerId}|${paymentId}`;
  }

  private static favoriteId(ownerId: string, listingId: string): string {
    return `${ownerId}|${listingId}`;
  }

  private static shopFollowId(ownerId: string, sellerId: string): string {
    return `${ownerId}|${sellerId}`;
  }

  private static cartItemId(ownerId: string, listingId: string, variantId: string): string {
    return `${ownerId}|${listingId}|${variantId}`;
  }

  private static awardCartItemId(ownerId: string, awardId: string): string {
    return `${ownerId}|award|${awardId}`;
  }
}
