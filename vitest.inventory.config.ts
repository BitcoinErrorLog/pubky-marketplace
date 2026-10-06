import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Headless staging proof for Inventory Studio W1 (grant + one stock edit),
 * W4 (GET match, +1/−1, 409, 3-row result CSV), W2 (250-row CSV plan, mixed
 * 207, resume), and W3 (sessions, webhooks, inventory revoke). Excluded from
 * every merge gate. Files run in sequence because they share the seller
 * identity and Dexie shim. W4 does not revoke. W3 is last: it revokes the
 * inventory session.
 *
 *   MARKETPLACE_STAGING_DROP_IDENTITIES_FILE=/path/outside/the/repo.json \
 *   npm run test:marketplace:inventory
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: 'inventory-studio-live',
    environment: 'node',
    include: [
      'src/test/live/inventory-studio.live.ts',
      'src/test/live/inventory-w4.live.ts',
      'src/test/live/inventory-import.live.ts',
      'src/test/live/inventory-automations.live.ts',
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
