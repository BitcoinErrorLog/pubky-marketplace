import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '@/controllers/auth/auth';
import { CommerceController } from '@/controllers/commerce/commerce';
import { isPassportApprovalRefused } from '@/hooks/useGrantSigner/useGrantSigner';
import { MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { getPassportOrigin } from '@/libs/runtime-config/runtime-config';
import { copyToClipboard } from '@/libs/utils/utils';
import { beginMarketplaceBootstrapFlow } from '@/services/marketplace/marketplace-bootstrap-client';
import { beginMarketplaceGrantFlow } from '@/services/marketplace/marketplace-grant-client';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { useAuthStore } from '@/stores/auth/auth.store';
import type { CommerceMarketplaceSession } from '@/stores/commerce/commerce.types';
import parityCapture from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import ringCookie from '@/test/fixtures/auth/ring-cookie-signin.pubky-common-0.11.json';
import { asOpaque } from '@/test-utils/type-assertions';
import { useMarketplaceSessionConnect } from './useMarketplaceSessionConnect';

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const SESSION: CommerceMarketplaceSession = {
  pubky: 'z'.repeat(52),
  capabilities: '/pub/pubky.app/:rw',
  expiresAt: '2026-08-22T00:00:00.000Z',
  issuedAt: '2026-08-21T00:00:00.000Z',
};

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    beginMarketplaceSessionConnect: vi.fn(),
    hasFullHomeserverGrant: vi.fn(() => true),
    writeMarketplaceSessionStore: vi.fn(),
  },
}));

vi.mock('@/services/marketplace/marketplace-grant-client', () => ({
  beginMarketplaceGrantFlow: vi.fn(),
}));

vi.mock('@/services/marketplace/marketplace-bootstrap-client', () => ({
  beginMarketplaceBootstrapFlow: vi.fn(),
}));

vi.mock('@/controllers/auth/auth', () => ({
  AuthController: {
    beginBridgedCommerceSessionFlow: vi.fn(),
    // The hook routes cancellation through the controller; the mock applies
    // the same net effect (the flow is freed) so cancel assertions hold.
    releaseAuthFlow: vi.fn((cancel: () => void) => cancel()),
  },
}));

vi.mock('@/libs/utils/utils', async () => {
  const actual = await vi.importActual<typeof import('@/libs/utils/utils')>('@/libs/utils/utils');
  return { ...actual, copyToClipboard: vi.fn().mockResolvedValue(undefined) };
});

/**
 * A controllable stand-in for one single-use session flow: the test decides
 * when the signer "approves" (resolve) or the flow fails (reject).
 */
function createDeferredFlow(url: string) {
  let resolveSession!: (session: CommerceMarketplaceSession) => void;
  let rejectSession!: (error: unknown) => void;
  const pending = new Promise<CommerceMarketplaceSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  const flow = {
    authorizationUrl: url,
    awaitSession: vi.fn(() => pending),
    cancel: vi.fn(),
  };
  return { flow, resolveSession, rejectSession };
}

describe('useMarketplaceSessionConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(true);
  });

  it('starts idle with no URL and no error', () => {
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    expect(result.current.status).toBe('idle');
    expect(result.current.authorizationUrl).toBe('');
    expect(result.current.errorMessage).toBeNull();
    expect(CommerceController.beginMarketplaceSessionConnect).not.toHaveBeenCalled();
  });

  it('starts the bridged single-approval flow when the homeserver grant is not full', () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=full');
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    vi.mocked(AuthController.beginBridgedCommerceSessionFlow).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());

    expect(AuthController.beginBridgedCommerceSessionFlow).toHaveBeenCalledTimes(1);
    expect(CommerceController.beginMarketplaceSessionConnect).not.toHaveBeenCalled();
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=full');
  });

  it('exposes requestsFullGrant so rendered copy and the started flow share one decision', () => {
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    const { result, rerender } = renderHook(() => useMarketplaceSessionConnect());

    expect(result.current.requestsFullGrant).toBe(true);

    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(true);
    rerender();
    expect(result.current.requestsFullGrant).toBe(false);
  });

  it('never auto-starts the bridged flow: mounting with a narrow grant requests no URL', () => {
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    expect(result.current.status).toBe('idle');
    expect(result.current.authorizationUrl).toBe('');
    expect(AuthController.beginBridgedCommerceSessionFlow).not.toHaveBeenCalled();
  });

  it('flag off: starts the legacy empty-capability connect even with a narrow grant', async () => {
    process.env.PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN = 'false';
    const { resetRuntimeConfigForTests } = await import('@/libs/runtime-config/runtime-config');
    resetRuntimeConfigForTests();
    try {
      const { flow } = createDeferredFlow('pubkyauth:///?caps=empty');
      vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
      vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
      const { result } = renderHook(() => useMarketplaceSessionConnect());

      expect(result.current.requestsFullGrant).toBe(false);
      act(() => result.current.start());

      expect(CommerceController.beginMarketplaceSessionConnect).toHaveBeenCalledTimes(1);
      expect(AuthController.beginBridgedCommerceSessionFlow).not.toHaveBeenCalled();
      expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=empty');
    } finally {
      delete process.env.PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN;
      resetRuntimeConfigForTests();
    }
  });

  it('frees a cancelled bridged flow THROUGH the controller so retry mints a fresh URL', () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=full');
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    vi.mocked(AuthController.beginBridgedCommerceSessionFlow).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    act(() => result.current.cancel());

    expect(AuthController.releaseAuthFlow).toHaveBeenCalledWith(flow.cancel);
    expect(result.current.status).toBe('idle');
  });

  it('treats a controller-cancelled (superseded) flow as control flow: idle, not error', async () => {
    const { flow, rejectSession } = createDeferredFlow('pubkyauth:///?caps=full');
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    vi.mocked(AuthController.beginBridgedCommerceSessionFlow).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    expect(result.current.status).toBe('awaiting');

    // A sign-in ceremony (or another start elsewhere) frees THIS flow through
    // the controller while the hook still points at it — that rejection is
    // control flow, not a failure.
    const canceledError = new Error('Auth flow canceled');
    canceledError.name = 'AuthFlowCanceled';
    rejectSession(canceledError);

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.authorizationUrl).toBe('');
  });

  it('a joined flow exposes the honest joined state — never awaiting with an empty URL', async () => {
    let resolveSession!: (session: CommerceMarketplaceSession) => void;
    const pending = new Promise<CommerceMarketplaceSession>((resolve) => {
      resolveSession = resolve;
    });
    // What AuthController.beginBridgedCommerceSessionFlow returns when a
    // direct sign-in ceremony is already in flight: no URL of its own.
    const joinedFlow = {
      authorizationUrl: '',
      joined: true,
      awaitSession: vi.fn(() => pending),
      cancel: vi.fn(),
    };
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    vi.mocked(AuthController.beginBridgedCommerceSessionFlow).mockReturnValue(joinedFlow);
    const onConnected = vi.fn();
    const { result } = renderHook(() => useMarketplaceSessionConnect({ onConnected }));

    act(() => result.current.start());

    expect(result.current.status).toBe('joined');
    expect(result.current.authorizationUrl).toBe('');

    // The join still settles through the shared ceremony: one approval on the
    // other surface connects this session too.
    resolveSession(SESSION);
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(onConnected).toHaveBeenCalledWith(SESSION);
  });

  it('exposes the authorization URL while awaiting and reports connected once the signer approves', async () => {
    const { flow, resolveSession } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const onConnected = vi.fn();
    const { result } = renderHook(() => useMarketplaceSessionConnect({ onConnected }));

    act(() => result.current.start());
    expect(result.current.status).toBe('awaiting');
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=first');

    resolveSession(SESSION);
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(onConnected).toHaveBeenCalledWith(SESSION);
    // The single-use URL is dead after resolution and must never be re-shown.
    expect(result.current.authorizationUrl).toBe('');
  });

  it('surfaces static failure copy and retries with a FRESH flow', async () => {
    const first = createDeferredFlow('pubkyauth:///?caps=first');
    const second = createDeferredFlow('pubkyauth:///?caps=second');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect)
      .mockReturnValueOnce(first.flow)
      .mockReturnValueOnce(second.flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    first.rejectSession(new Error('Relay timed out'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBe('The approval expired before it was completed. Try again.');
    expect(result.current.errorMessage).not.toContain('Relay timed out');
    expect(result.current.authorizationUrl).toBe('');

    act(() => result.current.start());
    expect(CommerceController.beginMarketplaceSessionConnect).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('awaiting');
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=second');
  });

  it('surfaces the flow timeout as a visible, retryable error instead of awaiting forever', async () => {
    const timedOut = createDeferredFlow('pubkyauth:///?caps=first');
    const fresh = createDeferredFlow('pubkyauth:///?caps=second');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect)
      .mockReturnValueOnce(timedOut.flow)
      .mockReturnValueOnce(fresh.flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    // The service-level timeout rejects awaitSession after SESSION_FLOW_TIMEOUT_MS.
    timedOut.rejectSession(
      new Error('The connect request expired before it was approved. Start again to get a fresh QR code.'),
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBe('The approval expired before it was completed. Try again.');
    expect(result.current.errorMessage).not.toContain('expired before it was approved');

    act(() => result.current.start());
    expect(result.current.status).toBe('awaiting');
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=second');
  });

  it('reports an error when the flow cannot even start (e.g. non-durable mode)', () => {
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockImplementation(() => {
      throw new Error('The marketplace transaction service is not enabled in this deployment.');
    });
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());

    expect(result.current.status).toBe('error');
    expect(result.current.errorMessage).toBe('Could not start the marketplace session.');
    expect(result.current.errorMessage).not.toContain('transaction service is not enabled');
  });

  it('cancel frees the flow, returns to idle, and drops the detached rejection silently', async () => {
    const { flow, rejectSession } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    act(() => result.current.cancel());
    expect(flow.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.authorizationUrl).toBe('');

    // The freed flow rejecting afterwards is control flow, not a failure.
    rejectSession(new Error('flow freed'));
    await act(async () => {});
    expect(result.current.status).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
  });

  it('maps thrown sentinel failures to static copy and keeps the error message static', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_session';
    const { flow, rejectSession } = createDeferredFlow('pubkyauth:///?caps=sentinel');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    rejectSession(
      new AppError({
        category: ErrorCategory.Auth,
        code: AuthErrorCode.SESSION_EXPIRED,
        message: sentinel,
        service: ErrorService.Marketplace,
        operation: 'sessionConnect',
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBeTypeOf('string');
    expect(result.current.errorMessage).not.toContain(sentinel);
  });

  it('a superseding start cancels the previous flow and ignores its late rejection', async () => {
    const first = createDeferredFlow('pubkyauth:///?caps=first');
    const second = createDeferredFlow('pubkyauth:///?caps=second');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect)
      .mockReturnValueOnce(first.flow)
      .mockReturnValueOnce(second.flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    act(() => result.current.start());
    expect(first.flow.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=second');

    first.rejectSession(new Error('flow freed'));
    await act(async () => {});
    expect(result.current.status).toBe('awaiting');

    second.resolveSession(SESSION);
    await waitFor(() => expect(result.current.status).toBe('connected'));
  });

  it('ignores an approval arriving after cancellation instead of connecting invisibly', async () => {
    const { flow, resolveSession } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const onConnected = vi.fn();
    const { result } = renderHook(() => useMarketplaceSessionConnect({ onConnected }));

    act(() => result.current.start());
    act(() => result.current.cancel());

    resolveSession(SESSION);
    await act(async () => {});
    expect(result.current.status).toBe('idle');
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('cancels the in-flight flow on unmount', () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const { result, unmount } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    unmount();

    expect(flow.cancel).toHaveBeenCalledTimes(1);
  });

  it('copies the authorization URL only while one exists', async () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    await act(() => result.current.copyAuthUrl());
    expect(copyToClipboard).not.toHaveBeenCalled();

    act(() => result.current.start());
    await act(() => result.current.copyAuthUrl());
    expect(copyToClipboard).toHaveBeenCalledWith({ text: 'pubkyauth:///?caps=first' });
  });

  it('opens the deeplink for same-device Ring and clears the opening state when the page hides', () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const originalLocation = window.location;
    const mockLocation = { ...originalLocation, href: '' };
    Object.defineProperty(window, 'location', { configurable: true, value: mockLocation });
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    act(() => result.current.openInRing());
    expect(mockLocation.href).toBe('pubkyauth:///?caps=first');
    expect(result.current.isOpeningRing).toBe(true);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.isOpeningRing).toBe(false);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });
});

describe('useMarketplaceSessionConnect grant reconnect', () => {
  async function enableGrantFlow() {
    process.env.PUBKY_RUNTIME_MARKETPLACE_GRANT_FLOW_ENABLED = 'true';
    const { resetRuntimeConfigForTests } = await import('@/libs/runtime-config/runtime-config');
    resetRuntimeConfigForTests();
    return () => {
      delete process.env.PUBKY_RUNTIME_MARKETPLACE_GRANT_FLOW_ENABLED;
      resetRuntimeConfigForTests();
    };
  }

  function createDeferredGrantFlow(url: string) {
    let resolveResult!: (result: {
      status: 'connected';
      token: string;
      pubky: string;
      capabilities: string;
      expires_at: string;
    }) => void;
    const pending = new Promise<Parameters<typeof resolveResult>[0]>((resolve) => {
      resolveResult = resolve;
    });
    const grantFlow = {
      authorizationUrl: url,
      awaitResult: vi.fn(() => pending),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    return { grantFlow, resolveResult };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bootstraps AuthToken when grant is enabled but no marketplace session exists', async () => {
    const restore = await enableGrantFlow();
    try {
      vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
      const { flow } = createDeferredFlow('pubkyauth:///?caps=bootstrap');
      vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
      const { result } = renderHook(() => useMarketplaceSessionConnect());

      act(() => result.current.start());

      expect(beginMarketplaceGrantFlow).not.toHaveBeenCalled();
      expect(CommerceController.beginMarketplaceSessionConnect).toHaveBeenCalledTimes(1);
      expect(result.current.requestsGrantReconnect).toBe(false);
      expect(result.current.status).toBe('awaiting');
      expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=bootstrap');
    } finally {
      restore();
    }
  });

  it('falls back to AuthToken when grant create returns shop_session_missing', async () => {
    const restore = await enableGrantFlow();
    try {
      vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue({
        token: 'session-token',
        sessionId: '11111111-1111-4111-8111-111111111111',
        pubky: SESSION.pubky,
        capabilities: '',
        expiresAt: SESSION.expiresAt,
        expiresAtMs: Date.parse(SESSION.expiresAt),
        issuedAt: SESSION.issuedAt,
      });
      vi.mocked(beginMarketplaceGrantFlow).mockRejectedValue(new Error('shop_session_missing'));
      const { flow } = createDeferredFlow('pubkyauth:///?caps=fallback');
      vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
      const { result } = renderHook(() => useMarketplaceSessionConnect());

      act(() => result.current.start());
      await waitFor(() => expect(result.current.status).toBe('awaiting'));

      expect(beginMarketplaceGrantFlow).toHaveBeenCalledTimes(1);
      expect(CommerceController.beginMarketplaceSessionConnect).toHaveBeenCalledTimes(1);
      expect(result.current.requestsGrantReconnect).toBe(false);
      expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=fallback');
      expect(result.current.errorMessage).toBeNull();
      expect(result.current.errorMessage).not.toBe(MARKETPLACE_FAILURE_MESSAGES.sessionTimeout);
    } finally {
      restore();
    }
  });

  it('does not label a grant_unavailable failure as expiry', async () => {
    const restore = await enableGrantFlow();
    try {
      vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue({
        token: 'session-token',
        sessionId: '11111111-1111-4111-8111-111111111111',
        pubky: SESSION.pubky,
        capabilities: '',
        expiresAt: SESSION.expiresAt,
        expiresAtMs: Date.parse(SESSION.expiresAt),
        issuedAt: SESSION.issuedAt,
      });
      vi.mocked(beginMarketplaceGrantFlow).mockRejectedValue(new Error('grant_unavailable'));
      const { result } = renderHook(() => useMarketplaceSessionConnect());

      act(() => result.current.start());
      await waitFor(() => expect(result.current.status).toBe('error'));

      expect(result.current.errorMessage).toBe(MARKETPLACE_FAILURE_MESSAGES.sessionStart);
      expect(result.current.errorMessage).not.toBe(MARKETPLACE_FAILURE_MESSAGES.sessionTimeout);
      expect(CommerceController.beginMarketplaceSessionConnect).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  describe('claimed grant results (real MarketplaceSessionService)', () => {
    const WIDE_TOKEN = 'W'.repeat(43);
    const CLAIMED_TOKEN = 'C'.repeat(43);
    const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

    beforeEach(() => {
      vi.restoreAllMocks();
      vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(true);
      MarketplaceSessionService.clearSession();
      useAuthStore.setState({ currentUserPubky: SESSION.pubky });
    });

    afterEach(() => {
      MarketplaceSessionService.clearSession();
      useAuthStore.setState({ currentUserPubky: null });
    });

    function seedCurrentSession(capabilities: string) {
      MarketplaceSessionService.establishClaimedGrantSession(
        { token: WIDE_TOKEN, pubky: SESSION.pubky, capabilities, expiresAt: FUTURE },
        SESSION.pubky,
      );
    }

    async function claim(capabilities: string) {
      const { grantFlow, resolveResult } = createDeferredGrantFlow('pubkyauth://signin_grant?caps=reconnect');
      vi.mocked(beginMarketplaceGrantFlow).mockResolvedValue(grantFlow);
      const onConnected = vi.fn();
      const hook = renderHook(() => useMarketplaceSessionConnect({ onConnected }));
      act(() => hook.result.current.start());
      await waitFor(() => expect(hook.result.current.status).toBe('awaiting'));
      resolveResult({
        status: 'connected',
        token: CLAIMED_TOKEN,
        pubky: SESSION.pubky,
        capabilities,
        expires_at: FUTURE,
      });
      return { ...hook, onConnected };
    }

    it('replaces the current session with the /priv parity grant Bitkit approved on staging', async () => {
      const restore = await enableGrantFlow();
      try {
        seedCurrentSession(parityCapture.previous_request.homeserver_verified);
        const { result, onConnected } = await claim(parityCapture.parity_request.homeserver_verified);

        await waitFor(() => expect(result.current.status).toBe('connected'));
        expect(MarketplaceSessionService.getActiveSession()?.token).toBe(CLAIMED_TOKEN);
        expect(MarketplaceSessionService.getActiveSession()?.capabilities).toBe(
          parityCapture.parity_request.homeserver_verified,
        );
        expect(CommerceController.writeMarketplaceSessionStore).toHaveBeenCalledTimes(1);
        expect(onConnected).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it.each([
      ['an empty grant', ''],
      ['a read-only inventory grant', '/pub/pubky.app/marketplace-service/v1/:r'],
      ['only /priv', '/priv/pubky.app/:rw'],
      ['an extra tree', `${parityCapture.parity_request.homeserver_verified},/pub/paykit/:rw`],
      ['root', '/:rw'],
      [
        'a duplicated entry',
        `${parityCapture.previous_request.homeserver_verified},/pub/pubky.app/marketplace-service/v1/:rw`,
      ],
      ['malformed text', 'not-a-capability'],
    ])('keeps a wide current session when the claimed result carries %s', async (_label, capabilities) => {
      const restore = await enableGrantFlow();
      try {
        seedCurrentSession(parityCapture.parity_request.homeserver_verified);
        const { result, onConnected } = await claim(capabilities);

        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.errorMessage).toBe(MARKETPLACE_FAILURE_MESSAGES.sessionGrantUnexpected);
        expect(MarketplaceSessionService.getActiveSession()?.token).toBe(WIDE_TOKEN);
        expect(CommerceController.writeMarketplaceSessionStore).not.toHaveBeenCalled();
        expect(onConnected).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('keeps a wide current session when the claimed grant drops /priv', async () => {
      const restore = await enableGrantFlow();
      try {
        seedCurrentSession(parityCapture.parity_request.homeserver_verified);
        const { result, onConnected } = await claim(parityCapture.previous_request.homeserver_verified);

        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.errorMessage).toBe(MARKETPLACE_FAILURE_MESSAGES.sessionGrantNarrower);
        expect(MarketplaceSessionService.getActiveSession()?.token).toBe(WIDE_TOKEN);
        expect(CommerceController.writeMarketplaceSessionStore).not.toHaveBeenCalled();
        expect(onConnected).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('keeps a Ring sign-in session whose grant covers /priv when the claim is inventory-only', async () => {
      process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
      const restore = await enableGrantFlow();
      try {
        const signIn = ringCookie.service_normalized;
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          new Response(
            JSON.stringify({ token: WIDE_TOKEN, pubky: SESSION.pubky, capabilities: signIn, expires_at: FUTURE }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
        );
        await MarketplaceSessionService.redeemAuthTokenAfterHomeserver(new Uint8Array([1]), SESSION.pubky, Date.now());
        expect(MarketplaceSessionService.getActiveSession()?.capabilities).toBe(signIn);

        const { result, onConnected } = await claim(parityCapture.previous_request.homeserver_verified);

        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.errorMessage).toBe(MARKETPLACE_FAILURE_MESSAGES.sessionGrantNarrower);
        expect(MarketplaceSessionService.getActiveSession()?.token).toBe(WIDE_TOKEN);
        expect(onConnected).not.toHaveBeenCalled();
      } finally {
        delete process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE;
        restore();
      }
    });
  });

  describe('Bitkit (grant) sign-in purchase bootstrap', () => {
    const OTHER_PUBKY = 'o'.repeat(52);

    function signInWithGrant(pubky = SESSION.pubky) {
      useAuthStore.setState({
        currentUserPubky: pubky,
        session: asOpaque({ grant: {}, info: { publicKey: { z32: () => pubky } } }),
      });
    }

    afterEach(() => {
      useAuthStore.setState({ currentUserPubky: null, session: null });
    });

    it('grant session connect uses bootstrap', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithGrant();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const { grantFlow } = createDeferredGrantFlow('pubkyauth://signin_grant?caps=bootstrap');
        vi.mocked(beginMarketplaceBootstrapFlow).mockResolvedValue(grantFlow);
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        expect(result.current.requestsGrantBootstrap).toBe(true);
        act(() => result.current.start());
        await waitFor(() => expect(result.current.status).toBe('awaiting'));

        expect(result.current.authorizationUrl).toBe('pubkyauth://signin_grant?caps=bootstrap');
        expect(result.current.requestsGrantReconnect).toBe(false);
        expect(beginMarketplaceGrantFlow).not.toHaveBeenCalled();
        expect(CommerceController.beginMarketplaceSessionConnect).not.toHaveBeenCalled();
        expect(AuthController.beginBridgedCommerceSessionFlow).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('challenge pubky comes from live grant session', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithGrant();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const { grantFlow } = createDeferredGrantFlow('pubkyauth://signin_grant?caps=bootstrap');
        vi.mocked(beginMarketplaceBootstrapFlow).mockResolvedValue(grantFlow);
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        act(() => result.current.start());
        await waitFor(() => expect(beginMarketplaceBootstrapFlow).toHaveBeenCalledTimes(1));
        expect(beginMarketplaceBootstrapFlow).toHaveBeenCalledWith({ pubky: SESSION.pubky });
      } finally {
        restore();
      }
    });

    it('a Ring (cookie) sign-in never runs the grant bootstrap', async () => {
      const restore = await enableGrantFlow();
      try {
        useAuthStore.setState({
          currentUserPubky: SESSION.pubky,
          session: asOpaque({ info: { publicKey: { z32: () => SESSION.pubky } } }),
        });
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const { flow } = createDeferredFlow('pubkyauth:///?caps=ring');
        vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        expect(result.current.requestsGrantBootstrap).toBe(false);
        act(() => result.current.start());

        expect(beginMarketplaceBootstrapFlow).not.toHaveBeenCalled();
        expect(CommerceController.beginMarketplaceSessionConnect).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it('browser rejects bearer for another pubky', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithGrant();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const establish = vi.spyOn(MarketplaceSessionService, 'establishClaimedGrantSession');
        const { grantFlow, resolveResult } = createDeferredGrantFlow('pubkyauth://signin_grant?caps=bootstrap');
        vi.mocked(beginMarketplaceBootstrapFlow).mockResolvedValue(grantFlow);
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        act(() => result.current.start());
        await waitFor(() => expect(result.current.status).toBe('awaiting'));
        resolveResult({
          status: 'connected',
          token: 'claimed-token',
          pubky: OTHER_PUBKY,
          capabilities: '/pub/pubky.app/marketplace-service/v1/:rw',
          expires_at: SESSION.expiresAt,
        });

        await waitFor(() => expect(result.current.status).toBe('mismatch'));
        expect(establish).not.toHaveBeenCalled();
        expect(CommerceController.writeMarketplaceSessionStore).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('an ended grant sign-in shows the bootstrap copy, not the AuthToken fallback', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithGrant();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        vi.mocked(beginMarketplaceBootstrapFlow).mockRejectedValue(new Error('shop_session_expired'));
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        act(() => result.current.start());
        await waitFor(() => expect(result.current.status).toBe('error'));

        expect(result.current.errorMessage).toBe('Your Shop session ended. Sign in again.');
        expect(CommerceController.beginMarketplaceSessionConnect).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('a failed Bitkit approval shows the approval_invalid copy', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithGrant();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const failed = {
          authorizationUrl: 'pubkyauth://signin_grant?caps=bootstrap',
          awaitResult: vi.fn().mockResolvedValue({ status: 'failed' }),
          cancel: vi.fn().mockResolvedValue(undefined),
        };
        vi.mocked(beginMarketplaceBootstrapFlow).mockResolvedValue(failed);
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        act(() => result.current.start());
        await waitFor(() => expect(result.current.status).toBe('error'));

        expect(result.current.errorMessage).toBe('That approval could not be verified. Approve again in Bitkit.');
      } finally {
        restore();
      }
    });
  });

  describe('Pubky Passport sign-in purchase approval', () => {
    const ACTIVE_SESSION = {
      token: 'session-token',
      sessionId: '11111111-1111-4111-8111-111111111111',
      pubky: SESSION.pubky,
      capabilities: '',
      expiresAt: SESSION.expiresAt,
      expiresAtMs: Date.parse(SESSION.expiresAt),
      issuedAt: SESSION.issuedAt,
    };

    function signInWithPassport() {
      useAuthStore.setState({
        currentUserPubky: SESSION.pubky,
        session: asOpaque({ grant: {}, info: { publicKey: { z32: () => SESSION.pubky } } }),
        grantSigner: 'passport',
      });
    }

    function openPopup() {
      const popup = {
        closed: false,
        location: { replace: vi.fn() },
        close: vi.fn(() => {
          popup.closed = true;
        }),
        focus: vi.fn(),
        postMessage: vi.fn(),
      };
      const open = vi.spyOn(window, 'open').mockReturnValue(asOpaque<Window>(popup));
      return { popup, open };
    }

    function passportSays(popup: unknown, outcome: string) {
      const event = new Event('message');
      Object.defineProperties(event, {
        data: {
          value: { type: 'pubky-passport.authorization-outcome', version: 1, outcome, messageId: 'm-1' },
        },
        origin: { value: getPassportOrigin() },
        source: { value: popup },
      });
      window.dispatchEvent(event);
    }

    afterEach(() => {
      useAuthStore.setState({ currentUserPubky: null, session: null, grantSigner: null });
    });

    it('arms the bootstrap on start and opens nothing until the click', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithPassport();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const { open } = openPopup();
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        expect(result.current.requestsPassport).toBe(true);
        act(() => result.current.start());

        expect(result.current.status).toBe('idle');
        expect(result.current.requestsGrantBootstrap).toBe(true);
        expect(result.current.authorizationUrl).toBe('');
        expect(beginMarketplaceBootstrapFlow).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('the click opens Passport with the service grant URL and connects on approval', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithPassport();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const claimed = { ...ACTIVE_SESSION, token: 'claimed-token' };
        const establish = vi
          .spyOn(MarketplaceSessionService, 'establishClaimedGrantSession')
          .mockReturnValue(asOpaque(claimed));
        const { popup, open } = openPopup();
        const url = `pubkyauth://signin_grant?caps=${encodeURIComponent('/pub/pubky.app/marketplace-service/v1/:rw')}`;
        const { grantFlow, resolveResult } = createDeferredGrantFlow(url);
        vi.mocked(beginMarketplaceBootstrapFlow).mockResolvedValue(grantFlow);
        const onConnected = vi.fn();
        const { result } = renderHook(() => useMarketplaceSessionConnect({ onConnected }));

        act(() => result.current.start());
        act(() => result.current.startPassport());

        expect(open).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(result.current.status).toBe('awaiting'));
        expect(beginMarketplaceBootstrapFlow).toHaveBeenCalledWith({ pubky: SESSION.pubky });
        expect(popup.location.replace).toHaveBeenCalledWith(
          `${getPassportOrigin()}/authorize#d=${encodeURIComponent(url)}`,
        );

        resolveResult({
          status: 'connected',
          token: 'claimed-token',
          pubky: SESSION.pubky,
          capabilities: '/pub/pubky.app/marketplace-service/v1/:rw',
          expires_at: SESSION.expiresAt,
        });
        await waitFor(() => expect(result.current.status).toBe('connected'));
        expect(establish).toHaveBeenCalledTimes(1);
        expect(CommerceController.writeMarketplaceSessionStore).toHaveBeenCalledWith(claimed);
        expect(onConnected).toHaveBeenCalledWith(claimed);
        expect(popup.close).toHaveBeenCalled();
        expect(grantFlow.cancel).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('a cancel in Passport cancels the service flow and ends as cancelled', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithPassport();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const { popup } = openPopup();
        const { grantFlow } = createDeferredGrantFlow('pubkyauth://signin_grant?caps=bootstrap');
        vi.mocked(beginMarketplaceBootstrapFlow).mockResolvedValue(grantFlow);
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        act(() => result.current.start());
        act(() => result.current.startPassport());
        await waitFor(() => expect(result.current.status).toBe('awaiting'));
        act(() => passportSays(popup, 'cancel'));

        await waitFor(() => expect(result.current.status).toBe('cancelled'));
        expect(grantFlow.cancel).toHaveBeenCalledTimes(1);
        expect(popup.close).toHaveBeenCalled();
        expect(CommerceController.writeMarketplaceSessionStore).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('a blocked popup reports it and never mints a service flow', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithPassport();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        vi.spyOn(window, 'open').mockReturnValue(null);
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        act(() => result.current.start());
        act(() => result.current.startPassport());

        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.errorMessage).toBe(
          'Your browser blocked the Pubky Passport window. Allow pop-ups for this site and try again.',
        );
        expect(beginMarketplaceBootstrapFlow).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('a failed Passport approval names Passport, not Bitkit', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithPassport();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        openPopup();
        vi.mocked(beginMarketplaceBootstrapFlow).mockResolvedValue({
          authorizationUrl: 'pubkyauth://signin_grant?caps=bootstrap',
          awaitResult: vi.fn().mockResolvedValue({ status: 'failed' }),
          cancel: vi.fn().mockResolvedValue(undefined),
        });
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        act(() => result.current.start());
        act(() => result.current.startPassport());

        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.errorMessage).toBe(
          'That approval could not be verified. Approve again in Pubky Passport.',
        );
      } finally {
        restore();
      }
    });

    it('a Passport reconnect that needs a session ends with the copy, never a Ring AuthToken QR', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithPassport();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(ACTIVE_SESSION);
        openPopup();
        vi.mocked(beginMarketplaceGrantFlow).mockRejectedValue(new Error('shop_session_missing'));
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        act(() => result.current.start());
        expect(result.current.requestsGrantReconnect).toBe(true);
        expect(beginMarketplaceGrantFlow).not.toHaveBeenCalled();
        act(() => result.current.startPassport());

        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(beginMarketplaceGrantFlow).toHaveBeenCalledTimes(1);
        expect(result.current.errorMessage).toBe(MARKETPLACE_FAILURE_MESSAGES.sessionMissing);
        expect(CommerceController.beginMarketplaceSessionConnect).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('cancel drops an armed approval, so a later click opens nothing', async () => {
      const restore = await enableGrantFlow();
      try {
        signInWithPassport();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const { open } = openPopup();
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        act(() => result.current.start());
        act(() => result.current.cancel());
        act(() => result.current.startPassport());

        expect(open).not.toHaveBeenCalled();
        expect(beginMarketplaceBootstrapFlow).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('with Passport switched off, a Passport sign-in starts no approval of any kind', async () => {
      const restore = await enableGrantFlow();
      process.env.PUBKY_RUNTIME_PASSPORT_SIGN_IN = 'false';
      const { resetRuntimeConfigForTests } = await import('@/libs/runtime-config/runtime-config');
      resetRuntimeConfigForTests();
      try {
        signInWithPassport();
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const { open } = openPopup();
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        expect(result.current.requestsPassport).toBe(false);
        expect(isPassportApprovalRefused()).toBe(true);
        act(() => result.current.start());
        act(() => result.current.startPassport());

        expect(result.current.status).toBe('idle');
        expect(result.current.authorizationUrl).toBe('');
        expect(open).not.toHaveBeenCalled();
        expect(beginMarketplaceBootstrapFlow).not.toHaveBeenCalled();
        expect(beginMarketplaceGrantFlow).not.toHaveBeenCalled();
        expect(CommerceController.beginMarketplaceSessionConnect).not.toHaveBeenCalled();
      } finally {
        delete process.env.PUBKY_RUNTIME_PASSPORT_SIGN_IN;
        restore();
      }
    });

    it('a Bitkit grant sign-in keeps the QR bootstrap and never opens Passport', async () => {
      const restore = await enableGrantFlow();
      try {
        useAuthStore.setState({
          currentUserPubky: SESSION.pubky,
          session: asOpaque({ grant: {}, info: { publicKey: { z32: () => SESSION.pubky } } }),
          grantSigner: 'bitkit',
        });
        vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue(null);
        const { open } = openPopup();
        const { grantFlow } = createDeferredGrantFlow('pubkyauth://signin_grant?caps=bootstrap');
        vi.mocked(beginMarketplaceBootstrapFlow).mockResolvedValue(grantFlow);
        const { result } = renderHook(() => useMarketplaceSessionConnect());

        expect(result.current.requestsPassport).toBe(false);
        act(() => result.current.start());
        await waitFor(() => expect(result.current.status).toBe('awaiting'));

        expect(result.current.authorizationUrl).toBe('pubkyauth://signin_grant?caps=bootstrap');
        expect(open).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });
  });
});
