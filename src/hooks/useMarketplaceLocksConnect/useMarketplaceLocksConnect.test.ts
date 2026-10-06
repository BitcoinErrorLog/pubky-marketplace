import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { httpResponseToError } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';
import { HttpStatusCode } from '@/libs/http/http.types';
import { useAuthStore } from '@/stores/auth/auth.store';
import {
  LOCKS_CONNECT_CALLBACK_TYPE,
  LOCKS_CONNECT_IDENTITY_ERROR,
  LOCKS_CONNECT_REAPPROVE_NOTICE,
  LOCKS_CONNECT_USER_ERROR,
  LOCKS_STATUS_CHECK_ERROR,
  useMarketplaceLocksConnect,
} from './useMarketplaceLocksConnect';

const PUBKY = 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco';
const OTHER = 'ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u';
const LOCKS_ORIGIN = 'https://locks.example.com';

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getLocksUrl: () => LOCKS_ORIGIN,
  };
});

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    createLocksFrontendSession: vi.fn(),
    getLocksCreatorAuthorityStatus: vi.fn(),
    getLocksPublicCreatorAuthorityStatus: vi.fn(),
    restoreLocksFrontendSession: vi.fn(),
    clearLocksFrontendSession: vi.fn(),
  },
}));

const mockedController = vi.mocked(CommerceController);

function dispatchLocksCallback(source: WindowProxy, data: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: LOCKS_ORIGIN,
      source,
      data,
    }),
  );
}

describe('useMarketplaceLocksConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useAuthStore.setState({ currentUserPubky: PUBKY });
    mockedController.restoreLocksFrontendSession.mockReturnValue(null);
    mockedController.getLocksPublicCreatorAuthorityStatus.mockResolvedValue({
      creator: `pubky${PUBKY}`,
      authorized: false,
    });
    mockedController.createLocksFrontendSession.mockResolvedValue({
      session_token: 'session-token',
      creator: `pubky${PUBKY}`,
    });
    vi.spyOn(window, 'open');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the Lock Server iframe with postmessage delivery and never window.opens', () => {
    const { result } = renderHook(() => useMarketplaceLocksConnect());

    act(() => {
      result.current.openConnect();
    });

    expect(window.open).not.toHaveBeenCalled();
    expect(result.current.connectOpen).toBe(true);
    const url = new URL(result.current.connectUrl ?? '');
    expect(url.origin).toBe(LOCKS_ORIGIN);
    expect(url.pathname).toBe('/connect');
    expect(url.searchParams.get('delivery')).toBe('postmessage');
    expect(url.searchParams.get('return_to')).toContain(window.location.origin);
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('exchanges a matching postmessage callback without a manual complete button', async () => {
    const { result } = renderHook(() => useMarketplaceLocksConnect());
    const source = {} as WindowProxy;

    act(() => {
      result.current.openConnect();
    });
    const state = new URL(result.current.connectUrl ?? '').searchParams.get('state');
    act(() => {
      result.current.setConnectIframe({ contentWindow: source } as HTMLIFrameElement);
    });

    await act(async () => {
      dispatchLocksCallback(source, { type: LOCKS_CONNECT_CALLBACK_TYPE, state, code: 'one-time-code' });
    });

    await waitFor(() => expect(result.current.connectedCreator).toBe(PUBKY));
    expect(mockedController.createLocksFrontendSession).toHaveBeenCalledWith('one-time-code', state, PUBKY);
    expect(result.current.connectOpen).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('shows a plain-language error for a Lock Server callback failure, never raw JSON', async () => {
    const { result } = renderHook(() => useMarketplaceLocksConnect());
    const source = {} as WindowProxy;

    act(() => {
      result.current.openConnect();
    });
    act(() => {
      result.current.setConnectIframe({ contentWindow: source } as HTMLIFrameElement);
    });

    await act(async () => {
      dispatchLocksCallback(source, {
        type: LOCKS_CONNECT_CALLBACK_TYPE,
        error: 'connect-failed-404',
      });
    });

    expect(result.current.error).toBe(LOCKS_CONNECT_USER_ERROR);
    expect(result.current.error).not.toMatch(/creator_connect_flow_unavailable|connect-failed-404|\{/);
    expect(mockedController.createLocksFrontendSession).not.toHaveBeenCalled();
  });

  it('restores a persisted connection after reload when the Lock Server still authorizes it', async () => {
    mockedController.restoreLocksFrontendSession.mockReturnValue({
      token: 'session-token',
      creator: `pubky${PUBKY}`,
      pubky: PUBKY,
    });
    mockedController.getLocksCreatorAuthorityStatus.mockResolvedValue({
      creator: `pubky${PUBKY}`,
      authorized: true,
    });

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(result.current.connectedCreator).toBe(PUBKY));
    expect(mockedController.getLocksCreatorAuthorityStatus).toHaveBeenCalledWith('session-token');
  });

  it('drops a persisted connection the Lock Server no longer accepts', async () => {
    mockedController.restoreLocksFrontendSession.mockReturnValue({
      token: 'session-token',
      creator: `pubky${PUBKY}`,
      pubky: PUBKY,
    });
    mockedController.getLocksCreatorAuthorityStatus.mockRejectedValue(
      Err.auth(AuthErrorCode.UNAUTHORIZED, 'Lock Server session is invalid.', {
        service: ErrorService.Locks,
        operation: 'getCreatorAuthorityStatus',
        context: { statusCode: HttpStatusCode.UNAUTHORIZED },
      }),
    );

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(mockedController.clearLocksFrontendSession).toHaveBeenCalledWith('session-token'));
    expect(result.current.connectedCreator).toBeNull();
  });

  it('keeps a persisted connection when authority-status cannot be reached', async () => {
    mockedController.restoreLocksFrontendSession.mockReturnValue({
      token: 'session-token',
      creator: `pubky${PUBKY}`,
      pubky: PUBKY,
    });
    mockedController.getLocksCreatorAuthorityStatus.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(result.current.error).toBe(LOCKS_STATUS_CHECK_ERROR));
    expect(mockedController.clearLocksFrontendSession).not.toHaveBeenCalled();
    expect(result.current.connectedCreator).toBeNull();
    expect(result.current.reapproveNotice).toBeNull();
  });

  it('explains an authenticated status 503 instead of reading as Not set up', async () => {
    mockedController.restoreLocksFrontendSession.mockReturnValue({
      token: 'session-token',
      creator: `pubky${PUBKY}`,
      pubky: PUBKY,
    });
    const url = `${LOCKS_ORIGIN}/creator/authority-status`;
    mockedController.getLocksCreatorAuthorityStatus.mockRejectedValue(
      httpResponseToError(
        new Response(
          JSON.stringify({
            error: { code: 'creator_authority_unavailable', message: 'creator authority unavailable' },
          }),
          { status: HttpStatusCode.SERVICE_UNAVAILABLE, headers: { 'content-type': 'application/json' } },
        ),
        ErrorService.Locks,
        'getCreatorAuthorityStatus',
        url,
      ),
    );

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(result.current.error).toBe(LOCKS_STATUS_CHECK_ERROR));
    expect(result.current.connectedCreator).toBeNull();
    expect(result.current.reapproveNotice).toBeNull();
    expect(mockedController.clearLocksFrontendSession).not.toHaveBeenCalled();
    expect(mockedController.getLocksPublicCreatorAuthorityStatus).not.toHaveBeenCalled();
  });

  it('drops a persisted connection when authority-status reports unauthorized', async () => {
    mockedController.restoreLocksFrontendSession.mockReturnValue({
      token: 'session-token',
      creator: `pubky${PUBKY}`,
      pubky: PUBKY,
    });
    mockedController.getLocksCreatorAuthorityStatus.mockResolvedValue({
      creator: `pubky${PUBKY}`,
      authorized: false,
    });

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(mockedController.clearLocksFrontendSession).toHaveBeenCalledWith('session-token'));
    expect(result.current.connectedCreator).toBeNull();
  });

  it('shows Connected from the stored authority when this browser holds no Lock Server session', async () => {
    mockedController.getLocksPublicCreatorAuthorityStatus.mockResolvedValue({
      creator: `pubky${PUBKY}`,
      authorized: true,
    });

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(result.current.connectedCreator).toBe(PUBKY));
    expect(mockedController.getLocksPublicCreatorAuthorityStatus).toHaveBeenCalledWith(PUBKY);
    expect(mockedController.getLocksCreatorAuthorityStatus).not.toHaveBeenCalled();
    expect(result.current.reapproveNotice).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('keeps Step 1 Connected after the 24-hour session expires when the authority is still stored', async () => {
    mockedController.restoreLocksFrontendSession.mockReturnValue({
      token: 'session-token',
      creator: `pubky${PUBKY}`,
      pubky: PUBKY,
    });
    mockedController.getLocksCreatorAuthorityStatus.mockRejectedValue(
      Err.auth(AuthErrorCode.UNAUTHORIZED, 'Lock Server session is invalid.', {
        service: ErrorService.Locks,
        operation: 'getCreatorAuthorityStatus',
        context: { statusCode: HttpStatusCode.UNAUTHORIZED },
      }),
    );
    mockedController.getLocksPublicCreatorAuthorityStatus.mockResolvedValue({
      creator: `pubky${PUBKY}`,
      authorized: true,
    });

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(result.current.connectedCreator).toBe(PUBKY));
    expect(mockedController.clearLocksFrontendSession).toHaveBeenCalledWith('session-token');
    expect(result.current.reapproveNotice).toBeNull();
  });

  it('asks for one fresh approval, with the reason, when the Lock Server has no creator-keyed status', async () => {
    mockedController.getLocksPublicCreatorAuthorityStatus.mockResolvedValue(null);

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(result.current.reapproveNotice).toBe(LOCKS_CONNECT_REAPPROVE_NOTICE));
    expect(result.current.connectedCreator).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('explains a failed creator-keyed status check instead of asking for a fresh approval', async () => {
    mockedController.getLocksPublicCreatorAuthorityStatus.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(result.current.error).toBe(LOCKS_STATUS_CHECK_ERROR));
    expect(result.current.connectedCreator).toBeNull();
    expect(result.current.reapproveNotice).toBeNull();
  });

  it('stays Not set up without a notice when the Lock Server holds no authority for the account', async () => {
    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(mockedController.getLocksPublicCreatorAuthorityStatus).toHaveBeenCalledWith(PUBKY));
    expect(result.current.connectedCreator).toBeNull();
    expect(result.current.reapproveNotice).toBeNull();
  });

  it('never marks Connected from a creator-keyed status that names another account', async () => {
    mockedController.getLocksPublicCreatorAuthorityStatus.mockResolvedValue({
      creator: `pubky${OTHER}`,
      authorized: true,
    });

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(mockedController.getLocksPublicCreatorAuthorityStatus).toHaveBeenCalled());
    expect(result.current.connectedCreator).toBeNull();
  });

  it('clears the fresh-approval notice once a new connect completes', async () => {
    mockedController.getLocksPublicCreatorAuthorityStatus.mockResolvedValue(null);
    const { result } = renderHook(() => useMarketplaceLocksConnect());
    await waitFor(() => expect(result.current.reapproveNotice).toBe(LOCKS_CONNECT_REAPPROVE_NOTICE));

    const source = {} as WindowProxy;
    act(() => {
      result.current.openConnect();
    });
    const state = new URL(result.current.connectUrl ?? '').searchParams.get('state');
    act(() => {
      result.current.setConnectIframe({ contentWindow: source } as HTMLIFrameElement);
    });
    await act(async () => {
      dispatchLocksCallback(source, { type: LOCKS_CONNECT_CALLBACK_TYPE, state, code: 'one-time-code' });
    });

    await waitFor(() => expect(result.current.connectedCreator).toBe(PUBKY));
    expect(result.current.reapproveNotice).toBeNull();
  });

  it('ignores a callback from the wrong origin or a mismatched state', async () => {
    const { result } = renderHook(() => useMarketplaceLocksConnect());
    const source = {} as WindowProxy;

    act(() => {
      result.current.openConnect();
    });
    const state = new URL(result.current.connectUrl ?? '').searchParams.get('state');
    act(() => {
      result.current.setConnectIframe({ contentWindow: source } as HTMLIFrameElement);
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://evil.example',
          source,
          data: { type: LOCKS_CONNECT_CALLBACK_TYPE, state, code: 'stolen' },
        }),
      );
      dispatchLocksCallback(source, { type: LOCKS_CONNECT_CALLBACK_TYPE, state: 'other', code: 'one-time-code' });
    });

    expect(mockedController.createLocksFrontendSession).not.toHaveBeenCalled();
    expect(result.current.connectedCreator).toBeNull();
    expect(result.current.error).toBe(LOCKS_CONNECT_USER_ERROR);
  });

  it('ignores a callback whose source is not the connect iframe', async () => {
    const { result } = renderHook(() => useMarketplaceLocksConnect());
    const iframeSource = {} as WindowProxy;
    const otherSource = {} as WindowProxy;

    act(() => {
      result.current.openConnect();
    });
    const state = new URL(result.current.connectUrl ?? '').searchParams.get('state');
    act(() => {
      result.current.setConnectIframe({ contentWindow: iframeSource } as HTMLIFrameElement);
    });

    await act(async () => {
      dispatchLocksCallback(otherSource, { type: LOCKS_CONNECT_CALLBACK_TYPE, state, code: 'one-time-code' });
    });

    expect(mockedController.createLocksFrontendSession).not.toHaveBeenCalled();
    expect(result.current.connectedCreator).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('does not wipe a persisted connection when a later connect exchange fails', async () => {
    mockedController.restoreLocksFrontendSession.mockReturnValue({
      token: 'session-token',
      creator: `pubky${PUBKY}`,
      pubky: PUBKY,
    });
    mockedController.getLocksCreatorAuthorityStatus.mockResolvedValue({
      creator: `pubky${PUBKY}`,
      authorized: true,
    });
    mockedController.createLocksFrontendSession.mockRejectedValue(new Error('exchange-failed'));

    const { result } = renderHook(() => useMarketplaceLocksConnect());
    await waitFor(() => expect(result.current.connectedCreator).toBe(PUBKY));

    const source = {} as WindowProxy;
    act(() => {
      result.current.openConnect();
    });
    const state = new URL(result.current.connectUrl ?? '').searchParams.get('state');
    act(() => {
      result.current.setConnectIframe({ contentWindow: source } as HTMLIFrameElement);
    });

    await act(async () => {
      dispatchLocksCallback(source, { type: LOCKS_CONNECT_CALLBACK_TYPE, state, code: 'one-time-code' });
    });

    await waitFor(() => expect(result.current.error).toBe(LOCKS_CONNECT_USER_ERROR));
    expect(result.current.connectedCreator).toBe(PUBKY);
    expect(mockedController.clearLocksFrontendSession).not.toHaveBeenCalled();
  });

  it('marks Connected when the Lock Server creator is the signed-in Shop pubky', async () => {
    const { result } = renderHook(() => useMarketplaceLocksConnect());
    const source = {} as WindowProxy;

    act(() => {
      result.current.openConnect();
    });
    const state = new URL(result.current.connectUrl ?? '').searchParams.get('state');
    act(() => {
      result.current.setConnectIframe({ contentWindow: source } as HTMLIFrameElement);
    });

    await act(async () => {
      dispatchLocksCallback(source, { type: LOCKS_CONNECT_CALLBACK_TYPE, state, code: 'one-time-code' });
    });

    await waitFor(() => expect(result.current.connectedCreator).toBe(PUBKY));
    expect(result.current.error).toBeNull();
    expect(mockedController.clearLocksFrontendSession).not.toHaveBeenCalled();
  });

  it('does not store a foreign Lock Server creator and shows the identity error', async () => {
    mockedController.createLocksFrontendSession.mockResolvedValue({
      session_token: 'session-token',
      creator: `pubky${OTHER}`,
    });
    const { result } = renderHook(() => useMarketplaceLocksConnect());
    const source = {} as WindowProxy;

    act(() => {
      result.current.openConnect();
    });
    const state = new URL(result.current.connectUrl ?? '').searchParams.get('state');
    act(() => {
      result.current.setConnectIframe({ contentWindow: source } as HTMLIFrameElement);
    });

    await act(async () => {
      dispatchLocksCallback(source, { type: LOCKS_CONNECT_CALLBACK_TYPE, state, code: 'one-time-code' });
    });

    await waitFor(() => expect(result.current.error).toBe(LOCKS_CONNECT_IDENTITY_ERROR));
    expect(result.current.connectedCreator).toBeNull();
    expect(mockedController.clearLocksFrontendSession).not.toHaveBeenCalled();
  });

  it('clears a restored blob whose Lock Server creator is not the signed-in Shop pubky', async () => {
    mockedController.restoreLocksFrontendSession.mockReturnValue({
      token: 'session-token',
      creator: `pubky${OTHER}`,
      pubky: PUBKY,
    });

    const { result } = renderHook(() => useMarketplaceLocksConnect());

    await waitFor(() => expect(mockedController.clearLocksFrontendSession).toHaveBeenCalledWith('session-token'));
    expect(result.current.connectedCreator).toBeNull();
    expect(result.current.error).toBe(LOCKS_CONNECT_IDENTITY_ERROR);
    expect(mockedController.getLocksCreatorAuthorityStatus).not.toHaveBeenCalled();
  });
});
