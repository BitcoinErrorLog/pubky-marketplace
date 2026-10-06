import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Integration project for the Marketplace Transaction Service transport.
 *
 * Deliberately separate from the unit config: it runs in Node (the Pubky SDK's
 * Node build loads its WASM from disk, and jsdom cannot), keeps the REAL global
 * fetch (the unit setup replaces it with a mock), and requires a running
 * service — so it is excluded from the unit gates and invoked explicitly:
 *
 *   npm run test:marketplace:service
 *
 * See docs/ecommerce/RUNNING.md ("Running against the durable transaction
 * service") for the service setup it expects.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: 'marketplace-service-integration',
    environment: 'node',
    include: ['src/test/integration/**/*.integration.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
