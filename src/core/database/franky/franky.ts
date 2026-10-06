import Dexie from 'dexie';
import { DB_INIT_MAX_ATTEMPTS, DB_INIT_RETRY_BASE_DELAY_MS, DB_NAME, DB_VERSION } from '@/config/database';
import {
  migrateMessagingHistoryToWrappedStorage,
  migrateMessagingSecretsToWrappedStorage,
} from '@/database/franky/franky.migrations';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import { type BookmarkModelSchema, bookmarkTableSchema } from '@/models/bookmark/bookmark.schema';
import {
  type CommerceActivityCheckpointModelSchema,
  commerceActivityCheckpointTableSchema,
  type CommerceCartItemModelSchema,
  commerceCartItemTableSchema,
  type CommerceCatalogEntryModelSchema,
  commerceCatalogEntryTableSchema,
  type CommerceDeliveryAddressModelSchema,
  commerceDeliveryAddressTableSchema,
  type CommerceFavoriteModelSchema,
  commerceFavoriteTableSchema,
  type CommerceImportManifestModelSchema,
  commerceImportManifestTableSchema,
  type CommerceImportMappingModelSchema,
  commerceImportMappingTableSchema,
  type CommerceImportRowModelSchema,
  commerceImportRowTableSchema,
  type CommerceListingDraftModelSchema,
  commerceListingDraftTableSchema,
  type CommerceListingModelSchema,
  type CommerceListingProjectionModelSchema,
  commerceListingProjectionTableSchema,
  commerceListingTableSchema,
  type CommerceLocksCorrelationModelSchema,
  commerceLocksCorrelationTableSchema,
  type CommerceReviewModelSchema,
  type CommerceReviewResponseModelSchema,
  commerceReviewResponseTableSchema,
  commerceReviewTableSchema,
  type CommerceSavedSearchModelSchema,
  commerceSavedSearchTableSchema,
  type CommerceShippingPresetModelSchema,
  commerceShippingPresetTableSchema,
  type CommerceShopFollowModelSchema,
  commerceShopFollowTableSchema,
  type CommerceShopModelSchema,
  commerceShopTableSchema,
  type CommerceSyncJobModelSchema,
  commerceSyncJobTableSchema,
  type CommerceWatchAlertModelSchema,
  commerceWatchAlertTableSchema,
  type CommerceWatchSnapshotModelSchema,
  commerceWatchSnapshotTableSchema,
  commerceWatchTombstoneTableSchema,
  type CommerceWebhookModelSchema,
  commerceWebhookTableSchema,
} from '@/models/commerce/commerce.schema';
import { type FeedModelSchema, feedTableSchema } from '@/models/feed/feed.schema';
import { type FileDetailsModelSchema, fileDetailsTableSchema } from '@/models/file/fileDetails.schema';
import { type HotTagsModelSchema, hotTagsTableSchema } from '@/models/hot/hot.schema';
import {
  type CommerceMessagingConversationModelSchema,
  commerceMessagingConversationTableSchema,
  type CommerceMessagingLinkModelSchema,
  commerceMessagingLinkTableSchema,
  type CommerceMessagingMessageModelSchema,
  commerceMessagingMessageTableSchema,
  type CommerceMessagingOutboxModelSchema,
  commerceMessagingOutboxTableSchema,
  type CommerceMessagingReceiverModelSchema,
  commerceMessagingReceiverTableSchema,
  commerceMessagingUnprocessedTableSchema,
} from '@/models/messaging/messaging.schema';
import type { Pubky } from '@/models/models.types';
import { type ModerationModelSchema, moderationTableSchema } from '@/models/moderation/moderation.schema';
import { notificationTableSchema } from '@/models/notification/notification.schema';
import type { FlatNotification } from '@/models/notification/notification.types';
import { type PostCountsModelSchema, postCountsTableSchema } from '@/models/post/counts/postCounts.schema';
import { type PostDetailsModelSchema, postDetailsTableSchema } from '@/models/post/details/postDetails.schema';
import {
  type PostRelationshipsModelSchema,
  postRelationshipsTableSchema,
} from '@/models/post/relationships/postRelationships.schema';
import { type PostTtlModelSchema, postTtlTableSchema } from '@/models/post/ttl/postTtl.schema';
import { type TagCollectionModelSchema, tagCollectionTableSchema } from '@/models/shared/tag/tag.schema';
import { type PostStreamModelSchema, postStreamTableSchema } from '@/models/stream/post/postStream.schema';
import { type TagStreamModelSchema, tagStreamTableSchema } from '@/models/stream/tag/tagStream.schema';
import { type UserStreamModelSchema, userStreamTableSchema } from '@/models/stream/user/userStream.schema';
import {
  type UserConnectionsModelSchema,
  userConnectionsTableSchema,
} from '@/models/user/connections/userConnections.schema';
import { type UserCountsModelSchema, userCountsTableSchema } from '@/models/user/counts/userCounts.schema';
import { type UserDetailsModelSchema, userDetailsTableSchema } from '@/models/user/details/userDetails.schema';
import {
  type UserRelationshipsModelSchema,
  userRelationshipsTableSchema,
} from '@/models/user/relationships/userRelationships.schema';
import { type UserTtlModelSchema, userTtlTableSchema } from '@/models/user/ttl/userTtl.schema';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * WebKit/iOS Safari throws these (often as the `cause` of a wrapped AppError) when an
 * IndexedDB connection is severed mid-operation rather than because of a real data problem.
 * These failures are typically transient and recover on a fresh open attempt.
 */
const TRANSIENT_INDEXED_DB_ERROR_NAMES = new Set(['UnknownError', 'AbortError']);
const TRANSIENT_INDEXED_DB_ERROR_PATTERNS = [
  'connection to indexed database server lost',
  'database deleted by request of the user',
  'transaction aborted',
  'in-progress transaction',
];

/**
 * Walks the `cause` chain of a thrown value and reports whether any link looks like a
 * transient IndexedDB failure (as opposed to a deterministic schema/logic error).
 *
 * Used by `initialize()` below; exported (not module-private) for direct unit testing and
 * for reuse on the post-init write path (see PUBKY-APP-34).
 */
export function isTransientIndexedDbError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);

    const name = typeof (current as { name?: unknown }).name === 'string' ? (current as { name: string }).name : '';
    const message =
      typeof (current as { message?: unknown }).message === 'string' ? (current as { message: string }).message : '';
    const haystack = `${name} ${message}`.toLowerCase();

    if (TRANSIENT_INDEXED_DB_ERROR_NAMES.has(name)) return true;
    if (TRANSIENT_INDEXED_DB_ERROR_PATTERNS.some((pattern) => haystack.includes(pattern))) return true;

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * The last DB version that stored messaging key material (receiver Noise
 * secrets, link snapshots) as PLAINTEXT. Versions above it run the in-place
 * at-rest wrap migration (`franky.migrations.ts`) instead of the
 * delete-and-recreate fallback — the wrapped rows ARE the user's messaging
 * identity, so wiping them would orphan every Encrypted Link.
 */
export const MESSAGING_WRAP_BASE_DB_VERSION = 4;

/**
 * Outcome of {@link AppDatabase.initialize}. `messagingAtRestDegraded` is
 * true when the best-effort versions-match wrap sweep failed: legacy
 * plaintext messaging key material may still sit at rest (and be served on
 * read) until a later boot's sweep succeeds. The messaging enable UI reads
 * this (via the messaging store) and pauses with "storage protection
 * unavailable" instead of silently continuing.
 */
export interface DatabaseInitResult {
  wasDbReset: boolean;
  messagingAtRestDegraded: boolean;
}

export class AppDatabase extends Dexie {
  private static readonly DEXIE_VERSION_MULTIPLIER = 10;

  private readonly declaredVersion: number;

  // User
  user_counts!: Dexie.Table<UserCountsModelSchema>;
  user_details!: Dexie.Table<UserDetailsModelSchema>;
  user_relationships!: Dexie.Table<UserRelationshipsModelSchema>;
  user_tags!: Dexie.Table<TagCollectionModelSchema<Pubky>>;
  user_connections!: Dexie.Table<UserConnectionsModelSchema>;
  user_ttl!: Dexie.Table<UserTtlModelSchema>;
  notifications!: Dexie.Table<FlatNotification>;
  // Post
  post_counts!: Dexie.Table<PostCountsModelSchema>;
  post_details!: Dexie.Table<PostDetailsModelSchema>;
  post_relationships!: Dexie.Table<PostRelationshipsModelSchema>;
  post_tags!: Dexie.Table<TagCollectionModelSchema<string>>;
  post_ttl!: Dexie.Table<PostTtlModelSchema>;
  // File
  file_details!: Dexie.Table<FileDetailsModelSchema>;
  // Streams
  post_streams!: Dexie.Table<PostStreamModelSchema>;
  unread_post_streams!: Dexie.Table<PostStreamModelSchema>;
  user_streams!: Dexie.Table<UserStreamModelSchema>;
  tag_streams!: Dexie.Table<TagStreamModelSchema>;
  // Bookmarks
  bookmarks!: Dexie.Table<BookmarkModelSchema>;
  // Commerce
  commerce_shops!: Dexie.Table<CommerceShopModelSchema>;
  commerce_listings!: Dexie.Table<CommerceListingModelSchema>;
  commerce_catalog_entries!: Dexie.Table<CommerceCatalogEntryModelSchema>;
  commerce_listing_drafts!: Dexie.Table<CommerceListingDraftModelSchema>;
  commerce_listing_projections!: Dexie.Table<CommerceListingProjectionModelSchema>;
  commerce_sync_jobs!: Dexie.Table<CommerceSyncJobModelSchema>;
  // Own published marketplace reviews (local-first copy + publication state)
  commerce_reviews!: Dexie.Table<CommerceReviewModelSchema>;
  // Own published review responses (subject-only, one revisable per review)
  commerce_review_responses!: Dexie.Table<CommerceReviewResponseModelSchema>;
  commerce_favorites!: Dexie.Table<CommerceFavoriteModelSchema>;
  commerce_shop_follows!: Dexie.Table<CommerceShopFollowModelSchema>;
  commerce_cart_items!: Dexie.Table<CommerceCartItemModelSchema>;
  commerce_locks_correlations!: Dexie.Table<CommerceLocksCorrelationModelSchema>;
  // Watchlist alerting — device-local observation baselines, detected alerts,
  // and saved catalog searches (see commerce.schema.ts headers).
  commerce_watch_snapshots!: Dexie.Table<CommerceWatchSnapshotModelSchema>;
  commerce_watch_alerts!: Dexie.Table<CommerceWatchAlertModelSchema>;
  commerce_saved_searches!: Dexie.Table<CommerceSavedSearchModelSchema>;
  // Device-local activity read checkpoint behind the marketplace Activity
  // badge (see commerce.schema.ts header) — one row per account.
  commerce_activity_checkpoints!: Dexie.Table<CommerceActivityCheckpointModelSchema>;
  // Private delivery details and seller authoring templates — device-local
  // only, never on the homeserver (see commerce.schema.ts headers).
  commerce_delivery_addresses!: Dexie.Table<CommerceDeliveryAddressModelSchema>;
  commerce_shipping_presets!: Dexie.Table<CommerceShippingPresetModelSchema>;
  // Inventory Studio import manifests (W2). Device-local; wiped on sign-out.
  commerce_import_manifests!: Dexie.Table<CommerceImportManifestModelSchema>;
  commerce_import_rows!: Dexie.Table<CommerceImportRowModelSchema>;
  commerce_import_mappings!: Dexie.Table<CommerceImportMappingModelSchema>;
  // Inventory Studio webhooks (W3). Device-local {id,url} only; wiped on sign-out.
  commerce_webhooks!: Dexie.Table<CommerceWebhookModelSchema>;
  // Encrypted messaging (Paykit Encrypted Links) — rows carry key material
  // and device-local plaintext history; see messaging.schema.ts header.
  commerce_messaging_receivers!: Dexie.Table<CommerceMessagingReceiverModelSchema>;
  commerce_messaging_links!: Dexie.Table<CommerceMessagingLinkModelSchema>;
  commerce_messaging_conversations!: Dexie.Table<CommerceMessagingConversationModelSchema>;
  commerce_messaging_messages!: Dexie.Table<CommerceMessagingMessageModelSchema>;
  // Device-local queued outbound messages awaiting a ready Encrypted Link
  commerce_messaging_outbox!: Dexie.Table<CommerceMessagingOutboxModelSchema>;
  // Marketplace community tags (listing/shop targets), kind-prefixed row ids
  marketplace_tags!: Dexie.Table<TagCollectionModelSchema<string>>;
  // Hot tags
  hot_tags!: Dexie.Table<HotTagsModelSchema>;
  // Feeds
  feeds!: Dexie.Table<FeedModelSchema>;
  // Moderation
  moderation!: Dexie.Table<ModerationModelSchema>;

  constructor(databaseName: string = DB_NAME, databaseVersion: number = DB_VERSION) {
    super(databaseName);
    this.declaredVersion = databaseVersion;

    try {
      const stores = {
        // User related tables
        user_counts: userCountsTableSchema,
        user_details: userDetailsTableSchema,
        user_relationships: userRelationshipsTableSchema,
        user_connections: userConnectionsTableSchema,
        user_ttl: userTtlTableSchema,
        user_tags: tagCollectionTableSchema,
        notifications: notificationTableSchema,
        // Post related tables
        post_counts: postCountsTableSchema,
        post_details: postDetailsTableSchema,
        post_relationships: postRelationshipsTableSchema,
        post_tags: tagCollectionTableSchema,
        post_ttl: postTtlTableSchema,
        // File related tables
        file_details: fileDetailsTableSchema,
        // Streams
        post_streams: postStreamTableSchema,
        unread_post_streams: postStreamTableSchema,
        user_streams: userStreamTableSchema,
        tag_streams: tagStreamTableSchema,
        // Bookmarks
        bookmarks: bookmarkTableSchema,
        // Commerce
        commerce_shops: commerceShopTableSchema,
        commerce_listings: commerceListingTableSchema,
        commerce_catalog_entries: commerceCatalogEntryTableSchema,
        commerce_listing_drafts: commerceListingDraftTableSchema,
        commerce_listing_projections: commerceListingProjectionTableSchema,
        commerce_sync_jobs: commerceSyncJobTableSchema,
        commerce_reviews: commerceReviewTableSchema,
        // Own review responses — folded into the current (unreleased) DB
        // version rather than bumping it: version 3 has never shipped, so
        // there is no upgrade path to preserve.
        commerce_review_responses: commerceReviewResponseTableSchema,
        commerce_favorites: commerceFavoriteTableSchema,
        commerce_shop_follows: commerceShopFollowTableSchema,
        commerce_cart_items: commerceCartItemTableSchema,
        commerce_locks_correlations: commerceLocksCorrelationTableSchema,
        // Watchlist alerting — folded into the current (unreleased) DB
        // version rather than bumping it: version 3 has never shipped, so
        // there is no upgrade path to preserve.
        commerce_watch_snapshots: commerceWatchSnapshotTableSchema,
        // Cross-device watchlist sync tombstones — folded into the current
        // (unreleased) DB version rather than bumping it: version 3 has never
        // shipped, so there is no upgrade path to preserve.
        commerce_watch_tombstones: commerceWatchTombstoneTableSchema,
        commerce_watch_alerts: commerceWatchAlertTableSchema,
        commerce_saved_searches: commerceSavedSearchTableSchema,
        // Activity read checkpoint — folded into DB version 4 rather than
        // bumping again: the 3 → 4 bump (the queued-message outbox below)
        // has not shipped yet, so there is no upgrade path to preserve.
        commerce_activity_checkpoints: commerceActivityCheckpointTableSchema,
        // Buyer address book and seller shipping presets — folded into the
        // current (unreleased) DB version rather than bumping it: version 3
        // has never shipped, so there is no upgrade path to preserve.
        commerce_delivery_addresses: commerceDeliveryAddressTableSchema,
        commerce_shipping_presets: commerceShippingPresetTableSchema,
        commerce_messaging_receivers: commerceMessagingReceiverTableSchema,
        commerce_messaging_links: commerceMessagingLinkTableSchema,
        commerce_messaging_conversations: commerceMessagingConversationTableSchema,
        commerce_messaging_messages: commerceMessagingMessageTableSchema,
        // Queued-message outbox. Adding this table REQUIRED bumping
        // NEXT_PUBLIC_DB_VERSION (3 → 4): version 3 HAD shipped, and a
        // schema change under a shipped version leaves existing browsers
        // with a mismatched store set that breaks every local write. The
        // app's upgrade path is mismatch → delete-and-recreate the local
        // cache (device-local state resets; homeserver-synced state
        // rehydrates).
        commerce_messaging_outbox: commerceMessagingOutboxTableSchema,
        // Marketplace community tags — folded into the current (unreleased)
        // DB version rather than bumping it: version 3 has never shipped, so
        // there is no upgrade path to preserve.
        marketplace_tags: tagCollectionTableSchema,
        // Hot tags
        hot_tags: hotTagsTableSchema,
        // Feeds
        feeds: feedTableSchema,
        // Moderation
        moderation: moderationTableSchema,
      };

      const importStores = {
        commerce_import_manifests: commerceImportManifestTableSchema,
        commerce_import_rows: commerceImportRowTableSchema,
        commerce_import_mappings: commerceImportMappingTableSchema,
      };
      const webhookStores = {
        commerce_webhooks: commerceWebhookTableSchema,
      };
      const unprocessedStores = {
        // Inbound events this build cannot interpret, kept unprocessed so
        // the link never reads past them. Added at version 8 (7 shipped).
        commerce_messaging_unprocessed: commerceMessagingUnprocessedTableSchema,
      };
      const storesWithoutImport = stores;
      const storesAt6 = { ...storesWithoutImport, ...importStores };
      const storesAt7 = { ...storesAt6, ...webhookStores };
      const storesAtDeclared = { ...storesAt7, ...unprocessedStores };

      if (this.declaredVersion > MESSAGING_WRAP_BASE_DB_VERSION) {
        // Version chain for 4 → 5 → 6 → 7 → 8: 4 and 5 share the wrap-era
        // schema (no import tables). 6 adds Inventory Studio import stores in
        // place. 7 adds commerce_webhooks ({id,url} only) in place. 8 adds
        // commerce_messaging_unprocessed in place.
        this.version(MESSAGING_WRAP_BASE_DB_VERSION).stores(storesWithoutImport);
        if (this.declaredVersion >= 5) {
          this.version(5).stores(storesWithoutImport);
        }
        if (this.declaredVersion >= 6) {
          this.version(6).stores(storesAt6);
        }
        if (this.declaredVersion >= 7) {
          this.version(7).stores(storesAt7);
        }
        if (this.declaredVersion >= 8) {
          this.version(8).stores(storesAtDeclared);
        }
        if (this.declaredVersion > 8) {
          this.version(this.declaredVersion).stores(storesAtDeclared);
        }
      } else {
        // Tests force DB_VERSION=1: fold import and webhook tables into the
        // single version so wipe-enumerate tests see them without a 4→7 chain.
        this.version(this.declaredVersion).stores(storesAtDeclared);
      }
    } catch (error) {
      throw Err.database(DatabaseErrorCode.SCHEMA_ERROR, 'Failed to initialize database schema of indexedDB', {
        service: ErrorService.Local,
        operation: 'constructor',
        cause: error,
      });
    }
  }

  private async getExistingDbVersion(): Promise<number | null> {
    return new Promise((resolve, reject) => {
      try {
        if (typeof indexedDB === 'undefined') {
          resolve(null);
          return;
        }

        const request = indexedDB.open(this.name);

        request.onerror = () => {
          if (request.error) {
            reject(request.error);
            return;
          }

          resolve(null);
        };

        request.onsuccess = () => {
          const version = request.result.version;
          request.result.close();
          resolve(typeof version === 'number' ? version : null);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private normalizeStoredVersion(version: number | null): number | null {
    if (version === null) {
      return null;
    }

    // Dexie always multiplies the version by 10 internally
    // If the version is >= 10, it's been multiplied by Dexie, so divide it back.
    // Dexie 4 additionally auto-bumps the native version by +1 when tables are
    // added to the SAME declared version (31 for declared version 3 after an
    // additive schema change), so floor the quotient: a fractional remainder is
    // Dexie's own in-place migration bookkeeping, not a version mismatch, and
    // treating it as one recreated (wiped) the database on every load after an
    // additive deploy.
    if (version >= AppDatabase.DEXIE_VERSION_MULTIPLIER) {
      return Math.floor(version / AppDatabase.DEXIE_VERSION_MULTIPLIER);
    }

    // If version is < 10, it's the raw user version (shouldn't happen in practice)
    return version;
  }

  private async recreateDatabase(currentVersion: number | null, rawVersion?: number | null) {
    try {
      this.close();

      if (typeof indexedDB !== 'undefined') {
        await new Promise<void>((resolve, reject) => {
          const deleteRequest = indexedDB.deleteDatabase(this.name);

          deleteRequest.onblocked = () => {
            Logger.warn(
              'Database deletion is blocked by open connections. Please close all other tabs/windows using this application.',
              {
                databaseName: this.name,
                hint: 'Close other browser tabs or windows that may be using this database',
              },
            );
          };

          deleteRequest.onsuccess = () => resolve();
          deleteRequest.onerror = () => reject(deleteRequest.error ?? new Error('Failed to delete database'));
        });
      } else {
        // Use Dexie.delete() which coordinates with other Dexie contexts
        await Dexie.delete(this.name);
      }
    } catch (error) {
      throw Err.database(DatabaseErrorCode.DELETE_FAILED, 'Failed to delete outdated database, indexedDB', {
        service: ErrorService.Local,
        operation: 'recreateDatabase',
        context: {
          currentVersion,
          rawVersion,
          expectedVersion: this.declaredVersion,
          databaseName: this.name,
        },
        cause: error,
      });
    }

    try {
      // Note: expected new DB version is already set in the constructor via this.version(...)
      await this.open();
      Logger.info('Database recreated with new schema');
    } catch (error) {
      throw Err.database(DatabaseErrorCode.INIT_FAILED, 'Failed to open database after recreation', {
        service: ErrorService.Local,
        operation: 'recreateDatabase',
        context: {
          version: this.declaredVersion,
          rawVersion,
          databaseName: this.name,
        },
        cause: error,
      });
    }
  }

  async initialize(): Promise<DatabaseInitResult> {
    if (typeof indexedDB === 'undefined') {
      Logger.warn('IndexedDB is not available in this environment. Skipping database initialization.');
      return { wasDbReset: false, messagingAtRestDegraded: false };
    }

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.runInitialize();

        // A prior retry may have called this.close(), which disables Dexie's auto-open.
        // runInitialize()'s version-match path returns without opening, so guarantee the
        // connection is open before reporting success — otherwise queries would throw
        // DatabaseClosedError even though initialization "succeeded". A transient failure
        // here is caught below and retried like any other.
        if (!this.isOpen()) {
          await this.open();
        }

        return result;
      } catch (error) {
        const isLastAttempt = attempt >= DB_INIT_MAX_ATTEMPTS;

        // iOS Safari / in-app browsers can drop the IndexedDB connection mid-open.
        // Reset Dexie's internal state and retry before surfacing a hard failure.
        if (!isLastAttempt && isTransientIndexedDbError(error)) {
          Logger.warn('Transient IndexedDB error during initialization. Retrying...', {
            attempt,
            maxAttempts: DB_INIT_MAX_ATTEMPTS,
          });
          this.close();
          await delay(DB_INIT_RETRY_BASE_DELAY_MS * attempt);
          continue;
        }

        if (error instanceof Error && error.name === 'AppError') throw error;

        throw Err.database(DatabaseErrorCode.INIT_FAILED, 'Failed to initialize database, indexedDB', {
          service: ErrorService.Local,
          operation: 'initialize',
          cause: error,
        });
      }
    }
  }

  private async runInitialize(): Promise<DatabaseInitResult> {
    const dbExists = await Dexie.exists(this.name);

    if (!dbExists) {
      Logger.info('Creating new database...');
      await this.open();
      return { wasDbReset: true, messagingAtRestDegraded: false };
    }

    let rawVersion: number | null = null;
    let currentVersion: number | null = null;

    try {
      rawVersion = await this.getExistingDbVersion();
      currentVersion = this.normalizeStoredVersion(rawVersion);
    } catch (error) {
      // A transient WebKit/iOS abort during the native version probe must NOT fall through to a
      // destructive recreateDatabase(). Re-throw so initialize()'s retry loop can recover the
      // connection; only genuinely unreadable versions (corruption) self-heal via recreate.
      if (isTransientIndexedDbError(error)) throw error;

      Logger.warn('Failed to determine current database version. Recreating database...', {
        error,
      });
    }

    if (currentVersion === null) {
      Logger.warn('Unable to determine current database version. Recreating database...');
      await this.recreateDatabase(currentVersion, rawVersion);
      return { wasDbReset: true, messagingAtRestDegraded: false };
    }

    if (currentVersion !== this.declaredVersion) {
      if (currentVersion >= MESSAGING_WRAP_BASE_DB_VERSION && this.declaredVersion > currentVersion) {
        // 4 → N: wrap messaging secrets when leaving v4. 5 → 6 adds import
        // tables in place via Dexie; 6 → 7 adds webhook {id,url} rows. Do not
        // delete-and-recreate, that would wipe seller-local inventory state.
        Logger.info(`Database upgrade ${currentVersion} → ${this.declaredVersion}: in-place Dexie schema`, {
          rawVersion,
          expectedVersion: this.declaredVersion,
        });
        await this.open();
        if (currentVersion === MESSAGING_WRAP_BASE_DB_VERSION) {
          await migrateMessagingSecretsToWrappedStorage(this);
        }
        return { wasDbReset: false, messagingAtRestDegraded: await this.wrapMessageHistory() };
      }
      Logger.info(`Database version mismatch. Current: ${currentVersion}, Expected: ${this.declaredVersion}`, {
        rawVersion,
        normalizedVersion: currentVersion,
        expectedVersion: this.declaredVersion,
        expectedInternalVersion: this.declaredVersion * AppDatabase.DEXIE_VERSION_MULTIPLIER,
      });
      await this.recreateDatabase(currentVersion, rawVersion);
      return { wasDbReset: true, messagingAtRestDegraded: false };
    }

    // Versions match: idempotent wrap sweep — heals a crash that interrupted
    // the 4 → 5 upgrade between the native version bump and the data pass.
    // Best-effort here: a failure fails the messaging layer closed at
    // operation time (writes refuse plaintext; unreadable rows read as lost)
    // rather than blocking app boot, and leftover rows retry on the next boot.
    // But it is NOT silent: a failed sweep leaves legacy plaintext key
    // material at rest AND still served on read, so the failure is reported
    // to the caller as `messagingAtRestDegraded` — the messaging enable UI
    // surfaces it ("messaging paused: storage protection unavailable") until
    // a later boot's sweep succeeds.
    let messagingAtRestDegraded = false;
    try {
      if (!this.isOpen()) {
        await this.open();
      }
      await migrateMessagingSecretsToWrappedStorage(this);
    } catch (error) {
      messagingAtRestDegraded = true;
      Logger.warn(
        'Messaging at-rest wrap sweep failed; legacy rows stay plaintext at rest until a later boot succeeds, and messaging is marked degraded',
        { error },
      );
    }
    if (await this.wrapMessageHistory()) messagingAtRestDegraded = true;

    Logger.debug('Database version is current');
    return { wasDbReset: false, messagingAtRestDegraded };
  }

  /**
   * Best-effort in-place wrap of message bodies left in plaintext by builds
   * before history was encrypted at rest. Runs on every boot of an existing
   * database (it is idempotent) and resolves `true` when it failed: those
   * bodies then stay plaintext at rest, readable, until a later boot
   * succeeds, and messaging is reported degraded meanwhile.
   */
  private async wrapMessageHistory(): Promise<boolean> {
    try {
      await migrateMessagingHistoryToWrappedStorage(this);
      return false;
    } catch (error) {
      Logger.warn(
        'Message history wrap sweep failed; legacy bodies stay plaintext at rest until a later boot succeeds, and messaging is marked degraded',
        { error },
      );
      return true;
    }
  }
}

export const db = new AppDatabase();
