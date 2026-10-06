/**
 * Durable obligation to remove grant keys that a failed save left in
 * BrowserSessionStore. Set before the cleanup is attempted and cleared only
 * once the store reads back empty, so a cleanup that fails (or a tab that
 * closes mid-cleanup) is retried on the next load, the next Bitkit sign-in,
 * or the next sign-out. Origin-scoped like the store it guards; not an
 * account-owned key, so account cleanup must not drop it.
 */
export const GRANT_KEY_CLEANUP_PENDING_KEY = 'pubky-grant-key-cleanup-pending-v1';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function markGrantKeyCleanupPending(): void {
  try {
    storage()?.setItem(GRANT_KEY_CLEANUP_PENDING_KEY, '1');
  } catch {
    // Storage full or disabled: the cleanup below still runs this once.
  }
}

export function isGrantKeyCleanupPending(): boolean {
  try {
    return storage()?.getItem(GRANT_KEY_CLEANUP_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearGrantKeyCleanupPending(): void {
  try {
    storage()?.removeItem(GRANT_KEY_CLEANUP_PENDING_KEY);
  } catch {
    // Unreadable storage cannot hold the marker either.
  }
}
