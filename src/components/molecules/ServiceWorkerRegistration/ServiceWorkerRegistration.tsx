'use client';

import { useEffect } from 'react';
import { getBasePath } from '@/config/base-path';
import { isShopEmbedded } from '@/config/embedded';

type SerwistWindow = Window & { serwist?: { register: () => Promise<unknown> } };

/**
 * Registers the Shop's service worker, unless another app owns the worker scope.
 *
 * The Serwist build plugin defines `window.serwist` but no longer registers on its own
 * (`register: false` in `next.config.ts`). The worker is skipped when:
 *  - the Shop is embedded in another app's page, whose own worker already covers the page;
 *  - the Shop is mounted under a base path on another app's origin, where a second worker
 *    would compete with the host's for the shared origin and its precache would cover only
 *    the Shop's shell.
 *
 * Embedded detection runs inside the effect rather than reading the hydration-time hook
 * value, which is still the server snapshot (`false`) on the first commit of a framed page.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (getBasePath() !== '' || isShopEmbedded()) return;
    void (window as SerwistWindow).serwist?.register();
  }, []);

  return null;
}
