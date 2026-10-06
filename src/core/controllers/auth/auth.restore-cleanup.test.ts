import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApplication } from '@/application/auth/auth';
import { MUTE_SYNC_CURSOR_STORAGE_PREFIX } from '@/config/mute-sync';
import { AuthController } from '@/controllers/auth/auth';
import { resetAuthFinalizationLockForTests, withAuthFinalizationLock } from '@/controllers/auth/auth-finalization-lock';
import { db } from '@/database/franky/franky';
import { IDENTITY_SCOPED_DEVICE_TABLES, PUBLIC_CACHE_TABLES } from '@/database/franky/franky.helpers';
import {
  dropCachedWrappingKeyForTests,
  getOrCreateWrappingKey,
  resetMessagingKeyringForTests,
} from '@/libs/crypto/messaging-keyring';
import { Identity } from '@/libs/identity/identity';
import * as vibeSessionAutoRestore from '@/libs/vibe-session/auto-restore';
import * as vibeSessionConfig from '@/libs/vibe-session/config';
import * as vibeSessionFragment from '@/libs/vibe-session/fragment';
import type { Pubky } from '@/models/models.types';
import { ROUTE_GUARD_RETURN_TO_STORAGE_KEY } from '@/providers/RouteGuardProvider/RouteGuardProvider.returnPath';
import { AUTH_FLOW_CANCELED_ERROR_NAME } from '@/services/homeserver/error.utils';
import { LOCKS_FRONTEND_SESSION_STORAGE_KEY } from '@/services/locks/locks-frontend-session';
import { INVENTORY_SESSION_STORAGE_KEY } from '@/services/marketplace/marketplace-inventory-grant';
import { MARKETPLACE_SESSION_STORAGE_KEY } from '@/services/marketplace/marketplace-session';
import { MESSAGING_SESSION_STORAGE_KEY } from '@/services/paykit/paykit-messaging';
import { readPersistedAuthIdentity, readPersistedAuthPubky } from '@/stores/auth/auth.persisted';
import { createAuthStore, useAuthStore } from '@/stores/auth/auth.store';
import { useOnboardingStore } from '@/stores/onboarding/onboarding.store';
import { AUTH_PERSIST_KEY, ONBOARDING_PERSIST_KEY } from '@/stores/persistedKeys';
import { mockKeypair, mockSession } from '@/test-utils/pubky';

const BRIDGE_ORIGIN = 'https://pubky.app';
const PERSISTED_PUBKY = '5a1diz4pghi47ywdfyfzpit5f3bdomzt4pugpbmq4rngdd4iub4y' as Pubky;
const ACCOUNT_B = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo' as Pubky;
const ACCOUNT_B_BOOKMARK = 'account-b:bookmark';
const ACCOUNT_B_LOCKS = 'account-b:locks-correlation';

const EXPECTED_PUBLIC_CACHE_TABLES = [
  'user_counts',
  'user_details',
  'user_ttl',
  'post_counts',
  'post_details',
  'post_relationships',
  'post_ttl',
  'file_details',
  'tag_streams',
  'commerce_shops',
  'commerce_listings',
  'commerce_catalog_entries',
  'commerce_listing_projections',
] as const;

const EXPECTED_PRIVATE_TABLES = [
  'user_relationships',
  'user_tags',
  'user_connections',
  'notifications',
  'post_tags',
  'post_streams',
  'unread_post_streams',
  'user_streams',
  'bookmarks',
  'commerce_listing_drafts',
  'commerce_import_manifests',
  'commerce_import_mappings',
  'commerce_import_rows',
  'commerce_webhooks',
  'commerce_sync_jobs',
  'commerce_reviews',
  'commerce_review_responses',
  'commerce_favorites',
  'commerce_shop_follows',
  'commerce_cart_items',
  'commerce_locks_correlations',
  'commerce_watch_snapshots',
  'commerce_watch_tombstones',
  'commerce_watch_alerts',
  'commerce_saved_searches',
  'commerce_activity_checkpoints',
  'commerce_shipping_presets',
  'commerce_messaging_receivers',
  'commerce_messaging_links',
  'commerce_messaging_conversations',
  'commerce_messaging_messages',
  'commerce_messaging_outbox',
  'commerce_messaging_unprocessed',
  'marketplace_tags',
  'hot_tags',
  'feeds',
  'moderation',
] as const;

const EXPECTED_IDENTITY_SCOPED_DEVICE_TABLES = ['commerce_delivery_addresses'] as const;

const sorted = (values: Iterable<string>) => [...values].sort();
const EXPECTED_TABLE_COUNT =
  EXPECTED_PUBLIC_CACHE_TABLES.length + EXPECTED_PRIVATE_TABLES.length + EXPECTED_IDENTITY_SCOPED_DEVICE_TABLES.length;

async function seedEveryTable(): Promise<void> {
  for (const table of db.tables) {
    const keyPath = table.schema.primKey.keyPath;
    const seed = `restore-cleanup:${table.name}`;
    if (keyPath === 'id') {
      await db.table<{ id: string }>(table.name).put({ id: seed });
      continue;
    }
    if (typeof keyPath === 'string') {
      await db.table(table.name).put({ [keyPath]: seed });
      continue;
    }
    if (Array.isArray(keyPath) && keyPath.every((part) => typeof part === 'string')) {
      const record: Record<string, string> = {};
      for (const part of keyPath) {
        record[part] = `${seed}:${part}`;
      }
      await db.table(table.name).put(record);
      continue;
    }
    throw new Error(`unseeded primary key ${JSON.stringify(keyPath)} on ${table.name}`);
  }
}

async function expectTableCounts(tableNames: readonly string[], expectedCount: number): Promise<void> {
  await Promise.all(
    tableNames.map(async (tableName) => {
      expect(await db.table(tableName).count(), tableName).toBe(expectedCount);
    }),
  );
}

async function expectTableCountsAtLeast(tableNames: readonly string[], minCount: number): Promise<void> {
  await Promise.all(
    tableNames.map(async (tableName) => {
      expect(await db.table(tableName).count(), tableName).toBeGreaterThanOrEqual(minCount);
    }),
  );
}

const WRAPPING_PROBE_PLAINTEXT = 'restore-cleanup-wrapping-probe';

async function seedWrappingKeyProbe(): Promise<{ iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await getOrCreateWrappingKey();
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    new TextEncoder().encode(WRAPPING_PROBE_PLAINTEXT),
  );
  return { iv, ciphertext };
}

async function expectWrappingKeyProbeSurvives({
  iv,
  ciphertext,
}: {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}) {
  // Reload from IndexedDB (drop the in-memory cache): if the keyring store was
  // deleted, a FRESH key is generated here and the decrypt fails closed.
  dropCachedWrappingKeyForTests();
  const reloadedKey = await getOrCreateWrappingKey();
  const roundTrip = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, reloadedKey, ciphertext);
  expect(new TextDecoder().decode(roundTrip)).toBe(WRAPPING_PROBE_PLAINTEXT);
}

function holdAuthFinalizationLock(): {
  acquired: Promise<void>;
  release: () => void;
  held: Promise<void>;
} {
  let release!: () => void;
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = withAuthFinalizationLock(async () => {
    markAcquired();
    await gate;
  });
  return { acquired, release, held };
}

async function writeAccountBLocally(): Promise<void> {
  useAuthStore.getState().init({
    session: mockSession({ export: () => 'account-b-session-export' }),
    currentUserPubky: ACCOUNT_B,
    hasProfile: true,
  });
  await db.table('bookmarks').put({ id: ACCOUNT_B_BOOKMARK });
  await db.table('commerce_locks_correlations').put({ id: ACCOUNT_B_LOCKS });
}

async function persistAccountBUnderLock(): Promise<void> {
  await withAuthFinalizationLock(async () => {
    await writeAccountBLocally();
  });
}

/**
 * Tab B: a second persist-backed auth store sharing `AUTH_PERSIST_KEY` + Dexie.
 * Tab A's `useAuthStore` heap is left untouched (the production cross-tab gap).
 */
async function persistAccountBFromOtherTab(): Promise<ReturnType<typeof createAuthStore>> {
  const tabBStore = createAuthStore();
  await withAuthFinalizationLock(async () => {
    // Production identity switch clears the blob before writing a new pubky
    // (`persistIdentityUnderLock`). Reset here so the owner fence allows B
    // to take `AUTH_PERSIST_KEY` without mutating Tab A's live store.
    tabBStore.getState().reset();
    tabBStore.getState().init({
      session: mockSession({ export: () => 'account-b-session-export' }),
      currentUserPubky: ACCOUNT_B,
      hasProfile: true,
    });
    await db.table('bookmarks').put({ id: ACCOUNT_B_BOOKMARK });
    await db.table('commerce_locks_correlations').put({ id: ACCOUNT_B_LOCKS });
  });
  return tabBStore;
}

async function expectAccountBCrossTabStateSurvives(tabALivePubky: Pubky): Promise<void> {
  expect(await db.table('bookmarks').get(ACCOUNT_B_BOOKMARK)).toBeDefined();
  expect(await db.table('commerce_locks_correlations').get(ACCOUNT_B_LOCKS)).toBeDefined();
  expect(readPersistedAuthPubky()).toBe(ACCOUNT_B);
  expect(useAuthStore.getState().currentUserPubky).toBe(tabALivePubky);
  const raw = window.localStorage.getItem(AUTH_PERSIST_KEY);
  expect(raw).toEqual(expect.stringContaining(ACCOUNT_B));
}

async function expectAccountBPrivateRowsSurvive(): Promise<void> {
  expect(await db.table('bookmarks').get(ACCOUNT_B_BOOKMARK)).toBeDefined();
  expect(await db.table('commerce_locks_correlations').get(ACCOUNT_B_LOCKS)).toBeDefined();
  expect(useAuthStore.getState().currentUserPubky).toBe(ACCOUNT_B);
}

/**
 * A fake `navigator.locks` that actually queues exclusive requests — one
 * promise tail PER LOCK NAME, like the platform (nested requests on a
 * different name, e.g. the messaging keyring's own lock, must not deadlock).
 */
function installQueuingFakeLocks() {
  const tails = new Map<string, Promise<void>>();
  const request = vi.fn((...args: unknown[]) => {
    const name = args[0];
    const callback = args.find((arg): arg is () => Promise<unknown> => typeof arg === 'function');
    if (typeof name !== 'string' || !callback) {
      return Promise.reject(new Error('navigator.locks.request called without a name/callback'));
    }
    const run = (tails.get(name) ?? Promise.resolve()).then(() => callback());
    tails.set(
      name,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  });
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return request;
}

async function runRealBridgeTimeoutRestore(currentUserPubky: Pubky | null) {
  useAuthStore.setState({
    session: null,
    sessionExport: null,
    currentUserPubky,
    hasProfile: currentUserPubky ? true : null,
    hasHydrated: true,
    isRestoringSession: false,
    sessionRestoreDeferred: false,
  });

  vi.useFakeTimers();
  const restorePromise = AuthController.restorePersistedSession();
  vi.advanceTimersByTime(15_000);
  vi.useRealTimers();
  return await restorePromise;
}

describe('AuthController restore cleanup with the real bridge and database', () => {
  beforeEach(() => {
    AuthController.resetCleanupLocalStateGuard();
    resetAuthFinalizationLockForTests();
    useAuthStore.getState().reset();
    vi.spyOn(vibeSessionConfig, 'getVibeSessionBridgeOrigin').mockReturnValue(BRIDGE_ORIGIN);
    vi.spyOn(vibeSessionConfig, 'getVibeId').mockReturnValue('marketplace-grid-test');
    vi.spyOn(vibeSessionFragment, 'takeFragmentSessionExport').mockReturnValue(null);
    vi.spyOn(vibeSessionAutoRestore, 'isVibeSessionAutoRestoreSuppressed').mockReturnValue(false);
  });

  afterEach(async () => {
    vi.useRealTimers();
    useAuthStore.getState().reset();
    useOnboardingStore.getState().reset();
    await resetMessagingKeyringForTests();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Reflect.deleteProperty(navigator, 'locks');
    vi.restoreAllMocks();
  });

  it('classifies every Dexie store and clears private data after a no-identity bridge timeout', async () => {
    const expectedTables = [
      ...EXPECTED_PUBLIC_CACHE_TABLES,
      ...EXPECTED_PRIVATE_TABLES,
      ...EXPECTED_IDENTITY_SCOPED_DEVICE_TABLES,
    ];
    expect(db.tables).toHaveLength(EXPECTED_TABLE_COUNT);
    expect(sorted(db.tables.map((table) => table.name))).toEqual(sorted(expectedTables));
    expect(sorted(PUBLIC_CACHE_TABLES)).toEqual(sorted(EXPECTED_PUBLIC_CACHE_TABLES));
    expect(sorted(IDENTITY_SCOPED_DEVICE_TABLES)).toEqual(sorted(EXPECTED_IDENTITY_SCOPED_DEVICE_TABLES));
    await seedEveryTable();
    const createElementSpy = vi.spyOn(document, 'createElement');
    // Non-Dexie account residue the no-identity path must also clear: the live
    // marketplace bearer, the messaging session metadata, onboarding secrets,
    // a stored route-return path, and mute-sync stream cursors.
    window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, '{"token":"dead-bearer"}');
    window.localStorage.setItem(MESSAGING_SESSION_STORAGE_KEY, '{"pubky":"dead-messaging"}');
    useOnboardingStore.getState().setSecrets({ secretKey: 'dead-secret-key', mnemonic: 'dead mnemonic' });
    window.sessionStorage.setItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY, '/settings');
    window.sessionStorage.setItem(`${MUTE_SYNC_CURSOR_STORAGE_PREFIX}homeserver`, '42');
    expect(window.localStorage.getItem(ONBOARDING_PERSIST_KEY)).not.toBeNull();

    await expect(runRealBridgeTimeoutRestore(null)).resolves.toEqual({ status: 'signed-out' });

    expect(createElementSpy).toHaveBeenCalledWith('iframe');
    await expectTableCounts(EXPECTED_PRIVATE_TABLES, 0);
    await expectTableCounts(EXPECTED_PUBLIC_CACHE_TABLES, 1);
    await expectTableCounts(EXPECTED_IDENTITY_SCOPED_DEVICE_TABLES, 1);
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(MESSAGING_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(ONBOARDING_PERSIST_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(`${MUTE_SYNC_CURSOR_STORAGE_PREFIX}homeserver`)).toBeNull();
  });

  it('still clears every store after a bridge timeout with persisted identity provenance', async () => {
    await seedEveryTable();

    await expect(runRealBridgeTimeoutRestore(PERSISTED_PUBKY)).resolves.toEqual({ status: 'signed-out' });

    await expectTableCounts([...EXPECTED_PUBLIC_CACHE_TABLES, ...EXPECTED_PRIVATE_TABLES], 0);
    await expectTableCounts(EXPECTED_IDENTITY_SCOPED_DEVICE_TABLES, 1);
  });

  it('keeps private rows and the wrapping key when this tab signs in during the bridge window', async () => {
    await seedEveryTable();
    const probe = await seedWrappingKeyProbe();

    useAuthStore.setState({
      session: null,
      sessionExport: null,
      currentUserPubky: null,
      hasProfile: null,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
    });

    // setTimeout-only fakes: the bridge timeout is timer-driven, but the
    // fake-indexeddb event loop (setImmediate) must stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const restorePromise = AuthController.restorePersistedSession();
    // A QR sign-in completes on THIS tab while the bridge restore is still
    // waiting: the identity lands on the live store (and the persist blob)
    // before the bridge times out.
    useAuthStore.setState({ sessionExport: 'same-tab-session-export', currentUserPubky: PERSISTED_PUBKY });

    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    await expect(restorePromise).resolves.toEqual({ status: 'signed-out' });

    await expectTableCounts(EXPECTED_PRIVATE_TABLES, 1);
    await expectTableCounts(EXPECTED_PUBLIC_CACHE_TABLES, 1);
    await expectWrappingKeyProbeSurvives(probe);
  });

  it('does not wipe a concurrent tab sign-in when the bridge times out (cross-tab serialization)', async () => {
    installQueuingFakeLocks();
    await seedEveryTable();

    useAuthStore.setState({
      session: null,
      sessionExport: null,
      currentUserPubky: null,
      hasProfile: null,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Tab B: a visitor with no identity; captures the empty snapshot and its
    // bridge restore starts waiting (15 s).
    const tabBRestore = AuthController.restorePersistedSession();

    // Tab A: acquires the finalization lock and signs in — identity +
    // a private row + the messaging wrapping key, the same writes the real
    // sign-in path persists under the lock.
    const probe = await withAuthFinalizationLock(async () => {
      useAuthStore.getState().init({
        session: mockSession({ export: () => 'tab-a-session-export' }),
        currentUserPubky: PERSISTED_PUBKY,
        hasProfile: true,
      });
      await db.table('bookmarks').put({ id: 'tab-a:bookmark' });
      return await seedWrappingKeyProbe();
    });

    // Tab B's bridge times out; B enters the lock, re-reads identity, and
    // must NOT clear tab A's rows or key.
    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    await expect(tabBRestore).resolves.toEqual({ status: 'signed-out' });

    expect(await db.table('bookmarks').get('tab-a:bookmark')).toBeDefined();
    await expectTableCountsAtLeast(EXPECTED_PRIVATE_TABLES, 1);
    await expectTableCounts(EXPECTED_PUBLIC_CACHE_TABLES, 1);
    await expectWrappingKeyProbeSurvives(probe);
  });

  it('does not wipe a concurrent different-account sign-in after identityAtCapture=true restore failure', async () => {
    installQueuingFakeLocks();
    await seedEveryTable();

    useAuthStore.setState({
      session: null,
      sessionExport: null,
      currentUserPubky: PERSISTED_PUBKY,
      hasProfile: true,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const restoreA = AuthController.restorePersistedSession();

    await persistAccountBUnderLock();

    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    await expect(restoreA).resolves.toEqual({ status: 'signed-out' });

    await expectAccountBPrivateRowsSurvive();
    expect(useAuthStore.getState().isLoggingOut).toBe(false);
  });

  it('no-ops pre-ceremony Dexie clear when a different identity acquired the lock first', async () => {
    const request = installQueuingFakeLocks();
    await seedEveryTable();
    useAuthStore.setState({
      session: mockSession({ export: () => 'account-a-session-export' }),
      sessionExport: 'account-a-session-export',
      currentUserPubky: PERSISTED_PUBKY,
      hasProfile: true,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
    });

    vi.spyOn(Identity, 'keypairFromMnemonic').mockReturnValue(mockKeypair());
    const signInSpy = vi
      .spyOn(AuthApplication, 'signIn')
      .mockRejectedValue(new Error('sign-in must not run after a skipped clear'));

    const lock = holdAuthFinalizationLock();
    await lock.acquired;
    const loginPromise = AuthController.loginWithMnemonic({ mnemonic: 'test mnemonic phrase' });
    await vi.waitFor(() => expect(request.mock.calls.length).toBeGreaterThanOrEqual(2));
    await writeAccountBLocally();
    lock.release();
    await lock.held;

    await expect(loginPromise).resolves.toBe(false);
    expect(signInSpy).not.toHaveBeenCalled();
    await expectAccountBPrivateRowsSurvive();
  });

  it('aborts identity persist when a third account wrote under the lock after the ceremony clear', async () => {
    installQueuingFakeLocks();
    useAuthStore.setState({
      session: null,
      sessionExport: null,
      currentUserPubky: null,
      hasProfile: null,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
    });

    let resolveSignIn: ((value: { session: ReturnType<typeof mockSession> }) => void) | undefined;
    vi.spyOn(Identity, 'keypairFromMnemonic').mockReturnValue(mockKeypair());
    vi.spyOn(Identity, 'z32FromSession').mockReturnValue(PERSISTED_PUBKY);
    const signInSpy = vi.spyOn(AuthApplication, 'signIn').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignIn = resolve;
        }),
    );
    vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);

    const loginPromise = AuthController.loginWithMnemonic({ mnemonic: 'test mnemonic phrase' });
    await vi.waitFor(() => expect(signInSpy).toHaveBeenCalled());
    await persistAccountBUnderLock();
    expect(resolveSignIn).toBeDefined();
    resolveSignIn!({ session: mockSession({ export: () => 'account-a-session-export' }) });

    await expect(loginPromise).rejects.toMatchObject({ name: AUTH_FLOW_CANCELED_ERROR_NAME });
    await expectAccountBPrivateRowsSurvive();
    expect(AuthApplication.logout).toHaveBeenCalled();
  });

  it('does not wipe a concurrent different-account sign-in when logout cleanup acquires the lock', async () => {
    const request = installQueuingFakeLocks();
    await seedEveryTable();
    useAuthStore.setState({
      session: mockSession({ export: () => 'account-a-session-export' }),
      sessionExport: 'account-a-session-export',
      currentUserPubky: PERSISTED_PUBKY,
      hasProfile: true,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
      isLoggingOut: false,
    });

    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(false);
    vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);

    const lock = holdAuthFinalizationLock();
    await lock.acquired;
    const logoutPromise = AuthController.logout();
    await vi.waitFor(() => expect(request.mock.calls.length).toBeGreaterThanOrEqual(2));
    await writeAccountBLocally();
    lock.release();
    await lock.held;
    await logoutPromise;

    await expectAccountBPrivateRowsSurvive();
    expect(useAuthStore.getState().isLoggingOut).toBe(false);
  });

  it('does not wipe Tab B Dexie when Tab A live store stays A and AUTH_PERSIST_KEY is B', async () => {
    installQueuingFakeLocks();
    await seedEveryTable();

    useAuthStore.setState({
      session: null,
      sessionExport: null,
      currentUserPubky: PERSISTED_PUBKY,
      hasProfile: true,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
    });
    expect(useAuthStore.getState().currentUserPubky).toBe(PERSISTED_PUBKY);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const restoreA = AuthController.restorePersistedSession();

    const tabBStore = await persistAccountBFromOtherTab();
    expect(tabBStore.getState().currentUserPubky).toBe(ACCOUNT_B);
    expect(useAuthStore.getState().currentUserPubky).toBe(PERSISTED_PUBKY);
    expect(readPersistedAuthPubky()).toBe(ACCOUNT_B);

    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    await expect(restoreA).resolves.toEqual({ status: 'signed-out' });

    await expectAccountBCrossTabStateSurvives(PERSISTED_PUBKY);
    expect(useAuthStore.getState().isLoggingOut).toBe(false);
  });

  it('aborts Tab A persist when AUTH_PERSIST_KEY already holds Tab B', async () => {
    installQueuingFakeLocks();
    await seedEveryTable();

    useAuthStore.setState({
      session: null,
      sessionExport: 'account-a-session-export',
      currentUserPubky: PERSISTED_PUBKY,
      hasProfile: true,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
    });

    let resolveRestore: ((value: { status: 'restored'; session: ReturnType<typeof mockSession> }) => void) | undefined;
    vi.spyOn(AuthApplication, 'restorePersistedSession').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRestore = resolve;
        }),
    );
    vi.spyOn(Identity, 'z32FromSession').mockReturnValue(PERSISTED_PUBKY);

    const restoreA = AuthController.restorePersistedSession();
    await vi.waitFor(() => expect(resolveRestore).toBeDefined());

    const tabBStore = await persistAccountBFromOtherTab();
    expect(tabBStore.getState().currentUserPubky).toBe(ACCOUNT_B);
    expect(useAuthStore.getState().currentUserPubky).toBe(PERSISTED_PUBKY);

    resolveRestore!({ status: 'restored', session: mockSession({ export: () => 'account-a-session-export' }) });
    await expect(restoreA).resolves.toEqual({ status: 'signed-out' });

    await expectAccountBCrossTabStateSurvives(PERSISTED_PUBKY);
  });

  it('sign-out removes the same account’s newer session another tab saved, so a reload stays signed out', async () => {
    installQueuingFakeLocks();
    useAuthStore.getState().init({
      session: mockSession({ export: () => 'account-a-session-export' }),
      currentUserPubky: PERSISTED_PUBKY,
      hasProfile: true,
    });
    const tabB = createAuthStore();
    tabB.getState().init({
      session: mockSession({ export: () => 'account-a-newer-session-export' }),
      currentUserPubky: PERSISTED_PUBKY,
      hasProfile: true,
    });
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(false);
    vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
    vi.spyOn(AuthApplication, 'clearGrantSessions').mockResolvedValue(undefined);

    await AuthController.logout();

    expect(readPersistedAuthIdentity()).toEqual({ pubky: null, present: false });
  });

  it('sign-out leaves another account’s persisted session alone', async () => {
    installQueuingFakeLocks();
    useAuthStore.setState({
      session: mockSession({ export: () => 'account-a-session-export' }),
      sessionExport: 'account-a-session-export',
      currentUserPubky: PERSISTED_PUBKY,
      hasProfile: true,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
    });
    await persistAccountBFromOtherTab();
    vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(false);
    vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
    vi.spyOn(AuthApplication, 'clearGrantSessions').mockResolvedValue(undefined);

    await AuthController.logout();

    expect(readPersistedAuthPubky()).toBe(ACCOUNT_B);
  });

  it('a sign-in that replaces another account removes that account’s bearers at rest and keeps the new account’s', async () => {
    installQueuingFakeLocks();
    useAuthStore.getState().init({
      session: mockSession({ export: () => 'account-a-session-export' }),
      currentUserPubky: PERSISTED_PUBKY,
      hasProfile: true,
    });
    const departed = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({ token: 'A'.repeat(43), pubky: PERSISTED_PUBKY, ...extra });
    window.localStorage.setItem(INVENTORY_SESSION_STORAGE_KEY, departed({ expiresAt: '2099-01-01T00:00:00Z' }));
    window.localStorage.setItem(LOCKS_FRONTEND_SESSION_STORAGE_KEY, departed({ creator: `pubky${PERSISTED_PUBKY}` }));
    window.localStorage.setItem(
      MESSAGING_SESSION_STORAGE_KEY,
      JSON.stringify({ pubky: PERSISTED_PUBKY, exported: 'account-a-messaging-export' }),
    );
    const kept = JSON.stringify({ token: 'B'.repeat(43), pubky: ACCOUNT_B, expiresAt: '2099-01-01T00:00:00Z' });
    window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, kept);

    vi.spyOn(Identity, 'keypairFromMnemonic').mockReturnValue(mockKeypair());
    vi.spyOn(Identity, 'z32FromSession').mockReturnValue(ACCOUNT_B);
    vi.spyOn(AuthApplication, 'signIn').mockResolvedValue({
      session: mockSession({ export: () => 'account-b-session-export' }),
    } as Awaited<ReturnType<typeof AuthApplication.signIn>>);
    vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(false);

    await AuthController.loginWithMnemonic({ mnemonic: 'test mnemonic phrase' });

    expect(readPersistedAuthPubky()).toBe(ACCOUNT_B);
    expect(window.localStorage.getItem(INVENTORY_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(LOCKS_FRONTEND_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(MESSAGING_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBe(kept);
  });
});
