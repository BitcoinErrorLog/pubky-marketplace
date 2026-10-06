import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Live project for the FCFS drops proof (ADR 0026 D1): the DEPLOYED staging
 * stack end to end — the real staging homeserver over the public pkarr
 * relays, the deployed Railway transaction service (running with
 * SANDBOX_PAYMENTS_ENABLED=true so the buyer-driven sandbox payment path can
 * stand in for a real rail on staging only), and the dedicated
 * marketplace-indexing Nexus.
 *
 * Node environment (the Pubky SDK's Node build loads its WASM from disk)
 * with the REAL global fetch, and excluded from every gate — it consumes
 * single-use staging signup tokens (or saved identity secrets) and races
 * real inventory. Invoked explicitly:
 *
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_SELLER=XXXX-XXXX-XXXX \
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_BUYER_A=YYYY-YYYY-YYYY \
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_BUYER_B=ZZZZ-ZZZZ-ZZZZ \
 *   MARKETPLACE_STAGING_DROP_IDENTITIES_FILE=/path/outside/the/repo.json \
 *   npm run test:marketplace:drops
 *
 * On the first successful signup the harness persists the three identities'
 * secret hexes to MARKETPLACE_STAGING_DROP_IDENTITIES_FILE (a path OUTSIDE
 * the repo, supplied at run time); re-runs sign back in with those saved
 * secrets so tokens are not burned. Tokens, secrets, and that file path are
 * never committed anywhere in this repo.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: 'listing-sync-probe-live',
    environment: 'node',
    include: ['src/test/live/listing-sync-probe.live.ts'],
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
