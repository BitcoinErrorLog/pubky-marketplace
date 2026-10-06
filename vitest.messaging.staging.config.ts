import { playwright } from '@vitest/browser-playwright';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * Live two-party proof for encrypted marketplace messaging against the REAL
 * staging network: the official staging homeserver
 * (ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy) reached through the
 * public pkarr relays (https://pkarr.pubky.app, https://pkarr.pubky.org) —
 * the exact topology of the deployed app (PUBKY_RUNTIME_TESTNET=false).
 *
 * The staging homeserver requires single-use signup tokens, so this suite is
 * NOT a standing gate: it consumes the tokens you pass in. Run with:
 *
 *   PAYKIT_STAGING_SIGNUP_TOKEN_A=XXXX-XXXX-XXXX \
 *   PAYKIT_STAGING_SIGNUP_TOKEN_B=YYYY-YYYY-YYYY \
 *   npm run test:marketplace:messaging:staging
 *
 * If a run fails after signup succeeded (tokens consumed), re-run by signing
 * back in with the identity secrets the harness printed:
 *
 *   PAYKIT_STAGING_SECRET_A=<hex> PAYKIT_STAGING_SECRET_B=<hex> \
 *   npm run test:marketplace:messaging:staging
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  define: {
    // The Chromium page has no `process` global (Next.js normally injects it);
    // inline the env the imported app modules read at module scope.
    'process.env': JSON.stringify({ NODE_ENV: 'test', NEXT_PUBLIC_APP_VERSION: '0.0.0-live' }),
    // Single-use credentials are injected at config-eval time (node side);
    // they never enter the committed source.
    __STAGING_SIGNUP_TOKEN_A__: JSON.stringify(process.env.PAYKIT_STAGING_SIGNUP_TOKEN_A ?? ''),
    __STAGING_SIGNUP_TOKEN_B__: JSON.stringify(process.env.PAYKIT_STAGING_SIGNUP_TOKEN_B ?? ''),
    __STAGING_SECRET_A__: JSON.stringify(process.env.PAYKIT_STAGING_SECRET_A ?? ''),
    __STAGING_SECRET_B__: JSON.stringify(process.env.PAYKIT_STAGING_SECRET_B ?? ''),
  },
  test: {
    name: 'marketplace-messaging-staging-live',
    include: ['src/test/live/messaging-staging.live.browser.ts'],
    env: {
      NEXT_PUBLIC_APP_VERSION: '0.0.0-live',
    },
    testTimeout: 480_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
