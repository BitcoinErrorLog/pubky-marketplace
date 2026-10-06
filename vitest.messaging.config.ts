import { playwright } from '@vitest/browser-playwright';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * Live two-party proof for encrypted marketplace messaging.
 *
 * This is NOT a unit suite: it runs the vendored paykit-wasm binding with
 * REAL crypto in a real Chromium page against a LIVE local Pubky testnet
 * (`pubky-testnet`, stock ports: pkarr relay 15411, homeserver HTTP 6286 —
 * see `docs/ecommerce/RUNNING.md`, "Encrypted messaging"). One party runs the
 * app's full `PaykitMessagingService` stack including IndexedDB persistence;
 * the counterparty runs the raw binding the way the binding's own e2e does.
 * Sessions come from the binding's dev/test signup helper — the only leg
 * swapped relative to production, where Pubky Ring approves the grant.
 * Nothing is mocked; a missing testnet FAILS with setup instructions rather
 * than skipping.
 *
 *   npm run test:marketplace:messaging
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  // The Chromium page has no `process` global (Next.js normally injects it);
  // inline the env the imported app modules read at module scope.
  define: {
    'process.env': JSON.stringify({ NODE_ENV: 'test', NEXT_PUBLIC_APP_VERSION: '0.0.0-live' }),
  },
  test: {
    name: 'marketplace-messaging-live',
    // `.live.browser.ts` (not `.test.ts`) keeps the unit project's jsdom
    // glob from picking this up; only this config runs it. The staging
    // variant (single-use tokens) has its own config.
    include: ['src/test/live/messaging.live.browser.ts', 'src/test/live/messaging-recovery.live.browser.ts'],
    env: {
      NEXT_PUBLIC_APP_VERSION: '0.0.0-live',
    },
    testTimeout: 240_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
