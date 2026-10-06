import type { Session } from '@synonymdev/pubky';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '@/controllers/auth/auth';
import { copyToClipboard } from '@/libs/utils/utils';
import { AUTH_FLOW_CANCELED_ERROR_NAME } from '@/services/homeserver/error.utils';
import type { TGenerateAuthUrlResult } from '@/services/homeserver/homeserver.types';
import { asOpaque } from '@/test-utils/type-assertions';
import { useStepUpReauth } from './useStepUpReauth';

vi.mock('@/controllers/auth/auth', () => ({
  AuthController: {
    getStepUpAuthUrl: vi.fn(),
    completeStepUpReauth: vi.fn(),
    // The hook routes cancellation through the controller; the mock applies
    // the same net effect (the flow is freed) so cancel assertions hold.
    releaseAuthFlow: vi.fn((cancelAuthFlow: () => void) => cancelAuthFlow()),
  },
}));

vi.mock('@/libs/utils/utils', async () => {
  const actual = await vi.importActual<typeof import('@/libs/utils/utils')>('@/libs/utils/utils');
  return { ...actual, copyToClipboard: vi.fn().mockResolvedValue(undefined) };
});

const SESSION = asOpaque<Session>({ info: { publicKey: 'test-pubky' } });

/**
 * A controllable stand-in for one single-use auth flow: the test decides
 * when the signer "approves" (resolve) or the flow fails (reject).
 */
function createDeferredFlow(url: string) {
  let resolveApproval!: (session: Session) => void;
  let rejectApproval!: (error: unknown) => void;
  const pending = new Promise<Session>((resolve, reject) => {
    resolveApproval = resolve;
    rejectApproval = reject;
  });
  const flow: TGenerateAuthUrlResult = {
    authorizationUrl: url,
    awaitApproval: pending,
    cancelAuthFlow: vi.fn(),
  };
  return { flow, resolveApproval, rejectApproval };
}

describe('useStepUpReauth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never auto-starts: mounting the hook requests no auth URL (only the explicit CTA may)', () => {
    const { result } = renderHook(() => useStepUpReauth());

    expect(result.current.status).toBe('idle');
    expect(result.current.authorizationUrl).toBe('');
    expect(result.current.errorMessage).toBeNull();
    expect(AuthController.getStepUpAuthUrl).not.toHaveBeenCalled();
  });

  it('exposes the authorization URL while awaiting and applies the widened session once the signer approves', async () => {
    const { flow, resolveApproval } = createDeferredFlow('pubkyauth:///?caps=full');
    vi.mocked(AuthController.getStepUpAuthUrl).mockResolvedValue(flow);
    vi.mocked(AuthController.completeStepUpReauth).mockResolvedValue(undefined);
    const onReauthenticated = vi.fn();
    const { result } = renderHook(() => useStepUpReauth({ onReauthenticated }));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=full');
    // The store is untouched before approval: the URL alone proves nothing.
    expect(AuthController.completeStepUpReauth).not.toHaveBeenCalled();

    resolveApproval(SESSION);
    await waitFor(() => expect(result.current.status).toBe('reauthenticated'));
    expect(AuthController.completeStepUpReauth).toHaveBeenCalledWith({ session: SESSION });
    expect(onReauthenticated).toHaveBeenCalledTimes(1);
    // The single-use URL is dead after resolution and must never be re-shown.
    expect(result.current.authorizationUrl).toBe('');
  });

  it('surfaces the real failure message and retries with a FRESH flow', async () => {
    const first = createDeferredFlow('pubkyauth:///?caps=first');
    const second = createDeferredFlow('pubkyauth:///?caps=second');
    vi.mocked(AuthController.getStepUpAuthUrl).mockResolvedValueOnce(first.flow).mockResolvedValueOnce(second.flow);
    const { result } = renderHook(() => useStepUpReauth());

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));
    first.rejectApproval(new Error('Relay timed out'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBe('Relay timed out');
    expect(result.current.authorizationUrl).toBe('');

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));
    expect(AuthController.getStepUpAuthUrl).toHaveBeenCalledTimes(2);
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=second');
  });

  it('reports an error when the flow cannot even start', async () => {
    vi.mocked(AuthController.getStepUpAuthUrl).mockRejectedValue(new Error('Failed to generate auth URL'));
    const { result } = renderHook(() => useStepUpReauth());

    act(() => result.current.start());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBe('Failed to generate auth URL');
  });

  it('surfaces a refused completion (e.g. a different identity approved) without applying it', async () => {
    const { flow, resolveApproval } = createDeferredFlow('pubkyauth:///?caps=full');
    vi.mocked(AuthController.getStepUpAuthUrl).mockResolvedValue(flow);
    vi.mocked(AuthController.completeStepUpReauth).mockRejectedValue(
      new Error('The approval was for a different identity.'),
    );
    const onReauthenticated = vi.fn();
    const { result } = renderHook(() => useStepUpReauth({ onReauthenticated }));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));
    resolveApproval(SESSION);

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBe('The approval was for a different identity.');
    expect(onReauthenticated).not.toHaveBeenCalled();
  });

  it('cancel frees the flow THROUGH the controller so a retry never joins the cancelled ceremony', async () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(AuthController.getStepUpAuthUrl).mockResolvedValue(flow);
    const { result } = renderHook(() => useStepUpReauth());

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));
    act(() => result.current.cancel());

    // releaseAuthFlow — not a raw cancelAuthFlow — is what tears down the
    // controller's ceremony guard so the retry mints a fresh URL.
    expect(AuthController.releaseAuthFlow).toHaveBeenCalledWith(flow.cancelAuthFlow);
  });

  it('cancel frees the flow, returns to idle, and drops the detached rejection silently', async () => {
    const { flow, rejectApproval } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(AuthController.getStepUpAuthUrl).mockResolvedValue(flow);
    const { result } = renderHook(() => useStepUpReauth());

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));
    act(() => result.current.cancel());
    expect(flow.cancelAuthFlow).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.authorizationUrl).toBe('');

    // The freed flow rejecting afterwards is control flow, not a failure.
    rejectApproval(new Error('flow freed'));
    await act(async () => {});
    expect(result.current.status).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
  });

  it('a cancel landing while the URL generates frees the fresh flow instead of showing its QR', async () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=late');
    let resolveStart!: (flow: TGenerateAuthUrlResult) => void;
    vi.mocked(AuthController.getStepUpAuthUrl).mockImplementation(
      () =>
        new Promise<TGenerateAuthUrlResult>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const { result } = renderHook(() => useStepUpReauth());

    act(() => result.current.start());
    expect(result.current.status).toBe('starting');
    act(() => result.current.cancel());
    await act(async () => resolveStart(flow));

    expect(flow.cancelAuthFlow).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.authorizationUrl).toBe('');
  });

  it('a superseding start cancels the previous flow and ignores its late rejection', async () => {
    const first = createDeferredFlow('pubkyauth:///?caps=first');
    const second = createDeferredFlow('pubkyauth:///?caps=second');
    vi.mocked(AuthController.getStepUpAuthUrl).mockResolvedValueOnce(first.flow).mockResolvedValueOnce(second.flow);
    const { result } = renderHook(() => useStepUpReauth());

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=second'));
    expect(first.flow.cancelAuthFlow).toHaveBeenCalledTimes(1);

    first.rejectApproval(new Error('flow freed'));
    await act(async () => {});
    expect(result.current.status).toBe('awaiting');

    vi.mocked(AuthController.completeStepUpReauth).mockResolvedValue(undefined);
    second.resolveApproval(SESSION);
    await waitFor(() => expect(result.current.status).toBe('reauthenticated'));
  });

  it('treats a controller-cancelled (superseded) flow as control flow: idle, not error', async () => {
    const { flow, rejectApproval } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(AuthController.getStepUpAuthUrl).mockResolvedValue(flow);
    const { result } = renderHook(() => useStepUpReauth());

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));

    // A second start() elsewhere frees THIS flow through the controller
    // (AuthController.cancelActiveAuthFlow in wrapAuthFlow), so the hook's
    // own active-flow reference still points at it when the SDK canceled
    // error arrives — that must not surface as a failure.
    const canceledError = new Error('Auth flow canceled');
    canceledError.name = AUTH_FLOW_CANCELED_ERROR_NAME;
    rejectApproval(canceledError);

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.authorizationUrl).toBe('');
  });

  it('ignores an approval arriving after cancellation instead of widening invisibly', async () => {
    const { flow, resolveApproval } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(AuthController.getStepUpAuthUrl).mockResolvedValue(flow);
    const onReauthenticated = vi.fn();
    const { result } = renderHook(() => useStepUpReauth({ onReauthenticated }));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));
    act(() => result.current.cancel());

    resolveApproval(SESSION);
    await act(async () => {});
    expect(result.current.status).toBe('idle');
    expect(AuthController.completeStepUpReauth).not.toHaveBeenCalled();
    expect(onReauthenticated).not.toHaveBeenCalled();
  });

  it('cancels the in-flight flow on unmount', async () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(AuthController.getStepUpAuthUrl).mockResolvedValue(flow);
    const { result, unmount } = renderHook(() => useStepUpReauth());

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));
    unmount();

    expect(flow.cancelAuthFlow).toHaveBeenCalledTimes(1);
  });

  it('copies the authorization URL only while one exists', async () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(AuthController.getStepUpAuthUrl).mockResolvedValue(flow);
    const { result } = renderHook(() => useStepUpReauth());

    await act(() => result.current.copyAuthUrl());
    expect(copyToClipboard).not.toHaveBeenCalled();

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('awaiting'));
    await act(() => result.current.copyAuthUrl());
    expect(copyToClipboard).toHaveBeenCalledWith({ text: 'pubkyauth:///?caps=first' });
  });
});
