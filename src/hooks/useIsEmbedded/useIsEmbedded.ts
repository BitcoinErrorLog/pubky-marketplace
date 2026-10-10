'use client';

import { useSyncExternalStore } from 'react';
import { isShopEmbedded } from '@/config/embedded';
import { getEmbeddedFlag } from '@/libs/runtime-config/runtime-config';

const subscribeNever = () => () => {};

/**
 * True when the Shop is embedded in another app's page.
 *
 * Server rendering and hydration use the deployer flag, which the server also
 * knows, so a deployment that sets `PUBKY_RUNTIME_EMBEDDED` renders the
 * embedded layout from the first byte. A page that is only detected as framed
 * in the browser switches over right after hydration. A top-level Shop reads
 * `false` on both sides and never re-renders.
 */
export function useIsEmbedded(): boolean {
  return useSyncExternalStore(subscribeNever, isShopEmbedded, getEmbeddedFlag);
}
