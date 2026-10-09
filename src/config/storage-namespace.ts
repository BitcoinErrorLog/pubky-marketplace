import { getBasePath } from '@/config/base-path';
import { isShopEmbedded } from '@/config/embedded';
import { getStorageAdoptLegacyOverride } from '@/libs/runtime-config/runtime-config';

/**
 * Whether this origin's pre-namespace browser storage (`franky`, `auth-store`, ...) is the
 * Shop's, so it should be migrated into the Shop namespace.
 *
 * Never while embedded: an embedded Shop runs on the host app's origin (or in storage
 * partitioned away from the user's own), where those names are not the Shop's, and a
 * database deleted from inside the frame is gone for the top page too (verified on iOS
 * Safari). Otherwise `PUBKY_RUNTIME_STORAGE_ADOPT_LEGACY` decides when set, and the answer
 * is yes for a Shop served from the origin root (`shop.pubky.app`, where those names have
 * only ever been the Shop's) and no for a Shop mounted under a base path (`pubky.app/shop`,
 * where they are the host app's and must never be touched).
 */
export function getStorageAdoptLegacy(): boolean {
  if (isShopEmbedded()) return false;
  return getStorageAdoptLegacyOverride() ?? getBasePath() === '';
}
