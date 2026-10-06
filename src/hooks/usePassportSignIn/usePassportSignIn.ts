'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthController } from '@/controllers/auth/auth';
import { getWrongEnvironmentHomeserverMessage, isWrongEnvironmentHomeserverError } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import {
  isPassportAttemptError,
  type PassportAttemptFailure,
  passportCallbacks,
  startPassportAttempt,
} from '@/libs/passport/passport-popup';
import { getPassportOrigin, getPassportSignInEnabled } from '@/libs/runtime-config/runtime-config';
import { toast } from '@/molecules/Toaster/use-toast';
import { AUTH_FLOW_CANCELED_ERROR_NAME } from '@/services/homeserver/error.utils';

/** What the user reads when a Passport attempt ends without a session; null ends it silently. */
export const PASSPORT_ATTEMPT_FAILURE_COPY: Record<PassportAttemptFailure, string | null> = {
  blocked: 'Your browser blocked the Pubky Passport window. Allow pop-ups for this site and try again.',
  busy: null,
  cancelled: null,
  closed: null,
  failed: 'Pubky Passport could not approve the request. Try again.',
  timeout: 'Pubky Passport took too long to answer. Try again.',
};

const isAuthFlowCanceled = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { name?: unknown }).name === AUTH_FLOW_CANCELED_ERROR_NAME;

/**
 * "Continue with Google": a Shop grant sign-in approved in the Pubky Passport
 * popup. Passport signs a new Google user up and approves the same grant
 * Bitkit approves; the session arrives through the relay and completes like
 * a Bitkit sign-in.
 */
export function usePassportSignIn() {
  const [isAvailable, setIsAvailable] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const isMountedRef = useRef(true);
  const isPendingRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    setIsAvailable(getPassportSignInEnabled() && AuthController.isGrantSignInAvailable());
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /** Call from the click handler itself: the popup must open before any await. */
  const start = useCallback(() => {
    if (isPendingRef.current) return;
    isPendingRef.current = true;
    setIsPending(true);
    startPassportAttempt(
      async () => {
        const { authorizationUrl, awaitApproval, cancelAuthFlow } = await AuthController.getPassportGrantAuthUrl(
          passportCallbacks(window.location.origin),
        );
        return { authorizationUrl, result: awaitApproval, cancel: cancelAuthFlow };
      },
      { passportOrigin: getPassportOrigin() },
    )
      // No mounted guard: the session init updates global stores and must run
      // even if the sign-in surface unmounted while Passport was open.
      .then((session) => AuthController.initializeAuthenticatedSession({ session }))
      .catch((error: unknown) => {
        if (isAuthFlowCanceled(error)) return;
        if (isPassportAttemptError(error)) {
          const description = PASSPORT_ATTEMPT_FAILURE_COPY[error.reason];
          if (description) toast({ variant: 'error', description });
          return;
        }
        if (isWrongEnvironmentHomeserverError(error)) {
          toast({ variant: 'error', description: getWrongEnvironmentHomeserverMessage() });
          return;
        }
        Logger.error('Pubky Passport sign-in failed', { error });
        toast({ variant: 'error', description: 'Sign in failed. Try again.' });
      })
      .finally(() => {
        isPendingRef.current = false;
        if (isMountedRef.current) setIsPending(false);
      });
  }, []);

  return { isAvailable, isPending, start };
}
