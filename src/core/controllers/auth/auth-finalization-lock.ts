export const AUTH_FINALIZATION_LOCK_NAME = 'pubky-auth-finalization-v1';

let fallbackTail: Promise<void> = Promise.resolve();

function withInProcessLock<T>(callback: () => Promise<T>): Promise<T> {
  const run = fallbackTail.then(callback, callback);
  fallbackTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test-only: drop a poisoned in-process tail left by a hanging lock holder. */
export function resetAuthFinalizationLockForTests(): void {
  fallbackTail = Promise.resolve();
}

/**
 * Exclusive lock for Dexie wipe and identity persist.
 * Prefers `navigator.locks` (`pubky-auth-finalization-v1`) which is
 * origin-scoped and cross-tab. Falls back to an in-process promise tail only
 * when Web Locks are missing or `request` throws before the callback starts.
 */
export async function withAuthFinalizationLock<T>(callback: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks && typeof locks.request === 'function') {
    let callbackStarted = false;
    try {
      return await locks.request(AUTH_FINALIZATION_LOCK_NAME, { mode: 'exclusive' }, async () => {
        callbackStarted = true;
        return await callback();
      });
    } catch (error) {
      if (callbackStarted) {
        throw error;
      }
    }
  }

  return await withInProcessLock(callback);
}
