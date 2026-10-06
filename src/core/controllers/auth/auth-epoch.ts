/**
 * Cross-tab sign-out fence for grant sessions.
 *
 * `authEpoch` is bumped inside the auth finalization lock on every sign-out.
 * A grant sign-in captures it when its QR starts and saves the session to
 * BrowserSessionStore only if the epoch is unchanged inside the same lock, so
 * a tab that signed out cannot have its key put back by another tab.
 */
export const AUTH_EPOCH_KEY = 'pubky-auth-epoch-v1';
export const AUTH_CHANNEL_NAME = 'pubky-auth-v1';

type AuthChannelMessage = { type: 'signed-out' };

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readAuthEpoch(): number {
  const raw = storage()?.getItem(AUTH_EPOCH_KEY);
  const value = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Call only inside the auth finalization lock. */
export function bumpAuthEpoch(): number {
  const next = readAuthEpoch() + 1;
  storage()?.setItem(AUTH_EPOCH_KEY, String(next));
  return next;
}

export function broadcastSignedOut(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
  channel.postMessage({ type: 'signed-out' } satisfies AuthChannelMessage);
  channel.close();
}

export function subscribeSignedOut(onSignedOut: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<AuthChannelMessage>) => {
    if (event.data?.type === 'signed-out') onSignedOut();
  };
  return () => channel.close();
}
