export type CapturedAuthIdentity = {
  pubky: string | null;
  hadIdentity: boolean;
};

export type AuthIdentitySnapshot = {
  session?: unknown;
  sessionExport?: unknown;
  grantSessionRecordId?: unknown;
  currentUserPubky?: unknown;
};

export type PersistedAuthIdentityInput = {
  pubky: string | null;
  present: boolean;
};

export function nonEmptyPubky(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function identityPresent(live: AuthIdentitySnapshot, persistedIdentityPresent: boolean): boolean {
  return Boolean(
    live.session ||
    live.sessionExport ||
    live.grantSessionRecordId ||
    nonEmptyPubky(live.currentUserPubky) ||
    persistedIdentityPresent,
  );
}

/**
 * Snapshot of the identity that currently owns origin-scoped Dexie (`franky`).
 * Capture this *before* awaiting the auth-finalization lock so a concurrent
 * sign-in can be detected by re-reading inside the lock.
 */
export function captureAuthIdentityFromStore(
  live: AuthIdentitySnapshot,
  persistedIdentityPresent: boolean,
): CapturedAuthIdentity {
  const pubky = nonEmptyPubky(live.currentUserPubky);
  return {
    pubky,
    hadIdentity: identityPresent(live, persistedIdentityPresent),
  };
}

function ownerDiffersFromCapture(capturedPubky: string | null, ownerPubky: string | null): boolean {
  if (!ownerPubky) return false;
  if (!capturedPubky) return true;
  return ownerPubky !== capturedPubky;
}

/**
 * Destructive Dexie/store cleanup must no-op when a *different* identity now
 * owns local state. The persist blob (`AUTH_PERSIST_KEY`) is the cross-tab
 * source of truth — Zustand is per-tab and is not storage-event synced.
 * Anonymous captures skip if any identity appeared; known-pubky captures skip
 * when the persist blob or the live store holds a different pubky.
 */
export function shouldSkipDestructiveCleanup(
  captured: CapturedAuthIdentity,
  live: AuthIdentitySnapshot,
  persisted: PersistedAuthIdentityInput,
): boolean {
  const livePubky = nonEmptyPubky(live.currentUserPubky);
  if (!captured.hadIdentity) {
    return identityPresent(live, persisted.present);
  }
  if (ownerDiffersFromCapture(captured.pubky, persisted.pubky)) {
    return true;
  }
  if (ownerDiffersFromCapture(captured.pubky, livePubky)) {
    return true;
  }
  return false;
}

function ownerBlocksPersist(
  captured: CapturedAuthIdentity | null,
  newPubky: string,
  ownerPubky: string | null,
): boolean {
  if (!ownerPubky) return false;
  if (ownerPubky === newPubky) return false;
  if (captured?.pubky && ownerPubky === captured.pubky) return false;
  return true;
}

/**
 * Persist of `newPubky` must not overwrite a third identity that signed in
 * after this flow captured local state. The persist blob is checked first
 * (cross-tab); the live store covers same-tab. Replacing the captured pubky,
 * or writing into an empty store, is allowed.
 */
export function shouldAbortIdentityPersist(
  captured: CapturedAuthIdentity | null,
  newPubky: string,
  currentPubky: string | null,
  persistedPubky: string | null = null,
): boolean {
  return ownerBlocksPersist(captured, newPubky, persistedPubky) || ownerBlocksPersist(captured, newPubky, currentPubky);
}
