import { describe, expect, it } from 'vitest';
import {
  buildFeatureDiscoveryDeviceStorageKey,
  buildFeatureDiscoveryStorageKey,
  FEATURE_DISCOVERY_STORAGE_PREFIX,
  MARKETPLACE_PROMO_STORAGE_ID,
} from './featureDiscovery';

describe('featureDiscovery storage keys', () => {
  it('keeps per-account keys namespaced to the pubky', () => {
    expect(buildFeatureDiscoveryStorageKey('pk:user', MARKETPLACE_PROMO_STORAGE_ID)).toBe(
      `${FEATURE_DISCOVERY_STORAGE_PREFIX}:pk:user:${MARKETPLACE_PROMO_STORAGE_ID}`,
    );
  });

  it('builds a device-wide key with the same prefix and no pubky segment', () => {
    expect(buildFeatureDiscoveryDeviceStorageKey(MARKETPLACE_PROMO_STORAGE_ID)).toBe(
      `${FEATURE_DISCOVERY_STORAGE_PREFIX}:${MARKETPLACE_PROMO_STORAGE_ID}`,
    );
  });
});
