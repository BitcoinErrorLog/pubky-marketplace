import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Live end-to-end project for the real Locks/Paykit payment leg
 * (`locks-paykit` mode, plan tasks 4.6–4.8 verification).
 *
 * This is NOT a unit or transport suite: it drives a real purchase through
 * the composed payments environment (Lock Server, Paykit Server, Bitcoin
 * regtest, pinned Pubky testnet — see `docs/ecommerce/RUNNING.md`, "Running a
 * real Locks/Paykit payment") plus the durable transaction service running
 * with Locks verification enabled. It orchestrates the environment's own
 * wallet-simulation tooling (`paykit-companion-auth`, `paykit-reader-demo`,
 * the regtest node) over docker compose, and exercises the client's own
 * services for every marketplace-side step. Nothing is mocked; a missing
 * dependency FAILS with setup instructions rather than skipping.
 *
 *   npm run test:marketplace:locks
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: 'marketplace-locks-live',
    environment: 'node',
    include: ['src/test/live/**/*.live.ts'],
    testTimeout: 600_000,
    hookTimeout: 300_000,
  },
});
