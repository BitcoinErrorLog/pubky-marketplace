import type { AuthToken, Session } from '@synonymdev/pubky';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RING_COOKIE_CAPABILITIES } from '@/config/app';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { asOpaque } from '@/test-utils/type-assertions';

/**
 * Seam-level ceremony test: everything above Client.fetch (homeserver) and
 * global fetch (marketplace) is REAL — controller, application, both
 * services — so the homeserver-then-marketplace ORDER and the identical
 * body bytes across both POSTs are asserted at the transport boundary, not
 * at a mocked application method.
 */

const PUBKY = 'y'.repeat(52);
const TOKEN_BYTES = new Uint8Array([7, 7, 7, 7]);
const SESSION_INFO_BODY = new Uint8Array([1, 2, 3]);
const BEARER = 'A'.repeat(43);

const mockState = vi.hoisted(() => ({
  clientFetch: vi.fn(),
  restoreSession: vi.fn(),
  sessionRestore: vi.fn(),
  startAuthFlow: vi.fn(),
  authTokenFromBytes: vi.fn(),
  // Who the device is signed in as, read by the auth-store mock below. Null
  // means "no signed-in identity" (the plain sign-in tests).
  currentUserPubky: null as string | null,
}));

vi.mock('@synonymdev/pubky', () => {
  const createMockPubkyInstance = () => ({
    getHomeserverOf: vi.fn(),
    restoreSession: (...args: unknown[]) => mockState.restoreSession(...args),
    startCookieAuthFlow: (...args: unknown[]) => mockState.startAuthFlow(...args),
    eventStreamForUser: vi.fn(),
    client: {
      fetch: (...args: unknown[]) => mockState.clientFetch(...args),
    },
    publicStorage: {
      get: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
    signer: vi.fn(),
  });

  const MockPubky = vi.fn().mockImplementation(createMockPubkyInstance);
  // @ts-expect-error - Adding static testnet method
  MockPubky.testnet = vi.fn().mockImplementation(createMockPubkyInstance);
  // @ts-expect-error - Adding static withClient method
  MockPubky.withClient = vi.fn().mockImplementation(createMockPubkyInstance);

  class MockClient {}
  class MockAddress {}

  return {
    Pubky: MockPubky,
    Client: MockClient,
    Address: MockAddress,
    Session: {
      restore: (...args: unknown[]) => mockState.sessionRestore(...args),
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
      signin: () => 'signin-kind',
    },
    AuthToken: {
      fromBytes: (...args: unknown[]) => mockState.authTokenFromBytes(...args),
    },
    resolvePubky: vi.fn((url: string) => url.replace('pubky://', 'https://')),
  };
});

// Mock pubky-app-specs to avoid WebAssembly issues
vi.mock('pubky-app-specs', () => ({
  default: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/database/franky/franky.helpers', () => ({
  clearDatabase: vi.fn().mockResolvedValue(undefined),
  clearPrivateData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: {
    getState: () => ({
      selectSession: () => null,
      currentUserPubky: mockState.currentUserPubky,
    }),
  },
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => 'transaction-service',
    getMarketplaceUrl: () => 'http://127.0.0.1:8080',
  };
});

const mockSession = asOpaque<Session>({
  info: { publicKey: { z32: () => PUBKY } },
});

describe('single-approval ceremony at the transport seams', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockState.currentUserPubky = null;
    const { AuthController } = await import('./auth');
    AuthController.resetSignInCeremonyGuard();

    mockState.authTokenFromBytes.mockReturnValue({
      capabilities: RING_COOKIE_CAPABILITIES.split(','),
      publicKey: { z32: () => PUBKY },
    });
    mockState.sessionRestore.mockResolvedValue(mockSession);
    mockState.startAuthFlow.mockReturnValue({
      authorizationUrl: 'pubkyauth:///?relay=https%3A%2F%2Frelay.example.com%2Finbox&secret=s',
      awaitToken: async () =>
        asOpaque<AuthToken>({
          toBytes: () => TOKEN_BYTES,
          publicKey: { z32: () => PUBKY },
          capabilities: RING_COOKIE_CAPABILITIES.split(','),
        }),
      free: vi.fn(),
    });
  });

  it('runs homeserver-then-marketplace exactly once, with identical body bytes on both POSTs', async () => {
    const order: string[] = [];
    mockState.clientFetch.mockImplementation(async () => {
      order.push('homeserver');
      return new Response(SESSION_INFO_BODY, { status: 200 });
    });
    vi.mocked(fetch).mockImplementation(async () => {
      order.push('marketplace');
      return new Response(
        JSON.stringify({
          token: BEARER,
          pubky: PUBKY,
          capabilities: RING_COOKIE_CAPABILITIES,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });

    const { AuthController } = await import('./auth');
    const { awaitApproval } = await AuthController.getAuthUrl();
    await expect(awaitApproval).resolves.toBe(mockSession);

    // Order is asserted at the transport boundary: homeserver first.
    expect(order).toEqual(['homeserver', 'marketplace']);

    // ONE auth flow for the whole ceremony, with the Ring cookie set — no
    // empty-capability second flow on the direct sign-in path.
    expect(mockState.startAuthFlow).toHaveBeenCalledTimes(1);
    expect(mockState.startAuthFlow).toHaveBeenCalledWith(RING_COOKIE_CAPABILITIES, 'signin-kind', expect.any(String));
    // The /session body hydrates through Session.restore, never Pubky.restoreSession.
    expect(mockState.sessionRestore).toHaveBeenCalledWith(expect.any(String), expect.anything());
    expect(mockState.restoreSession).not.toHaveBeenCalled();

    // Identical bytes (same reference) on both POSTs.
    expect(mockState.clientFetch).toHaveBeenCalledTimes(1);
    expect(mockState.clientFetch).toHaveBeenCalledWith(
      `https://_pubky.${PUBKY}/session`,
      expect.objectContaining({ method: 'POST', credentials: 'include', body: TOKEN_BYTES }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/v1/auth/sessions',
      expect.objectContaining({ method: 'POST', body: TOKEN_BYTES }),
    );
  });

  it('keeps the sign-in when the marketplace POST fails terminally after a homeserver 2xx', async () => {
    mockState.clientFetch.mockResolvedValue(new Response(SESSION_INFO_BODY, { status: 200 }));
    vi.mocked(fetch).mockResolvedValue(new Response('The auth token is invalid.', { status: 401 }));

    const { AuthController } = await import('./auth');
    const { awaitApproval } = await AuthController.getAuthUrl();

    // The marketplace rejection must NOT discard the restored session.
    await expect(awaitApproval).resolves.toBe(mockSession);
  });

  it('step-up after a pubky.app sign-in narrowed the cookie asks Ring for both sites and redeems once', async () => {
    mockState.currentUserPubky = PUBKY;
    mockState.clientFetch.mockResolvedValue(new Response(SESSION_INFO_BODY, { status: 200 }));
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          token: BEARER,
          pubky: PUBKY,
          capabilities: RING_COOKIE_CAPABILITIES,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );

    const { AuthController } = await import('./auth');
    const { awaitApproval } = await AuthController.getStepUpAuthUrl();
    await expect(awaitApproval).resolves.toBe(mockSession);

    expect(mockState.startAuthFlow).toHaveBeenCalledTimes(1);
    expect(mockState.startAuthFlow).toHaveBeenCalledWith(
      '/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r',
      'signin-kind',
      expect.any(String),
    );
    expect(mockState.clientFetch).toHaveBeenCalledWith(
      `https://_pubky.${PUBKY}/session`,
      expect.objectContaining({ method: 'POST', body: TOKEN_BYTES }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const { MarketplaceSessionService } = await import('@/services/marketplace/marketplace-session');
    expect(MarketplaceSessionService.getActiveSession()).toMatchObject({
      pubky: PUBKY,
      capabilities: RING_COOKIE_CAPABILITIES,
    });
    MarketplaceSessionService.clearSession();
    window.localStorage.clear();
  });

  it("refuses a Ring approval that carries only pubky.app's set before either POST", async () => {
    mockState.currentUserPubky = PUBKY;
    mockState.authTokenFromBytes.mockReturnValue({
      capabilities: ['/pub/pubky.app/:rw', '/priv/social/:rw', '/priv/app.locks/content/:r'],
      publicKey: { z32: () => PUBKY },
    });

    const { AuthController } = await import('./auth');
    const { awaitApproval } = await AuthController.getStepUpAuthUrl();

    await expect(awaitApproval).rejects.toMatchObject({
      message: 'This approval does not include the full Shop permission list. Scan again from Shop.',
    });
    expect(mockState.clientFetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('step-up approved by a different identity mints no marketplace bearer and signs the session out', async () => {
    // The device is signed in as A; the signer approves the step-up as B
    // (PUBKY). The identity gate must run BEFORE the marketplace POST.
    mockState.currentUserPubky = 'a'.repeat(52);
    const signout = vi.fn();
    const wrongIdentitySession = asOpaque<Session>({
      info: { publicKey: { z32: () => PUBKY } },
      signout,
    });
    mockState.sessionRestore.mockResolvedValue(wrongIdentitySession);
    mockState.clientFetch.mockResolvedValue(new Response(SESSION_INFO_BODY, { status: 200 }));
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          token: BEARER,
          pubky: PUBKY,
          capabilities: RING_COOKIE_CAPABILITIES,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );

    const { AuthController } = await import('./auth');
    const { awaitApproval } = await AuthController.getStepUpAuthUrl();

    await expect(awaitApproval).rejects.toMatchObject({ code: AuthErrorCode.UNAUTHORIZED });

    // The marketplace POST never ran, so no bearer exists anywhere: not in
    // the service's memory, not in its localStorage mirror, not in the
    // commerce store.
    expect(fetch).not.toHaveBeenCalled();
    const { MarketplaceSessionService, MARKETPLACE_SESSION_STORAGE_KEY } =
      await import('@/services/marketplace/marketplace-session');
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
    const { useCommerceStore } = await import('@/stores/commerce/commerce.store');
    expect(useCommerceStore.getState().marketplaceSession).toBeNull();

    // The wrong-identity session is signed back out, not left dangling.
    expect(signout).toHaveBeenCalledTimes(1);
  });

  it("step-up approved by a different identity keeps the SIGNED-IN user's resting marketplace bearer", async () => {
    // The device is signed in as A with A's own valid bearer at rest; the
    // signer approves the step-up as B (PUBKY). The gate runs BEFORE the
    // marketplace POST, so the only bearer at rest is A's — a mistaken scan
    // must never destroy A's approval.
    const signedInPubky = 'a'.repeat(52);
    mockState.currentUserPubky = signedInPubky;
    const signout = vi.fn();
    const wrongIdentitySession = asOpaque<Session>({
      info: { publicKey: { z32: () => PUBKY } },
      signout,
    });
    mockState.sessionRestore.mockResolvedValue(wrongIdentitySession);
    mockState.clientFetch.mockResolvedValue(new Response(SESSION_INFO_BODY, { status: 200 }));
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          token: BEARER,
          pubky: PUBKY,
          capabilities: RING_COOKIE_CAPABILITIES,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );

    // Seed A's bearer the way a restore leaves it: real service memory +
    // localStorage mirror + commerce store.
    const { MarketplaceSessionService, MARKETPLACE_SESSION_STORAGE_KEY } =
      await import('@/services/marketplace/marketplace-session');
    window.localStorage.setItem(
      MARKETPLACE_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: BEARER,
        pubky: signedInPubky,
        capabilities: RING_COOKIE_CAPABILITIES,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );
    const restored = MarketplaceSessionService.restorePersistedSession(signedInPubky);
    expect(restored).not.toBeNull();
    const { CommerceController } = await import('@/controllers/commerce/commerce');
    CommerceController.writeMarketplaceSessionStore(restored as NonNullable<typeof restored>);
    const { useCommerceStore } = await import('@/stores/commerce/commerce.store');
    expect(useCommerceStore.getState().marketplaceSession?.pubky).toBe(signedInPubky);

    const { AuthController } = await import('./auth');
    const { awaitApproval } = await AuthController.getStepUpAuthUrl();

    await expect(awaitApproval).rejects.toMatchObject({ code: AuthErrorCode.UNAUTHORIZED });

    // The marketplace POST never ran and B's session was signed back out…
    expect(fetch).not.toHaveBeenCalled();
    expect(signout).toHaveBeenCalledTimes(1);

    // …but A's bearer survived everywhere: service memory, localStorage
    // mirror, and the commerce store.
    expect(MarketplaceSessionService.getActiveSession()?.pubky).toBe(signedInPubky);
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).not.toBeNull();
    expect(useCommerceStore.getState().marketplaceSession?.pubky).toBe(signedInPubky);
  });

  it('completeStepUpReauth drops a resting bearer that belongs to a DIFFERENT identity than the signed-in user', async () => {
    // Hook-driven completion runs AFTER the ceremony outcome (i.e. after any
    // marketplace mint), so a wrong-identity bearer CAN be at rest there — a
    // leftover minted for a stranger. The gate must still drop it.
    const signedInPubky = 'a'.repeat(52);
    const strangerPubky = 'c'.repeat(52);
    mockState.currentUserPubky = signedInPubky;

    const { MarketplaceSessionService, MARKETPLACE_SESSION_STORAGE_KEY } =
      await import('@/services/marketplace/marketplace-session');
    window.localStorage.setItem(
      MARKETPLACE_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: BEARER,
        pubky: strangerPubky,
        capabilities: RING_COOKIE_CAPABILITIES,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );
    const restored = MarketplaceSessionService.restorePersistedSession(strangerPubky);
    expect(restored).not.toBeNull();
    const { CommerceController } = await import('@/controllers/commerce/commerce');
    CommerceController.writeMarketplaceSessionStore(restored as NonNullable<typeof restored>);
    const { useCommerceStore } = await import('@/stores/commerce/commerce.store');
    expect(useCommerceStore.getState().marketplaceSession?.pubky).toBe(strangerPubky);

    const signout = vi.fn();
    const wrongIdentitySession = asOpaque<Session>({
      info: { publicKey: { z32: () => PUBKY } },
      signout,
    });

    const { AuthController } = await import('./auth');
    await expect(AuthController.completeStepUpReauth({ session: wrongIdentitySession })).rejects.toMatchObject({
      code: AuthErrorCode.UNAUTHORIZED,
    });

    // The stranger's bearer is gone from service memory, the localStorage
    // mirror, and the commerce store.
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
    expect(useCommerceStore.getState().marketplaceSession).toBeNull();
    expect(signout).toHaveBeenCalledTimes(1);
  });
});
