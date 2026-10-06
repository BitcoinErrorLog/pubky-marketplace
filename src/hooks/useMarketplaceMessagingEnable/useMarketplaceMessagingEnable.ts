'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessagingController } from '@/controllers/messaging/messaging';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import { Logger } from '@/libs/logger/logger';
import { copyToClipboard } from '@/libs/utils/utils';
import { useMessagingStore } from '@/stores/messaging/messaging.store';
import type {
  MarketplaceMessagingEnableStatus,
  UseMarketplaceMessagingEnableOptions,
  UseMarketplaceMessagingEnableReturn,
} from './useMarketplaceMessagingEnable.types';

type ActiveFlow = Awaited<ReturnType<typeof MessagingController.beginMessagingEnable>>;

/**
 * Drives the interactive "enable encrypted messaging" flow (durable modes
 * only): a fresh `pubkyauth://` URL for the `/pub/paykit/:rw` grant, pending
 * signer approval, cancellation, and retry. Mirrors
 * `useMarketplaceSessionConnect` — messaging is its OWN Ring approval, never
 * the transaction-service session.
 *
 * Cancellation is detected by identity: `cancel()` and `start()` first detach
 * the current flow, so a rejection arriving from a detached flow is dropped
 * silently instead of being surfaced as a failure.
 */
export function useMarketplaceMessagingEnable(
  options: UseMarketplaceMessagingEnableOptions = {},
): UseMarketplaceMessagingEnableReturn {
  const [status, setStatus] = useState<MarketplaceMessagingEnableStatus>('idle');
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOpeningRing, setIsOpeningRing] = useState(false);
  // True when this boot's at-rest wrap sweep failed: enabling on top of
  // degraded storage protection is refused until a later boot heals it.
  const messagingAtRestDegraded = useMessagingStore((state) => state.messagingAtRestDegraded);
  const activeFlowRef = useRef<ActiveFlow | null>(null);
  const onEnabledRef = useRef(options.onEnabled);
  const visibilityHandlerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onEnabledRef.current = options.onEnabled;
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
    if (flow) flow.cancel();
  }, []);

  const start = useCallback(() => {
    detachActiveFlow();
    removeVisibilityHandler();
    setIsOpeningRing(false);
    setErrorMessage(null);
    if (messagingAtRestDegraded) {
      // The boot wrap sweep could not protect messaging key material at
      // rest (legacy plaintext rows may remain). Pause instead of enabling
      // on top of degraded storage protection; a later boot retries the
      // sweep and clears the flag.
      setAuthorizationUrl('');
      setErrorMessage(MARKETPLACE_FAILURE_MESSAGES.messagingStorage);
      setStatus('error');
      return;
    }
    setStatus('awaiting');
    setAuthorizationUrl('');

    let cancelled = false;
    const begin = async () => {
      const flow = await MessagingController.beginMessagingEnable();
      if (cancelled) {
        flow.cancel();
        return;
      }
      activeFlowRef.current = flow;
      setAuthorizationUrl(flow.authorizationUrl);

      try {
        const enabled = await flow.awaitEnabled();
        if (activeFlowRef.current !== flow) return;
        activeFlowRef.current = null;
        setAuthorizationUrl('');
        setStatus('enabled');
        onEnabledRef.current?.(enabled);
      } catch (error) {
        // A detached flow (cancelled or superseded) rejects as a side effect
        // of being freed — that is control flow, not a failure to report.
        if (activeFlowRef.current !== flow) return;
        activeFlowRef.current = null;
        Logger.error('Messaging enable flow failed', { error });
        setAuthorizationUrl('');
        setErrorMessage(
          marketplaceFailureMessage(marketplaceErrorCode(error), 'Marketplace messaging could not be enabled.'),
        );
        setStatus('error');
      }
    };

    begin().catch((error: unknown) => {
      Logger.error('Failed to start the messaging enable flow', { error });
      setAuthorizationUrl('');
      setErrorMessage(
        marketplaceFailureMessage(marketplaceErrorCode(error), MARKETPLACE_FAILURE_MESSAGES.messagingStart, error),
      );
      setStatus('error');
    });

    return () => {
      cancelled = true;
    };
  }, [detachActiveFlow, removeVisibilityHandler, messagingAtRestDegraded]);

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
      // Unmount cancels outright: without a mounted dialog the grant would be
      // approved invisibly, and the flow is cheap to restart.
      detachActiveFlow();
      removeVisibilityHandler();
    };
  }, [detachActiveFlow, removeVisibilityHandler]);

  return { status, authorizationUrl, errorMessage, start, cancel, copyAuthUrl, openInRing, isOpeningRing };
}
