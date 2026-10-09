import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { CommerceAttentionSeenApplication } from '@/application/commerce/attention-seen';
import { CommerceInventoryApplication } from '@/application/commerce/inventory';
import { CommercePrivKeyringApplication } from '@/application/commerce/priv-keyring';
import { TagKind } from '@/application/tag/tag.types';
import {
  COMMERCE_SAVED_SEARCH_MAX_PER_OWNER,
  COMMERCE_WATCH_CHECK_MAX_ITEMS,
  COMMERCE_WATCH_ENDING_SOON_THRESHOLD_MS,
  getCommerceAdapterMode,
  getMarketplaceUrl,
  isDurableCommerceMode,
  isTransactionalCommerceMode,
  MARKETPLACE_FOLLOWED_SHELF_MAX_SELLER_FETCHES,
} from '@/config/commerce';
import { NEXUS_LISTINGS_PER_PAGE } from '@/config/nexus';
import { readAuthEpoch } from '@/controllers/auth/auth-epoch';
import {
  extractReviewAttestation,
  verifyOrderReceiptClaims,
  verifyOwnDropEdition,
  verifyOwnOrderReceipt,
  verifyOwnReviewAttestation,
} from '@/libs/commerce/attestation';
import {
  DIGITAL_DELIVERY_COPY,
  type DigitalFileOpenFailure,
  type MarketplaceDigitalDeliveryCapability,
  type MarketplaceDigitalDeliveryChannel,
  type MarketplaceDigitalDeliveryInput,
  type MarketplaceDigitalDeliverySet,
  type MarketplaceOrderDeliveryEmail,
  type MarketplaceOrderDigitalDelivery,
  type MarketplaceOrderDigitalEvidence,
  type MarketplaceOrderDigitalLine,
  type MarketplaceSellerDigitalDelivery,
} from '@/libs/commerce/digital';
import {
  digitalCiphertextBytes,
  digitalDeliverableUrl,
  digitalFileContentType,
  digitalFileName,
  encryptDigitalDeliverable,
  newDigitalDeliverableId,
  openDigitalDeliverable,
} from '@/libs/commerce/digital-file';
import { locksAdmissionView } from '@/libs/commerce/locks-lifecycle';
import { lockPolicyCreator, toBareLockResource } from '@/libs/commerce/locks-payment';
import {
  assertReserveFreePublicRecord,
  type CommerceDigitalLock,
  type CommerceDropRecord,
  commerceListingFulfillmentMethods,
  type CommerceListingRecord,
  commerceListingShippingMinor,
  type CommerceOrderReceiptRecord,
  commerceReviewRecordSchema,
  type CommerceShopRecord,
  type CommerceWatchlistRecord,
  findForbiddenPublicReserveKey,
  stripForbiddenPublicReserveKeys,
} from '@/libs/commerce/marketplace-records';
import {
  type BuyerPaykitWallet,
  foundAppRegistryShowsNewWallet,
  PAYKIT_APP_REGISTRY_PATH,
  paykitAppRegistryUrl,
} from '@/libs/commerce/paykit-wallet';
import type { PaymentMethodKind } from '@/libs/commerce/payment-methods';
import {
  type MarketplaceCheckoutFulfillmentLine,
  type MarketplaceFulfillmentMethod,
  type MarketplacePickupDetails,
  type MarketplacePickupReveal,
  type MarketplaceSellerPickupDetails,
  pickupRefusalFailureMessage,
  resolveCheckoutFulfillment,
} from '@/libs/commerce/pickup';
import {
  assertPrivKeyringLive,
  isPrivKeyringRevoked,
  PRIV_V1_LOG_PATH,
  privEntryUrl,
  privErrorSummary,
  type PrivKeyring,
} from '@/libs/commerce/priv-envelope';
import type { MarketplacePrivKeysResult } from '@/libs/commerce/priv-keys';
import { createCommerceSandboxCatalog } from '@/libs/commerce/sandbox-catalog';
import type { ShipFromAddress, ShippingParcel } from '@/libs/commerce/shipping';
import {
  buildMarketplaceCheckoutAggregateId,
  buildMarketplaceDropAggregateId,
  buildMarketplaceListingAggregateId,
  buildMarketplaceOrderAggregateId,
  buildMarketplacePaymentAggregateId,
  classifyMarketplacePickupCommandRefusal,
  type CreateMarketplaceCheckoutCommand,
  isCorrelatedBenignListingRegistrationResponse,
  isListingRecordNotFoundResponse,
  isSuccessfulListingRegistrationResponse,
  type MarketplaceCommand,
  type MarketplaceCommandResponse,
} from '@/libs/commerce/transaction-commands';
import type { CommerceJsonValue, CommerceMoney } from '@/libs/commerce/transaction-contracts';
import { assertPublishableListingStock } from '@/libs/commerce/unlimited-stock';
import { AuthErrorCode, ClientErrorCode, ServerErrorCode, ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { hasHttpStatus, isAppError, isNotFound } from '@/libs/error/error.utils';
import { HttpMethod, HttpStatusCode } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import type {
  CommerceAuctionRegistrationCommand,
  CommerceCatalogEntryModelSchema,
  CommerceIndexedReview,
  CommerceListingModelSchema,
  CommerceListingProjectionModelSchema,
  CommerceReputationSummary,
  CommerceReviewModelSchema,
  CommerceReviewResponseModelSchema,
  CommerceSavedSearchModelSchema,
  CommerceSavedSearchParams,
  CommerceSyncJobModelSchema,
  CommerceWatchAlertModelSchema,
  CommerceWatchSnapshotModelSchema,
} from '@/models/commerce/commerce.schema';
import { selectFollowedSellersToRefresh } from '@/pipes/commerce/commerce.discovery';
import {
  type CommerceDeliveryAddressInput,
  CommerceRecordNormalizer,
  type CommerceShippingPresetInput,
} from '@/pipes/commerce/commerce.normalizer';
import {
  emptyWatchlistState,
  localRowsToWatchlistState,
  mergeWatchlistStates,
  watchlistRecordToState,
  watchlistStatesEqual,
  watchlistStateToRecordBody,
} from '@/pipes/commerce/commerce.watchlist';
import {
  detectWatchAlerts,
  type WatchIndexObservation,
  type WatchObservation,
  type WatchProjectionObservation,
} from '@/pipes/marketplaceWatch/marketplaceWatch.detector';
import { MarketplaceMediaService } from '@/services/commerce/marketplace-media';
import { ExchangerateService } from '@/services/exchangerate/exchangerate';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { CommercePrivStoreService } from '@/services/homeserver/commerce/priv-store';
import { HomeserverService, PRIVATE_APP_DATA_PATH } from '@/services/homeserver/homeserver';
import { retryHomeserverWrite } from '@/services/homeserver/write-retry';
import { type CommerceListingRowGeneration, LocalCommerceService } from '@/services/local/commerce/commerce';
import {
  buildMarketplaceTagRowId,
  LocalMarketplaceTagService,
  type MarketplaceTagKind,
} from '@/services/local/tag/marketplace/tag.marketplace';
import { LocksGatewayService } from '@/services/locks/locks';
import { locksCreatorMatchesShopPubky, LocksFrontendSessionStore } from '@/services/locks/locks-frontend-session';
import {
  MarketplaceGatewayService,
  type MarketplaceOrder,
  type MarketplacePayment,
} from '@/services/marketplace/marketplace';
import { MarketplacePaykitClaimService } from '@/services/marketplace/marketplace-paykit-claim';
import {
  type MarketplaceSessionEndedEvent,
  MarketplaceSessionService,
} from '@/services/marketplace/marketplace-session';
import { NexusMarketplaceService } from '@/services/nexus/marketplace/marketplace';
import type {
  NexusListingCondition,
  NexusListingDetails,
  NexusListingSaleFormat,
} from '@/services/nexus/marketplace/marketplace.types';
import type { NexusTag } from '@/services/nexus/nexus.types';
import { PaykitMessagingService } from '@/services/paykit/paykit-messaging';
import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * The `review` view inside a successful review command result (camelCased
 * by the wire boundary) — exactly the fields record publication needs.
 */
const reviewResultSchema = z
  .object({
    reviewerPubky: z.string().length(52),
    reviewerRole: z.enum(['buyer', 'seller']),
    subjectPubky: z.string().length(52),
    rating: z.number().int().min(1).max(5),
    text: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

export interface CommerceCatalogStreamFilters {
  saleFormat?: NexusListingSaleFormat;
  condition?: NexusListingCondition;
  /**
   * Ask Nexus for auctions ordered by soonest auction end
   * (`sorting=ends_at&order=ascending`) instead of the indexing timeline.
   * That stream contains only auction listings by definition.
   */
  endingSoonest?: boolean;
  /** Seller-declared item location: ISO-3166-1 alpha-2 country code. */
  country?: string;
}

/**
 * Cross-tab Web Lock that owns one listing's registration attempts. Its
 * holder requests no other lock, so it cannot join a lock-order cycle with
 * the messaging, watchlist or auth locks.
 */
export const LISTING_REGISTRATION_LOCK_PREFIX = 'pubky-listing-registration|';
/** Deadline for the service requests one attempt makes while holding the lock. */
export const LISTING_REGISTRATION_TIMEOUT_MS = 20_000;

/**
 * One registration, publish or delete of a listing. Its session binding
 * (`authEpoch`, the signed-in `pubky`, the marketplace `sessionToken`) is
 * read once when it starts; a sign-out in any tab, an account switch or a
 * session replacement changes it, and the attempt stops before its next
 * request or write. `observed` is the listing row generation the attempt
 * acts on, advanced only by its own writes.
 */
type ListingRegistrationAttempt = {
  compositeListingId: string;
  aggregateId: string;
  authEpoch: number;
  pubky: string | null;
  sessionToken: string | null;
  observed: CommerceListingRowGeneration;
  signal?: AbortSignal;
};

/**
 * `publish` (a user action) waits for the lock and acts on the row as it is
 * then. `heal` (owner surfaces) gives up if another attempt holds the lock
 * and acts only if the row is unchanged since the attempt began.
 */
type ListingRegistrationOwner = 'publish' | 'heal';

/**
 * `record_deleted`: the seller's homeserver has no record, so nothing was
 * sent. `service_not_found`: the service refused with `NOT_FOUND` for the
 * same reason. Neither is retried. `superseded`: the row changed under the
 * attempt, which leaves it to the newer writer.
 */
type ListingRegistrationOutcome = 'registered' | 'record_deleted' | 'service_not_found' | 'superseded';

/**
 * The three honest states a rating header can be in: `rated` (the index
 * holds reviews), `new_seller` (a reputation-aware index confirmed zero
 * reviews — the explicit cold-start state, ratified in the design's §10.3),
 * or `unavailable` (no reputation-aware index reachable — render nothing,
 * never a fabricated state).
 */
/**
 * Whether the current session can use private cross-device watchlist sync,
 * decided from `session.info.capabilities` (facts), never by probing for 403s.
 */
export type CommerceWatchlistSyncCapability = 'capable' | 'needs_reauth' | 'no_session';

/**
 * Outcome of one watchlist sync round. `skipped` covers sandbox mode and
 * signed-out/restoring states; `needs_reauth` is the honest "this homeserver
 * session's grant cannot touch /priv" state (from capability facts or an
 * actual 401/403); `needs_marketplace_approval` means the marketplace refused
 * to release the data key to the current purchase session (missing, or
 * approved without `/priv/pubky.app/`), which only a marketplace session
 * approval repairs; `unavailable` means the marketplace cannot release the
 * key right now, so nothing is written.
 */
export type CommerceWatchlistSyncStatus =
  | 'synced'
  | 'needs_reauth'
  | 'needs_marketplace_approval'
  | 'unavailable'
  | 'unsupported'
  | 'skipped'
  | 'error';

/** The logical id of the one encrypted watchlist entry. */
const WATCHLIST_PRIV_ENTRY_ID = 'watchlist';

/** Plaintext receipts moved per orders load; the rest move on later loads. */
const RECEIPT_MIGRATION_BATCH = 100;

/**
 * Read-back retries for an acked listing write (see
 * {@link CommerceApplication.readBackAckedWrite}). Homeserver reads can lag a
 * just-acked write by a moment, so the verify read waits briefly before
 * believing a lag; one publish that outlasted this budget is still reported
 * as published (unverified), never as failed.
 */
const LISTING_READ_BACK_RETRY_DELAYS_MS = [250, 500, 1_000];

/**
 * Outcome of one portable order-receipt publication pass, mirrored by the
 * controller into the commerce store for UI surfaces. Same honesty contract
 * as the watchlist sync status: capability is decided from session facts,
 * and a refused private read/write reports `needs_reauth` — nothing
 * silently no-ops. A data-key refusal for the purchase session reports
 * `needs_marketplace_approval`. `unavailable` covers the cases re-approval cannot fix:
 * this deployment issued no attestation, the marketplace cannot release the
 * data key that seals receipts, or a transient failure left a receipt
 * unpublished or a plaintext receipt unmoved (it retries on the next
 * orders-surface load).
 * `skipped` covers non-durable modes and signed-out/restoring states.
 */
export type CommerceReceiptPublicationStatus =
  | 'published'
  | 'needs_reauth'
  | 'needs_marketplace_approval'
  | 'unavailable'
  | 'skipped';

export type CommerceSellerReputationOverview =
  | { status: 'rated'; summary: CommerceReputationSummary }
  | { status: 'new_seller' }
  | { status: 'unavailable' };

/**
 * One checkout line as the fulfillment plumbing needs it (local pickup §A2):
 * the projection facts plus the seller identity and the listing's published
 * methods, so the buyer's per-(seller, fulfillment) group choice can be
 * validated and assigned before submit.
 */
export type CommerceCheckoutLineInput = MarketplaceCheckoutFulfillmentLine & {
  expectedRevision: number;
  quantity: number;
  variantId?: string;
  variantOptions?: { name: string; value: string }[];
};

/**
 * A checkout submission with per-group fulfillment choices. A seller group
 * with no recorded choice ships (the default); a checkout with no shipped
 * line sends NO delivery address (§A2), and the delivery email rides only
 * when an email-kind digital line needs it (digital delivery design §4.3).
 */
export type CommerceCheckoutFulfillmentInput = {
  lines: CommerceCheckoutLineInput[];
  fulfillmentChoiceBySeller?: Readonly<Record<string, MarketplaceFulfillmentMethod | undefined>>;
  deliveryAddress?: CreateMarketplaceCheckoutCommand['payload']['deliveryAddress'];
  deliveryEmail?: string;
};

/** A review-list page, or the honest signal that no review index serves this deployment. */
export type CommerceIndexedReviewsResult =
  | { status: 'ok'; reviews: CommerceIndexedReview[] }
  | { status: 'unavailable' };

type CommerceListingWithProjection = CommerceListingModelSchema & {
  purchasableQuantity: number | null;
};

function applyInventoryProjection(
  listing: CommerceListingModelSchema,
  projection: CommerceListingProjectionModelSchema | null | undefined,
): CommerceListingWithProjection {
  const recordQuantity = listing.record.variants
    .filter(({ enabled }) => enabled)
    .reduce((total, variant) => total + variant.quantity, 0);
  if (!projection || projection.listing_revision !== listing.revision) {
    return { ...listing, purchasableQuantity: null };
  }
  return {
    ...listing,
    purchasableQuantity: Math.min(recordQuantity, projection.available_quantity),
  };
}

const SELLER_REFRESH_MAX_PAGES = 100;

export class CommerceApplication {
  private constructor() {}

  private static sellerListingsRefreshInFlight = new Map<string, Promise<void>>();

  static async getShop(ownerPubky: string) {
    return await LocalCommerceService.getShop(ownerPubky);
  }

  static async getAllShops() {
    return await LocalCommerceService.getAllShops();
  }

  static async fetchShop(ownerPubky: string): Promise<CommerceShopRecord> {
    const url = CommerceRecordNormalizer.shopUri(ownerPubky);
    return CommerceRecordNormalizer.shop(await CommerceHomeserverService.fetchJson(url));
  }

  /** Refresh published settings without discarding an unpublished local edit. */
  static async refreshShop(ownerPubky: string): Promise<CommerceShopRecord> {
    const local = await LocalCommerceService.getShop(ownerPubky);
    if (local && local.sync_status !== 'synced') return local.record;

    const record = await this.fetchShop(ownerPubky);
    return await LocalCommerceService.cacheRefreshedShop(record, local?.record ?? null);
  }

  static async getOrFetchShop(ownerPubky: string): Promise<CommerceShopRecord> {
    const local = await LocalCommerceService.getShop(ownerPubky);
    if (local) return local.record;

    const record = await this.fetchShop(ownerPubky);
    await LocalCommerceService.upsertShop(record, 'synced');
    return record;
  }

  static async getListing(compositeListingId: string) {
    const listing = await LocalCommerceService.getListing(compositeListingId);
    if (!listing) return listing;
    const projection = await LocalCommerceService.getListingProjection(compositeListingId);
    return applyInventoryProjection(listing, projection);
  }

  static async getManyListings(compositeListingIds: string[]): Promise<Map<string, CommerceListingModelSchema>> {
    const listings = await LocalCommerceService.getListingsByIds(compositeListingIds);
    return new Map(listings.map((listing) => [listing.id, listing]));
  }

  /**
   * Reads the locally cached community tag aggregate for a marketplace target.
   *
   * @param kind - `TagKind.LISTING` or `TagKind.SHOP`
   * @param taggedId - Composite `seller:listingId` for listings, owner pubky for shops
   * @returns The cached NexusTag[] aggregate (viewer's own write-through included)
   */
  static async getMarketplaceTags(kind: MarketplaceTagKind, taggedId: string): Promise<NexusTag[]> {
    return await LocalMarketplaceTagService.read(buildMarketplaceTagRowId(kind, taggedId));
  }

  /**
   * Fetches the community tag aggregate for a marketplace target from the
   * marketplace Nexus and merges it into the local cache.
   *
   * Honest degradation: the tag endpoints only exist once the marketplace
   * Nexus deploys tag aggregation. A 404 means "aggregation not available",
   * so this returns an empty array WITHOUT touching the local cache — the
   * viewer's own locally written tags keep rendering, and nothing fake is
   * shown. Any other error propagates.
   *
   * @param params.kind - `TagKind.LISTING` or `TagKind.SHOP`
   * @param params.taggedId - Composite `seller:listingId` for listings, owner pubky for shops
   * @param params.viewerId - Viewer pubky for relationship data, if signed in
   * @param params.skip - Number of tags to skip (pagination)
   * @param params.limit - Maximum number of tags to return
   * @returns Tags returned by Nexus; empty when the endpoint is not deployed (404)
   */
  static async fetchMarketplaceTags({
    kind,
    taggedId,
    viewerId,
    skip,
    limit,
  }: {
    kind: MarketplaceTagKind;
    taggedId: string;
    viewerId?: string;
    skip?: number;
    limit?: number;
  }): Promise<NexusTag[]> {
    let nexusTags: NexusTag[];
    try {
      if (kind === TagKind.LISTING) {
        const [sellerId, listingId] = taggedId.split(':');
        nexusTags = await NexusMarketplaceService.fetchListingTags({
          seller_id: sellerId,
          listing_id: listingId,
          skip_tags: skip,
          limit_tags: limit,
          viewer_id: viewerId,
        });
      } else {
        nexusTags = await NexusMarketplaceService.fetchShopTags({
          seller_id: taggedId,
          skip_tags: skip,
          limit_tags: limit,
          viewer_id: viewerId,
        });
      }
    } catch (error) {
      if (isAppError(error) && isNotFound(error)) {
        return [];
      }
      throw error;
    }

    if (nexusTags.length > 0) {
      await LocalMarketplaceTagService.mergeTags({
        taggedId: buildMarketplaceTagRowId(kind, taggedId),
        tags: nexusTags,
        viewerId: viewerId ?? null,
      });
    }

    return nexusTags;
  }

  static async getListingsBySeller(sellerPubky: string) {
    const listings = await LocalCommerceService.getListingsBySeller(sellerPubky);
    return await Promise.all(
      listings.map(async (listing) =>
        applyInventoryProjection(listing, await LocalCommerceService.getListingProjection(listing.id)),
      ),
    );
  }

  static async cacheMarketplaceListingProjection(projection: CommerceListingProjectionModelSchema): Promise<void> {
    await LocalCommerceService.cacheListingProjection(projection);
  }

  static async getOrFetchListingsBySeller(sellerPubky: string) {
    const listings = await LocalCommerceService.getListingsBySeller(sellerPubky);
    if (listings.length > 0) return listings;

    await this.fetchSellerCatalogListings(sellerPubky);
    const entries = await LocalCommerceService.getCatalogEntriesBySeller(sellerPubky);
    await Promise.all(entries.map((entry) => this.getOrFetchListing(sellerPubky, entry.listing_id)));
    return await LocalCommerceService.getListingsBySeller(sellerPubky);
  }

  /**
   * Refreshes one seller's discovery stream, then hydrates only records that
   * are absent locally or newer than the canonical record already cached.
   * Nexus remains discovery/revision data; the homeserver remains canonical.
   *
   * Concurrent dashboard mounts for the same seller share one bounded pass.
   * Missing entries from the stream are intentionally retained locally:
   * discovery is not the seller's durable inventory authority.
   */
  static async refreshListingsBySeller(sellerPubky: string): Promise<void> {
    // Sandbox catalogs are seeded locally and stay self-contained (same
    // invariant as fetchCatalogListings / fetchSellerCatalogListings):
    // sandbox mode never reads from Nexus, so the refresh is a no-op and
    // the cached rows keep rendering.
    if (getCommerceAdapterMode() === 'sandbox') return;

    const inFlight = this.sellerListingsRefreshInFlight.get(sellerPubky);
    if (inFlight) {
      await inFlight;
      return;
    }

    const refresh = this.runSellerListingsRefresh(sellerPubky);
    this.sellerListingsRefreshInFlight.set(sellerPubky, refresh);
    try {
      await refresh;
    } finally {
      if (this.sellerListingsRefreshInFlight.get(sellerPubky) === refresh) {
        this.sellerListingsRefreshInFlight.delete(sellerPubky);
      }
    }
  }

  private static async runSellerListingsRefresh(sellerPubky: string): Promise<void> {
    const entries = await this.collectSellerCatalogEntries(sellerPubky, { strictIdentity: true, paginate: true });
    const localListings = await LocalCommerceService.getListingsBySeller(sellerPubky);
    const localListingsById = new Map(localListings.map((listing) => [listing.listing_id, listing]));
    const recordsToCommit: CommerceListingRecord[] = [];

    for (const entry of entries) {
      const local = localListingsById.get(entry.listing_id);
      if (local && local.revision >= entry.revision) continue;
      const record = await this.fetchListing(sellerPubky, entry.listing_id);
      if (record.revision < entry.revision) {
        throw Err.validation(
          ValidationErrorCode.INVALID_INPUT,
          'Canonical listing revision is older than the Nexus discovery revision.',
          {
            service: ErrorService.Marketplace,
            operation: 'refreshListingsBySeller',
            context: { canonicalRevision: record.revision, indexedRevision: entry.revision },
          },
        );
      }
      recordsToCommit.push(record);
    }

    await LocalCommerceService.commitSellerCatalogRefresh(entries, recordsToCommit);
  }

  static async getListingsByCategory(categoryId: string) {
    return await LocalCommerceService.getListingsByCategory(categoryId);
  }

  static async getAllListings() {
    return await LocalCommerceService.getAllListings();
  }

  static async getListingDrafts(ownerPubky: string) {
    return await LocalCommerceService.getDraftsByOwner(ownerPubky);
  }

  static async commitUpdateListingDraft(
    ownerPubky: string,
    listingId: string,
    form: CommerceJsonValue,
    mediaBlobs: Record<string, Blob> = {},
  ): Promise<void> {
    await LocalCommerceService.upsertDraft({
      ownerId: ownerPubky,
      listingId,
      data: { ownerPubky, listingId, form },
      now: Date.now(),
      mediaBlobs,
    });
  }

  static async commitDeleteListingDraft(ownerPubky: string, listingId: string): Promise<void> {
    await LocalCommerceService.deleteDraft(`${ownerPubky}:${listingId}`);
  }

  static async initializeSandboxCatalog(): Promise<boolean> {
    if (getCommerceAdapterMode() !== 'sandbox') return false;
    const catalog = createCommerceSandboxCatalog();
    const seeded = await LocalCommerceService.seedSandboxCatalog(catalog);
    await Promise.allSettled(catalog.listings.map((listing) => this.ensureListingRegistered(listing)));
    return seeded;
  }

  static async executeMarketplaceCommand(actorPubky: string, command: MarketplaceCommand) {
    await this.assertSellerAuthorityRoutable(command);
    return await MarketplaceGatewayService.execute(actorPubky, command);
  }

  static async commitOfferCheckout(actorPubky: string, command: MarketplaceCommand) {
    return await this.executeMarketplaceCommand(actorPubky, command);
  }

  // ---------------------------------------------------------------------
  // Local pickup (Wave 7 safe subset, local pickup design PART A)
  //
  // Pickup details are restricted personal data. This layer NEVER writes
  // them to Dexie, a store, or any persistence: the buyer's revealed copy
  // is memory-only and re-fetched from the reveal read on each view (§A1),
  // and the seller's owner-read copy is returned to the caller, which holds
  // it in memory. The only writes are the service commands themselves.
  // ---------------------------------------------------------------------

  /**
   * The client-side deployment boundary for pickup commands (§A8): the
   * sandbox deployment stores and reveals no pickup details, so the commands
   * are refused before any bytes leave the client — the same refusal the
   * durable service answers on sandbox-payments deployments, in the same
   * shape: CONFLICT with the typed `pickup_unavailable` refusal.
   */
  private static assertPickupDeployment(operation: string): void {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.CONFLICT, 'Pickup is unavailable on this deployment.', {
        service: ErrorService.Marketplace,
        operation,
        context: { refusal: 'pickup_unavailable' },
      });
    }
  }

  /**
   * Command refusals come back in the response envelope (`ok:false`), not as
   * thrown errors, so the typed pickup refusals (§A3/§A6/§A7) would never
   * reach a caller that branches on `context.refusal` — the entitled reads
   * already throw that shape. Re-throw a classified pickup refusal as the
   * same CONFLICT + `context.refusal` error the reads produce; unclassified
   * failures (revision conflicts, validation) keep the envelope for the
   * caller to handle.
   */
  private static throwIfPickupCommandRefusal(operation: string, response: MarketplaceCommandResponse): void {
    if (response.ok) return;
    const refusal = classifyMarketplacePickupCommandRefusal(response);
    if (!refusal) return;
    throw Err.client(ClientErrorCode.CONFLICT, pickupRefusalFailureMessage(refusal), {
      service: ErrorService.Marketplace,
      operation,
      context: { refusal },
    });
  }

  /**
   * The deployment's `pickup_available` capability (§A7), read from the
   * service's /health surface: false in every non-durable mode and whenever
   * the sealing key is absent or sandbox payments are enabled. 7.2b gates
   * every pickup affordance on this.
   */
  static async fetchPickupAvailable(): Promise<boolean> {
    return await MarketplaceGatewayService.getPickupAvailability();
  }

  /** The deployment's digital delivery capability (digital delivery design §6 B5), read from /health. */
  static async fetchDigitalDeliveryCapability(): Promise<MarketplaceDigitalDeliveryCapability> {
    return await MarketplaceGatewayService.getDigitalDeliveryCapability();
  }

  /**
   * The paying buyer's per-line pickup-details reveal (§A3): the pinned
   * snapshot recorded at payment, straight from the service's entitled read.
   * The returned details stay IN MEMORY ONLY — they are written to no Dexie
   * table, no store, and no cache, and must be re-fetched on each view.
   */
  static async fetchPickupReveal(actorPubky: string, orderId: string): Promise<MarketplacePickupReveal> {
    return await MarketplaceGatewayService.getOrderPickupDetails(actorPubky, orderId);
  }

  /**
   * The seller's owner read of their own current pickup details plus the
   * surviving version counter (§A4): the input the next
   * `pickup_details.set` compare-and-swaps against.
   */
  static async fetchSellerPickupDetails(
    actorPubky: string,
    listingAggregateId: string,
  ): Promise<MarketplaceSellerPickupDetails> {
    return await MarketplaceGatewayService.getListingPickupDetails(actorPubky, listingAggregateId);
  }

  /**
   * `pickup_details.set` (§A7): sealed whole-payload upsert of a listing's
   * pickup details. `expectedVersion` CASes against the per-listing version
   * counter (0 when no details exist yet); a stale value gets the standard
   * 409 REVISION_CONFLICT refetch-and-retry treatment. The envelope's
   * `expectedRevision` is always 0 — the CAS rides the payload.
   */
  static async commitSetPickupDetails(
    actorPubky: string,
    input: {
      sellerPubky: string;
      listingId: string;
      expectedVersion: number;
      details: MarketplacePickupDetails;
    },
  ): Promise<MarketplaceCommandResponse> {
    this.assertPickupDeployment('commitSetPickupDetails');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceListingAggregateId(input.sellerPubky, input.listingId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'pickup_details.set',
      payload: { expectedVersion: input.expectedVersion, details: input.details },
    });
    const response = await this.executeMarketplaceCommand(actorPubky, command);
    this.throwIfPickupCommandRefusal('commitSetPickupDetails', response);
    return response;
  }

  /**
   * `pickup_details.clear` (§A3/§A7): removes the listing's pickup details.
   * The service retains only versions pinned by a paid, non-terminal order;
   * the version counter survives, so the next set continues the sequence.
   */
  static async commitClearPickupDetails(
    actorPubky: string,
    input: {
      sellerPubky: string;
      listingId: string;
      expectedVersion: number;
    },
  ): Promise<MarketplaceCommandResponse> {
    this.assertPickupDeployment('commitClearPickupDetails');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceListingAggregateId(input.sellerPubky, input.listingId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'pickup_details.clear',
      payload: { expectedVersion: input.expectedVersion },
    });
    const response = await this.executeMarketplaceCommand(actorPubky, command);
    this.throwIfPickupCommandRefusal('commitClearPickupDetails', response);
    return response;
  }

  // ---------------------------------------------------------------------
  // Digital delivery seller setup (digital delivery design §2, §6 C1–C5)
  //
  // A file is encrypted here with a fresh AES-256-GCM key; only the
  // ciphertext goes to the seller's homeserver, and the key goes once, to the
  // service, inside `digital_delivery.set`, which seals it. Neither the key
  // nor the plaintext is persisted, stored or logged; the seller's own link
  // or text from the owner read is returned to the caller only.
  // ---------------------------------------------------------------------

  /** The durable-service boundary for digital delivery: the sandbox seals and releases nothing. */
  private static assertDigitalDeployment(operation: string): void {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.CONFLICT, DIGITAL_DELIVERY_COPY.unavailable, {
        service: ErrorService.Marketplace,
        operation,
        context: { refusal: 'digital_delivery_unavailable' },
      });
    }
  }

  /** The seller's owner read of one listing's digital delivery (§6 C5). */
  static async fetchSellerDigitalDelivery(
    actorPubky: string,
    listingAggregateId: string,
  ): Promise<MarketplaceSellerDigitalDelivery> {
    return await MarketplaceGatewayService.getListingDigitalDelivery(actorPubky, listingAggregateId);
  }

  /**
   * `digital_delivery.set`: sets how buyers receive the listing as version
   * `expectedVersion + 1`. A file is encrypted, bound to the seller,
   * deliverable id and version, and written to the seller's homeserver
   * before the command. When the service refuses, the new ciphertext is
   * referenced by no version, so it is deleted (best effort). The response
   * is returned as-is; refusals stay in the envelope.
   *
   * A command that throws after the upload has an unknown outcome: the
   * service may have set the version before the reply was lost, and deleting
   * a referenced ciphertext would break every later download. The same
   * command (same id and payload) is sent once more, which returns the
   * service's stored result: a refusal deletes the upload and is returned,
   * a success is returned, and a second throw keeps the upload (an
   * unreferenced ciphertext under a random id reveals nothing) and rethrows
   * the first error. A failed encryption throws with `refusal:
   * 'encrypt_failed'`, before anything leaves the device.
   */
  static async commitSetDigitalDelivery(
    actorPubky: string,
    input: {
      sellerPubky: string;
      listingId: string;
      expectedVersion: number;
      delivery: MarketplaceDigitalDeliveryInput;
    },
  ): Promise<MarketplaceCommandResponse> {
    this.assertDigitalDeployment('commitSetDigitalDelivery');
    let uploadedUrl: string | null = null;
    let delivery: MarketplaceDigitalDeliverySet;
    if (input.delivery.kind === 'file') {
      const version = input.expectedVersion + 1;
      const deliverableId = newDigitalDeliverableId();
      let encrypted: Awaited<ReturnType<typeof encryptDigitalDeliverable>>;
      try {
        encrypted = await encryptDigitalDeliverable({
          plaintext: input.delivery.bytes,
          sellerPubky: input.sellerPubky,
          deliverableId,
          version,
        });
      } catch (cause) {
        throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'The file could not be encrypted on this device.', {
          service: ErrorService.Local,
          operation: 'commitSetDigitalDelivery',
          context: { refusal: 'encrypt_failed' },
          cause,
        });
      }
      const url = digitalDeliverableUrl(input.sellerPubky, deliverableId, version);
      await CommerceHomeserverService.putDeliverable(url, encrypted.ciphertext);
      uploadedUrl = url;
      delivery = {
        kind: 'file',
        deliverableId,
        version,
        key: encrypted.key,
        iv: encrypted.iv,
        ciphertextBlake3: encrypted.ciphertextBlake3,
        plaintextBlake3: encrypted.plaintextBlake3,
        sizeBytes: encrypted.sizeBytes,
        contentType: digitalFileContentType(input.delivery.contentType),
        fileName: digitalFileName(input.delivery.fileName),
      };
    } else {
      delivery = input.delivery;
    }
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceListingAggregateId(input.sellerPubky, input.listingId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'digital_delivery.set',
      payload: { expectedVersion: input.expectedVersion, delivery },
    });
    let response: MarketplaceCommandResponse;
    try {
      response = await this.executeMarketplaceCommand(actorPubky, command);
    } catch (error) {
      if (!uploadedUrl) throw error;
      const replayed = await this.executeMarketplaceCommand(actorPubky, command).catch(() => null);
      if (!replayed) {
        Logger.warn('A digital delivery set had no answer; its uploaded deliverable is kept');
        throw error;
      }
      response = replayed;
    }
    if (!response.ok && uploadedUrl) {
      await CommerceHomeserverService.deleteDeliverable(uploadedUrl).catch(() => {
        Logger.warn('An unreferenced digital deliverable could not be deleted');
      });
    }
    return response;
  }

  /** `digital_delivery.clear`: removes delivery; the service refuses while buyers pay for or download it (C4). */
  static async commitClearDigitalDelivery(
    actorPubky: string,
    input: { sellerPubky: string; listingId: string; expectedVersion: number },
  ): Promise<MarketplaceCommandResponse> {
    this.assertDigitalDeployment('commitClearDigitalDelivery');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceListingAggregateId(input.sellerPubky, input.listingId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'digital_delivery.clear',
      payload: { expectedVersion: input.expectedVersion },
    });
    return await this.executeMarketplaceCommand(actorPubky, command);
  }

  /**
   * The buyer's pinned digital payload for one order (digital delivery design
   * §4.2). The service writes an access row on every read, and an opened
   * instant line stays sold if the order is later cancelled (§6 E8), so this
   * is called only when the buyer asks to open a line.
   */
  static async fetchOrderDigitalDelivery(
    actorPubky: string,
    orderId: string,
    lineIndex: number,
  ): Promise<MarketplaceOrderDigitalDelivery> {
    this.assertDigitalDeployment('fetchOrderDigitalDelivery');
    return await MarketplaceGatewayService.getOrderDigitalDelivery(actorPubky, orderId, lineIndex);
  }

  /**
   * Opens a buyer's file line (§3.4): reads the ciphertext from the seller's
   * homeserver, checks its length and BLAKE3 against the pin, decrypts it
   * with the pinned key under the seller, deliverable and version, and
   * checks the plaintext BLAKE3. The bytes are returned only when all hold;
   * nothing is stored.
   */
  static async openOrderDigitalFile(
    line: Extract<MarketplaceOrderDigitalLine, { kind: 'file' }>,
  ): Promise<
    | { ok: true; bytes: Uint8Array; fileName: string; contentType: string }
    | { ok: false; reason: DigitalFileOpenFailure }
  > {
    let ciphertext: Uint8Array<ArrayBuffer>;
    try {
      ciphertext = await CommerceHomeserverService.getDeliverable(
        digitalDeliverableUrl(line.sellerPubky, line.deliverableId, line.version),
        digitalCiphertextBytes(line.sizeBytes),
      );
    } catch (error) {
      // A body larger than the pinned ciphertext is not the file that was paid for.
      const oversized = isAppError(error) && error.code === ClientErrorCode.PAYLOAD_TOO_LARGE;
      return { ok: false, reason: oversized ? 'ciphertext_mismatch' : 'fetch_failed' };
    }
    const opened = await openDigitalDeliverable({
      ciphertext,
      key: line.key,
      iv: line.iv,
      ciphertextBlake3: line.ciphertextBlake3,
      plaintextBlake3: line.plaintextBlake3,
      sizeBytes: line.sizeBytes,
      sellerPubky: line.sellerPubky,
      deliverableId: line.deliverableId,
      version: line.version,
    });
    if (!opened.ok) return opened;
    return { ok: true, bytes: opened.plaintext, fileName: line.fileName, contentType: line.contentType };
  }

  /** The seller's delivery evidence on one of their digital orders (§3 "Seller's orders"). */
  static async fetchOrderDigitalEvidence(
    actorPubky: string,
    orderId: string,
  ): Promise<MarketplaceOrderDigitalEvidence> {
    this.assertDigitalDeployment('fetchOrderDigitalEvidence');
    return await MarketplaceGatewayService.getOrderDigitalEvidence(actorPubky, orderId);
  }

  /** An email-kind order's delivery email and emailed time (§4.3, §6 F5–F9). */
  static async fetchOrderDeliveryEmail(actorPubky: string, orderId: string): Promise<MarketplaceOrderDeliveryEmail> {
    this.assertDigitalDeployment('fetchOrderDeliveryEmail');
    return await MarketplaceGatewayService.getOrderDeliveryEmail(actorPubky, orderId);
  }

  /**
   * `order.set_delivery_email` (§6 F11, F12): the buyer replaces the address
   * the seller sends an email-kind line to. `expectedRevision` is the
   * order's current revision.
   */
  static async commitSetDeliveryEmail(
    actorPubky: string,
    input: { orderId: string; expectedRevision: number; deliveryEmail: string },
  ): Promise<MarketplaceCommandResponse> {
    this.assertDigitalDeployment('commitSetDeliveryEmail');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceOrderAggregateId(input.orderId),
      expectedRevision: input.expectedRevision,
      issuedAt: new Date().toISOString(),
      kind: 'order.set_delivery_email',
      payload: { orderId: input.orderId, deliveryEmail: input.deliveryEmail },
    });
    return await this.executeMarketplaceCommand(actorPubky, command);
  }

  /**
   * `fulfillment.deliver_digital` (§4.3, §6 F13): the seller marks an
   * order's email or message lines delivered after sending them.
   * `expectedRevision` is the order's current revision, so a racing buyer
   * cancel request and this mark have exactly one winner (F15).
   */
  static async commitDeliverDigital(
    actorPubky: string,
    input: { orderId: string; expectedRevision: number; channel: MarketplaceDigitalDeliveryChannel },
  ): Promise<MarketplaceCommandResponse> {
    this.assertDigitalDeployment('commitDeliverDigital');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceOrderAggregateId(input.orderId),
      expectedRevision: input.expectedRevision,
      issuedAt: new Date().toISOString(),
      kind: 'fulfillment.deliver_digital',
      payload: { orderId: input.orderId, channel: input.channel },
    });
    return await this.executeMarketplaceCommand(actorPubky, command);
  }

  /**
   * `fulfillment.mark_ready` (§A6): the seller arms a paid pickup order for
   * handover (`paid` → `ready_for_pickup`). `expectedRevision` is the
   * order's current revision.
   */
  static async commitMarkReady(
    actorPubky: string,
    input: { orderId: string; expectedRevision: number },
  ): Promise<MarketplaceCommandResponse> {
    this.assertPickupDeployment('commitMarkReady');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceOrderAggregateId(input.orderId),
      expectedRevision: input.expectedRevision,
      issuedAt: new Date().toISOString(),
      kind: 'fulfillment.mark_ready',
      payload: { orderId: input.orderId },
    });
    const response = await this.executeMarketplaceCommand(actorPubky, command);
    this.throwIfPickupCommandRefusal('commitMarkReady', response);
    return response;
  }

  /**
   * `fulfillment.confirm_pickup` (§A6): either party confirms the handover
   * (`paid`/`ready_for_pickup` → `delivered`). A seller-actor confirm is
   * refused service-side while a post-payment terms change is unresolved.
   */
  static async commitConfirmPickup(
    actorPubky: string,
    input: { orderId: string; expectedRevision: number },
  ): Promise<MarketplaceCommandResponse> {
    this.assertPickupDeployment('commitConfirmPickup');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceOrderAggregateId(input.orderId),
      expectedRevision: input.expectedRevision,
      issuedAt: new Date().toISOString(),
      kind: 'fulfillment.confirm_pickup',
      payload: { orderId: input.orderId },
    });
    const response = await this.executeMarketplaceCommand(actorPubky, command);
    this.throwIfPickupCommandRefusal('commitConfirmPickup', response);
    return response;
  }

  /**
   * `checkout.create` with the Wave 7 fulfillment plumbing (§A2): the
   * buyer's per-(seller, fulfillment) group choice is assigned to every
   * line of the group and validated against what each line's listing
   * publishes — a disallowed choice is refused locally with a typed
   * validation error, never silently rewritten to shipping. The delivery
   * address rule is enforced by the command schema (required when any group
   * ships; forbidden on pickup-only checkouts).
   */
  static async commitCreateMarketplaceCheckout(
    actorPubky: string,
    input: CommerceCheckoutFulfillmentInput,
  ): Promise<MarketplaceCommandResponse> {
    const plan = resolveCheckoutFulfillment(input.lines, input.fulfillmentChoiceBySeller ?? {});
    if (!plan.ok) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        'A checkout group chooses a fulfillment its listing does not publish.',
        {
          service: ErrorService.Marketplace,
          operation: 'commitCreateMarketplaceCheckout',
          context: {
            sellerPubky: plan.sellerPubky,
            fulfillment: plan.fulfillment,
            listingAggregateId: plan.listingAggregateId,
          },
        },
      );
    }
    const commandId = crypto.randomUUID();
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId,
      aggregateId: buildMarketplaceCheckoutAggregateId(commandId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'checkout.create',
      payload: {
        lines: input.lines.map((line, index) => ({
          listingAggregateId: line.listingAggregateId,
          expectedRevision: line.expectedRevision,
          quantity: line.quantity,
          ...(line.variantId ? { variantId: line.variantId } : {}),
          ...(line.variantOptions && line.variantOptions.length > 0 ? { variantOptions: line.variantOptions } : {}),
          fulfillment: plan.lineFulfillments[index],
        })),
        ...(input.deliveryAddress ? { deliveryAddress: input.deliveryAddress } : {}),
        ...(input.deliveryEmail !== undefined ? { deliveryEmail: input.deliveryEmail } : {}),
        guaranteePolicyVersion: 1 as const,
      },
    });
    return await this.executeMarketplaceCommand(actorPubky, command);
  }

  /**
   * The multi-operator mismatch guard (docs/ecommerce/multi-operator.md,
   * increment 1). A seller's shop record may declare the transaction-service
   * authority it sells through (`shop.transactionService`, specs
   * `0.6.2-marketplace.7`). This client cannot route to arbitrary services
   * yet, so when a listing-aggregate command targets a seller whose declared
   * authority is a DIFFERENT origin than this deployment's configured
   * service, the command is refused with an honest message — instead of
   * silently registering the seller's listing into an authority they never
   * declared.
   *
   * Deliberately fail-open on absence: no shop record, no declared field, an
   * unreadable homeserver, or a sandbox deployment all keep today's
   * behavior. The declaration is the seller's routing statement, not a
   * security boundary — the transaction service authenticates actors itself.
   */
  private static async assertSellerAuthorityRoutable(command: MarketplaceCommand): Promise<void> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return;
    const aggregateId = typeof command.aggregateId === 'string' ? command.aggregateId : '';
    if (!aggregateId.startsWith('listing:')) return;
    const sellerPubky = aggregateId.slice('listing:'.length, 'listing:'.length + 52);
    if (sellerPubky.length !== 52) return;

    let declared: string | undefined;
    try {
      declared = (await this.getOrFetchShop(sellerPubky)).transactionService;
    } catch {
      return;
    }
    if (!declared) return;

    const configured = getMarketplaceUrl();
    let declaredOrigin: string;
    let configuredOrigin: string;
    try {
      declaredOrigin = new URL(declared).origin;
      configuredOrigin = new URL(configured).origin;
    } catch {
      return;
    }
    if (declaredOrigin === configuredOrigin) return;

    throw Err.validation(
      ValidationErrorCode.INVALID_INPUT,
      'This listing is not registered with this Shop, so checkout cannot continue here.',
      {
        service: ErrorService.Marketplace,
        operation: 'assertSellerAuthorityRoutable',
        context: {
          sellerPubky,
          declaredOrigin: declaredOrigin.length <= 64 ? declaredOrigin : declaredOrigin.slice(0, 64),
          configuredOrigin: configuredOrigin.length <= 64 ? configuredOrigin : configuredOrigin.slice(0, 64),
          kind: command.kind,
        },
      },
    );
  }

  /**
   * Starts the interactive Marketplace Transaction Service session flow:
   * returns the `pubkyauth://` authorization URL to hand to the user's signer
   * (QR or deeplink) plus a lazy `awaitSession` that resolves once the signer
   * approves and the AuthToken is exchanged for a bearer session. AuthTokens
   * are single-use, so every retry must come back through here for a fresh
   * flow. Durable modes only; the service fails closed otherwise.
   */
  static beginMarketplaceSessionFlow() {
    return MarketplaceSessionService.beginSessionFlow();
  }

  static currentHomeserverGrantIsFull(): boolean {
    return HomeserverService.currentSessionHasFullGrant();
  }

  /**
   * Restores the account-scoped marketplace session persisted in
   * `localStorage`, returning its public facts (never the token) or null
   * when nothing valid is persisted for this account.
   */
  static restoreMarketplaceSession(pubky: string) {
    return MarketplaceSessionService.restorePersistedSession(pubky);
  }

  static restoreInventorySession(pubky: string) {
    return CommerceInventoryApplication.restoreInventorySession(pubky);
  }

  /**
   * Drops the Marketplace Transaction Service session this tab holds, with
   * only its own persisted record (a newer bearer another tab persisted
   * stays). The published-receipt memo backs the user-visible `published`
   * status, so it is cleared here too — session teardown matches the store
   * reset, and a later account re-reads its receipts instead of trusting a
   * prior session. The persisted Lock Server creator session is not this
   * bearer's and stays; sign-out removes it.
   */
  static clearMarketplaceSession(): void {
    MarketplaceSessionService.clearSession('cleared');
    this.clearSessionScopedState();
  }

  /**
   * Sign-out and account switch: also removes the purchase bearer and Lock
   * Server creator session another tab persisted, because none may outlive
   * the user who is leaving.
   */
  static clearMarketplaceSessionForSignOut(): void {
    MarketplaceSessionService.clearForSignOut();
    LocksFrontendSessionStore.clearForSignOut();
    this.clearSessionScopedState();
  }

  /**
   * Account switch without a sign-out: the purchase, Studio and Lock Server
   * sessions of any account but `keepPubky` go from memory and from rest,
   * with the caches that belonged to the account that left.
   */
  static clearMarketplaceSessionsOfOtherAccounts(keepPubky: string): void {
    MarketplaceSessionService.clearOtherAccounts(keepPubky);
    CommerceInventoryApplication.clearInventorySessionsOfOtherAccounts(keepPubky);
    LocksFrontendSessionStore.clearOtherAccounts(keepPubky);
    this.clearSessionScopedState();
  }

  private static clearSessionScopedState(): void {
    this.publishedReceiptUrls.clear();
    this.ownReviewHomeserverMisses.clear();
    CommercePrivKeyringApplication.clear();
  }

  static clearInventorySession(): void {
    CommerceInventoryApplication.clearInventorySession();
  }

  static clearInventorySessionForSignOut(): void {
    CommerceInventoryApplication.clearInventorySessionForSignOut();
  }

  /**
   * Controllers subscribe here so a transport-side `clearSession` (TTL, 401,
   * sign-out) can null the zustand copy without the service touching stores.
   */
  static onMarketplaceSessionEnded(listener: (event: MarketplaceSessionEndedEvent) => void): () => void {
    return MarketplaceSessionService.onSessionEnded(listener);
  }

  static onInventorySessionEnded(listener: (event: MarketplaceSessionEndedEvent) => void): () => void {
    return CommerceInventoryApplication.onInventorySessionEnded(listener);
  }

  static beginInventorySessionFlow(expectedPubky: string) {
    return CommerceInventoryApplication.beginInventorySessionFlow(expectedPubky);
  }

  /**
   * True while `MarketplaceSessionService.getActiveSession()` still holds a
   * token inside the expiry margin. Callers must not duplicate that TTL rule.
   */
  static hasActiveMarketplaceSession(): boolean {
    return MarketplaceSessionService.getActiveSession() !== null;
  }

  static async getMarketplaceListingProjection(actorPubky: string | null, aggregateId: string) {
    return await MarketplaceGatewayService.getListing(actorPubky, aggregateId);
  }

  static async getMarketplaceSellerListingProjection(actorPubky: string, aggregateId: string) {
    return await MarketplaceGatewayService.getSellerListing(actorPubky, aggregateId);
  }

  static async getMarketplaceListingBids(actorPubky: string | null, aggregateId: string) {
    return await MarketplaceGatewayService.getListingBids(actorPubky, aggregateId);
  }

  static async getMarketplaceConversations(actorPubky: string) {
    return await MarketplaceGatewayService.getConversations(actorPubky);
  }

  static async getMarketplaceOffers(actorPubky: string) {
    return await MarketplaceGatewayService.getOffers(actorPubky);
  }

  /**
   * The account's marketplace notifications. In durable modes a
   * `message_received` row is never returned: private messages are
   * end-to-end encrypted, no service writer can attest them, and a row naming
   * a sender would show who wrote without the mute list being consulted.
   * Durable messaging is surfaced only by the inbox, which applies it.
   */
  static async getMarketplaceNotifications(actorPubky: string) {
    const notifications = await MarketplaceGatewayService.getNotifications(actorPubky);
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return notifications;
    return notifications.filter((notification) => notification.type !== 'message_received');
  }

  static async getMarketplaceNotificationPreferences(actorPubky: string) {
    return await MarketplaceGatewayService.getNotificationPreferences(actorPubky);
  }

  static async getMarketplaceOrders(actorPubky: string) {
    return await MarketplaceGatewayService.getOrders(actorPubky);
  }

  static async getMarketplacePayment(actorPubky: string, paymentId: string) {
    return await MarketplaceGatewayService.getPayment(actorPubky, paymentId);
  }

  static async confirmBitcoinPayment(actorPubky: string, orderId: string, reason?: string) {
    return await MarketplaceGatewayService.confirmBitcoinPayment(actorPubky, orderId, reason);
  }

  static async resolveBitcoinPayment(
    actorPubky: string,
    orderId: string,
    input: {
      outcome: 'paid' | 'refunded' | 'abandoned';
      reason?: string;
      externalRefundReference?: string;
    },
    idempotencyKey: string,
  ) {
    return await MarketplaceGatewayService.resolveBitcoinPayment(actorPubky, orderId, input, idempotencyKey);
  }

  // --- Seller-configurable payment methods (durable service only) ----------

  static async getSellerPaymentConfig(sellerPubky: string) {
    return await MarketplaceGatewayService.getSellerPaymentConfig(sellerPubky);
  }

  /**
   * Whether the buyer can receive a Bitcoin payment request from the Shop's
   * Paykit server (see {@link BuyerPaykitWallet}). The registry wins over
   * receiver markers: Bitkit 2.6 keeps the markers 2.5 published but no
   * longer answers on them. So a registry read that fails (anything but a
   * 404, already logged by the homeserver service) is `unverified`, never a
   * marker verdict. Rejects only when the marker read fails after the
   * registry was ruled out.
   */
  static async fetchBuyerPaykitWallet(buyerPubky: string): Promise<BuyerPaykitWallet> {
    let registry: { found: false } | { found: true; json: unknown };
    try {
      registry = await HomeserverService.getJsonIfFound<unknown>({
        url: paykitAppRegistryUrl(buyerPubky),
        logUrl: PAYKIT_APP_REGISTRY_PATH,
      });
    } catch {
      return 'unverified';
    }
    if (registry.found && foundAppRegistryShowsNewWallet(registry.json)) return 'unsupported';
    return (await PaykitMessagingService.hasPaymentRequestReceiver(buyerPubky)) ? 'payable' : 'not_payable';
  }

  static async getMyPaymentConfig(actorPubky: string) {
    return await MarketplaceGatewayService.getMyPaymentConfig(actorPubky);
  }

  static async putMyPaymentConfig(
    actorPubky: string,
    input: {
      bitcoinEnabled: boolean;
      stripePaymentLink: string | null;
      stripeRestrictedKey?: string;
      paypalMerchantEmail: string | null;
    },
  ) {
    return await MarketplaceGatewayService.putMyPaymentConfig(actorPubky, input);
  }

  static async bindPaymentMethod(actorPubky: string, orderId: string, method: PaymentMethodKind) {
    return await MarketplaceGatewayService.bindPaymentMethod(actorPubky, orderId, method);
  }

  static async verifyStripePayment(actorPubky: string, orderId: string) {
    return await MarketplaceGatewayService.verifyStripePayment(actorPubky, orderId);
  }

  static async markFiatPaid(actorPubky: string, orderId: string, transactionRef?: string) {
    return await MarketplaceGatewayService.markFiatPaid(actorPubky, orderId, transactionRef);
  }

  static async getMyShippingConfig(actorPubky: string) {
    return await MarketplaceGatewayService.getMyShippingConfig(actorPubky);
  }

  static async putMyShippingConfig(
    actorPubky: string,
    input: { shippoApiKey?: string; shipFrom: ShipFromAddress | null },
  ) {
    return await MarketplaceGatewayService.putMyShippingConfig(actorPubky, input);
  }

  static async quoteShippingRates(actorPubky: string, orderId: string, parcel: ShippingParcel) {
    return await MarketplaceGatewayService.quoteShippingRates(actorPubky, orderId, parcel);
  }

  static async purchaseShippingLabel(actorPubky: string, orderId: string, rateId: string) {
    return await MarketplaceGatewayService.purchaseShippingLabel(actorPubky, orderId, rateId);
  }

  static async getShippingLabel(actorPubky: string, orderId: string) {
    return await MarketplaceGatewayService.getShippingLabel(actorPubky, orderId);
  }

  static async confirmFiatReceived(actorPubky: string, orderId: string) {
    return await MarketplaceGatewayService.confirmFiatReceived(actorPubky, orderId);
  }

  static async isPaykitAccountClaimed(pubky: string) {
    return await MarketplacePaykitClaimService.isAccountClaimed(pubky);
  }

  static async getMarketplaceReceipt(actorPubky: string, receiptId: string) {
    return await MarketplaceGatewayService.getReceipt(actorPubky, receiptId);
  }

  static async getMarketplaceOrder(actorPubky: string, orderId: string) {
    return await MarketplaceGatewayService.getOrder(actorPubky, orderId);
  }

  static async uploadMarketplaceAttachment(actorPubky: string, recipientPubky: string, file: File) {
    return await MarketplaceGatewayService.uploadAttachment(actorPubky, recipientPubky, file);
  }

  static async fetchMarketplaceAttachment(actorPubky: string, attachmentId: string) {
    return await MarketplaceGatewayService.fetchAttachment(actorPubky, attachmentId);
  }

  static async submitLocksPaykitProof(params: {
    creatorPubky: string;
    readerPubky: string;
    bundleId: string;
    lockResource: string;
    criterionId: string;
  }) {
    return await LocksGatewayService.submitPaykitProof(params);
  }

  /**
   * The buyer's side of a real Locks/Paykit payment (`locks-paykit` mode):
   *
   * 1. Generate (or reuse a persisted, not-yet-registered) bundle id and
   *    submit the proof bundle to the Lock Server, which requests the real
   *    Paykit invoice and delivers the private Payment Request to the buyer's
   *    wallet.
   * 2. Register the correlation with the transaction service via
   *    `payment.register_locks`, sourcing `expected_revision` from the fresh
   *    payment projection the caller just read.
   *
   * This NEVER advances the payment: registration flips the payment to the
   * `locks` adapter and the service's worker independently verifies the Locks
   * lifecycle before confirming (ADR-0019 §7). Returns the raw command
   * response so callers can apply the standard revision-conflict handling
   * (refetch and retry). The correlation — including the bearer bundle id —
   * is persisted in the buyer's account-scoped database so the flow survives
   * a reload and the purchased content stays unlockable.
   */
  static async beginMarketplaceLocksPayment({
    buyerPubky,
    order,
    payment,
    digitalLock,
  }: {
    buyerPubky: string;
    order: MarketplaceOrder;
    payment: MarketplacePayment;
    digitalLock: CommerceDigitalLock;
  }): Promise<MarketplaceCommandResponse> {
    if (getCommerceAdapterMode() !== 'locks-paykit') {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Real Locks/Paykit payments are not enabled in this deployment.', {
        service: ErrorService.Locks,
        operation: 'beginMarketplaceLocksPayment',
      });
    }
    const creator = lockPolicyCreator(digitalLock.policyUri);
    const bareLockResource = toBareLockResource(digitalLock.policyUri);
    if (!creator || !bareLockResource) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'The listing carries an invalid Locks policy URI.', {
        service: ErrorService.Locks,
        operation: 'beginMarketplaceLocksPayment',
      });
    }
    if (creator !== order.sellerPubky) {
      // The service enforces this too; refusing here keeps a mismatched lock
      // from ever producing an upstream lifecycle.
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'The lock creator is not this order\u2019s seller.', {
        service: ErrorService.Locks,
        operation: 'beginMarketplaceLocksPayment',
      });
    }

    const existing = await LocalCommerceService.getLocksCorrelation(buyerPubky, payment.id);
    let bundleId = existing?.bundle_id;
    const submit = async (id: string) => {
      await LocksGatewayService.submitPaykitProof({
        creatorPubky: creator,
        readerPubky: buyerPubky,
        bundleId: id,
        lockResource: digitalLock.policyUri,
        criterionId: digitalLock.criterionId,
      });
    };
    if (!existing) {
      bundleId = await LocksGatewayService.generateBundleId();
      // Persist BEFORE the submit: the bundle id is the buyer's only handle on
      // the upstream lifecycle. A Lock Server with durable invoice admission
      // (pubky/locks#72) keeps the task even when its response is lost, so a
      // retry must find that task again rather than mint a second one.
      await LocalCommerceService.upsertLocksCorrelation({
        owner_id: buyerPubky,
        payment_id: payment.id,
        order_id: order.id,
        seller_pubky: creator,
        bundle_id: bundleId,
        policy_uri: digitalLock.policyUri,
        criterion_id: digitalLock.criterionId,
        content_path: digitalLock.contentPath,
        resource_hash: digitalLock.resourceHash,
        window_expires_at: null,
        registered: false,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      await submit(bundleId);
    } else if (!existing.registered) {
      // An unregistered correlation may predate a submit that never reached the
      // Lock Server. Look the task up: if it exists the buyer keeps polling it,
      // and only a missing task is submitted, with the same bundle id. A
      // submitted bundle is never submitted again.
      const task = await LocksGatewayService.findVerification(creator, existing.bundle_id);
      if (!task) await submit(existing.bundle_id);
    }

    const response = await MarketplaceGatewayService.execute(buyerPubky, {
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplacePaymentAggregateId(payment.id),
      expectedRevision: payment.revision,
      issuedAt: new Date().toISOString(),
      kind: 'payment.register_locks',
      payload: { paymentId: payment.id, bundleId: bundleId!, pubkyLockResource: bareLockResource },
    });
    if (response.ok) {
      const verification = (response.result as { verification?: { windowExpiresAt?: string } }).verification;
      await LocalCommerceService.markLocksCorrelationRegistered(
        buyerPubky,
        payment.id,
        verification?.windowExpiresAt ?? null,
        Date.now(),
      );
    }
    return response;
  }

  static async getMarketplaceLocksCorrelation(buyerPubky: string, paymentId: string) {
    return await LocalCommerceService.getLocksCorrelation(buyerPubky, paymentId);
  }

  /**
   * Redeems a confirmed Locks payment for the purchased digital content:
   * issues the short-lived access credential from the persisted bundle id,
   * reads the guarded bytes through the Lock Server proxy, and verifies their
   * BLAKE3 hash against the hash the seller published in the listing record.
   * A hash mismatch is a content-integrity failure and throws — the bytes are
   * never returned as if they were the purchased content.
   */
  static async unlockMarketplaceLocksContent(
    buyerPubky: string,
    paymentId: string,
  ): Promise<{ bytes: Uint8Array; contentPath: string }> {
    const correlation = await LocalCommerceService.getLocksCorrelation(buyerPubky, paymentId);
    if (!correlation) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'No Locks correlation is stored for this payment.', {
        service: ErrorService.Locks,
        operation: 'unlockMarketplaceLocksContent',
      });
    }
    const credential = await LocksGatewayService.issueAccessCredential(correlation.seller_pubky, correlation.bundle_id);
    const blob = await LocksGatewayService.fetchGuardedContent(correlation.content_path, credential.credential);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = bytesToHex(blake3(bytes));
    if (digest !== correlation.resource_hash) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'The delivered content does not match the listed hash.', {
        service: ErrorService.Locks,
        operation: 'unlockMarketplaceLocksContent',
        context: { contentPath: correlation.content_path },
      });
    }
    return { bytes, contentPath: correlation.content_path };
  }

  /**
   * Exchanges a Lock Server legacy-connect completion (`code`/`state`) for a
   * creator frontend session — the seller-setup "connected" proof. When
   * `accountPubky` is the signed-in Shop identity the bearer is persisted so
   * Step 1 survives reload; sign-out still wipes it via {@link clearMarketplaceSession}.
   */
  static async createLocksFrontendSession(code: string, state: string, accountPubky?: string) {
    const session = await LocksGatewayService.createFrontendSession(code, state);
    if (!accountPubky || !locksCreatorMatchesShopPubky(session.creator, accountPubky)) {
      return session;
    }
    LocksFrontendSessionStore.save({
      token: session.session_token,
      creator: session.creator,
      pubky: accountPubky,
    });
    return session;
  }

  static async getLocksCreatorAuthorityStatus(sessionToken: string) {
    return await LocksGatewayService.getCreatorAuthorityStatus(sessionToken);
  }

  static async getLocksPublicCreatorAuthorityStatus(accountPubky: string) {
    return await LocksGatewayService.getPublicCreatorAuthorityStatus(accountPubky);
  }

  static restoreLocksFrontendSession(accountPubky: string) {
    return LocksFrontendSessionStore.restore(accountPubky);
  }

  static clearLocksFrontendSession(token: string): void {
    LocksFrontendSessionStore.clear(token);
  }

  static async lookupLocksVerification(creatorPubky: string, bundleId: string) {
    return await LocksGatewayService.lookupVerification(creatorPubky, bundleId);
  }

  /**
   * The buyer's view of the Lock Server task behind a Locks payment: wallet
   * setup in progress, a terminal admission failure, or neither. `null` when
   * no correlation is stored or the Lock Server holds no task for it.
   */
  static async fetchMarketplaceLocksAdmission(buyerPubky: string, paymentId: string) {
    const correlation = await LocalCommerceService.getLocksCorrelation(buyerPubky, paymentId);
    if (!correlation) return null;
    const lifecycle = await LocksGatewayService.findVerification(correlation.seller_pubky, correlation.bundle_id);
    return lifecycle ? locksAdmissionView(lifecycle) : null;
  }

  static async issueLocksAccessCredential(creatorPubky: string, bundleId: string) {
    return await LocksGatewayService.issueAccessCredential(creatorPubky, bundleId);
  }

  static async fetchLocksGuardedContent(relativePath: string, credential: string) {
    return await LocksGatewayService.fetchGuardedContent(relativePath, credential);
  }

  static getPaykitSetupUrl(returnTo: string, state: string, creator: string) {
    return LocksGatewayService.buildPaykitSetupUrl(returnTo, state, creator);
  }

  /**
   * BTC/USD rate for the indicative "≈" price estimates shown beside listing
   * prices. Display-only: nothing transactional consumes this rate, and it
   * throws when unavailable so the UI shows no estimate instead of a stale
   * or invented number.
   */
  static async getIndicativeBtcRate() {
    return await ExchangerateService.getIndicativeBtcRate();
  }

  static async isFavorite(ownerPubky: string, listingId: string): Promise<boolean> {
    return await LocalCommerceService.isFavorite(ownerPubky, listingId);
  }

  static async getCartItems(ownerPubky: string) {
    return await LocalCommerceService.getCartItems(ownerPubky);
  }

  static async commitUpsertCartItem(
    ownerPubky: string,
    listingId: string,
    variantId: string,
    quantity: number,
  ): Promise<void> {
    await LocalCommerceService.upsertCartItem(ownerPubky, listingId, variantId, quantity, Date.now());
  }

  static async commitUpsertAwardCartItem(
    ownerPubky: string,
    listingId: string,
    variantId: string,
    quantity: number,
    awardId: string,
    offerRevision: number,
  ): Promise<void> {
    await LocalCommerceService.upsertAwardCartItem(
      ownerPubky,
      listingId,
      variantId,
      quantity,
      awardId,
      offerRevision,
      Date.now(),
    );
  }

  static async commitDeleteCartItem(
    ownerPubky: string,
    listingId: string,
    variantId: string,
    awardId?: string,
  ): Promise<void> {
    await LocalCommerceService.deleteCartItem(ownerPubky, listingId, variantId, awardId);
  }

  static async commitClearCart(ownerPubky: string): Promise<void> {
    await LocalCommerceService.clearCart(ownerPubky);
  }

  static async getDeliveryAddresses(ownerPubky: string) {
    return await LocalCommerceService.getDeliveryAddresses(ownerPubky);
  }

  static async commitUpsertDeliveryAddress(
    ownerPubky: string,
    addressId: string,
    input: CommerceDeliveryAddressInput,
  ): Promise<void> {
    await LocalCommerceService.upsertDeliveryAddress(ownerPubky, addressId, input, Date.now());
  }

  static async commitDeleteDeliveryAddress(ownerPubky: string, addressId: string): Promise<void> {
    await LocalCommerceService.deleteDeliveryAddress(ownerPubky, addressId);
  }

  static async commitSetDefaultDeliveryAddress(ownerPubky: string, addressId: string): Promise<void> {
    await LocalCommerceService.setDefaultDeliveryAddress(ownerPubky, addressId, Date.now());
  }

  static async commitMarkDeliveryAddressUsed(ownerPubky: string, addressId: string): Promise<void> {
    await LocalCommerceService.markDeliveryAddressUsed(ownerPubky, addressId, Date.now());
  }

  static async getShippingPresets(ownerPubky: string) {
    return await LocalCommerceService.getShippingPresets(ownerPubky);
  }

  static async commitUpsertShippingPreset(
    ownerPubky: string,
    presetId: string,
    input: CommerceShippingPresetInput,
  ): Promise<void> {
    await LocalCommerceService.upsertShippingPreset(ownerPubky, presetId, input, Date.now());
  }

  static async commitDeleteShippingPreset(ownerPubky: string, presetId: string): Promise<void> {
    await LocalCommerceService.deleteShippingPreset(ownerPubky, presetId);
  }

  static async getFavorites(ownerPubky: string) {
    return await LocalCommerceService.getFavorites(ownerPubky);
  }

  static async commitCreateFavorite(ownerPubky: string, listingId: string): Promise<void> {
    await LocalCommerceService.createFavorite(ownerPubky, listingId, Date.now());
    await this.stageWatchlistPush(ownerPubky);
  }

  static async commitDeleteFavorite(ownerPubky: string, listingId: string): Promise<void> {
    await LocalCommerceService.deleteFavorite(ownerPubky, listingId, Date.now());
    // The watch baseline shadows the favorite row; an unwatched item must not
    // keep producing alerts. Already-created alerts stay — they were real
    // observations made while the item was watched.
    await LocalCommerceService.deleteWatchSnapshot(ownerPubky, listingId);
    await this.stageWatchlistPush(ownerPubky);
  }

  // ---------------------------------------------------------------------------
  // Cross-device watchlist sync (PRIVATE homeserver document)
  // ---------------------------------------------------------------------------

  /** In-flight sync per owner, so overlapping triggers share one round-trip. */
  private static watchlistSyncInFlight = new Map<string, Promise<CommerceWatchlistSyncStatus>>();

  private static watchlistSyncJobId(ownerPubky: string): string {
    return `watchlist|${ownerPubky}`;
  }

  /**
   * Marks the private watchlist document dirty in the retryable outbox
   * (`commerce_sync_jobs`, same table the review outbox uses). The job id is
   * deterministic per owner because the document is whole-state — the latest
   * sync always carries every prior change, so one pending job coalesces any
   * number of toggles. Local-first: this stages only; the actual push is
   * triggered by the controller after the toggle, and any staged job that
   * outlives a failed push heals on the next watchlist sync.
   */
  private static async stageWatchlistPush(ownerPubky: string): Promise<void> {
    if (getCommerceAdapterMode() === 'sandbox') return;
    const now = Date.now();
    await LocalCommerceService.restageSyncJob({
      id: this.watchlistSyncJobId(ownerPubky),
      owner_id: ownerPubky,
      entity_type: 'watchlist',
      entity_id: ownerPubky,
      operation: 'update',
      status: 'pending',
      attempts: 0,
      next_attempt_at: now,
      last_error_code: null,
      payload: {},
      created_at: now,
      updated_at: now,
    });
  }

  /**
   * Whether the CURRENT session can use private watchlist sync, decided from
   * session facts (`session.info.capabilities`), never by probing for 403s:
   * - `capable` — the session's grant covers writing `/priv/pubky.app/`
   *   (the widened Ring grant, or the root `/:rw` of a recovery-phrase sign-in)
   * - `needs_reauth` — a live session whose grant predates the `/priv` scope;
   *   the user must approve a fresh sign-in for sync to work
   * - `no_session` — signed out or the session is still being restored
   */
  static getWatchlistSyncCapability(): CommerceWatchlistSyncCapability {
    if (!HomeserverService.hasActiveSession()) return 'no_session';
    return HomeserverService.canCurrentSessionWrite(PRIVATE_APP_DATA_PATH) ? 'capable' : 'needs_reauth';
  }

  /**
   * One full sync round of the private watchlist document: pull, merge,
   * apply locally, push back when the merge changed the remote.
   *
   * Local-first: Dexie is applied before any push, and a failed push leaves
   * the outbox job pending so the next sync heals it. The merge rule
   * (per-key LWW, tie -> tombstone) lives in `commerce.watchlist.ts`.
   *
   * Honesty contract: capability is decided from session facts up front, and
   * a 401/403 on the actual read or write ALSO returns `needs_reauth` — the
   * caller (controller) surfaces that state; nothing silently no-ops. A
   * browser without the Web Locks API gets `unsupported` and a refused lock
   * gets `error`; neither touches the homeserver.
   */
  static async syncWatchlist(ownerPubky: string): Promise<CommerceWatchlistSyncStatus> {
    if (getCommerceAdapterMode() === 'sandbox') return 'skipped';

    const capability = this.getWatchlistSyncCapability();
    if (capability === 'no_session') return 'skipped';
    if (capability === 'needs_reauth') return 'needs_reauth';

    const inFlight = this.watchlistSyncInFlight.get(ownerPubky);
    if (inFlight) return await inFlight;

    // Without a lock every tab shares, two rounds can interleave their
    // read-merge-write and one tab's change is lost. No lock, no remote work:
    // the list keeps working on this device and the outbox job stays.
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (typeof locks?.request !== 'function') return 'unsupported';

    const run = (async (): Promise<CommerceWatchlistSyncStatus> => {
      try {
        return await locks.request(`pubky-priv|watchlist|${ownerPubky}`, () => this.runWatchlistSync(ownerPubky));
      } catch (error) {
        Logger.warn('The watchlist sync lock was refused; the outbox job stays pending', privErrorSummary(error));
        return 'error';
      } finally {
        this.watchlistSyncInFlight.delete(ownerPubky);
      }
    })();
    this.watchlistSyncInFlight.set(ownerPubky, run);
    return await run;
  }

  /** Test support: forgets in-flight rounds, as a second tab of the same origin would not see them. */
  static resetWatchlistSyncInFlight(): void {
    this.watchlistSyncInFlight.clear();
  }

  /**
   * The watchlist lives encrypted at an opaque v2 path. A plaintext v1
   * document (`watchlist.json`, written before encryption or by a cached
   * older build) is merged in, the merged state is written to v2 and read
   * back, and only then is v1 deleted. Without a key nothing is written:
   * no plaintext fallback and no empty overwrite.
   *
   * The outbox job is completed only if no change was staged after this
   * round read the local state; a later change keeps it pending.
   */
  private static async runWatchlistSync(ownerPubky: string): Promise<CommerceWatchlistSyncStatus> {
    const legacyUrl = CommerceRecordNormalizer.watchlistUri(ownerPubky);
    const jobId = this.watchlistSyncJobId(ownerPubky);
    try {
      const stagedAt = (await LocalCommerceService.getSyncJob(jobId))?.updated_at ?? null;
      const keys = await CommercePrivKeyringApplication.get(ownerPubky);
      if (keys.kind !== 'keys') return keys.kind === 'needs_reauth' ? 'needs_marketplace_approval' : keys.kind;
      const { keyring } = keys;

      let encrypted: CommerceWatchlistRecord | null = null;
      try {
        const payload = await CommercePrivStoreService.read(keyring, 'watchlist', WATCHLIST_PRIV_ENTRY_ID);
        if (payload !== null) encrypted = CommerceRecordNormalizer.watchlistRecord(payload);
      } catch (error) {
        if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
        throw error;
      }
      let legacy: CommerceWatchlistRecord | null = null;
      try {
        legacy = CommerceRecordNormalizer.watchlistRecord(
          await CommerceHomeserverService.fetchJson(legacyUrl, PRIV_V1_LOG_PATH),
        );
      } catch (error) {
        if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
        if (!(isAppError(error) && isNotFound(error))) throw error;
      }

      const [favorites, tombstoneRows] = await Promise.all([
        LocalCommerceService.getFavorites(ownerPubky),
        LocalCommerceService.getWatchTombstones(ownerPubky),
      ]);
      const localState = localRowsToWatchlistState(favorites, tombstoneRows);
      const encryptedState = encrypted ? watchlistRecordToState(encrypted) : emptyWatchlistState();
      const remoteState = legacy
        ? mergeWatchlistStates(encryptedState, watchlistRecordToState(legacy))
        : encryptedState;
      const merged = mergeWatchlistStates(localState, remoteState);

      if (!watchlistStatesEqual(merged, localState)) {
        await LocalCommerceService.applyWatchlistState(ownerPubky, merged.items, merged.tombstones);
      }

      const isEmptyAndUnpublished = !encrypted && !legacy && merged.items.size === 0 && merged.tombstones.size === 0;
      const remoteNeedsWrite = !isEmptyAndUnpublished && (!encrypted || !watchlistStatesEqual(merged, encryptedState));
      if (remoteNeedsWrite) {
        const remote = encrypted ?? legacy;
        const nowIso = new Date().toISOString();
        const createdAt = remote?.createdAt ?? nowIso;
        // Guard against clock skew between devices: updatedAt must not
        // precede createdAt or the record fails its own validation.
        const updatedAt = Date.parse(createdAt) > Date.now() ? createdAt : nowIso;
        const body = watchlistStateToRecordBody({
          ownerPubky,
          state: merged,
          revision: Math.max(encrypted?.revision ?? 0, legacy?.revision ?? 0) + 1,
          createdAt,
          updatedAt,
        });
        // Validate through the vendored specs builder before sealing, the
        // same guarantee every other marketplace record gets.
        const { PubkySpecsBuilder } = await import('pubky-app-specs');
        const built = new PubkySpecsBuilder(ownerPubky).createWatchlist(body);
        const record = CommerceRecordNormalizer.watchlistRecord(built.watchlist.toJson());
        try {
          await CommercePrivStoreService.write(keyring, 'watchlist', WATCHLIST_PRIV_ENTRY_ID, { ...record });
        } catch (error) {
          if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
          throw error;
        }
      }
      // v2 now holds a state that includes every v1 entry and tombstone.
      if (legacy) {
        assertPrivKeyringLive(keyring);
        await CommerceHomeserverService.delete(legacyUrl, PRIV_V1_LOG_PATH);
      }

      await LocalCommerceService.completeSyncJobIfUnchanged(jobId, stagedAt);
      return 'synced';
    } catch (error) {
      Logger.warn('Watchlist sync failed; the outbox job stays pending', privErrorSummary(error));
      return 'error';
    }
  }

  /**
   * 403 (scope refused) or 401 (session rejected) on the private document,
   * for a session that a step-up approval can widen. A grant session already
   * holds the full Shop grant (enforced at sign-in and restore), so a refusal
   * means its grant is no longer honored (revoked or expired), which no
   * step-up QR can fix: the round fails and retries on the next load.
   */
  private static isPrivateAccessDenied(error: unknown): boolean {
    const denied = hasHttpStatus(error, HttpStatusCode.FORBIDDEN) || hasHttpStatus(error, HttpStatusCode.UNAUTHORIZED);
    return denied && !HomeserverService.isCurrentSessionGrant();
  }

  // ---------------------------------------------------------------------
  // Portable order receipts (PRIVATE homeserver documents)
  // ---------------------------------------------------------------------

  /**
   * Session-scoped memo of encrypted receipt URLs confirmed present on the
   * owner's homeserver, so one browsing session re-reads each receipt entry
   * at most once. Keyed by the full owner-scoped URL, so an account switch
   * cannot bleed publication state across identities.
   */
  private static publishedReceiptUrls = new Set<string>();

  /** Test support: clears the session-scoped published-receipt memo. */
  static resetReceiptPublicationMemo(): void {
    this.publishedReceiptUrls.clear();
  }

  /**
   * Moves plaintext v1 receipts (`/priv/pubky.app/marketplace/v1/receipts/`)
   * into encrypted entries. Each one is parsed; when no sealed entry exists
   * it is written sealed and read back, and when one exists it must open to
   * exactly the same record. Only then is the plaintext deleted. A sealed
   * entry that differs, fails validation or does not open is never
   * overwritten, and both copies stay. One bounded batch per call; a file
   * that does not parse, or names another receipt than its path, stays in
   * place and leaves the pass incomplete.
   */
  private static async migratePlaintextReceipts(
    ownerPubky: string,
    keyring: PrivKeyring,
  ): Promise<'done' | 'incomplete' | 'needs_reauth'> {
    let urls: string[];
    try {
      urls = await CommerceHomeserverService.list(
        CommerceRecordNormalizer.orderReceiptDirectoryUri(ownerPubky),
        RECEIPT_MIGRATION_BATCH,
        PRIV_V1_LOG_PATH,
      );
    } catch (error) {
      if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
      Logger.warn(
        'Listing plaintext order receipts failed; the move retries on the next orders load',
        privErrorSummary(error),
      );
      return 'incomplete';
    }
    let incomplete = urls.length >= RECEIPT_MIGRATION_BATCH;
    for (const url of urls) {
      const receiptId = url.slice(url.lastIndexOf('/') + 1);
      try {
        const sealedUrl = privEntryUrl(keyring, 'order_receipt', receiptId);
        const legacy = CommerceRecordNormalizer.orderReceiptRecord(
          await CommerceHomeserverService.fetchJson(url, PRIV_V1_LOG_PATH),
        );
        if (legacy.receiptId !== receiptId || legacy.ownerPubky !== ownerPubky) {
          incomplete = true;
          continue;
        }
        const sealed = await CommercePrivStoreService.read(keyring, 'order_receipt', receiptId);
        if (sealed === null) {
          await CommercePrivStoreService.write(keyring, 'order_receipt', receiptId, { ...legacy });
        } else if (!this.isSameReceipt(sealed, legacy)) {
          Logger.warn('A sealed order receipt differs from its plaintext copy; both are kept');
          incomplete = true;
          continue;
        }
        assertPrivKeyringLive(keyring);
        await CommerceHomeserverService.delete(url, PRIV_V1_LOG_PATH);
        if (this.verifiedSealedReceipt(sealed ?? legacy, ownerPubky, receiptId) !== null) {
          this.publishedReceiptUrls.add(sealedUrl);
        }
      } catch (error) {
        if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
        if (isPrivKeyringRevoked(error)) return 'incomplete';
        Logger.warn(
          'Moving a plaintext order receipt failed; it retries on the next orders load',
          privErrorSummary(error),
        );
        incomplete = true;
      }
    }
    return incomplete ? 'incomplete' : 'done';
  }

  /** Whether a decrypted sealed receipt is exactly the validated plaintext one. */
  private static isSameReceipt(sealed: unknown, legacy: CommerceOrderReceiptRecord): boolean {
    try {
      return JSON.stringify(CommerceRecordNormalizer.orderReceiptRecord(sealed)) === JSON.stringify(legacy);
    } catch {
      return false;
    }
  }

  /**
   * A decrypted receipt counts as published only when it is a valid order
   * receipt of this owner, for this receipt id, whose attestations verify.
   */
  private static verifiedSealedReceipt(
    sealed: unknown,
    ownerPubky: string,
    receiptId: string,
  ): CommerceOrderReceiptRecord | null {
    let record: CommerceOrderReceiptRecord;
    try {
      record = CommerceRecordNormalizer.orderReceiptRecord(sealed);
    } catch {
      return null;
    }
    if (record.receiptId !== receiptId || record.ownerPubky !== ownerPubky) return null;
    if (verifyOwnOrderReceipt({ ...record }) === null) return null;
    if (record.editionAttestation !== undefined && verifyOwnDropEdition({ ...record }) === null) return null;
    return record;
  }

  /**
   * Publishes the portable order receipt (specs `0.6.2-marketplace.7`) for
   * every eligible paid order to the CURRENT user's own homeserver, sealed
   * at the opaque v2 entry for its receipt id, and first moves any
   * plaintext v1 receipts there — the "credible exit for orders" record: killing
   * the marketplace operator must still leave a signed, verifiable purchase
   * history on the participants' homeservers.
   *
   * The document embeds the service attestor's deterministic
   * `pubky-order-receipt+v1` JWS (re-fetchable idempotently), and the
   * record's fields are taken from the VERIFIED claims, never from local
   * projections, so record and attestation cannot disagree. The client
   * re-runs the offline verification recipe before every PUT and refuses to
   * publish anything that does not verify.
   *
   * Failure semantics mirror the watchlist document: capability is decided
   * from session facts, absence of an attestor is an honest `unavailable`,
   * and a failed PUT simply retries on the next orders-surface load (the
   * homeserver read is the durable "already published" check — no local
   * marker table to drift). The returned status is what the controller
   * mirrors into the store: a narrow (bridged or legacy) grant, or a
   * session the marketplace will not release the data key to, reports
   * `needs_reauth` instead of returning without a trace. Without a key
   * nothing is written; a sealed entry that does not decrypt is never
   * overwritten.
   */
  static async publishOrderReceipts(
    ownerPubky: string,
    orders: MarketplaceOrder[],
  ): Promise<CommerceReceiptPublicationStatus> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return 'skipped';
    if (!HomeserverService.hasActiveSession()) return 'skipped';
    if (!HomeserverService.canCurrentSessionWrite(PRIVATE_APP_DATA_PATH)) return 'needs_reauth';

    let keys: MarketplacePrivKeysResult;
    try {
      keys = await CommercePrivKeyringApplication.get(ownerPubky);
    } catch (error) {
      Logger.warn(
        'The private data key could not be read; receipts retry on the next orders load',
        privErrorSummary(error),
      );
      return 'unavailable';
    }
    if (keys.kind !== 'keys') return keys.kind === 'needs_reauth' ? 'needs_marketplace_approval' : keys.kind;
    const { keyring } = keys;
    const migration = await this.migratePlaintextReceipts(ownerPubky, keyring);
    if (migration === 'needs_reauth') return 'needs_reauth';

    const eligible = orders.filter(
      (order) =>
        typeof order.receiptId === 'string' && (order.buyerPubky === ownerPubky || order.sellerPubky === ownerPubky),
    );

    // Derived now, while the keyring is known live; a revoked keyring stops here.
    let entryUrls: Map<string, string>;
    try {
      entryUrls = new Map(
        eligible.map((order) => [
          order.receiptId as string,
          privEntryUrl(keyring, 'order_receipt', order.receiptId as string),
        ]),
      );
    } catch (error) {
      if (isPrivKeyringRevoked(error)) return 'unavailable';
      throw error;
    }

    for (const order of eligible) {
      const receiptId = order.receiptId as string;
      const url = entryUrls.get(receiptId) as string;
      if (this.publishedReceiptUrls.has(url)) continue;
      try {
        let sealed: unknown;
        try {
          sealed = await CommercePrivStoreService.read(keyring, 'order_receipt', receiptId);
        } catch (error) {
          if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
          throw error;
        }
        if (sealed !== null) {
          if (this.verifiedSealedReceipt(sealed, ownerPubky, receiptId) !== null) {
            this.publishedReceiptUrls.add(url);
          } else {
            Logger.warn('A sealed order receipt opens but does not verify; it is kept and not overwritten');
          }
          continue;
        }

        const attestation = await MarketplaceGatewayService.getReceiptAttestation(ownerPubky, receiptId);
        if (attestation === null) return 'unavailable';

        // Drop orders additionally carry a `pubky-drop-edition+v1` proof
        // ("edition N of M") in the same portable document (ADR 0026). Its
        // absence for a non-drop order is honest, not a failure.
        const editionAttestation =
          typeof order.dropAggregateId === 'string'
            ? await MarketplaceGatewayService.getEditionAttestation(ownerPubky, receiptId)
            : null;

        const { claims } = attestation;
        const wireBody = {
          schemaVersion: 1,
          recordType: 'order_receipt',
          ownerPubky,
          revision: 1,
          createdAt: claims.paidAt,
          updatedAt: claims.paidAt,
          role: claims.buyer === ownerPubky ? 'buyer' : 'seller',
          receiptId: claims.receipt,
          orderId: claims.order,
          buyerPubky: claims.buyer,
          sellerPubky: claims.seller,
          total:
            claims.v === 2
              ? {
                  amountMinor: claims.merchandiseTotal.amountMinor,
                  currency: claims.merchandiseTotal.currency,
                  exponent: claims.merchandiseTotal.exponent,
                }
              : { amountMinor: claims.totalMinor, currency: claims.currency, exponent: claims.exponent },
          ...(claims.v === 2 ? { settlementTotal: claims.settlementTotal } : {}),
          paidAt: claims.paidAt,
          receiptAttestation: attestation.jws,
          ...(editionAttestation !== null
            ? {
                editionAttestation: editionAttestation.jws,
                drop: {
                  dropId: editionAttestation.claims.drop,
                  edition: editionAttestation.claims.edition,
                  of: editionAttestation.claims.of,
                },
              }
            : {}),
        };
        const { PubkySpecsBuilder } = await import('pubky-app-specs');
        const provisional = new PubkySpecsBuilder(ownerPubky).createMarketplaceOrderReceipt(wireBody);
        const provisionalRecord = CommerceRecordNormalizer.orderReceiptRecord(provisional.order_receipt.toJson());
        const verifiedClaims = verifyOrderReceiptClaims({ ...provisionalRecord });
        if (
          verifiedClaims === null ||
          verifiedClaims.v !== claims.v ||
          (claims.v === 2 &&
            (verifiedClaims.v !== 2 ||
              JSON.stringify(verifiedClaims.merchandiseTotal) !== JSON.stringify(claims.merchandiseTotal) ||
              JSON.stringify(verifiedClaims.settlementTotal) !== JSON.stringify(claims.settlementTotal)))
        ) {
          throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Receipt attestation claims are not verified.', {
            service: ErrorService.Marketplace,
            operation: 'publishOrderReceipts',
          });
        }
        const verifiedBody = {
          schemaVersion: 1,
          recordType: 'order_receipt',
          ownerPubky,
          revision: 1,
          createdAt: verifiedClaims.paidAt,
          updatedAt: verifiedClaims.paidAt,
          role: verifiedClaims.buyer === ownerPubky ? 'buyer' : 'seller',
          receiptId: verifiedClaims.receipt,
          orderId: verifiedClaims.order,
          buyerPubky: verifiedClaims.buyer,
          sellerPubky: verifiedClaims.seller,
          total:
            verifiedClaims.v === 2
              ? verifiedClaims.merchandiseTotal
              : {
                  amountMinor: verifiedClaims.totalMinor,
                  currency: verifiedClaims.currency,
                  exponent: verifiedClaims.exponent,
                },
          ...(verifiedClaims.v === 2 ? { settlementTotal: verifiedClaims.settlementTotal } : {}),
          paidAt: verifiedClaims.paidAt,
          receiptAttestation: attestation.jws,
          ...(editionAttestation !== null
            ? {
                editionAttestation: editionAttestation.jws,
                drop: {
                  dropId: editionAttestation.claims.drop,
                  edition: editionAttestation.claims.edition,
                  of: editionAttestation.claims.of,
                },
              }
            : {}),
        };
        const built = new PubkySpecsBuilder(ownerPubky).createMarketplaceOrderReceipt(verifiedBody);
        const record = CommerceRecordNormalizer.orderReceiptRecord(built.order_receipt.toJson());
        if (verifiedClaims.v === 2) record.settlementTotal = verifiedClaims.settlementTotal;
        if (verifyOwnOrderReceipt({ ...record }) === null) {
          Logger.warn('Refusing to publish an order receipt whose attestation does not verify');
          continue;
        }
        if (record.editionAttestation !== undefined && verifyOwnDropEdition({ ...record }) === null) {
          Logger.warn('Refusing to publish an order receipt whose edition attestation does not verify');
          continue;
        }
        try {
          await CommercePrivStoreService.write(keyring, 'order_receipt', receiptId, { ...record });
        } catch (error) {
          if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
          throw error;
        }
        this.publishedReceiptUrls.add(url);
      } catch (error) {
        if (isPrivKeyringRevoked(error)) return 'unavailable';
        Logger.warn('Order receipt publication failed; it will retry on the next orders load', privErrorSummary(error));
      }
    }

    // A receipt that failed mid-flight (logged above), or a plaintext receipt
    // still waiting to move, retries on the next orders-surface load; report
    // that honestly instead of claiming done.
    const hasUnpublished = [...entryUrls.values()].some((url) => !this.publishedReceiptUrls.has(url));
    return hasUnpublished || migration === 'incomplete' ? 'unavailable' : 'published';
  }

  static async getWatchAlerts(ownerPubky: string): Promise<CommerceWatchAlertModelSchema[]> {
    return await LocalCommerceService.getWatchAlerts(ownerPubky);
  }

  static async getWatchSnapshots(ownerPubky: string): Promise<CommerceWatchSnapshotModelSchema[]> {
    return await LocalCommerceService.getWatchSnapshots(ownerPubky);
  }

  static async markWatchAlertsSeen(ownerPubky: string): Promise<void> {
    await LocalCommerceService.markWatchAlertsSeen(ownerPubky, Date.now());
  }

  static async getActivityReadCheckpoint(ownerPubky: string): Promise<number> {
    return await LocalCommerceService.getActivityReadCheckpoint(ownerPubky);
  }

  static async markActivityRead(ownerPubky: string): Promise<void> {
    await CommerceAttentionSeenApplication.markSeen(ownerPubky, 'activity');
  }

  static async markOrdersAttentionSeen(ownerPubky: string): Promise<void> {
    await CommerceAttentionSeenApplication.markSeen(ownerPubky, 'orders');
  }

  static async syncAttentionSeen(ownerPubky: string): Promise<void> {
    await CommerceAttentionSeenApplication.pull(ownerPubky);
  }

  /**
   * One bounded watchlist detection pass: re-observes the most recently
   * watched items and derives alerts from what actually changed against the
   * persisted per-item baselines (see `detectWatchAlerts` for the honesty
   * rules).
   *
   * Observation sources, per item:
   *
   * - Index: a per-listing Nexus read (`v0/listing/{seller}/{listing}`) —
   *   revision, price, state, auction deadline. Sandbox mode reads the
   *   locally seeded catalog instead (the sandbox never queries Nexus).
   *   Fresh Nexus rows are folded into the catalog cache, so the watchlist
   *   page renders the same freshness the detection observed.
   * - Projection: the transaction service's public listing projection —
   *   current bid, bid count, leader, sale state. Transactional modes only;
   *   a missing session or unreachable service yields no observation, never
   *   a fabricated one.
   *
   * An item where both reads failed is skipped entirely: no observation, no
   * claim, and the baseline stays where it was. The whole pass is bounded to
   * {@link COMMERCE_WATCH_CHECK_MAX_ITEMS} items and the caller enforces
   * spacing between passes — there is no background daemon.
   */
  static async runWatchlistDetection(ownerPubky: string): Promise<{ alertCount: number }> {
    const adapterMode = getCommerceAdapterMode();
    const favorites = await LocalCommerceService.getFavorites(ownerPubky);
    const watched = favorites.slice(-COMMERCE_WATCH_CHECK_MAX_ITEMS).reverse();
    if (watched.length === 0) return { alertCount: 0 };

    const baselines = new Map(
      (await LocalCommerceService.getWatchSnapshots(ownerPubky)).map((snapshot) => [snapshot.listing_id, snapshot]),
    );
    const now = Date.now();
    const freshEntries: CommerceCatalogEntryModelSchema[] = [];

    const observations = await Promise.all(
      watched.map(async (favorite): Promise<WatchObservation> => {
        const listingId = favorite.listing_id;
        const separator = listingId.indexOf(':');
        const sellerId = listingId.slice(0, separator);
        const id = listingId.slice(separator + 1);

        const [index, projection] = await Promise.all([
          this.observeWatchIndex(adapterMode, sellerId, id, listingId, freshEntries),
          this.observeWatchProjection(adapterMode, ownerPubky, sellerId, id),
        ]);
        return { ownerId: ownerPubky, listingId, sellerId, observedAt: now, index, projection };
      }),
    );

    const snapshots: CommerceWatchSnapshotModelSchema[] = [];
    const alerts: CommerceWatchAlertModelSchema[] = [];
    for (const observation of observations) {
      if (!observation.index && !observation.projection) continue;
      const result = detectWatchAlerts(baselines.get(observation.listingId) ?? null, observation, {
        endingSoonThresholdMs: COMMERCE_WATCH_ENDING_SOON_THRESHOLD_MS,
      });
      snapshots.push(result.snapshot);
      alerts.push(...result.alerts);
    }

    if (freshEntries.length > 0) {
      await LocalCommerceService.bulkUpsertCatalogEntries(freshEntries);
    }
    await LocalCommerceService.saveWatchDetection(ownerPubky, snapshots, alerts);
    return { alertCount: alerts.length };
  }

  private static async observeWatchIndex(
    adapterMode: ReturnType<typeof getCommerceAdapterMode>,
    sellerId: string,
    id: string,
    listingId: string,
    freshEntries: CommerceCatalogEntryModelSchema[],
  ): Promise<WatchIndexObservation | null> {
    if (adapterMode === 'sandbox') {
      // The sandbox catalog is seeded locally and never queries Nexus; its
      // local rows are the only index-shaped source that exists in this mode.
      const entry = await LocalCommerceService.getCatalogEntry(listingId);
      if (entry) {
        return {
          revision: entry.revision,
          state: entry.state,
          priceMinor: entry.price.amountMinor,
          currency: entry.price.currency,
          exponent: entry.price.exponent,
          auctionEndsAt: entry.auction?.endsAt ?? null,
          title: entry.title,
        };
      }
      const listing = await LocalCommerceService.getListing(listingId);
      if (!listing) return null;
      const record = listing.record;
      const price = record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice;
      return {
        revision: listing.revision,
        state: listing.state,
        priceMinor: price.amountMinor,
        currency: price.currency,
        exponent: price.exponent,
        auctionEndsAt: record.sale.format === 'auction' ? record.sale.endsAt : null,
        title: record.title,
      };
    }

    try {
      const entry = CommerceRecordNormalizer.nexusListingDetails(
        await NexusMarketplaceService.fetchListingDetails({ seller_id: sellerId, listing_id: id }),
      );
      freshEntries.push(entry);
      return {
        revision: entry.revision,
        state: entry.state,
        priceMinor: entry.price.amountMinor,
        currency: entry.price.currency,
        exponent: entry.price.exponent,
        auctionEndsAt: entry.auction?.endsAt ?? null,
        title: entry.title,
      };
    } catch (error) {
      if (!(isAppError(error) && isNotFound(error))) {
        Logger.warn('Failed to observe a watched listing on the Nexus index', { listing: listingId, error });
      }
      // 404 (never/no-longer indexed) and transport failures alike: nothing
      // was observed, so nothing may be claimed.
      return null;
    }
  }

  private static async observeWatchProjection(
    adapterMode: ReturnType<typeof getCommerceAdapterMode>,
    ownerPubky: string,
    sellerId: string,
    id: string,
  ): Promise<WatchProjectionObservation | null> {
    if (!isTransactionalCommerceMode(adapterMode)) return null;
    try {
      const projection = await MarketplaceGatewayService.getListing(
        ownerPubky,
        buildMarketplaceListingAggregateId(sellerId, id),
      );
      if (!projection) return null;
      return {
        serverRevision: projection.serverRevision,
        state: projection.state,
        auction: projection.auction
          ? {
              endsAt: projection.auction.endsAt,
              currentPriceMinor: projection.auction.currentPrice.amountMinor,
              currency: projection.auction.currentPrice.currency,
              exponent: projection.auction.currentPrice.exponent,
              bidCount: projection.auction.bidCount,
              leaderPubky: projection.auction.leaderPubky,
            }
          : null,
      };
    } catch {
      // No session yet, service unreachable, or listing unregistered — not an
      // error at watch level, and never a fabricated observation.
      return null;
    }
  }

  static async getSavedSearches(ownerPubky: string): Promise<CommerceSavedSearchModelSchema[]> {
    return await LocalCommerceService.getSavedSearches(ownerPubky);
  }

  /**
   * Saves the current catalog filter/search combination. The initial
   * watermark must be the newest `updated_at` among the search's CURRENT
   * matches (the caller just rendered them), so nothing that already existed
   * at save time can ever be counted as NEW.
   */
  static async commitCreateSavedSearch(
    ownerPubky: string,
    name: string,
    params: CommerceSavedSearchParams,
    initialWatermarkUpdatedAt: number,
  ): Promise<void> {
    const existing = await LocalCommerceService.getSavedSearches(ownerPubky);
    if (existing.length >= COMMERCE_SAVED_SEARCH_MAX_PER_OWNER) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        `You can keep up to ${COMMERCE_SAVED_SEARCH_MAX_PER_OWNER} saved searches.`,
        {
          service: ErrorService.Local,
          operation: 'commitCreateSavedSearch',
        },
      );
    }
    const now = Date.now();
    await LocalCommerceService.createSavedSearch({
      id: crypto.randomUUID(),
      owner_id: ownerPubky,
      name,
      params,
      watermark_updated_at: initialWatermarkUpdatedAt,
      latest_match_updated_at: initialWatermarkUpdatedAt,
      new_count: 0,
      last_checked_at: now,
      created_at: now,
    });
  }

  static async commitDeleteSavedSearch(ownerPubky: string, id: string): Promise<void> {
    await this.assertSavedSearchOwner(ownerPubky, id);
    await LocalCommerceService.deleteSavedSearch(id);
  }

  static async recordSavedSearchCheck(
    ownerPubky: string,
    id: string,
    result: { newCount: number; latestMatchUpdatedAt: number; checkedAt: number },
  ): Promise<void> {
    await this.assertSavedSearchOwner(ownerPubky, id);
    await LocalCommerceService.recordSavedSearchCheck(id, result);
  }

  static async acknowledgeSavedSearch(ownerPubky: string, id: string): Promise<void> {
    await this.assertSavedSearchOwner(ownerPubky, id);
    await LocalCommerceService.acknowledgeSavedSearch(id);
  }

  private static async assertSavedSearchOwner(ownerPubky: string, id: string): Promise<void> {
    const searches = await LocalCommerceService.getSavedSearches(ownerPubky);
    if (!searches.some((search) => search.id === id)) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Saved search does not belong to this account.', {
        service: ErrorService.Local,
        operation: 'assertSavedSearchOwner',
      });
    }
  }

  static async isShopFollowed(ownerPubky: string, sellerPubky: string): Promise<boolean> {
    return await LocalCommerceService.isShopFollowed(ownerPubky, sellerPubky);
  }

  static async getShopFollows(ownerPubky: string) {
    return await LocalCommerceService.getShopFollows(ownerPubky);
  }

  static async commitCreateShopFollow(ownerPubky: string, sellerPubky: string): Promise<void> {
    await LocalCommerceService.createShopFollow(ownerPubky, sellerPubky, Date.now());
  }

  static async commitDeleteShopFollow(ownerPubky: string, sellerPubky: string): Promise<void> {
    await LocalCommerceService.deleteShopFollow(ownerPubky, sellerPubky);
  }

  static async getAllCatalogEntries() {
    return await LocalCommerceService.getAllCatalogEntries();
  }

  static async getCatalogEntriesBySeller(sellerPubky: string) {
    return await LocalCommerceService.getCatalogEntriesBySeller(sellerPubky);
  }

  /**
   * Populates the local catalog cache from the Nexus marketplace index.
   *
   * The index now carries everything a catalog card renders (including
   * auction terms), so discovery validates the stream and stores the
   * normalized entries directly — one request, no per-listing homeserver
   * hydration. The canonical owner-signed record is fetched lazily, when a
   * listing is actually opened (`getOrFetchListing`), keeping the homeserver
   * canonical per ADR-0020. Shop profiles are the one card field the index
   * cannot supply, so sellers without a locally cached shop record are still
   * hydrated here (deduplicated, cache-first).
   *
   * Sandbox catalogs are seeded locally and stay self-contained: querying the
   * index there would blend real network listings into a demo catalog of
   * fictional sellers, so sandbox mode never reads from Nexus.
   *
   * Per-shop hydration failures are logged and skipped so one unreachable
   * seller cannot block the rest of the catalog (cards fall back to the
   * seller's pubky until the shop record is reachable).
   */
  static async fetchCatalogListings(filters: CommerceCatalogStreamFilters = {}): Promise<void> {
    if (getCommerceAdapterMode() === 'sandbox') return;

    const payload = await NexusMarketplaceService.fetchListingStream({
      state: 'active',
      limit: NEXUS_LISTINGS_PER_PAGE,
      ...(filters.saleFormat ? { sale_format: filters.saleFormat } : {}),
      ...(filters.condition ? { condition: filters.condition } : {}),
      ...(filters.endingSoonest ? { sorting: 'ends_at' as const, order: 'ascending' as const } : {}),
      ...(filters.country ? { country: filters.country } : {}),
    });
    const entries = CommerceRecordNormalizer.nexusListingStream(payload);
    await LocalCommerceService.bulkUpsertCatalogEntries(entries);
    await this.hydrateDiscoveredShops([...new Set(entries.map(({ seller_id }) => seller_id))]);
  }

  /**
   * Populates the local catalog cache with one seller's active listings from
   * the Nexus index — what a direct visit to a shop page needs when the
   * visitor never browsed the main catalog. Sandbox catalogs are seeded
   * locally, so (as with {@link fetchCatalogListings}) sandbox mode never
   * reads from Nexus.
   */
  static async fetchSellerCatalogListings(
    sellerPubky: string,
    options: { strictIdentity?: boolean; paginate?: boolean } = {},
  ): Promise<void> {
    if (getCommerceAdapterMode() === 'sandbox') return;

    const entries = await this.collectSellerCatalogEntries(sellerPubky, options);
    await LocalCommerceService.bulkUpsertCatalogEntries(entries);
  }

  private static async collectSellerCatalogEntries(
    sellerPubky: string,
    options: { strictIdentity?: boolean; paginate?: boolean } = {},
  ): Promise<ReturnType<typeof CommerceRecordNormalizer.nexusListingStream>[number][]> {
    const pages: NexusListingDetails[][] = [];
    const maxPages = options.paginate ? SELLER_REFRESH_MAX_PAGES : 1;
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await NexusMarketplaceService.fetchListingStream({
        seller_id: sellerPubky,
        state: 'active',
        limit: NEXUS_LISTINGS_PER_PAGE,
        ...(options.paginate && page > 0 ? { skip: page * NEXUS_LISTINGS_PER_PAGE } : {}),
      });
      if (!Array.isArray(payload)) {
        if (options.strictIdentity) throw this.invalidSellerCatalogIdentity();
        break;
      }
      this.validateSellerCatalogPage(payload, sellerPubky, options.strictIdentity);
      pages.push(payload);
      if (!options.paginate || payload.length < NEXUS_LISTINGS_PER_PAGE) break;
      if (page === maxPages - 1) {
        throw Err.validation(
          ValidationErrorCode.INVALID_INPUT,
          'Seller catalog refresh exceeded its bounded page limit.',
          {
            service: ErrorService.Nexus,
            operation: 'fetchSellerCatalogListings',
            context: { maxPages },
          },
        );
      }
    }

    const entriesById = new Map<string, ReturnType<typeof CommerceRecordNormalizer.nexusListingStream>[number]>();
    for (const entry of CommerceRecordNormalizer.nexusListingStream(pages.flat())) {
      const prior = entriesById.get(entry.id);
      if (!prior || entry.revision > prior.revision) entriesById.set(entry.id, entry);
    }
    return [...entriesById.values()];
  }

  private static validateSellerCatalogPage(
    payload: NexusListingDetails[],
    sellerPubky: string,
    strictIdentity = false,
  ): void {
    if (
      strictIdentity &&
      payload.some(
        (entry) =>
          !entry ||
          typeof entry !== 'object' ||
          entry.owner_id !== sellerPubky ||
          entry.uri !== `pubky://${sellerPubky}/pub/pubky.app/marketplace/v1/listings/${entry.id}`,
      )
    ) {
      throw this.invalidSellerCatalogIdentity();
    }
  }

  private static invalidSellerCatalogIdentity() {
    return Err.validation(ValidationErrorCode.INVALID_INPUT, 'Seller catalog contains an invalid listing identity.', {
      service: ErrorService.Nexus,
      operation: 'fetchSellerCatalogListings',
      context: { ownerMatches: false },
    });
  }

  /**
   * Refreshes the catalog cache with recent active listings from the sellers
   * a viewer follows, for the home-feed "From sellers you follow" shelf.
   *
   * Cost model — the Nexus listing stream accepts one `seller_id` per
   * request, so intersecting a follow graph with the index can never be one
   * query. This method bounds the cost instead of hiding it:
   *
   * 1. ONE shared global page of the newest active listings (the same read
   *    the catalog grid does) — it both refreshes the cache and cheaply
   *    discovers followed accounts that recently listed something.
   * 2. Per-seller refreshes ONLY for follows already known to sell (cached
   *    shop record or cached index entry), capped at
   *    {@link MARKETPLACE_FOLLOWED_SHELF_MAX_SELLER_FETCHES} — never a
   *    request per follow (see {@link selectFollowedSellersToRefresh}).
   *
   * Degradation: a failed global page falls back to refreshing cache-known
   * sellers; failed per-seller refreshes are logged and skipped
   * (`allSettled`) so one unreachable seller cannot empty the shelf; when
   * everything fails the shelf renders whatever the cache honestly holds.
   * Sandbox catalogs are seeded locally and never read from Nexus.
   */
  static async fetchFollowedSellerCatalogListings(followedPubkys: string[]): Promise<void> {
    if (getCommerceAdapterMode() === 'sandbox') return;
    if (followedPubkys.length === 0) return;

    try {
      const payload = await NexusMarketplaceService.fetchListingStream({
        state: 'active',
        limit: NEXUS_LISTINGS_PER_PAGE,
      });
      await LocalCommerceService.bulkUpsertCatalogEntries(CommerceRecordNormalizer.nexusListingStream(payload));
    } catch (error) {
      Logger.warn('Failed to refresh the global listing page for the followed-sellers shelf; using cache only', {
        error,
      });
    }

    const [entries, shops] = await Promise.all([
      LocalCommerceService.getAllCatalogEntries(),
      LocalCommerceService.getAllShops(),
    ]);
    const knownSellerIds = new Set([
      ...entries.map(({ seller_id }) => seller_id),
      ...shops.map(({ owner_id }) => owner_id),
    ]);
    const sellersToRefresh = selectFollowedSellersToRefresh(
      followedPubkys,
      knownSellerIds,
      MARKETPLACE_FOLLOWED_SHELF_MAX_SELLER_FETCHES,
    );
    if (sellersToRefresh.length === 0) return;

    const results = await Promise.allSettled(
      sellersToRefresh.map((sellerId) => this.fetchSellerCatalogListings(sellerId)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        Logger.warn('Failed to refresh a followed seller for the shelf; keeping their cached listings', {
          sellerId: sellersToRefresh[index],
          error: result.reason,
        });
      }
    });

    await this.hydrateDiscoveredShops(sellersToRefresh);
  }

  private static async hydrateDiscoveredShops(sellerIds: string[]): Promise<void> {
    const shopResults = await Promise.allSettled(sellerIds.map((sellerId) => this.getOrFetchShop(sellerId)));
    shopResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        Logger.warn('Failed to hydrate a discovered marketplace shop', {
          sellerId: sellerIds[index],
          error: result.reason,
        });
      }
    });
  }

  static async fetchListing(ownerPubky: string, listingId: string): Promise<CommerceListingRecord> {
    const url = CommerceRecordNormalizer.listingUri(ownerPubky, listingId);
    const record = CommerceRecordNormalizer.listing(await CommerceHomeserverService.fetchJson(url));
    if (record.ownerPubky !== ownerPubky || record.listingId !== listingId) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        'Canonical listing identity does not match the requested seller and listing.',
        {
          service: ErrorService.Marketplace,
          operation: 'fetchListing',
          context: {
            ownerMatches: record.ownerPubky === ownerPubky,
            listingMatches: record.listingId === listingId,
          },
        },
      );
    }
    return record;
  }

  /**
   * Returns the canonical listing record, fetching it from the owner
   * homeserver when it is not cached — or when the Nexus index has seen a
   * newer revision than the cache holds, so opening a listing always shows
   * the freshest record the network can supply. When a refresh fails but a
   * cached record exists, the cached record is returned (local-first
   * degradation, mirroring the catalog's behavior when Nexus is down).
   */
  static async getOrFetchListing(ownerPubky: string, listingId: string): Promise<CommerceListingRecord> {
    const compositeListingId = `${ownerPubky}:${listingId}`;
    const [local, indexed] = await Promise.all([
      LocalCommerceService.getListing(compositeListingId),
      LocalCommerceService.getCatalogEntry(compositeListingId),
    ]);
    if (local && (!indexed || local.revision >= indexed.revision)) return local.record;

    try {
      const record = await this.fetchListing(ownerPubky, listingId);
      if (indexed && record.revision < indexed.revision) {
        throw Err.validation(
          ValidationErrorCode.INVALID_INPUT,
          'Canonical listing revision is older than the Nexus discovery revision.',
          {
            service: ErrorService.Marketplace,
            operation: 'getOrFetchListing',
            context: { canonicalRevision: record.revision, indexedRevision: indexed.revision },
          },
        );
      }
      await LocalCommerceService.upsertListing(record, 'synced');
      return record;
    } catch (error) {
      if (isAppError(error) && error.code === ValidationErrorCode.INVALID_INPUT) throw error;
      if (!local) throw error;
      Logger.warn('Failed to refresh a stale marketplace listing; serving the cached record', {
        listing: compositeListingId,
        error,
      });
      return local.record;
    }
  }

  /**
   * Whether a failed {@link getOrFetchListing} proves the seller deleted the
   * listing. Deletion is confirmed only when the owner homeserver answered
   * 404 for the canonical record AND the Nexus index, asked once without
   * retry, also answers 404. Every other outcome (transport failure, 5xx,
   * a homeserver 404 while Nexus still lists the record, a Nexus failure)
   * is unknown and returns `false`, so callers keep their generic
   * "could not be loaded" copy. Never throws.
   */
  static async isListingConfirmedRemoved(ownerPubky: string, listingId: string, fetchError: unknown): Promise<boolean> {
    if (!isAppError(fetchError) || fetchError.service !== ErrorService.Homeserver || !isNotFound(fetchError)) {
      return false;
    }
    try {
      await NexusMarketplaceService.fetchListingDetailsOnce({ seller_id: ownerPubky, listing_id: listingId });
      return false;
    } catch (nexusError) {
      return isAppError(nexusError) && nexusError.service === ErrorService.Nexus && isNotFound(nexusError);
    }
  }

  /**
   * The seller's standing amount-band consent (ratified D2, ADR 0024).
   * `null` means the running backend has no attestation support at all
   * (sandbox) — callers render absence, never a fake false.
   */
  static async getMarketplaceBandConsent(actorPubky: string, sellerPubky: string): Promise<boolean | null> {
    return await MarketplaceGatewayService.getBandConsent(actorPubky, sellerPubky);
  }

  /**
   * Session-scoped 404 memo so a remount of the same order card does not
   * re-GET a homeserver miss. Keyed by actor + order. Cleared with the
   * marketplace session so a later sign-in can hydrate a record published
   * after this session's miss.
   */
  private static ownReviewHomeserverMisses = new Set<string>();

  /** Test support: clears the session-scoped own-review 404 memo. */
  static resetOwnReviewHydrateMemo(): void {
    this.ownReviewHomeserverMisses.clear();
  }

  private static ownReviewMissKey(actorPubky: string, orderId: string): string {
    return `${actorPubky}:${orderId}`;
  }

  /**
   * Live session pubky vs the identity captured when hydrate started.
   * Null (signed out) or a different account must not write `commerce_reviews`.
   */
  private static liveIdentityMatches(hydrateIdentity: string): boolean {
    return useAuthStore.getState().currentUserPubky === hydrateIdentity;
  }

  /**
   * The current user's own published review row for one order.
   * Local-first: a Dexie hit returns immediately. After a fresh sign-in the
   * local row is gone (wiped with identity) even when the homeserver record
   * is live — hydrate from the deterministic review URI (listing + subject
   * + role) so the order card can resolve publication/attestation state
   * instead of waiting forever.
   */
  static async getOwnMarketplaceReview(
    actorPubky: string,
    order: MarketplaceOrder,
  ): Promise<CommerceReviewModelSchema | null> {
    const local = (await LocalCommerceService.getOwnReviewByOrder(actorPubky, order.id)) ?? null;
    if (local !== null) return local;
    if (this.ownReviewHomeserverMisses.has(this.ownReviewMissKey(actorPubky, order.id))) return null;
    return await this.hydrateOwnReviewFromHomeserver(actorPubky, order);
  }

  /** `listing:<sellerPubky>_<listingId>` on the first order line, or null. */
  private static listingIdFromOrder(order: MarketplaceOrder): string | null {
    const listingPrefix = `listing:${order.sellerPubky}_`;
    const listingAggregateId = order.lines[0]?.listingAggregateId ?? '';
    if (!listingAggregateId.startsWith(listingPrefix)) return null;
    const listingId = listingAggregateId.slice(listingPrefix.length);
    return listingId.length > 0 ? listingId : null;
  }

  /**
   * Specs hash ID for the living review of this (listing, subject, role).
   * Dummy text/attestation are ignored by the hash — only listing URI,
   * subject, and role feed the id.
   */
  private static async ownReviewPathId(input: {
    actorPubky: string;
    listingOwnerPubky: string;
    listingId: string;
    subjectPubky: string;
    role: 'buyer_reviewing_seller' | 'seller_reviewing_buyer';
  }): Promise<string> {
    const { PubkySpecsBuilder } = await import('pubky-app-specs');
    const built = new PubkySpecsBuilder(input.actorPubky).createMarketplaceReview({
      schemaVersion: 1,
      recordType: 'review',
      ownerPubky: input.actorPubky,
      revision: 1,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
      reviewId: '',
      subjectPubky: input.subjectPubky,
      listingOwnerPubky: input.listingOwnerPubky,
      listingId: input.listingId,
      role: input.role,
      ratings: { overall: 1 },
      text: 'path-id-probe',
      eligibilityAttestation: 'A'.repeat(32),
    });
    return built.meta.id;
  }

  /**
   * Rebuilds the local own-review row from the reviewer's homeserver after
   * a cache miss. GET only — never PUT. A 404 or identity mismatch stays
   * unresolved (the order card's waiting copy), never a false published
   * or unpublished claim.
   */
  private static async hydrateOwnReviewFromHomeserver(
    actorPubky: string,
    order: MarketplaceOrder,
  ): Promise<CommerceReviewModelSchema | null> {
    const hydrateIdentity = actorPubky;
    if (!this.liveIdentityMatches(hydrateIdentity)) return null;
    const listingId = this.listingIdFromOrder(order);
    if (listingId === null) return null;
    const isBuyer = actorPubky === order.buyerPubky;
    const isSeller = actorPubky === order.sellerPubky;
    if (!isBuyer && !isSeller) return null;
    const role = isBuyer ? 'buyer_reviewing_seller' : 'seller_reviewing_buyer';
    const subjectPubky = isBuyer ? order.sellerPubky : order.buyerPubky;
    let reviewId = '';
    try {
      reviewId = await this.ownReviewPathId({
        actorPubky,
        listingOwnerPubky: order.sellerPubky,
        listingId,
        subjectPubky,
        role,
      });
      const url = CommerceRecordNormalizer.reviewUri(actorPubky, reviewId);
      const record = CommerceRecordNormalizer.review(await CommerceHomeserverService.fetchJson(url));
      if (
        record.ownerPubky !== actorPubky ||
        record.listingId !== listingId ||
        record.listingOwnerPubky !== order.sellerPubky ||
        record.role !== role ||
        record.subjectPubky !== subjectPubky ||
        record.reviewId !== reviewId
      ) {
        Logger.warn('Own review homeserver record identity did not match this order; leaving status unresolved', {
          orderId: order.id,
          reviewId,
        });
        return null;
      }
      const verifiedIss = verifyOwnReviewAttestation(record);
      const model: CommerceReviewModelSchema = {
        id: `${actorPubky}:${reviewId}`,
        owner_id: actorPubky,
        review_id: reviewId,
        order_id: order.id,
        subject_id: record.subjectPubky,
        record,
        attestation_verified: verifiedIss !== null,
        attestation_iss: verifiedIss,
        sync_status: 'synced',
        updated_at: Date.now(),
      };
      // Auth-cleanup may wipe `commerce_reviews` while this GET is in flight.
      // Do not re-seed another identity's private table; skip if the live
      // session pubky is no longer the one captured at hydrate start.
      if (!this.liveIdentityMatches(hydrateIdentity)) return null;
      await LocalCommerceService.upsertOwnReview(model);
      return model;
    } catch (error) {
      if (isAppError(error) && isNotFound(error)) {
        this.ownReviewHomeserverMisses.add(this.ownReviewMissKey(actorPubky, order.id));
      } else {
        Logger.warn('Own review homeserver hydrate failed; leaving publication status unresolved', {
          orderId: order.id,
          reviewId,
          error,
        });
      }
      return null;
    }
  }

  /**
   * Publishes the reviewer-owned public review record after a successful
   * `review.create`/`review.update` (trust & reputation plan P1.6): builds
   * the `PubkyAppMarketplaceReview` via the specs builder (deterministic
   * hash ID), embeds the service-issued purchase attestation verbatim in
   * `eligibilityAttestation`, and PUTs it to the reviewer's homeserver with
   * the staged-job outbox pattern listing publication established — a failed
   * PUT leaves a visible pending row that
   * {@link resumeOwnReviewPublications} retries.
   *
   * Returns `null` (publishing nothing) when the command result carries no
   * attestation: the record's `eligibilityAttestation` is required, so a
   * deployment without an attestor keeps reviews service-only — an honest
   * absence, not a failure.
   */
  static async commitPublishOwnReview(input: {
    actorPubky: string;
    order: MarketplaceOrder;
    result: Record<string, unknown>;
  }): Promise<CommerceReviewModelSchema | null> {
    const { actorPubky, order, result } = input;
    const attestation = extractReviewAttestation(result);
    if (attestation === null) return null;
    const review = reviewResultSchema.parse(result.review);

    const listingId = this.listingIdFromOrder(order);
    if (listingId === null) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Order lines carry no parseable listing identity.', {
        service: ErrorService.Marketplace,
        operation: 'commitPublishOwnReview',
        context: { orderId: order.id },
      });
    }
    const role = review.reviewerRole === 'buyer' ? 'buyer_reviewing_seller' : 'seller_reviewing_buyer';

    const build = async (revision: number, createdAt: string) => {
      const { PubkySpecsBuilder } = await import('pubky-app-specs');
      const built = new PubkySpecsBuilder(actorPubky).createMarketplaceReview({
        schemaVersion: 1,
        recordType: 'review',
        ownerPubky: actorPubky,
        revision,
        createdAt,
        updatedAt: review.updatedAt,
        reviewId: '',
        subjectPubky: review.subjectPubky,
        listingOwnerPubky: order.sellerPubky,
        listingId,
        role,
        ratings: { overall: review.rating },
        text: review.text,
        eligibilityAttestation: attestation.jws,
      });
      return {
        record: commerceReviewRecordSchema.parse(built.marketplace_review.toJson()),
        reviewId: built.meta.id,
      };
    };

    // The hash ID is deterministic per (listing, subject, role): a revision
    // of the living record — an edit, or a repeat purchase refreshing the
    // attestation — bumps `revision` and keeps the original `createdAt`.
    const probe = await build(1, review.createdAt);
    const prior = await LocalCommerceService.getOwnReviewById(`${actorPubky}:${probe.reviewId}`);
    const { record, reviewId } =
      prior === undefined ? probe : await build(prior.record.revision + 1, prior.record.createdAt);

    const verifiedIss = verifyOwnReviewAttestation(record);
    const model: CommerceReviewModelSchema = {
      id: `${actorPubky}:${reviewId}`,
      owner_id: actorPubky,
      review_id: reviewId,
      order_id: order.id,
      subject_id: record.subjectPubky,
      record,
      attestation_verified: verifiedIss !== null,
      attestation_iss: verifiedIss,
      sync_status: 'pending',
      updated_at: Date.now(),
    };
    const url = CommerceRecordNormalizer.reviewUri(actorPubky, reviewId);
    const job = this.createSyncJob({
      ownerId: actorPubky,
      entityType: 'review',
      entityId: reviewId,
      operation: 'publish',
      payload: { url },
      now: Date.now(),
    });

    await LocalCommerceService.stageOwnReviewSync(model, job);
    await CommerceHomeserverService.putJson(url, { ...record });
    const synced: CommerceReviewModelSchema = { ...model, sync_status: 'synced', updated_at: Date.now() };
    await LocalCommerceService.upsertOwnReview(synced);
    await LocalCommerceService.completeSyncJob(job.id);
    return synced;
  }

  /**
   * Retries every own-review record whose homeserver PUT never landed (the
   * visible retryable outbox): re-publishes the staged record verbatim and
   * marks it synced. Called when the orders surface loads, so a failed
   * publication heals on the next visit instead of rotting silently.
   */
  static async resumeOwnReviewPublications(actorPubky: string): Promise<number> {
    const pending = await LocalCommerceService.getPendingOwnReviews(actorPubky);
    let published = 0;
    for (const row of pending) {
      const url = CommerceRecordNormalizer.reviewUri(row.owner_id, row.review_id);
      try {
        await CommerceHomeserverService.putJson(url, { ...row.record });
        await LocalCommerceService.upsertOwnReview({ ...row, sync_status: 'synced', updated_at: Date.now() });
        published += 1;
      } catch (error) {
        Logger.warn('Own review publication retry failed; the row stays pending', {
          reviewId: row.review_id,
          error,
        });
      }
    }
    return published;
  }

  /**
   * The seller's public reputation overview for rating headers, with the
   * old-deployment ambiguity resolved honestly: the reputation endpoint
   * answers 404 both when the subject has no indexed reviews AND when the
   * Nexus deployment predates reputation indexing (unknown route). Claiming
   * "New seller" against an old index would be a fabrication, so a 404 is
   * only trusted as the New-seller state after the review-list endpoint
   * answers 200 (proving the deployment indexes reviews at all). Anything
   * else degrades to `unavailable`, which renders NO reputation surface —
   * absence, never a fake state.
   */
  static async fetchSellerReputationOverview(sellerPubky: string): Promise<CommerceSellerReputationOverview> {
    if (getCommerceAdapterMode() === 'sandbox') return { status: 'unavailable' };

    try {
      const payload = await NexusMarketplaceService.fetchShopReputation({ seller_id: sellerPubky });
      return { status: 'rated', summary: CommerceRecordNormalizer.nexusReputationSummary(payload) };
    } catch (error) {
      if (!(isAppError(error) && isNotFound(error))) {
        Logger.warn('Seller reputation fetch failed; rendering no reputation surface', { sellerPubky, error });
        return { status: 'unavailable' };
      }
    }

    try {
      await NexusMarketplaceService.fetchShopReviews({ seller_id: sellerPubky, limit: 1 });
      return { status: 'new_seller' };
    } catch (error) {
      Logger.warn('Review index probe failed; rendering no reputation surface', { sellerPubky, error });
      return { status: 'unavailable' };
    }
  }

  /**
   * A page of indexed reviews about a seller (with joined seller responses),
   * newest-indexed first. `unavailable` means the index does not serve
   * review routes (old deployment or unreachable) — callers render no
   * review section rather than an empty one.
   */
  static async fetchSellerReviews(
    sellerPubky: string,
    page: { skip?: number; limit?: number } = {},
  ): Promise<CommerceIndexedReviewsResult> {
    if (getCommerceAdapterMode() === 'sandbox') return { status: 'unavailable' };
    try {
      const payload = await NexusMarketplaceService.fetchShopReviews({ seller_id: sellerPubky, ...page });
      return { status: 'ok', reviews: CommerceRecordNormalizer.nexusReviewStream(payload) };
    } catch (error) {
      Logger.warn('Seller reviews fetch failed; rendering no review section', { sellerPubky, error });
      return { status: 'unavailable' };
    }
  }

  /** A page of indexed buyer reviews of one listing (with joined seller responses). */
  static async fetchListingReviews(
    sellerPubky: string,
    listingId: string,
    page: { skip?: number; limit?: number } = {},
  ): Promise<CommerceIndexedReviewsResult> {
    if (getCommerceAdapterMode() === 'sandbox') return { status: 'unavailable' };
    try {
      const payload = await NexusMarketplaceService.fetchListingReviews({
        seller_id: sellerPubky,
        listing_id: listingId,
        ...page,
      });
      return { status: 'ok', reviews: CommerceRecordNormalizer.nexusReviewStream(payload) };
    } catch (error) {
      Logger.warn('Listing reviews fetch failed; rendering no review section', { sellerPubky, listingId, error });
      return { status: 'unavailable' };
    }
  }

  /**
   * The current user's own published review rows (local-first: the user owns
   * these records, so the list renders from the local copies with their
   * publication + verification state — no index round-trip).
   */
  static async getOwnReviews(actorPubky: string): Promise<CommerceReviewModelSchema[]> {
    return await LocalCommerceService.getOwnReviews(actorPubky);
  }

  /** The current user's own response row for one review, or null. */
  static async getOwnReviewResponse(
    actorPubky: string,
    reviewId: string,
  ): Promise<CommerceReviewResponseModelSchema | null> {
    return (await LocalCommerceService.getOwnReviewResponse(actorPubky, reviewId)) ?? null;
  }

  /**
   * Publishes (or revises) the current user's response to a review they are
   * the subject of — a `PubkyAppReviewResponse` record on the user's OWN
   * homeserver (ratified D7: subject-only, one revisable response per
   * review; the path ID equals the review's ID). There is no service
   * command for responses: the record is the whole mechanism, and Nexus
   * indexes it with the structural `owner == subjectPubky` check. Publication
   * uses the same staged-job retryable outbox as reviews and listings.
   *
   * `priorRevision` carries the newest revision the caller has seen from the
   * index (a response written on another device); the new revision always
   * moves past both it and the local copy.
   */
  static async commitPublishReviewResponse(input: {
    actorPubky: string;
    review: CommerceIndexedReview;
    text: string;
    priorRevision?: number | null;
    priorCreatedAt?: string | null;
  }): Promise<CommerceReviewResponseModelSchema> {
    const { actorPubky, review, text } = input;
    if (review.subjectId !== actorPubky) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Only the review subject may respond to a review.', {
        service: ErrorService.Local,
        operation: 'commitPublishReviewResponse',
        context: { reviewId: review.reviewId },
      });
    }

    const prior = await LocalCommerceService.getOwnReviewResponse(actorPubky, review.reviewId);
    const baseRevision = Math.max(prior?.record.revision ?? 0, input.priorRevision ?? 0);
    const nowIso = new Date().toISOString();
    const createdAt = prior?.record.createdAt ?? input.priorCreatedAt ?? nowIso;

    const { PubkySpecsBuilder } = await import('pubky-app-specs');
    const built = new PubkySpecsBuilder(actorPubky).createReviewResponse({
      schemaVersion: 1,
      recordType: 'review_response',
      ownerPubky: actorPubky,
      revision: baseRevision + 1,
      createdAt,
      updatedAt: nowIso,
      reviewId: review.reviewId,
      reviewUri: CommerceRecordNormalizer.reviewUri(review.reviewerId, review.reviewId),
      text,
    });
    const record = CommerceRecordNormalizer.reviewResponse(built.review_response.toJson());

    const model: CommerceReviewResponseModelSchema = {
      id: `${actorPubky}:${review.reviewId}`,
      owner_id: actorPubky,
      review_id: review.reviewId,
      reviewer_id: review.reviewerId,
      record,
      sync_status: 'pending',
      updated_at: Date.now(),
    };
    const url = CommerceRecordNormalizer.reviewResponseUri(actorPubky, review.reviewId);
    const job = this.createSyncJob({
      ownerId: actorPubky,
      entityType: 'review_response',
      entityId: review.reviewId,
      operation: 'publish',
      payload: { url },
      now: Date.now(),
    });

    await LocalCommerceService.stageOwnReviewResponseSync(model, job);
    await CommerceHomeserverService.putJson(url, { ...record });
    const synced: CommerceReviewResponseModelSchema = { ...model, sync_status: 'synced', updated_at: Date.now() };
    await LocalCommerceService.upsertOwnReviewResponse(synced);
    await LocalCommerceService.completeSyncJob(job.id);
    return synced;
  }

  /**
   * Retries every own review-response record whose homeserver PUT never
   * landed — the same visible retryable outbox reviews use.
   */
  static async resumeOwnReviewResponsePublications(actorPubky: string): Promise<number> {
    const pending = await LocalCommerceService.getPendingOwnReviewResponses(actorPubky);
    let published = 0;
    for (const row of pending) {
      const url = CommerceRecordNormalizer.reviewResponseUri(row.owner_id, row.review_id);
      try {
        await CommerceHomeserverService.putJson(url, { ...row.record });
        await LocalCommerceService.upsertOwnReviewResponse({ ...row, sync_status: 'synced', updated_at: Date.now() });
        published += 1;
      } catch (error) {
        Logger.warn('Own review response publication retry failed; the row stays pending', {
          reviewId: row.review_id,
          error,
        });
      }
    }
    return published;
  }

  static async commitUpsertShop(record: CommerceShopRecord): Promise<void> {
    const now = Date.now();
    const url = CommerceRecordNormalizer.shopUri(record.ownerPubky);
    const job = this.createSyncJob({
      ownerId: record.ownerPubky,
      entityType: 'shop',
      entityId: record.ownerPubky,
      operation: 'publish',
      payload: { url },
      now,
    });

    await LocalCommerceService.stageShopSync(record, job);
    await CommerceHomeserverService.putJson(url, { ...record });
    await LocalCommerceService.upsertShop(record, 'synced');
    await LocalCommerceService.completeSyncJob(job.id);
  }

  static async commitUpsertListing(
    record: CommerceListingRecord,
    reservePrice?: CommerceMoney | null,
  ): Promise<{ registered: boolean; verified: boolean }> {
    if (isDurableCommerceMode(getCommerceAdapterMode()) && !this.hasActiveMarketplaceSession()) {
      throw Err.auth(AuthErrorCode.SESSION_EXPIRED, 'Connect a marketplace session to publish a listing.', {
        service: ErrorService.Marketplace,
        operation: 'commitUpsertListing',
      });
    }
    // Before anything is staged locally, so a refused listing leaves no sync job behind.
    assertPublishableListingStock(record, 'commitUpsertListing');
    const now = Date.now();
    const url = CommerceRecordNormalizer.listingUri(record.ownerPubky, record.listingId);
    const publishJob = this.createSyncJob({
      ownerId: record.ownerPubky,
      entityType: 'listing',
      entityId: record.listingId,
      operation: 'publish',
      payload: { url },
      now,
    });

    const mode = getCommerceAdapterMode();
    const attempt = this.beginListingRegistration(record.ownerPubky, record.listingId);
    const registering = mode !== 'unavailable' && this.canCoordinateListingRegistration();
    const registrationStatus = mode === 'unavailable' ? 'unavailable' : 'unregistered';
    this.assertListingRegistrationFence(attempt);
    attempt.observed = await LocalCommerceService.stageListingSync(record, publishJob, registrationStatus);
    if (registering && record.sale.format === 'auction' && isDurableCommerceMode(mode)) {
      // The command is chosen before the public write, so a reserve conflict leaves the homeserver untouched.
      await this.sweepOwnAuctionReserves(record.ownerPubky);
      await this.withListingRegistrationLock(attempt, 'publish', async () => {
        await this.assertRowHoldsPublish(attempt);
        attempt.signal = AbortSignal.timeout(LISTING_REGISTRATION_TIMEOUT_MS);
        const prepared = await this.prepareAuctionRegistration(record, attempt, reservePrice);
        if (prepared === 'superseded') throw this.listingChangedConflict();
      });
    }
    const verified = await this.putVerifiedPublicListing(record, url, attempt, async () => {
      await this.assertRowHoldsPublish(attempt);
    });
    this.assertListingRegistrationFence(attempt);
    const synced = await LocalCommerceService.markPublishedListingSynced(record, attempt.observed, !verified);
    if (synced === null) throw this.listingChangedConflict();
    attempt.observed = synced;

    // Registration is idempotent (skipped when the aggregate already has a server
    // revision), so retrying the whole commit after a failure here is safe.
    // Every transactional mode needs it: without registration the service has
    // no aggregate for the listing, so checkout/offers/bids dead-end. (This
    // was sandbox-only once — a relic that left durable-mode listings
    // unregistered and therefore un-buyable.)
    //
    // A registration failure must NOT unwind the publish that already
    // happened: the record is on the homeserver, and reporting the whole
    // commit as failed made sellers retry into duplicate listings. The
    // truths (published / verified / registered) are returned separately; an
    // unregistered listing self-heals through ensureListingRegistered /
    // listing.sync once a marketplace session exists.
    if (mode === 'unavailable') {
      await LocalCommerceService.completeSyncJob(publishJob.id);
      return { registered: false, verified };
    }
    // Without Web Locks nothing registers; the listing stays `unregistered`.
    if (!registering) return { registered: false, verified };
    // The homeserver acked the write but is not serving it yet, so the publish
    // job is done. The row carries `read_back_pending_since`: within the
    // window no 404 settles it, and it stays `unregistered` for
    // ensureListingRegistered to heal.
    if (!verified) {
      await LocalCommerceService.completeSyncJob(publishJob.id);
      return { registered: false, verified };
    }
    return {
      registered: await this.runListingRegistration(record, attempt, 'publish', publishJob.id),
      verified,
    };
  }

  /**
   * Self-heal for listings published while registration failed or was skipped
   * (e.g. records created before durable-mode registration existed): registers
   * the listing when the service has no aggregate for it. Idempotent; callers
   * invoke it from owner-facing surfaces where a session is available. Gives
   * up without a request when another attempt holds the listing's lock or the
   * browser has no Web Locks.
   */
  static async ensureListingRegistered(record: CommerceListingRecord): Promise<boolean> {
    if (getCommerceAdapterMode() === 'unavailable' || !this.canCoordinateListingRegistration()) return false;
    const attempt = this.beginListingRegistration(record.ownerPubky, record.listingId);
    attempt.observed = await LocalCommerceService.getListingRowGeneration(attempt.compositeListingId);
    return await this.runListingRegistration(record, attempt, 'heal', null);
  }

  /** Whether this browser can register listings: registration needs Web Locks to have one owner per listing. */
  static canCoordinateListingRegistration(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
  }

  private static beginListingRegistration(ownerPubky: string, listingId: string): ListingRegistrationAttempt {
    return {
      compositeListingId: `${ownerPubky}:${listingId}`,
      aggregateId: buildMarketplaceListingAggregateId(ownerPubky, listingId),
      ...this.listingSessionBinding(),
      observed: null,
    };
  }

  private static listingSessionBinding(): Pick<ListingRegistrationAttempt, 'authEpoch' | 'pubky' | 'sessionToken'> {
    return {
      authEpoch: readAuthEpoch(),
      pubky: useAuthStore.getState().currentUserPubky,
      sessionToken: MarketplaceSessionService.getActiveSession()?.token ?? null,
    };
  }

  private static listingRegistrationFenceHolds(attempt: ListingRegistrationAttempt): boolean {
    const now = this.listingSessionBinding();
    return (
      now.authEpoch === attempt.authEpoch && now.pubky === attempt.pubky && now.sessionToken === attempt.sessionToken
    );
  }

  private static listingChangedConflict() {
    return Err.client(ClientErrorCode.CONFLICT, 'The listing changed. Reload and try again.', {
      service: ErrorService.Marketplace,
      operation: 'commitUpsertListing',
    });
  }

  /**
   * A publish acts only while the local row is still exactly its own
   * generation: the `write_id` captured atomically at staging, advanced only
   * by the publish's own writes. A delete, or another tab's publish, even of
   * the same revision, since then wins.
   */
  private static async assertRowHoldsPublish(attempt: ListingRegistrationAttempt): Promise<void> {
    const stillOwn = await this.listingRowStillObserved(attempt);
    this.assertListingRegistrationFence(attempt);
    if (!stillOwn) throw this.listingChangedConflict();
  }

  /**
   * Runs one homeserver write of a listing as the listing's lock holder, so
   * it never overlaps that listing's registration, publish or delete. The
   * body makes a single attempt; callers back off outside the lock. Without
   * Web Locks nothing registers in this browser, and the write runs
   * unlocked.
   */
  private static async withListingWriteLock(
    attempt: ListingRegistrationAttempt,
    body: () => Promise<void>,
  ): Promise<void> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    this.assertListingRegistrationFence(attempt);
    const run = async () => {
      this.assertListingRegistrationFence(attempt);
      await body();
    };
    if (typeof locks?.request !== 'function') {
      await run();
      return;
    }
    await locks.request(`${LISTING_REGISTRATION_LOCK_PREFIX}${attempt.aggregateId}`, run);
  }

  /** Checked after every await and before every request or write of an attempt. */
  private static assertListingRegistrationFence(attempt: ListingRegistrationAttempt): void {
    if (this.listingRegistrationFenceHolds(attempt)) return;
    throw Err.auth(AuthErrorCode.SESSION_EXPIRED, 'Signed out during listing registration.', {
      service: ErrorService.Marketplace,
      operation: 'registerListing',
      context: { reason: 'auth_epoch_changed' },
    });
  }

  /**
   * Runs `body` as the listing's single registration owner. `publish` waits
   * for the lock; `heal` returns null at once when another attempt holds it.
   * Also null without Web Locks. The body requests no other lock.
   */
  private static async withListingRegistrationLock<T>(
    attempt: ListingRegistrationAttempt,
    owner: ListingRegistrationOwner,
    body: () => Promise<T>,
  ): Promise<T | null> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (typeof locks?.request !== 'function') return null;
    this.assertListingRegistrationFence(attempt);
    const name = `${LISTING_REGISTRATION_LOCK_PREFIX}${attempt.aggregateId}`;
    const run = async (): Promise<T> => {
      this.assertListingRegistrationFence(attempt);
      try {
        return await body();
      } finally {
        attempt.signal = undefined;
      }
    };
    if (owner === 'publish') return await locks.request(name, run);
    return await locks.request(name, { ifAvailable: true }, async (lock) => (lock ? await run() : null));
  }

  /**
   * One registration attempt. Outside the lock: the stock rule and the
   * homeserver precheck (a single read, or the read-back retry schedule for a
   * row whose acked write was never read back). Under the lock: the fence, the row
   * generation check, the service reads that shape the command, one timed
   * command request, and the compare-and-write settle. Nothing waits or
   * retries under the lock; a failed attempt stays pending for the next one.
   */
  private static async runListingRegistration(
    record: CommerceListingRecord,
    attempt: ListingRegistrationAttempt,
    owner: ListingRegistrationOwner,
    publishJobId: string | null,
  ): Promise<boolean> {
    const settle = async (outcome: Parameters<typeof LocalCommerceService.settleListingRegistration>[2]) => {
      this.assertListingRegistrationFence(attempt);
      await LocalCommerceService.settleListingRegistration(attempt.compositeListingId, attempt.observed, outcome);
    };
    const takeRow = async (): Promise<boolean> => {
      // Both owners act only on the exact generation they hold: for a publish, the row it staged and
      // marked synced. A delete or another tab's publish since then leaves nothing to register.
      const stillObserved = await this.listingRowStillObserved(attempt);
      this.assertListingRegistrationFence(attempt);
      return stillObserved;
    };
    try {
      assertPublishableListingStock(record, 'registerListing');
      if (isDurableCommerceMode(getCommerceAdapterMode())) {
        this.assertListingRegistrationFence(attempt);
        const published = await this.precheckPublishedListingRecord(record, attempt);
        this.assertListingRegistrationFence(attempt);
        if (!published) {
          await this.withListingRegistrationLock(attempt, owner, async () => {
            if (await takeRow()) await this.settleUnregistrableListing(attempt, 'record_deleted');
          });
          return false;
        }
      }
      const registered = await this.withListingRegistrationLock(attempt, owner, async () => {
        if (!(await takeRow())) return false;
        attempt.signal = AbortSignal.timeout(LISTING_REGISTRATION_TIMEOUT_MS);
        try {
          const outcome = await this.registerListing(record, attempt);
          this.assertListingRegistrationFence(attempt);
          if (outcome === 'superseded') return false;
          if (outcome !== 'registered') {
            await this.settleUnregistrableListing(attempt, outcome);
            return false;
          }
          await settle({ status: 'registered' });
          if (publishJobId) {
            this.assertListingRegistrationFence(attempt);
            await LocalCommerceService.completeSyncJob(publishJobId);
          }
          return true;
        } catch (error) {
          if (!this.listingRegistrationFenceHolds(attempt)) return false;
          await settle({ status: 'unregistered' });
          Logger.warn('Listing registration failed; it stays pending for the next attempt', { error });
          return false;
        }
      });
      return registered ?? false;
    } catch (error) {
      if (!this.listingRegistrationFenceHolds(attempt)) return false;
      // Best effort: a refused lock or a sign-out here leaves the row as it is, which is already pending.
      await this.withListingRegistrationLock(attempt, 'heal', async () => {
        if (await this.listingRowStillObserved(attempt)) await settle({ status: 'unregistered' });
      }).catch(() => null);
      Logger.warn('Listing registration failed before it reached the service; it stays pending', { error });
      return false;
    }
  }

  private static async listingRowStillObserved(attempt: ListingRegistrationAttempt): Promise<boolean> {
    const { generation } = await LocalCommerceService.getListingRegistrationState(attempt.compositeListingId);
    return generation !== null && attempt.observed !== null && generation.writeId === attempt.observed.writeId;
  }

  /**
   * Ends the pending registration of a listing the service cannot accept,
   * if the row is still the attempt's generation. A deleted record removes a
   * synced cache so no owner surface offers it again; a row with pending
   * publication state, or a `NOT_FOUND` refusal, is kept and taken out of
   * pending. The same compare-and-write clears the persisted auction command.
   */
  private static async settleUnregistrableListing(
    attempt: ListingRegistrationAttempt,
    outcome: 'record_deleted' | 'service_not_found',
  ): Promise<void> {
    if (outcome === 'service_not_found') {
      Logger.warn('Listing registration stopped: the service found no homeserver record');
    }
    this.assertListingRegistrationFence(attempt);
    await LocalCommerceService.settleListingRegistration(
      attempt.compositeListingId,
      attempt.observed,
      outcome === 'record_deleted' ? { recordDeleted: true } : { status: 'not_found' },
    );
  }

  /**
   * The registration precheck. A row still within its read-back window was
   * acked but never served back, so its 404 is retried on the read-back schedule; one
   * that outlasts it still answers false, and the settle keeps that row
   * pending rather than `not_found`.
   */
  private static async precheckPublishedListingRecord(
    record: CommerceListingRecord,
    attempt: ListingRegistrationAttempt,
  ): Promise<boolean> {
    const { readBackPending } = await LocalCommerceService.getListingRegistrationState(attempt.compositeListingId);
    for (let retry = 0; ; retry += 1) {
      if (await this.hasPublishedListingRecord(record)) return true;
      if (!readBackPending) return false;
      if (retry >= LISTING_READ_BACK_RETRY_DELAYS_MS.length) {
        Logger.warn('Listing record is still not served back after an acked write; registration stays pending', {
          listing: attempt.compositeListingId,
        });
        return false;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, LISTING_READ_BACK_RETRY_DELAYS_MS[retry]);
      });
      this.assertListingRegistrationFence(attempt);
    }
  }

  /**
   * Whether the seller's homeserver still holds the listing record. Only a
   * 404 answers false; any other failure throws, so the caller stays pending.
   */
  private static async hasPublishedListingRecord(listing: CommerceListingRecord): Promise<boolean> {
    try {
      await this.fetchListing(listing.ownerPubky, listing.listingId);
      return true;
    } catch (error) {
      if (isAppError(error) && isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Buyer-side heal (`listing.sync`, durable modes only): asks the
   * transaction service to fetch the canonical seller-signed record from the
   * seller's homeserver itself and register (or refresh) the aggregate from
   * it. Unlike {@link ensureListingRegistered}, the actor need NOT be the
   * seller — provenance comes from the service's homeserver fetch, not from
   * the session — so any signed-in user can heal a listing published before
   * durable-mode registration existed. Convergent: `expectedRevision` is
   * always 0 and a pre-existing aggregate is a no-op success.
   */
  // ---------------------------------------------------------------------
  // Drops (ADR 0026)
  // ---------------------------------------------------------------------

  /** Fetches the canonical seller-signed drop record from the homeserver. */
  static async fetchDrop(ownerPubky: string, dropId: string): Promise<CommerceDropRecord> {
    const url = CommerceRecordNormalizer.dropUri(ownerPubky, dropId);
    return CommerceRecordNormalizer.drop(await CommerceHomeserverService.fetchJson(url));
  }

  /**
   * Enumerates the drop ids published on an owner's homeserver by listing
   * the drops directory — the authoritative enumeration (works across
   * devices, unlike any local publish memo). Ids only; callers hydrate each
   * record/projection themselves and render read failures per row.
   */
  static async listOwnDropIds(ownerPubky: string): Promise<string[]> {
    const baseDirectory = `pubky://${ownerPubky}/pub/pubky.app/marketplace/v1/drops/`;
    const urls = await HomeserverService.listAll({ baseDirectory });
    return urls.map((url) => url.slice(baseDirectory.length)).filter((id) => id.length > 0 && !id.includes('/'));
  }

  /**
   * The transaction service's authoritative drop state (public projection,
   * stock redaction server-side, `serverTime` for countdown correction).
   * Null when unregistered or in sandbox mode — callers render absence.
   */
  static async getPublicDrop(sellerPubky: string, dropId: string) {
    return await MarketplaceGatewayService.getPublicDrop(sellerPubky, dropId);
  }

  static async getSellerDrop(actorPubky: string, sellerPubky: string, dropId: string) {
    return await MarketplaceGatewayService.getDrop(actorPubky, buildMarketplaceDropAggregateId(sellerPubky, dropId));
  }

  static async getDropReadyCheck(actorPubky: string, sellerPubky: string, dropId: string) {
    return await MarketplaceGatewayService.getDropReadyCheck(
      actorPubky,
      buildMarketplaceDropAggregateId(sellerPubky, dropId),
    );
  }

  /**
   * Publishes the seller-signed drop record to the seller's own homeserver.
   * The record is validated through the vendored specs builder before the
   * PUT (the same guarantee every published marketplace record gets); the
   * caller follows up with {@link syncDropRegistration} so the transaction
   * service registers the enforced schedule — the studio renders the two
   * truths (record published / service registered) separately.
   */
  static async commitPublishDrop(record: CommerceDropRecord): Promise<void> {
    const { PubkySpecsBuilder } = await import('pubky-app-specs');
    const built = new PubkySpecsBuilder(record.ownerPubky).createMarketplaceDrop({ ...record });
    const validated = CommerceRecordNormalizer.drop(built.marketplace_drop.toJson());
    const url = CommerceRecordNormalizer.dropUri(validated.ownerPubky, validated.dropId);
    await CommerceHomeserverService.putJson(url, { ...validated });
  }

  /**
   * Convergent drop registration from the seller-signed homeserver record —
   * `listing.sync`'s doctrine applied to drops. Any authenticated actor.
   */
  static async syncDropRegistration(
    actorPubky: string,
    sellerPubky: string,
    dropId: string,
  ): Promise<MarketplaceCommandResponse> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Drops require the durable transaction service.', {
        service: ErrorService.Marketplace,
        operation: 'syncDropRegistration',
      });
    }
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceDropAggregateId(sellerPubky, dropId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'drop.sync',
      payload: { sellerPubky, dropId },
    });
    return await MarketplaceGatewayService.execute(actorPubky, command);
  }

  /**
   * Seller-only drop lifecycle commands, both CAS-guarded with the freshly
   * read revision: `drop.cancel` (kill switch, announced/live) and
   * `drop.release_listings` (return an ENDED drop's listings to open sale).
   */
  static async cancelDrop(
    actorPubky: string,
    dropId: string,
    expectedRevision: number,
  ): Promise<MarketplaceCommandResponse> {
    return await this.executeDropLifecycleCommand(actorPubky, dropId, expectedRevision, 'drop.cancel');
  }

  static async releaseDropListings(
    actorPubky: string,
    dropId: string,
    expectedRevision: number,
  ): Promise<MarketplaceCommandResponse> {
    return await this.executeDropLifecycleCommand(actorPubky, dropId, expectedRevision, 'drop.release_listings');
  }

  private static async executeDropLifecycleCommand(
    actorPubky: string,
    dropId: string,
    expectedRevision: number,
    kind: 'drop.cancel' | 'drop.release_listings',
  ): Promise<MarketplaceCommandResponse> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Drops require the durable transaction service.', {
        service: ErrorService.Marketplace,
        operation: kind,
      });
    }
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceDropAggregateId(actorPubky, dropId),
      expectedRevision,
      issuedAt: new Date().toISOString(),
      kind,
      payload: {},
    });
    return await MarketplaceGatewayService.execute(actorPubky, command);
  }

  static async syncListingRegistration(
    actorPubky: string,
    sellerPubky: string,
    listingId: string,
  ): Promise<MarketplaceCommandResponse> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Listing sync requires the durable transaction service.', {
        service: ErrorService.Marketplace,
        operation: 'syncListingRegistration',
      });
    }
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceListingAggregateId(sellerPubky, listingId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'listing.sync',
      payload: { sellerPubky, listingId },
    });
    return await MarketplaceGatewayService.execute(actorPubky, command);
  }

  /**
   * Deletes a listing the current user owns: removes the owner-signed record
   * from the homeserver (the canonical copy indexers read), then clears every
   * local cache of it. Media files are deleted afterwards as best-effort
   * cleanup — a media file that outlives its record is unreferenced bytes,
   * not a live listing, so media failures never block the deletion.
   */
  static async commitDeleteListing(ownerPubky: string, listingId: string): Promise<void> {
    const compositeListingId = `${ownerPubky}:${listingId}`;
    const local = await LocalCommerceService.getListing(compositeListingId);
    const url = CommerceRecordNormalizer.listingUri(ownerPubky, listingId);
    const job = this.createSyncJob({
      ownerId: ownerPubky,
      entityType: 'listing',
      entityId: listingId,
      operation: 'remove',
      payload: { url },
      now: Date.now(),
    });

    const attempt = this.beginListingRegistration(ownerPubky, listingId);
    this.assertListingRegistrationFence(attempt);
    await LocalCommerceService.upsertSyncJob(job);
    // One DELETE per hold of the listing lock, the local rows removed in the same hold, so a queued
    // registration or publish finds no row; a retryable failure backs off outside the lock.
    await retryHomeserverWrite(HttpMethod.DELETE, () =>
      this.withListingWriteLock(attempt, async () => {
        await CommerceHomeserverService.delete(url, undefined, { singleAttempt: true });
        this.assertListingRegistrationFence(attempt);
        await LocalCommerceService.deleteListing(compositeListingId);
      }),
    );
    this.assertListingRegistrationFence(attempt);
    await LocalCommerceService.completeSyncJob(job.id);

    if (local) {
      const mediaResults = await Promise.allSettled(
        local.record.media.map((media) => CommerceHomeserverService.delete(media.url)),
      );
      mediaResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          Logger.warn('Failed to delete an orphaned listing media file', {
            mediaUrl: local.record.media[index].url,
            error: result.reason,
          });
        }
      });
    }
  }

  static async commitCreateMedia(ownerPubky: string, mediaId: string, bytes: Uint8Array): Promise<string> {
    const url = CommerceRecordNormalizer.mediaUri(ownerPubky, mediaId);
    await CommerceHomeserverService.putMedia(url, bytes);
    return url;
  }

  /** GET→merge→PUT for Inventory Studio import. Does not go through commitUpsertListing. */
  static async putPublicListingForImport(record: CommerceListingRecord): Promise<void> {
    const url = CommerceRecordNormalizer.listingUri(record.ownerPubky, record.listingId);
    await this.putVerifiedPublicListing(
      record,
      url,
      this.beginListingRegistration(record.ownerPubky, record.listingId),
    );
  }

  static async getMarketplaceMediaOwnerHomeserver(ownerPubky: string): Promise<string | null> {
    return await MarketplaceMediaService.getOwnerHomeserver(ownerPubky);
  }

  static async fetchMarketplaceMedia(uri: string): Promise<Blob> {
    return await MarketplaceMediaService.fetchMedia(uri);
  }

  /**
   * The only write of a public listing record: every Shop publisher, Inventory
   * Studio included, reaches it.
   *
   * The PUT runs as the listing's lock holder, one attempt per hold, after
   * `guard` (the publish's row check) passes under the same hold; a
   * retryable failure backs off outside the lock. Reads before and after
   * stay outside it.
   *
   * Returns true when the homeserver served the written record back and it
   * matched the candidate. Returns false when the write was acked but the
   * homeserver has not made the record readable yet — reads lag just-acked
   * writes (production 2026-09-30: a publish read back 410ms after the record
   * was created still got a 404, and the same record served fine about a
   * second later). A lag is reported as `false`, never thrown: a published
   * listing must not read as a failed publish, or the seller re-posts it as a
   * duplicate. Proven divergence — the homeserver serving something other than
   * what was written — still throws.
   */
  private static async putVerifiedPublicListing(
    record: CommerceListingRecord,
    url: string,
    attempt: ListingRegistrationAttempt,
    guard?: () => Promise<void>,
  ): Promise<boolean> {
    assertPublishableListingStock(record, 'putVerifiedPublicListing');
    let current: Record<string, unknown> = {};
    let exists = false;
    try {
      const fetched = await CommerceHomeserverService.fetchJson(url);
      if (!isPlainRecord(fetched)) {
        throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'The published listing is not a JSON object.', {
          service: ErrorService.Homeserver,
          operation: 'putVerifiedPublicListing',
        });
      }
      current = fetched;
      exists = true;
    } catch (error) {
      if (!(isAppError(error) && isNotFound(error) && record.revision === 1)) throw error;
    }

    const scrubbed = stripForbiddenPublicReserveKeys(current);
    const candidate = mergeOpenWorldRecords(isPlainRecord(scrubbed) ? scrubbed : {}, record);
    assertReserveFreePublicRecord(candidate);
    if (exists) {
      if (current.ownerPubky !== record.ownerPubky || current.listingId !== record.listingId) {
        throw Err.client(ClientErrorCode.CONFLICT, 'The published listing identity changed. Reload and try again.', {
          service: ErrorService.Homeserver,
          operation: 'putVerifiedPublicListing',
        });
      }
      const currentRevision = current.revision;
      const expectedBaseRevision = record.revision - 1;
      if (currentRevision === record.revision) {
        if (canonicalJson(scrubbed) !== canonicalJson(candidate)) {
          throw Err.client(ClientErrorCode.CONFLICT, 'The published listing changed. Reload and try again.', {
            service: ErrorService.Homeserver,
            operation: 'putVerifiedPublicListing',
          });
        }
      } else if (currentRevision !== expectedBaseRevision) {
        throw Err.client(ClientErrorCode.CONFLICT, 'The published listing changed. Reload and try again.', {
          service: ErrorService.Homeserver,
          operation: 'putVerifiedPublicListing',
        });
      }
    }

    const requiresPut =
      !exists || current.revision !== record.revision || findForbiddenPublicReserveKey(current) !== null;
    if (requiresPut) {
      if (exists) {
        const latest = await CommerceHomeserverService.fetchJson(url);
        if (canonicalJson(latest) !== canonicalJson(current)) {
          throw Err.client(ClientErrorCode.CONFLICT, 'The published listing changed. Reload and try again.', {
            service: ErrorService.Homeserver,
            operation: 'putVerifiedPublicListing',
          });
        }
      } else {
        try {
          await CommerceHomeserverService.fetchJson(url);
          throw Err.client(ClientErrorCode.CONFLICT, 'The published listing changed. Reload and try again.', {
            service: ErrorService.Homeserver,
            operation: 'putVerifiedPublicListing',
          });
        } catch (error) {
          if (!(isAppError(error) && isNotFound(error))) throw error;
        }
      }
      await retryHomeserverWrite(HttpMethod.PUT, () =>
        this.withListingWriteLock(attempt, async () => {
          await guard?.();
          await CommerceHomeserverService.putJson(url, candidate, { singleAttempt: true });
        }),
      );
    }

    let verified: unknown;
    if (requiresPut) {
      const readBack = await this.readBackAckedWrite(url, record);
      if (readBack === undefined) {
        Logger.warn('Listing write was acked but the homeserver has not served the record back yet', {
          listing: `${record.ownerPubky}:${record.listingId}`,
        });
        return false;
      }
      verified = readBack.record;
    } else {
      verified = current;
    }
    assertReserveFreePublicRecord(verified);
    if (
      !isPlainRecord(verified) ||
      verified.ownerPubky !== record.ownerPubky ||
      verified.listingId !== record.listingId ||
      verified.revision !== record.revision
    ) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'The published listing could not be verified.', {
        service: ErrorService.Homeserver,
        operation: 'putVerifiedPublicListing',
      });
    }
    if (canonicalJson(verified) !== canonicalJson(candidate)) {
      throw Err.server(
        ServerErrorCode.INVALID_RESPONSE,
        'The published listing did not match the verified candidate.',
        {
          service: ErrorService.Homeserver,
          operation: 'putVerifiedPublicListing',
        },
      );
    }
    return true;
  }

  /**
   * Reads back an acked listing write until the homeserver serves the written
   * revision, or reports that it cannot confirm the write.
   *
   * Reads can lag a just-acked write by a moment, so the two lag signatures —
   * the record is not readable yet, or the previous revision is still being
   * served — are retried (250ms, 500ms, 1s) before they are believed.
   * Returning `undefined` means "acked but unconfirmed": a truth to report,
   * not a failure to raise. Everything else — a readable record at the written
   * revision, a concurrent writer's newer revision, an auth or transport
   * error — is returned or thrown for the caller's normal checks.
   */
  private static async readBackAckedWrite(
    url: string,
    record: CommerceListingRecord,
  ): Promise<{ record: unknown } | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const fetched = await CommerceHomeserverService.fetchJson(url);
        const staleLag = isPlainRecord(fetched) && fetched.revision === record.revision - 1;
        if (!staleLag || attempt >= LISTING_READ_BACK_RETRY_DELAYS_MS.length)
          return staleLag ? undefined : { record: fetched };
      } catch (error) {
        const missing = isAppError(error) && isNotFound(error);
        if (!missing || attempt >= LISTING_READ_BACK_RETRY_DELAYS_MS.length) {
          if (missing) return undefined;
          throw error;
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, LISTING_READ_BACK_RETRY_DELAYS_MS[attempt]);
      });
    }
  }

  /**
   * Deletes the signed-in seller's own leftover `auction_reserves/` files.
   * Listing is enough to find them; the file body is not read. A list or
   * delete failure does not throw.
   */
  static async sweepOwnAuctionReserves(ownerPubky: string): Promise<number> {
    if (useAuthStore.getState().currentUserPubky !== ownerPubky) return 0;
    if (!HomeserverService.canCurrentSessionWrite(PRIVATE_APP_DATA_PATH)) return 0;
    const directory = CommerceRecordNormalizer.auctionReserveDirectoryUri(ownerPubky);
    let entries: string[] = [];
    try {
      entries = await HomeserverService.listAll({ baseDirectory: directory });
    } catch (error) {
      Logger.warn('Auction reserve sweep could not list the owner directory', { error });
      return 0;
    }
    let deleted = 0;
    for (const entry of entries) {
      const url = ownAuctionReserveFileUrl(directory, entry);
      if (!url) continue;
      try {
        await CommerceHomeserverService.delete(url);
        deleted += 1;
      } catch (error) {
        if (isAppError(error) && isNotFound(error)) continue;
        Logger.warn('Auction reserve sweep could not delete an owner file', { error });
      }
    }
    return deleted;
  }

  /**
   * Chooses the auction's `listing.register` command under the listing's
   * lock: the command persisted on the row is replayed while it still
   * matches this revision and the service's reserve record; otherwise a new
   * one is stored on the row (compare-and-write) before it is sent, so a
   * reload or another tab replays the same command id.
   */
  private static async prepareAuctionRegistration(
    listing: CommerceListingRecord,
    attempt: ListingRegistrationAttempt,
    reservePrice?: CommerceMoney | null,
  ): Promise<MarketplaceCommand | 'superseded'> {
    if (listing.sale.format !== 'auction') {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Auction reserve requires an auction listing.', {
        service: ErrorService.Marketplace,
        operation: 'prepareAuctionRegistration',
      });
    }
    this.assertListingRegistrationFence(attempt);
    const projection = await MarketplaceGatewayService.getSellerListing(listing.ownerPubky, attempt.aggregateId, {
      signal: attempt.signal,
    });
    this.assertListingRegistrationFence(attempt);
    const serviceRecordRevision = projection?.reserveRecordRevision ?? 0;
    const state = await LocalCommerceService.getListingRegistrationState(attempt.compositeListingId);
    this.assertListingRegistrationFence(attempt);
    if (state.generation === null || state.generation.writeId !== attempt.observed?.writeId) return 'superseded';
    const pending = state.auctionRegistration;
    const reusingPending =
      pending !== null &&
      pending.listing_revision === listing.revision &&
      pending.record_revision === serviceRecordRevision + 1;
    const replayingAcknowledged =
      pending !== null &&
      projection !== null &&
      pending.listing_revision === listing.revision &&
      pending.record_revision === serviceRecordRevision &&
      projection.lastReserveCommandId === pending.command_id;
    if ((reusingPending || replayingAcknowledged) && pending) {
      if (reservePrice !== undefined && canonicalJson(reservePrice) !== canonicalJson(pending.reserve_price)) {
        throw Err.client(
          ClientErrorCode.CONFLICT,
          'The pending reserve differs from this edit. Reload and try again.',
          {
            service: ErrorService.Marketplace,
            operation: 'prepareAuctionRegistration',
          },
        );
      }
      return this.auctionRegisterCommand(listing, pending);
    }

    const chosenReserve = reservePrice !== undefined ? reservePrice : (projection?.reservePrice ?? null);
    const command: CommerceAuctionRegistrationCommand = {
      command_id: crypto.randomUUID(),
      issued_at: new Date().toISOString(),
      listing_revision: listing.revision,
      reserve_price: chosenReserve,
      expected_service_revision: projection?.serverRevision ?? 0,
      expected_record_revision: serviceRecordRevision,
      record_revision: serviceRecordRevision + 1,
    };
    this.assertListingRegistrationFence(attempt);
    const stored = await LocalCommerceService.persistAuctionRegistration(
      attempt.compositeListingId,
      attempt.observed,
      command,
    );
    this.assertListingRegistrationFence(attempt);
    if (stored === null) return 'superseded';
    attempt.observed = stored;
    return this.auctionRegisterCommand(listing, command);
  }

  private static auctionRegisterCommand(
    listing: CommerceListingRecord,
    pending: CommerceAuctionRegistrationCommand,
  ): MarketplaceCommand {
    const unitPrice = listing.sale.format === 'auction' ? listing.sale.startingPrice : listing.sale.unitPrice;
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: pending.command_id,
      aggregateId: buildMarketplaceListingAggregateId(listing.ownerPubky, listing.listingId),
      expectedRevision: pending.expected_service_revision,
      issuedAt: pending.issued_at,
      kind: 'listing.register',
      payload: {
        sellerPubky: listing.ownerPubky,
        listingId: listing.listingId,
        title: listing.title,
        listingRevision: listing.revision,
        contentHash: listing.media[0].contentHash,
        quantity: listing.variants.reduce((total, variant) => total + variant.quantity, 0),
        unitPrice,
        shippingMinor: commerceListingShippingMinor(listing.shippingOptions),
        saleFormat: 'auction',
        fulfillmentMethods: commerceListingFulfillmentMethods(
          listing.fulfillmentMethods,
          listing.digitalLock !== undefined,
        ),
        auctionTerms:
          listing.sale.format === 'auction'
            ? {
                startsAt: listing.sale.startsAt,
                endsAt: listing.sale.endsAt,
                minimumIncrement: listing.sale.minimumIncrement,
                antiSnipingWindowSeconds: listing.sale.antiSnipingWindowSeconds,
                antiSnipingExtensionSeconds: listing.sale.antiSnipingExtensionSeconds,
              }
            : undefined,
        auctionReserve: {
          expectedRecordRevision: pending.expected_record_revision,
          recordRevision: pending.record_revision,
          reservePrice: pending.reserve_price,
        },
      },
    });
    return command;
  }

  /**
   * The service half of one attempt, run under the listing's lock after the
   * homeserver precheck found the record: a service 404 for a deleted
   * listing is never answered with `listing.register` blind. Every service
   * request carries the attempt's deadline, and the fence is checked after
   * each one.
   */
  private static async registerListing(
    listing: CommerceListingRecord,
    attempt: ListingRegistrationAttempt,
  ): Promise<ListingRegistrationOutcome> {
    const aggregateId = attempt.aggregateId;
    const durable = isDurableCommerceMode(getCommerceAdapterMode());
    const send = async (command: MarketplaceCommand) => {
      this.assertListingRegistrationFence(attempt);
      const response = await MarketplaceGatewayService.execute(listing.ownerPubky, command, { signal: attempt.signal });
      this.assertListingRegistrationFence(attempt);
      return response;
    };
    if (listing.sale.format === 'auction' && durable) {
      const command = await this.prepareAuctionRegistration(listing, attempt);
      if (command === 'superseded') return 'superseded';
      const response = await send(command);
      if (isListingRecordNotFoundResponse(response, aggregateId, command.commandId)) return 'service_not_found';
      if (!isSuccessfulListingRegistrationResponse(response, aggregateId, command.commandId)) {
        throw Err.client(ClientErrorCode.BAD_REQUEST, 'Marketplace listing registration was refused.', {
          service: ErrorService.Marketplace,
          operation: 'registerListing',
        });
      }
      return 'registered';
    }
    this.assertListingRegistrationFence(attempt);
    const existing = await MarketplaceGatewayService.getListing(listing.ownerPubky, aggregateId, {
      signal: attempt.signal,
    });
    this.assertListingRegistrationFence(attempt);
    if (existing?.serverRevision) {
      // Already registered: EDITS must still reach the authority. `listing.sync`
      // is convergent — the service re-reads the seller-signed record and
      // updates the aggregate's terms when the record revision advanced, or
      // no-ops when nothing changed. Skipping here (the old behavior) left
      // the service charging a stale price after every edit. The sandbox has
      // no homeserver to sync from, so it keeps the skip.
      if (durable) {
        const command = this.createListingSyncCommand(listing.ownerPubky, listing.listingId);
        const response = await send(command);
        if (isListingRecordNotFoundResponse(response, aggregateId, command.commandId)) return 'service_not_found';
        if (!isSuccessfulListingRegistrationResponse(response, aggregateId, command.commandId, true)) {
          throw Err.client(ClientErrorCode.BAD_REQUEST, 'Marketplace listing registration was refused.', {
            service: ErrorService.Marketplace,
            operation: 'registerListing',
          });
        }
      }
      return 'registered';
    }
    const unitPrice = listing.sale.format === 'fixed_price' ? listing.sale.unitPrice : listing.sale.startingPrice;
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId,
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'listing.register',
      payload: {
        sellerPubky: listing.ownerPubky,
        listingId: listing.listingId,
        title: listing.title,
        listingRevision: listing.revision,
        contentHash: listing.media[0].contentHash,
        quantity: listing.variants.reduce((total, variant) => total + variant.quantity, 0),
        unitPrice,
        shippingMinor: commerceListingShippingMinor(listing.shippingOptions),
        saleFormat: listing.sale.format,
        // The service-facing fulfillment methods (§A1), derived from the
        // record exactly as the service's own homeserver derivation would.
        fulfillmentMethods: commerceListingFulfillmentMethods(
          listing.fulfillmentMethods,
          listing.digitalLock !== undefined,
        ),
        auctionTerms:
          listing.sale.format === 'auction'
            ? {
                startsAt: listing.sale.startsAt,
                endsAt: listing.sale.endsAt,
                minimumIncrement: listing.sale.minimumIncrement,
                antiSnipingWindowSeconds: listing.sale.antiSnipingWindowSeconds,
                antiSnipingExtensionSeconds: listing.sale.antiSnipingExtensionSeconds,
              }
            : undefined,
        auctionReserve:
          listing.sale.format === 'auction'
            ? {
                expectedRecordRevision: 0,
                recordRevision: 1,
                reservePrice: null,
              }
            : undefined,
      },
    });
    const response = await send(command);
    if (isListingRecordNotFoundResponse(response, aggregateId, command.commandId)) return 'service_not_found';
    if (!isSuccessfulListingRegistrationResponse(response, aggregateId, command.commandId)) {
      if (!isCorrelatedBenignListingRegistrationResponse(response, aggregateId, command.commandId)) {
        throw Err.client(ClientErrorCode.BAD_REQUEST, 'Marketplace listing registration was refused.', {
          service: ErrorService.Marketplace,
          operation: 'registerListing',
        });
      }
      const confirmed = await MarketplaceGatewayService.getListing(listing.ownerPubky, aggregateId, {
        signal: attempt.signal,
      });
      this.assertListingRegistrationFence(attempt);
      if (
        !isSuccessfulListingRegistrationResponse(
          response,
          aggregateId,
          command.commandId,
          Boolean(confirmed?.serverRevision),
        )
      ) {
        throw Err.client(ClientErrorCode.BAD_REQUEST, 'Marketplace listing registration was refused.', {
          service: ErrorService.Marketplace,
          operation: 'registerListing',
        });
      }
    }
    return 'registered';
  }

  private static createSyncJob({
    ownerId,
    entityType,
    entityId,
    operation,
    payload,
    now,
  }: {
    ownerId: string;
    entityType: CommerceSyncJobModelSchema['entity_type'];
    entityId: string;
    operation: CommerceSyncJobModelSchema['operation'];
    payload: CommerceSyncJobModelSchema['payload'];
    now: number;
  }): CommerceSyncJobModelSchema {
    return {
      id: crypto.randomUUID(),
      owner_id: ownerId,
      entity_type: entityType,
      entity_id: entityId,
      operation,
      status: 'pending',
      attempts: 0,
      next_attempt_at: now,
      last_error_code: null,
      payload,
      created_at: now,
      updated_at: now,
    };
  }

  private static createListingSyncCommand(sellerPubky: string, listingId: string) {
    return CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceListingAggregateId(sellerPubky, listingId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'listing.sync',
      payload: { sellerPubky, listingId },
    });
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeOpenWorldRecords(
  existing: Record<string, unknown>,
  managed: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(managed)) {
    const prior = merged[key];
    if (isPlainRecord(prior) && isPlainRecord(value)) {
      merged[key] = mergeOpenWorldRecords(prior, value);
    } else if (Array.isArray(prior) && Array.isArray(value)) {
      merged[key] = mergeOpenWorldRecordArray(prior, value);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function mergeOpenWorldRecordArray(existing: unknown[], managed: unknown[]): unknown[] {
  const hasStableIds = managed.every((value) => isPlainRecord(value) && typeof value.id === 'string');
  if (!hasStableIds) return structuredClone(managed);

  const existingById = new Map(
    existing
      .filter((value): value is Record<string, unknown> => isPlainRecord(value) && typeof value.id === 'string')
      .map((value) => [value.id as string, value]),
  );
  return managed.map((value) => {
    const managedRecord = value as Record<string, unknown>;
    const prior = existingById.get(managedRecord.id as string);
    return prior ? mergeOpenWorldRecords(prior, managedRecord) : structuredClone(managedRecord);
  });
}

function ownAuctionReserveFileUrl(directory: string, entry: string): string | null {
  const name = entry.startsWith(directory) ? entry.slice(directory.length) : entry;
  if (
    name.length === 0 ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    !name.endsWith('.json')
  ) {
    return null;
  }
  if (entry.includes('://') && !entry.startsWith(directory)) return null;
  return entry.startsWith(directory) ? entry : `${directory}${name}`;
}

/**
 * Matches what `JSON.stringify` writes: an object key whose value is
 * `undefined` is omitted (the homeserver never sees it), while an
 * `undefined` array element is `null`.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
