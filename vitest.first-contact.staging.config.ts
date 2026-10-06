import { readFileSync } from 'node:fs';
import { playwright } from '@vitest/browser-playwright';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * Live staging proof that a buyer's first message reaches a seller with more
 * followers than one Nexus page, with no conversation kept open on either
 * side (src/test/live/first-contact-discovery.live.browser.ts).
 *
 * It needs 24 throwaway staging seats, so it is NOT a standing gate. First
 * run, with 24 single-use signup tokens:
 *
 *   FC64_SIGNUP_TOKENS=AAAA-AAAA-AAAA,BBBB-BBBB-BBBB,... \
 *   npx vitest run --config vitest.first-contact.staging.config.ts
 *
 * The seat keys land in `.first-contact-out/seat-keys.json` (never printed).
 * Later runs sign back in with them; add FC64_FINAL_CLEANUP=1 to the last run
 * to delete every file the seats wrote:
 *
 *   FC64_SEAT_KEYS=.first-contact-out/seat-keys.json FC64_FINAL_CLEANUP=1 \
 *   npx vitest run --config vitest.first-contact.staging.config.ts
 */
const seatKeys = process.env.FC64_SEAT_KEYS ? JSON.parse(readFileSync(process.env.FC64_SEAT_KEYS, 'utf8')) : [];

export default defineConfig({
  plugins: [tsconfigPaths()],
  define: {
    'process.env': JSON.stringify({ NODE_ENV: 'test', NEXT_PUBLIC_APP_VERSION: '0.0.0-live' }),
    __SIGNUP_TOKENS__: JSON.stringify(
      (process.env.FC64_SIGNUP_TOKENS ?? '')
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean),
    ),
    __SEAT_KEYS__: JSON.stringify(seatKeys),
    __FINAL_CLEANUP__: JSON.stringify(process.env.FC64_FINAL_CLEANUP === '1'),
  },
  test: {
    name: 'first-contact-staging-live',
    include: ['src/test/live/first-contact-discovery.live.browser.ts'],
    env: { NEXT_PUBLIC_APP_VERSION: '0.0.0-live' },
    testTimeout: 1_500_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
