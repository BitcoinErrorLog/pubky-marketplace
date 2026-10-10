export type CommerceSaleFormatFilter = 'all' | 'fixed_price' | 'auction' | 'drops';

/**
 * Public facts about the marketplace transaction-service session, set by the
 * controller when a signer-approved session is established. Deliberately
 * NEVER contains the bearer token — that lives only inside
 * `MarketplaceSessionService`'s private field. This mirror exists so
 * durable-mode surfaces can re-render (and refetch) the moment a session is
 * connected, and it is cleared with the rest of the store on sign-out.
 */
export interface CommerceMarketplaceSession {
  pubky: string;
  capabilities: string;
  expiresAt: string;
  issuedAt: string;
}
/**
 * Cross-device watchlist sync state for UI surfaces, written by the
 * controller after each sync round. `idle` = no sync attempted yet (or not
 * applicable: sandbox mode, signed out); `needs_reauth` = the session's grant
 * cannot write `/priv/pubky.app/` (legacy approval) OR an actual write was
 * refused with 401/403 — the honest "re-approve to enable sync" state;
 * `needs_marketplace_approval` = the marketplace refused to release the data
 * key to the current purchase session, so the fix is a marketplace session
 * approval, whichever signer the user signed in with;
 * `unavailable` = the marketplace cannot release the data key that encrypts
 * the synced copy right now, so nothing was written.
 */
export type CommerceWatchlistSyncUiStatus =
  | 'idle'
  | 'synced'
  | 'needs_reauth'
  | 'needs_marketplace_approval'
  | 'unavailable'
  | 'unsupported'
  | 'error';

/**
 * Portable order-receipt publication state for UI surfaces, written by the
 * controller after each publication pass. `idle` = no pass ran yet (or not
 * applicable: sandbox mode, signed out); `published` = every eligible paid
 * order's receipt is confirmed on the owner's homeserver; `needs_reauth` =
 * the session's grant cannot write `/priv/pubky.app/` (a bridged or legacy
 * approval) OR the private read/write was refused with 401/403 — the honest
 * "reconnect to save it" state; `needs_marketplace_approval` = the
 * marketplace refused to release the data key to the current purchase
 * session; `unavailable` = this deployment issued no attestation, or a
 * transient failure left a receipt unpublished (it retries on the next
 * orders-surface load).
 */
export type CommerceReceiptPublicationUiStatus =
  | 'idle'
  | 'published'
  | 'needs_reauth'
  | 'needs_marketplace_approval'
  | 'unavailable';

/**
 * Why the service refused to bind USDT to an order: `usdt_unavailable` (the
 * deployment cannot take USDT yet) or `usdt_seller_not_ready` (this seller
 * cannot). Either way the same USDT bind would be refused again.
 */
export type CommerceUsdtRefusalReason = 'usdt_unavailable' | 'usdt_seller_not_ready';

export type CommerceConditionFilter = 'new' | 'like_new' | 'excellent' | 'good' | 'fair' | 'for_parts';
export type CommerceSort = 'recommended' | 'newest' | 'price_low' | 'price_high' | 'ending_soon';
export type CommerceLayout = 'grid' | 'list';

export interface CommerceState {
  query: string;
  categoryId: string | null;
  /**
   * Active attribute facet filters (attribute key -> stored value), scoped
   * to the current category — changing or clearing the category clears them.
   */
  attributeFilters: Record<string, string>;
  saleFormat: CommerceSaleFormatFilter;
  conditions: CommerceConditionFilter[];
  minimumPriceMinor: number | null;
  maximumPriceMinor: number | null;
  /** Seller-declared item location filter: ISO-3166-1 alpha-2, null = anywhere. */
  countryCode: string | null;
  sort: CommerceSort;
  layout: CommerceLayout;
  selectedListingId: string | null;
  pendingEntityIds: string[];
  marketplaceSession: CommerceMarketplaceSession | null;
  inventorySession: CommerceMarketplaceSession | null;
  watchlistSyncStatus: CommerceWatchlistSyncUiStatus;
  receiptsPublicationStatus: CommerceReceiptPublicationUiStatus;
  /**
   * USDT refusals this browser session has seen, keyed by the checkout's
   * seller set (the seller pubky, or the pubkys joined with `|` for a
   * multi-seller cart). Checkout and the order's payment card stop offering
   * USDT for that key. Memory only: a reload clears it, and a different
   * seller set has a different key.
   */
  usdtRefusals: Record<string, CommerceUsdtRefusalReason>;
}

export interface CommerceActions {
  setQuery: (query: string) => void;
  setCategoryId: (categoryId: string | null) => void;
  setAttributeFilter: (key: string, value: string | null) => void;
  setSaleFormat: (saleFormat: CommerceSaleFormatFilter) => void;
  setConditions: (conditions: CommerceConditionFilter[]) => void;
  setPriceRange: (minimumPriceMinor: number | null, maximumPriceMinor: number | null) => void;
  setCountryCode: (countryCode: string | null) => void;
  setSort: (sort: CommerceSort) => void;
  setLayout: (layout: CommerceLayout) => void;
  setSelectedListingId: (listingId: string | null) => void;
  setEntityPending: (entityId: string, isPending: boolean) => void;
  setMarketplaceSession: (session: CommerceMarketplaceSession | null) => void;
  setInventorySession: (session: CommerceMarketplaceSession | null) => void;
  setWatchlistSyncStatus: (watchlistSyncStatus: CommerceWatchlistSyncUiStatus) => void;
  setReceiptsPublicationStatus: (receiptsPublicationStatus: CommerceReceiptPublicationUiStatus) => void;
  setUsdtRefusal: (sellerKey: string, reason: CommerceUsdtRefusalReason) => void;
  resetFilters: () => void;
  reset: () => void;
}

export type CommerceStore = CommerceState & CommerceActions;

export const commerceInitialState: CommerceState = {
  query: '',
  categoryId: null,
  attributeFilters: {},
  saleFormat: 'all',
  conditions: [],
  minimumPriceMinor: null,
  maximumPriceMinor: null,
  countryCode: null,
  sort: 'recommended',
  layout: 'grid',
  selectedListingId: null,
  pendingEntityIds: [],
  marketplaceSession: null,
  inventorySession: null,
  watchlistSyncStatus: 'idle',
  receiptsPublicationStatus: 'idle',
  usdtRefusals: {},
};

export enum CommerceActionTypes {
  SET_QUERY = 'SET_QUERY',
  SET_CATEGORY = 'SET_CATEGORY',
  SET_ATTRIBUTE_FILTER = 'SET_ATTRIBUTE_FILTER',
  SET_SALE_FORMAT = 'SET_SALE_FORMAT',
  SET_CONDITIONS = 'SET_CONDITIONS',
  SET_PRICE_RANGE = 'SET_PRICE_RANGE',
  SET_COUNTRY = 'SET_COUNTRY',
  SET_SORT = 'SET_SORT',
  SET_LAYOUT = 'SET_LAYOUT',
  SET_SELECTED_LISTING = 'SET_SELECTED_LISTING',
  SET_ENTITY_PENDING = 'SET_ENTITY_PENDING',
  SET_MARKETPLACE_SESSION = 'SET_MARKETPLACE_SESSION',
  SET_INVENTORY_SESSION = 'SET_INVENTORY_SESSION',
  SET_WATCHLIST_SYNC_STATUS = 'SET_WATCHLIST_SYNC_STATUS',
  SET_RECEIPTS_PUBLICATION_STATUS = 'SET_RECEIPTS_PUBLICATION_STATUS',
  SET_USDT_REFUSAL = 'SET_USDT_REFUSAL',
  RESET_FILTERS = 'RESET_FILTERS',
  RESET = 'RESET',
}
