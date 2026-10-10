import { act } from '@testing-library/react';
import type { Mock } from 'vitest';

/**
 * Runs `trigger` (a click handler) and reports whether `navigate` had already been called with
 * `url` by the time the handler returned, with no await, microtask or timer in between.
 *
 * iOS Safari only lets a frame navigate the top window, or hand a custom-scheme link such as
 * `pubkyauth://` to the OS, from inside the user-gesture task of the tap (about a second at most).
 * A deep link started after an await is silently dropped, so every signer hand-off must pass this.
 */
export function navigatesWithinGesture(navigate: Mock, url: string, trigger: () => void): boolean {
  navigate.mockClear();
  let navigatedBeforeReturn = false;
  act(() => {
    trigger();
    navigatedBeforeReturn = navigate.mock.calls.length === 1 && navigate.mock.calls[0]?.[0] === url;
  });
  return navigatedBeforeReturn;
}
