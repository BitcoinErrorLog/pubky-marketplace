import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Live staging proof for pickup_details.set (issue 51). Excluded from the
 * default unit gate. Invoked explicitly:
 *
 *   MARKETPLACE_STAGING_PICKUP_IDENTITIES_FILE=/path/outside/the/repo.json \
 *   npx vitest run --config vitest.pickup.config.ts
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: 'pickup-details-set-live',
    environment: 'node',
    include: ['src/test/live/pickup-details-set.live.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
