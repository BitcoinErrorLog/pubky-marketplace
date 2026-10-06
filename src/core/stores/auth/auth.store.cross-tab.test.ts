import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { THomeserverSessionResult } from '@/services/homeserver/homeserver.types';
import { asOpaque } from '@/test-utils/type-assertions';
import { AUTH_PERSIST_KEY } from '../persistedKeys';
import { clearPersistedAuthIdentity } from './auth.persisted';
import { createAuthStore } from './auth.store';

vi.mock('@/libs/logger/logger', () => ({
  Logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ACCOUNT = '5a1diz4pghi47ywdfyfzpit5f3bdomzt4pugpbmq4rngdd4iub4y';
const OTHER_ACCOUNT = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo';

type Session = THomeserverSessionResult['session'];

function ringSession(pubky: string, exported: string): Session {
  return asOpaque<Session>({ info: { publicKey: { z32: () => pubky } }, grant: undefined, export: () => exported });
}

function bitkitSession(pubky: string): Session {
  return asOpaque<Session>({ info: { publicKey: { z32: () => pubky } }, grant: {}, export: () => 'never' });
}

type PersistedState = { currentUserPubky?: unknown; sessionExport?: unknown; grantSessionRecordId?: unknown };

function persisted(): PersistedState | null {
  const raw = window.localStorage.getItem(AUTH_PERSIST_KEY);
  return raw === null ? null : ((JSON.parse(raw) as { state: PersistedState }).state ?? null);
}

/** A tab: its own store instance, hydrated from the shared `localStorage` when it opens. */
function openTab() {
  return createAuthStore();
}

function signInWithRing(tab: ReturnType<typeof openTab>, pubky: string, exported: string) {
  tab.getState().init({ session: ringSession(pubky, exported), currentUserPubky: pubky, hasProfile: true });
}

describe('auth persist: a tab never overwrites or clears a session it does not own', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('a signed-out tab’s flag write keeps the Ring session another tab saved', () => {
    const visitor = openTab();
    const signedIn = openTab();
    signInWithRing(signedIn, ACCOUNT, 'ring-export');

    visitor.getState().setShowSignInDialog(true);
    visitor.getState().setIsRestoringSession(false);

    expect(persisted()).toMatchObject({ currentUserPubky: ACCOUNT, sessionExport: 'ring-export' });
  });

  it('a signed-out tab’s flag write keeps the Bitkit grant record another tab saved', () => {
    const visitor = openTab();
    const signedIn = openTab();
    signedIn.getState().init({
      session: bitkitSession(ACCOUNT),
      currentUserPubky: ACCOUNT,
      hasProfile: true,
      grantSessionRecordId: 'grant-record-b',
    });

    visitor.getState().setIsLoggingOut(false);

    expect(persisted()).toMatchObject({ currentUserPubky: ACCOUNT, grantSessionRecordId: 'grant-record-b' });
  });

  it('a stale tab of the same account cannot put its older session back over a newer sign-in', () => {
    const stale = openTab();
    signInWithRing(stale, ACCOUNT, 'ring-export-1');
    const fresh = openTab();
    signInWithRing(fresh, ACCOUNT, 'ring-export-2');

    stale.getState().setHasProfile(true);

    expect(persisted()).toMatchObject({ currentUserPubky: ACCOUNT, sessionExport: 'ring-export-2' });
  });

  it('a stale tab’s sign-out reset keeps the newer sign-in another tab saved', () => {
    const stale = openTab();
    signInWithRing(stale, ACCOUNT, 'ring-export-1');
    const fresh = openTab();
    signInWithRing(fresh, ACCOUNT, 'ring-export-2');

    stale.getState().reset();

    expect(persisted()).toMatchObject({ sessionExport: 'ring-export-2' });
  });

  it('a stale write never puts back a session another tab removed', () => {
    const stale = openTab();
    signInWithRing(stale, ACCOUNT, 'ring-export-1');
    clearPersistedAuthIdentity();

    stale.getState().setHasProfile(true);

    expect(persisted()).toBeNull();
  });

  it('a stale tab never blocks the account switch that removed its session', () => {
    const stale = openTab();
    signInWithRing(stale, ACCOUNT, 'ring-export-1');
    const switching = openTab();
    clearPersistedAuthIdentity();

    stale.getState().setShowSignInDialog(false);
    signInWithRing(switching, OTHER_ACCOUNT, 'other-export');

    expect(persisted()).toMatchObject({ currentUserPubky: OTHER_ACCOUNT, sessionExport: 'other-export' });
  });

  it('the tab that owns the session clears it on sign-out', () => {
    const tab = openTab();
    signInWithRing(tab, ACCOUNT, 'ring-export');
    tab.getState().reset();
    expect(persisted()).toMatchObject({ currentUserPubky: null, sessionExport: null, grantSessionRecordId: null });
  });

  it('two tabs restored from one session: either tab’s sign-out clears it', () => {
    const first = openTab();
    signInWithRing(first, ACCOUNT, 'ring-export');
    const second = openTab();

    second.getState().setHasProfile(true);
    expect(persisted()).toMatchObject({ sessionExport: 'ring-export' });

    second.getState().reset();
    expect(persisted()).toMatchObject({ currentUserPubky: null, sessionExport: null });
  });

  it('a fresh sign-in replaces the older session of the same account another tab saved', () => {
    const later = openTab();
    const earlier = openTab();
    signInWithRing(earlier, ACCOUNT, 'ring-export-1');

    signInWithRing(later, ACCOUNT, 'ring-export-2');

    expect(persisted()).toMatchObject({ sessionExport: 'ring-export-2' });
  });

  it('a sign-in never replaces another account’s saved session', () => {
    const other = openTab();
    const signedIn = openTab();
    signInWithRing(signedIn, ACCOUNT, 'ring-export');

    signInWithRing(other, OTHER_ACCOUNT, 'other-export');

    expect(persisted()).toMatchObject({ currentUserPubky: ACCOUNT, sessionExport: 'ring-export' });
  });
});
