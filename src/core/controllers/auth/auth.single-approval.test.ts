import type { AuthToken, Session } from '@synonymdev/pubky';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApplication } from '@/application/auth/auth';
import { BootstrapApplication } from '@/application/bootstrap/bootstrap';
import { CAPABILITIES } from '@/config/app';
import { clearDatabase } from '@/database/franky/franky.helpers';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { resetRuntimeConfigForTests } from '@/libs/runtime-config/runtime-config';
import { useMigrationStore } from '@/stores/migration/migration.store';
import { mockMigrationStore } from '@/test-utils/stores';
import { asOpaque } from '@/test-utils/type-assertions';
import { AuthController } from './auth';
import { resetAuthFinalizationLockForTests } from './auth-finalization-lock';

vi.mock('@/database/franky/franky.helpers', () => ({
  clearDatabase: vi.fn(),
  clearPrivateData: vi.fn(),
}));

vi.mock('pubky-app-specs', () => ({
  default: vi.fn(() => Promise.resolve()),
}));

const mockClearDatabase = vi.mocked(clearDatabase);

const mockToken = asOpaque<AuthToken>({
  toBytes: () => new Uint8Array([1, 2, 3]),
  publicKey: { z32: () => 'test-pubky' },
  capabilities: [],
});

const mockSession = asOpaque<Session>({
  info: { publicKey: { z32: () => 'test-pubky' } },
});

function mockDirectSignInFlow(overrides: {
  authorizationUrl?: string;
  awaitToken?: () => Promise<AuthToken>;
  cancelAuthFlow?: () => void;
}) {
  return vi.spyOn(AuthApplication, 'startDirectSignInFlow').mockReturnValue({
    authorizationUrl: overrides.authorizationUrl ?? 'https://example.com/auth?token=A',
    awaitToken: overrides.awaitToken ?? (async () => mockToken),
    cancelAuthFlow: overrides.cancelAuthFlow ?? vi.fn(),
  });
}

describe('AuthController single-approval ceremony', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAuthFinalizationLockForTests();
    mockClearDatabase.mockReset();
    mockClearDatabase.mockResolvedValue(undefined);
    AuthController.resetSignInCeremonyGuard();
    AuthController.resetCleanupLocalStateGuard();
    vi.spyOn(BootstrapApplication, 'cancelModerationFollow').mockImplementation(() => {});
    vi.spyOn(useMigrationStore, 'getState').mockReturnValue(mockMigrationStore({ reset: vi.fn() }));
  });

  it('holds the in-flight guard through the POST window so re-entry does not clearDatabase', async () => {
    let resolveToken!: (token: AuthToken) => void;
    const awaitToken = () =>
      new Promise<AuthToken>((resolve) => {
        resolveToken = resolve;
      });
    let resolveCeremony!: (value: { session: Session; marketplace: null; marketplaceError: null }) => void;
    const ceremony = new Promise<{ session: Session; marketplace: null; marketplaceError: null }>((resolve) => {
      resolveCeremony = resolve;
    });

    const startSpy = mockDirectSignInFlow({ awaitToken });
    const completeSpy = vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockReturnValue(ceremony);

    const first = await AuthController.getAuthUrl();
    expect(mockClearDatabase).toHaveBeenCalledTimes(1);

    const approval = first.awaitApproval;
    resolveToken(mockToken);
    await vi.waitFor(() => expect(completeSpy).toHaveBeenCalledTimes(1));

    const second = await AuthController.getAuthUrl();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(mockClearDatabase).toHaveBeenCalledTimes(1);
    expect(second.authorizationUrl).toBe(first.authorizationUrl);

    resolveCeremony({ session: mockSession, marketplace: null, marketplaceError: null });
    await expect(approval).resolves.toBe(mockSession);
  });

  it('holds the guard during the clearDatabase window itself: re-entry joins before the flow exists', async () => {
    let releaseClear!: () => void;
    mockClearDatabase.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseClear = resolve;
        }),
    );
    const startSpy = mockDirectSignInFlow({});
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockResolvedValue({
      session: mockSession,
      marketplace: null,
      marketplaceError: null,
    });

    const firstPromise = AuthController.getAuthUrl();
    await vi.waitFor(() => expect(releaseClear).toEqual(expect.any(Function)));
    const secondPromise = AuthController.getAuthUrl();
    releaseClear();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(mockClearDatabase).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(second.authorizationUrl).toBe(first.authorizationUrl);
    await expect(first.awaitApproval).resolves.toBe(mockSession);
    await expect(second.awaitApproval).resolves.toBe(mockSession);
  });

  it('delegates the dual POST to the application exactly once for one approval', async () => {
    // NOTE: this asserts the single-flight of the delegation only. The
    // homeserver-then-marketplace ORDER and the identical body bytes are
    // asserted at the transport seams in auth.single-approval-seams.test.ts —
    // mocking completeSingleApprovalCeremony (as done here) cannot prove
    // either, which is why the old order test moved there.
    mockDirectSignInFlow({});
    const completeSpy = vi
      .spyOn(AuthApplication, 'completeSingleApprovalCeremony')
      .mockResolvedValue({ session: mockSession, marketplace: null, marketplaceError: null });

    const { awaitApproval } = await AuthController.getAuthUrl();
    await awaitApproval;

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledWith(mockToken);
  });

  it('resolves awaitApproval with the session when the ceremony outcome carries a marketplace failure (controller mapping)', async () => {
    // Pins ONLY the controller's outcome → awaitApproval mapping: an outcome
    // with marketplace: null + marketplaceError must still resolve the
    // session, never reject. The REAL marketplace-failure tolerance (the
    // application catching the failed marketplace POST) is driven end-to-end
    // at the transport seams in auth.single-approval-seams.test.ts —
    // completeSingleApprovalCeremony is mocked here, so this test cannot and
    // does not prove that half.
    mockDirectSignInFlow({});
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockResolvedValue({
      session: mockSession,
      marketplace: null,
      marketplaceError: { statusCode: 401 },
    });

    const { awaitApproval } = await AuthController.getAuthUrl();

    await expect(awaitApproval).resolves.toBe(mockSession);
  });

  it('cancels a live QR from an earlier entry point before the ceremony takes the slot', async () => {
    // A prior flow (e.g. a signup page's wrapAuthFlow) is still scannable.
    const priorCancel = vi.fn();
    vi.spyOn(AuthApplication, 'generateSignupAuthUrl').mockResolvedValue({
      authorizationUrl: 'https://example.com/auth?token=prior',
      // Never settles: the QR is still live when the ceremony takes over.
      awaitApproval: new Promise<Session>(() => {}),
      cancelAuthFlow: priorCancel,
    });
    const prior = await AuthController.getSignupAuthUrl('INVITE-CODE');
    // The caller of the signup flow is expected to observe its approval
    // promise; attach a swallow so the ceremony's cancellation below does not
    // surface as an unhandled rejection in this test.
    prior.awaitApproval.catch(() => {});

    mockDirectSignInFlow({});
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockResolvedValue({
      session: mockSession,
      marketplace: null,
      marketplaceError: null,
    });

    const { awaitApproval } = await AuthController.getAuthUrl();
    await awaitApproval;

    expect(priorCancel).toHaveBeenCalledTimes(1);
  });

  it('mints a FRESH URL when a cancelled ceremony is retried (never re-shows the dead QR)', async () => {
    const startSpy = mockDirectSignInFlow({ authorizationUrl: 'https://example.com/auth?token=first' });
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockResolvedValue({
      session: mockSession,
      marketplace: null,
      marketplaceError: null,
    });

    const first = await AuthController.getStepUpAuthUrl();
    // The hook cancels via releaseAuthFlow, which must tear down the ceremony
    // guard — a raw cancelAuthFlow() would leave a cancelled ceremony to join.
    AuthController.releaseAuthFlow(first.cancelAuthFlow);

    startSpy.mockReturnValue({
      authorizationUrl: 'https://example.com/auth?token=second',
      awaitToken: async () => mockToken,
      cancelAuthFlow: vi.fn(),
    });
    const second = await AuthController.getStepUpAuthUrl();

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(second.authorizationUrl).toBe('https://example.com/auth?token=second');
    // Step-up preserves local state: no clearDatabase on either attempt.
    expect(mockClearDatabase).not.toHaveBeenCalled();
    await expect(second.awaitApproval).resolves.toBe(mockSession);
  });

  it('releaseAuthFlow frees only the hook-held stale flow when another flow already superseded it', async () => {
    const staleCancel = vi.fn();
    const liveCancel = vi.fn();
    mockDirectSignInFlow({ cancelAuthFlow: staleCancel });
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockResolvedValue({
      session: mockSession,
      marketplace: null,
      marketplaceError: null,
    });

    const first = await AuthController.getStepUpAuthUrl();
    // Supersede through the controller (a second ceremony takes the slot).
    AuthController.cancelActiveAuthFlow();
    expect(staleCancel).toHaveBeenCalledTimes(1);

    mockDirectSignInFlow({ authorizationUrl: 'https://example.com/auth?token=live', cancelAuthFlow: liveCancel });
    const second = await AuthController.getStepUpAuthUrl();
    // Releasing the STALE handle must not kill the live flow.
    AuthController.releaseAuthFlow(first.cancelAuthFlow);
    expect(liveCancel).not.toHaveBeenCalled();
    await expect(second.awaitApproval).resolves.toBe(mockSession);
  });

  it('a joined sign-in handle released by the joiner does NOT tear down the ceremony the owner still waits on', async () => {
    const ownerCancel = vi.fn();
    mockDirectSignInFlow({ cancelAuthFlow: ownerCancel });
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockResolvedValue({
      session: mockSession,
      marketplace: null,
      marketplaceError: null,
    });

    const owner = await AuthController.getStepUpAuthUrl();
    // A second surface (e.g. another step-up affordance) joins the ceremony.
    const joined = await AuthController.getStepUpAuthUrl();
    expect(joined.authorizationUrl).toBe(owner.authorizationUrl);

    // The joiner's surface closes: releasing ITS handle must leave the
    // owner's ceremony fully alive.
    AuthController.releaseAuthFlow(joined.cancelAuthFlow);

    expect(ownerCancel).not.toHaveBeenCalled();
    await expect(owner.awaitApproval).resolves.toBe(mockSession);
    await expect(joined.awaitApproval).resolves.toBe(mockSession);
  });

  it('closing a joined bridged dialog does not cancel the bridged ceremony the owning dialog waits on', async () => {
    const ownerCancel = vi.fn();
    mockDirectSignInFlow({ cancelAuthFlow: ownerCancel });
    const marketplace = {
      pubky: 'test-pubky',
      capabilities: '',
      expiresAt: '2099-01-01T00:00:00.000Z',
      issuedAt: '2026-09-08T00:00:00.000Z',
    };
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockResolvedValue({
      session: mockSession,
      marketplace,
      marketplaceError: null,
    });
    vi.spyOn(AuthController, 'completeStepUpReauth').mockResolvedValue(undefined);
    const { CommerceController } = await import('@/controllers/commerce/commerce');
    vi.spyOn(CommerceController, 'writeMarketplaceSessionStore').mockImplementation(() => {});

    const owner = AuthController.beginBridgedCommerceSessionFlow();
    const joined = AuthController.beginBridgedCommerceSessionFlow();
    expect(joined.authorizationUrl).toBe(owner.authorizationUrl);

    AuthController.releaseAuthFlow(joined.cancel);

    expect(ownerCancel).not.toHaveBeenCalled();
    await expect(owner.awaitSession()).resolves.toEqual(marketplace);
    await expect(joined.awaitSession()).resolves.toEqual(marketplace);
  });

  it('does not double-initialize when two joiners settle the same approval (StrictMode remount)', async () => {
    mockDirectSignInFlow({});
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockResolvedValue({
      session: mockSession,
      marketplace: null,
      marketplaceError: null,
    });
    vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(false);
    vi.spyOn(AuthApplication, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
    let initCalls = 0;
    const authStoreModule = await import('@/stores/auth/auth.store');
    vi.spyOn(authStoreModule.useAuthStore, 'getState').mockReturnValue(
      asOpaque<ReturnType<typeof authStoreModule.useAuthStore.getState>>({
        init: () => {
          initCalls += 1;
        },
        setHasProfile: vi.fn(),
        reset: vi.fn(),
      }),
    );
    const signInStoreModule = await import('@/stores/signIn/signIn.store');
    vi.spyOn(signInStoreModule.useSignInStore, 'getState').mockReturnValue(
      asOpaque<ReturnType<typeof signInStoreModule.useSignInStore.getState>>({
        reset: vi.fn(),
        setAuthUrlResolved: vi.fn(),
        setProfileChecked: vi.fn(),
      }),
    );

    const { awaitApproval } = await AuthController.getAuthUrl();
    // Two handlers attach to the SAME settled promise, as two mounted
    // useAuthUrl instances would. Both must converge on ONE real init run.
    const first = awaitApproval.then((session) => AuthController.initializeAuthenticatedSession({ session }));
    const second = awaitApproval.then((session) => AuthController.initializeAuthenticatedSession({ session }));
    await Promise.all([first, second]);

    expect(initCalls).toBe(1);
  });

  it('runs the session-init body once for concurrent same-session calls', async () => {
    const userIsSignedUpSpy = vi.spyOn(AuthApplication, 'userIsSignedUp').mockResolvedValue(false);
    vi.spyOn(AuthApplication, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
    let initCalls = 0;
    const authStoreModule = await import('@/stores/auth/auth.store');
    vi.spyOn(authStoreModule.useAuthStore, 'getState').mockReturnValue(
      asOpaque<ReturnType<typeof authStoreModule.useAuthStore.getState>>({
        init: () => {
          initCalls += 1;
        },
        setHasProfile: vi.fn(),
        reset: vi.fn(),
      }),
    );
    const signInStoreModule = await import('@/stores/signIn/signIn.store');
    vi.spyOn(signInStoreModule.useSignInStore, 'getState').mockReturnValue(
      asOpaque<ReturnType<typeof signInStoreModule.useSignInStore.getState>>({
        reset: vi.fn(),
        setAuthUrlResolved: vi.fn(),
        setProfileChecked: vi.fn(),
      }),
    );

    await Promise.all([
      AuthController.initializeAuthenticatedSession({ session: mockSession }),
      AuthController.initializeAuthenticatedSession({ session: mockSession }),
    ]);

    expect(initCalls).toBe(1);
    expect(userIsSignedUpSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the marketplace session when a just-approved sign-in is refused', async () => {
    vi.spyOn(AuthApplication, 'assertUserHomeserverAllowed').mockRejectedValue(
      Err.auth(AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER, 'wrong env', {
        service: ErrorService.Homeserver,
        operation: 'assertUserHomeserverAllowed',
      }),
    );
    vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
    const { CommerceController } = await import('@/controllers/commerce/commerce');
    const clearSpy = vi.spyOn(CommerceController, 'clearMarketplaceSession').mockImplementation(() => {});

    await expect(AuthController.initializeAuthenticatedSession({ session: mockSession })).rejects.toMatchObject({
      code: AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER,
    });

    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the marketplace bearer when the post-mint bootstrap fails after the env check', async () => {
    process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
    resetRuntimeConfigForTests();
    try {
      vi.spyOn(AuthApplication, 'assertUserHomeserverAllowed').mockResolvedValue(undefined);
      // The bootstrap half of the init blows up AFTER the env check passed.
      vi.spyOn(AuthApplication, 'userIsSignedUp').mockRejectedValue(new Error('nexus unreachable'));
      const authStoreModule = await import('@/stores/auth/auth.store');
      vi.spyOn(authStoreModule.useAuthStore, 'getState').mockReturnValue(
        asOpaque<ReturnType<typeof authStoreModule.useAuthStore.getState>>({
          init: vi.fn(),
          setHasProfile: vi.fn(),
          reset: vi.fn(),
        }),
      );
      const signInStoreModule = await import('@/stores/signIn/signIn.store');
      vi.spyOn(signInStoreModule.useSignInStore, 'getState').mockReturnValue(
        asOpaque<ReturnType<typeof signInStoreModule.useSignInStore.getState>>({
          reset: vi.fn(),
          setAuthUrlResolved: vi.fn(),
          setProfileChecked: vi.fn(),
        }),
      );

      // Seed a bearer at rest the way the ceremony's marketplace half leaves
      // it: real service memory + localStorage mirror + commerce store.
      const bearerPubky = 'y'.repeat(52);
      const { MarketplaceSessionService, MARKETPLACE_SESSION_STORAGE_KEY } =
        await import('@/services/marketplace/marketplace-session');
      window.localStorage.setItem(
        MARKETPLACE_SESSION_STORAGE_KEY,
        JSON.stringify({
          token: 'A'.repeat(43),
          pubky: bearerPubky,
          capabilities: CAPABILITIES,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      );
      const restored = MarketplaceSessionService.restorePersistedSession(bearerPubky);
      expect(restored).not.toBeNull();
      const { CommerceController } = await import('@/controllers/commerce/commerce');
      CommerceController.writeMarketplaceSessionStore(restored as NonNullable<typeof restored>);
      const { useCommerceStore } = await import('@/stores/commerce/commerce.store');
      expect(useCommerceStore.getState().marketplaceSession).not.toBeNull();

      await expect(AuthController.initializeAuthenticatedSession({ session: mockSession })).rejects.toThrow(
        'nexus unreachable',
      );

      // Service memory, the localStorage mirror, and the store all hold NO bearer.
      expect(MarketplaceSessionService.getActiveSession()).toBeNull();
      expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
      expect(useCommerceStore.getState().marketplaceSession).toBeNull();
    } finally {
      delete process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE;
      resetRuntimeConfigForTests();
    }
  });

  it('joins two bridged commerce starts into ONE Ring flow', async () => {
    const startSpy = mockDirectSignInFlow({});
    const marketplace = {
      pubky: 'test-pubky',
      capabilities: '',
      expiresAt: '2099-01-01T00:00:00.000Z',
      issuedAt: '2026-09-08T00:00:00.000Z',
    };
    const completeSpy = vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockResolvedValue({
      session: mockSession,
      marketplace,
      marketplaceError: null,
    });
    vi.spyOn(AuthController, 'completeStepUpReauth').mockResolvedValue(undefined);
    const { CommerceController } = await import('@/controllers/commerce/commerce');
    vi.spyOn(CommerceController, 'writeMarketplaceSessionStore').mockImplementation(() => {});

    const first = AuthController.beginBridgedCommerceSessionFlow();
    const second = AuthController.beginBridgedCommerceSessionFlow();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(second.authorizationUrl).toBe(first.authorizationUrl);
    await expect(first.awaitSession()).resolves.toEqual(marketplace);
    await expect(second.awaitSession()).resolves.toEqual(marketplace);
    expect(completeSpy).toHaveBeenCalledTimes(1);
    // Bridged never wipes local state.
    expect(mockClearDatabase).not.toHaveBeenCalled();
  });

  it('swaps the store session BEFORE the marketplace POST in the bridged ceremony', async () => {
    mockDirectSignInFlow({});
    const order: string[] = [];
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockImplementation(async (_token, hooks) => {
      order.push('hs');
      await hooks?.onHomeserverSession?.(mockSession);
      order.push('mp');
      return { session: mockSession, marketplace: null, marketplaceError: { statusCode: 503 } };
    });
    const stepUpSpy = vi.spyOn(AuthController, 'completeStepUpReauth').mockImplementation(async () => {
      order.push('stepUp');
    });

    const flow = AuthController.beginBridgedCommerceSessionFlow();

    await expect(flow.awaitSession()).rejects.toMatchObject({ code: AuthErrorCode.INVALID_TOKEN });
    expect(stepUpSpy).toHaveBeenCalledWith({ session: mockSession }, { releaseAuthFlow: false });
    expect(order).toEqual(['hs', 'stepUp', 'mp']);
  });

  it('getAuthUrl during the bridged POST window JOINS instead of running clearDatabase', async () => {
    let resolveToken!: (token: AuthToken) => void;
    const awaitToken = () =>
      new Promise<AuthToken>((resolve) => {
        resolveToken = resolve;
      });
    let resolveCeremony!: (value: { session: Session; marketplace: null; marketplaceError: null }) => void;
    const ceremony = new Promise<{ session: Session; marketplace: null; marketplaceError: null }>((resolve) => {
      resolveCeremony = resolve;
    });
    mockDirectSignInFlow({ authorizationUrl: 'https://example.com/auth?token=bridged', awaitToken });
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockReturnValue(ceremony);
    vi.spyOn(AuthController, 'completeStepUpReauth').mockResolvedValue(undefined);

    const bridged = AuthController.beginBridgedCommerceSessionFlow();
    resolveToken(mockToken);
    // Inside the POST window: a sign-in request must join, never clearDatabase.
    const signIn = await AuthController.getAuthUrl();

    expect(mockClearDatabase).not.toHaveBeenCalled();
    expect(signIn.authorizationUrl).toBe(bridged.authorizationUrl);

    resolveCeremony({ session: mockSession, marketplace: null, marketplaceError: null });
    await expect(signIn.awaitApproval).resolves.toBe(mockSession);
    await expect(bridged.awaitSession()).rejects.toMatchObject({ code: AuthErrorCode.INVALID_TOKEN });
  });

  it('a bridged dialog opening during a direct sign-in ceremony joins its outcome', async () => {
    mockDirectSignInFlow({});
    const marketplace = {
      pubky: 'test-pubky',
      capabilities: '',
      expiresAt: '2099-01-01T00:00:00.000Z',
      issuedAt: '2026-09-08T00:00:00.000Z',
    };
    vi.spyOn(AuthApplication, 'completeSingleApprovalCeremony').mockResolvedValue({
      session: mockSession,
      marketplace,
      marketplaceError: null,
    });
    const { CommerceController } = await import('@/controllers/commerce/commerce');
    vi.spyOn(CommerceController, 'writeMarketplaceSessionStore').mockImplementation(() => {});
    const startSpy = vi.mocked(AuthApplication.startDirectSignInFlow);

    const { awaitApproval } = await AuthController.getAuthUrl();
    const bridged = AuthController.beginBridgedCommerceSessionFlow();

    expect(startSpy).toHaveBeenCalledTimes(1);
    await expect(bridged.awaitSession()).resolves.toEqual(marketplace);
    await expect(awaitApproval).resolves.toBe(mockSession);
  });

  describe('flag off (PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN=false)', () => {
    beforeEach(() => {
      process.env.PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN = 'false';
      resetRuntimeConfigForTests();
    });

    afterEach(() => {
      delete process.env.PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN;
      resetRuntimeConfigForTests();
    });

    it('getAuthUrl uses the legacy wrapAuthFlow path: clearDatabase + generateAuthUrl, no ceremony flow', async () => {
      const genSpy = vi.spyOn(AuthApplication, 'generateAuthUrl').mockResolvedValue({
        authorizationUrl: 'https://example.com/auth?legacy',
        awaitApproval: new Promise<Session>(() => {}),
        cancelAuthFlow: vi.fn(),
      });
      const startSpy = vi.spyOn(AuthApplication, 'startDirectSignInFlow');

      const result = await AuthController.getAuthUrl();
      result.awaitApproval.catch(() => {});

      expect(genSpy).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
      expect(mockClearDatabase).toHaveBeenCalledTimes(1);
      expect(result.authorizationUrl).toBe('https://example.com/auth?legacy');
    });

    it('getStepUpAuthUrl uses the legacy wrapAuthFlow path and preserves local state', async () => {
      const genSpy = vi.spyOn(AuthApplication, 'generateAuthUrl').mockResolvedValue({
        authorizationUrl: 'https://example.com/auth?legacy-step-up',
        awaitApproval: new Promise<Session>(() => {}),
        cancelAuthFlow: vi.fn(),
      });
      const startSpy = vi.spyOn(AuthApplication, 'startDirectSignInFlow');

      const result = await AuthController.getStepUpAuthUrl();
      result.awaitApproval.catch(() => {});

      expect(genSpy).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
      // preserveLocalState: a step-up must not wipe local state.
      expect(mockClearDatabase).not.toHaveBeenCalled();
      expect(result.authorizationUrl).toBe('https://example.com/auth?legacy-step-up');
    });
  });
});

describe('AuthController Ring and Bitkit QRs side by side', () => {
  const grantSession = asOpaque<Session>({
    info: { publicKey: { z32: () => 'test-pubky' }, capabilities: CAPABILITIES.split(',') },
    grant: {},
  });

  function mockGrantFlow(awaitApproval: Promise<Session>, cancelAuthFlow = vi.fn()) {
    vi.spyOn(AuthApplication, 'generateGrantAuthUrl').mockResolvedValue({
      authorizationUrl: 'pubkyauth://signin_grant?caps=x&relay=r&secret=s&cid=shop.pubky.app&cpk=k',
      awaitApproval,
      cancelAuthFlow,
    });
    return cancelAuthFlow;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    resetAuthFinalizationLockForTests();
    mockClearDatabase.mockReset();
    mockClearDatabase.mockResolvedValue(undefined);
    AuthController.resetSignInCeremonyGuard();
    AuthController.resetCleanupLocalStateGuard();
    AuthController.cancelAllAuthFlows();
    vi.spyOn(BootstrapApplication, 'cancelModerationFollow').mockImplementation(() => {});
    vi.spyOn(useMigrationStore, 'getState').mockReturnValue(mockMigrationStore({ reset: vi.fn() }));
  });

  it('starting the Bitkit QR keeps the Ring ceremony live', async () => {
    const ringCancel = vi.fn();
    mockDirectSignInFlow({ awaitToken: () => new Promise<AuthToken>(() => {}), cancelAuthFlow: ringCancel });
    const ring = await AuthController.getAuthUrl();
    ring.awaitApproval.catch(() => {});

    mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getGrantAuthUrl();

    expect(ringCancel).not.toHaveBeenCalled();
    // The Ring ceremony guard is still held: a second getAuthUrl joins it.
    const joined = await AuthController.getAuthUrl();
    expect(joined.authorizationUrl).toBe(ring.authorizationUrl);
  });

  it('starting the Ring QR keeps the Bitkit flow live', async () => {
    const grantCancel = mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getGrantAuthUrl();

    mockDirectSignInFlow({ awaitToken: () => new Promise<AuthToken>(() => {}) });
    const ring = await AuthController.getAuthUrl();
    ring.awaitApproval.catch(() => {});

    expect(grantCancel).not.toHaveBeenCalled();
  });

  it('a completed sign-in cancels both QRs', async () => {
    const ringCancel = vi.fn();
    mockDirectSignInFlow({ awaitToken: () => new Promise<AuthToken>(() => {}), cancelAuthFlow: ringCancel });
    const ring = await AuthController.getAuthUrl();
    ring.awaitApproval.catch(() => {});
    const grantCancel = mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getGrantAuthUrl();

    AuthController.cancelAllAuthFlows();

    expect(ringCancel).toHaveBeenCalled();
    expect(grantCancel).toHaveBeenCalled();
  });

  it('a Bitkit approval that settles after another sign-in won is signed out, not returned', async () => {
    let approve!: (session: Session) => void;
    mockGrantFlow(
      new Promise<Session>((resolve) => {
        approve = resolve;
      }),
    );
    const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
    const { awaitApproval } = await AuthController.getGrantAuthUrl();

    AuthController.cancelAllAuthFlows();
    approve(grantSession);

    await expect(awaitApproval).rejects.toMatchObject({ name: 'AuthFlowCanceled' });
    expect(logoutSpy).toHaveBeenCalledWith({ session: grantSession });
  });

  it('a Bitkit approval with no competing sign-in is returned', async () => {
    mockGrantFlow(Promise.resolve(grantSession));
    const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
    const { awaitApproval } = await AuthController.getGrantAuthUrl();

    await expect(awaitApproval).resolves.toBe(grantSession);
    expect(logoutSpy).not.toHaveBeenCalled();
  });

  it('starting Pubky Passport keeps the Bitkit QR and the Ring ceremony live', async () => {
    const ringCancel = vi.fn();
    mockDirectSignInFlow({ awaitToken: () => new Promise<AuthToken>(() => {}), cancelAuthFlow: ringCancel });
    const ring = await AuthController.getAuthUrl();
    ring.awaitApproval.catch(() => {});
    const bitkitCancel = mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getGrantAuthUrl();

    const passportCancel = mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getPassportGrantAuthUrl();

    expect(bitkitCancel).not.toHaveBeenCalled();
    expect(ringCancel).not.toHaveBeenCalled();
    expect(passportCancel).not.toHaveBeenCalled();
  });

  it('a new Passport attempt replaces the previous Passport flow only', async () => {
    const bitkitCancel = mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getGrantAuthUrl();
    const firstPassportCancel = mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getPassportGrantAuthUrl();

    mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getPassportGrantAuthUrl();

    expect(firstPassportCancel).toHaveBeenCalled();
    expect(bitkitCancel).not.toHaveBeenCalled();
  });

  it('a completed sign-in cancels the Bitkit and Passport flows', async () => {
    const bitkitCancel = mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getGrantAuthUrl();
    const passportCancel = mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getPassportGrantAuthUrl();

    AuthController.cancelAllAuthFlows();

    expect(bitkitCancel).toHaveBeenCalled();
    expect(passportCancel).toHaveBeenCalled();
  });

  it('a Passport approval that settles after another sign-in won is signed out, not returned', async () => {
    let approve!: (session: Session) => void;
    mockGrantFlow(
      new Promise<Session>((resolve) => {
        approve = resolve;
      }),
    );
    const logoutSpy = vi.spyOn(AuthApplication, 'logout').mockResolvedValue(undefined);
    const { awaitApproval } = await AuthController.getPassportGrantAuthUrl();

    AuthController.cancelAllAuthFlows();
    approve(grantSession);

    await expect(awaitApproval).rejects.toMatchObject({ name: 'AuthFlowCanceled' });
    expect(logoutSpy).toHaveBeenCalledWith({ session: grantSession });
  });

  it('releasing the Passport handle cancels only the Passport flow', async () => {
    const bitkitCancel = mockGrantFlow(new Promise<Session>(() => {}));
    await AuthController.getGrantAuthUrl();
    const passportCancel = mockGrantFlow(new Promise<Session>(() => {}));
    const passport = await AuthController.getPassportGrantAuthUrl();

    AuthController.releaseAuthFlow(passport.cancelAuthFlow);

    expect(passportCancel).toHaveBeenCalled();
    expect(bitkitCancel).not.toHaveBeenCalled();
  });

  it('releasing the Bitkit handle cancels only the Bitkit flow', async () => {
    const ringCancel = vi.fn();
    mockDirectSignInFlow({ awaitToken: () => new Promise<AuthToken>(() => {}), cancelAuthFlow: ringCancel });
    const ring = await AuthController.getAuthUrl();
    ring.awaitApproval.catch(() => {});
    const grantCancel = mockGrantFlow(new Promise<Session>(() => {}));
    const grant = await AuthController.getGrantAuthUrl();

    AuthController.releaseAuthFlow(grant.cancelAuthFlow);

    expect(grantCancel).toHaveBeenCalled();
    expect(ringCancel).not.toHaveBeenCalled();
  });
});
