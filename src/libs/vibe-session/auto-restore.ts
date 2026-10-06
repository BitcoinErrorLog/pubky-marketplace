import { AUTH_ROUTES } from '@/app/routes';

export const VIBE_SESSION_AUTO_RESTORE_SUPPRESSED_KEY = 'pubky.vibeSession.autoRestoreSuppressed';

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } catch {
    return undefined;
  }
}

/** Disable the bridge leg of consumer auto-restore for the rest of this tab. */
export function suppressVibeSessionAutoRestore(): void {
  try {
    sessionStorageOrUndefined()?.setItem(VIBE_SESSION_AUTO_RESTORE_SUPPRESSED_KEY, '1');
  } catch {
    // Best-effort: Safari private-mode quota and storage-disabled policies throw on write.
  }
}

/** Clear suppression after a successful sign-in or restore (`authStore.init`). */
export function clearVibeSessionAutoRestoreSuppressed(): void {
  try {
    sessionStorageOrUndefined()?.removeItem(VIBE_SESSION_AUTO_RESTORE_SUPPRESSED_KEY);
  } catch {
    // Best-effort: same as setItem — must not reject logout or sign-in.
  }
}

export function isVibeSessionAutoRestoreSuppressed(): boolean {
  try {
    return sessionStorageOrUndefined()?.getItem(VIBE_SESSION_AUTO_RESTORE_SUPPRESSED_KEY) === '1';
  } catch {
    // Best-effort: a storage-disabled context can expose sessionStorage but throw on getItem.
    return false;
  }
}

function isOnSignInRoute(): boolean {
  const pathname = (globalThis as { location?: Location }).location?.pathname;
  if (!pathname) {
    return false;
  }
  return pathname.replace(/\/+$/, '') === AUTH_ROUTES.SIGN_IN;
}

/**
 * The bridge leg is skipped when suppressed for this tab, or on the sign-in
 * page: the sign-in QR is only minted once restore settles, and the bridge
 * iframe's load + reply timeouts (up to 6 s) would hold it behind a spinner.
 * Persisted-export and `#s=` fragment restores are not affected.
 */
export function isVibeSessionBridgeLegSkipped(): boolean {
  return isVibeSessionAutoRestoreSuppressed() || isOnSignInRoute();
}
