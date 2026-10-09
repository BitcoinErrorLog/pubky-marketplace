import type { AuthToken, Session } from '@synonymdev/pubky';
import { LastReadResult } from 'pubky-app-specs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApplication } from '@/application/auth/auth';
import { BootstrapApplication } from '@/application/bootstrap/bootstrap';
import { CommerceApplication } from '@/application/commerce/commerce';
import { SettingsApplication } from '@/application/settings/settings';
import { postStreamQueue } from '@/application/stream/posts/muting/post-stream-queue';
import { CAPABILITIES, KEYED_CAPABILITIES, PRIV_KEYS_SCOPE_DECLINED } from '@/config/app';
import { MUTE_SYNC_CURSOR_STORAGE_PREFIX } from '@/config/mute-sync';
import { AUTH_EPOCH_KEY, bumpAuthEpoch, readAuthEpoch, subscribeSignedOut } from '@/controllers/auth/auth-epoch';
import { resetAuthFinalizationLockForTests } from '@/controllers/auth/auth-finalization-lock';
import {
  clearGrantKeyCleanupPending,
  isGrantKeyCleanupPending,
  markGrantKeyCleanupPending,
} from '@/controllers/auth/grant-key-cleanup';
import { CommerceController } from '@/controllers/commerce/commerce';
import { NotificationCoordinator } from '@/coordinators/notifications/notifications';
import { StreamCoordinator } from '@/coordinators/streams/stream';
import { TtlCoordinator } from '@/coordinators/ttl/ttl';
import { clearDatabase, clearPrivateData } from '@/database/franky/franky.helpers';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode, ServerErrorCode, ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { Identity } from '@/libs/identity/identity';
import { Logger } from '@/libs/logger/logger';
import * as vibeSessionAutoRestore from '@/libs/vibe-session/auto-restore';
import * as vibeSessionConfig from '@/libs/vibe-session/config';
import { CommerceCatalogEntryModel } from '@/models/commerce/commerce.models';
import type { Pubky } from '@/models/models.types';
import { NotificationType } from '@/models/notification/notification.types';
import { NotificationNormalizer } from '@/pipes/notification/notification.normalizer';
import { PubkySpecsSingleton } from '@/pipes/pipes.builder';
import { SettingsNormalizer } from '@/pipes/settings/settings.normalizer';
import { grantKeyRemovalFailed, isGrantKeyRemovalError } from '@/services/homeserver/error.utils';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { useAuthStore } from '@/stores/auth/auth.store';
import type { AuthStore } from '@/stores/auth/auth.types';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { useHomeStore } from '@/stores/home/home.store';
import { useHotStore } from '@/stores/hot/hot.store';
import { useLocalFilesStore } from '@/stores/localFiles/localFiles.store';
import { useMigrationStore } from '@/stores/migration/migration.store';
import { useNotificationStore } from '@/stores/notification/notification.store';
import type { NotificationState } from '@/stores/notification/notification.types';
import { useOnboardingStore } from '@/stores/onboarding/onboarding.store';
import { useSearchStore } from '@/stores/search/search.store';
import { useSessionHandoffStore } from '@/stores/sessionHandoff/sessionHandoff.store';
import { useSettingsStore } from '@/stores/settings/settings.store';
import {
  defaultNotificationPreferences,
  defaultPrivacyPreferences,
  type NotificationPreferences,
  type SettingsState,
} from '@/stores/settings/settings.types';
import { useSignInStore } from '@/stores/signIn/signIn.store';
import { createCommerceCatalogEntryFixture } from '@/test/fixtures/commerce/commerce';
import { mockSession as buildMockSession } from '@/test-utils/pubky';
import {
  mockAuthStore,
  mockHomeStore,
  mockHotStore,
  mockLocalFilesStore,
  mockMigrationStore,
  mockNotificationStore,
  mockOnboardingStore,
  mockSearchStore,
  mockSettingsStore,
  mockSignInStore,
} from '@/test-utils/stores';
import { asOpaque } from '@/test-utils/type-assertions';
import { AuthController } from './auth';

const TEST_SECRET_KEY = Buffer.from(new Uint8Array(32).fill(1)).toString('hex');
const TEST_PUBKY = '5a1diz4pghi47ywdfyfzpit5f3bdomzt4pugpbmq4rngdd4iub4y';
const MOCK_ALLOWED_TYPES = [NotificationType.Follow, NotificationType.Reply];

const spyOnSleep = async () => vi.spyOn(await import('@/libs/utils/utils'), 'sleep').mockResolvedValue(undefined);
const spyOnClearCookies = async () =>
  vi.spyOn(await import('@/libs/utils/utils'), 'clearCookies').mockImplementation(() => {});
const spyOnClearAllQueryClients = async () =>
  vi
    .spyOn(await import('@/libs/query-client/query-client.factory'), 'clearAllQueryClients')
    .mockImplementation(() => {});

const getLastReadUrl = (pubky: string) => `pubky://${pubky}/pub/pubky.app/last_read`;

const createMockSettingsState = (overrides?: Partial<SettingsState>): SettingsState => ({
  notifications: defaultNotificationPreferences,
  privacy: defaultPrivacyPreferences,
  muted: [],
  updatedAt: 0,
  version: 1,
  ...overrides,
});

const createMockKeypair = () =>
  asOpaque<import('@synonymdev/pubky').Keypair>({
    pubky: vi.fn(() => ({ z32: () => 'test-pubky' })),
    secret: vi.fn(() => new Uint8Array(32).fill(1)),
    // Matches the real Keypair shape: `publicKey` is a readonly property
    // (not a method) exposing `.z32()` / `.toString()`.
    publicKey: { z32: () => 'test-pubky', toString: () => 'pubkytest-pubky' },
    free: vi.fn(),
  });

const createMockEncryptedFile = () =>
  new File([new Uint8Array([1, 2, 3, 4, 5])], 'recovery.bin', { type: 'application/octet-stream' });

const setupOnboardingStore = () => {
  vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(
    mockOnboardingStore({
      secretKey: TEST_SECRET_KEY,
      reset: storeMocks.resetOnboardingStore,
    }),
  );
};

const setupNotificationMocks = () => {
  vi.spyOn(useNotificationStore, 'getState').mockReturnValue(
    mockNotificationStore({
      setState: storeMocks.notificationInit,
      reset: storeMocks.resetNotificationStore,
    }),
  );

  vi.spyOn(NotificationNormalizer, 'to').mockImplementation(
    (pubky: string) => ({ meta: { url: getLastReadUrl(pubky) } }) as LastReadResult,
  );

  // Settings sync is now handled in the controller (hydrateMeImAlive)
  vi.spyOn(SettingsApplication, 'initializeSettings').mockResolvedValue(null);
  vi.spyOn(NotificationNormalizer, 'toEnabledTypes').mockReturnValue(MOCK_ALLOWED_TYPES);
};

const setupAuthAndNotificationStores = () => {
  const authStore = storeMocks.getAuthState();
  vi.spyOn(useAuthStore, 'getState').mockReturnValue(mockAuthStore(authStore));
  vi.spyOn(useNotificationStore, 'getState').mockReturnValue(
    mockNotificationStore({
      setState: storeMocks.notificationInit,
      reset: storeMocks.resetNotificationStore,
    }),
  );
  // Settings sync is now handled in the controller (hydrateMeImAlive)
  vi.spyOn(SettingsApplication, 'initializeSettings').mockResolvedValue(null);
  vi.spyOn(NotificationNormalizer, 'toEnabledTypes').mockReturnValue(MOCK_ALLOWED_TYPES);
  return authStore;
};

// Mock pubky-app-specs to avoid WebAssembly issues
vi.mock('pubky-app-specs', () => ({
  default: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/database/franky/franky.helpers', () => ({
  clearDatabase: vi.fn(),
  clearPrivateData: vi.fn(),
}));

const mockClearDatabase = vi.mocked(clearDatabase);
const mockClearPrivateData = vi.mocked(clearPrivateData);

const storeMocks = vi.hoisted(() => {
  const resetAuthStore = vi.fn();
  const resetOnboardingStore = vi.fn();
  const resetSignInStore = vi.fn();
  const resetLocalFilesStore = vi.fn();
  const resetHomeStore = vi.fn();
  const resetHotStore = vi.fn();
  const resetSearchStore = vi.fn();
  const resetNotificationStore = vi.fn();
  const resetSettingsStore = vi.fn();
  const notificationInit = vi.fn();
  const initAuthStore = vi.fn();
  const setAuthUrlResolved = vi.fn();
  const setProfileChecked = vi.fn();
  const resetMigrationStore = vi.fn();

  // Factories are kept as separate constants so they can be reapplied in
  // beforeEach — vitest 4.1's restoreAllMocks() can clear vi.fn implementations
  // when a property has been spied on, so we need to re-establish defaults.
  const authStateFactory = () => ({
    init: initAuthStore,
    setSession: vi.fn(),
    setCurrentUserPubky: vi.fn(),
    setHasProfile: vi.fn(),
    setIsRestoringSession: vi.fn(),
    setHasHydrated: vi.fn(),
    setSessionRestoreDeferred: vi.fn(),
    reset: resetAuthStore,
    selectCurrentUserPubky: vi.fn(() => TEST_PUBKY),
    selectIsAuthenticated: vi.fn(() => false),
  });
  const onboardingStateFactory = () => ({ reset: resetOnboardingStore });
  const notificationStateFactory = () => ({
    setState: notificationInit,
    reset: resetNotificationStore,
  });
  const signInStateFactory = () => ({
    reset: resetSignInStore,
    setAuthUrlResolved,
    setProfileChecked,
    authUrlResolved: false,
    profileChecked: false,
    bootstrapFetched: false,
    dataPersisted: false,
    homeserverSynced: false,
  });
  const localFilesStateFactory = () => ({ reset: resetLocalFilesStore });
  const homeStateFactory = () => ({ reset: resetHomeStore });
  const hotStateFactory = () => ({ reset: resetHotStore });
  const searchStateFactory = () => ({ reset: resetSearchStore });
  const settingsStateFactory = () => ({ reset: resetSettingsStore });

  return {
    resetAuthStore,
    resetOnboardingStore,
    resetSignInStore,
    resetLocalFilesStore,
    resetHomeStore,
    resetHotStore,
    resetSearchStore,
    resetNotificationStore,
    resetSettingsStore,
    notificationInit,
    initAuthStore,
    setAuthUrlResolved,
    setProfileChecked,
    resetMigrationStore,
    authStateFactory,
    onboardingStateFactory,
    notificationStateFactory,
    signInStateFactory,
    localFilesStateFactory,
    homeStateFactory,
    hotStateFactory,
    searchStateFactory,
    settingsStateFactory,
    getAuthState: vi.fn(authStateFactory),
    getOnboardingState: vi.fn(onboardingStateFactory),
    getNotificationState: vi.fn(notificationStateFactory),
    getSignInState: vi.fn(signInStateFactory),
    getLocalFilesState: vi.fn(localFilesStateFactory),
    getHomeState: vi.fn(homeStateFactory),
    getHotState: vi.fn(hotStateFactory),
    getSearchState: vi.fn(searchStateFactory),
    getSettingsState: vi.fn(settingsStateFactory),
  };
});

// Mock stores - simplified approach
vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: {
    getState: storeMocks.getAuthState,
  },
}));
vi.mock('@/stores/onboarding/onboarding.store', () => ({
  useOnboardingStore: {
    getState: storeMocks.getOnboardingState,
  },
}));
vi.mock('@/stores/notification/notification.store', () => ({
  useNotificationStore: {
    getState: storeMocks.getNotificationState,
  },
}));
vi.mock('@/stores/signIn/signIn.store', () => ({
  useSignInStore: {
    getState: storeMocks.getSignInState,
  },
}));
vi.mock('@/stores/localFiles/localFiles.store', () => ({
  useLocalFilesStore: {
    getState: storeMocks.getLocalFilesState,
  },
}));
vi.mock('@/stores/home/home.store', () => ({
  useHomeStore: {
    getState: storeMocks.getHomeState,
  },
}));
vi.mock('@/stores/hot/hot.store', () => ({
  useHotStore: {
    getState: storeMocks.getHotState,
  },
}));
vi.mock('@/stores/search/search.store', () => ({
  useSearchStore: {
    getState: storeMocks.getSearchState,
  },
}));
vi.mock('@/stores/settings/settings.store', () => ({
  useSettingsStore: {
    getState: storeMocks.getSettingsState,
  },
}));
vi.mock('@/stores/migration/migration.store', () => ({
  useMigrationStore: {
    getState: () => ({
      reset: storeMocks.resetMigrationStore,
      wasDbReset: false,
    }),
  },
}));

// Mock @synonymdev/pubky
vi.mock('@synonymdev/pubky', () => ({
  Client: class {
    fetch(input: string, init?: RequestInit | null): Promise<Response> {
      return globalThis.fetch(input, init ?? undefined);
    }
  },
  Keypair: {
    fromSecret: vi.fn(() => ({
      pubky: vi.fn(() => ({ z32: () => 'test-public-key' })),
      secret: vi.fn(() => new Uint8Array(32).fill(1)),
    })),
    random: vi.fn(() => ({
      pubky: vi.fn(() => ({ z32: () => 'test-public-key' })),
      secret: vi.fn(() => new Uint8Array(32).fill(1)),
    })),
  },
  Pubky: {
    withClient: (client: { fetch: (input: string, init?: RequestInit | null) => Promise<Response> }) => ({
      client,
      getHomeserverOf: vi.fn(),
    }),
  },
  PublicKey: {
    from: vi.fn(),
  },
  resolvePubky: (identifier: string) => identifier.replace('pubky://', 'https://_pubky.'),
  createRecoveryFile: vi.fn(() => new Uint8Array([1, 2, 3, 4, 5])),
}));

vi.mock('@/libs/env/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/env/env')>();
  return {
    Env: {
      ...actual.Env,
      HOMESERVER_ADMIN_URL: 'http://test-admin.com',
      HOMESERVER_ADMIN_PASSWORD: 'test-password',
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClearDatabase.mockReset();
    AuthController.resetCleanupLocalStateGuard();
    AuthController.resetSignInCeremonyGuard();
    resetAuthFinalizationLockForTests();
    // Default: homeserver environment check passes (non-staging test config / allowed key)
    vi.spyOn(AuthApplication, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
    // Default: the grant key store is empty; grant tests override these.
    vi.spyOn(AuthApplication, 'clearGrantSessions').mockResolvedValue(undefined);
    vi.spyOn(AuthApplication, 'removeGrantSession').mockResolvedValue(undefined);
    // Re-apply factory implementations: vi.restoreAllMocks() in afterEach can
    // clear vi.fn implementations whenever a property has been spied on, which
    // would leave subsequent tests with empty mocks returning undefined.
    storeMocks.getAuthState.mockImplementation(storeMocks.authStateFactory);
    storeMocks.getOnboardingState.mockImplementation(storeMocks.onboardingStateFactory);
    storeMocks.getNotificationState.mockImplementation(storeMocks.notificationStateFactory);
    storeMocks.getSignInState.mockImplementation(storeMocks.signInStateFactory);
    storeMocks.getLocalFilesState.mockImplementation(storeMocks.localFilesStateFactory);
    storeMocks.getHomeState.mockImplementation(storeMocks.homeStateFactory);
    storeMocks.getHotState.mockImplementation(storeMocks.hotStateFactory);
    storeMocks.getSearchState.mockImplementation(storeMocks.searchStateFactory);
    storeMocks.getSettingsState.mockImplementation(storeMocks.settingsStateFactory);
    // Ensure migration store mock is always available
    vi.spyOn(useMigrationStore, 'getState').mockReturnValue(
      mockMigrationStore({
        reset: storeMocks.resetMigrationStore,
        wasDbReset: false,
      }),
    );
  });

  describe('bootstrapWithDelay', () => {
    beforeEach(() => {
      setupNotificationMocks();
    });

    it('should wait 5 seconds, initialize bootstrap, and setState notification store', async () => {
      const notification: Omit<NotificationState, 'marketplaceUnread'> = {
        unread: 2,
        lastRead: 123,
        lastPolledTimestamp: undefined,
      };
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize').mockResolvedValue(notification);
      const sleepSpy = await spyOnSleep();

      const authStoreState = mockAuthStore({
        currentUserPubky: TEST_PUBKY,
        session: null,
        hasProfile: false,
        hasHydrated: false,
        sessionExport: null,
        isRestoringSession: false,
        selectIsAuthenticated: vi.fn(() => false),
        init: vi.fn(),
        setSession: vi.fn(),
        setCurrentUserPubky: vi.fn(),
        setHasProfile: vi.fn(),
        setHasHydrated: vi.fn(),
        setIsRestoringSession: vi.fn(),
        reset: vi.fn(),
        selectCurrentUserPubky: vi.fn(() => TEST_PUBKY),
      });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStoreState);

      await AuthController.bootstrapWithDelay();

      expect(sleepSpy).toHaveBeenCalledWith(5000);
      expect(initializeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          pubky: TEST_PUBKY,
          lastReadUrl: getLastReadUrl(TEST_PUBKY),
          allowedTypes: MOCK_ALLOWED_TYPES,
        }),
        expect.any(Function), // onProgress callback
      );
      expect(storeMocks.notificationInit).toHaveBeenCalledWith(notification);
      expect(authStoreState.setHasProfile).toHaveBeenCalledWith(true);
    });

    it('should use remote settings when initializeSettings returns non-null', async () => {
      // Goal: prove that bootstrap prefers fresher remote settings and derives
      // notification bootstrap inputs from that remote snapshot.
      const remoteNotificationPrefs: NotificationPreferences = {
        newFriend: true,
        tagProfile: true,
        mention: true,
        reply: true,
        postDeleted: true,
        follow: false,
        tagPost: false,
        repost: false,
        postEdited: false,
      };
      const remoteSettings = createMockSettingsState({
        notifications: remoteNotificationPrefs,
      });
      const remoteAllowedTypes = [NotificationType.Reply, NotificationType.Mention];

      // Override global mocks: initializeSettings returns remote, toEnabledTypes uses remote prefs
      vi.spyOn(SettingsApplication, 'initializeSettings').mockResolvedValue(remoteSettings);
      vi.spyOn(NotificationNormalizer, 'toEnabledTypes').mockReturnValue(remoteAllowedTypes);
      vi.spyOn(SettingsNormalizer, 'extractState').mockReturnValue(createMockSettingsState());

      const notification: Omit<NotificationState, 'marketplaceUnread'> = {
        unread: 5,
        lastRead: 999,
        lastPolledTimestamp: undefined,
      };
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize').mockResolvedValue(notification);
      await spyOnSleep();

      const loadFromHomeserverSpy = vi.fn();
      const settingsStoreState = mockSettingsStore({ loadFromHomeserver: loadFromHomeserverSpy });
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(settingsStoreState);

      const authStoreState = mockAuthStore({
        ...storeMocks.getAuthState(),
        selectCurrentUserPubky: vi.fn(() => TEST_PUBKY),
        setHasProfile: vi.fn(),
      });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStoreState);

      await AuthController.bootstrapWithDelay();

      // toEnabledTypes should have been called with remote notification preferences
      expect(NotificationNormalizer.toEnabledTypes).toHaveBeenCalledWith(remoteNotificationPrefs);
      // Bootstrap should use remote-derived allowedTypes
      expect(initializeSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ allowedTypes: remoteAllowedTypes }));
      // Remote settings should be applied to the store
      expect(loadFromHomeserverSpy).toHaveBeenCalledWith(remoteSettings);
    });

    it('should complete bootstrap when settings sync fails with AppError', async () => {
      // Goal: prove that settings sync failures are non-blocking and bootstrap
      // still finishes with local settings as the fallback source of truth.
      const appError = new AppError({
        category: ErrorCategory.Server,
        code: ServerErrorCode.UNKNOWN_ERROR,
        message: 'settings sync failed',
        service: ErrorService.Homeserver,
        operation: 'initializeSettings',
      });
      vi.spyOn(SettingsApplication, 'initializeSettings').mockRejectedValue(appError);
      vi.spyOn(SettingsNormalizer, 'extractState').mockReturnValue(createMockSettingsState());

      const notification: Omit<NotificationState, 'marketplaceUnread'> = {
        unread: 0,
        lastRead: 0,
        lastPolledTimestamp: undefined,
      };
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize').mockResolvedValue(notification);
      await spyOnSleep();

      const loadFromHomeserverSpy = vi.fn();
      const settingsStoreState = mockSettingsStore({ loadFromHomeserver: loadFromHomeserverSpy });
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(settingsStoreState);

      const authStoreState = mockAuthStore({
        ...storeMocks.getAuthState(),
        selectCurrentUserPubky: vi.fn(() => TEST_PUBKY),
        setHasProfile: vi.fn(),
      });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStoreState);

      await AuthController.bootstrapWithDelay();

      // Bootstrap should still complete despite settings sync failure
      expect(initializeSpy).toHaveBeenCalled();
      expect(storeMocks.notificationInit).toHaveBeenCalledWith(notification);
      expect(authStoreState.setHasProfile).toHaveBeenCalledWith(true);
      // Remote settings should NOT be applied (sync failed, fell back to local)
      expect(loadFromHomeserverSpy).not.toHaveBeenCalled();
    });
  });

  describe('signUp', () => {
    beforeEach(() => {
      setupOnboardingStore();
    });

    it('should successfully sign up a user and call init', async () => {
      const keypair = createMockKeypair();
      const signupToken = 'test-token';
      const mockSession = buildMockSession();
      const mockPubky = 'test-pubky' as Pubky;

      const signUpSpy = vi.spyOn(AuthApplication, 'signUp').mockResolvedValue({
        session: mockSession,
      });
      const keypairFromSecretKeySpy = vi.spyOn(Identity, 'keypairFromSecretKey').mockReturnValue(keypair);
      const z32FromSessionSpy = vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearAllQueryClientsSpy = await spyOnClearAllQueryClients();
      const cancelModerationFollowSpy = vi.spyOn(BootstrapApplication, 'cancelModerationFollow');

      const authStore = storeMocks.getAuthState();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(mockAuthStore(authStore));

      const result = await AuthController.signUp({ secretKey: TEST_SECRET_KEY, signupToken });

      expect(clearAllQueryClientsSpy).toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(cancelModerationFollowSpy.mock.invocationCallOrder[0]).toBeLessThan(
        clearDatabaseSpy.mock.invocationCallOrder[0]!,
      );
      // Skip post-migration resync — new user has no homeserver data to resync
      expect(storeMocks.resetMigrationStore).toHaveBeenCalled();
      expect(keypairFromSecretKeySpy).toHaveBeenCalledWith(TEST_SECRET_KEY);
      expect(signUpSpy).toHaveBeenCalledWith({
        keypair,
        signupToken,
      });
      expect(z32FromSessionSpy).toHaveBeenCalledWith({ session: mockSession });
      expect(authStore.init).toHaveBeenCalledWith({
        session: mockSession,
        currentUserPubky: mockPubky,
        hasProfile: false,
      });
      expect(result).toBeUndefined();
    });

    it('should throw error if signup fails', async () => {
      const keypair = createMockKeypair();
      const signupToken = 'invalid-token';

      const signUpSpy = vi.spyOn(AuthApplication, 'signUp').mockRejectedValue(new Error('Signup failed'));
      const keypairFromSecretKeySpy = vi.spyOn(Identity, 'keypairFromSecretKey').mockReturnValue(keypair);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearAllQueryClientsSpy = await spyOnClearAllQueryClients();
      const cancelModerationFollowSpy = vi.spyOn(BootstrapApplication, 'cancelModerationFollow');

      await expect(AuthController.signUp({ secretKey: TEST_SECRET_KEY, signupToken })).rejects.toThrow('Signup failed');
      expect(clearAllQueryClientsSpy).toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(cancelModerationFollowSpy.mock.invocationCallOrder[0]).toBeLessThan(
        clearDatabaseSpy.mock.invocationCallOrder[0]!,
      );
      expect(keypairFromSecretKeySpy).toHaveBeenCalledWith(TEST_SECRET_KEY);
      expect(signUpSpy).toHaveBeenCalledWith({
        keypair,
        signupToken,
      });
    });
  });

  describe('loginWithMnemonic', () => {
    beforeEach(() => {
      setupOnboardingStore();
      vi.spyOn(NotificationNormalizer, 'to').mockReturnValue(
        asOpaque<LastReadResult>({
          meta: { url: 'pubky://test-pubky/pub/pubky.app/last_read' },
        }),
      );
    });

    it('should successfully login with mnemonic and bootstrap', async () => {
      const mnemonic = 'test mnemonic phrase';
      const mockKeypair = createMockKeypair();
      const mockSession = buildMockSession();
      const mockPubky = 'test-pubky' as Pubky;
      const mockData = { session: mockSession };
      const mockNotification: Omit<NotificationState, 'marketplaceUnread'> = {
        unread: 0,
        lastRead: 123,
        lastPolledTimestamp: 0,
      };

      const keypairSpy = vi.spyOn(Identity, 'keypairFromMnemonic').mockReturnValue(mockKeypair);
      const signInSpy = vi.spyOn(AuthApplication, 'signIn').mockResolvedValue(mockData);
      const z32FromSessionSpy = vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(true);
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize').mockResolvedValue(mockNotification);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearAllQueryClientsSpy = await spyOnClearAllQueryClients();
      const cancelModerationFollowSpy = vi.spyOn(BootstrapApplication, 'cancelModerationFollow');

      const _authStore = setupAuthAndNotificationStores();

      const result = await AuthController.loginWithMnemonic({ mnemonic });

      expect(clearAllQueryClientsSpy).toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(cancelModerationFollowSpy.mock.invocationCallOrder[0]).toBeLessThan(
        clearDatabaseSpy.mock.invocationCallOrder[0]!,
      );
      // Skip post-migration resync — bootstrap runs if user has profile, otherwise no data to resync
      expect(storeMocks.resetMigrationStore).toHaveBeenCalled();
      expect(keypairSpy).toHaveBeenCalledWith(mnemonic);
      expect(signInSpy).toHaveBeenCalledWith({ keypair: mockKeypair });
      expect(z32FromSessionSpy).toHaveBeenCalledWith({ session: mockSession });
      expect(userIsSignedUpSpy).toHaveBeenCalledWith({ pubky: mockPubky });
      expect(initializeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          pubky: mockPubky,
          lastReadUrl: getLastReadUrl('test-pubky'),
          allowedTypes: MOCK_ALLOWED_TYPES,
        }),
        expect.any(Function), // onProgress callback
      );
      expect(storeMocks.notificationInit).toHaveBeenCalledWith(mockNotification);
      // Session stored early with hasProfile: null, then setHasProfile called after bootstrap
      expect(_authStore.init).toHaveBeenCalledWith({
        session: mockSession,
        currentUserPubky: mockPubky,
        hasProfile: null,
      });
      expect(_authStore.setHasProfile).toHaveBeenCalledWith(true);
      expect(result).toBe(true);
    });

    it('should successfully login with mnemonic without bootstrap if user is not signed up', async () => {
      const mnemonic = 'test mnemonic phrase';
      const mockKeypair = createMockKeypair();
      const mockSession = buildMockSession();
      const mockPubky = 'test-pubky' as Pubky;
      const mockData = { session: mockSession };

      const keypairSpy = vi.spyOn(Identity, 'keypairFromMnemonic').mockReturnValue(mockKeypair);
      const signInSpy = vi.spyOn(AuthApplication, 'signIn').mockResolvedValue(mockData);
      const z32FromSessionSpy = vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(false);
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize');
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearAllQueryClients();

      const _authStore = setupAuthAndNotificationStores();

      const result = await AuthController.loginWithMnemonic({ mnemonic });

      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(keypairSpy).toHaveBeenCalledWith(mnemonic);
      expect(signInSpy).toHaveBeenCalledWith({ keypair: mockKeypair });
      expect(z32FromSessionSpy).toHaveBeenCalledWith({ session: mockSession });
      expect(userIsSignedUpSpy).toHaveBeenCalledWith({ pubky: mockPubky });
      expect(initializeSpy).not.toHaveBeenCalled();
      // Session stored early with hasProfile: null, then setHasProfile called after check
      expect(_authStore.init).toHaveBeenCalledWith({
        session: mockSession,
        currentUserPubky: mockPubky,
        hasProfile: null,
      });
      expect(_authStore.setHasProfile).toHaveBeenCalledWith(false);
      expect(result).toBe(true);
    });

    it('should return false if signIn returns undefined', async () => {
      const mnemonic = 'test mnemonic phrase';
      const mockKeypair = createMockKeypair();

      vi.spyOn(Identity, 'keypairFromMnemonic').mockReturnValue(mockKeypair);
      vi.spyOn(AuthApplication, 'signIn').mockResolvedValue(undefined);
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearAllQueryClients();

      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize');

      const result = await AuthController.loginWithMnemonic({ mnemonic });

      expect(initializeSpy).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it('logs the sign-in failure with the public key only — never the keypair or secret material', async () => {
      const mnemonic = 'test mnemonic phrase';
      const mockKeypair = createMockKeypair();

      vi.spyOn(Identity, 'keypairFromMnemonic').mockReturnValue(mockKeypair);
      vi.spyOn(AuthApplication, 'signIn').mockResolvedValue(undefined);
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearAllQueryClients();
      const loggerErrorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});

      const result = await AuthController.loginWithMnemonic({ mnemonic });

      expect(result).toBe(false);
      const failureLog = loggerErrorSpy.mock.calls.find(
        ([message]) => message === 'Failed to sign in. Please try again.',
      );
      expect(failureLog).toBeDefined();
      const context = failureLog![1] as Record<string, unknown>;
      expect(context).toEqual({ pubky: 'test-pubky' });
      // No secret field, by name or by serialized content.
      expect(context).not.toHaveProperty('keypair');
      expect(JSON.stringify(context)).not.toMatch(/secret|secretKey|mnemonic|recoveryPhrase|keypair/i);
    });

    it('should throw error if signIn fails', async () => {
      const mnemonic = 'test mnemonic phrase';
      const mockKeypair = createMockKeypair();

      vi.spyOn(Identity, 'keypairFromMnemonic').mockReturnValue(mockKeypair);
      vi.spyOn(AuthApplication, 'signIn').mockRejectedValue(new Error('Authentication failed'));
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearAllQueryClients();

      await expect(AuthController.loginWithMnemonic({ mnemonic })).rejects.toThrow('Authentication failed');
    });
  });

  describe('loginWithEncryptedFile', () => {
    beforeEach(() => {
      setupOnboardingStore();
      vi.spyOn(NotificationNormalizer, 'to').mockReturnValue(
        asOpaque<LastReadResult>({
          meta: { url: 'pubky://test-pubky/pub/pubky.app/last_read' },
        }),
      );
    });

    it('should successfully login with encrypted file and bootstrap', async () => {
      const encryptedFile = createMockEncryptedFile();
      const password = 'test-password';
      const mockKeypair = createMockKeypair();
      const mockSession = buildMockSession();
      const mockPubky = 'test-pubky' as Pubky;
      const mockData = { session: mockSession };
      const mockNotification: Omit<NotificationState, 'marketplaceUnread'> = {
        unread: 0,
        lastRead: 123,
        lastPolledTimestamp: 0,
      };

      const decryptSpy = vi.spyOn(Identity, 'decryptRecoveryFile').mockResolvedValue(mockKeypair);
      const signInSpy = vi.spyOn(AuthApplication, 'signIn').mockResolvedValue(mockData);
      const z32FromSessionSpy = vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(true);
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize').mockResolvedValue(mockNotification);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearAllQueryClientsSpy = await spyOnClearAllQueryClients();

      const _authStore = setupAuthAndNotificationStores();

      const result = await AuthController.loginWithEncryptedFile({ encryptedFile, password });

      expect(clearAllQueryClientsSpy).toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(decryptSpy).toHaveBeenCalledWith({ encryptedFile, passphrase: password });
      expect(signInSpy).toHaveBeenCalledWith({ keypair: mockKeypair });
      expect(z32FromSessionSpy).toHaveBeenCalledWith({ session: mockSession });
      expect(userIsSignedUpSpy).toHaveBeenCalledWith({ pubky: mockPubky });
      expect(initializeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          pubky: mockPubky,
          lastReadUrl: getLastReadUrl('test-pubky'),
          allowedTypes: MOCK_ALLOWED_TYPES,
        }),
        expect.any(Function), // onProgress callback
      );
      expect(storeMocks.notificationInit).toHaveBeenCalledWith(mockNotification);
      // Session stored early with hasProfile: null, then setHasProfile called after bootstrap
      expect(_authStore.init).toHaveBeenCalledWith({
        session: mockSession,
        currentUserPubky: mockPubky,
        hasProfile: null,
      });
      expect(_authStore.setHasProfile).toHaveBeenCalledWith(true);
      expect(result).toBe(true);
    });

    it('should successfully login with encrypted file without bootstrap if user is not signed up', async () => {
      const encryptedFile = createMockEncryptedFile();
      const password = 'test-password';
      const mockKeypair = createMockKeypair();
      const mockSession = buildMockSession();
      const mockPubky = 'test-pubky' as Pubky;
      const mockData = { session: mockSession };

      const decryptSpy = vi.spyOn(Identity, 'decryptRecoveryFile').mockResolvedValue(mockKeypair);
      const signInSpy = vi.spyOn(AuthApplication, 'signIn').mockResolvedValue(mockData);
      const z32FromSessionSpy = vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(false);
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize');
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearAllQueryClients();

      const _authStore = setupAuthAndNotificationStores();

      const result = await AuthController.loginWithEncryptedFile({ encryptedFile, password });

      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(decryptSpy).toHaveBeenCalledWith({ encryptedFile, passphrase: password });
      expect(signInSpy).toHaveBeenCalledWith({ keypair: mockKeypair });
      expect(z32FromSessionSpy).toHaveBeenCalledWith({ session: mockSession });
      expect(userIsSignedUpSpy).toHaveBeenCalledWith({ pubky: mockPubky });
      expect(initializeSpy).not.toHaveBeenCalled();
      // Session stored early with hasProfile: null, then setHasProfile called after check
      expect(_authStore.init).toHaveBeenCalledWith({
        session: mockSession,
        currentUserPubky: mockPubky,
        hasProfile: null,
      });
      expect(_authStore.setHasProfile).toHaveBeenCalledWith(false);
      expect(result).toBe(true);
    });

    it('should return false if signIn returns undefined', async () => {
      const encryptedFile = createMockEncryptedFile();
      const password = 'test-password';
      const mockKeypair = createMockKeypair();

      vi.spyOn(Identity, 'decryptRecoveryFile').mockResolvedValue(mockKeypair);
      vi.spyOn(AuthApplication, 'signIn').mockResolvedValue(undefined);
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearAllQueryClients();

      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize');

      const result = await AuthController.loginWithEncryptedFile({ encryptedFile, password });

      expect(initializeSpy).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it('should throw error if decryption fails', async () => {
      const encryptedFile = createMockEncryptedFile();
      const password = 'wrong-password';

      vi.spyOn(Identity, 'decryptRecoveryFile').mockRejectedValue(new Error('Decryption failed'));

      await expect(AuthController.loginWithEncryptedFile({ encryptedFile, password })).rejects.toThrow(
        'Decryption failed',
      );
    });

    it('should throw error if signIn fails', async () => {
      const encryptedFile = createMockEncryptedFile();
      const password = 'test-password';
      const mockKeypair = createMockKeypair();

      vi.spyOn(Identity, 'decryptRecoveryFile').mockResolvedValue(mockKeypair);
      vi.spyOn(AuthApplication, 'signIn').mockRejectedValue(new Error('Authentication failed'));
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearAllQueryClients();

      await expect(AuthController.loginWithEncryptedFile({ encryptedFile, password })).rejects.toThrow(
        'Authentication failed',
      );
    });
  });

  describe('getAuthUrl', () => {
    beforeEach(() => {
      setupOnboardingStore();
    });

    const tokenFlow = (authorizationUrl: string, cancelAuthFlow: () => void) => ({
      authorizationUrl,
      awaitToken: () => new Promise<never>(() => {}),
      cancelAuthFlow,
    });

    it('should generate auth URL successfully', async () => {
      const cancelAuthFlow = vi.fn();
      const mockFlow = tokenFlow('https://example.com/auth?token=abc123', cancelAuthFlow);
      const startSpy = vi.spyOn(AuthApplication, 'startDirectSignInFlow').mockReturnValue(mockFlow);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const cancelModerationFollowSpy = vi.spyOn(BootstrapApplication, 'cancelModerationFollow');

      const result = await AuthController.getAuthUrl();

      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(cancelModerationFollowSpy.mock.invocationCallOrder[0]).toBeLessThan(
        clearDatabaseSpy.mock.invocationCallOrder[0]!,
      );
      expect(storeMocks.resetMigrationStore).toHaveBeenCalled();
      expect(result.authorizationUrl).toEqual(mockFlow.authorizationUrl);
      expect(result.awaitApproval).toBeInstanceOf(Promise);
      expect(result.cancelAuthFlow).toBe(cancelAuthFlow);
      expect(startSpy).toHaveBeenCalled();
    });

    it('should throw error when auth URL generation fails', async () => {
      const startSpy = vi.spyOn(AuthApplication, 'startDirectSignInFlow').mockImplementation(() => {
        throw new Error('Failed to generate auth URL');
      });
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);

      await expect(AuthController.getAuthUrl()).rejects.toThrow('Failed to generate auth URL');
      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalled();
    });

    it('joins overlapping requests during the ceremony instead of wiping Dexie again', async () => {
      mockClearDatabase.mockResolvedValue(undefined);
      const cancelAuthFlow = vi.fn();
      const startSpy = vi
        .spyOn(AuthApplication, 'startDirectSignInFlow')
        .mockReturnValue(tokenFlow('https://example.com/auth?token=A', cancelAuthFlow));

      const firstCall = AuthController.getAuthUrl();
      const secondCall = AuthController.getAuthUrl();
      const [first, second] = await Promise.all([firstCall, secondCall]);

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(mockClearDatabase).toHaveBeenCalledTimes(1);
      expect(first.authorizationUrl).toBe(second.authorizationUrl);
      expect(cancelAuthFlow).not.toHaveBeenCalled();
    });
  });

  describe('getStepUpAuthUrl (step-up Option C)', () => {
    beforeEach(() => {
      setupOnboardingStore();
    });

    it('requests the FULL grant without wiping local state', async () => {
      const cancelAuthFlow = vi.fn();
      const mockFlow = {
        authorizationUrl: 'https://example.com/auth?token=stepup',
        awaitToken: () => new Promise<never>(() => {}),
        cancelAuthFlow,
      };
      const startSpy = vi.spyOn(AuthApplication, 'startDirectSignInFlow').mockReturnValue(mockFlow);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);

      const result = await AuthController.getStepUpAuthUrl();

      expect(startSpy).toHaveBeenCalledExactlyOnceWith();
      expect(clearDatabaseSpy).not.toHaveBeenCalled();
      expect(storeMocks.resetMigrationStore).not.toHaveBeenCalled();
      expect(result.authorizationUrl).toEqual(mockFlow.authorizationUrl);
      expect(result.cancelAuthFlow).toBe(cancelAuthFlow);
    });

    it('joins overlapping step-up requests (StrictMode) without a second flow', async () => {
      const cancelAuthFlow = vi.fn();
      const startSpy = vi.spyOn(AuthApplication, 'startDirectSignInFlow').mockReturnValue({
        authorizationUrl: 'https://example.com/auth?token=A',
        awaitToken: () => new Promise<never>(() => {}),
        cancelAuthFlow,
      });

      const firstCall = AuthController.getStepUpAuthUrl();
      const secondCall = AuthController.getStepUpAuthUrl();
      await Promise.all([firstCall, secondCall]);

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(cancelAuthFlow).not.toHaveBeenCalled();
    });
  });

  describe('completeStepUpReauth (step-up Option C)', () => {
    it('swaps the auth-store session for the widened one on approval', async () => {
      const mockSession = buildMockSession();
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(TEST_PUBKY as Pubky);
      const guardSpy = vi.spyOn(AuthApplication, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      const logoutSpy = vi.spyOn(AuthApplication, 'logout');
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        currentUserPubky: TEST_PUBKY as Pubky,
      });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);

      await AuthController.completeStepUpReauth({ session: mockSession });

      expect(guardSpy).toHaveBeenCalledWith({ publicKey: mockSession.info.publicKey });
      // The store session update is what makes watchlist sync, receipts, and
      // messaging cookie-resume capable without a reload.
      expect(authStore.setSession).toHaveBeenCalledWith(mockSession);
      expect(logoutSpy).not.toHaveBeenCalled();
    });

    it('refuses and signs out a session approved for a DIFFERENT identity', async () => {
      const mockSession = buildMockSession();
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue('o'.repeat(52) as Pubky);
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const guardSpy = vi.spyOn(AuthApplication, 'assertUserHomeserverAllowed');
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        currentUserPubky: TEST_PUBKY as Pubky,
      });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);

      await expect(AuthController.completeStepUpReauth({ session: mockSession })).rejects.toMatchObject({
        code: AuthErrorCode.UNAUTHORIZED,
      });
      expect(authStore.setSession).not.toHaveBeenCalled();
      expect(guardSpy).not.toHaveBeenCalled();
      expect(logoutSpy).toHaveBeenCalledWith({ session: mockSession });
    });

    it('signs out and rethrows when the staging homeserver guard rejects the session', async () => {
      const mockSession = buildMockSession();
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(TEST_PUBKY as Pubky);
      vi.spyOn(AuthApplication, 'assertUserHomeserverAllowed').mockRejectedValue(new Error('wrong environment'));
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        currentUserPubky: TEST_PUBKY as Pubky,
      });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);

      await expect(AuthController.completeStepUpReauth({ session: mockSession })).rejects.toThrow('wrong environment');
      expect(logoutSpy).toHaveBeenCalledWith({ session: mockSession });
      expect(authStore.setSession).not.toHaveBeenCalled();
    });
  });

  describe('getSignupAuthUrl', () => {
    beforeEach(() => {
      setupOnboardingStore();
    });

    it('should generate signup auth URL successfully with activeAuthFlow tracking', async () => {
      const cancelAuthFlow = vi.fn();
      const mockAuthUrl = {
        authorizationUrl: 'https://example.com/auth?token=signup123',
        awaitApproval: Promise.resolve(buildMockSession()),
        cancelAuthFlow,
      };
      const generateSignupAuthUrlSpy = vi
        .spyOn(AuthApplication, 'generateSignupAuthUrl')
        .mockResolvedValue(mockAuthUrl);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);

      const result = await AuthController.getSignupAuthUrl('A9KM-7MJP-ERM9');

      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(generateSignupAuthUrlSpy).toHaveBeenCalledWith('A9KM-7MJP-ERM9');
      expect(result.authorizationUrl).toEqual(mockAuthUrl.authorizationUrl);
      expect(result.awaitApproval).toBeInstanceOf(Promise);
      expect(result.cancelAuthFlow).toBe(cancelAuthFlow);
    });

    it('should throw error when signup auth URL generation fails', async () => {
      const generateSignupAuthUrlSpy = vi
        .spyOn(AuthApplication, 'generateSignupAuthUrl')
        .mockRejectedValue(new Error('Failed to generate signup auth URL'));
      mockClearDatabase.mockResolvedValue(undefined);

      await expect(AuthController.getSignupAuthUrl('INVITE-CODE')).rejects.toThrow(
        'Failed to generate signup auth URL',
      );
      expect(generateSignupAuthUrlSpy).toHaveBeenCalledWith('INVITE-CODE');
    });

    it('should free stale auth flows when multiple requests overlap (StrictMode)', async () => {
      mockClearDatabase.mockResolvedValue(undefined);

      const cancelAuthFlowA = vi.fn();
      const cancelAuthFlowB = vi.fn();

      type GenerateSignupAuthUrlResult = Awaited<ReturnType<typeof AuthApplication.generateSignupAuthUrl>>;

      let resolveFirst!: (value: GenerateSignupAuthUrlResult) => void;
      const first = new Promise<GenerateSignupAuthUrlResult>((resolve) => {
        resolveFirst = resolve;
      });

      vi.spyOn(AuthApplication, 'generateSignupAuthUrl')
        .mockImplementationOnce(() => first)
        .mockResolvedValueOnce({
          authorizationUrl: 'https://example.com/auth?token=B',
          awaitApproval: new Promise(() => {}),
          cancelAuthFlow: cancelAuthFlowB,
        });

      const firstCall = AuthController.getSignupAuthUrl('CODE-A');
      const secondCall = AuthController.getSignupAuthUrl('CODE-B');

      resolveFirst!({
        authorizationUrl: 'https://example.com/auth?token=A',
        awaitApproval: new Promise(() => {}),
        cancelAuthFlow: cancelAuthFlowA,
      });

      await secondCall;
      await firstCall;

      expect(cancelAuthFlowA).toHaveBeenCalled();
      expect(cancelAuthFlowB).not.toHaveBeenCalled();
    });
  });

  describe('restorePersistedSession', () => {
    it('should restore a session when sessionExport exists and store has hydrated', async () => {
      const mockSession = buildMockSession();
      const mockPubky = TEST_PUBKY as Pubky;
      const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(false);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);

      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: 'session-export',
        currentUserPubky: mockPubky,
        hasProfile: true,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({
        status: 'restored',
        session: mockSession,
      });
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);

      const result = await AuthController.restorePersistedSession();

      expect(result).toEqual({ status: 'restored' });
      expect(AuthApplication.restorePersistedSession).toHaveBeenCalledWith({
        authStore,
        confirmSessionHandoff: expect.any(Function),
      });
      expect(Identity.z32FromSession).toHaveBeenCalledWith({ session: mockSession });
      expect(userIsSignedUpSpy).not.toHaveBeenCalled();
      expect(authStore.reset).not.toHaveBeenCalled();
      expect(clearDatabaseSpy).not.toHaveBeenCalled();
      expect(authStore.init).toHaveBeenCalledWith({
        session: mockSession,
        currentUserPubky: mockPubky,
        hasProfile: true,
      });
    });

    it('should restore the account-scoped marketplace session and mirror its facts into the commerce store', async () => {
      const mockSession = buildMockSession();
      const mockPubky = TEST_PUBKY as Pubky;
      const marketplaceSession = {
        pubky: mockPubky,
        capabilities: '',
        expiresAt: '2026-08-22T00:00:00.000Z',
        issuedAt: '2026-08-21T00:00:00.000Z',
      };

      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: 'session-export',
        currentUserPubky: mockPubky,
        hasProfile: true,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({
        status: 'restored',
        session: mockSession,
      });
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      const restoreSpy = vi.spyOn(CommerceApplication, 'restoreMarketplaceSession').mockReturnValue(marketplaceSession);
      const writeSpy = vi.spyOn(CommerceController, 'writeMarketplaceSessionStore');

      await AuthController.restorePersistedSession();

      expect(restoreSpy).toHaveBeenCalledWith(mockPubky);
      expect(writeSpy).toHaveBeenCalledWith(marketplaceSession);
      expect(useCommerceStore.getState().marketplaceSession).toEqual(marketplaceSession);
    });

    it('does not overwrite a newer marketplace session when restore returns an older issuedAt', async () => {
      const mockSession = buildMockSession();
      const mockPubky = TEST_PUBKY as Pubky;
      const newerSession = {
        pubky: mockPubky,
        capabilities: 'l:rw',
        expiresAt: '2026-08-23T00:00:00.000Z',
        issuedAt: '2026-08-22T12:00:00.000Z',
      };
      const olderSession = {
        pubky: mockPubky,
        capabilities: '',
        expiresAt: '2026-08-22T00:00:00.000Z',
        issuedAt: '2026-08-21T00:00:00.000Z',
      };

      useCommerceStore.getState().setMarketplaceSession(newerSession);

      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: 'session-export',
        currentUserPubky: mockPubky,
        hasProfile: true,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({
        status: 'restored',
        session: mockSession,
      });
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      vi.spyOn(CommerceApplication, 'restoreMarketplaceSession').mockReturnValue(olderSession);
      const writeSpy = vi.spyOn(CommerceController, 'writeMarketplaceSessionStore');

      await AuthController.restorePersistedSession();

      expect(writeSpy).toHaveBeenCalledWith(olderSession);
      expect(useCommerceStore.getState().marketplaceSession).toEqual(newerSession);
    });

    it('should return false and run full cleanup when restoration fails', async () => {
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: 'expired-session-export',
        currentUserPubky: TEST_PUBKY as Pubky,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({ status: 'signed-out' });
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearCookiesSpy = await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      const resetSpy = vi.spyOn(PubkySpecsSingleton, 'reset');
      const cancelModerationFollowSpy = vi.spyOn(BootstrapApplication, 'cancelModerationFollow');
      const homeStore = storeMocks.getHomeState();
      const searchStore = storeMocks.getSearchState();
      const notificationStore = storeMocks.getNotificationState();
      const settingsStore = storeMocks.getSettingsState();
      // Partial mocks: only mock the methods under test, cast via `unknown` to satisfy the full store type
      vi.spyOn(useHomeStore, 'getState').mockReturnValue(mockHomeStore(homeStore));
      vi.spyOn(useSearchStore, 'getState').mockReturnValue(mockSearchStore(searchStore));
      vi.spyOn(useNotificationStore, 'getState').mockReturnValue(mockNotificationStore(notificationStore));
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(mockSettingsStore(settingsStore));

      const result = await AuthController.restorePersistedSession();

      expect(result).toEqual({ status: 'signed-out' });
      expect(authStore.init).not.toHaveBeenCalled();
      // cleanupLocalState should have been called
      expect(resetSpy).toHaveBeenCalled();
      expect(authStore.reset).toHaveBeenCalled();
      expect(homeStore.reset).toHaveBeenCalled();
      expect(searchStore.reset).toHaveBeenCalled();
      expect(notificationStore.reset).toHaveBeenCalled();
      expect(settingsStore.reset).toHaveBeenCalled();
      expect(clearCookiesSpy).toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(cancelModerationFollowSpy.mock.invocationCallOrder[0]).toBeLessThan(
        clearDatabaseSpy.mock.invocationCallOrder[0]!,
      );
    });

    it('preserves the public catalog cache when a signed-out bridge restore fails', async () => {
      const entry = createCommerceCatalogEntryFixture();
      await CommerceCatalogEntryModel.create(entry);
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: null,
        currentUserPubky: null,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({ status: 'signed-out' });

      try {
        await expect(AuthController.restorePersistedSession()).resolves.toEqual({ status: 'signed-out' });
        expect(await CommerceCatalogEntryModel.table.count()).toBe(1);
        expect(mockClearDatabase).not.toHaveBeenCalled();
        expect(mockClearPrivateData).toHaveBeenCalledOnce();
      } finally {
        await CommerceCatalogEntryModel.table.clear();
      }
    });

    it('clears private data when a no-identity restore throws', async () => {
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: null,
        currentUserPubky: null,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockRejectedValue(new Error('bridge failed'));
      mockClearPrivateData.mockResolvedValue(undefined);

      await expect(AuthController.restorePersistedSession()).resolves.toEqual({ status: 'signed-out' });

      expect(mockClearPrivateData).toHaveBeenCalledOnce();
      expect(mockClearDatabase).not.toHaveBeenCalled();
    });

    it('should cleanup then rethrow when restore throws wrong-environment homeserver error', async () => {
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: 'session-export',
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockRejectedValue(
        Err.auth(AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER, 'wrong env', {
          service: ErrorService.Homeserver,
          operation: 'assertUserHomeserverAllowed',
        }),
      );
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      const homeStore = storeMocks.getHomeState();
      const searchStore = storeMocks.getSearchState();
      const notificationStore = storeMocks.getNotificationState();
      const settingsStore = storeMocks.getSettingsState();
      vi.spyOn(useHomeStore, 'getState').mockReturnValue(mockHomeStore(homeStore));
      vi.spyOn(useSearchStore, 'getState').mockReturnValue(mockSearchStore(searchStore));
      vi.spyOn(useNotificationStore, 'getState').mockReturnValue(mockNotificationStore(notificationStore));
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(mockSettingsStore(settingsStore));

      await expect(AuthController.restorePersistedSession()).rejects.toMatchObject({
        code: AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER,
      });

      expect(authStore.init).not.toHaveBeenCalled();
      expect(authStore.reset).toHaveBeenCalled();
    });

    it('should normalize an unknown restore error before cleanup', async () => {
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: 'session-export',
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });
      const loggerErrorSpy = vi.spyOn(Logger, 'error');

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockRejectedValue(new Error('unexpected restore failure'));
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      const homeStore = storeMocks.getHomeState();
      const searchStore = storeMocks.getSearchState();
      const notificationStore = storeMocks.getNotificationState();
      const settingsStore = storeMocks.getSettingsState();
      vi.spyOn(useHomeStore, 'getState').mockReturnValue(mockHomeStore(homeStore));
      vi.spyOn(useSearchStore, 'getState').mockReturnValue(mockSearchStore(searchStore));
      vi.spyOn(useNotificationStore, 'getState').mockReturnValue(mockNotificationStore(notificationStore));
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(mockSettingsStore(settingsStore));

      await expect(AuthController.restorePersistedSession()).resolves.toEqual({ status: 'signed-out' });

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        `[${ErrorService.Local}:restorePersistedSession]`,
        'unexpected restore failure',
        undefined,
      );
      expect(authStore.reset).toHaveBeenCalled();
    });

    it('does not cleanup when restore asks to preserve the persisted export', async () => {
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: 'session-export',
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({ status: 'deferred' });
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);

      const result = await AuthController.restorePersistedSession();

      expect(result).toEqual({ status: 'deferred' });
      expect(authStore.setSessionRestoreDeferred).toHaveBeenCalledWith(true);
      expect(authStore.init).not.toHaveBeenCalled();
      expect(authStore.reset).not.toHaveBeenCalled();
      expect(clearDatabaseSpy).not.toHaveBeenCalled();
    });

    it('inits a fresh vibe restore with fetched hasProfile after account cleanup', async () => {
      const mockSession = buildMockSession();
      const mockPubky = TEST_PUBKY as Pubky;
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: null,
        currentUserPubky: null,
        hasProfile: null,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({
        status: 'restored',
        session: mockSession,
      });
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(true);
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      const homeStore = storeMocks.getHomeState();
      const searchStore = storeMocks.getSearchState();
      const notificationStore = storeMocks.getNotificationState();
      const settingsStore = storeMocks.getSettingsState();
      vi.spyOn(useHomeStore, 'getState').mockReturnValue(mockHomeStore(homeStore));
      vi.spyOn(useSearchStore, 'getState').mockReturnValue(mockSearchStore(searchStore));
      vi.spyOn(useNotificationStore, 'getState').mockReturnValue(mockNotificationStore(notificationStore));
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(mockSettingsStore(settingsStore));

      const result = await AuthController.restorePersistedSession();

      expect(result).toEqual({ status: 'restored' });
      expect(userIsSignedUpSpy).toHaveBeenCalledWith({ pubky: mockPubky });
      expect(authStore.reset).toHaveBeenCalled();
      expect(authStore.init).toHaveBeenCalledWith({
        session: mockSession,
        currentUserPubky: mockPubky,
        hasProfile: true,
      });
      expect(vi.mocked(authStore.init).mock.invocationCallOrder[0]).toBeGreaterThan(
        vi.mocked(authStore.reset).mock.invocationCallOrder[0]!,
      );
    });

    it('cleans up before init when the restored pubky differs from the persisted identity', async () => {
      const mockSession = buildMockSession();
      const restoredPubky = TEST_PUBKY as Pubky;
      const previousPubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo' as Pubky;
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: 'old-session-export',
        currentUserPubky: previousPubky,
        hasProfile: true,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({
        status: 'restored',
        session: mockSession,
      });
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(restoredPubky);
      const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(false);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      const homeStore = storeMocks.getHomeState();
      const searchStore = storeMocks.getSearchState();
      const notificationStore = storeMocks.getNotificationState();
      const settingsStore = storeMocks.getSettingsState();
      vi.spyOn(useHomeStore, 'getState').mockReturnValue(mockHomeStore(homeStore));
      vi.spyOn(useSearchStore, 'getState').mockReturnValue(mockSearchStore(searchStore));
      vi.spyOn(useNotificationStore, 'getState').mockReturnValue(mockNotificationStore(notificationStore));
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(mockSettingsStore(settingsStore));

      const result = await AuthController.restorePersistedSession();

      expect(result).toEqual({ status: 'restored' });
      expect(clearDatabaseSpy).toHaveBeenCalled();
      expect(authStore.reset).toHaveBeenCalled();
      expect(userIsSignedUpSpy).toHaveBeenCalledWith({ pubky: restoredPubky });
      expect(authStore.init).toHaveBeenCalledWith({
        session: mockSession,
        currentUserPubky: restoredPubky,
        hasProfile: false,
      });
      expect(authStore.init).not.toHaveBeenCalledWith(expect.objectContaining({ hasProfile: true }));
      expect(vi.mocked(authStore.init).mock.invocationCallOrder[0]).toBeGreaterThan(
        vi.mocked(authStore.reset).mock.invocationCallOrder[0]!,
      );
      expect(vi.mocked(authStore.init).mock.invocationCallOrder[0]).toBeGreaterThan(
        clearDatabaseSpy.mock.invocationCallOrder[0]!,
      );
    });

    it('ends signed-out with isRestoringSession false and cleanup once when userIsSignedUp throws', async () => {
      const mockSession = buildMockSession();
      const restoredPubky = TEST_PUBKY as Pubky;
      const previousPubky = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo' as Pubky;
      const authStore = mockAuthStore({
        ...storeMocks.getAuthState(),
        hasHydrated: true,
        session: null,
        sessionExport: 'old-session-export',
        currentUserPubky: previousPubky,
        hasProfile: true,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({
        status: 'restored',
        session: mockSession,
      });
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(restoredPubky);
      vi.spyOn(AuthApplication, 'userIsSignedUp').mockRejectedValue(new Error('profile lookup failed'));
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      const homeStore = storeMocks.getHomeState();
      const searchStore = storeMocks.getSearchState();
      const notificationStore = storeMocks.getNotificationState();
      const settingsStore = storeMocks.getSettingsState();
      vi.spyOn(useHomeStore, 'getState').mockReturnValue(mockHomeStore(homeStore));
      vi.spyOn(useSearchStore, 'getState').mockReturnValue(mockSearchStore(searchStore));
      vi.spyOn(useNotificationStore, 'getState').mockReturnValue(mockNotificationStore(notificationStore));
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(mockSettingsStore(settingsStore));

      await expect(AuthController.restorePersistedSession()).resolves.toEqual({ status: 'signed-out' });

      expect(authStore.init).not.toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalledTimes(1);
      expect(authStore.reset).toHaveBeenCalledTimes(1);
      expect(authStore.setIsRestoringSession).toHaveBeenCalledWith(false);
    });
  });

  describe('initializeAuthenticatedSession', () => {
    beforeEach(() => {
      setupNotificationMocks();
    });

    it('should stop any active auth flow polling when a session is initialized', async () => {
      const cancelAuthFlow = vi.fn();
      vi.spyOn(AuthApplication, 'startDirectSignInFlow').mockReturnValue({
        authorizationUrl: 'https://example.com/auth?token=abc123',
        awaitToken: () => new Promise(() => {}),
        cancelAuthFlow,
      });
      mockClearDatabase.mockResolvedValue(undefined);

      await AuthController.getAuthUrl();

      const mockSession = buildMockSession();
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(TEST_PUBKY as Pubky);
      vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(false);
      const authStore = storeMocks.getAuthState();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(mockAuthStore(authStore));

      await AuthController.initializeAuthenticatedSession({ session: mockSession });

      expect(cancelAuthFlow).toHaveBeenCalled();
    });

    it('should initialize session and bootstrap if user is signed up', async () => {
      const mockSession = buildMockSession();
      const mockPubky = TEST_PUBKY as Pubky;
      const notification: Omit<NotificationState, 'marketplaceUnread'> = {
        unread: 0,
        lastRead: 456,
        lastPolledTimestamp: 0,
      };

      const z32FromSessionSpy = vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(true);
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize').mockResolvedValue(notification);

      const authStore = storeMocks.getAuthState();
      const signInStore = storeMocks.getSignInState();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(mockAuthStore(authStore));
      vi.spyOn(useSignInStore, 'getState').mockReturnValue(mockSignInStore(signInStore));

      await AuthController.initializeAuthenticatedSession({ session: mockSession });

      expect(signInStore.reset).toHaveBeenCalled();
      expect(signInStore.setAuthUrlResolved).toHaveBeenCalledWith(true);
      expect(z32FromSessionSpy).toHaveBeenCalledWith({ session: mockSession });
      expect(userIsSignedUpSpy).toHaveBeenCalledWith({ pubky: mockPubky });
      expect(signInStore.setProfileChecked).toHaveBeenCalledWith(true);
      expect(initializeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          pubky: mockPubky,
          lastReadUrl: getLastReadUrl(TEST_PUBKY),
          allowedTypes: MOCK_ALLOWED_TYPES,
        }),
        expect.any(Function), // onProgress callback
      );
      expect(storeMocks.notificationInit).toHaveBeenCalledWith(notification);
      // Session stored early with hasProfile: null, then setHasProfile called after bootstrap
      expect(authStore.init).toHaveBeenCalledWith({
        session: mockSession,
        currentUserPubky: mockPubky,
        hasProfile: null,
      });
      expect(authStore.setHasProfile).toHaveBeenCalledWith(true);
    });

    it('should initialize session without bootstrap if user is not signed up', async () => {
      const mockSession = buildMockSession();
      const mockPubky = TEST_PUBKY as Pubky;

      const z32FromSessionSpy = vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(false);
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize');

      const authStore = storeMocks.getAuthState();
      const signInStore = storeMocks.getSignInState();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(mockAuthStore(authStore));
      vi.spyOn(useSignInStore, 'getState').mockReturnValue(mockSignInStore(signInStore));

      await AuthController.initializeAuthenticatedSession({ session: mockSession });

      expect(signInStore.reset).toHaveBeenCalled();
      expect(signInStore.setAuthUrlResolved).toHaveBeenCalledWith(true);
      expect(z32FromSessionSpy).toHaveBeenCalledWith({ session: mockSession });
      expect(userIsSignedUpSpy).toHaveBeenCalledWith({ pubky: mockPubky });
      expect(signInStore.setProfileChecked).toHaveBeenCalledWith(true);
      expect(initializeSpy).not.toHaveBeenCalled();
      // Session stored early with hasProfile: null, then setHasProfile called after check
      expect(authStore.init).toHaveBeenCalledWith({
        session: mockSession,
        currentUserPubky: mockPubky,
        hasProfile: null,
      });
      expect(authStore.setHasProfile).toHaveBeenCalledWith(false);
    });

    it('should use remote settings for allowedTypes and apply them to store when initializeSettings returns non-null', async () => {
      // Goal: prove that, during session initialization, fresher remote settings
      // drive allowedTypes computation and are applied to settings state.
      const mockSession = buildMockSession();
      const mockPubky = TEST_PUBKY as Pubky;
      const remoteNotificationPrefs: NotificationPreferences = {
        newFriend: true,
        mention: true,
        reply: true,
        follow: false,
        tagPost: false,
        tagProfile: false,
        repost: false,
        postDeleted: false,
        postEdited: false,
      };
      const remoteSettings = createMockSettingsState({
        notifications: remoteNotificationPrefs,
      });
      const remoteAllowedTypes = [NotificationType.Reply, NotificationType.Mention];
      const notification: Omit<NotificationState, 'marketplaceUnread'> = {
        unread: 3,
        lastRead: 789,
        lastPolledTimestamp: 0,
      };

      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(true);
      vi.spyOn(SettingsApplication, 'initializeSettings').mockResolvedValue(remoteSettings);
      vi.spyOn(NotificationNormalizer, 'toEnabledTypes').mockReturnValue(remoteAllowedTypes);
      vi.spyOn(SettingsNormalizer, 'extractState').mockReturnValue(createMockSettingsState());
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize').mockResolvedValue(notification);

      const loadFromHomeserverSpy = vi.fn();
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(
        mockSettingsStore({ loadFromHomeserver: loadFromHomeserverSpy }),
      );

      const authStore = storeMocks.getAuthState();
      const signInStore = storeMocks.getSignInState();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(mockAuthStore(authStore));
      vi.spyOn(useSignInStore, 'getState').mockReturnValue(mockSignInStore(signInStore));

      await AuthController.initializeAuthenticatedSession({ session: mockSession });

      // toEnabledTypes should receive remote notification preferences
      expect(NotificationNormalizer.toEnabledTypes).toHaveBeenCalledWith(remoteNotificationPrefs);
      // Bootstrap should use remote-derived allowedTypes
      expect(initializeSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ allowedTypes: remoteAllowedTypes }));
      // Remote settings applied to store
      expect(loadFromHomeserverSpy).toHaveBeenCalledWith(remoteSettings);
    });

    it('should complete bootstrap when settings sync fails with AppError', async () => {
      // Goal: prove that settings-sync failures do not block authenticated-session
      // bootstrap and that local settings are used as the fallback source.
      const mockSession = buildMockSession();
      const mockPubky = TEST_PUBKY as Pubky;
      const localSettings = createMockSettingsState();

      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(mockPubky);
      vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(true);
      vi.spyOn(SettingsApplication, 'initializeSettings').mockRejectedValue(
        new AppError({
          category: ErrorCategory.Server,
          code: ServerErrorCode.UNKNOWN_ERROR,
          message: 'homeserver unreachable',
          service: ErrorService.Homeserver,
          operation: 'initializeSettings',
        }),
      );
      vi.spyOn(SettingsNormalizer, 'extractState').mockReturnValue(localSettings);

      const notification: Omit<NotificationState, 'marketplaceUnread'> = {
        unread: 0,
        lastRead: 0,
        lastPolledTimestamp: 0,
      };
      const initializeSpy = vi.spyOn(BootstrapApplication, 'initialize').mockResolvedValue(notification);

      const loadFromHomeserverSpy = vi.fn();
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(
        mockSettingsStore({ loadFromHomeserver: loadFromHomeserverSpy }),
      );

      const authStore = storeMocks.getAuthState();
      const signInStore = storeMocks.getSignInState();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(mockAuthStore(authStore));
      vi.spyOn(useSignInStore, 'getState').mockReturnValue(mockSignInStore(signInStore));

      await AuthController.initializeAuthenticatedSession({ session: mockSession });

      // Bootstrap should still complete
      expect(initializeSpy).toHaveBeenCalled();
      expect(storeMocks.notificationInit).toHaveBeenCalledWith(notification);
      // toEnabledTypes should use local preferences (fallback)
      expect(NotificationNormalizer.toEnabledTypes).toHaveBeenCalledWith(localSettings.notifications);
      // Remote settings should NOT be applied
      expect(loadFromHomeserverSpy).not.toHaveBeenCalled();
      // Session flow completes normally
      expect(authStore.setHasProfile).toHaveBeenCalledWith(true);
    });

    it('should sign the session out and rethrow when homeserver environment check fails', async () => {
      const mockSession = buildMockSession();
      const wrongEnvError = Err.auth(AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER, 'wrong env', {
        service: ErrorService.Homeserver,
        operation: 'assertUserHomeserverAllowed',
      });

      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(TEST_PUBKY as Pubky);
      vi.spyOn(AuthApplication, 'assertUserHomeserverAllowed').mockRejectedValue(wrongEnvError);
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp');

      const authStore = storeMocks.getAuthState();
      const signInStore = storeMocks.getSignInState();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(mockAuthStore(authStore));
      vi.spyOn(useSignInStore, 'getState').mockReturnValue(mockSignInStore(signInStore));

      await expect(AuthController.initializeAuthenticatedSession({ session: mockSession })).rejects.toMatchObject({
        code: AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER,
      });

      expect(userIsSignedUpSpy).not.toHaveBeenCalled();
      // The Ring-approved session lives on the user's actual homeserver — it
      // must be signed out, not left dangling after the rejection.
      expect(logoutSpy).toHaveBeenCalledWith({ session: mockSession });
      // Account initialization has not started, but clear the sign-in progress
      // shown as soon as approval arrived so a rejected session can be retried.
      expect(authStore.init).not.toHaveBeenCalled();
      expect(authStore.reset).not.toHaveBeenCalled();
      expect(signInStore.reset).toHaveBeenCalledOnce();
    });

    it('should sign the session out when the environment check fails transiently', async () => {
      // A failed PKARR lookup (not a wrong-env rejection) must not leave the
      // just-approved session dangling on its homeserver either.
      const mockSession = buildMockSession();
      const lookupError = Err.server(ServerErrorCode.INTERNAL_ERROR, 'PKARR relay unavailable', {
        service: ErrorService.Homeserver,
        operation: 'assertUserHomeserverAllowed',
      });

      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(TEST_PUBKY as Pubky);
      vi.spyOn(AuthApplication, 'assertUserHomeserverAllowed').mockRejectedValue(lookupError);
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);

      await expect(AuthController.initializeAuthenticatedSession({ session: mockSession })).rejects.toMatchObject({
        code: ServerErrorCode.INTERNAL_ERROR,
      });

      expect(logoutSpy).toHaveBeenCalledWith({ session: mockSession });
    });
  });

  describe('logout', () => {
    const createAuthStore = (overrides: Partial<AuthStore> = {}): AuthStore =>
      mockAuthStore({
        ...storeMocks.getAuthState(),
        currentUserPubky: 'test-pubky' as Pubky,
        session: buildMockSession(),
        hasProfile: false,
        hasHydrated: false,
        sessionExport: null,
        isRestoringSession: false,
        isLoggingOut: false,
        selectCurrentUserPubky: vi.fn(() => 'test-pubky' as Pubky),
        setHasHydrated: vi.fn(),
        setIsRestoringSession: vi.fn(),
        setIsLoggingOut: vi.fn(),
        setSessionRestoreDeferred: vi.fn(),
        ...overrides,
      });

    const createOnboardingStore = () =>
      mockOnboardingStore({
        secretKey: TEST_SECRET_KEY,
        reset: storeMocks.resetOnboardingStore,
      });

    const createSignInStore = () => mockSignInStore(storeMocks.getSignInState());

    const createLocalFilesStore = () => mockLocalFilesStore(storeMocks.getLocalFilesState());

    beforeEach(() => {
      Object.defineProperty(document, 'cookie', { writable: true, value: '' });
      Object.defineProperty(window, 'location', { writable: true, value: { href: '' } });
      storeMocks.resetAuthStore.mockClear();
      storeMocks.resetOnboardingStore.mockClear();
      storeMocks.resetSignInStore.mockClear();
      storeMocks.resetLocalFilesStore.mockClear();
    });

    it('should successfully logout user, clear stores, cookies and redirect', async () => {
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const cancelModerationFollowSpy = vi.spyOn(BootstrapApplication, 'cancelModerationFollow');
      const clearCookiesSpy = await spyOnClearCookies();
      const clearAllQueryClientsSpy = await spyOnClearAllQueryClients();
      const resetSpy = vi.spyOn(PubkySpecsSingleton, 'reset');
      const clearMarketplaceSessionSpy = vi.spyOn(CommerceApplication, 'clearMarketplaceSessionForSignOut');
      const resetTtlSpy = vi.spyOn(TtlCoordinator, 'resetInstance');
      const resetStreamSpy = vi.spyOn(StreamCoordinator, 'resetInstance');
      const resetNotifCoordSpy = vi.spyOn(NotificationCoordinator, 'resetInstance');
      const postStreamQueueClearSpy = vi.spyOn(postStreamQueue, 'clear');

      const signInStore = createSignInStore();
      const localFilesStore = createLocalFilesStore();
      const homeStore = storeMocks.getHomeState();
      const hotStore = storeMocks.getHotState();
      const searchStore = storeMocks.getSearchState();
      const notificationStore = storeMocks.getNotificationState();
      const settingsStore = storeMocks.getSettingsState();
      const authStore = createAuthStore();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());
      vi.spyOn(useSignInStore, 'getState').mockReturnValue(signInStore);
      vi.spyOn(useLocalFilesStore, 'getState').mockReturnValue(localFilesStore);
      // Partial mocks: only mock the methods under test, cast via `unknown` to satisfy the full store type
      vi.spyOn(useHomeStore, 'getState').mockReturnValue(mockHomeStore(homeStore));
      vi.spyOn(useHotStore, 'getState').mockReturnValue(mockHotStore(hotStore));
      vi.spyOn(useSearchStore, 'getState').mockReturnValue(mockSearchStore(searchStore));
      vi.spyOn(useNotificationStore, 'getState').mockReturnValue(mockNotificationStore(notificationStore));
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(mockSettingsStore(settingsStore));

      document.cookie = 'testCookie=value; path=/';
      document.cookie = 'anotherCookie=anotherValue; path=/';

      const muteSyncCursorKey = `${MUTE_SYNC_CURSOR_STORAGE_PREFIX}test-pubky`;
      sessionStorage.setItem(muteSyncCursorKey, 'cursor-value');

      await AuthController.logout();

      // Homeserver logout
      expect(logoutSpy).toHaveBeenCalledWith({ session: expect.anything() });
      expect(cancelModerationFollowSpy).toHaveBeenCalledTimes(2);
      expect(cancelModerationFollowSpy.mock.invocationCallOrder[0]).toBeLessThan(
        logoutSpy.mock.invocationCallOrder[0]!,
      );
      expect(cancelModerationFollowSpy.mock.invocationCallOrder[1]).toBeLessThan(
        clearDatabaseSpy.mock.invocationCallOrder[0]!,
      );

      // Singletons
      expect(resetSpy).toHaveBeenCalledOnce();
      expect(clearMarketplaceSessionSpy).toHaveBeenCalledOnce();
      expect(resetTtlSpy).toHaveBeenCalledOnce();
      expect(resetStreamSpy).toHaveBeenCalledOnce();
      expect(resetNotifCoordSpy).toHaveBeenCalledOnce();
      expect(postStreamQueueClearSpy).toHaveBeenCalledOnce();

      // Zustand stores
      expect(storeMocks.resetOnboardingStore).toHaveBeenCalledOnce();
      expect(authStore.reset).toHaveBeenCalledOnce();
      expect(signInStore.reset).toHaveBeenCalledOnce();
      expect(localFilesStore.reset).toHaveBeenCalledOnce();
      expect(homeStore.reset).toHaveBeenCalledOnce();
      expect(hotStore.reset).toHaveBeenCalledOnce();
      expect(searchStore.reset).toHaveBeenCalledOnce();
      expect(notificationStore.reset).toHaveBeenCalledOnce();
      expect(settingsStore.reset).toHaveBeenCalledOnce();

      // Query clients
      expect(clearAllQueryClientsSpy).toHaveBeenCalledOnce();

      // Cookies and database
      expect(clearCookiesSpy).toHaveBeenCalledWith();
      expect(clearDatabaseSpy).toHaveBeenCalledOnce();

      // Skip post-migration resync — full cleanup resets all state
      expect(storeMocks.resetMigrationStore).toHaveBeenCalled();

      expect(sessionStorage.getItem(muteSyncCursorKey)).toBeNull();
    });

    it('should log warning and clear local state even when homeserver logout fails', async () => {
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockRejectedValue(new Error('Network error'));
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearCookiesSpy = await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

      const localFilesStore = createLocalFilesStore();
      const authStore = createAuthStore();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());
      vi.spyOn(useLocalFilesStore, 'getState').mockReturnValue(localFilesStore);

      await AuthController.logout();
      expect(logoutSpy).toHaveBeenCalledWith({ session: expect.anything() });
      expect(warnSpy).toHaveBeenCalledWith('Homeserver logout failed, clearing local state anyway', {
        error: expect.any(Error),
      });
      // Local state should still be cleared even if homeserver logout fails
      expect(storeMocks.resetOnboardingStore).toHaveBeenCalled();
      expect(authStore.reset).toHaveBeenCalled();
      expect(localFilesStore.reset).toHaveBeenCalled();
      expect(clearCookiesSpy).toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalledTimes(1);
    });

    it('should restore a persisted session before homeserver logout when only sessionExport exists', async () => {
      const restoredSession = buildMockSession({
        export: vi.fn(() => 'restored-export'),
      });
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearCookiesSpy = await spyOnClearCookies();
      await spyOnClearAllQueryClients();

      const authStore = createAuthStore({
        session: null,
        sessionExport: 'session-export',
      });
      const localFilesStore = createLocalFilesStore();
      const homeStore = storeMocks.getHomeState();
      const hotStore = storeMocks.getHotState();
      const searchStore = storeMocks.getSearchState();
      const notificationStore = storeMocks.getNotificationState();
      const settingsStore = storeMocks.getSettingsState();

      vi.spyOn(useAuthStore, 'getState').mockImplementation(() => authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());
      vi.spyOn(useSignInStore, 'getState').mockReturnValue(createSignInStore());
      vi.spyOn(useLocalFilesStore, 'getState').mockReturnValue(localFilesStore);
      vi.spyOn(useHomeStore, 'getState').mockReturnValue(mockHomeStore(homeStore));
      vi.spyOn(useHotStore, 'getState').mockReturnValue(mockHotStore(hotStore));
      vi.spyOn(useSearchStore, 'getState').mockReturnValue(mockSearchStore(searchStore));
      vi.spyOn(useNotificationStore, 'getState').mockReturnValue(mockNotificationStore(notificationStore));
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue(mockSettingsStore(settingsStore));

      const restorePersistedSessionSpy = vi
        .spyOn(AuthController, 'restorePersistedSession')
        .mockImplementation(async () => {
          authStore.session = restoredSession;
          authStore.sessionExport = null;
          return { status: 'restored' };
        });

      await AuthController.logout();

      expect(restorePersistedSessionSpy).toHaveBeenCalledOnce();
      expect(logoutSpy).toHaveBeenCalledWith({ session: restoredSession });
      expect(clearCookiesSpy).toHaveBeenCalledWith();
      expect(clearDatabaseSpy).toHaveBeenCalledTimes(1);
    });

    it('should not run local cleanup twice when persisted session restore fails', async () => {
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearCookiesSpy = await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);

      const authStore = createAuthStore({
        session: null,
        sessionExport: 'session-export',
      });

      vi.spyOn(useAuthStore, 'getState').mockImplementation(() => authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());
      vi.spyOn(AuthController, 'restorePersistedSession').mockResolvedValue({ status: 'signed-out' });

      await AuthController.logout();

      expect(logoutSpy).not.toHaveBeenCalled();
      expect(clearCookiesSpy).not.toHaveBeenCalled();
      expect(clearDatabaseSpy).not.toHaveBeenCalled();
    });

    it('should reset PubkySpecsSingleton even when homeserver logout fails (issue #538)', async () => {
      vi.spyOn(AuthApplication, 'logout').mockRejectedValue(new Error('Pubky resolution failed'));
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      const resetSpy = vi.spyOn(PubkySpecsSingleton, 'reset');

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(createAuthStore());
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());

      await AuthController.logout();

      // PubkySpecsSingleton should be reset even when homeserver logout fails
      // This ensures users can sign out even when their profile pubky cannot be resolved
      expect(resetSpy).toHaveBeenCalledOnce();
    });

    it('should clear all existing cookies', async () => {
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearCookiesSpy = await spyOnClearCookies();
      await spyOnClearAllQueryClients();

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(createAuthStore());
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());

      document.cookie = 'session=abc123; path=/';
      document.cookie = 'token=xyz789; path=/';
      document.cookie = 'user=john; path=/';

      await AuthController.logout();

      expect(logoutSpy).toHaveBeenCalled();
      expect(clearCookiesSpy).toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalledTimes(1);
    });

    it('suppresses vibe auto-restore and aborts the bridge before any logout await', async () => {
      let suppressedDuringRestore = false;
      let abortCalledBeforeRestore = false;
      const authStore = createAuthStore({
        session: null,
        sessionExport: 'session-export',
      });
      vi.spyOn(useAuthStore, 'getState').mockImplementation(() => authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());
      vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
      const abortSpy = vi.spyOn(AuthApplication, 'abortInFlightBridgeRequest').mockImplementation(() => {});
      vi.spyOn(AuthController, 'restorePersistedSession').mockImplementation(async () => {
        suppressedDuringRestore = vibeSessionAutoRestore.isVibeSessionAutoRestoreSuppressed();
        abortCalledBeforeRestore = abortSpy.mock.calls.length > 0;
        return { status: 'signed-out' };
      });

      await AuthController.logout();

      expect(suppressedDuringRestore).toBe(true);
      expect(abortCalledBeforeRestore).toBe(true);
      expect(vibeSessionAutoRestore.isVibeSessionAutoRestoreSuppressed()).toBe(true);
      vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
    });

    it('does not re-restore from the bridge after consumer logout', async () => {
      const authStore = createAuthStore();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());
      vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
      vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      const restoreAppSpy = vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({
        status: 'signed-out',
      });

      await AuthController.logout();
      expect(vibeSessionAutoRestore.isVibeSessionAutoRestoreSuppressed()).toBe(true);

      restoreAppSpy.mockClear();
      const afterLogout = await AuthController.restorePersistedSession();

      expect(afterLogout).toEqual({ status: 'signed-out' });
      expect(restoreAppSpy).toHaveBeenCalledOnce();
      // Application still runs (RouteGuard may call it) but the flag stays set so the bridge leg is skipped.
      expect(vibeSessionAutoRestore.isVibeSessionAutoRestoreSuppressed()).toBe(true);
      vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
    });

    it('keeps vibe auto-restore suppressed when the homeserver sign-out fails after the internal restore cleared it', async () => {
      const restoredSession = buildMockSession({
        export: vi.fn(() => 'restored-export'),
      });
      const authStore = createAuthStore({
        session: null,
        sessionExport: 'session-export',
      });
      vi.spyOn(useAuthStore, 'getState').mockImplementation(() => authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());
      vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      vi.spyOn(AuthController, 'restorePersistedSession').mockImplementation(async () => {
        // The internal restore's init() clears the suppression set at logout start.
        vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
        authStore.session = restoredSession;
        authStore.sessionExport = null;
        return { status: 'restored' };
      });
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockRejectedValue(new Error('homeserver unreachable'));

      await AuthController.logout();

      expect(logoutSpy).toHaveBeenCalledWith({ session: restoredSession });
      // A failed sign-out must not leave a later reload able to
      // bridge-restore the session the user just logged out of.
      expect(vibeSessionAutoRestore.isVibeSessionAutoRestoreSuppressed()).toBe(true);
      vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
    });

    it('re-applies vibe auto-restore suppression at logout end only in consumer mode', async () => {
      const suppressSpy = vi.spyOn(vibeSessionAutoRestore, 'suppressVibeSessionAutoRestore');
      vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(createAuthStore());
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());

      // Consumer mode off: no bridge leg exists, so logout must not re-apply
      // suppression beyond the initial set at logout start.
      vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(false);
      await AuthController.logout();
      expect(suppressSpy).toHaveBeenCalledTimes(1);

      suppressSpy.mockClear();
      vi.mocked(vibeSessionConfig.isVibeSessionConsumerEnabled).mockReturnValue(true);
      await AuthController.logout();
      expect(suppressSpy).toHaveBeenCalledTimes(2);

      vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
    });

    it('cleans up local state when restore during logout is deferred', async () => {
      const authStore = createAuthStore({
        session: null,
        sessionExport: 'session-export',
      });
      const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      vi.spyOn(useAuthStore, 'getState').mockImplementation(() => authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());
      vi.spyOn(vibeSessionConfig, 'isVibeSessionConsumerEnabled').mockReturnValue(true);
      vi.spyOn(AuthController, 'restorePersistedSession').mockResolvedValue({ status: 'deferred' });
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearCookiesSpy = await spyOnClearCookies();
      await spyOnClearAllQueryClients();

      await AuthController.logout();

      expect(logoutSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith('Homeserver logout failed, clearing local state anyway', {
        error: 'Session restore deferred; homeserver sign-out could not run',
      });
      expect(authStore.reset).toHaveBeenCalled();
      expect(clearCookiesSpy).toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalledTimes(1);
      vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
    });

    it('cleans up local state when restore during logout is deferred with consumer mode off', async () => {
      // A transient restore failure defers (never wipes the export) even with
      // consumer mode off; an explicit logout still cleans local state.
      const authStore = createAuthStore({
        session: null,
        sessionExport: 'session-export',
      });
      const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      vi.spyOn(useAuthStore, 'getState').mockImplementation(() => authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());
      vi.spyOn(AuthController, 'restorePersistedSession').mockResolvedValue({ status: 'deferred' });
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      const clearCookiesSpy = await spyOnClearCookies();
      await spyOnClearAllQueryClients();

      await AuthController.logout();

      expect(logoutSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith('Homeserver logout failed, clearing local state anyway', {
        error: 'Session restore deferred; homeserver sign-out could not run',
      });
      expect(authStore.reset).toHaveBeenCalled();
      expect(clearCookiesSpy).toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalledTimes(1);
      vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
    });

    it('runs local cleanup once when a logout races an in-flight restore', async () => {
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();

      const authStore = createAuthStore({
        session: null,
        sessionExport: 'session-export',
      });
      vi.spyOn(useAuthStore, 'getState').mockImplementation(() => authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());

      // An in-flight restore that only settles once both callers are awaiting it.
      let releaseRestore: (() => void) | undefined;
      const restoreGate = new Promise<void>((resolve) => {
        releaseRestore = resolve;
      });
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockImplementation(async () => {
        await restoreGate;
        return { status: 'signed-out' };
      });

      const restorePromise = AuthController.restorePersistedSession();
      const logoutPromise = AuthController.logout();
      releaseRestore?.();
      await Promise.all([restorePromise, logoutPromise]);

      // Both the route restore and the logout's internal restore ended
      // signed-out; cleanupLocalState must still have run exactly once.
      expect(clearDatabaseSpy).toHaveBeenCalledTimes(1);
      expect(authStore.reset).toHaveBeenCalledTimes(1);
      vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
    });

    it('never re-inits the logged-out identity when the shared restore resolves restored after logout began', async () => {
      const clearDatabaseSpy = mockClearDatabase.mockResolvedValue(undefined);
      await spyOnClearCookies();
      await spyOnClearAllQueryClients();

      const restoredSession = buildMockSession({
        export: vi.fn(() => 'restored-export'),
      });
      const authStore = createAuthStore({
        session: null,
        sessionExport: 'session-export',
        // Mirror the real store: init persists the session so the logout's own
        // finalization can sign it out on the homeserver.
        init: vi.fn((params: { session: AuthStore['session'] }) => {
          authStore.session = params.session;
        }),
      });
      vi.spyOn(useAuthStore, 'getState').mockImplementation(() => authStore);
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      // Same persisted pubky as the restored session: the same-identity branch.
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue('test-pubky' as Pubky);

      // The shared Application restore settles restored only once both
      // Controller callers (RouteGuard restore + the logout's internal
      // restore) are awaiting it.
      let releaseRestore: (() => void) | undefined;
      const restoreGate = new Promise<void>((resolve) => {
        releaseRestore = resolve;
      });
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockImplementation(async () => {
        await restoreGate;
        return { status: 'restored', session: restoredSession };
      });

      const routeRestorePromise = AuthController.restorePersistedSession();
      const logoutPromise = AuthController.logout();
      releaseRestore?.();
      const [routeResult] = await Promise.all([routeRestorePromise, logoutPromise]);

      // The restore that started before the logout treats its stale result as
      // signed-out: it must not re-init the just-logged-out identity.
      expect(routeResult).toEqual({ status: 'signed-out' });
      // Only the logout's own finalization inits (to sign the homeserver
      // session out); the racing restore must not re-persist sessionExport.
      expect(authStore.init).toHaveBeenCalledTimes(1);
      expect(logoutSpy).toHaveBeenCalledWith({ session: restoredSession });
      // Logout suppression survives the race — nothing re-cleared it.
      expect(vibeSessionAutoRestore.isVibeSessionAutoRestoreSuppressed()).toBe(true);
      expect(clearDatabaseSpy).toHaveBeenCalledTimes(1);
      vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
    });

    it('should throw error if clearing the database fails', async () => {
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const clearDatabaseSpy = mockClearDatabase.mockRejectedValue(new Error('clear failed'));
      const clearCookiesSpy = await spyOnClearCookies();
      await spyOnClearAllQueryClients();

      vi.spyOn(useAuthStore, 'getState').mockReturnValue(createAuthStore());
      vi.spyOn(useOnboardingStore, 'getState').mockReturnValue(createOnboardingStore());

      await expect(AuthController.logout()).rejects.toThrow('clear failed');
      expect(logoutSpy).toHaveBeenCalled();
      expect(clearCookiesSpy).toHaveBeenCalled();
      expect(clearDatabaseSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateSignupToken', () => {
    it('should generate signup token successfully', async () => {
      const generateSignupTokenSpy = vi.spyOn(AuthApplication, 'generateSignupToken').mockResolvedValue('test-token');
      const result = await AuthController.generateSignupToken();
      expect(result).toBe('test-token');
      expect(generateSignupTokenSpy).toHaveBeenCalled();
    });
  });

  describe('verifySignupToken', () => {
    it('should return valid when the invite code is valid', async () => {
      const verifySpy = vi.spyOn(AuthApplication, 'verifySignupToken').mockResolvedValue('valid');

      const result = await AuthController.verifySignupToken('YVB2-YFRN-GDY0');

      expect(verifySpy).toHaveBeenCalledWith('YVB2-YFRN-GDY0');
      expect(result).toBe('valid');
    });

    it('should return used when the invite code has already been used', async () => {
      const verifySpy = vi.spyOn(AuthApplication, 'verifySignupToken').mockResolvedValue('used');

      const result = await AuthController.verifySignupToken('YVB2-YFRN-GDY0');

      expect(verifySpy).toHaveBeenCalledWith('YVB2-YFRN-GDY0');
      expect(result).toBe('used');
    });

    it('should return invalid when the invite code is not recognised', async () => {
      const verifySpy = vi.spyOn(AuthApplication, 'verifySignupToken').mockResolvedValue('invalid');

      const result = await AuthController.verifySignupToken('BADC-0DE0-0000');

      expect(verifySpy).toHaveBeenCalledWith('BADC-0DE0-0000');
      expect(result).toBe('invalid');
    });
  });

  describe('grant sessions (Bitkit sign-in)', () => {
    const grantSession = (capabilities: string[] = CAPABILITIES.split(',')) =>
      buildMockSession({
        grant: asOpaque<Session['grant']>({}),
        info: asOpaque<Session['info']>({ publicKey: { z32: () => 'mock-session-pubky' }, capabilities }),
      });

    const grantAuthStore = (overrides: Partial<AuthStore> = {}): AuthStore =>
      mockAuthStore({
        ...storeMocks.getAuthState(),
        currentUserPubky: TEST_PUBKY as Pubky,
        session: null,
        sessionExport: null,
        grantSessionRecordId: null,
        hasProfile: false,
        isRestoringSession: false,
        isLoggingOut: false,
        setIsLoggingOut: vi.fn(),
        setIsRestoringSession: vi.fn(),
        setSessionRestoreDeferred: vi.fn(),
        ...overrides,
      });

    beforeEach(() => {
      storeMocks.resetAuthStore.mockReset();
      localStorage.removeItem(AUTH_EPOCH_KEY);
      clearGrantKeyCleanupPending();
      Object.defineProperty(document, 'cookie', { writable: true, value: '' });
      mockClearDatabase.mockResolvedValue(undefined);
      vi.spyOn(Identity, 'z32FromSession').mockReturnValue(TEST_PUBKY as Pubky);
      vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(false);
    });

    async function approveGrantSignIn(session: Session) {
      vi.spyOn(AuthApplication, 'generateGrantAuthUrl').mockResolvedValue({
        authorizationUrl: 'pubkyauth://signin_grant?caps=x&relay=r&secret=s&cid=shop.pubky.app&cpk=k',
        awaitApproval: Promise.resolve(session),
        cancelAuthFlow: vi.fn(),
      });
      const { awaitApproval } = await AuthController.getGrantAuthUrl();
      return await awaitApproval;
    }

    it('grant sign-in persists record id not export', async () => {
      const session = grantSession();
      const authStore = grantAuthStore();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      const saveSpy = vi.spyOn(AuthApplication, 'saveGrantSession').mockResolvedValue('rec-1');

      await AuthController.initializeAuthenticatedSession({ session: await approveGrantSignIn(session) });

      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledWith(session);
      expect(authStore.init).toHaveBeenCalledWith(
        expect.objectContaining({
          session,
          currentUserPubky: TEST_PUBKY,
          grantSessionRecordId: 'rec-1',
          grantSigner: 'bitkit',
        }),
      );
    });

    it('a Pubky Passport sign-in is saved as a grant record marked as Passport-approved', async () => {
      const session = grantSession();
      const authStore = grantAuthStore();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'saveGrantSession').mockResolvedValue('rec-passport');
      const callbacks = {
        xSource: 'Pubky Shop',
        xSuccess: 'https://shop.pubky.app/auth/passport/return?outcome=success',
        xError: 'https://shop.pubky.app/auth/passport/return?outcome=error',
        xCancel: 'https://shop.pubky.app/auth/passport/return?outcome=cancel',
      };
      const generate = vi.spyOn(AuthApplication, 'generateGrantAuthUrl').mockResolvedValue({
        authorizationUrl: 'pubkyauth://signin_grant?caps=x&relay=r&secret=s&cid=shop.pubky.app&cpk=k',
        awaitApproval: Promise.resolve(session),
        cancelAuthFlow: vi.fn(),
      });

      const { awaitApproval } = await AuthController.getPassportGrantAuthUrl(callbacks);
      await AuthController.initializeAuthenticatedSession({ session: await awaitApproval });

      expect(generate).toHaveBeenCalledWith(callbacks);
      expect(authStore.init).toHaveBeenCalledWith(
        expect.objectContaining({ session, grantSessionRecordId: 'rec-passport', grantSigner: 'passport' }),
      );
    });

    it('a restored Passport grant session keeps its Passport mark', async () => {
      const session = grantSession();
      const authStore = grantAuthStore({
        session: null,
        grantSessionRecordId: 'rec-passport',
        grantSigner: 'passport',
        hasProfile: true,
      });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockResolvedValue({ status: 'restored', session });

      await expect(AuthController.restorePersistedSession()).resolves.toEqual({ status: 'restored' });

      expect(authStore.init).toHaveBeenCalledWith(
        expect.objectContaining({ session, grantSessionRecordId: 'rec-passport', grantSigner: 'passport' }),
      );
    });

    it('accepts an approval that carries the scoped-keys scope, as approved or with e declined', async () => {
      for (const capabilities of [KEYED_CAPABILITIES, `${CAPABILITIES},${PRIV_KEYS_SCOPE_DECLINED}`]) {
        const session = grantSession(capabilities.split(','));
        vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore());
        await expect(approveGrantSignIn(session)).resolves.toBe(session);
      }
    });

    it('passes the request for keys, or the sign-in without them, through to the application', async () => {
      const generate = vi.spyOn(AuthApplication, 'generateGrantAuthUrl').mockResolvedValue({
        authorizationUrl: 'pubkyauth://signin_grant?caps=x&relay=r&secret=s&cid=shop.pubky.app&cpk=k',
        awaitApproval: new Promise<Session>(() => undefined),
        cancelAuthFlow: vi.fn(),
      });

      await AuthController.getGrantAuthUrl();
      expect(generate).toHaveBeenLastCalledWith();
      await AuthController.getGrantAuthUrl({ withPrivKeys: false });
      expect(generate).toHaveBeenLastCalledWith(undefined, { withPrivKeys: false });
      await AuthController.getPassportGrantAuthUrl({ xSource: 'Pubky Shop' }, { withPrivKeys: false });
      expect(generate).toHaveBeenLastCalledWith({ xSource: 'Pubky Shop' }, { withPrivKeys: false });
      AuthController.cancelAllAuthFlows();
    });

    it('an approval narrower than the Shop grant is signed out and never saved', async () => {
      const session = grantSession(['/pub/pubky.app/:rw']);
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore());
      const saveSpy = vi.spyOn(AuthApplication, 'saveGrantSession').mockResolvedValue('rec-1');
      const logoutSpy = vi.spyOn(HomeserverService, 'logout').mockResolvedValue(undefined);

      await expect(approveGrantSignIn(session)).rejects.toMatchObject({ code: ValidationErrorCode.INVALID_INPUT });
      expect(logoutSpy).toHaveBeenCalledWith({ session });
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it('a failed save signs the grant out, removes its keys and surfaces the failure', async () => {
      const order: string[] = [];
      const session = grantSession();
      const authStore = grantAuthStore();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      const saveFailure = new Error('IndexedDB write failed');
      vi.spyOn(AuthApplication, 'saveGrantSession').mockRejectedValue(saveFailure);
      vi.spyOn(AuthApplication, 'logout').mockImplementation(async () => {
        order.push('signout');
      });
      vi.spyOn(AuthApplication, 'clearGrantSessions').mockImplementation(async () => {
        order.push('clearAll');
      });

      const approved = await approveGrantSignIn(session);
      await expect(AuthController.initializeAuthenticatedSession({ session: approved })).rejects.toBe(saveFailure);

      expect(order).toEqual(['signout', 'clearAll']);
      expect(authStore.init).not.toHaveBeenCalled();
    });

    /** In-memory BrowserSessionStore behind `clearGrantSessions`: fails `failures` times, then empties. */
    function fakeGrantStore(records: string[], failures: number) {
      let remainingFailures = failures;
      const clear = vi.spyOn(AuthApplication, 'clearGrantSessions').mockImplementation(async () => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw grantKeyRemovalFailed('clearGrantSessions', null);
        }
        records.splice(0);
      });
      return { records, clear };
    }

    it('a failed save whose key removal also fails keeps the cleanup, and the next Bitkit sign-in empties the store first', async () => {
      const session = grantSession();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore());
      vi.spyOn(AuthApplication, 'saveGrantSession').mockRejectedValue(new Error('IndexedDB write failed'));
      vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const store = fakeGrantStore(['partial-record'], 1);

      const approved = await approveGrantSignIn(session);
      await expect(AuthController.initializeAuthenticatedSession({ session: approved })).rejects.toThrow(
        'IndexedDB write failed',
      );
      expect(store.records).toEqual(['partial-record']);
      expect(isGrantKeyCleanupPending()).toBe(true);

      const order: string[] = [];
      store.clear.mockImplementation(async () => {
        order.push('clear');
        store.records.splice(0);
      });
      vi.spyOn(AuthApplication, 'generateGrantAuthUrl').mockImplementation(async () => {
        order.push('new-flow');
        return {
          authorizationUrl: 'pubkyauth://signin_grant?x',
          awaitApproval: new Promise(() => {}),
          cancelAuthFlow: vi.fn(),
        };
      });
      await AuthController.getGrantAuthUrl();

      expect(order).toEqual(['clear', 'new-flow']);
      expect(store.records).toEqual([]);
      expect(isGrantKeyCleanupPending()).toBe(false);
    });

    it('the next load removes grant keys a failed cleanup left behind', async () => {
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore());
      const store = fakeGrantStore(['stranded'], 1);
      markGrantKeyCleanupPending();

      await expect(AuthController.settlePendingGrantKeyCleanup()).resolves.toBe(false);
      expect(isGrantKeyCleanupPending()).toBe(true);

      await expect(AuthController.settlePendingGrantKeyCleanup()).resolves.toBe(true);
      expect(store.records).toEqual([]);
      expect(isGrantKeyCleanupPending()).toBe(false);
    });

    it('a pending cleanup leaves a signed-in grant session alone until its sign-out removes every key', async () => {
      const authStore = grantAuthStore({ session: grantSession(), grantSessionRecordId: 'rec-live' });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const store = fakeGrantStore(['rec-live', 'stranded'], 0);
      markGrantKeyCleanupPending();

      await expect(AuthController.settlePendingGrantKeyCleanup()).resolves.toBe(false);
      expect(store.clear).not.toHaveBeenCalled();
      expect(isGrantKeyCleanupPending()).toBe(true);

      await AuthController.logout();

      expect(store.records).toEqual([]);
      expect(isGrantKeyCleanupPending()).toBe(false);
    });

    it('a successful grant save drops only the marker it set', async () => {
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore());
      vi.spyOn(AuthApplication, 'saveGrantSession').mockResolvedValue('rec-1');

      await AuthController.initializeAuthenticatedSession({ session: await approveGrantSignIn(grantSession()) });
      expect(isGrantKeyCleanupPending()).toBe(false);

      vi.spyOn(AuthApplication, 'clearGrantSessions').mockRejectedValue(
        grantKeyRemovalFailed('clearGrantSessions', null),
      );
      markGrantKeyCleanupPending();
      await AuthController.initializeAuthenticatedSession({ session: await approveGrantSignIn(grantSession()) });
      expect(isGrantKeyCleanupPending()).toBe(true);
    });

    it('save aborts after a sign-out since QR start', async () => {
      const session = grantSession();
      const authStore = grantAuthStore();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      const saveSpy = vi.spyOn(AuthApplication, 'saveGrantSession').mockResolvedValue('rec-1');
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);

      const approved = await approveGrantSignIn(session);
      // Another tab (or this one) signed out between QR start and completion.
      bumpAuthEpoch();

      await expect(AuthController.initializeAuthenticatedSession({ session: approved })).rejects.toBeDefined();
      expect(saveSpy).not.toHaveBeenCalled();
      expect(authStore.init).not.toHaveBeenCalled();
      expect(logoutSpy).toHaveBeenCalledWith({ session });
    });

    it('second tab cannot save after sign-out', async () => {
      // Tab B started its grant QR; tab A then signed out (epoch bumped under the lock).
      const session = grantSession();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore());
      const saveSpy = vi.spyOn(AuthApplication, 'saveGrantSession').mockResolvedValue('rec-2');
      vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const approved = await approveGrantSignIn(session);
      localStorage.setItem(AUTH_EPOCH_KEY, String(readAuthEpoch() + 1));

      await expect(AuthController.initializeAuthenticatedSession({ session: approved })).rejects.toBeDefined();
      expect(saveSpy).not.toHaveBeenCalled();
    });

    describe('first approval wins between the Ring and Bitkit QRs', () => {
      const marketplaceBearer = {
        pubky: TEST_PUBKY as Pubky,
        capabilities: '',
        expiresAt: '2026-10-01T00:00:00.000Z',
        issuedAt: '2026-09-24T00:00:00.000Z',
      };

      function mockRingCeremony(ceremony: Promise<{ session: Session; marketplace: typeof marketplaceBearer | null }>) {
        vi.spyOn(AuthApplication, 'startDirectSignInFlow').mockReturnValue({
          authorizationUrl: 'pubkyauth://signin?caps=x&relay=r&secret=s',
          awaitToken: async () => asOpaque<AuthToken>({}),
          cancelAuthFlow: vi.fn(),
        });
        vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockReturnValue(
          ceremony.then((result) => ({ ...result, marketplaceError: null })),
        );
      }

      beforeEach(() => {
        AuthController.resetSignInCeremonyGuard();
        AuthController.cancelAllAuthFlows();
      });

      it('a late Ring approval for the same identity cannot replace a Bitkit sign-in that won', async () => {
        const grant = grantSession();
        const ring = buildMockSession();
        const authStore = grantAuthStore();
        vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
        vi.spyOn(AuthApplication, 'saveGrantSession').mockResolvedValue('rec-1');
        const removeSpy = vi.spyOn(AuthApplication, 'removeGrantSession').mockResolvedValue(undefined);
        const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
        const clearSpy = vi.spyOn(CommerceController, 'clearMarketplaceSession');
        mockRingCeremony(Promise.resolve({ session: ring, marketplace: marketplaceBearer }));

        // Both approvals are in hand before either completes.
        const ringApproval = await (await AuthController.getAuthUrl()).awaitApproval;
        const grantApproval = await approveGrantSignIn(grant);

        await AuthController.initializeAuthenticatedSession({ session: grantApproval });
        await expect(AuthController.initializeAuthenticatedSession({ session: ringApproval })).rejects.toMatchObject({
          name: 'AuthFlowCanceled',
        });

        expect(authStore.init).toHaveBeenCalledTimes(1);
        expect(authStore.init).toHaveBeenCalledWith(
          expect.objectContaining({ session: grant, grantSessionRecordId: 'rec-1' }),
        );
        expect(authStore.reset).not.toHaveBeenCalled();
        expect(removeSpy).not.toHaveBeenCalled();
        expect(logoutSpy).toHaveBeenCalledWith({ session: ring });
        expect(logoutSpy).not.toHaveBeenCalledWith({ session: grant });
        expect(clearSpy).toHaveBeenCalledTimes(1);
      });

      it('a late Ring approval for another identity is signed out without touching the Bitkit sign-in', async () => {
        const grant = grantSession();
        const ring = buildMockSession();
        vi.spyOn(Identity, 'z32FromSession').mockImplementation(
          ({ session }) => (session === ring ? 'other-pubky' : TEST_PUBKY) as Pubky,
        );
        const authStore = grantAuthStore();
        vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
        vi.spyOn(AuthApplication, 'saveGrantSession').mockResolvedValue('rec-1');
        const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
        mockRingCeremony(Promise.resolve({ session: ring, marketplace: null }));

        const ringApproval = await (await AuthController.getAuthUrl()).awaitApproval;
        await AuthController.initializeAuthenticatedSession({ session: await approveGrantSignIn(grant) });
        await expect(AuthController.initializeAuthenticatedSession({ session: ringApproval })).rejects.toMatchObject({
          name: 'AuthFlowCanceled',
        });

        expect(authStore.init).toHaveBeenCalledTimes(1);
        expect(authStore.reset).not.toHaveBeenCalled();
        expect(logoutSpy).toHaveBeenCalledWith({ session: ring });
      });

      it('a Ring approval still inside its dual POST when Bitkit wins never writes its bearer', async () => {
        const grant = grantSession();
        const ring = buildMockSession();
        const authStore = grantAuthStore();
        vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
        vi.spyOn(AuthApplication, 'saveGrantSession').mockResolvedValue('rec-1');
        const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
        const writeSpy = vi.spyOn(CommerceController, 'writeMarketplaceSessionStore');
        const clearSpy = vi.spyOn(CommerceController, 'clearMarketplaceSession');
        let finishDualPost!: (result: { session: Session; marketplace: typeof marketplaceBearer }) => void;
        mockRingCeremony(
          new Promise((resolve) => {
            finishDualPost = resolve;
          }),
        );

        const { awaitApproval: ringApproval } = await AuthController.getAuthUrl();
        await vi.waitFor(() => expect(AuthApplication.completeSingleApprovalCeremony).toHaveBeenCalled());
        await AuthController.initializeAuthenticatedSession({ session: await approveGrantSignIn(grant) });
        finishDualPost({ session: ring, marketplace: marketplaceBearer });

        await expect(ringApproval).rejects.toMatchObject({ name: 'AuthFlowCanceled' });
        expect(writeSpy).not.toHaveBeenCalled();
        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect(logoutSpy).toHaveBeenCalledWith({ session: ring });
        expect(authStore.init).toHaveBeenCalledTimes(1);
      });

      it('a late Bitkit approval cannot replace a Ring sign-in that won, and keeps the Ring bearer', async () => {
        const grant = grantSession();
        const ring = buildMockSession();
        const authStore = grantAuthStore();
        vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
        const saveSpy = vi.spyOn(AuthApplication, 'saveGrantSession').mockResolvedValue('rec-1');
        const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
        const clearSpy = vi.spyOn(CommerceController, 'clearMarketplaceSession');
        mockRingCeremony(Promise.resolve({ session: ring, marketplace: marketplaceBearer }));

        const ringApproval = await (await AuthController.getAuthUrl()).awaitApproval;
        const grantApproval = await approveGrantSignIn(grant);

        await AuthController.initializeAuthenticatedSession({ session: ringApproval });
        await expect(AuthController.initializeAuthenticatedSession({ session: grantApproval })).rejects.toMatchObject({
          name: 'AuthFlowCanceled',
        });

        expect(authStore.init).toHaveBeenCalledTimes(1);
        expect(authStore.init).toHaveBeenCalledWith(expect.objectContaining({ session: ring }));
        expect(saveSpy).not.toHaveBeenCalled();
        expect(logoutSpy).toHaveBeenCalledWith({ session: grant });
        expect(logoutSpy).not.toHaveBeenCalledWith({ session: ring });
        expect(clearSpy).not.toHaveBeenCalled();
      });
    });

    it('signout calls signout then clearAll under lock', async () => {
      const order: string[] = [];
      const session = grantSession();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore({ session, grantSessionRecordId: 'rec-1' }));
      vi.spyOn(AuthApplication, 'logout').mockImplementation(async () => {
        order.push('signout');
      });
      vi.spyOn(AuthApplication, 'clearGrantSessions').mockImplementation(async () => {
        order.push('clearAll');
      });
      const epochBefore = readAuthEpoch();

      await AuthController.logout();

      expect(order).toEqual(['signout', 'clearAll']);
      expect(readAuthEpoch()).toBe(epochBefore + 1);
    });

    it('cold logout calls signout before clearAll', async () => {
      const order: string[] = [];
      const session = grantSession();
      const authStore = grantAuthStore({ session: null, grantSessionRecordId: 'rec-1' });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthController, 'restorePersistedSession').mockImplementation(async () => {
        order.push('restore');
        authStore.session = session;
        return { status: 'restored' };
      });
      vi.spyOn(AuthApplication, 'logout').mockImplementation(async () => {
        order.push('signout');
      });
      vi.spyOn(AuthApplication, 'clearGrantSessions').mockImplementation(async () => {
        order.push('clearAll');
      });

      await AuthController.logout();

      expect(order).toEqual(['restore', 'signout', 'clearAll']);
    });

    it('cold logout still clears grant keys when the restore fails', async () => {
      const authStore = grantAuthStore({ session: null, grantSessionRecordId: 'rec-1' });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthController, 'restorePersistedSession').mockResolvedValue({ status: 'signed-out' });
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const clearSpy = vi.spyOn(AuthApplication, 'clearGrantSessions').mockResolvedValue(undefined);

      await AuthController.logout();

      expect(logoutSpy).not.toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    function listenForSignedOut() {
      const heard = vi.fn();
      const unsubscribe = subscribeSignedOut(heard);
      return { heard, unsubscribe };
    }

    it('warm logout removes the grant key before it clears the record pointer', async () => {
      const order: string[] = [];
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(
        grantAuthStore({ session: grantSession(), grantSessionRecordId: 'rec-1' }),
      );
      vi.spyOn(AuthApplication, 'logout').mockImplementation(async () => {
        order.push('signout');
      });
      vi.spyOn(AuthApplication, 'clearGrantSessions').mockImplementation(async () => {
        order.push('clearAll');
      });
      storeMocks.resetAuthStore.mockImplementation(() => {
        order.push('clear-pointer');
      });

      await AuthController.logout();

      expect(order).toEqual(['signout', 'clearAll', 'clear-pointer']);
    });

    it('warm logout fails and keeps the record pointer when the grant key cannot be removed', async () => {
      const authStore = grantAuthStore({ session: grantSession(), grantSessionRecordId: 'rec-1' });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      vi.spyOn(AuthApplication, 'clearGrantSessions').mockRejectedValue(
        grantKeyRemovalFailed('clearGrantSessions', null),
      );
      const { heard, unsubscribe } = listenForSignedOut();

      try {
        const failure = await AuthController.logout().catch((error: unknown) => error);

        expect(isGrantKeyRemovalError(failure)).toBe(true);
        expect(storeMocks.resetAuthStore).not.toHaveBeenCalled();
        expect(authStore.setIsLoggingOut).toHaveBeenLastCalledWith(false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(heard).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });

    it('cold logout fails and keeps the record pointer when the grant key cannot be removed', async () => {
      const authStore = grantAuthStore({ session: null, grantSessionRecordId: 'rec-1' });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      // The restore could not remove its record either, so it kept the pointer.
      vi.spyOn(AuthController, 'restorePersistedSession').mockResolvedValue({ status: 'deferred' });
      vi.spyOn(AuthApplication, 'clearGrantSessions').mockRejectedValue(
        grantKeyRemovalFailed('clearGrantSessions', null),
      );
      const { heard, unsubscribe } = listenForSignedOut();

      try {
        const failure = await AuthController.logout().catch((error: unknown) => error);

        expect(isGrantKeyRemovalError(failure)).toBe(true);
        expect(storeMocks.resetAuthStore).not.toHaveBeenCalled();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(heard).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });

    it('expiry cleanup keeps the record pointer when its grant key cannot be removed', async () => {
      const authStore = grantAuthStore({ session: null, grantSessionRecordId: 'rec-1' });
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(authStore);
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockRejectedValue(
        grantKeyRemovalFailed('removeGrantSession', null),
      );

      await expect(AuthController.restorePersistedSession()).resolves.toEqual({ status: 'deferred' });

      expect(authStore.setSessionRestoreDeferred).toHaveBeenCalledWith(true);
      expect(storeMocks.resetAuthStore).not.toHaveBeenCalled();
    });

    it('cross-tab finalization removes this tab record before it clears the pointer', async () => {
      const order: string[] = [];
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(
        grantAuthStore({ session: grantSession(), grantSessionRecordId: 'rec-1' }),
      );
      vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      const removeSpy = vi.spyOn(AuthApplication, 'removeGrantSession').mockImplementation(async () => {
        order.push('remove');
      });
      storeMocks.resetAuthStore.mockImplementation(() => {
        order.push('clear-pointer');
      });

      await AuthController.handleCrossTabSignOut();

      expect(removeSpy).toHaveBeenCalledWith('rec-1');
      expect(order).toEqual(['remove', 'clear-pointer']);
    });

    it('cross-tab finalization keeps the tab signed in when its grant key cannot be removed', async () => {
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(
        grantAuthStore({ session: grantSession(), grantSessionRecordId: 'rec-1' }),
      );
      vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      vi.spyOn(AuthApplication, 'removeGrantSession').mockRejectedValue(
        grantKeyRemovalFailed('removeGrantSession', null),
      );

      await AuthController.handleCrossTabSignOut();

      expect(storeMocks.resetAuthStore).not.toHaveBeenCalled();
    });

    it('a #s= hand-off waits for the prompt and only a yes passes through', async () => {
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore({ currentUserPubky: null }));
      let answer: boolean | undefined;
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockImplementation(async ({ confirmSessionHandoff }) => {
        answer = await confirmSessionHandoff?.('handoff-pubky' as Pubky);
        return { status: 'deferred' };
      });

      const restoring = AuthController.restorePersistedSession();
      await vi.waitFor(() => expect(useSessionHandoffStore.getState().pendingPubky).toBe('handoff-pubky'));
      expect(answer).toBeUndefined();
      AuthController.answerSessionHandoff(true);
      await restoring;

      expect(answer).toBe(true);
      expect(useSessionHandoffStore.getState().pendingPubky).toBeNull();
    });

    it('logout declines an unanswered #s= prompt', async () => {
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore({ currentUserPubky: null }));
      let answer: boolean | undefined;
      vi.spyOn(AuthApplication, 'restorePersistedSession').mockImplementation(async ({ confirmSessionHandoff }) => {
        answer = await confirmSessionHandoff?.('handoff-pubky' as Pubky);
        return { status: 'deferred' };
      });
      const restoring = AuthController.restorePersistedSession();
      await vi.waitFor(() => expect(useSessionHandoffStore.getState().pendingPubky).toBe('handoff-pubky'));

      vi.spyOn(AuthApplication, 'clearGrantSessions').mockResolvedValue(undefined);
      await AuthController.logout();
      await restoring;

      expect(answer).toBe(false);
      expect(useSessionHandoffStore.getState().pendingPubky).toBeNull();
    });

    it('a grant session is refused a step-up and no Ring flow starts', async () => {
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore({ session: grantSession() }));
      const ringFlow = vi.spyOn(AuthApplication, 'generateAuthUrl');

      await expect(AuthController.getStepUpAuthUrl()).rejects.toMatchObject({ code: AuthErrorCode.UNAUTHORIZED });
      expect(ringFlow).not.toHaveBeenCalled();
    });

    it('logout tells other tabs to let go', async () => {
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore({ session: grantSession() }));
      vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
      vi.spyOn(AuthApplication, 'clearGrantSessions').mockResolvedValue(undefined);
      const received = new Promise<void>((resolve) => {
        const unsubscribe = subscribeSignedOut(() => {
          unsubscribe();
          resolve();
        });
      });

      await AuthController.logout();

      await expect(received).resolves.toBeUndefined();
    });

    it('second tab drops live grant session on broadcast', async () => {
      const session = grantSession();
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore({ session }));
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);

      await AuthController.handleCrossTabSignOut();

      expect(logoutSpy).toHaveBeenCalledWith({ session });
      expect(storeMocks.resetAuthStore).toHaveBeenCalled();
    });

    it('a cookie session ignores the cross-tab broadcast', async () => {
      vi.spyOn(useAuthStore, 'getState').mockReturnValue(grantAuthStore({ session: buildMockSession() }));
      const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);

      await AuthController.handleCrossTabSignOut();

      expect(logoutSpy).not.toHaveBeenCalled();
    });
  });
});
