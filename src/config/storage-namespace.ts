import { getBasePath } from '@/config/base-path';
import { getStorageAdoptLegacyOverride } from '@/libs/runtime-config/runtime-config';

/**
 * Whether this origin's pre-namespace browser storage (`franky`, `auth-store`, ...) is the
 * Shop's, so it should be migrated into the Shop namespace.
 *
 * `PUBKY_RUNTIME_STORAGE_ADOPT_LEGACY` decides when set. Otherwise the answer is yes for a
 * Shop served from the origin root (`shop.pubky.app`, where those names have only ever been
 * the Shop's) and no for a Shop mounted under a base path (`pubky.app/shop`, where they are
 * the host app's and must never be touched).
 */
export function getStorageAdoptLegacy(): boolean {
  return getStorageAdoptLegacyOverride() ?? getBasePath() === '';
}
