import {
  getCommerceAdapterMode,
  getCommercePollIntervalMs,
  getLocksUrl,
  getMarketplaceUrl,
  getPaykitSetupCreatorParam,
  getPaykitSetupUrl,
  getUsdtPaymentsEnabled,
} from '@/libs/runtime-config/runtime-config';
import type { CommerceAdapterMode } from '@/libs/runtime-config/runtime-config.schema';

export {
  type CommerceAdapterMode,
  getCommerceAdapterMode,
  getCommercePollIntervalMs,
  getLocksUrl,
  getMarketplaceUrl,
  getPaykitSetupCreatorParam,
  getPaykitSetupUrl,
  getUsdtPaymentsEnabled,
};

/**
 * True when the mode has a marketplace transaction backend the interactive
 * flows can operate against: the in-memory sandbox (simulated outcomes) or
 * the durable Rust transaction service (authoritative outcomes, selected by
 * both durable modes — see {@link isDurableCommerceMode}). `unavailable` has
 * no command/read surface and the shopping UI must say so.
 */
export function isTransactionalCommerceMode(mode: CommerceAdapterMode): boolean {
  return mode === 'sandbox' || isDurableCommerceMode(mode);
}

/**
 * True when marketplace commands and reads go to the durable Rust Marketplace
 * Transaction Service (Pubky AuthToken sessions, snake_case wire, role-scoped
 * projections). The two durable modes COMPOSE rather than exclude:
 *
 * - `transaction-service`: the durable authority alone; payments stay on its
 *   sandbox adapter and this client refuses to simulate them, so orders
 *   honestly sit awaiting payment.
 * - `locks-paykit`: the same durable authority PLUS the real Locks/Paykit
 *   payment rails. The client submits the buyer's proof bundle to the Lock
 *   Server and registers the correlation via `payment.register_locks`; the
 *   service's worker — never this client — verifies the Locks lifecycle and
 *   confirms the payment.
 */
export function isDurableCommerceMode(mode: CommerceAdapterMode): boolean {
  return mode === 'transaction-service' || mode === 'locks-paykit';
}

/** True when the real Locks/Paykit buyer payment rails are active. */
export function isLocksPaykitCommerceMode(mode: CommerceAdapterMode): boolean {
  return mode === 'locks-paykit';
}

export const COMMERCE_CONTRACT_VERSION = 1 as const;
/**
 * The taxonomy version new listings publish. Version 2 introduced the full
 * category tree and category-dependent attributes (see
 * `src/config/taxonomy/taxonomy.ts`); version-1 records (four flat
 * categories, no attributes) remain valid — their ids all resolve in the v2
 * tree. Records validate against the range below, mirroring the specs fork
 * (0.6.2-marketplace.4), which bounds `taxonomyVersion` instead of pinning
 * it so the taxonomy can evolve as client config without spec churn.
 */
export const COMMERCE_TAXONOMY_VERSION = 2 as const;
export const COMMERCE_TAXONOMY_VERSION_MIN = 1;
export const COMMERCE_TAXONOMY_VERSION_MAX = 1_000_000;

export const COMMERCE_SHOP_NAME_MAX_CHARS = 60;
export const COMMERCE_SHOP_BIO_MAX_CHARS = 1_000;
export const COMMERCE_SHOP_POLICY_MAX_CHARS = 4_000;

export const COMMERCE_LISTING_TITLE_MIN_CHARS = 3;
export const COMMERCE_LISTING_TITLE_MAX_CHARS = 80;
export const COMMERCE_LISTING_DESCRIPTION_MAX_CHARS = 10_000;
export const COMMERCE_LISTING_MAX_IMAGES = 12;
/**
 * How many photos the in-app sell/edit studio accepts per listing. The record
 * contract (and the pubky-app-specs fork) allows up to
 * {@link COMMERCE_LISTING_MAX_IMAGES}; the studio deliberately caps composing
 * at 8 so records published elsewhere with more images still validate and
 * render.
 */
export const COMMERCE_LISTING_STUDIO_MAX_PHOTOS = 8;
export const COMMERCE_LISTING_MAX_VIDEOS = 1;
export const COMMERCE_LISTING_MAX_MEDIA = COMMERCE_LISTING_MAX_IMAGES + COMMERCE_LISTING_MAX_VIDEOS;
export const COMMERCE_LISTING_MAX_VARIANTS = 100;
export const COMMERCE_LISTING_MAX_OPTION_DIMENSIONS = 3;
export const COMMERCE_LISTING_MAX_TAGS = 10;
export const COMMERCE_LISTING_MAX_QUANTITY = 1_000_000;

export const COMMERCE_REVIEW_TEXT_MAX_CHARS = 5_000;
/**
 * How long a reviewer may edit their review after creating it, mirroring the
 * durable service's `REVIEW_EDIT_WINDOW_SECONDS`. `review.update` exists
 * only on the durable service (the sandbox has no review editing), and the
 * service enforces the window against the review's `created_at` — the client
 * uses this constant purely to withhold the edit affordance once the window
 * has closed instead of failing on submit.
 */
export const COMMERCE_REVIEW_EDIT_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * The attestor pubkys this client TRUSTS for the "Verified purchase" label
 * (ADR 0024 §3: the signature proves key possession, never legitimacy —
 * verifiers pin attestor identities out of band, and this list is that
 * pinning). Nexus indexes every cryptographically verified review and names
 * its attestor; display trust is decided here. Two entries, one per deployed
 * transaction service — the staging Railway project
 * `pubky-marketplace-staging` and the production project
 * `pubky-marketplace-production` — both operated by the marketplace operator.
 */
export const MARKETPLACE_TRUSTED_ATTESTORS: readonly string[] = [
  // pubky-marketplace-staging (Railway)
  'ws343aqzmcahagojhmhkbri8odqz9iqg61woxbkh9fd3bxhqomdy',
  // pubky-marketplace-production (Railway)
  'szhtpayftdz3mpkoyyk3zesuad11ufuudqqrc73s35w1tfju7gxy',
];

/** Whether an attestor pubky is on this client's pinned trust list. */
export function isTrustedMarketplaceAttestor(attestorId: string | null): boolean {
  return attestorId !== null && MARKETPLACE_TRUSTED_ATTESTORS.includes(attestorId);
}

/** Page size for marketplace review lists (listing and shop surfaces). */
export const MARKETPLACE_REVIEWS_PAGE_SIZE = 10;
export const COMMERCE_MEDIA_ALT_TEXT_MAX_CHARS = 300;
export const COMMERCE_CATALOG_SKELETON_COUNT = 8;

/** Most cards the home-feed "From sellers you follow" shelf renders. */
export const MARKETPLACE_FOLLOWED_SHELF_MAX_CARDS = 12;
/**
 * Most recent follows the shelf considers when intersecting the viewer's
 * social graph with the marketplace index. One user-stream slice — never a
 * request per follow (see `fetchFollowedSellerCatalogListings`).
 */
export const MARKETPLACE_FOLLOWED_SHELF_FOLLOWS_LIMIT = 30;
/**
 * Most per-seller listing-stream refreshes one shelf refresh may issue. The
 * Nexus listing stream accepts a single `seller_id` per request, so this cap
 * bounds the shelf's network cost the same way the auction card's
 * viewport-lazy projection read bounds the catalog's (`useMarketplaceLiveBid`).
 */
export const MARKETPLACE_FOLLOWED_SHELF_MAX_SELLER_FETCHES = 6;
/** Most cards each Hot-page marketplace module ("Ending soon" / "Fresh listings") renders. */
export const MARKETPLACE_HOT_MODULE_MAX_CARDS = 4;
/**
 * How close an observed auction deadline must be before a watched item raises
 * an "ending soon" alert.
 */
export const COMMERCE_WATCH_ENDING_SOON_THRESHOLD_MS = 24 * 60 * 60 * 1_000;

/**
 * Most-recently-watched items refreshed per detection pass. The Nexus
 * per-listing read and the service's public listing projection are both
 * per-item requests, so this bounds one pass to at most 2×N requests.
 */
export const COMMERCE_WATCH_CHECK_MAX_ITEMS = 24;

/**
 * Minimum spacing between detection passes for the same account. Passes run
 * on marketplace/watchlist visit and window focus — not on a background
 * timer — and this keeps rapid tab switching from fanning out repeated
 * per-item reads.
 */
export const COMMERCE_WATCH_CHECK_MIN_INTERVAL_MS = 60 * 1_000;

/** Saved searches re-run per check pass (each is one Nexus stream request). */
export const COMMERCE_SAVED_SEARCH_CHECK_MAX = 10;

export const COMMERCE_SAVED_SEARCH_NAME_MAX_CHARS = 60;

/** Saved searches storable per account. */
export const COMMERCE_SAVED_SEARCH_MAX_PER_OWNER = 20;
