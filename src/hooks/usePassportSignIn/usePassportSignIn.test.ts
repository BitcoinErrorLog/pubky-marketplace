import type { Session } from '@synonymdev/pubky';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { type PassportApproval, PassportAttemptError } from '@/libs/passport/passport-popup';
import { AUTH_FLOW_CANCELED_ERROR_NAME } from '@/services/homeserver/error.utils';
import { asOpaque } from '@/test-utils/type-assertions';
import { PASSPORT_ATTEMPT_FAILURE_COPY, usePassportSignIn } from './usePassportSignIn';

const mocks = vi.hoisted(() => ({
  getPassportGrantAuthUrl: vi.fn(),
  initializeAuthenticatedSession: vi.fn(),
  isGrantSignInAvailable: vi.fn(() => true),
  passportSignIn: true,
  attempt: null as null | ((begin: () => Promise<PassportApproval<unknown>>) => Promise<unknown>),
  startPassportAttempt: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/controllers/auth/auth', () => ({
  AuthController: {
    getPassportGrantAuthUrl: mocks.getPassportGrantAuthUrl,
    initializeAuthenticatedSession: mocks.initializeAuthenticatedSession,
    isGrantSignInAvailable: mocks.isGrantSignInAvailable,
  },
}));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>()),
  getPassportSignInEnabled: () => mocks.passportSignIn,
  getPassportOrigin: () => 'https://passport.staging.pubky.app',
}));

vi.mock('@/libs/passport/passport-popup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/passport/passport-popup')>();
  return { ...actual, startPassportAttempt: mocks.startPassportAttempt };
});

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: mocks.toast }));

const session = asOpaque<Session>({ info: { publicKey: { z32: () => 'pubky' } }, grant: {} });

describe('usePassportSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.passportSignIn = true;
    mocks.isGrantSignInAvailable.mockReturnValue(true);
    mocks.initializeAuthenticatedSession.mockResolvedValue(undefined);
  });

  it('is available only with a holdable grant key and Passport switched on', () => {
    expect(renderHook(() => usePassportSignIn()).result.current.isAvailable).toBe(true);

    mocks.passportSignIn = false;
    expect(renderHook(() => usePassportSignIn()).result.current.isAvailable).toBe(false);

    mocks.passportSignIn = true;
    mocks.isGrantSignInAvailable.mockReturnValue(false);
    expect(renderHook(() => usePassportSignIn()).result.current.isAvailable).toBe(false);
  });

  it('runs the Shop grant ceremony inside the Passport attempt and initializes the approved session', async () => {
    const awaitApproval = Promise.resolve(session);
    const cancelAuthFlow = vi.fn();
    mocks.getPassportGrantAuthUrl.mockResolvedValue({
      authorizationUrl: 'pubkyauth://signin_grant?caps=x',
      awaitApproval,
      cancelAuthFlow,
    });
    mocks.startPassportAttempt.mockImplementation(async (begin: () => Promise<PassportApproval<Session>>) => {
      const approval = await begin();
      expect(approval).toEqual({
        authorizationUrl: 'pubkyauth://signin_grant?caps=x',
        result: awaitApproval,
        cancel: cancelAuthFlow,
      });
      return await approval.result;
    });

    const { result } = renderHook(() => usePassportSignIn());
    act(() => result.current.start());

    expect(result.current.isPending).toBe(true);
    expect(mocks.startPassportAttempt).toHaveBeenCalledWith(expect.any(Function), {
      passportOrigin: 'https://passport.staging.pubky.app',
    });
    await waitFor(() => expect(mocks.initializeAuthenticatedSession).toHaveBeenCalledWith({ session }));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    // jsdom serves http://localhost, so no callbacks (Passport accepts HTTPS callbacks only).
    expect(mocks.getPassportGrantAuthUrl).toHaveBeenCalledWith(undefined);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('ignores a second click while an attempt is pending', () => {
    mocks.startPassportAttempt.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => usePassportSignIn());

    act(() => result.current.start());
    act(() => result.current.start());

    expect(mocks.startPassportAttempt).toHaveBeenCalledTimes(1);
  });

  it.each(['blocked', 'busy', 'cancelled', 'closed', 'failed', 'timeout'] as const)(
    'a %s attempt never initializes a session and shows its own copy',
    async (reason) => {
      mocks.startPassportAttempt.mockRejectedValue(new PassportAttemptError(reason));
      const { result } = renderHook(() => usePassportSignIn());

      act(() => result.current.start());
      await waitFor(() => expect(result.current.isPending).toBe(false));

      expect(mocks.initializeAuthenticatedSession).not.toHaveBeenCalled();
      const copy = PASSPORT_ATTEMPT_FAILURE_COPY[reason];
      if (copy) expect(mocks.toast).toHaveBeenCalledWith({ variant: 'error', description: copy });
      else expect(mocks.toast).not.toHaveBeenCalled();
    },
  );

  it('an approval that lost to another sign-in ends silently', async () => {
    mocks.startPassportAttempt.mockRejectedValue(
      Object.assign(new Error('canceled'), { name: AUTH_FLOW_CANCELED_ERROR_NAME }),
    );
    const { result } = renderHook(() => usePassportSignIn());

    act(() => result.current.start());
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('a key from another environment gets the wrong-environment copy', async () => {
    mocks.startPassportAttempt.mockResolvedValue(session);
    mocks.initializeAuthenticatedSession.mockRejectedValue(
      new AppError({
        category: ErrorCategory.Auth,
        code: AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER,
        message: 'wrong homeserver',
        service: ErrorService.Homeserver,
        operation: 'assertUserHomeserverAllowed',
      }),
    );
    const { result } = renderHook(() => usePassportSignIn());

    act(() => result.current.start());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());

    expect(mocks.toast).toHaveBeenCalledWith({
      variant: 'error',
      description: expect.stringContaining('linked to a different homeserver'),
    });
  });
});
