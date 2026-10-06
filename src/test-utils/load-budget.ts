import { configure, getConfig } from '@testing-library/react';
import { afterAll, beforeAll, vi } from 'vitest';

/** Per-test budget for suites that mount a whole marketplace studio. */
export const HEAVY_SUITE_TEST_TIMEOUT_MS = 60_000;

/** Budget for one `waitFor` / `findBy*` on those suites. */
export const HEAVY_SUITE_ASYNC_UTIL_TIMEOUT_MS = 20_000;

/**
 * Give the calling test file explicit time budgets sized for a shared machine.
 *
 * The marketplace studios (checkout, listing form, sell) mount hundreds of DOM
 * nodes, and every `getByRole` walks the accessibility tree of all of them.
 * A test that takes about a second alone takes five to ten when several test
 * runs share the CPU, which crosses Vitest's 5s test timeout and Testing
 * Library's 1s `waitFor`/`findBy*` default with no product change. Neither
 * default reflects a product timing requirement; they are wall-clock limits on
 * test work. Call this once at module scope of such a file.
 */
export function setHeavySuiteBudgets(): void {
  vi.setConfig({ testTimeout: HEAVY_SUITE_TEST_TIMEOUT_MS });

  let previousAsyncUtilTimeout = getConfig().asyncUtilTimeout;
  beforeAll(() => {
    previousAsyncUtilTimeout = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: HEAVY_SUITE_ASYNC_UTIL_TIMEOUT_MS });
  });
  afterAll(() => {
    configure({ asyncUtilTimeout: previousAsyncUtilTimeout });
  });
}
