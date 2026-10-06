import type { AuthToken, Keypair, Session } from '@synonymdev/pubky';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApplication, isDefinitiveSessionAuthFailure } from '@/application/auth/auth';
import type { THomeserverAuthenticateParams } from '@/application/auth/auth.types';
import { CAPABILITIES } from '@/config/app';
import { getHomeserver, isStagingHomeserverDeploy } from '@/config/network';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode, ClientErrorCode, NetworkErrorCode, ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { isWrongEnvironmentHomeserverError } from '@/libs/error/error.utils';
import { HttpMethod } from '@/libs/http/http.types';
import * as vibeSessionAutoRestore from '@/libs/vibe-session/auto-restore';
import * as vibeSessionBridge from '@/libs/vibe-session/bridge';
import * as vibeSessionConfig from '@/libs/vibe-session/config';
import * as vibeSessionFragment from '@/libs/vibe-session/fragment';
import type { Pubky } from '@/models/models.types';
import { grantKeyRemovalFailed, isGrantKeyRemovalError } from '@/services/homeserver/error.utils';
import { HomeserverService } from '@/services/homeserver/homeserver';
import type { THomeserverSignUpParams } from '@/services/homeserver/homeserver.types';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { mockSession } from '@/test-utils/pubky';
import { mockAuthStore } from '@/test-utils/stores';
import { asOpaque } from '@/test-utils/type-assertions';

const spyOnSleep = async () => vi.spyOn(await import('@/libs/utils/utils'), 'sleep').mockResolvedValue(undefined);

vi.mock('pubky-app-specs', () => ({
  default: vi.fn(() => Promise.resolve()),
  userUriBuilder: (pubky: string) => `pubky://${pubky}/pub/pubky.app/profile.json`,
}));

// Default to the real implementations; individual tests override the staging
// gate so the homeserver environment guard can be exercised for real.
vi.mock('@/config/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/network')>();
  return {
    ...actual,
    isStagingHomeserverDeploy: vi.fn(actual.isStagingHomeserverDeploy),
    getHomeserver: vi.fn(actual.getHomeserver),
  };
});

describe('AuthApplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('signUp', () => {
    const createParams = (): THomeserverSignUpParams => ({
      keypair: asOpaque<Keypair>({
        publicKey: vi.fn(() => ({ z32: () => 'test-pubky' })),
        secret: vi.fn(() => new Uint8Array([1, 2, 3])),
      }),
      signupToken: 'test-signup-token',
    });

    it('should sign up successfully', async () => {
      const params = createParams();
      const session = asOpaque<Session>({ token: 'test-token' });
      const expectedResult = { session };

      const signUpSpy = vi.spyOn(HomeserverService, 'signUp').mockResolvedValue(expectedResult);

      const result = await AuthApplication.signUp(params);

      expect(signUpSpy).toHaveBeenCalledWith({ keypair: params.keypair, signupToken: params.signupToken });
      expect(result).toEqual(expectedResult);
    });

    it('should propagate error when signup fails', async () => {
      const params = createParams();
      const signUpSpy = vi.spyOn(HomeserverService, 'signUp').mockRejectedValue(new Error('Signup failed'));

      await expect(AuthApplication.signUp(params)).rejects.toThrow('Signup failed');
      expect(signUpSpy).toHaveBeenCalledOnce();
    });
  });

  describe('signIn', () => {
    const createParams = (): THomeserverAuthenticateParams => ({
      keypair: asOpaque<Keypair>({
        publicKey: vi.fn(() => ({ z32: () => 'test-pubky' })),
        secret: vi.fn(() => new Uint8Array([1, 2, 3])),
      }),
      secretKey: 'test-secret-key',
    });

    it('should successfully authenticate and return result', async () => {
      const params = createParams();
      const session = asOpaque<Session>({ token: 'test-token' });
      const expectedResult = { session };

      const signInSpy = vi.spyOn(HomeserverService, 'signIn').mockResolvedValue(expectedResult);

      const result = await AuthApplication.signIn(params);

      expect(signInSpy).toHaveBeenCalledWith({ keypair: params.keypair });
      expect(result).toEqual(expectedResult);
    });

    it('should return undefined when homeserver is not found during authentication', async () => {
      const params = createParams();
      const signInSpy = vi.spyOn(HomeserverService, 'signIn').mockResolvedValue(undefined);

      const result = await AuthApplication.signIn(params);

      expect(signInSpy).toHaveBeenCalledWith({ keypair: params.keypair });
      expect(result).toBeUndefined();
    });

    it('should propagate error when authentication throws', async () => {
      const params = createParams();
      const signInSpy = vi.spyOn(HomeserverService, 'signIn').mockRejectedValue(new Error('Authentication failed'));

      await expect(AuthApplication.signIn(params)).rejects.toThrow('Authentication failed');
      expect(signInSpy).toHaveBeenCalledOnce();
    });
  });

  describe('generateAuthUrl', () => {
    it('should generate and return auth URL', async () => {
      const session = asOpaque<Session>({ token: 'test-token' });
      const cancelAuthFlow = vi.fn();
      const expectedResult = {
        authorizationUrl: 'https://example.com/auth?token=test-token',
        awaitApproval: Promise.resolve(session),
        cancelAuthFlow,
      };

      const generateAuthUrlSpy = vi.spyOn(HomeserverService, 'generateAuthUrl').mockResolvedValue(expectedResult);

      const result = await AuthApplication.generateAuthUrl();

      expect(generateAuthUrlSpy).toHaveBeenCalled();
      expect(result).toEqual(expectedResult);
    });

    it('should propagate error when URL generation fails', async () => {
      const generateAuthUrlSpy = vi
        .spyOn(HomeserverService, 'generateAuthUrl')
        .mockRejectedValue(new Error('Failed to generate auth URL'));

      await expect(AuthApplication.generateAuthUrl()).rejects.toThrow('Failed to generate auth URL');
      expect(generateAuthUrlSpy).toHaveBeenCalledOnce();
    });
  });

  describe('logout', () => {
    it('should successfully logout', async () => {
      const session = mockSession({ signout: vi.fn() });
      const params = { session };
      const logoutSpy = vi.spyOn(HomeserverService, 'logout').mockResolvedValue(undefined);

      await AuthApplication.logout(params);

      expect(logoutSpy).toHaveBeenCalledWith(params);
    });

    it('should propagate error when logout fails', async () => {
      const session = mockSession({ signout: vi.fn() });
      const params = { session };
      const logoutSpy = vi.spyOn(HomeserverService, 'logout').mockRejectedValue(new Error('Logout failed'));

      await expect(AuthApplication.logout(params)).rejects.toThrow('Logout failed');
      expect(logoutSpy).toHaveBeenCalledOnce();
    });
  });

  describe('generateSignupToken', () => {
    it('should generate signup token successfully', async () => {
      const generateSignupTokenSpy = vi.spyOn(HomeserverService, 'generateSignupToken').mockResolvedValue('test-token');

      const result = await AuthApplication.generateSignupToken();

      expect(generateSignupTokenSpy).toHaveBeenCalled();
      expect(result).toBe('test-token');
    });

    it('should propagate error when signup token generation fails', async () => {
      const generateSignupTokenSpy = vi
        .spyOn(HomeserverService, 'generateSignupToken')
        .mockRejectedValue(new Error('Failed to generate signup token'));

      await expect(AuthApplication.generateSignupToken()).rejects.toThrow('Failed to generate signup token');
      expect(generateSignupTokenSpy).toHaveBeenCalledOnce();
    });
  });

  describe('verifySignupToken', () => {
    it('should return valid when the homeserver reports the token is valid', async () => {
      const verifySpy = vi.spyOn(HomeserverService, 'verifySignupToken').mockResolvedValue('valid');

      const result = await AuthApplication.verifySignupToken('YVB2-YFRN-GDY0');

      expect(verifySpy).toHaveBeenCalledWith('YVB2-YFRN-GDY0');
      expect(result).toBe('valid');
    });

    it('should return used when the homeserver reports the token is used', async () => {
      const verifySpy = vi.spyOn(HomeserverService, 'verifySignupToken').mockResolvedValue('used');

      const result = await AuthApplication.verifySignupToken('YVB2-YFRN-GDY0');

      expect(verifySpy).toHaveBeenCalledWith('YVB2-YFRN-GDY0');
      expect(result).toBe('used');
    });

    it('should return invalid when the homeserver does not recognise the token', async () => {
      const verifySpy = vi.spyOn(HomeserverService, 'verifySignupToken').mockResolvedValue('invalid');

      const result = await AuthApplication.verifySignupToken('BADC-0DE0-0000');

      expect(verifySpy).toHaveBeenCalledWith('BADC-0DE0-0000');
      expect(result).toBe('invalid');
    });
  });

  describe('restorePersistedSession', () => {
    const createMockAuthStore = (sessionExport: string | null = 'mock-session-export') =>
      mockAuthStore({
        sessionExport,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

    const createNetworkError = () =>
      new AppError({
        category: ErrorCategory.Network,
        code: NetworkErrorCode.CONNECTION_FAILED,
        message: 'ERR_NETWORK_CHANGED',
        service: ErrorService.Homeserver,
        operation: 'restoreSession',
      });

    const createAuthError = () =>
      new AppError({
        category: ErrorCategory.Auth,
        code: AuthErrorCode.SESSION_EXPIRED,
        message: 'Session expired',
        service: ErrorService.Homeserver,
        operation: 'restoreSession',
      });

    let sleepSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      sleepSpy = await spyOnSleep();
    });

    it('should restore session successfully on first attempt', async () => {
      const authStore = createMockAuthStore();
      const publicKey = asOpaque({ z32: () => 'user-pubky' });
      const session = asOpaque<Session>({ token: 'test-token', info: { publicKey } });
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(session);
      const assertSpy = vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(restoreSpy).toHaveBeenCalledOnce();
      expect(assertSpy).toHaveBeenCalledWith({ publicKey });
      expect(result).toEqual({ status: 'restored', session });
      // Application never touches the restore loading flag — the Controller owns
      // it for the whole restore+finalization span.
      expect(authStore.setIsRestoringSession).not.toHaveBeenCalled();
      // Ensure no sleep calls during restoration because session is restored immediately
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    describe('grant session record (Bitkit sign-in)', () => {
      const grantStore = () =>
        mockAuthStore({
          sessionExport: null,
          grantSessionRecordId: 'rec-1',
          isRestoringSession: false,
          setIsRestoringSession: vi.fn(),
          init: vi.fn(),
        });
      const grantSession = (capabilities: string[] = CAPABILITIES.split(',')) =>
        asOpaque<Session>({ grant: {}, info: { publicKey: asOpaque({ z32: () => 'user-pubky' }), capabilities } });

      it('reload restores grant session from store', async () => {
        const session = grantSession();
        const restoreGrantSpy = vi.spyOn(HomeserverService, 'restoreGrantSession').mockResolvedValue(session);
        const cookieRestoreSpy = vi.spyOn(HomeserverService, 'restoreSession');
        vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);

        const result = await AuthApplication.restorePersistedSession({ authStore: grantStore() });

        expect(result).toEqual({ status: 'restored', session });
        expect(restoreGrantSpy).toHaveBeenCalledWith('rec-1');
        expect(cookieRestoreSpy).not.toHaveBeenCalled();
      });

      it('a stored grant narrower than the Shop grant is signed out and its record removed', async () => {
        const session = grantSession(['/pub/pubky.app/:rw']);
        vi.spyOn(HomeserverService, 'restoreGrantSession').mockResolvedValue(session);
        const logoutSpy = vi.spyOn(HomeserverService, 'logout').mockResolvedValue(undefined);
        const removeSpy = vi.spyOn(HomeserverService, 'removeGrantSession').mockResolvedValue(undefined);

        const result = await AuthApplication.restorePersistedSession({ authStore: grantStore() });

        expect(result).toEqual({ status: 'signed-out' });
        expect(logoutSpy).toHaveBeenCalledWith({ session });
        expect(removeSpy).toHaveBeenCalledWith('rec-1');
      });

      it('grant restore drops a #s= export captured on the same load', async () => {
        vi.spyOn(HomeserverService, 'restoreGrantSession').mockRejectedValue(createAuthError());
        vi.spyOn(HomeserverService, 'removeGrantSession').mockResolvedValue(undefined);
        vibeSessionFragment.resetFragmentSessionExportCache();
        window.history.replaceState(null, '', '/marketplace#s=handoff-export');
        try {
          vibeSessionFragment.consumeFragmentSessionExport();
          expect(vibeSessionFragment.hasPendingFragmentSessionExport()).toBe(true);

          await AuthApplication.restorePersistedSession({ authStore: grantStore() });

          expect(vibeSessionFragment.hasPendingFragmentSessionExport()).toBe(false);
          expect(vibeSessionFragment.takeFragmentSessionExport()).toBeNull();
        } finally {
          vibeSessionFragment.resetFragmentSessionExportCache();
          window.history.replaceState(null, '', '/');
        }
      });

      it('restore never calls save', async () => {
        vi.spyOn(HomeserverService, 'restoreGrantSession').mockResolvedValue(grantSession());
        vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
        const saveSpy = vi.spyOn(HomeserverService, 'saveGrantSession');

        await AuthApplication.restorePersistedSession({ authStore: grantStore() });

        expect(saveSpy).not.toHaveBeenCalled();
      });

      it('reload after grant expiry shows signed-out and drops the record', async () => {
        vi.spyOn(HomeserverService, 'restoreGrantSession').mockRejectedValue(createAuthError());
        const removeSpy = vi.spyOn(HomeserverService, 'removeGrantSession').mockResolvedValue(undefined);

        const result = await AuthApplication.restorePersistedSession({ authStore: grantStore() });

        expect(result).toEqual({ status: 'signed-out' });
        expect(removeSpy).toHaveBeenCalledWith('rec-1');
      });

      it('expiry cleanup rejects instead of signing out when the grant key cannot be removed', async () => {
        vi.spyOn(HomeserverService, 'restoreGrantSession').mockRejectedValue(createAuthError());
        const removeSpy = vi
          .spyOn(HomeserverService, 'removeGrantSession')
          .mockRejectedValue(grantKeyRemovalFailed('removeGrantSession', null));

        const failure = await AuthApplication.restorePersistedSession({ authStore: grantStore() }).catch(
          (error: unknown) => error,
        );

        expect(isGrantKeyRemovalError(failure)).toBe(true);
        // One attempt plus two retries before giving up.
        expect(removeSpy).toHaveBeenCalledTimes(3);
      });

      it('expiry cleanup signs out once a retried removal succeeds', async () => {
        vi.spyOn(HomeserverService, 'restoreGrantSession').mockRejectedValue(createAuthError());
        const removeSpy = vi
          .spyOn(HomeserverService, 'removeGrantSession')
          .mockRejectedValueOnce(grantKeyRemovalFailed('removeGrantSession', null))
          .mockResolvedValueOnce(undefined);

        await expect(AuthApplication.restorePersistedSession({ authStore: grantStore() })).resolves.toEqual({
          status: 'signed-out',
        });
        expect(removeSpy).toHaveBeenCalledTimes(2);
      });

      it('keeps the record on a transient restore failure', async () => {
        vi.spyOn(HomeserverService, 'restoreGrantSession').mockRejectedValue(createNetworkError());
        const removeSpy = vi.spyOn(HomeserverService, 'removeGrantSession').mockResolvedValue(undefined);

        const result = await AuthApplication.restorePersistedSession({ authStore: grantStore() });

        expect(result).toEqual({ status: 'deferred' });
        expect(removeSpy).not.toHaveBeenCalled();
      });

      it('consumer mode ignores grant record id: no bridge, no cookie restore', async () => {
        const originSpy = vi
          .spyOn(vibeSessionConfig, 'getVibeSessionBridgeOrigin')
          .mockReturnValue('https://pubky.app');
        vi.spyOn(HomeserverService, 'restoreGrantSession').mockRejectedValue(createAuthError());
        vi.spyOn(HomeserverService, 'removeGrantSession').mockResolvedValue(undefined);
        const cookieRestoreSpy = vi.spyOn(HomeserverService, 'restoreSession');
        const bridgeSpy = vi.spyOn(vibeSessionBridge, 'requestFromBridge');

        try {
          const result = await AuthApplication.restorePersistedSession({ authStore: grantStore() });

          expect(result).toEqual({ status: 'signed-out' });
          expect(cookieRestoreSpy).not.toHaveBeenCalled();
          expect(bridgeSpy).not.toHaveBeenCalled();
        } finally {
          originSpy.mockRestore();
          bridgeSpy.mockRestore();
        }
      });
    });

    it('should return null when sessionExport is missing', async () => {
      const authStore = createMockAuthStore(null);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(result).toEqual({ status: 'signed-out' });
    });

    it('should retry on retryable error and succeed on subsequent attempt', async () => {
      const authStore = createMockAuthStore();
      const publicKey = asOpaque({ z32: () => 'user-pubky' });
      const session = asOpaque<Session>({ token: 'test-token', info: { publicKey } });
      // Simulate: 1st call fails (network), 2nd call fails (network), 3rd call succeeds
      const restoreSpy = vi
        .spyOn(HomeserverService, 'restoreSession')
        .mockRejectedValueOnce(createNetworkError())
        .mockRejectedValueOnce(createNetworkError())
        .mockResolvedValueOnce(session);
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(restoreSpy).toHaveBeenCalledTimes(3);
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ status: 'restored', session });
    });

    // Errors like expired session (Auth category) are permanent — retrying won't help.
    // Only transient errors (Network, Timeout, Server) should trigger retries.
    it('should not retry on non-retryable AppError', async () => {
      const authStore = createMockAuthStore();
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockRejectedValueOnce(createAuthError()); // Non-retryable error

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(restoreSpy).toHaveBeenCalledOnce();
      expect(sleepSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'signed-out' });
    });

    it('should not retry on non-AppError (plain Error)', async () => {
      const authStore = createMockAuthStore();
      const restoreSpy = vi
        .spyOn(HomeserverService, 'restoreSession')
        .mockRejectedValueOnce(new Error('Unknown error'));

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(restoreSpy).toHaveBeenCalledOnce();
      expect(sleepSpy).not.toHaveBeenCalled();
      // Unknown errors are non-definitive: defer (keep the export), never sign out.
      expect(result).toEqual({ status: 'deferred' });
    });

    it('should defer after exhausting all retry attempts', async () => {
      const authStore = createMockAuthStore();
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockRejectedValue(createNetworkError());

      const result = await AuthApplication.restorePersistedSession({ authStore });

      // 10 attempts total (RESTORE_MAX_ATTEMPTS)
      expect(restoreSpy).toHaveBeenCalledTimes(10);
      // 10 attempts but only 9 sleeps: on the 10th attempt, `attempt < MAX` is false so it breaks instead of sleeping
      expect(sleepSpy).toHaveBeenCalledTimes(9);
      // Transient failure is retryable on the next load — the persisted export
      // must survive, so the outcome is deferred even with consumer mode off.
      expect(result).toEqual({ status: 'deferred' });
      expect(authStore.setIsRestoringSession).not.toHaveBeenCalled();
    });

    it('should defer a transient persist failure when consumer mode is off without consulting fragment or bridge', async () => {
      const authStore = createMockAuthStore();
      const takeFragmentSpy = vi.spyOn(vibeSessionFragment, 'takeFragmentSessionExport');
      const bridgeSpy = vi.spyOn(vibeSessionBridge, 'requestFromBridge');
      vi.spyOn(HomeserverService, 'restoreSession').mockRejectedValue(createNetworkError());

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(result).toEqual({ status: 'deferred' });
      expect(authStore.sessionExport).toBe('mock-session-export');
      expect(takeFragmentSpy).not.toHaveBeenCalled();
      expect(bridgeSpy).not.toHaveBeenCalled();
      takeFragmentSpy.mockRestore();
      bridgeSpy.mockRestore();
    });

    it('should sign out on a definitive auth failure when consumer mode is off', async () => {
      const authStore = createMockAuthStore();
      vi.spyOn(HomeserverService, 'restoreSession').mockRejectedValueOnce(createAuthError());

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(result).toEqual({ status: 'signed-out' });
    });

    // The restore loading flag is Controller-owned for the whole
    // restore+finalization span; Application must not clear it mid-flow (that
    // left a gap on the no-persist bridge/fragment path where useAuthStatus
    // could settle UNAUTHENTICATED before init).
    it('should never touch isRestoringSession, even on failure', async () => {
      const authStore = createMockAuthStore();
      vi.spyOn(HomeserverService, 'restoreSession').mockRejectedValue(createAuthError());

      await AuthApplication.restorePersistedSession({ authStore });

      expect(authStore.setIsRestoringSession).not.toHaveBeenCalled();
    });

    it('should throw without retry when restored session fails staging homeserver check', async () => {
      const authStore = createMockAuthStore();
      const publicKey = asOpaque({ z32: () => 'user-pubky' });
      const session = asOpaque<Session>({ token: 'test-token', info: { publicKey } });
      vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(session);
      const logoutSpy = vi.spyOn(HomeserverService, 'logout').mockResolvedValue(undefined);
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockRejectedValue(
        Err.auth(AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER, 'wrong env', {
          service: ErrorService.Homeserver,
          operation: 'assertUserHomeserverAllowed',
        }),
      );

      await expect(AuthApplication.restorePersistedSession({ authStore })).rejects.toMatchObject({
        code: AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER,
      });
      expect(sleepSpy).not.toHaveBeenCalled();
      // The rejected session must not be left dangling on its own homeserver.
      expect(logoutSpy).toHaveBeenCalledWith({ session });
      expect(authStore.setIsRestoringSession).not.toHaveBeenCalled();
    });

    it('should still reject wrong environment when the best-effort signout fails', async () => {
      const authStore = createMockAuthStore();
      const publicKey = asOpaque({ z32: () => 'user-pubky' });
      const session = asOpaque<Session>({ token: 'test-token', info: { publicKey } });
      vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(session);
      vi.spyOn(HomeserverService, 'logout').mockRejectedValue(new Error('signout failed'));
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockRejectedValue(
        Err.auth(AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER, 'wrong env', {
          service: ErrorService.Homeserver,
          operation: 'assertUserHomeserverAllowed',
        }),
      );

      await expect(AuthApplication.restorePersistedSession({ authStore })).rejects.toMatchObject({
        code: AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER,
      });
      expect(authStore.setIsRestoringSession).not.toHaveBeenCalled();
    });

    it('should retry a transient environment-check failure like any other restore failure', async () => {
      // A failed (non-mismatch) PKARR lookup goes through the shared
      // retry-or-cleanup policy — special-casing it into a kept half-restored
      // state would strand useAuthStatus in its loading branch with no retry.
      const authStore = createMockAuthStore();
      const publicKey = asOpaque({ z32: () => 'user-pubky' });
      const session = asOpaque<Session>({ token: 'test-token', info: { publicKey } });
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(session);
      const logoutSpy = vi.spyOn(HomeserverService, 'logout').mockResolvedValue(undefined);
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed')
        .mockRejectedValueOnce(createNetworkError())
        .mockResolvedValueOnce(undefined);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(result).toEqual({ status: 'restored', session });
      expect(sleepSpy).toHaveBeenCalledOnce();
      // The already-restored session is reused — only the failed check retries.
      expect(restoreSpy).toHaveBeenCalledOnce();
      // Only a definitive wrong-environment rejection signs the session out.
      expect(logoutSpy).not.toHaveBeenCalled();
      expect(authStore.setIsRestoringSession).not.toHaveBeenCalled();
    });
  });

  describe('restorePersistedSession vibe consumer', () => {
    const BRIDGE = 'https://pubky.app';
    const FRAGMENT_EXPORT = 'fragment-export';
    const BRIDGE_EXPORT = 'bridge-export';
    const PERSISTED_EXPORT = 'persisted-export';

    const createMockAuthStore = (sessionExport: string | null = null) =>
      mockAuthStore({
        sessionExport,
        isRestoringSession: false,
        setIsRestoringSession: vi.fn(),
        init: vi.fn(),
      });

    const createAuthError = () =>
      new AppError({
        category: ErrorCategory.Auth,
        code: AuthErrorCode.SESSION_EXPIRED,
        message: 'Session expired',
        service: ErrorService.Homeserver,
        operation: 'restoreSession',
      });

    const createNetworkError = () =>
      new AppError({
        category: ErrorCategory.Network,
        code: NetworkErrorCode.CONNECTION_FAILED,
        message: 'ERR_NETWORK_CHANGED',
        service: ErrorService.Homeserver,
        operation: 'restoreSession',
      });

    const liveSession = () => {
      const publicKey = asOpaque({ z32: () => 'user-pubky' });
      return asOpaque<Session>({ token: 'test-token', info: { publicKey } });
    };

    beforeEach(async () => {
      await spyOnSleep();
      vi.spyOn(vibeSessionConfig, 'getVibeSessionBridgeOrigin').mockReturnValue(undefined);
      vi.spyOn(vibeSessionFragment, 'takeFragmentSessionExport').mockReturnValue(null);
      vi.spyOn(vibeSessionBridge, 'requestFromBridge').mockResolvedValue({ kind: 'none' });
      vi.spyOn(vibeSessionConfig, 'getVibeId').mockReturnValue('test-vibe');
      vi.spyOn(vibeSessionAutoRestore, 'isVibeSessionBridgeLegSkipped').mockReturnValue(false);
    });

    afterEach(() => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockRestore();
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockRestore();
      vi.mocked(vibeSessionBridge.requestFromBridge).mockRestore();
      vi.mocked(vibeSessionConfig.getVibeId).mockRestore();
      vi.mocked(vibeSessionAutoRestore.isVibeSessionBridgeLegSkipped).mockRestore();
    });

    it('does not consult fragment or bridge when consumer mode is off', async () => {
      const authStore = createMockAuthStore(null);
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession');

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(result).toEqual({ status: 'signed-out' });
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(vibeSessionFragment.takeFragmentSessionExport).not.toHaveBeenCalled();
      expect(vibeSessionBridge.requestFromBridge).not.toHaveBeenCalled();
    });

    it('restores from a fragment export when consumer mode is on and nothing is persisted', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(FRAGMENT_EXPORT);
      const session = liveSession();
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(session);
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      const authStore = createMockAuthStore(null);
      const confirmSessionHandoff = vi.fn().mockResolvedValue(true);

      const result = await AuthApplication.restorePersistedSession({ authStore, confirmSessionHandoff });

      expect(restoreSpy).toHaveBeenCalledOnce();
      expect(restoreSpy).toHaveBeenCalledWith({ sessionExport: FRAGMENT_EXPORT });
      expect(confirmSessionHandoff).toHaveBeenCalledWith('user-pubky');
      expect(vibeSessionBridge.requestFromBridge).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'restored', session });
    });

    it('a declined #s= hand-off restores nothing and turns the bridge off for the tab', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(FRAGMENT_EXPORT);
      vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(liveSession());
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      const confirmSessionHandoff = vi.fn().mockResolvedValue(false);
      try {
        const result = await AuthApplication.restorePersistedSession({
          authStore: createMockAuthStore(null),
          confirmSessionHandoff,
        });

        expect(confirmSessionHandoff).toHaveBeenCalledWith('user-pubky');
        expect(result).toEqual({ status: 'signed-out' });
        expect(vibeSessionBridge.requestFromBridge).not.toHaveBeenCalled();
        expect(vibeSessionAutoRestore.isVibeSessionAutoRestoreSuppressed()).toBe(true);
      } finally {
        vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
      }
    });

    it('a #s= hand-off is declined when no one can confirm it', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(FRAGMENT_EXPORT);
      vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(liveSession());
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      try {
        const result = await AuthApplication.restorePersistedSession({ authStore: createMockAuthStore(null) });

        expect(result).toEqual({ status: 'signed-out' });
      } finally {
        vibeSessionAutoRestore.clearVibeSessionAutoRestoreSuppressed();
      }
    });

    it('restores from a bridge reply when consumer mode is on and nothing is persisted', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(null);
      vi.mocked(vibeSessionBridge.requestFromBridge).mockResolvedValue({
        kind: 'export',
        sessionExport: BRIDGE_EXPORT,
      });
      const session = liveSession();
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(session);
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      const authStore = createMockAuthStore(null);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(restoreSpy).toHaveBeenCalledWith({ sessionExport: BRIDGE_EXPORT });
      expect(result).toEqual({ status: 'restored', session });
    });

    it('returns null and does not restore when the bridge replies none', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionBridge.requestFromBridge).mockResolvedValue({ kind: 'none' });
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession');
      const authStore = createMockAuthStore(null);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(result).toEqual({ status: 'signed-out' });
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(authStore.init).not.toHaveBeenCalled();
    });

    it('returns null and does not restore when the bridge times out', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionBridge.requestFromBridge).mockResolvedValue({ kind: 'timeout', phase: 'reply' });
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession');
      const authStore = createMockAuthStore(null);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(result).toEqual({ status: 'signed-out' });
      expect(restoreSpy).not.toHaveBeenCalled();
    });

    it('replaces an expired persisted export with a fresh bridge export', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(null);
      vi.mocked(vibeSessionBridge.requestFromBridge).mockResolvedValue({
        kind: 'export',
        sessionExport: BRIDGE_EXPORT,
      });
      const session = liveSession();
      const restoreSpy = vi
        .spyOn(HomeserverService, 'restoreSession')
        .mockRejectedValueOnce(createAuthError())
        .mockResolvedValueOnce(session);
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      const authStore = createMockAuthStore(PERSISTED_EXPORT);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(restoreSpy).toHaveBeenNthCalledWith(1, { sessionExport: PERSISTED_EXPORT });
      expect(restoreSpy).toHaveBeenNthCalledWith(2, { sessionExport: BRIDGE_EXPORT });
      expect(result).toEqual({ status: 'restored', session });
    });

    it('preserves a persisted export when a transient restore fails and the bridge times out', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionBridge.requestFromBridge).mockResolvedValue({ kind: 'timeout', phase: 'load' });
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockRejectedValue(createNetworkError());
      const authStore = createMockAuthStore(PERSISTED_EXPORT);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(restoreSpy).toHaveBeenCalledTimes(10);
      expect(result).toEqual({ status: 'deferred' });
      expect(authStore.sessionExport).toBe(PERSISTED_EXPORT);
      expect(authStore.init).not.toHaveBeenCalled();
    });

    it('falls through to the bridge when a fragment export fails to restore', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(FRAGMENT_EXPORT);
      vi.mocked(vibeSessionBridge.requestFromBridge).mockResolvedValue({
        kind: 'export',
        sessionExport: BRIDGE_EXPORT,
      });
      const session = liveSession();
      const restoreSpy = vi
        .spyOn(HomeserverService, 'restoreSession')
        .mockRejectedValueOnce(createAuthError())
        .mockResolvedValueOnce(session);
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      const authStore = createMockAuthStore(null);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(restoreSpy).toHaveBeenNthCalledWith(1, { sessionExport: FRAGMENT_EXPORT });
      expect(restoreSpy).toHaveBeenNthCalledWith(2, { sessionExport: BRIDGE_EXPORT });
      expect(result).toEqual({ status: 'restored', session });
    });

    it('skips the bridge when auto-restore is suppressed and still restores a fragment', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.spyOn(vibeSessionAutoRestore, 'isVibeSessionBridgeLegSkipped').mockReturnValue(true);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(FRAGMENT_EXPORT);
      const session = liveSession();
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(session);
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      const authStore = createMockAuthStore(null);

      const result = await AuthApplication.restorePersistedSession({
        authStore,
        confirmSessionHandoff: async () => true,
      });

      expect(restoreSpy).toHaveBeenCalledWith({ sessionExport: FRAGMENT_EXPORT });
      expect(vibeSessionBridge.requestFromBridge).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'restored', session });
    });

    it('does not call the bridge when auto-restore is suppressed and nothing is persisted', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.spyOn(vibeSessionAutoRestore, 'isVibeSessionBridgeLegSkipped').mockReturnValue(true);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(null);
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession');
      const authStore = createMockAuthStore(null);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(result).toEqual({ status: 'signed-out' });
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(vibeSessionBridge.requestFromBridge).not.toHaveBeenCalled();
    });

    it('does not consult the bridge when suppressed and a bogus #s= fragment fails to restore', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.spyOn(vibeSessionAutoRestore, 'isVibeSessionBridgeLegSkipped').mockReturnValue(true);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue('bogus');
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockRejectedValue(createAuthError());
      const authStore = createMockAuthStore(null);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(restoreSpy).toHaveBeenCalledWith({ sessionExport: 'bogus' });
      expect(vibeSessionBridge.requestFromBridge).not.toHaveBeenCalled();
      expect(authStore.init).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'signed-out' });
    });

    it('does not probe the bridge on the sign-in page, so the QR is not held behind its timeouts', async () => {
      vi.mocked(vibeSessionAutoRestore.isVibeSessionBridgeLegSkipped).mockRestore();
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(null);
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession');
      window.history.replaceState(null, '', '/sign-in');
      try {
        const result = await AuthApplication.restorePersistedSession({ authStore: createMockAuthStore(null) });

        expect(result).toEqual({ status: 'signed-out' });
        expect(restoreSpy).not.toHaveBeenCalled();
        expect(vibeSessionBridge.requestFromBridge).not.toHaveBeenCalled();
      } finally {
        window.history.replaceState(null, '', '/');
        vi.spyOn(vibeSessionAutoRestore, 'isVibeSessionBridgeLegSkipped').mockReturnValue(false);
      }
    });

    it('still probes the bridge on other routes', async () => {
      vi.mocked(vibeSessionAutoRestore.isVibeSessionBridgeLegSkipped).mockRestore();
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(null);
      window.history.replaceState(null, '', '/marketplace');
      try {
        const result = await AuthApplication.restorePersistedSession({ authStore: createMockAuthStore(null) });

        expect(vibeSessionBridge.requestFromBridge).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ status: 'signed-out' });
      } finally {
        window.history.replaceState(null, '', '/');
        vi.spyOn(vibeSessionAutoRestore, 'isVibeSessionBridgeLegSkipped').mockReturnValue(false);
      }
    });

    it('passes an AbortSignal to the bridge and abortInFlightBridgeRequest cancels it', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(null);
      let capturedSignal: AbortSignal | undefined;
      vi.mocked(vibeSessionBridge.requestFromBridge).mockImplementation((_win, _origin, _load, _reply, signal) => {
        capturedSignal = signal;
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ kind: 'aborted' }));
        });
      });
      const authStore = createMockAuthStore(null);

      const restorePromise = AuthApplication.restorePersistedSession({ authStore });
      await Promise.resolve();
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
      AuthApplication.abortInFlightBridgeRequest();
      expect(capturedSignal?.aborted).toBe(true);
      await expect(restorePromise).resolves.toEqual({ status: 'signed-out' });
    });

    it('discards the cached fragment export once the restore decision has run (restored leg)', async () => {
      const discardSpy = vi.spyOn(vibeSessionFragment, 'discardFragmentSessionExport');
      const session = liveSession();
      vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(session);
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      const authStore = createMockAuthStore(PERSISTED_EXPORT);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(result).toEqual({ status: 'restored', session });
      expect(discardSpy).toHaveBeenCalledOnce();
    });

    it('discards the cached fragment export once the restore decision has run (signed-out leg)', async () => {
      const discardSpy = vi.spyOn(vibeSessionFragment, 'discardFragmentSessionExport');
      vi.spyOn(HomeserverService, 'restoreSession').mockRejectedValue(createAuthError());
      const authStore = createMockAuthStore(PERSISTED_EXPORT);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(result).toEqual({ status: 'signed-out' });
      expect(discardSpy).toHaveBeenCalledOnce();
    });

    it('does not auto-trigger any re-approval (generateAuthUrl / beginSessionFlow) on a bridged restore', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(null);
      vi.mocked(vibeSessionBridge.requestFromBridge).mockResolvedValue({
        kind: 'export',
        sessionExport: BRIDGE_EXPORT,
      });
      const session = liveSession();
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(session);
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      const generateAuthUrlSpy = vi.spyOn(HomeserverService, 'generateAuthUrl');
      const beginSessionFlowSpy = vi.spyOn(MarketplaceSessionService, 'beginSessionFlow');
      const authStore = createMockAuthStore(null);

      const result = await AuthApplication.restorePersistedSession({ authStore });

      expect(restoreSpy).toHaveBeenCalledWith({ sessionExport: BRIDGE_EXPORT });
      expect(result).toEqual({ status: 'restored', session });
      // A bridged (narrow-grant) restore must never widen on its own: step-up
      // re-approval only happens when a scope-gated feature asks for it.
      expect(generateAuthUrlSpy).not.toHaveBeenCalled();
      expect(beginSessionFlowSpy).not.toHaveBeenCalled();
    });

    it('still runs the staging homeserver guard after a bridged restore when the deploy is staging', async () => {
      vi.mocked(vibeSessionConfig.getVibeSessionBridgeOrigin).mockReturnValue(BRIDGE);
      vi.mocked(vibeSessionFragment.takeFragmentSessionExport).mockReturnValue(null);
      vi.mocked(vibeSessionBridge.requestFromBridge).mockResolvedValue({
        kind: 'export',
        sessionExport: BRIDGE_EXPORT,
      });
      const session = liveSession();
      const restoreSpy = vi.spyOn(HomeserverService, 'restoreSession').mockResolvedValue(session);
      // Undo leaked mock implementations from earlier tests so the REAL guard runs.
      vi.spyOn(HomeserverService, 'assertUserHomeserverAllowed').mockRestore();
      vi.spyOn(HomeserverService, 'logout').mockResolvedValue(undefined);
      // PUBKY_RUNTIME_ENV=staging gate: the real guard must resolve the PKARR
      // record and reject a bridged key whose homeserver is not this deploy's.
      vi.mocked(isStagingHomeserverDeploy).mockReturnValue(true);
      vi.mocked(getHomeserver).mockReturnValue('staging-homeserver');
      const resolveRecordSpy = vi
        .spyOn(
          asOpaque<{
            resolveHomeserverRecord: (params: { publicKey: unknown }) => Promise<{ z32: () => string } | null>;
          }>(HomeserverService),
          'resolveHomeserverRecord',
        )
        .mockResolvedValue({ z32: () => 'prod-homeserver' });
      const authStore = createMockAuthStore(null);

      const error = await AuthApplication.restorePersistedSession({ authStore }).catch((caught: unknown) => caught);

      expect(restoreSpy).toHaveBeenCalledWith({ sessionExport: BRIDGE_EXPORT });
      expect(resolveRecordSpy).toHaveBeenCalledWith({ publicKey: session.info.publicKey });
      expect(isWrongEnvironmentHomeserverError(error)).toBe(true);
    });
  });

  describe('isDefinitiveSessionAuthFailure', () => {
    const requestError = (statusCode?: number) => {
      const err = new Error('HTTP error') as Error & { name: string; data?: { statusCode?: number } };
      err.name = 'RequestError';
      if (statusCode !== undefined) {
        err.data = { statusCode };
      }
      return err;
    };

    it('excludes wrong-environment homeserver errors', () => {
      expect(
        isDefinitiveSessionAuthFailure(
          Err.auth(AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER, 'wrong env', {
            service: ErrorService.Homeserver,
            operation: 'assertUserHomeserverAllowed',
          }),
        ),
      ).toBe(false);
    });

    it('treats AppError auth-category as definitive', () => {
      expect(
        isDefinitiveSessionAuthFailure(
          new AppError({
            category: ErrorCategory.Auth,
            code: AuthErrorCode.SESSION_EXPIRED,
            message: 'Session expired',
            service: ErrorService.Homeserver,
            operation: 'restoreSession',
          }),
        ),
      ).toBe(true);
    });

    it('treats RequestError 401 and 403 as definitive', () => {
      expect(isDefinitiveSessionAuthFailure(requestError(401))).toBe(true);
      expect(isDefinitiveSessionAuthFailure(requestError(403))).toBe(true);
    });

    it('does not treat RequestError 5xx or missing status as definitive', () => {
      expect(isDefinitiveSessionAuthFailure(requestError(500))).toBe(false);
      expect(isDefinitiveSessionAuthFailure(requestError())).toBe(false);
    });
  });

  describe('userIsSignedUp', () => {
    const testPubky = 'test-pubky' as Pubky;

    it('should return true when profile.json exists', async () => {
      const requestSpy = vi.spyOn(HomeserverService, 'request').mockResolvedValue({ name: 'Test' });

      const result = await AuthApplication.userIsSignedUp({ pubky: testPubky });

      expect(result).toBe(true);
      expect(requestSpy).toHaveBeenCalledWith({
        method: HttpMethod.GET,
        url: `pubky://${testPubky}/pub/pubky.app/profile.json`,
      });
    });

    it('should return false when profile.json is not found (404)', async () => {
      const notFoundError = Err.client(ClientErrorCode.NOT_FOUND, 'Profile not found', {
        service: ErrorService.Homeserver,
        operation: 'userIsSignedUp',
      });
      vi.spyOn(HomeserverService, 'request').mockRejectedValue(notFoundError);

      const result = await AuthApplication.userIsSignedUp({ pubky: testPubky });

      expect(result).toBe(false);
    });

    it('should throw when request fails with non-404 error', async () => {
      const serverError = Err.server(ServerErrorCode.INTERNAL_ERROR, 'Server error', {
        service: ErrorService.Homeserver,
        operation: 'userIsSignedUp',
      });
      vi.spyOn(HomeserverService, 'request').mockRejectedValue(serverError);

      await expect(AuthApplication.userIsSignedUp({ pubky: testPubky })).rejects.toMatchObject({
        code: ServerErrorCode.INTERNAL_ERROR,
      });
    });
  });

  describe('single-approval ceremony', () => {
    it('starts the token flow with the full CAPABILITIES grant', () => {
      const spy = vi.spyOn(HomeserverService, 'generateAuthTokenFlow').mockReturnValue({
        authorizationUrl: 'https://example.com/auth',
        awaitToken: async () => asOpaque({}),
        cancelAuthFlow: vi.fn(),
      });

      AuthApplication.startDirectSignInFlow();

      expect(spy).toHaveBeenCalledWith(expect.stringContaining('/priv/pubky.app/:rw'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('/pub/paykit/:rw'));
    });

    it('presents the same bytes to homeserver first, then marketplace', async () => {
      const bytes = new Uint8Array([3, 2, 1]);
      const token = asOpaque<AuthToken>({
        toBytes: () => bytes,
        publicKey: { z32: () => 'y'.repeat(52) },
      });
      const order: string[] = [];
      vi.spyOn(HomeserverService, 'signInWithFullGrantAuthToken').mockImplementation(async (got) => {
        order.push('hs');
        expect(got).toBe(bytes);
        return mockSession();
      });
      vi.spyOn(MarketplaceSessionService, 'redeemAuthTokenAfterHomeserver').mockImplementation(async (got) => {
        order.push('mp');
        expect(got).toBe(bytes);
        return {
          pubky: 'y'.repeat(52),
          capabilities: '',
          expiresAt: '2099-01-01T00:00:00.000Z',
          issuedAt: '2026-09-08T00:00:00.000Z',
        };
      });
      vi.spyOn(await import('@/config/commerce'), 'isDurableCommerceMode').mockReturnValue(true);
      vi.spyOn(await import('@/config/commerce'), 'getCommerceAdapterMode').mockReturnValue('transaction-service');

      const result = await AuthApplication.completeSingleApprovalCeremony(token);

      expect(order).toEqual(['hs', 'mp']);
      expect(result.marketplace).not.toBeNull();
      expect(result.marketplaceError).toBeNull();
    });

    it('keeps the homeserver session when the marketplace half fails, with a no-excerpt marketplaceError', async () => {
      const session = mockSession();
      const token = asOpaque<AuthToken>({
        toBytes: () => new Uint8Array([3, 2, 1]),
        publicKey: { z32: () => 'y'.repeat(52) },
      });
      vi.spyOn(HomeserverService, 'signInWithFullGrantAuthToken').mockResolvedValue(session);
      vi.spyOn(MarketplaceSessionService, 'redeemAuthTokenAfterHomeserver').mockRejectedValue(
        Err.auth(AuthErrorCode.INVALID_TOKEN, 'The marketplace service rejected the auth token.', {
          service: ErrorService.Marketplace,
          operation: 'establishWithAuthToken',
          context: { statusCode: 401, alreadyUsed: true },
        }),
      );
      vi.spyOn(await import('@/config/commerce'), 'isDurableCommerceMode').mockReturnValue(true);
      vi.spyOn(await import('@/config/commerce'), 'getCommerceAdapterMode').mockReturnValue('transaction-service');

      const result = await AuthApplication.completeSingleApprovalCeremony(token);

      expect(result.session).toBe(session);
      expect(result.marketplace).toBeNull();
      // No-excerpt discipline: exactly statusCode/alreadyUsed, nothing else.
      expect(result.marketplaceError).toEqual({ statusCode: 401, alreadyUsed: true });
    });

    it('returns an empty marketplaceError for a non-AppError marketplace failure', async () => {
      const token = asOpaque<AuthToken>({
        toBytes: () => new Uint8Array([3, 2, 1]),
        publicKey: { z32: () => 'y'.repeat(52) },
      });
      vi.spyOn(HomeserverService, 'signInWithFullGrantAuthToken').mockResolvedValue(mockSession());
      vi.spyOn(MarketplaceSessionService, 'redeemAuthTokenAfterHomeserver').mockRejectedValue(
        new TypeError('network down'),
      );
      vi.spyOn(await import('@/config/commerce'), 'isDurableCommerceMode').mockReturnValue(true);
      vi.spyOn(await import('@/config/commerce'), 'getCommerceAdapterMode').mockReturnValue('transaction-service');

      const result = await AuthApplication.completeSingleApprovalCeremony(token);

      expect(result.marketplace).toBeNull();
      expect(result.marketplaceError).toEqual({});
    });

    it('runs the onHomeserverSession hook after the homeserver half and before the marketplace POST', async () => {
      const session = mockSession();
      const token = asOpaque<AuthToken>({
        toBytes: () => new Uint8Array([3, 2, 1]),
        publicKey: { z32: () => 'y'.repeat(52) },
      });
      const order: string[] = [];
      vi.spyOn(HomeserverService, 'signInWithFullGrantAuthToken').mockImplementation(async () => {
        order.push('hs');
        return session;
      });
      vi.spyOn(MarketplaceSessionService, 'redeemAuthTokenAfterHomeserver').mockImplementation(async () => {
        order.push('mp');
        return {
          pubky: 'y'.repeat(52),
          capabilities: '',
          expiresAt: '2099-01-01T00:00:00.000Z',
          issuedAt: '2026-09-08T00:00:00.000Z',
        };
      });
      vi.spyOn(await import('@/config/commerce'), 'isDurableCommerceMode').mockReturnValue(true);
      vi.spyOn(await import('@/config/commerce'), 'getCommerceAdapterMode').mockReturnValue('transaction-service');

      await AuthApplication.completeSingleApprovalCeremony(token, {
        onHomeserverSession: async (got) => {
          order.push('hook');
          expect(got).toBe(session);
        },
      });

      expect(order).toEqual(['hs', 'hook', 'mp']);
    });

    it('aborts before the marketplace POST when the onHomeserverSession hook throws', async () => {
      const token = asOpaque<AuthToken>({
        toBytes: () => new Uint8Array([3, 2, 1]),
        publicKey: { z32: () => 'y'.repeat(52) },
      });
      vi.spyOn(HomeserverService, 'signInWithFullGrantAuthToken').mockResolvedValue(mockSession());
      const redeemSpy = vi.spyOn(MarketplaceSessionService, 'redeemAuthTokenAfterHomeserver');
      vi.spyOn(await import('@/config/commerce'), 'isDurableCommerceMode').mockReturnValue(true);
      vi.spyOn(await import('@/config/commerce'), 'getCommerceAdapterMode').mockReturnValue('transaction-service');

      await expect(
        AuthApplication.completeSingleApprovalCeremony(token, {
          onHomeserverSession: async () => {
            throw new Error('different identity approved');
          },
        }),
      ).rejects.toThrow('different identity approved');
      expect(redeemSpy).not.toHaveBeenCalled();
    });
  });
});
