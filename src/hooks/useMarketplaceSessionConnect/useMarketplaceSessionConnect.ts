'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isSingleApprovalSignInEnabled } from '@/config/app';
import { AuthController } from '@/controllers/auth/auth';
import { CommerceController } from '@/controllers/commerce/commerce';
import { readGrantSigner } from '@/hooks/useGrantSigner/useGrantSigner';
import { marketplaceApprovalSigner } from '@/hooks/useMarketplaceApprovalSigner/useMarketplaceApprovalSigner';
import {
  type BootstrapSignerName,
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceBootstrapFailureMessage,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import { isAppError } from '@/libs/error/error';
import { ErrorCategory } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import {
  isPassportAttemptError,
  PassportAttemptError,
  type PassportAttemptFailure,
  startPassportAttempt,
} from '@/libs/passport/passport-popup';
import {
  getMarketplaceGrantFlowEnabled,
  getPassportOrigin,
  getPassportSignInEnabled,
} from '@/libs/runtime-config/runtime-config';
import { copyToClipboard } from '@/libs/utils/utils';
import { AUTH_FLOW_CANCELED_ERROR_NAME } from '@/services/homeserver/error.utils';
import { beginMarketplaceBootstrapFlow } from '@/services/marketplace/marketplace-bootstrap-client';
import { beginMarketplaceGrantFlow, type MarketplaceGrantFlow } from '@/services/marketplace/marketplace-grant-client';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { useAuthStore } from '@/stores/auth/auth.store';
import type {
  MarketplaceSessionConnectStatus,
  UseMarketplaceSessionConnectOptions,
  UseMarketplaceSessionConnectReturn,
} from './useMarketplaceSessionConnect.types';

type ActiveFlow =
  | ReturnType<typeof CommerceController.beginMarketplaceSessionConnect>
  | ReturnType<typeof AuthController.beginBridgedCommerceSessionFlow>;

/**
 * Drives the interactive marketplace session-connect flow (durable modes
 * only): a fresh `pubkyauth://` URL for the user's signer, a pending
 * approval, cancellation, and retry. AuthToken flows are single-use, so
 * `start()` always begins a NEW flow — after an error or cancellation the
 * previous URL is dead and is never re-shown.
 *
 * Cancellation is detected by identity, not by error shape: `cancel()` and
 * `start()` first detach the current flow, so a rejection arriving from a
 * detached flow is dropped silently instead of being surfaced as a failure.
 */
/**
 * The pubky of the Shop session, grant-backed (Bitkit or Pubky Passport) or a
 * Pubky Ring cookie session. Either can write the bootstrap's homeserver proof.
 */
function signedInPubky(): string | null {
  const session = useAuthStore.getState().session;
  if (!session) return null;
  return session.info.publicKey.z32();
}

/** True when Pubky Passport approved the Shop sign-in, so it approves the purchase grant too. */
function isPassportGrantSignIn(): boolean {
  return readGrantSigner(useAuthStore.getState()) === 'passport';
}

/** Who approves the bootstrap's grant link, named in its failure copy. */
function bootstrapSignerName(): BootstrapSignerName {
  const signer = readGrantSigner(useAuthStore.getState());
  if (signer === 'passport') return 'Pubky Passport';
  if (signer === 'bitkit') return 'Bitkit';
  return 'Pubky Ring or Bitkit';
}

/** Copy for a Passport purchase approval that ended without a result. Null returns to idle silently. */
export const PASSPORT_GRANT_FAILURE_COPY: Record<PassportAttemptFailure, string | null> = {
  blocked: 'Your browser blocked the Pubky Passport window. Allow pop-ups for this site and try again.',
  busy: 'A Pubky Passport window is already open. Finish or close it, then try again.',
  cancelled: null,
  closed: null,
  failed: 'Pubky Passport could not approve the request. Try again.',
  timeout: null,
};

export function useMarketplaceSessionConnect(
  options: UseMarketplaceSessionConnectOptions = {},
): UseMarketplaceSessionConnectReturn {
  const [status, setStatus] = useState<MarketplaceSessionConnectStatus>('idle');
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOpeningRing, setIsOpeningRing] = useState(false);
  // First-paint copy must match the flow `start()` will pick: grant reconnect
  // only when a marketplace bearer already exists. AuthToken fallback clears it.
  const [requestsGrantReconnect, setRequestsGrantReconnect] = useState(
    () => getMarketplaceGrantFlowEnabled() && Boolean(MarketplaceSessionService.getActiveSession()),
  );
  const [requestsGrantBootstrap, setRequestsGrantBootstrap] = useState(
    () => getMarketplaceGrantFlowEnabled() && signedInPubky() !== null && !MarketplaceSessionService.getActiveSession(),
  );
  // A Passport approval opens a popup, which needs a click: `start()` only
  // arms it and `startPassport()` runs it.
  const requestsPassport = getMarketplaceGrantFlowEnabled() && isPassportGrantSignIn() && getPassportSignInEnabled();
  const approvalSigner = marketplaceApprovalSigner(readGrantSigner(useAuthStore.getState()));
  const activeFlowRef = useRef<ActiveFlow | null>(null);
  /** The Passport approval `start()` prepared, waiting for the user's click. */
  const passportRunRef = useRef<(() => void) | null>(null);
  const activeGrantFlowRef = useRef<MarketplaceGrantFlow | null>(null);
  const generationRef = useRef(0);
  const onConnectedRef = useRef(options.onConnected);
  const visibilityHandlerRef = useRef<(() => void) | null>(null);

  // Keep the latest callback without making `start` depend on its identity.
  useEffect(() => {
    onConnectedRef.current = options.onConnected;
  });

  const removeVisibilityHandler = useCallback(() => {
    if (visibilityHandlerRef.current) {
      document.removeEventListener('visibilitychange', visibilityHandlerRef.current);
      visibilityHandlerRef.current = null;
    }
  }, []);

  const detachActiveFlow = useCallback(() => {
    generationRef.current += 1;
    passportRunRef.current = null;
    const flow = activeFlowRef.current;
    activeFlowRef.current = null;
    const grantFlow = activeGrantFlowRef.current;
    activeGrantFlowRef.current = null;
    // Route through the controller: when this flow is still the tracked
    // active flow, the ceremony guard is torn down with it, so a retry mints
    // a FRESH single-use URL instead of joining the cancelled ceremony and
    // re-showing its dead QR. Untracked (empty-capability) flows degrade to
    // the plain cancel.
    if (flow) AuthController.releaseAuthFlow(flow.cancel);
    if (grantFlow) void grantFlow.cancel();
  }, []);

  /** Holds a Passport approval until the user clicks; the dialog shows the Passport button meanwhile. */
  const armPassport = useCallback((run: () => void) => {
    passportRunRef.current = run;
    setAuthorizationUrl('');
    setStatus('idle');
  }, []);

  /**
   * The ONE decision of which consent this dialog asks for, computed here so
   * the rendered copy and the flow `start()` actually begins can never
   * diverge (the dialog renders this value; it must not re-evaluate it).
   */
  const grantFlowEnabled = getMarketplaceGrantFlowEnabled();
  const requestsFullGrant =
    !grantFlowEnabled && isSingleApprovalSignInEnabled() && !CommerceController.hasFullHomeserverGrant();

  const start = useCallback(() => {
    detachActiveFlow();
    removeVisibilityHandler();
    setIsOpeningRing(false);
    setErrorMessage(null);

    const generation = generationRef.current;

    const startAuthTokenConnect = () => {
      setRequestsGrantReconnect(false);
      let flow: ActiveFlow;
      try {
        flow = requestsFullGrant
          ? AuthController.beginBridgedCommerceSessionFlow()
          : CommerceController.beginMarketplaceSessionConnect();
      } catch (error) {
        Logger.error('Failed to start the marketplace session flow', { error });
        setAuthorizationUrl('');
        setErrorMessage(
          marketplaceFailureMessage(marketplaceErrorCode(error), MARKETPLACE_FAILURE_MESSAGES.sessionStart),
        );
        setStatus('error');
        return;
      }

      activeFlowRef.current = flow;
      // A JOINED flow's approval lives on another surface (e.g. a sign-in in
      // progress): that surface holds the only scannable URL, so this hook
      // exposes the honest `joined` state — never `awaiting` with an empty URL
      // (a blank, un-scannable QR with Copy/Open dead). The join still settles
      // through the same awaitSession below.
      if ('joined' in flow && flow.joined) {
        setAuthorizationUrl('');
        setStatus('joined');
      } else {
        setAuthorizationUrl(flow.authorizationUrl);
        setStatus('awaiting');
      }

      flow
        .awaitSession()
        .then((session) => {
          if (activeFlowRef.current !== flow) return;
          activeFlowRef.current = null;
          setAuthorizationUrl('');
          setStatus('connected');
          onConnectedRef.current?.(session);
        })
        .catch((error: unknown) => {
          // A detached flow (cancelled or superseded) rejects as a side effect
          // of being freed — that is control flow, not a failure to report.
          if (activeFlowRef.current !== flow) return;
          activeFlowRef.current = null;
          // The CONTROLLER can also free this flow out from under the hook: a
          // sign-in ceremony or a second start() anywhere supersedes it via
          // `AuthController.cancelActiveAuthFlow`. The SDK canceled error that
          // rejection carries is control flow too — the superseded flow ends
          // idle, never error, and surfaces no toast.
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
          Logger.error('Marketplace session flow failed', { error });
          setAuthorizationUrl('');
          setErrorMessage(
            marketplaceFailureMessage(marketplaceErrorCode(error), MARKETPLACE_FAILURE_MESSAGES.sessionTimeout, error),
          );
          setStatus('error');
        });
    };

    const runGrantFlow = (
      begin: () => Promise<MarketplaceGrantFlow>,
      failureMessage: (code: string) => string,
      onSessionMissing?: () => void,
      viaPassport = false,
    ) => {
      setAuthorizationUrl('');
      setStatus('creating');
      let grantFlow: MarketplaceGrantFlow | null = null;
      const attach = async () => {
        const flow = await begin();
        if (generationRef.current !== generation) {
          await flow.cancel();
          throw new PassportAttemptError('cancelled');
        }
        grantFlow = flow;
        activeGrantFlowRef.current = flow;
        setAuthorizationUrl(flow.authorizationUrl);
        setStatus('awaiting');
        return flow;
      };
      const settled = viaPassport
        ? startPassportAttempt(
            async () => {
              const flow = await attach();
              return { authorizationUrl: flow.authorizationUrl, result: flow.awaitResult(), cancel: flow.cancel };
            },
            { passportOrigin: getPassportOrigin() },
          )
        : attach().then((flow) => flow.awaitResult());
      void settled
        .then(async (result) => {
          if (generationRef.current !== generation || activeGrantFlowRef.current !== grantFlow) return;
          activeGrantFlowRef.current = null;
          setAuthorizationUrl('');
          if (result.status === 'connected') {
            if (!result.token || !result.pubky || result.capabilities === undefined || !result.expires_at) {
              throw new Error('grant_invalid_response');
            }
            const expectedPubky = useAuthStore.getState().currentUserPubky;
            if (!expectedPubky) {
              throw new Error('grant_invalid_response');
            }
            if (result.pubky !== expectedPubky) {
              setStatus('mismatch');
              return;
            }
            let session;
            try {
              session = MarketplaceSessionService.establishClaimedGrantSession(
                {
                  token: result.token,
                  pubky: result.pubky,
                  capabilities: result.capabilities,
                  expiresAt: result.expires_at,
                },
                expectedPubky,
              );
            } catch (error) {
              if (!isAppError(error) || error.category !== ErrorCategory.Validation) throw error;
              setErrorMessage(error.message);
              setStatus('error');
              return;
            }
            CommerceController.writeMarketplaceSessionStore(session);
            setStatus('connected');
            onConnectedRef.current?.(session);
            return;
          }
          if (result.status === 'mismatch') setStatus('mismatch');
          else if (result.status === 'expired') setStatus('expired');
          else if (result.status === 'cancelled') setStatus('cancelled');
          else {
            setErrorMessage(failureMessage('approval_invalid'));
            setStatus('error');
          }
        })
        .catch((error: unknown) => {
          if (generationRef.current !== generation) return;
          activeGrantFlowRef.current = null;
          setAuthorizationUrl('');
          if (isPassportAttemptError(error)) {
            if (error.reason === 'timeout') {
              setStatus('expired');
              return;
            }
            const message = PASSPORT_GRANT_FAILURE_COPY[error.reason];
            if (!message) {
              setStatus(error.reason === 'cancelled' ? 'cancelled' : 'idle');
              return;
            }
            setErrorMessage(message);
            setStatus('error');
            return;
          }
          const code = error instanceof Error ? error.message : '';
          if ((code === 'shop_session_missing' || code === 'shop_session_expired') && onSessionMissing) {
            Logger.warn('Marketplace grant reconnect needs a session; starting a new approval', { code });
            onSessionMissing();
            return;
          }
          Logger.error('Marketplace grant flow failed', { error });
          setErrorMessage(failureMessage(code));
          setStatus('error');
        });
    };

    const viaPassport = isPassportGrantSignIn();
    if (viaPassport && !getPassportSignInEnabled()) {
      // Passport is switched off: no approval of any kind starts for this sign-in.
      setAuthorizationUrl('');
      setStatus('idle');
      return;
    }

    // With the grant flow on, every signed-in purchase approval is a
    // `signin_grant` link, which Bitkit and Pubky Ring 2.0+ both approve.
    // Bitkit rejects the Ring AuthToken link, so no Shop session falls back to
    // it. The browser bootstrap needs only a session that can write its own
    // homeserver (the proof document), so it serves Ring cookie sessions too.
    const bootstrapPubky = signedInPubky();
    const runBootstrap = (pubky: string) => {
      setRequestsGrantReconnect(false);
      setRequestsGrantBootstrap(true);
      runGrantFlow(
        () => beginMarketplaceBootstrapFlow({ pubky }),
        (code) => marketplaceBootstrapFailureMessage(code, bootstrapSignerName()),
        undefined,
        viaPassport,
      );
    };
    if (grantFlowEnabled && bootstrapPubky && !MarketplaceSessionService.getActiveSession()) {
      setRequestsGrantReconnect(false);
      setRequestsGrantBootstrap(true);
      if (viaPassport) {
        armPassport(() => runBootstrap(bootstrapPubky));
        return;
      }
      runBootstrap(bootstrapPubky);
      return;
    }

    // Reconnect grant cannot mint a first session: BFF createFlow requires a
    // paired cookie. When the BFF has none, the bootstrap mints the session
    // instead of opening a grant that 401s locally as "expired". A Passport
    // reconnect needs a fresh click for the bootstrap popup, so it ends with
    // the failure copy instead.
    if (grantFlowEnabled && MarketplaceSessionService.getActiveSession()) {
      setRequestsGrantBootstrap(false);
      setRequestsGrantReconnect(true);
      const onSessionMissing = viaPassport
        ? undefined
        : bootstrapPubky
          ? () => runBootstrap(bootstrapPubky)
          : startAuthTokenConnect;
      const runReconnect = () =>
        runGrantFlow(
          beginMarketplaceGrantFlow,
          (code) => marketplaceFailureMessage(code, MARKETPLACE_FAILURE_MESSAGES.sessionStart),
          onSessionMissing,
          viaPassport,
        );
      if (viaPassport) {
        armPassport(runReconnect);
        return;
      }
      runReconnect();
      return;
    }

    startAuthTokenConnect();
  }, [armPassport, detachActiveFlow, grantFlowEnabled, removeVisibilityHandler, requestsFullGrant]);

  /**
   * Runs the armed Pubky Passport approval. Call it from the click handler
   * itself: the popup must open before any await.
   */
  const startPassport = useCallback(() => {
    const run = passportRunRef.current;
    if (!run) return;
    passportRunRef.current = null;
    setErrorMessage(null);
    run();
  }, []);

  const cancel = useCallback(() => {
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
      // Unmount cancels outright: unlike sign-in, nothing global consumes the
      // approval — without a mounted dialog the session would connect
      // invisibly, and the single-use flow is cheap to restart.
      detachActiveFlow();
      removeVisibilityHandler();
    };
  }, [detachActiveFlow, removeVisibilityHandler]);

  return {
    status,
    authorizationUrl,
    errorMessage,
    requestsFullGrant,
    requestsGrantReconnect,
    requestsGrantBootstrap,
    requestsPassport,
    approvalSigner,
    start,
    startPassport,
    cancel,
    copyAuthUrl,
    openInRing,
    isOpeningRing,
  };
}
