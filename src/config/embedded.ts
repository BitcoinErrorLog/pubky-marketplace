import { isEmbedded } from '@/libs/embedded/embedded';
import { getEmbeddedFlag, getFrameAncestors } from '@/libs/runtime-config/runtime-config';

/**
 * Whether the Shop is running embedded in another app's page. Server rendering
 * only knows the deployer flag; the browser adds frame detection (when the
 * deployment allows framing) and the `?embedded=1` URL flag (see
 * `@/libs/embedded/embedded`).
 */
export function isShopEmbedded(): boolean {
  return isEmbedded({ forced: getEmbeddedFlag(), framingAllowed: getFrameAncestors().length > 0 });
}
