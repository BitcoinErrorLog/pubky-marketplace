import { playwright } from '@vitest/browser-playwright';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * One-sided live messaging proof against a REAL user on the staging network
 * (see src/test/live/dm-to-user.live.browser.ts). Phase 1 is
 * scripts/probe-dm-offer.mjs, which creates the identity, publishes a
 * profile, and makes a real offer on the target's listing so their inbox
 * sync will answer the handshake.
 *
 *   PAYKIT_DM_SECRET=<hex from phase 1> \
 *   PAYKIT_DM_TARGET=<target z32 pubky> \
 *   PAYKIT_DM_LISTING=<listing id> \
 *   npm run test:marketplace:dm
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  define: {
    'process.env': JSON.stringify({ NODE_ENV: 'test', NEXT_PUBLIC_APP_VERSION: '0.0.0-live' }),
    __DM_SECRET_HEX__: JSON.stringify(process.env.PAYKIT_DM_SECRET ?? ''),
    __DM_TARGET_PUBKY__: JSON.stringify(process.env.PAYKIT_DM_TARGET ?? ''),
    __DM_NOISE_HEX__: JSON.stringify(process.env.PAYKIT_DM_NOISE ?? ''),
  },
  test: {
    name: 'marketplace-dm-live',
    include: ['src/test/live/dm-to-user.live.browser.ts'],
    env: {
      NEXT_PUBLIC_APP_VERSION: '0.0.0-live',
    },
    testTimeout: 720_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
