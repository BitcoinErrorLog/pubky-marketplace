import { shopStorageKey } from '@/libs/storage-namespace/storage-namespace';

export const COLLECTIONS_NAV_NEW_BADGE_ENABLED = true;
export const COLLECTIONS_NAV_NEW_BADGE_STORAGE_ID = 'collections-nav-v1';
export const MARKETPLACE_PROMO_STORAGE_ID = 'marketplace-promo-v1';
/** Namespaced: the App defines the same prefix and its own flag ids. */
export const FEATURE_DISCOVERY_STORAGE_PREFIX = shopStorageKey('pubky-feature-discovery');
/** The prefix before it was namespaced; read only by the one-time storage migration. */
export const LEGACY_FEATURE_DISCOVERY_STORAGE_PREFIX = 'pubky-feature-discovery';

export function buildFeatureDiscoveryStorageKey(pubky: string, featureId: string): string {
  return `${FEATURE_DISCOVERY_STORAGE_PREFIX}:${pubky}:${featureId}`;
}

/** Device-wide key (no account). Same prefix as per-account keys; no pubky segment. */
export function buildFeatureDiscoveryDeviceStorageKey(featureId: string): string {
  return `${FEATURE_DISCOVERY_STORAGE_PREFIX}:${featureId}`;
}
