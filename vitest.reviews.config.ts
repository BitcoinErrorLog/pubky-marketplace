import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Live project for the trust & reputation loop: the real transaction service
 * (with a real attestor key), a real testnet homeserver, and a real local
 * Nexus indexing the published records.
 *
 * Node environment (the Pubky SDK's Node build loads its WASM from disk) with
 * the REAL global fetch, and excluded from every gate — it needs three live
 * processes. Invoked explicitly:
 *
 *   npm run test:marketplace:reviews
 *
 * See docs/ecommerce/RUNNING.md for the process invocations.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: 'marketplace-reviews-live',
    environment: 'node',
    include: ['src/test/live/reviews-index.live.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
