import { resetEmbeddedForTests } from '@/libs/embedded/embedded';

/**
 * Puts the current test page in or out of embedded mode through the `?embedded=1` URL
 * flag (the same signal a host page or a VRT scene uses). Call `setEmbedded(false)` in
 * `afterEach` to restore the default (top-level Shop).
 */
export function setEmbedded(embedded: boolean): void {
  window.history.replaceState(null, '', embedded ? '/?embedded=1' : '/');
  resetEmbeddedForTests();
}
