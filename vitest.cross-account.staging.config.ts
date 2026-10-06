import { playwright } from '@vitest/browser-playwright';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * Live CROSS-ACCOUNT marketplace proof against the REAL staging homeserver
 * (ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy) reached through the
 * public pkarr relays — the exact topology of the deployed app.
 *
 * Why this suite exists: the serialized-nulls bug (every published listing
 * unloadable by anyone except its cached seller) shipped because no test ever
 * viewed a listing as a STRANGER. This suite makes the stranger perspective a
 * first-class journey: identity A publishes through the real create path,
 * identity B — a fresh account with an empty local cache — loads it through
 * the real read path (`getOrFetchListing` → normalizer) plus A's shop page
 * data.
 *
 * The staging homeserver requires single-use signup tokens, so this suite is
 * NOT a standing gate: it consumes the tokens you pass in. Generate tokens
 * from the staging admin endpoint (see docs/ecommerce/RUNNING.md — the admin
 * password is NOT committed anywhere in this repo), then:
 *
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_A=XXXX-XXXX-XXXX \
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_B=YYYY-YYYY-YYYY \
 *   npm run test:marketplace:cross-account
 *
 * If a run fails after signup succeeded (tokens consumed), re-run by signing
 * back in with the identity secrets the harness printed:
 *
 *   MARKETPLACE_STAGING_SECRET_A=<hex> MARKETPLACE_STAGING_SECRET_B=<hex> \
 *   npm run test:marketplace:cross-account
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  define: {
    // The Chromium page has no `process` global (Next.js normally injects it);
    // inline the env the imported app modules read at module scope. NODE_ENV
    // 'test' keeps the runtime config on its lenient parse, which resolves to
    // the canonical staging network defaults.
    'process.env': JSON.stringify({ NODE_ENV: 'test', NEXT_PUBLIC_APP_VERSION: '0.0.0-live' }),
    // Single-use credentials are injected at config-eval time (node side);
    // they never enter the committed source.
    __STAGING_SIGNUP_TOKEN_A__: JSON.stringify(process.env.MARKETPLACE_STAGING_SIGNUP_TOKEN_A ?? ''),
    __STAGING_SIGNUP_TOKEN_B__: JSON.stringify(process.env.MARKETPLACE_STAGING_SIGNUP_TOKEN_B ?? ''),
    __STAGING_SECRET_A__: JSON.stringify(process.env.MARKETPLACE_STAGING_SECRET_A ?? ''),
    __STAGING_SECRET_B__: JSON.stringify(process.env.MARKETPLACE_STAGING_SECRET_B ?? ''),
  },
  test: {
    name: 'marketplace-cross-account-staging-live',
    include: ['src/test/live/marketplace-cross-account.live.browser.ts'],
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
