import {
  buildFeatureDiscoveryDeviceStorageKey,
  buildFeatureDiscoveryStorageKey,
  MARKETPLACE_PROMO_STORAGE_ID,
} from '@/config/featureDiscovery';
import { AUTH_PERSIST_KEY } from '@/stores/persistedKeys';

/**
 * The marketplace promo is server-rendered so it never pushes the catalog down
 * after hydration. For a visitor who dismissed it (device-wide or for the
 * persisted account), this inline script hides it before the first paint; the
 * Marketplace template (whose promo section carries `data-marketplace-promo`)
 * removes the style once its own dismissal state resolves.
 */
const MARKETPLACE_PROMO_ATTRIBUTE = 'data-marketplace-promo';
export const MARKETPLACE_PROMO_PREPAINT_STYLE_ID = 'marketplace-promo-prepaint';

const PUBKY_PLACEHOLDER = '\u0000';

export function buildMarketplacePromoPrepaintScript(): string {
  const deviceKey = buildFeatureDiscoveryDeviceStorageKey(MARKETPLACE_PROMO_STORAGE_ID);
  const [accountKeyPrefix, accountKeySuffix] = buildFeatureDiscoveryStorageKey(
    PUBKY_PLACEHOLDER,
    MARKETPLACE_PROMO_STORAGE_ID,
  ).split(PUBKY_PLACEHOLDER);
  const json = (value: string | undefined) => JSON.stringify(value ?? '').replace(/</g, '\\u003c');
  return (
    '(function(){try{var s=window.localStorage;' +
    `var hide=s.getItem(${json(deviceKey)})==='dismissed';` +
    `if(!hide){var a=JSON.parse(s.getItem(${json(AUTH_PERSIST_KEY)})||'null');` +
    'var p=a&&a.state&&a.state.currentUserPubky;' +
    `if(typeof p==='string'&&p&&s.getItem(${json(accountKeyPrefix)}+p+${json(accountKeySuffix)})==='dismissed')hide=true;}` +
    `if(hide){var e=document.createElement('style');e.id=${json(MARKETPLACE_PROMO_PREPAINT_STYLE_ID)};` +
    `e.textContent='[${MARKETPLACE_PROMO_ATTRIBUTE}]{display:none}';document.head.appendChild(e);}` +
    '}catch(_){}})();'
  );
}

export function removeMarketplacePromoPrepaintStyle(): void {
  document.getElementById(MARKETPLACE_PROMO_PREPAINT_STYLE_ID)?.remove();
}
