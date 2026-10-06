import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearVibeSessionAutoRestoreSuppressed, suppressVibeSessionAutoRestore } from './auto-restore';
import * as vibeSessionConfig from './config';
import { resetFragmentSessionExportCache } from './fragment';
import { shouldAttemptSessionRestore } from './should-restore';

afterEach(() => {
  window.history.replaceState(null, '', '/');
  resetFragmentSessionExportCache();
  clearVibeSessionAutoRestoreSuppressed();
  vi.restoreAllMocks();
});

describe('shouldAttemptSessionRestore', () => {
  it('is true when a persisted export is present', () => {
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(false);
    suppressVibeSessionAutoRestore();
    expect(shouldAttemptSessionRestore('session-export')).toBe(true);
  });

  it('is true when consumer mode is on and auto-restore is not suppressed', () => {
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
    expect(shouldAttemptSessionRestore(null)).toBe(true);
  });

  it('is false when consumer restore is suppressed and nothing is persisted or pending', () => {
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
    suppressVibeSessionAutoRestore();
    expect(shouldAttemptSessionRestore(null)).toBe(false);
  });

  it('is true when consumer restore is suppressed but a #s= fragment is pending', () => {
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
    suppressVibeSessionAutoRestore();
    window.history.replaceState(null, '', '/#s=pending-session-export');
    expect(shouldAttemptSessionRestore(null)).toBe(true);
  });

  it('is false when a suppressed consumer has only a stale (TTL-expired) #s= fragment', () => {
    vi.useFakeTimers();
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
    suppressVibeSessionAutoRestore();
    window.history.replaceState(null, '', '/#s=pending-session-export');
    expect(shouldAttemptSessionRestore(null)).toBe(true);

    vi.advanceTimersByTime(61_000);

    // A later same-tab logout must not resurrect the hours-old hand-off.
    expect(shouldAttemptSessionRestore(null)).toBe(false);
    vi.useRealTimers();
  });

  it('is false on the sign-in page for a consumer with nothing persisted or pending', () => {
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
    window.history.replaceState(null, '', '/sign-in');
    expect(shouldAttemptSessionRestore(null)).toBe(false);
  });

  it('still restores a persisted export on the sign-in page', () => {
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
    window.history.replaceState(null, '', '/sign-in');
    expect(shouldAttemptSessionRestore('session-export')).toBe(true);
  });

  it('still restores a pending #s= fragment on the sign-in page', () => {
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
    window.history.replaceState(null, '', '/sign-in#s=pending-session-export');
    expect(shouldAttemptSessionRestore(null)).toBe(true);
  });

  it('is false when consumer mode is off and nothing is persisted', () => {
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(false);
    expect(shouldAttemptSessionRestore(null)).toBe(false);
    expect(shouldAttemptSessionRestore(undefined)).toBe(false);
  });
});
