'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthController } from '@/controllers/auth/auth';
import { getErrorMessage } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import { copyToClipboard } from '@/libs/utils/utils';
import { AUTH_FLOW_CANCELED_ERROR_NAME } from '@/services/homeserver/error.utils';
import type { TGenerateAuthUrlResult } from '@/services/homeserver/homeserver.types';
import type { StepUpReauthStatus, UseStepUpReauthOptions, UseStepUpReauthReturn } from './useStepUpReauth.types';

type ActiveFlow = TGenerateAuthUrlResult;

/**
 * Drives the step-up re-approval that widens a narrow (bridged or legacy)
 * session grant to the app's full `CAPABILITIES`
 * (docs/ecommerce/step-up-approval.md, Option C). Shared by every
 * scope-gated affordance (watchlist sync, portable receipts).
 *
 * NEVER auto-started: `start()` runs only from the explicit reconnect CTA —
 * a bridged restore, browsing, publishing, and checkout must not trigger a
 * widened-grant approval on their own.
 *
 * Mirrors useMarketplaceSessionConnect's lifecycle: a fresh single-use
 * `pubkyauth://` URL per attempt, cancellation detected by identity (a
 * rejection from a detached flow is control flow, not a failure), and the
 * flow is freed on unmount. On approval the controller swaps the auth-store
 * session for the widened one, so watchlist sync, receipts, and messaging
 * cookie-resume become capable without a reload.
 */
export function useStepUpReauth(options: UseStepUpReauthOptions = {}): UseStepUpReauthReturn {
  const [status, setStatus] = useState<StepUpReauthStatus>('idle');
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOpeningRing, setIsOpeningRing] = useState(false);
  const activeFlowRef = useRef<ActiveFlow | null>(null);
  const startGenerationRef = useRef(0);
  const onReauthenticatedRef = useRef(options.onReauthenticated);
  const visibilityHandlerRef = useRef<(() => void) | null>(null);

  // Keep the latest callback without making `start` depend on its identity.
  useEffect(() => {
    onReauthenticatedRef.current = options.onReauthenticated;
  });

  const removeVisibilityHandler = useCallback(() => {
    if (visibilityHandlerRef.current) {
      document.removeEventListener('visibilitychange', visibilityHandlerRef.current);
      visibilityHandlerRef.current = null;
    }
  }, []);

  const detachActiveFlow = useCallback(() => {
    const flow = activeFlowRef.current;
    activeFlowRef.current = null;
    // Route through the controller: when this flow is still the tracked
    // active flow, the ceremony guard is torn down with it, so a retry mints
    // a FRESH single-use URL instead of joining the cancelled ceremony and
    // re-showing its dead QR. When another flow already superseded this one,
    // only this stale handle is freed.
    if (flow) AuthController.releaseAuthFlow(flow.cancelAuthFlow);
  }, []);

  const start = useCallback(() => {
    detachActiveFlow();
    removeVisibilityHandler();
    setIsOpeningRing(false);
    setErrorMessage(null);
    setAuthorizationUrl('');
    setStatus('starting');
    // Invalidates a cancel/supersede that lands while the URL generates.
    const generation = ++startGenerationRef.current;

    void (async () => {
      let flow: ActiveFlow;
      try {
        flow = await AuthController.getStepUpAuthUrl();
      } catch (error) {
        if (startGenerationRef.current !== generation) return;
        Logger.error('Failed to start the step-up re-approval flow', { error });
        setErrorMessage(getErrorMessage(error));
        setStatus('error');
        return;
      }

      // Cancelled or superseded while the URL was generating: free the fresh
      // single-use flow instead of showing its QR.
      if (startGenerationRef.current !== generation) {
        flow.cancelAuthFlow();
        return;
      }

      activeFlowRef.current = flow;
      setAuthorizationUrl(flow.authorizationUrl);
      setStatus('awaiting');

      flow.awaitApproval
        .then(async (session) => {
          if (activeFlowRef.current !== flow) return;
          try {
            await AuthController.completeStepUpReauth({ session });
          } catch (error) {
            if (activeFlowRef.current !== flow) return;
            activeFlowRef.current = null;
            Logger.error('Step-up re-approval could not be applied', { error });
            setAuthorizationUrl('');
            setErrorMessage(getErrorMessage(error));
            setStatus('error');
            return;
          }
          activeFlowRef.current = null;
          setAuthorizationUrl('');
          setStatus('reauthenticated');
          try {
            await onReauthenticatedRef.current?.();
          } catch (error) {
            Logger.warn('Post-re-authentication refresh failed', { error });
          }
        })
        .catch((error: unknown) => {
          // A detached flow (cancelled or superseded) rejects as a side effect
          // of being freed — that is control flow, not a failure to report.
          if (activeFlowRef.current !== flow) return;
          activeFlowRef.current = null;
          // The CONTROLLER can also free this flow out from under the hook:
          // a second start() anywhere supersedes it via
          // `AuthController.cancelActiveAuthFlow` (wrapAuthFlow). The SDK
          // canceled error that rejection carries is control flow too — the
          // superseded flow ends idle, never error, and surfaces no toast.
          if (
            typeof error === 'object' &&
            error !== null &&
            'name' in error &&
            (error as { name?: unknown }).name === AUTH_FLOW_CANCELED_ERROR_NAME
          ) {
            setAuthorizationUrl('');
            setStatus('idle');
            return;
          }
          Logger.error('Step-up re-approval flow failed', { error });
          setAuthorizationUrl('');
          setErrorMessage(getErrorMessage(error));
          setStatus('error');
        });
    })();
  }, [detachActiveFlow, removeVisibilityHandler]);

  const cancel = useCallback(() => {
    startGenerationRef.current += 1;
    detachActiveFlow();
    removeVisibilityHandler();
    setIsOpeningRing(false);
    setAuthorizationUrl('');
    setErrorMessage(null);
    setStatus('idle');
  }, [detachActiveFlow, removeVisibilityHandler]);

  const copyAuthUrl = useCallback(async () => {
    if (!authorizationUrl) return;
    await copyToClipboard({ text: authorizationUrl });
  }, [authorizationUrl]);

  const openInRing = useCallback(() => {
    if (!authorizationUrl) return;
    removeVisibilityHandler();
    setIsOpeningRing(true);
    const onVisibilityChange = () => {
      if (document.hidden) {
        removeVisibilityHandler();
        setIsOpeningRing(false);
      }
    };
    visibilityHandlerRef.current = onVisibilityChange;
    document.addEventListener('visibilitychange', onVisibilityChange, { once: true });
    window.location.href = authorizationUrl;
  }, [authorizationUrl, removeVisibilityHandler]);

  useEffect(() => {
    return () => {
      // Unmount cancels outright (same tradeoff as the marketplace session
      // connect): without a mounted affordance the widening would complete
      // invisibly, and the single-use flow is cheap to restart.
      startGenerationRef.current += 1;
      detachActiveFlow();
      removeVisibilityHandler();
    };
  }, [detachActiveFlow, removeVisibilityHandler]);

  return { status, authorizationUrl, errorMessage, start, cancel, copyAuthUrl, openInRing, isOpeningRing };
}
