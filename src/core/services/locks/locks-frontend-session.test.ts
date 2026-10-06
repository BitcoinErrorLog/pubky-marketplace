import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocksGatewayService } from './locks';
import {
  LOCKS_FRONTEND_SESSION_STORAGE_KEY,
  locksCreatorMatchesShopPubky,
  LocksFrontendSessionStore,
} from './locks-frontend-session';

const PUBKY = 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco';
const OTHER = 'ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u';
const RECORD = {
  token: 'locks-frontend-session-token',
  creator: `pubky${PUBKY}`,
  pubky: PUBKY,
};

const NEWER = { ...RECORD, token: 'locks-frontend-session-token-from-another-tab' };

function stored(): string | null {
  return window.localStorage.getItem(LOCKS_FRONTEND_SESSION_STORAGE_KEY);
}

beforeAll(async () => {
  // The application graph is large; its first transform must not count against one test's timeout.
  await import('@/application/commerce/commerce');
}, 60_000);

afterEach(() => {
  LocksFrontendSessionStore.clearForSignOut();
  vi.restoreAllMocks();
});

describe('LocksFrontendSessionStore', () => {
  it('restores a saved session for the matching Shop account and leaves another account’s in place', () => {
    LocksFrontendSessionStore.save(RECORD);

    expect(LocksFrontendSessionStore.restore(PUBKY)).toEqual(RECORD);
    expect(LocksFrontendSessionStore.restore(OTHER)).toBeNull();
    expect(LocksFrontendSessionStore.restore(PUBKY)).toEqual(RECORD);
  });

  it('a clear for the token a check read keeps the newer session another tab saved', () => {
    LocksFrontendSessionStore.save(RECORD);
    LocksFrontendSessionStore.save(NEWER);

    LocksFrontendSessionStore.clear(RECORD.token);

    expect(LocksFrontendSessionStore.restore(PUBKY)).toEqual(NEWER);
  });

  it('a clear for the stored token removes it', () => {
    LocksFrontendSessionStore.save(RECORD);
    LocksFrontendSessionStore.clear(RECORD.token);
    expect(stored()).toBeNull();
  });

  it('a purchase-session clear that is not a sign-out keeps the Lock Server session', async () => {
    LocksFrontendSessionStore.save(RECORD);
    const { CommerceApplication } = await import('@/application/commerce/commerce');
    CommerceApplication.clearMarketplaceSession();
    expect(LocksFrontendSessionStore.restore(PUBKY)).toEqual(RECORD);
  });

  it('drops a malformed blob instead of treating it as connected', () => {
    window.localStorage.setItem(LOCKS_FRONTEND_SESSION_STORAGE_KEY, '{"token":"x"}');
    expect(LocksFrontendSessionStore.restore(PUBKY)).toBeNull();
    expect(window.localStorage.getItem(LOCKS_FRONTEND_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('refuses to persist a record whose pubky is not a Shop identity', () => {
    LocksFrontendSessionStore.save({ ...RECORD, pubky: 'not-a-pubky' });
    expect(window.localStorage.getItem(LOCKS_FRONTEND_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('sign-out teardown wipes the stored bearer, whichever tab saved it', async () => {
    LocksFrontendSessionStore.save(NEWER);
    const { CommerceApplication } = await import('@/application/commerce/commerce');
    CommerceApplication.clearMarketplaceSessionForSignOut();
    expect(stored()).toBeNull();
    expect(LocksFrontendSessionStore.restore(PUBKY)).toBeNull();
  });

  it('refuses to persist a Lock Server creator that is not the Shop pubky', () => {
    LocksFrontendSessionStore.save({ ...RECORD, creator: `pubky${OTHER}` });
    expect(window.localStorage.getItem(LOCKS_FRONTEND_SESSION_STORAGE_KEY)).toBeNull();
    expect(locksCreatorMatchesShopPubky(`pubky${OTHER}`, PUBKY)).toBe(false);
  });

  it('clears a stale blob whose creator is not the signed-in Shop pubky', () => {
    window.localStorage.setItem(
      LOCKS_FRONTEND_SESSION_STORAGE_KEY,
      JSON.stringify({ ...RECORD, creator: `pubky${OTHER}` }),
    );
    expect(LocksFrontendSessionStore.restore(PUBKY)).toBeNull();
    expect(window.localStorage.getItem(LOCKS_FRONTEND_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('persists a matching creator and never lets a foreign one replace or clear it', async () => {
    const { CommerceApplication } = await import('@/application/commerce/commerce');
    const create = vi.spyOn(LocksGatewayService, 'createFrontendSession');
    create.mockResolvedValueOnce({
      session_token: 'locks-frontend-session-token',
      creator: `pubky${PUBKY}`,
    });
    await CommerceApplication.createLocksFrontendSession('code', 'state', PUBKY);
    expect(LocksFrontendSessionStore.restore(PUBKY)).toEqual(RECORD);

    create.mockResolvedValueOnce({
      session_token: 'foreign-token',
      creator: `pubky${OTHER}`,
    });
    await CommerceApplication.createLocksFrontendSession('code', 'state', PUBKY);
    expect(LocksFrontendSessionStore.restore(PUBKY)).toEqual(RECORD);
    create.mockRestore();
  });
});
