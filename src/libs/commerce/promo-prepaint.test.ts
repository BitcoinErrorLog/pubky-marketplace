import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildFeatureDiscoveryDeviceStorageKey,
  buildFeatureDiscoveryStorageKey,
  MARKETPLACE_PROMO_STORAGE_ID,
} from '@/config/featureDiscovery';
import {
  buildMarketplacePromoPrepaintScript,
  MARKETPLACE_PROMO_PREPAINT_STYLE_ID,
  removeMarketplacePromoPrepaintStyle,
} from './promo-prepaint';

const PUBKY = 'n3pfudgxtestpubkyn3pfudgxtestpubkyn3pfudgxtestpubky1';

function runPrepaint() {
  new Function(buildMarketplacePromoPrepaintScript())();
  return document.getElementById(MARKETPLACE_PROMO_PREPAINT_STYLE_ID);
}

function persistAccount(pubky: string) {
  window.localStorage.setItem('auth-store', JSON.stringify({ state: { currentUserPubky: pubky }, version: 0 }));
}

describe('marketplace promo prepaint script', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    removeMarketplacePromoPrepaintStyle();
  });

  it('leaves the promo visible for a first-time visitor', () => {
    expect(runPrepaint()).toBeNull();
  });

  it('hides the promo before paint after a device-wide dismissal', () => {
    window.localStorage.setItem(buildFeatureDiscoveryDeviceStorageKey(MARKETPLACE_PROMO_STORAGE_ID), 'dismissed');

    expect(runPrepaint()?.textContent).toBe('[data-marketplace-promo]{display:none}');
  });

  it('hides the promo before paint for the persisted account that dismissed it', () => {
    persistAccount(PUBKY);
    window.localStorage.setItem(buildFeatureDiscoveryStorageKey(PUBKY, MARKETPLACE_PROMO_STORAGE_ID), 'dismissed');

    expect(runPrepaint()).not.toBeNull();
  });

  it('keeps the promo for a different persisted account', () => {
    persistAccount(PUBKY);
    window.localStorage.setItem(buildFeatureDiscoveryStorageKey('other', MARKETPLACE_PROMO_STORAGE_ID), 'dismissed');

    expect(runPrepaint()).toBeNull();
  });

  it('ignores a malformed persisted auth store', () => {
    window.localStorage.setItem('auth-store', '{not json');

    expect(runPrepaint()).toBeNull();
  });

  it('removes the prepaint style', () => {
    window.localStorage.setItem(buildFeatureDiscoveryDeviceStorageKey(MARKETPLACE_PROMO_STORAGE_ID), 'dismissed');
    runPrepaint();

    removeMarketplacePromoPrepaintStyle();

    expect(document.getElementById(MARKETPLACE_PROMO_PREPAINT_STYLE_ID)).toBeNull();
  });
});
