'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import { Logger } from '@/libs/logger/logger';
import { copyToClipboard } from '@/libs/utils/utils';
import { AUTH_FLOW_CANCELED_ERROR_NAME } from '@/services/homeserver/error.utils';
import { useAuthStore } from '@/stores/auth/auth.store';

type GrantStatus = 'idle' | 'awaiting' | 'error' | 'connected';

export function useMarketplaceInventoryGrantConnect(options: { onConnected?: () => void } = {}) {
  const [status, setStatus] = useState<GrantStatus>('idle');
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOpeningSigner, setIsOpeningSigner] = useState(false);
  const activeFlowRef = useRef<ReturnType<typeof CommerceController.beginInventorySessionConnect> | null>(null);
  const onConnectedRef = useRef(options.onConnected);

  useEffect(() => {
    onConnectedRef.current = options.onConnected;
  });

  const detach = useCallback(() => {
    const flow = activeFlowRef.current;
    activeFlowRef.current = null;
    flow?.cancel();
  }, []);

  const start = useCallback(() => {
    detach();
    const pubky = useAuthStore.getState().currentUserPubky;
    if (!pubky) {
      setStatus('error');
      setErrorMessage('Sign in first.');
      return;
    }
    let flow: ReturnType<typeof CommerceController.beginInventorySessionConnect>;
    try {
      flow = CommerceController.beginInventorySessionConnect(pubky);
    } catch (error) {
      // A thrown start leaves the dialog on "Generating QR Code" with no URL.
      // The board stays grant-needed and the canary cannot approve anything.
      Logger.error('Inventory grant flow failed', { error });
      setAuthorizationUrl('');
      setErrorMessage(error instanceof Error ? error.message : 'The inventory grant was not approved.');
      setStatus('error');
      return;
    }
    activeFlowRef.current = flow;
    setAuthorizationUrl(flow.authorizationUrl);
    setErrorMessage(null);
    setStatus('awaiting');
    flow
      .awaitSession()
      .then(() => {
        if (activeFlowRef.current !== flow) return;
        activeFlowRef.current = null;
        setAuthorizationUrl('');
        setStatus('connected');
        onConnectedRef.current?.();
      })
      .catch((error: unknown) => {
        if (activeFlowRef.current !== flow) return;
        activeFlowRef.current = null;
        if (
          typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          (error as { name?: unknown }).name === AUTH_FLOW_CANCELED_ERROR_NAME
        ) {
          setStatus('idle');
          setAuthorizationUrl('');
          return;
        }
        Logger.error('Inventory grant flow failed', { error });
        setAuthorizationUrl('');
        setErrorMessage(error instanceof Error ? error.message : 'The inventory grant was not approved.');
        setStatus('error');
      });
  }, [detach]);

  const cancel = useCallback(() => {
    detach();
    setIsOpeningSigner(false);
    setAuthorizationUrl('');
    setErrorMessage(null);
    setStatus('idle');
  }, [detach]);

  const copyAuthUrl = useCallback(async () => {
    if (!authorizationUrl) return;
    await copyToClipboard({ text: authorizationUrl });
  }, [authorizationUrl]);

  const openInSigner = useCallback(() => {
    if (!authorizationUrl) return;
    setIsOpeningSigner(true);
    window.location.href = authorizationUrl;
  }, [authorizationUrl]);

  useEffect(() => () => detach(), [detach]);

  return {
    status,
    authorizationUrl,
    errorMessage,
    isOpeningSigner,
    start,
    cancel,
    copyAuthUrl,
    openInSigner,
  };
}
