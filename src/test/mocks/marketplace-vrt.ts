import { createZustandLikeHook } from '@/test-utils/stores';

export function createMarketplaceVrtAuthStore(overrides: Record<string, unknown> = {}) {
  const getCurrentUserPubky =
    (overrides.getCurrentUserPubky as (() => string | null) | undefined) ??
    (() => overrides.currentUserPubky ?? 'u'.repeat(52));
  const snapshot: Record<string, unknown> = {
    currentUserPubky: getCurrentUserPubky(),
    session: null,
    setShowSignInDialog: () => {},
    ...overrides,
  };
  delete snapshot.getCurrentUserPubky;
  Object.defineProperty(snapshot, 'currentUserPubky', {
    configurable: true,
    get: getCurrentUserPubky,
  });
  snapshot.selectCurrentUserPubky = getCurrentUserPubky;
  return createZustandLikeHook(snapshot);
}

export function createMarketplaceVrtCommerceController() {
  return {
    getCartItems: async () => [],
    getManyListings: async () => new Map(),
    getWatchAlerts: async () => [],
    getActivityReadCheckpoint: async () => 0,
    getMarketplaceNotifications: async () => [],
    getMarketplaceOrders: async () => [],
    getMarketplaceOffers: async () => [],
    syncAttentionSeen: async () => {},
    // The deployment reports no digital delivery unless a scene opts in.
    fetchDigitalDeliveryCapability: async () => ({ available: false, maxBytes: null }),
    // USDT stays off unless a scene opts in.
    fetchUsdtPaymentsAvailable: async () => false,
    getSellerPaymentConfig: async () => ({
      bitcoinAvailable: false,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    }),
  };
}
