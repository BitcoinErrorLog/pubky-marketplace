import type { Keypair, PublicKey, Session } from '@synonymdev/pubky';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES, RING_COOKIE_CAPABILITIES } from '@/config/app';
import { AppError } from '@/libs/error/error';
import {
  AuthErrorCode,
  ClientErrorCode,
  NetworkErrorCode,
  ServerErrorCode,
  ValidationErrorCode,
} from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import { asOpaque } from '@/test-utils/type-assertions';
import { bytesToBase64 } from './homeserver.utils';

// =============================================================================
// HOISTED MOCKS - Must be hoisted to run before module imports
// =============================================================================

const mockState = vi.hoisted(() => ({
  // Signer methods
  signup: vi.fn(),
  signin: vi.fn(),
  publishHomeserverForce: vi.fn(),
  // Session methods
  sessionSignout: vi.fn(),
  // Session storage
  sessionStorageGet: vi.fn(),
  sessionStorageExists: vi.fn(),
  sessionStoragePutJson: vi.fn(),
  sessionStoragePutBytes: vi.fn(),
  sessionStorageDelete: vi.fn(),
  sessionStorageList: vi.fn(),
  // Client methods
  clientFetch: vi.fn(),
  // Public storage
  publicStorageGet: vi.fn(),
  publicStorageExists: vi.fn(),
  publicStorageList: vi.fn(),
  // Pubky methods
  getHomeserverOf: vi.fn(),
  restoreSession: vi.fn(),
  sessionRestore: vi.fn(),
  grantStartDelegated: vi.fn(),
  grantStoreRemove: vi.fn(),
  grantStoreClearAll: vi.fn(),
  grantStoreList: vi.fn(),
  grantStoreIsAvailable: vi.fn(),
  startAuthFlow: vi.fn(),
  resumeAuthFlow: vi.fn(),
  authFlowKindSignin: vi.fn(),
  authTokenFromBytes: vi.fn(),
  eventStreamForUser: vi.fn(),
  // Auth store session
  currentSession: null as Session | null,
}));

// Mock global fetch for generateSignupToken tests (calls /api/dev/signup-token)
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock pubky-app-specs to avoid WebAssembly issues
vi.mock('pubky-app-specs', () => ({
  default: vi.fn(() => Promise.resolve()),
  getValidMimeTypes: () => ['image/jpeg', 'image/png'],
}));

// Mock Logger to suppress console output during tests
vi.mock('@/libs/logger/logger', () => ({
  Logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock useAuthStore to provide session
vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: {
    getState: () => ({
      selectSession: () => {
        // Access mockState.currentSession at call time, not at mock creation time
        return mockState.currentSession;
      },
    }),
  },
}));

// =============================================================================
// MOCK @synonymdev/pubky MODULE
// =============================================================================

vi.mock('@synonymdev/pubky', () => {
  const createMockPubkyInstance = () => ({
    getHomeserverOf: (...args: unknown[]) => mockState.getHomeserverOf(...args),
    restoreSession: (...args: unknown[]) => mockState.restoreSession(...args),
    startCookieAuthFlow: (...args: unknown[]) => mockState.startAuthFlow(...args),
    resumeCookieAuthFlow: (...args: unknown[]) => mockState.resumeAuthFlow(...args),
    eventStreamForUser: (...args: unknown[]) => mockState.eventStreamForUser(...args),
    client: {
      fetch: (...args: unknown[]) => mockState.clientFetch(...args),
    },
    browserSessionStore: {
      remove: (...args: unknown[]) => mockState.grantStoreRemove(...args),
      clearAll: (...args: unknown[]) => mockState.grantStoreClearAll(...args),
      list: (...args: unknown[]) => mockState.grantStoreList(...args),
      isAvailable: (...args: unknown[]) => mockState.grantStoreIsAvailable(...args),
    },
    publicStorage: {
      get: (...args: unknown[]) => mockState.publicStorageGet(...args),
      exists: (...args: unknown[]) => mockState.publicStorageExists(...args),
      list: (...args: unknown[]) => mockState.publicStorageList(...args),
    },
    signer: () => ({
      signupCookie: (...args: unknown[]) => mockState.signup(...args),
      signinCookie: (...args: unknown[]) => mockState.signin(...args),
      pkdns: {
        publishHomeserverForce: (...args: unknown[]) => mockState.publishHomeserverForce(...args),
      },
    }),
  });

  const MockPubky = vi.fn().mockImplementation(createMockPubkyInstance);
  // @ts-expect-error - Adding static testnet method
  MockPubky.testnet = vi.fn().mockImplementation(createMockPubkyInstance);

  return {
    Pubky: MockPubky,
    Session: {
      restore: (...args: unknown[]) => mockState.sessionRestore(...args),
    },
    GrantAuthFlow: {
      startDelegated: (...args: unknown[]) => mockState.grantStartDelegated(...args),
      isDelegationAvailable: true,
    },
    PublicKey: {
      from: vi.fn().mockReturnValue({
        z32: () => 'homeserver-public-key-z32',
      }),
    },
    Keypair: {
      random: vi.fn(),
      fromSecret: vi.fn(),
    },
    AuthFlowKind: {
      signin: () => mockState.authFlowKindSignin(),
    },
    AuthToken: {
      fromBytes: (...args: unknown[]) => mockState.authTokenFromBytes(...args),
    },
    resolvePubky: vi.fn((url: string) => url.replace('pubky://', 'https://')),
  };
});

// =============================================================================
// HELPER FACTORIES
// =============================================================================

/**
 * Creates a mock Session object
 */
const createMockSession = (): Session =>
  asOpaque<Session>({
    info: {
      publicKey: {
        z32: () => 'user',
      },
    },
    storage: {
      get: (...args: unknown[]) => mockState.sessionStorageGet(...args),
      exists: (...args: unknown[]) => mockState.sessionStorageExists(...args),
      putJson: (...args: unknown[]) => mockState.sessionStoragePutJson(...args),
      putBytes: (...args: unknown[]) => mockState.sessionStoragePutBytes(...args),
      delete: (...args: unknown[]) => mockState.sessionStorageDelete(...args),
      list: (...args: unknown[]) => mockState.sessionStorageList(...args),
    },
    signout: (...args: unknown[]) => mockState.sessionSignout(...args),
  });

/**
 * Creates a mock Keypair
 */
const createMockKeypair = (): Keypair =>
  asOpaque<Keypair>({
    publicKey: {
      z32: () => 'test-public-key-z32',
    } as PublicKey,
    secret: vi.fn(() => new Uint8Array(32).fill(1)),
  });

/**
 * Temporarily declare a staging deploy (PUBKY_RUNTIME_ENV=staging) and point
 * runtime config at canonical staging homeserver values.
 */
async function withStagingHomeserverEnv(
  run: () => Promise<void>,
  { keepTestHomeserver = false }: { keepTestHomeserver?: boolean } = {},
): Promise<void> {
  const { resetRuntimeConfigForTests } = await import('@/libs/runtime-config/runtime-config');
  const { NETWORK_RUNTIME_DEFAULTS } = await import('@/libs/runtime-config/runtime-config.schema');

  const previousDeployEnv = process.env.PUBKY_RUNTIME_ENV;
  const previousHomeserver = process.env.PUBKY_RUNTIME_HOMESERVER;
  const previousHomeserverUrl = process.env.PUBKY_RUNTIME_HOMESERVER_URL;
  process.env.PUBKY_RUNTIME_ENV = 'staging';
  if (!keepTestHomeserver) {
    process.env.PUBKY_RUNTIME_HOMESERVER = NETWORK_RUNTIME_DEFAULTS.homeserver;
    process.env.PUBKY_RUNTIME_HOMESERVER_URL = NETWORK_RUNTIME_DEFAULTS.homeserverUrl;
  }
  resetRuntimeConfigForTests();

  try {
    await run();
  } finally {
    process.env.PUBKY_RUNTIME_ENV = previousDeployEnv;
    process.env.PUBKY_RUNTIME_HOMESERVER = previousHomeserver;
    process.env.PUBKY_RUNTIME_HOMESERVER_URL = previousHomeserverUrl;
    resetRuntimeConfigForTests();
  }
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('HomeserverService', () => {
  let HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;

  beforeEach(async () => {
    // Reset all mocks
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockState.currentSession = null;

    // Setup default successful behaviors
    mockState.signup.mockResolvedValue(createMockSession());
    mockState.signin.mockResolvedValue(createMockSession());
    mockState.publishHomeserverForce.mockResolvedValue(undefined);
    mockState.clientFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    mockState.publicStorageGet.mockResolvedValue(new Response('{}', { status: 200 }));
    mockState.publicStorageExists.mockResolvedValue(true);
    mockState.publicStorageList.mockResolvedValue([]);
    mockState.getHomeserverOf.mockResolvedValue('https://test-homeserver.com');
    mockState.sessionSignout.mockResolvedValue(undefined);
    mockState.sessionStorageGet.mockResolvedValue(new Response('{}', { status: 200 }));
    mockState.sessionStorageExists.mockResolvedValue(true);
    mockState.sessionStoragePutJson.mockResolvedValue(undefined);
    mockState.sessionStoragePutBytes.mockResolvedValue(undefined);
    mockState.sessionStorageDelete.mockResolvedValue(undefined);
    mockState.sessionStorageList.mockResolvedValue([]);
    mockState.startAuthFlow.mockReturnValue({
      authorizationUrl: 'https://auth.example.com/authorize',
      tryPollOnce: vi.fn().mockResolvedValue(createMockSession()),
      free: vi.fn(),
    });
    mockState.authTokenFromBytes.mockReset();
    mockState.authFlowKindSignin.mockReturnValue('signin-kind');
    mockState.eventStreamForUser.mockReturnValue({
      path: vi.fn().mockReturnThis(),
      live: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockResolvedValue(new ReadableStream()),
    });

    // Reset module cache and re-import
    vi.resetModules();
    ({ HomeserverService } = await import('@/services/homeserver/homeserver'));
  });

  // ===========================================================================
  // API SURFACE
  // ===========================================================================

  describe('API Surface', () => {
    it('should expose the expected public API', () => {
      expect(HomeserverService).toBeDefined();

      const expectedMethods = [
        'signUp',
        'verifySignupToken',
        'signIn',
        'logout',
        'generateAuthUrl',
        'signInWithFullGrantAuthToken',
        'currentSessionHasFullGrant',
        'request',
        'putBlob',
        'list',
        'delete',
        'get',
        'exists',
        'generateSignupToken',
        'subscribeUserEventStreamForPath',
      ] as const;

      expectedMethods.forEach((method) => {
        expect(typeof HomeserverService[method]).toBe('function');
      });
    });
  });

  // ===========================================================================
  // AUTHENTICATION
  // ===========================================================================

  describe('Authentication', () => {
    describe('signUp', () => {
      it('should return session on successful signup', async () => {
        const keypair = createMockKeypair();
        const signupToken = 'valid-signup-token';
        const expectedSession = createMockSession();

        mockState.signup.mockResolvedValue(expectedSession);

        const result = await HomeserverService.signUp({ keypair, signupToken });

        expect(result).toEqual({ session: expectedSession });
      });

      it('should call signer.signup with signup token', async () => {
        const keypair = createMockKeypair();
        const signupToken = 'test-token';

        await HomeserverService.signUp({ keypair, signupToken });

        expect(mockState.signup).toHaveBeenCalledWith(
          expect.anything(), // homeserver public key
          signupToken,
        );
      });

      it('should throw SIGNUP_FAILED error when signup fails with Error', async () => {
        const keypair = createMockKeypair();
        const signupToken = 'invalid-token';

        mockState.signup.mockRejectedValue(new Error('Invalid token'));

        await expect(HomeserverService.signUp({ keypair, signupToken })).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });

      it('should throw SIGNUP_FAILED error when signup fails with non-Error', async () => {
        const keypair = createMockKeypair();
        const signupToken = 'bad-token';

        mockState.signup.mockRejectedValue('string error');

        await expect(HomeserverService.signUp({ keypair, signupToken })).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });

      it('should preserve original error message in error details', async () => {
        const keypair = createMockKeypair();
        const signupToken = 'token';
        const originalMessage = 'Token expired';

        mockState.signup.mockRejectedValue(new Error(originalMessage));

        try {
          await HomeserverService.signUp({ keypair, signupToken });
          expect.fail('Should have thrown');
        } catch (error) {
          // Use name check instead of instanceof due to module reset
          expect((error as Error).name).toBe('AppError');
          // The original error message becomes the error message
          expect((error as AppError).message).toBe(originalMessage);
        }
      });
    });

    describe('signUp (staging: direct homeserver URL)', () => {
      const signupToken = 'AAAA-BBBB-CCCC';
      const sessionInfoBytes = new Uint8Array([1, 2, 3, 4]);

      it('POSTs a locally signed auth token to the homeserver URL and hydrates the session', async () => {
        await withStagingHomeserverEnv(async () => {
          const keypair = createMockKeypair();
          const expectedSession = createMockSession();
          mockState.clientFetch.mockResolvedValue(new Response(sessionInfoBytes, { status: 200 }));
          mockState.sessionRestore.mockResolvedValue(expectedSession);

          const result = await HomeserverService.signUp({ keypair, signupToken });

          expect(result).toEqual({ session: expectedSession });
          // Never touches the PKARR-dependent SDK signup
          expect(mockState.signup).not.toHaveBeenCalled();
          expect(mockState.clientFetch).toHaveBeenCalledWith(
            expect.stringContaining(`/signup?signup_token=${signupToken}`),
            expect.objectContaining({ method: HttpMethod.POST, credentials: 'include' }),
          );
          const [url, init] = mockState.clientFetch.mock.calls[0] as [string, { body: ArrayBuffer }];
          expect(url.startsWith('https://homeserver.staging.pubky.app')).toBe(true);
          // Body is a canonical v0 root auth token (120 bytes for "/:rw")
          expect(new Uint8Array(init.body).length).toBe(120);
          // Publishes the user's record so the staging guard and Nexus can resolve it
          expect(mockState.publishHomeserverForce).toHaveBeenCalled();
          // Session is restored from the base64 of the signup response body via
          // the metadata API; Pubky.restoreSession parses secret tokens instead.
          expect(mockState.sessionRestore).toHaveBeenCalledWith(
            btoa(String.fromCharCode(...sessionInfoBytes)),
            expect.anything(),
          );
          expect(mockState.restoreSession).not.toHaveBeenCalled();
        });
      });

      it('recovers a consumed invite by signing in when the account already exists', async () => {
        await withStagingHomeserverEnv(async () => {
          const keypair = createMockKeypair();
          const expectedSession = createMockSession();
          mockState.clientFetch.mockResolvedValue(new Response('token already used', { status: 400 }));
          mockState.signin.mockResolvedValue(expectedSession);

          const result = await HomeserverService.signUp({ keypair, signupToken });

          expect(result).toEqual({ session: expectedSession });
          expect(mockState.publishHomeserverForce).toHaveBeenCalled();
          expect(mockState.signin).toHaveBeenCalled();
        });
      });

      it('throws a non-retryable auth error when the invite is rejected and no account exists', async () => {
        await withStagingHomeserverEnv(async () => {
          const keypair = createMockKeypair();
          mockState.clientFetch.mockResolvedValue(new Response('invalid token', { status: 401 }));
          mockState.signin.mockRejectedValue(new Error('no account'));

          await expect(HomeserverService.signUp({ keypair, signupToken })).rejects.toMatchObject({
            category: ErrorCategory.Auth,
            code: AuthErrorCode.INVALID_TOKEN,
          });
        });
      });

      it('throws a retryable server error when the homeserver is unreachable (invite not consumed)', async () => {
        await withStagingHomeserverEnv(async () => {
          const keypair = createMockKeypair();
          mockState.clientFetch.mockRejectedValue(new Error('network down'));

          await expect(HomeserverService.signUp({ keypair, signupToken })).rejects.toMatchObject({
            category: ErrorCategory.Server,
            code: ServerErrorCode.SERVICE_UNAVAILABLE,
          });
          expect(mockState.publishHomeserverForce).not.toHaveBeenCalled();
        });
      });

      it('throws a retryable server error when record publishing fails after a successful POST', async () => {
        await withStagingHomeserverEnv(async () => {
          const keypair = createMockKeypair();
          mockState.clientFetch.mockResolvedValue(new Response(sessionInfoBytes, { status: 200 }));
          mockState.publishHomeserverForce.mockRejectedValue(new Error('relay 429'));

          await expect(HomeserverService.signUp({ keypair, signupToken })).rejects.toMatchObject({
            category: ErrorCategory.Server,
            code: ServerErrorCode.SERVICE_UNAVAILABLE,
          });
          expect(mockState.sessionRestore).not.toHaveBeenCalled();
          expect(mockState.restoreSession).not.toHaveBeenCalled();
        });
      });

      it('retries session hydration before failing with a retryable error', async () => {
        await withStagingHomeserverEnv(async () => {
          const keypair = createMockKeypair();
          const expectedSession = createMockSession();
          mockState.clientFetch.mockResolvedValue(new Response(sessionInfoBytes, { status: 200 }));
          mockState.sessionRestore
            .mockRejectedValueOnce(new Error('record not propagated yet'))
            .mockResolvedValueOnce(expectedSession);

          const result = await HomeserverService.signUp({ keypair, signupToken });

          expect(result).toEqual({ session: expectedSession });
          expect(mockState.sessionRestore).toHaveBeenCalledTimes(2);
          expect(mockState.signin).not.toHaveBeenCalled();
        });
      });

      it('recovers via signinCookie when every restore attempt fails after the invite is spent', async () => {
        await withStagingHomeserverEnv(async () => {
          vi.useFakeTimers();
          try {
            const keypair = createMockKeypair();
            const recoveredSession = createMockSession();
            mockState.clientFetch.mockResolvedValue(new Response(sessionInfoBytes, { status: 200 }));
            mockState.sessionRestore.mockRejectedValue(new Error('restore failed'));
            mockState.signin.mockResolvedValue(recoveredSession);

            const pending = HomeserverService.signUp({ keypair, signupToken });
            await vi.runAllTimersAsync();
            const result = await pending;

            expect(result).toEqual({ session: recoveredSession });
            expect(mockState.sessionRestore).toHaveBeenCalledTimes(3);
            expect(mockState.signin).toHaveBeenCalledTimes(1);
            expect(mockState.restoreSession).not.toHaveBeenCalled();
          } finally {
            vi.useRealTimers();
          }
        });
      });

      it('throws a retryable error only when both restore and signinCookie fail', async () => {
        await withStagingHomeserverEnv(async () => {
          vi.useFakeTimers();
          try {
            const keypair = createMockKeypair();
            mockState.clientFetch.mockResolvedValue(new Response(sessionInfoBytes, { status: 200 }));
            mockState.sessionRestore.mockRejectedValue(new Error('restore failed'));
            mockState.signin.mockRejectedValue(new Error('signin failed'));

            const pending = HomeserverService.signUp({ keypair, signupToken }).catch((error: unknown) => error);
            await vi.runAllTimersAsync();

            expect(await pending).toMatchObject({
              category: ErrorCategory.Server,
              code: ServerErrorCode.SERVICE_UNAVAILABLE,
            });
            expect(mockState.sessionRestore).toHaveBeenCalledTimes(3);
            expect(mockState.signin).toHaveBeenCalledTimes(1);
          } finally {
            vi.useRealTimers();
          }
        });
      });
    });

    describe('verifySignupToken', () => {
      it('should return valid when the homeserver responds with status valid', async () => {
        mockState.clientFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'valid' }), { status: 200 }));

        const result = await HomeserverService.verifySignupToken('YVB2-YFRN-GDY0');

        expect(result).toBe('valid');
        expect(mockState.clientFetch).toHaveBeenCalledWith(expect.stringContaining('/signup_tokens/YVB2-YFRN-GDY0'), {
          method: HttpMethod.GET,
        });
      });

      it('should return used when the homeserver responds with status used', async () => {
        mockState.clientFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'used' }), { status: 200 }));

        const result = await HomeserverService.verifySignupToken('YVB2-YFRN-GDY0');

        expect(result).toBe('used');
      });

      it('should return invalid when the homeserver responds with 404', async () => {
        mockState.clientFetch.mockResolvedValue(new Response(null, { status: 404 }));

        const result = await HomeserverService.verifySignupToken('BADC-0DE0-0000');

        expect(result).toBe('invalid');
      });

      it('should return invalid when the homeserver responds with an unexpected payload', async () => {
        mockState.clientFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'unknown' }), { status: 200 }));

        const result = await HomeserverService.verifySignupToken('BADC-0DE0-0000');

        expect(result).toBe('invalid');
      });

      it('logs only the status when the verification body is not JSON', async () => {
        const windowed = '{"status":"valid"';
        mockState.clientFetch.mockResolvedValue(new Response(windowed, { status: 200 }));
        const { Logger } = await import('@/libs/logger/logger');

        const result = await HomeserverService.verifySignupToken('YVB2-YFRN-GDY0');

        expect(result).toBe('invalid');
        expect(JSON.stringify(vi.mocked(Logger.warn).mock.calls)).not.toContain(windowed);
        expect(JSON.stringify(vi.mocked(Logger.warn).mock.calls)).not.toContain('Unexpected token');
      });

      it('should rethrow when the homeserver cannot be reached', async () => {
        mockState.clientFetch.mockRejectedValue(new Error('network error'));

        await expect(HomeserverService.verifySignupToken('YVB2-YFRN-GDY0')).rejects.toThrow('network error');
      });

      it('should URL-encode the signup token', async () => {
        mockState.clientFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'valid' }), { status: 200 }));

        await HomeserverService.verifySignupToken('AB CD/EF');

        expect(mockState.clientFetch).toHaveBeenCalledWith(expect.stringContaining('/signup_tokens/AB%20CD%2FEF'), {
          method: HttpMethod.GET,
        });
      });
    });

    describe('signIn', () => {
      it('should skip homeserver resolution when the deploy is not staging', async () => {
        const keypair = createMockKeypair();

        await HomeserverService.assertUserHomeserverAllowed({ publicKey: keypair.publicKey });

        expect(mockState.getHomeserverOf).not.toHaveBeenCalled();
      });

      it('should return session on successful signin', async () => {
        const keypair = createMockKeypair();
        const expectedSession = createMockSession();

        mockState.getHomeserverOf.mockResolvedValue('https://homeserver.example.com');
        mockState.signin.mockResolvedValue(expectedSession);

        const result = await HomeserverService.signIn({ keypair });

        expect(mockState.signin).toHaveBeenCalled();
        expect(result).toEqual({ session: expectedSession });
      });

      it('should check homeserver before signing in', async () => {
        const keypair = createMockKeypair();

        mockState.getHomeserverOf.mockResolvedValue('https://homeserver.example.com');

        await HomeserverService.signIn({ keypair });

        expect(mockState.getHomeserverOf).toHaveBeenCalledWith(keypair.publicKey);
      });

      it('should attempt to republish homeserver and return undefined when the record is provably absent', async () => {
        // NOTE: This is intentional behavior - after republishing the homeserver,
        // the method returns undefined to signal the caller should retry signin.
        // The republish is a recovery mechanism when PKARR records are stale,
        // and only fires when the lookup RESOLVED to "no record".
        const keypair = createMockKeypair();

        mockState.getHomeserverOf.mockResolvedValue(null);

        const result = await HomeserverService.signIn({ keypair });

        expect(mockState.publishHomeserverForce).toHaveBeenCalled();
        expect(result).toBeUndefined();
      });

      it('should not republish when the homeserver lookup fails outside staging', async () => {
        // A thrown lookup does not prove the record is absent — republishing on
        // it could overwrite an existing record that points elsewhere.
        const keypair = createMockKeypair();

        mockState.getHomeserverOf.mockRejectedValue(new Error('PKARR relay unavailable'));

        await expect(HomeserverService.signIn({ keypair })).rejects.toMatchObject({
          category: ErrorCategory.Server,
        });
        expect(mockState.signin).not.toHaveBeenCalled();
        expect(mockState.publishHomeserverForce).not.toHaveBeenCalled();
      });

      it('should throw SESSION_EXPIRED error when both signin and republish fail', async () => {
        // NOTE: handleError converts 401 errors to SESSION_EXPIRED (see error.utils.ts)
        const keypair = createMockKeypair();

        mockState.getHomeserverOf.mockResolvedValue(null);
        mockState.publishHomeserverForce.mockRejectedValue(new Error('Republish failed'));

        await expect(HomeserverService.signIn({ keypair })).rejects.toMatchObject({
          category: ErrorCategory.Auth,
          code: AuthErrorCode.SESSION_EXPIRED,
        });
      });

      it('should reject mismatched homeserver on staging without republishing', async () => {
        await withStagingHomeserverEnv(async () => {
          const keypair = createMockKeypair();
          mockState.getHomeserverOf.mockResolvedValue({
            z32: () => 'prod-homeserver-public-key-z32',
          });

          await expect(HomeserverService.signIn({ keypair })).rejects.toMatchObject({
            category: ErrorCategory.Auth,
            code: AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER,
          });
          expect(mockState.signin).not.toHaveBeenCalled();
          expect(mockState.publishHomeserverForce).not.toHaveBeenCalled();
        });
      });

      it('should reject an absent homeserver record on staging without republishing', async () => {
        // Absence cannot prove the key belongs to this deploy — it is rejected
        // like a mismatch (deterministic, non-retryable) rather than surfaced
        // as a transient server error.
        await withStagingHomeserverEnv(async () => {
          const keypair = createMockKeypair();
          mockState.getHomeserverOf.mockResolvedValue(null);

          await expect(HomeserverService.signIn({ keypair })).rejects.toMatchObject({
            category: ErrorCategory.Auth,
            code: AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER,
          });
          expect(mockState.signin).not.toHaveBeenCalled();
          expect(mockState.publishHomeserverForce).not.toHaveBeenCalled();
        });
      });

      it('should not republish when homeserver resolution fails on staging', async () => {
        await withStagingHomeserverEnv(async () => {
          const keypair = createMockKeypair();
          mockState.getHomeserverOf.mockRejectedValue(new Error('PKARR relay unavailable'));

          await expect(HomeserverService.signIn({ keypair })).rejects.toMatchObject({
            category: ErrorCategory.Server,
          });
          expect(mockState.signin).not.toHaveBeenCalled();
          expect(mockState.publishHomeserverForce).not.toHaveBeenCalled();
        });
      });

      it('should allow signin on staging when PKARR homeserver matches configured homeserver', async () => {
        await withStagingHomeserverEnv(async () => {
          const { NETWORK_RUNTIME_DEFAULTS } = await import('@/libs/runtime-config/runtime-config.schema');
          const keypair = createMockKeypair();
          const expectedSession = createMockSession();
          mockState.getHomeserverOf.mockResolvedValue({
            z32: () => NETWORK_RUNTIME_DEFAULTS.homeserver,
          });
          mockState.signin.mockResolvedValue(expectedSession);

          const result = await HomeserverService.signIn({ keypair });

          expect(result).toEqual({ session: expectedSession });
          expect(mockState.publishHomeserverForce).not.toHaveBeenCalled();
        });
      });

      it('should keep the staging guard active when homeserver config drifts from the canonical defaults', async () => {
        // Regression: the guard is driven by the declared PUBKY_RUNTIME_ENV, not
        // by config equality with the compiled-in staging defaults — drift used
        // to silently disable it and re-enable the force-republish path.
        await withStagingHomeserverEnv(
          async () => {
            const keypair = createMockKeypair();
            mockState.getHomeserverOf.mockResolvedValue({
              z32: () => 'prod-homeserver-public-key-z32',
            });

            await expect(HomeserverService.signIn({ keypair })).rejects.toMatchObject({
              category: ErrorCategory.Auth,
              code: AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER,
            });
            expect(mockState.signin).not.toHaveBeenCalled();
            expect(mockState.publishHomeserverForce).not.toHaveBeenCalled();
          },
          { keepTestHomeserver: true },
        );
      });
    });

    describe('logout', () => {
      it('should sign out using the Session object', async () => {
        const session = createMockSession();

        await HomeserverService.logout({ session });

        expect(mockState.sessionSignout).toHaveBeenCalledOnce();
      });

      it('should throw error when signout fails', async () => {
        const session = createMockSession();
        mockState.sessionSignout.mockRejectedValue(new Error('Network error'));

        await expect(HomeserverService.logout({ session })).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });
    });

    describe('generateAuthUrl', () => {
      it('should return authorizationUrl and awaitApproval promise', async () => {
        const result = await HomeserverService.generateAuthUrl();

        expect(result).toHaveProperty('authorizationUrl');
        expect(result).toHaveProperty('awaitApproval');
        expect(result).toHaveProperty('cancelAuthFlow');
        expect(typeof result.authorizationUrl).toBe('string');
        expect(result.awaitApproval).toBeInstanceOf(Promise);
      });

      it('should cancel polling before first poll when cancelAuthFlow is called immediately', async () => {
        vi.useFakeTimers();
        try {
          const tryPollOnce = vi.fn().mockResolvedValue(undefined);
          const free = vi.fn();
          mockState.startAuthFlow.mockReturnValue({
            authorizationUrl: 'https://auth.example.com/authorize',
            tryPollOnce,
            free,
          });

          const result = await HomeserverService.generateAuthUrl();
          const approvalPromise = result.awaitApproval;
          const rejection = expect(approvalPromise).rejects.toMatchObject({ name: 'AuthFlowCanceled' });

          result.cancelAuthFlow();
          await vi.runAllTimersAsync();

          await rejection;
          expect(tryPollOnce).not.toHaveBeenCalled();
          expect(free).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('should reject with SESSION_EXPIRED when tryPollOnce throws (SDK exhausted its retry budget)', async () => {
        vi.useFakeTimers();
        try {
          const relayError = { name: 'RequestError', message: 'Gateway Timeout', data: { statusCode: 504 } };
          const tryPollOnce = vi.fn().mockRejectedValue(relayError);
          const free = vi.fn();
          mockState.startAuthFlow.mockReturnValue({
            authorizationUrl: 'https://auth.example.com/authorize',
            tryPollOnce,
            free,
          });

          const result = await HomeserverService.generateAuthUrl();
          const approvalPromise = result.awaitApproval;
          const rejection = expect(approvalPromise).rejects.toMatchObject({
            code: AuthErrorCode.SESSION_EXPIRED,
          });

          await vi.advanceTimersByTimeAsync(0);
          await rejection;

          // Loop must not retry on a dead flow; one throw is terminal.
          expect(tryPollOnce).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('resumes the flow on the same relay channel when the page is visible again after the relay poll dropped', async () => {
        vi.useFakeTimers();
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        try {
          const session = createMockSession();
          // The SDK gives up on a flow after a few failed relay requests; polling that flow again never recovers it.
          const transportError = new Error('Request failed: HTTP transport error: error sending request');
          transportError.name = 'RequestError';
          const deadFlow = {
            authorizationUrl: 'https://auth.example.com/authorize',
            tryPollOnce: vi.fn().mockRejectedValueOnce(transportError).mockResolvedValue(undefined),
            free: vi.fn(),
          };
          const resumedFlow = { tryPollOnce: vi.fn().mockResolvedValue(session), free: vi.fn() };
          mockState.startAuthFlow.mockReturnValue(deadFlow);
          mockState.resumeAuthFlow.mockReturnValue(resumedFlow);

          const result = await HomeserverService.generateAuthUrl();
          await vi.advanceTimersByTimeAsync(0);
          expect(deadFlow.tryPollOnce).toHaveBeenCalledTimes(1);
          // Still in the background: nothing resumes yet.
          await vi.advanceTimersByTimeAsync(5_000);
          expect(mockState.resumeAuthFlow).not.toHaveBeenCalled();

          // Back from Pubky Ring: the page becomes visible and reconnects to the same channel.
          visibility.mockReturnValue('visible');
          document.dispatchEvent(new Event('visibilitychange'));
          await vi.advanceTimersByTimeAsync(0);

          await expect(result.awaitApproval).resolves.toBe(session);
          expect(mockState.resumeAuthFlow).toHaveBeenCalledWith('https://auth.example.com/authorize');
          expect(deadFlow.free).toHaveBeenCalled();
        } finally {
          visibility.mockRestore();
          vi.useRealTimers();
        }
      });

      it('resumes the token flow (single-approval Ring sign-in) after the relay poll dropped in the background', async () => {
        vi.useFakeTimers();
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        try {
          const token = { publicKey: 'token-key' };
          const transportError = new Error('Request failed: HTTP transport error: error sending request');
          transportError.name = 'RequestError';
          const deadFlow = {
            authorizationUrl: 'https://auth.example.com/authorize',
            awaitToken: vi.fn().mockRejectedValue(transportError),
            free: vi.fn(),
          };
          const resumedFlow = { awaitToken: vi.fn().mockResolvedValue(token), free: vi.fn() };
          mockState.startAuthFlow.mockReturnValue(deadFlow);
          mockState.resumeAuthFlow.mockReturnValue(resumedFlow);

          const flow = HomeserverService.generateAuthTokenFlow();
          const approved = flow.awaitToken();
          await vi.advanceTimersByTimeAsync(5_000);
          // Still in the background: nothing resumes yet.
          expect(mockState.resumeAuthFlow).not.toHaveBeenCalled();

          visibility.mockReturnValue('visible');
          document.dispatchEvent(new Event('visibilitychange'));
          await vi.advanceTimersByTimeAsync(0);

          await expect(approved).resolves.toBe(token);
          expect(mockState.resumeAuthFlow).toHaveBeenCalledWith('https://auth.example.com/authorize');
          expect(resumedFlow.free).toHaveBeenCalled();
        } finally {
          visibility.mockRestore();
          vi.useRealTimers();
        }
      });

      it('settles a cancelled approval at once when the relay poll dropped while the page is hidden', async () => {
        vi.useFakeTimers();
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        try {
          const transportError = new Error('Request failed: HTTP transport error: error sending request');
          transportError.name = 'RequestError';
          mockState.startAuthFlow.mockReturnValue({
            authorizationUrl: 'https://auth.example.com/authorize',
            tryPollOnce: vi.fn().mockRejectedValue(transportError),
            free: vi.fn(),
          });

          const result = await HomeserverService.generateAuthUrl();
          let settled = false;
          const outcome = result.awaitApproval.then(
            () => 'resolved',
            (error: Error) => {
              settled = true;
              return error.name;
            },
          );
          await vi.advanceTimersByTimeAsync(0);

          // The page stays in the background: cancelling must not wait for it to become visible.
          result.cancelAuthFlow();
          await vi.advanceTimersByTimeAsync(0);

          expect(settled).toBe(true);
          await expect(outcome).resolves.toBe('AuthFlowCanceled');
          expect(mockState.resumeAuthFlow).not.toHaveBeenCalled();
        } finally {
          visibility.mockRestore();
          vi.useRealTimers();
        }
      });

      it('settles a cancelled token flow at once when the relay poll dropped while the page is hidden', async () => {
        vi.useFakeTimers();
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        try {
          const transportError = new Error('Request failed: HTTP transport error: error sending request');
          transportError.name = 'RequestError';
          mockState.startAuthFlow.mockReturnValue({
            authorizationUrl: 'https://auth.example.com/authorize',
            awaitToken: vi.fn().mockRejectedValue(transportError),
            free: vi.fn(),
          });

          const flow = HomeserverService.generateAuthTokenFlow();
          let settled = false;
          const outcome = flow.awaitToken().catch((error: unknown) => {
            settled = true;
            return error;
          });
          await vi.advanceTimersByTimeAsync(0);

          flow.cancelAuthFlow();
          await vi.advanceTimersByTimeAsync(0);

          expect(settled).toBe(true);
          await expect(outcome).resolves.toBe(transportError);
          expect(mockState.resumeAuthFlow).not.toHaveBeenCalled();
        } finally {
          visibility.mockRestore();
          vi.useRealTimers();
        }
      });

      it('gives up after the resume cap while the page stays visible', async () => {
        vi.useFakeTimers();
        try {
          const transportError = Object.assign(new Error('HTTP transport error'), { name: 'RequestError' });
          const deadFlow = () => ({ tryPollOnce: vi.fn().mockRejectedValue(transportError), free: vi.fn() });
          mockState.startAuthFlow.mockReturnValue({
            authorizationUrl: 'https://auth.example.com/authorize',
            ...deadFlow(),
          });
          mockState.resumeAuthFlow.mockImplementation(deadFlow);

          const result = await HomeserverService.generateAuthUrl();
          const rejection = expect(result.awaitApproval).rejects.toMatchObject({ code: AuthErrorCode.SESSION_EXPIRED });
          await vi.advanceTimersByTimeAsync(61_000);

          await rejection;
          expect(mockState.resumeAuthFlow).toHaveBeenCalledTimes(60);
        } finally {
          vi.useRealTimers();
        }
      });

      it('rejects with SESSION_EXPIRED when the relay channel cannot be resumed', async () => {
        vi.useFakeTimers();
        try {
          const transportError = Object.assign(new Error('HTTP transport error'), { name: 'RequestError' });
          const deadFlow = {
            authorizationUrl: 'https://auth.example.com/authorize',
            tryPollOnce: vi.fn().mockRejectedValue(transportError),
            free: vi.fn(),
          };
          mockState.startAuthFlow.mockReturnValue(deadFlow);
          mockState.resumeAuthFlow.mockImplementation(() => {
            throw Object.assign(new Error('invalid url'), { name: 'AuthenticationError' });
          });

          const result = await HomeserverService.generateAuthUrl();
          const rejection = expect(result.awaitApproval).rejects.toMatchObject({
            code: AuthErrorCode.SESSION_EXPIRED,
            context: { resumeError: 'invalid url' },
          });
          await vi.advanceTimersByTimeAsync(1_000);

          await rejection;
          expect(mockState.resumeAuthFlow).toHaveBeenCalledTimes(1);
          expect(deadFlow.free).toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });

      it('does not resume once the relay no longer holds the approval when the page is visible again', async () => {
        vi.useFakeTimers();
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        try {
          const transportError = Object.assign(new Error('HTTP transport error'), { name: 'RequestError' });
          mockState.startAuthFlow.mockReturnValue({
            authorizationUrl: 'https://auth.example.com/authorize',
            tryPollOnce: vi.fn().mockRejectedValue(transportError),
            free: vi.fn(),
          });

          const result = await HomeserverService.generateAuthUrl();
          const rejection = expect(result.awaitApproval).rejects.toMatchObject({ code: AuthErrorCode.SESSION_EXPIRED });
          // Away for longer than the relay keeps an approval.
          await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
          visibility.mockReturnValue('visible');
          document.dispatchEvent(new Event('visibilitychange'));
          await vi.advanceTimersByTimeAsync(0);

          await rejection;
          expect(mockState.resumeAuthFlow).not.toHaveBeenCalled();
        } finally {
          visibility.mockRestore();
          vi.useRealTimers();
        }
      });

      it('ends the token flow without resuming once the relay no longer holds the approval', async () => {
        vi.useFakeTimers();
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        try {
          const transportError = Object.assign(new Error('HTTP transport error'), { name: 'RequestError' });
          mockState.startAuthFlow.mockReturnValue({
            authorizationUrl: 'https://auth.example.com/authorize',
            awaitToken: vi.fn().mockRejectedValue(transportError),
            free: vi.fn(),
          });

          const flow = HomeserverService.generateAuthTokenFlow();
          const rejection = expect(flow.awaitToken()).rejects.toBe(transportError);
          await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
          visibility.mockReturnValue('visible');
          document.dispatchEvent(new Event('visibilitychange'));
          await vi.advanceTimersByTimeAsync(0);

          await rejection;
          expect(mockState.resumeAuthFlow).not.toHaveBeenCalled();
        } finally {
          visibility.mockRestore();
          vi.useRealTimers();
        }
      });

      it('should call startAuthFlow with default capabilities', async () => {
        await HomeserverService.generateAuthUrl();

        expect(mockState.startAuthFlow).toHaveBeenCalledWith(
          // The Shop's scopes plus pubky.app's, so the shared cookie keeps both sites working.
          '/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r',
          'signin-kind', // AuthFlowKind.signin()
          expect.stringContaining('/inbox'), // HTTP relay (Pubky 0.7+ inbox endpoint)
        );
      });

      it('should call startAuthFlow with custom capabilities when provided', async () => {
        const customCaps = '/custom/path/:r';

        await HomeserverService.generateAuthUrl(customCaps);

        expect(mockState.startAuthFlow).toHaveBeenCalledWith(
          customCaps,
          'signin-kind',
          expect.stringContaining('/inbox'),
        );
      });

      it('should throw error when flow fails', async () => {
        mockState.startAuthFlow.mockImplementation(() => {
          throw new Error('Flow initialization failed');
        });

        await expect(HomeserverService.generateAuthUrl()).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });
    });

    describe('generateGrantAuthUrl (Bitkit sign-in)', () => {
      it('bitkit qr is signin_grant with shop caps and cid', async () => {
        const free = vi.fn();
        mockState.grantStartDelegated.mockResolvedValue({
          authorizationUrl: 'pubkyauth://signin_grant?caps=x&relay=r&secret=s&cid=shop.pubky.app&cpk=k',
          tryPollOnce: vi.fn().mockResolvedValue(undefined),
          free,
        });

        const { authorizationUrl, awaitApproval, cancelAuthFlow } = await HomeserverService.generateGrantAuthUrl();
        awaitApproval.catch(() => undefined);
        cancelAuthFlow();

        expect(mockState.grantStartDelegated).toHaveBeenCalledWith(CAPABILITIES, 'signin-kind', {
          clientId: 'shop.pubky.app',
          relay: expect.any(String),
        });
        expect(authorizationUrl.startsWith('pubkyauth://signin_grant')).toBe(true);
        expect(free).toHaveBeenCalled();
      });

      it('reports grant sign-in availability from the SDK', () => {
        expect(HomeserverService.isGrantSignInAvailable()).toBe(true);
      });
    });

    describe('grant key removal (sign-out and expiry cleanup)', () => {
      // After the module reset above: the error class must come from the same graph.
      let isGrantKeyRemovalError: typeof import('./error.utils').isGrantKeyRemovalError;

      beforeEach(async () => {
        ({ isGrantKeyRemovalError } = await import('./error.utils'));
        mockState.grantStoreRemove.mockReset().mockResolvedValue(undefined);
        mockState.grantStoreClearAll.mockReset().mockResolvedValue(undefined);
        mockState.grantStoreList.mockReset().mockResolvedValue([]);
        mockState.grantStoreIsAvailable.mockReset().mockResolvedValue(true);
      });

      it('remove rejects while the record is still stored, even when the SDK call resolved', async () => {
        mockState.grantStoreList.mockResolvedValue([{ id: 'rec-1' }]);

        const failure = await HomeserverService.removeGrantSession('rec-1').catch((error: unknown) => error);

        expect(isGrantKeyRemovalError(failure)).toBe(true);
        expect(mockState.grantStoreRemove).toHaveBeenCalledWith('rec-1');
      });

      it('remove rejects when the SDK delete fails and the record is still stored', async () => {
        mockState.grantStoreRemove.mockRejectedValue(new Error('IndexedDB delete failed'));
        mockState.grantStoreList.mockResolvedValue([{ id: 'rec-1' }, { id: 'rec-2' }]);

        const failure = await HomeserverService.removeGrantSession('rec-1').catch((error: unknown) => error);

        expect(isGrantKeyRemovalError(failure)).toBe(true);
      });

      it('remove rejects when the store cannot be read back', async () => {
        mockState.grantStoreList.mockRejectedValue(new Error('IndexedDB unavailable'));

        const failure = await HomeserverService.removeGrantSession('rec-1').catch((error: unknown) => error);

        expect(isGrantKeyRemovalError(failure)).toBe(true);
      });

      it('remove resolves once the record is gone, even if the SDK delete reported an error', async () => {
        mockState.grantStoreRemove.mockRejectedValue(new Error('already deleted'));
        mockState.grantStoreList.mockResolvedValue([{ id: 'rec-2' }]);

        await expect(HomeserverService.removeGrantSession('rec-1')).resolves.toBeUndefined();
      });

      it('clearAll rejects while any record is still stored', async () => {
        mockState.grantStoreClearAll.mockRejectedValue(new Error('IndexedDB clear failed'));
        mockState.grantStoreList.mockResolvedValue([{ id: 'rec-1' }]);

        const failure = await HomeserverService.clearGrantSessions().catch((error: unknown) => error);

        expect(isGrantKeyRemovalError(failure)).toBe(true);
      });

      it('clearAll resolves when the store reads back empty', async () => {
        await expect(HomeserverService.clearGrantSessions()).resolves.toBeUndefined();
        expect(mockState.grantStoreClearAll).toHaveBeenCalledTimes(1);
        expect(mockState.grantStoreList).toHaveBeenCalledTimes(1);
      });

      it('clearAll is a no-op without IndexedDB persistence', async () => {
        mockState.grantStoreIsAvailable.mockResolvedValue(false);

        await expect(HomeserverService.clearGrantSessions()).resolves.toBeUndefined();
        expect(mockState.grantStoreClearAll).not.toHaveBeenCalled();
      });
    });

    describe('restoreSession (cookie reload)', () => {
      it('reload restores cookie session via Session.restore', async () => {
        const restored = createMockSession();
        mockState.sessionRestore.mockResolvedValue(restored);

        const result = await HomeserverService.restoreSession({ sessionExport: 'c2Vzc2lvbi1leHBvcnQ=' });

        expect(result).toBe(restored);
        expect(mockState.sessionRestore).toHaveBeenCalledWith('c2Vzc2lvbi1leHBvcnQ=', expect.anything());
        expect(mockState.restoreSession).not.toHaveBeenCalled();
      });
    });

    describe('currentSessionHasFullGrant', () => {
      const PUBKY_APP_SIGN_IN = '/pub/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r';
      const cookieSession = (capabilities: string) =>
        asOpaque<Session>({ info: { capabilities: capabilities.split(',') } });
      const grantSession = (capabilities: string) =>
        asOpaque<Session>({ info: { capabilities: capabilities.split(',') }, grant: { id: 'grant-1' } });

      it.each([
        ['a Ring cookie session holding the Ring set', cookieSession(RING_COOKIE_CAPABILITIES), true],
        [
          'a Ring cookie session holding the Ring set in another order',
          cookieSession(RING_COOKIE_CAPABILITIES.split(',').reverse().join(',')),
          true,
        ],
        ['a cookie session that pubky.app narrowed to its own set', cookieSession(PUBKY_APP_SIGN_IN), false],
        ['a cookie session holding only the Shop grant', cookieSession(CAPABILITIES), false],
        ['a root cookie session', cookieSession('/:rw'), false],
        ['a grant session holding the Shop grant', grantSession(CAPABILITIES), true],
        ['a grant session holding the Ring set', grantSession(RING_COOKIE_CAPABILITIES), false],
      ])('%s → %s', (_label, session, full) => {
        mockState.currentSession = session;

        expect(HomeserverService.currentSessionHasFullGrant()).toBe(full);
      });

      it('is false with no session', () => {
        mockState.currentSession = null;

        expect(HomeserverService.currentSessionHasFullGrant()).toBe(false);
      });

      it("reports the Shop's private and Paykit trees unwritable once pubky.app narrowed the cookie", () => {
        mockState.currentSession = cookieSession(PUBKY_APP_SIGN_IN);
        expect(HomeserverService.canCurrentSessionWrite('/priv/pubky.app/')).toBe(false);
        expect(HomeserverService.canCurrentSessionWrite('/pub/paykit/')).toBe(false);
        expect(HomeserverService.canCurrentSessionWrite('/pub/pubky.app/')).toBe(true);

        mockState.currentSession = cookieSession(RING_COOKIE_CAPABILITIES);
        expect(HomeserverService.canCurrentSessionWrite('/priv/pubky.app/')).toBe(true);
        expect(HomeserverService.canCurrentSessionWrite('/pub/paykit/')).toBe(true);
        expect(HomeserverService.canCurrentSessionWrite('/priv/social/')).toBe(true);
      });
    });

    describe('signInWithFullGrantAuthToken', () => {
      const z32 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const fullCaps = RING_COOKIE_CAPABILITIES.split(',');
      const bytes = new Uint8Array([9, 8, 7]);

      beforeEach(() => {
        mockState.authTokenFromBytes.mockReturnValue({
          capabilities: fullCaps,
          publicKey: { z32: () => z32 },
        });
        mockState.sessionRestore.mockResolvedValue(createMockSession());
      });

      it('POSTs to the session endpoint after a full-grant capability check', async () => {
        mockState.clientFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

        await HomeserverService.signInWithFullGrantAuthToken(bytes);

        expect(mockState.authTokenFromBytes).toHaveBeenCalledWith(bytes);
        expect(mockState.clientFetch).toHaveBeenCalledWith(
          `https://_pubky.${z32}/session`,
          expect.objectContaining({ method: 'POST', credentials: 'include', body: bytes }),
        );
        expect(mockState.sessionRestore).toHaveBeenCalledWith(expect.any(String), expect.anything());
        expect(mockState.restoreSession).not.toHaveBeenCalled();
      });

      it('hydrates with the same standard padded base64 alphabet session.export() uses', async () => {
        // 0xfb 0xff 0xfe encodes to '+//+' ONLY under the standard base64
        // alphabet (base64url would be '-__-'); a trailing 0xfb forces '='
        // padding ('+w=='). Both are what the d.ts means by "base64" — the
        // alphabet restore accepted on staging (single-approval.md §9 step 0,
        // recorded as empirical) is pinned here in the helper path.
        mockState.clientFetch
          .mockResolvedValueOnce(new Response(new Uint8Array([0xfb, 0xff, 0xfe]), { status: 200 }))
          .mockResolvedValueOnce(new Response(new Uint8Array([0xfb]), { status: 200 }));

        await HomeserverService.signInWithFullGrantAuthToken(bytes);
        await HomeserverService.signInWithFullGrantAuthToken(bytes);

        expect(mockState.sessionRestore).toHaveBeenNthCalledWith(1, '+//+', expect.anything());
        expect(mockState.sessionRestore).toHaveBeenNthCalledWith(2, '+w==', expect.anything());
      });

      it('accepts a reordered full grant (order-insensitive set equality)', async () => {
        mockState.authTokenFromBytes.mockReturnValue({
          capabilities: [...fullCaps].reverse(),
          publicKey: { z32: () => z32 },
        });
        mockState.clientFetch.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));

        await HomeserverService.signInWithFullGrantAuthToken(bytes);

        expect(mockState.clientFetch).toHaveBeenCalled();
      });

      it('refuses empty-capability bytes before POSTing /session', async () => {
        mockState.authTokenFromBytes.mockReturnValue({
          capabilities: [],
          publicKey: { z32: () => z32 },
        });

        await expect(HomeserverService.signInWithFullGrantAuthToken(bytes)).rejects.toMatchObject({
          category: ErrorCategory.Validation,
          code: ValidationErrorCode.INVALID_INPUT,
        });
        expect(mockState.clientFetch).not.toHaveBeenCalled();
      });

      it.each([
        ['the Shop grant alone', CAPABILITIES],
        ["pubky.app's own sign-in set", '/pub/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r'],
        ['the Ring set plus root', `${RING_COOKIE_CAPABILITIES},/:rw`],
      ])('refuses %s before POSTing /session', async (_label, capabilities) => {
        mockState.authTokenFromBytes.mockReturnValue({
          capabilities: capabilities.split(','),
          publicKey: { z32: () => z32 },
        });

        await expect(HomeserverService.signInWithFullGrantAuthToken(bytes)).rejects.toMatchObject({
          code: ValidationErrorCode.INVALID_INPUT,
        });
        expect(mockState.clientFetch).not.toHaveBeenCalled();
      });

      it('refuses a missing capability before POSTing /session', async () => {
        mockState.authTokenFromBytes.mockReturnValue({
          capabilities: fullCaps.slice(0, 2),
          publicKey: { z32: () => z32 },
        });

        await expect(HomeserverService.signInWithFullGrantAuthToken(bytes)).rejects.toMatchObject({
          code: ValidationErrorCode.INVALID_INPUT,
        });
        expect(mockState.clientFetch).not.toHaveBeenCalled();
      });

      it('treats homeserver AlreadyUsed as GET /session hydrate, not failure', async () => {
        // STATUS PIN NOTE: 400 is what the Node-side run recorded for a
        // homeserver replay; the WASM-path status is recorded as UNPROVEN in
        // single-approval.md §9. The helper must not depend on the exact
        // number — it probes GET /session after ANY non-ok POST (see the
        // next test), so this 400 is illustrative, not load-bearing.
        mockState.clientFetch
          .mockResolvedValueOnce(new Response('already used', { status: 400 }))
          .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]), { status: 200 }));

        await HomeserverService.signInWithFullGrantAuthToken(bytes);

        expect(mockState.clientFetch).toHaveBeenNthCalledWith(
          2,
          `https://_pubky.${z32}/session`,
          expect.objectContaining({ method: 'GET', credentials: 'include' }),
        );
        expect(mockState.sessionRestore).toHaveBeenCalled();
      });

      it('probes GET /session after any non-ok POST status, not just the recorded 400', async () => {
        for (const status of [401, 409, 500]) {
          mockState.clientFetch.mockReset();
          mockState.sessionRestore.mockClear();
          mockState.clientFetch
            .mockResolvedValueOnce(new Response('nope', { status }))
            .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]), { status: 200 }));

          await HomeserverService.signInWithFullGrantAuthToken(bytes);

          expect(mockState.clientFetch).toHaveBeenNthCalledWith(
            2,
            `https://_pubky.${z32}/session`,
            expect.objectContaining({ method: 'GET', credentials: 'include' }),
          );
          expect(mockState.sessionRestore).toHaveBeenCalled();
        }
      });

      it('fails sign-in when restore fails after a 2xx POST, without a fallback GET', async () => {
        mockState.clientFetch.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
        mockState.sessionRestore.mockRejectedValueOnce(new Error('restore failed'));

        await expect(HomeserverService.signInWithFullGrantAuthToken(bytes)).rejects.toMatchObject({
          message: 'Sign-in failed. Scan again.',
        });
        // Exactly one call: the POST. No GET probe follows a restore failure
        // (the cookie may be missing; a probe would mask that).
        expect(mockState.clientFetch).toHaveBeenCalledTimes(1);
      });

      it('never puts the AuthToken bytes into error context or logger arguments', async () => {
        // Distinctive, recognizable bytes: their base64 form and their
        // comma-joined decimal form must appear nowhere observable.
        const sensitive = new Uint8Array([170, 187, 204, 221, 238]);
        const asBase64 = bytesToBase64(sensitive);
        const asDecimal = sensitive.join(',');
        mockState.clientFetch
          .mockResolvedValueOnce(new Response('already used', { status: 400 }))
          .mockResolvedValueOnce(new Response('no session', { status: 404 }));

        const error = await HomeserverService.signInWithFullGrantAuthToken(sensitive).catch((caught) => caught);

        expect(error).toMatchObject({ code: AuthErrorCode.UNAUTHORIZED, context: { stage: 'no-session' } });
        const observable = JSON.stringify({
          context: (error as AppError).context,
          loggerCalls: [
            ...vi.mocked(Logger.error).mock.calls,
            ...vi.mocked(Logger.warn).mock.calls,
            ...vi.mocked(Logger.info).mock.calls,
            ...vi.mocked(Logger.debug).mock.calls,
          ],
        });
        expect(observable).not.toContain(asBase64);
        expect(observable).not.toContain(asDecimal);
      });
    });
  });

  // ===========================================================================
  // DATA OPERATIONS
  // ===========================================================================

  describe('Data Operations', () => {
    describe('request', () => {
      describe('GET requests', () => {
        it('should return parsed JSON for successful GET', async () => {
          mockState.currentSession = createMockSession();
          const testData = { name: 'test', value: 123 };
          mockState.sessionStorageGet.mockResolvedValue(new Response(JSON.stringify(testData), { status: 200 }));

          const result = await HomeserverService.request<typeof testData>({
            method: HttpMethod.GET,
            url: 'pubky://user/pub/data.json',
          });

          expect(result).toEqual(testData);
          expect(mockState.sessionStorageGet).toHaveBeenCalledWith('/pub/data.json');
        });

        it('should return undefined for empty GET response', async () => {
          mockState.currentSession = createMockSession();
          mockState.sessionStorageGet.mockResolvedValue(new Response('', { status: 200 }));

          const result = await HomeserverService.request({
            method: HttpMethod.GET,
            url: 'pubky://user/pub/empty.json',
          });

          expect(result).toBeUndefined();
        });

        it('should return undefined for invalid JSON response', async () => {
          mockState.currentSession = createMockSession();
          mockState.sessionStorageGet.mockResolvedValue(new Response('not-valid-json', { status: 200 }));

          const result = await HomeserverService.request({
            method: HttpMethod.GET,
            url: 'pubky://user/pub/invalid.json',
          });

          expect(result).toBeUndefined();
        });
      });

      describe('PUT requests', () => {
        it('should send JSON body for PUT request', async () => {
          mockState.currentSession = createMockSession();
          const bodyData = { name: 'new-value' };
          await HomeserverService.request({
            method: HttpMethod.PUT,
            url: 'pubky://user/pub/data.json',
            bodyJson: bodyData,
          });

          expect(mockState.sessionStoragePutJson).toHaveBeenCalledWith('/pub/data.json', bodyData);
        });

        it('should throw INVALID_INPUT when PUT is attempted without a session on a pubky:// address', async () => {
          mockState.currentSession = null;
          await expect(
            HomeserverService.request({
              method: HttpMethod.PUT,
              url: 'pubky://someone/pub/data.json',
              bodyJson: { ok: true },
            }),
          ).rejects.toMatchObject({
            category: ErrorCategory.Validation,
            code: ValidationErrorCode.INVALID_INPUT,
          });
        });

        it('should return undefined for successful PUT', async () => {
          mockState.currentSession = createMockSession();

          const result = await HomeserverService.request({
            method: HttpMethod.PUT,
            url: 'pubky://user/pub/data.json',
            bodyJson: {
              data: 'test',
            },
          });

          expect(result).toBeUndefined();
        });
      });

      describe('DELETE requests', () => {
        it('should send DELETE request without body', async () => {
          mockState.currentSession = createMockSession();

          await HomeserverService.request({ method: HttpMethod.DELETE, url: 'pubky://user/pub/data.json' });

          expect(mockState.sessionStorageDelete).toHaveBeenCalledWith('/pub/data.json');
        });
      });

      describe('Error handling', () => {
        it('should throw NOT_FOUND error for 404 response', async () => {
          mockState.currentSession = createMockSession();
          mockState.sessionStorageGet.mockResolvedValue(
            new Response('Not Found', { status: 404, statusText: 'Not Found' }),
          );

          await expect(
            HomeserverService.request({ method: HttpMethod.GET, url: 'pubky://user/pub/missing.json' }),
          ).rejects.toMatchObject({
            category: ErrorCategory.Client,
            code: ClientErrorCode.NOT_FOUND,
          });
        });

        it('should throw SESSION_EXPIRED error for 401 response', async () => {
          mockState.currentSession = createMockSession();
          mockState.sessionStorageGet.mockResolvedValue(
            new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
          );

          await expect(
            HomeserverService.request({ method: HttpMethod.GET, url: 'pubky://user/pub/data.json' }),
          ).rejects.toMatchObject({
            category: ErrorCategory.Auth,
            code: AuthErrorCode.SESSION_EXPIRED,
          });
        });

        it('should throw INTERNAL_ERROR for network errors', async () => {
          mockState.currentSession = createMockSession();
          mockState.sessionStorageGet.mockRejectedValue(new Error('Network error'));

          await expect(
            HomeserverService.request({ method: HttpMethod.GET, url: 'pubky://user/pub/data.json' }),
          ).rejects.toMatchObject({
            category: ErrorCategory.Server,
            code: ServerErrorCode.INTERNAL_ERROR,
          });
        });
      });
    });

    describe('getJsonIfFound', () => {
      it('answers not found for a 404 response, logging and reporting nothing', async () => {
        mockState.currentSession = createMockSession();
        mockState.sessionStorageGet.mockResolvedValue(new Response('Not Found', { status: 404 }));

        await expect(
          HomeserverService.getJsonIfFound({ url: 'pubky://user/priv/missing.json', logUrl: '/priv/redacted/' }),
        ).resolves.toEqual({ found: false });
        expect(mockState.sessionStorageGet).toHaveBeenCalledWith('/priv/missing.json');
        expect(Logger.error).not.toHaveBeenCalled();
        expect(Logger.warn).not.toHaveBeenCalled();
      });

      it('answers not found when the client throws the 404', async () => {
        mockState.currentSession = createMockSession();
        mockState.sessionStorageGet.mockRejectedValue({
          name: 'RequestError',
          message: 'Not Found',
          data: { statusCode: 404 },
        });

        await expect(HomeserverService.getJsonIfFound({ url: 'pubky://user/priv/missing.json' })).resolves.toEqual({
          found: false,
        });
        expect(Logger.error).not.toHaveBeenCalled();
      });

      it('answers not found for a public 404', async () => {
        mockState.currentSession = null;
        mockState.publicStorageGet.mockResolvedValue(new Response('Not Found', { status: 404 }));

        await expect(HomeserverService.getJsonIfFound({ url: 'pubky://someone/pub/missing.json' })).resolves.toEqual({
          found: false,
        });
        expect(Logger.error).not.toHaveBeenCalled();
      });

      it('returns the parsed body of a stored record, a stored null included', async () => {
        mockState.currentSession = createMockSession();
        mockState.sessionStorageGet
          .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'kept' }), { status: 200 }))
          .mockResolvedValueOnce(new Response('null', { status: 200 }));

        await expect(HomeserverService.getJsonIfFound({ url: 'pubky://user/priv/a.json' })).resolves.toEqual({
          found: true,
          json: { name: 'kept' },
        });
        await expect(HomeserverService.getJsonIfFound({ url: 'pubky://user/priv/b.json' })).resolves.toEqual({
          found: true,
          json: null,
        });
      });

      it('throws every other failure like a GET', async () => {
        mockState.currentSession = createMockSession();
        mockState.sessionStorageGet
          .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
          .mockResolvedValueOnce(new Response('Boom', { status: 500 }))
          .mockRejectedValueOnce(new Error('Network error'));

        await expect(HomeserverService.getJsonIfFound({ url: 'pubky://user/priv/a.json' })).rejects.toMatchObject({
          category: ErrorCategory.Auth,
          code: AuthErrorCode.SESSION_EXPIRED,
        });
        await expect(HomeserverService.getJsonIfFound({ url: 'pubky://user/priv/a.json' })).rejects.toMatchObject({
          category: ErrorCategory.Server,
        });
        await expect(HomeserverService.getJsonIfFound({ url: 'pubky://user/priv/a.json' })).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });
    });

    describe('putBlob', () => {
      it('should upload binary data successfully', async () => {
        mockState.currentSession = createMockSession();
        const blobData = new Uint8Array([1, 2, 3, 4, 5]);

        await HomeserverService.putBlob({ url: 'pubky://user/pub/avatar.png', blob: blobData });

        expect(mockState.sessionStoragePutBytes).toHaveBeenCalledWith('/pub/avatar.png', blobData);
      });

      it('should throw PAYLOAD_TOO_LARGE error for 413 response', async () => {
        mockState.currentSession = createMockSession();
        const blobData = new Uint8Array([1, 2, 3]);
        mockState.sessionStoragePutBytes.mockRejectedValue({
          name: 'RequestError',
          message: 'Payload Too Large',
          data: { statusCode: 413 },
        });

        await expect(
          HomeserverService.putBlob({ url: 'pubky://user/pub/large.bin', blob: blobData }),
        ).rejects.toMatchObject({
          category: ErrorCategory.Client,
          code: ClientErrorCode.PAYLOAD_TOO_LARGE,
        });
      });

      it('should throw SESSION_EXPIRED error for 401 response', async () => {
        mockState.currentSession = createMockSession();
        const blobData = new Uint8Array([1, 2, 3]);
        mockState.sessionStoragePutBytes.mockRejectedValue({
          name: 'AuthenticationError',
          message: 'Session expired',
          data: { statusCode: 401 },
        });

        await expect(
          HomeserverService.putBlob({ url: 'pubky://user/pub/avatar.png', blob: blobData }),
        ).rejects.toMatchObject({
          category: ErrorCategory.Auth,
          code: AuthErrorCode.SESSION_EXPIRED,
        });
      });

      // Digital deliverables live at unpublished paths (digital delivery
      // design §2): errors and logs name the redacted path only.
      it('records the redacted logUrl, never the real path, when an upload fails', async () => {
        mockState.currentSession = createMockSession();
        const realPath = 'pubky://user/pub/pubky.app/marketplace/v1/deliverables/0123456789abcdef0123456789abcdef/1';
        const logUrl = '/pub/pubky.app/marketplace/v1/deliverables/<deliverable>';
        mockState.sessionStoragePutBytes.mockRejectedValue({
          name: 'RequestError',
          message: 'Insufficient Storage',
          data: { statusCode: 507 },
        });
        const loggerError = vi.spyOn(Logger, 'error');

        const error = (await HomeserverService.putBlob({ url: realPath, blob: new Uint8Array([1]), logUrl }).catch(
          (caught: unknown) => caught,
        )) as AppError;

        expect(error.context).toMatchObject({ endpoint: logUrl, statusCode: 507 });
        expect(JSON.stringify(error.context)).not.toContain('0123456789abcdef');
        expect(JSON.stringify(loggerError.mock.calls)).not.toContain('0123456789abcdef');
        loggerError.mockRestore();
      });

      it('records the redacted logUrl when an upload has no session', async () => {
        mockState.currentSession = null;
        const error = (await HomeserverService.putBlob({
          url: 'pubky://someone/pub/pubky.app/marketplace/v1/deliverables/0123456789abcdef0123456789abcdef/1',
          blob: new Uint8Array([1]),
          logUrl: '/pub/pubky.app/marketplace/v1/deliverables/<deliverable>',
        }).catch((caught: unknown) => caught)) as AppError;

        expect(JSON.stringify(error.context)).not.toContain('0123456789abcdef');
      });

      it('records the redacted logUrl when a delete fails', async () => {
        mockState.currentSession = createMockSession();
        mockState.sessionStorageDelete.mockRejectedValue(new Error('Network error'));

        const error = (await HomeserverService.request({
          method: HttpMethod.DELETE,
          url: 'pubky://user/pub/pubky.app/marketplace/v1/deliverables/0123456789abcdef0123456789abcdef/1',
          logUrl: '/pub/pubky.app/marketplace/v1/deliverables/<deliverable>',
        }).catch((caught: unknown) => caught)) as AppError;

        expect(error.context).toMatchObject({ endpoint: '/pub/pubky.app/marketplace/v1/deliverables/<deliverable>' });
        expect(JSON.stringify(error.context)).not.toContain('0123456789abcdef');
      });

      it('should throw INVALID_INPUT when uploading blob without a session to a pubky:// address', async () => {
        mockState.currentSession = null;
        const blobData = new Uint8Array([1, 2, 3]);

        await expect(
          HomeserverService.putBlob({ url: 'pubky://someone/pub/avatar.png', blob: blobData }),
        ).rejects.toMatchObject({
          category: ErrorCategory.Validation,
          code: ValidationErrorCode.INVALID_INPUT,
        });
      });
    });

    describe('list', () => {
      it('should return array of file URLs', async () => {
        const mockFiles = ['file1.json', 'file2.json', 'file3.json'];
        mockState.publicStorageList.mockResolvedValue(mockFiles);

        const result = await HomeserverService.list({ baseDirectory: 'pubky://user/pub/posts/' });

        expect(result).toEqual(mockFiles);
      });

      it('should use session.storage.list for owned directories when session is set', async () => {
        mockState.currentSession = createMockSession();
        const mockFiles = ['pubky://user/pub/posts/file1.json', 'pubky://user/pub/posts/file2.json'];
        mockState.sessionStorageList.mockResolvedValue(mockFiles);

        const result = await HomeserverService.list({ baseDirectory: 'pubky://user/pub/posts/' });

        expect(result).toEqual(mockFiles);
        expect(mockState.sessionStorageList).toHaveBeenCalledWith(
          '/pub/posts/',
          null, // cursor
          false, // reverse
          500, // limit
          false, // shallow
        );
        expect(mockState.publicStorageList).not.toHaveBeenCalled();
      });

      it('should call list with default parameters', async () => {
        mockState.publicStorageList.mockResolvedValue([]);

        await HomeserverService.list({ baseDirectory: 'pubky://user/pub/posts/' });

        expect(mockState.publicStorageList).toHaveBeenCalledWith(
          'pubky://user/pub/posts/',
          null, // cursor
          false, // reverse
          500, // limit
          false, // shallow
        );
      });

      it('should pass pagination parameters to list', async () => {
        mockState.publicStorageList.mockResolvedValue([]);

        await HomeserverService.list({
          baseDirectory: 'pubky://user/pub/posts/',
          cursor: 'cursor123',
          reverse: true,
          limit: 100,
        });

        expect(mockState.publicStorageList).toHaveBeenCalledWith(
          'pubky://user/pub/posts/',
          'cursor123',
          true,
          100,
          false,
        );
      });

      it('should throw INTERNAL_ERROR on list failure', async () => {
        mockState.publicStorageList.mockRejectedValue(new Error('List failed'));

        await expect(HomeserverService.list({ baseDirectory: 'pubky://user/pub/posts/' })).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });

      it('should return empty array when directory returns 404', async () => {
        mockState.publicStorageList.mockRejectedValue({ data: { statusCode: 404 } });

        const result = await HomeserverService.list({ baseDirectory: 'pubky://user/pub/missing/' });

        expect(result).toEqual([]);
      });

      it('records the redacted logUrl, never the listed directory, when an owned list fails', async () => {
        mockState.currentSession = createMockSession();
        const directory = 'pubky://user/priv/pubky.app/marketplace/v1/receipts/';
        const logUrl = '/priv/pubky.app/marketplace/v1/<entry>';
        mockState.sessionStorageList.mockRejectedValue(new Error('List failed'));
        const debug = vi.spyOn(Logger, 'debug');
        const warn = vi.spyOn(Logger, 'warn');

        const error = (await HomeserverService.list({ baseDirectory: directory, logUrl }).catch(
          (caught: unknown) => caught,
        )) as AppError;

        expect(error.context).toMatchObject({ endpoint: logUrl });
        expect(JSON.stringify(error.context)).not.toContain('receipts');

        mockState.sessionStorageList.mockResolvedValue([`${directory}r1`]);
        await HomeserverService.list({ baseDirectory: directory, logUrl });
        mockState.sessionStorageList.mockRejectedValue({ data: { statusCode: 404 } });
        await HomeserverService.list({ baseDirectory: directory, logUrl });
        const logged = JSON.stringify([...debug.mock.calls, ...warn.mock.calls]);
        expect(logged).toContain(logUrl);
        expect(logged).not.toContain('receipts');
      });
    });

    describe('listAll', () => {
      const baseDirectory = 'pubky://user/pub/posts/';
      const makeFiles = (count: number, offset = 0) =>
        Array.from({ length: count }, (_, i) => `${baseDirectory}file${String(offset + i).padStart(4, '0')}`);

      it('should return all files in a single page when below the page limit', async () => {
        const files = makeFiles(3);
        mockState.publicStorageList.mockResolvedValue(files);

        const result = await HomeserverService.listAll({ baseDirectory });

        expect(result).toEqual(files);
        expect(mockState.publicStorageList).toHaveBeenCalledTimes(1);
        expect(mockState.publicStorageList).toHaveBeenCalledWith(baseDirectory, null, false, 500, false);
      });

      it('should paginate with the last URL as cursor until a short page is returned', async () => {
        const page1 = makeFiles(500);
        const page2 = makeFiles(200, 500);
        mockState.publicStorageList.mockImplementation((_dir: string, cursor: string | null) =>
          Promise.resolve(cursor === null ? page1 : page2),
        );

        const result = await HomeserverService.listAll({ baseDirectory });

        expect(result).toEqual([...page1, ...page2]);
        expect(mockState.publicStorageList).toHaveBeenCalledTimes(2);
        expect(mockState.publicStorageList).toHaveBeenNthCalledWith(2, baseDirectory, page1[499], false, 500, false);
      });

      it('should stop after an empty page when the file count is an exact multiple of the page size', async () => {
        const page1 = makeFiles(500);
        mockState.publicStorageList.mockImplementation((_dir: string, cursor: string | null) =>
          Promise.resolve(cursor === null ? page1 : []),
        );

        const result = await HomeserverService.listAll({ baseDirectory });

        expect(result).toEqual(page1);
        expect(mockState.publicStorageList).toHaveBeenCalledTimes(2);
      });

      it('should propagate list failures', async () => {
        mockState.publicStorageList.mockRejectedValue(new Error('List failed'));

        await expect(HomeserverService.listAll({ baseDirectory })).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });
    });

    describe('delete', () => {
      it('should call request with DELETE method', async () => {
        mockState.currentSession = createMockSession();

        await HomeserverService.delete('pubky://user/pub/file.json');

        expect(mockState.sessionStorageDelete).toHaveBeenCalledWith('/pub/file.json');
      });

      it('should throw FORBIDDEN error on delete failure with 403', async () => {
        // NOTE: For owned paths, delete uses session.storage.delete
        // handleError extracts status code from error.data.statusCode if available
        mockState.currentSession = createMockSession();
        mockState.sessionStorageDelete.mockRejectedValue({
          name: 'RequestError',
          message: 'Forbidden',
          data: { statusCode: 403 },
        });

        await expect(HomeserverService.delete('pubky://user/pub/protected.json')).rejects.toMatchObject({
          category: ErrorCategory.Auth,
          code: AuthErrorCode.FORBIDDEN,
        });
      });
    });

    describe('getBlob', () => {
      const realPath = 'pubky://someone/pub/pubky.app/marketplace/v1/deliverables/0123456789abcdef0123456789abcdef/2';
      const logUrl = '/pub/pubky.app/marketplace/v1/deliverables/<deliverable>';

      it('reads the bytes of a public path', async () => {
        mockState.publicStorageGet.mockResolvedValue(new Response(new Uint8Array([7, 8, 9]), { status: 200 }));

        const bytes = await HomeserverService.getBlob({ url: realPath, logUrl });

        expect(mockState.publicStorageGet).toHaveBeenCalledWith(realPath);
        expect([...bytes]).toEqual([7, 8, 9]);
      });

      // Digital delivery design §2: a buyer's read of a deliverable names the redacted path only.
      it('records the redacted logUrl, never the real path, when the read fails', async () => {
        mockState.publicStorageGet.mockResolvedValue(new Response('gone', { status: 404 }));
        const loggerError = vi.spyOn(Logger, 'error');

        const error = (await HomeserverService.getBlob({ url: realPath, logUrl }).catch(
          (caught: unknown) => caught,
        )) as AppError;

        expect(error.context).toMatchObject({ endpoint: logUrl, statusCode: 404 });
        expect(JSON.stringify(error.context)).not.toContain('0123456789abcdef');
        expect(JSON.stringify(loggerError.mock.calls)).not.toContain('0123456789abcdef');
        loggerError.mockRestore();
      });

      // Review P2: an oversized body is refused before it is held in memory.
      it('refuses a declared body over maxBytes without reading it', async () => {
        let pulled = 0;
        const stream = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(64));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        );
        const body = new Response(stream, { status: 200, headers: { 'content-length': '64' } });
        const arrayBuffer = vi.spyOn(body, 'arrayBuffer');
        mockState.publicStorageGet.mockResolvedValue(body);

        const error = (await HomeserverService.getBlob({ url: realPath, logUrl, maxBytes: 19 }).catch(
          (caught: unknown) => caught,
        )) as AppError;

        expect(error).toMatchObject({
          code: ClientErrorCode.PAYLOAD_TOO_LARGE,
          context: { endpoint: logUrl, maxBytes: 19 },
        });
        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(pulled).toBe(0);
      });

      it('stops reading a streamed body once it passes maxBytes', async () => {
        let pulled = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(10));
            if (pulled > 100) controller.close();
          },
        });
        mockState.publicStorageGet.mockResolvedValue(new Response(stream, { status: 200 }));

        await expect(HomeserverService.getBlob({ url: realPath, logUrl, maxBytes: 19 })).rejects.toMatchObject({
          code: ClientErrorCode.PAYLOAD_TOO_LARGE,
        });
        expect(pulled).toBeLessThan(10);
      });

      it('reads a body within maxBytes', async () => {
        mockState.publicStorageGet.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

        const bytes = await HomeserverService.getBlob({ url: realPath, logUrl, maxBytes: 3 });

        expect([...bytes]).toEqual([1, 2, 3]);
      });

      it('records the redacted logUrl when the transport throws', async () => {
        mockState.publicStorageGet.mockRejectedValue(new Error('Network error'));

        const error = (await HomeserverService.getBlob({ url: realPath, logUrl }).catch(
          (caught: unknown) => caught,
        )) as AppError;

        expect(JSON.stringify(error.context)).not.toContain('0123456789abcdef');
      });
    });

    describe('get', () => {
      it('should use publicStorage.get for fetching', async () => {
        const testUrl = 'pubky://user/pub/public.json';
        const mockResponse = new Response(JSON.stringify({ data: 'public' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
        mockState.publicStorageGet.mockResolvedValue(mockResponse);

        const result = await HomeserverService.get(testUrl);

        expect(mockState.publicStorageGet).toHaveBeenCalledWith(testUrl);
        expect(result).toBeInstanceOf(Response);
        const jsonData = await result.json();
        expect(jsonData).toEqual({ data: 'public' });
      });

      it('should use session.storage.get for owned paths when session is set', async () => {
        mockState.currentSession = createMockSession();
        const testUrl = 'pubky://user/pub/private.json';
        const mockResponse = new Response(JSON.stringify({ data: 'private' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
        mockState.sessionStorageGet.mockResolvedValue(mockResponse);

        const result = await HomeserverService.get(testUrl);

        expect(mockState.sessionStorageGet).toHaveBeenCalledWith('/pub/private.json');
        expect(mockState.publicStorageGet).not.toHaveBeenCalled();
        expect(result).toBeInstanceOf(Response);
        const jsonData = await result.json();
        expect(jsonData).toEqual({ data: 'private' });
      });

      it('should wrap errors from publicStorage.get as AppError', async () => {
        const testUrl = 'pubky://user/pub/data.json';
        const networkError = new Error('Network request failed');
        mockState.publicStorageGet.mockRejectedValue(networkError);

        await expect(HomeserverService.get(testUrl)).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });
    });

    describe('exists', () => {
      const testUrl = 'pubky://user/pub/resource.json';

      it('should return true for an owned resource that exists', async () => {
        mockState.currentSession = createMockSession();
        mockState.sessionStorageExists.mockResolvedValue(true);

        await expect(HomeserverService.exists(testUrl)).resolves.toBe(true);

        expect(mockState.sessionStorageExists).toHaveBeenCalledWith('/pub/resource.json');
        expect(mockState.publicStorageExists).not.toHaveBeenCalled();
      });

      it('should return false without error logging when an owned resource is missing', async () => {
        mockState.currentSession = createMockSession();
        mockState.sessionStorageExists.mockResolvedValue(false);

        await expect(HomeserverService.exists(testUrl)).resolves.toBe(false);

        expect(Logger.error).not.toHaveBeenCalled();
      });

      it('should normalize unexpected owned-storage failures', async () => {
        mockState.currentSession = createMockSession();
        mockState.sessionStorageExists.mockRejectedValue(new Error('Network failure'));

        await expect(HomeserverService.exists(testUrl)).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });

      it('should preserve session-expiration handling for owned-storage failures', async () => {
        mockState.currentSession = createMockSession();
        mockState.sessionStorageExists.mockRejectedValue({
          name: 'RequestError',
          message: 'Session expired',
          data: { statusCode: 401 },
        });

        await expect(HomeserverService.exists(testUrl)).rejects.toMatchObject({
          category: ErrorCategory.Auth,
          code: AuthErrorCode.SESSION_EXPIRED,
        });
      });

      it('should use publicStorage.exists when the resource is not owned', async () => {
        mockState.publicStorageExists.mockResolvedValue(true);

        await expect(HomeserverService.exists(testUrl)).resolves.toBe(true);

        expect(mockState.publicStorageExists).toHaveBeenCalledWith(testUrl);
        expect(mockState.sessionStorageExists).not.toHaveBeenCalled();
      });

      it('should return false without error logging when a public resource is missing', async () => {
        mockState.publicStorageExists.mockResolvedValue(false);

        await expect(HomeserverService.exists(testUrl)).resolves.toBe(false);

        expect(Logger.error).not.toHaveBeenCalled();
      });

      it('should normalize unexpected public-storage failures', async () => {
        mockState.publicStorageExists.mockRejectedValue(new Error('Network failure'));

        await expect(HomeserverService.exists(testUrl)).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });

      it('should return true for a successful HTTP response', async () => {
        const httpUrl = 'https://example.com/resource.json';
        mockState.clientFetch.mockResolvedValue(new Response('{}', { status: 200 }));

        await expect(HomeserverService.exists(httpUrl)).resolves.toBe(true);

        expect(mockState.clientFetch).toHaveBeenCalledWith(httpUrl);
      });

      it('should return false without error logging for an HTTP 404', async () => {
        mockState.clientFetch.mockResolvedValue(new Response('', { status: 404 }));

        await expect(HomeserverService.exists('https://example.com/missing.json')).resolves.toBe(false);

        expect(Logger.error).not.toHaveBeenCalled();
      });

      it('should normalize an unexpected HTTP response', async () => {
        mockState.clientFetch.mockResolvedValue(new Response('Server error', { status: 500 }));

        await expect(HomeserverService.exists('https://example.com/broken.json')).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.INTERNAL_ERROR,
        });
      });

      it('should preserve session-expiration handling for HTTP responses', async () => {
        mockState.clientFetch.mockResolvedValue(new Response('Session expired', { status: 401 }));

        await expect(HomeserverService.exists('https://example.com/private.json')).rejects.toMatchObject({
          category: ErrorCategory.Auth,
          code: AuthErrorCode.SESSION_EXPIRED,
        });
      });
    });
  });

  // ===========================================================================
  // EDGE CASES & ERROR HANDLING
  // ===========================================================================

  describe('Edge Cases & Error Handling', () => {
    describe('handleError (private)', () => {
      it('should re-throw AppError instances without wrapping', async () => {
        const { Err: FreshErr } = await import('@/libs/error/error.factories');
        const appError = FreshErr.auth(AuthErrorCode.UNAUTHORIZED, 'Already an AppError', {
          service: ErrorService.Homeserver,
          operation: 'test',
        });
        mockState.signup.mockRejectedValue(appError);

        try {
          await HomeserverService.signUp({
            keypair: createMockKeypair(),
            signupToken: 'token',
          });
          expect.fail('Should have thrown');
        } catch (error) {
          // Should be the exact same error instance (not wrapped)
          expect(error).toBe(appError);
          expect((error as AppError).category).toBe(ErrorCategory.Auth);
          expect((error as AppError).code).toBe(AuthErrorCode.UNAUTHORIZED);
          expect((error as AppError).message).toBe('Already an AppError');
        }
      });
    });

    describe('PKARR lookup failure (SDK 0.11 PkarrError)', () => {
      it('pkarr error maps to retryable network error', async () => {
        const pkarrError = { name: 'PkarrError', message: 'PKARR lookup failed: relay timeout' };
        mockState.signup.mockRejectedValue(pkarrError);

        const error = await HomeserverService.signUp({ keypair: createMockKeypair(), signupToken: 'token' }).catch(
          (caught: unknown) => caught,
        );

        expect(error).toMatchObject({
          category: ErrorCategory.Network,
          code: NetworkErrorCode.CONNECTION_FAILED,
        });
      });
    });

    describe('Session expiration handling', () => {
      it('should include endpoint in SESSION_EXPIRED error context', async () => {
        const testUrl = 'pubky://user/pub/data.json';
        mockState.currentSession = createMockSession();
        mockState.sessionStorageGet.mockResolvedValue(new Response('Session expired', { status: 401 }));

        try {
          await HomeserverService.request({ method: HttpMethod.GET, url: testUrl });
          expect.fail('Should have thrown');
        } catch (error) {
          // Use name check instead of instanceof due to module reset
          expect((error as Error).name).toBe('AppError');
          expect((error as AppError).context?.endpoint).toContain('user/pub/data.json');
        }
      });

      it('should use custom error message from 401 response body', async () => {
        const customMessage = 'Your session has expired, please login again';
        mockState.currentSession = createMockSession();
        mockState.sessionStorageGet.mockResolvedValue(new Response(customMessage, { status: 401 }));

        try {
          await HomeserverService.request({ method: HttpMethod.GET, url: 'pubky://user/pub/data.json' });
          expect.fail('Should have thrown');
        } catch (error) {
          // Use name check instead of instanceof due to module reset
          expect((error as Error).name).toBe('AppError');
          expect((error as AppError).message).toBe(customMessage);
        }
      });
    });

    describe('generateSignupToken (via API route)', () => {
      it('should fetch token from server-side API route', async () => {
        const expectedToken = 'generated-signup-token-123';
        mockFetch.mockResolvedValue(
          new Response(JSON.stringify({ token: expectedToken }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

        const result = await HomeserverService.generateSignupToken();

        expect(mockFetch).toHaveBeenCalledWith('/api/dev/signup-token', { method: 'GET' });
        expect(result).toBe(expectedToken);
      });

      it('should throw FORBIDDEN error for 403 response', async () => {
        mockFetch.mockResolvedValue(
          new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

        await expect(HomeserverService.generateSignupToken()).rejects.toMatchObject({
          category: ErrorCategory.Auth,
          code: AuthErrorCode.FORBIDDEN,
        });
      });

      it('should throw UNEXPECTED_ERROR when no token received', async () => {
        mockFetch.mockResolvedValue(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

        await expect(HomeserverService.generateSignupToken()).rejects.toMatchObject({
          category: ErrorCategory.Server,
          code: ServerErrorCode.UNKNOWN_ERROR,
        });
      });

      it('should return token from JSON response', async () => {
        const expectedToken = 'token-from-json';
        mockFetch.mockResolvedValue(
          new Response(JSON.stringify({ token: expectedToken }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

        const result = await HomeserverService.generateSignupToken();

        expect(result).toBe(expectedToken);
      });
    });

    describe('subscribeUserEventStreamForPath', () => {
      it('normalizes SDK events and disposes raw WASM objects internally', async () => {
        const free = vi.fn();
        const path = vi.fn().mockReturnThis();
        const live = vi.fn().mockReturnThis();
        const subscribe = vi.fn().mockResolvedValue(
          new ReadableStream({
            start(controller) {
              controller.enqueue({ cursor: 'cursor-1', eventType: 'PUT', free });
              controller.close();
            },
          }),
        );

        mockState.eventStreamForUser.mockReturnValue({ path, live, subscribe });

        const stream = await HomeserverService.subscribeUserEventStreamForPath({
          userZ32: 'user-pubky',
          cursor: 'cursor-0',
          pathPrefix: '/pub/pubky.app/mutes/',
        });
        const reader = stream.getReader();

        const result = await reader.read();

        expect(path).toHaveBeenCalledWith('/pub/pubky.app/mutes/');
        expect(live).toHaveBeenCalled();
        expect(subscribe).toHaveBeenCalled();
        expect(result.value).toEqual({ cursor: 'cursor-1', eventType: 'PUT' });
        expect(result.value).not.toHaveProperty('free');
        expect(free).toHaveBeenCalledTimes(1);
      });
    });

    describe('URL resolution', () => {
      it('should use session storage paths for pubky URLs', async () => {
        mockState.currentSession = createMockSession();
        mockState.sessionStorageGet.mockResolvedValue(new Response('{}', { status: 200 }));

        await HomeserverService.request({ method: HttpMethod.GET, url: 'pubky://user/pub/data.json' });

        expect(mockState.sessionStorageGet).toHaveBeenCalledWith('/pub/data.json');
      });
    });
  });
});
