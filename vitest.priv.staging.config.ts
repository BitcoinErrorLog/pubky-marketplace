import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * Live proof for encrypted `/priv` (watchlist, receipts, badge checkpoints)
 * against the DEPLOYED staging stack: the real staging homeserver over the
 * public pkarr relays and the staging marketplace service releasing data
 * keys from `GET /v1/me/priv-keys` (with SANDBOX_PAYMENTS_ENABLED=true so a
 * paid order can carry a real staging receipt attestation).
 *
 * Node environment with the real global fetch; excluded from every gate. It
 * consumes two single-use staging signup tokens, or re-signs in with the
 * secrets persisted to a file outside the repo:
 *
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_SELLER=XXXX-XXXX-XXXX \
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_BUYER=YYYY-YYYY-YYYY \
 *   MARKETPLACE_STAGING_PRIV_IDENTITIES_FILE=/path/outside/the/repo.json \
 *   npm run test:marketplace:priv
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: 'marketplace-priv-live',
    environment: 'node',
    include: ['src/test/live/priv-encryption.live.ts'],
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
