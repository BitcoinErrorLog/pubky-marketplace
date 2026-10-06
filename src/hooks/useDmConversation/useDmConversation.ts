'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MessagingThreadState } from '@/application/messaging/messaging';
import { getCommercePollIntervalMs } from '@/config/commerce';
import { MessagingController } from '@/controllers/messaging/messaging';
import { bodyByteSize } from '@/libs/commerce/messaging-contracts';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { getErrorMessage } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import { buildDmConversationId, dmBodyBudget } from '@/libs/messaging/dm-contracts';
import { isMarkerReadError } from '@/libs/messaging/marker-read';
import { toast } from '@/molecules/Toaster/use-toast';
import { useMessagingStore } from '@/stores/messaging/messaging.store';
import type {
  ConversationThreadItem,
  EncryptedConversationKeyChange,
  EncryptedSendOutcome,
  UseEncryptedConversationReturn,
} from '../useEncryptedConversation/useEncryptedConversation.types';
import {
  encryptedConversationStatusOf,
  keyChangeOf,
  ownKeyRepublishedCopy,
} from '../useEncryptedConversation/useEncryptedConversation.utils';

/**
 * Drives one general direct-message conversation while its surface is OPEN.
 * Same shape and same truthful states as the marketplace's
 * `useEncryptedConversation` — the two ride the same Encrypted Link per
 * counterparty; only the message kind and the conversation identity differ
 * (a DM conversation is keyed by the counterparty pubky, no listing).
 *
 * While the handshake is pending the composer is NOT blocked: sends queue
 * device-locally (rendered honestly as "Queued", never as sent) and deliver
 * automatically the moment the link becomes ready.
 *
 * Polling is bounded and abortable by construction — it runs only while
 * `active` is true AND the page is visible, resumes on focus, and stops on
 * unmount; away from it, `MessagingSyncCoordinator` advances the link and
 * flushes queued rows. While the surface shows messages
 * it also moves the device-local read checkpoint, keeping the unread badge
 * honest.
 */
export function useDmConversation(counterpartyPubky: string, active: boolean): UseEncryptedConversationReturn {
  const enabledPubky = useMessagingStore((state) => state.enabledPubky);
  const [status, setStatus] = useState<UseEncryptedConversationReturn['status']>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [thread, setThread] = useState<ConversationThreadItem[]>([]);
  const [receiverProvisioned, setReceiverProvisioned] = useState(false);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [pausedReason, setPausedReason] = useState<UseEncryptedConversationReturn['pausedReason']>(null);
  const [keyChange, setKeyChange] = useState<EncryptedConversationKeyChange | null>(null);
  const [isAcceptingKey, setIsAcceptingKey] = useState(false);
  // The "your message is queued" toast fires once per surface, not per send.
  const queuedToastShownRef = useRef(false);
  const rateCapToastShownRef = useRef(false);

  const conversationId = useMemo(() => buildDmConversationId(counterpartyPubky), [counterpartyPubky]);
  // The DM envelope has no variable-width fields outside the body, so the
  // budget is a stable constant.
  const bodyBudgetBytes = useMemo(() => dmBodyBudget(), []);
  const draftBytes = useMemo(() => bodyByteSize(draft.trim()), [draft]);

  const applyThreadState = useCallback((state: MessagingThreadState) => {
    setPausedReason(state.status === 'paused' ? state.reason : null);
    setKeyChange(keyChangeOf(state));
    setStatus(encryptedConversationStatusOf(state));
  }, []);

  const loadThread = useCallback(async () => {
    try {
      const [history, queued] = await Promise.all([
        MessagingController.getConversationMessages(conversationId),
        MessagingController.getQueuedConversationMessages(conversationId),
      ]);
      setThread([
        ...history.map((message) => ({ deliveryState: 'sent' as const, message })),
        ...queued.map((row) => ({ deliveryState: 'queued' as const, queued: row })),
      ]);
      if (history.length > 0) {
        // The surface is open and showing these rows: advance the read checkpoint.
        await MessagingController.markConversationRead(conversationId);
      }
    } catch (error) {
      Logger.warn('Failed to load local DM history', { error });
    }
  }, [conversationId]);

  useEffect(() => {
    if (!active) return;
    // Opening or retrying the conversation retries its failed attempts now;
    // a hidden page keeps backing off.
    if (!document.hidden) MessagingController.restartDmConversationRetries(counterpartyPubky);

    let cancelled = false;
    let timer: number | null = null;
    // False until the thread opened on a confirmed mute list; while paused,
    // each poll retries the open instead of polling.
    let opened = false;

    const applyLinkState = (state: MessagingThreadState) => {
      if (cancelled) return;
      applyThreadState(state);
    };

    const poll = async () => {
      if (cancelled || document.hidden) return;
      if (!opened) {
        await open();
        return;
      }
      try {
        const { state, received, flushed, rateLimited } =
          await MessagingController.pollDmConversation(counterpartyPubky);
        applyLinkState(state);
        if (rateLimited > 0 && !rateCapToastShownRef.current) {
          rateCapToastShownRef.current = true;
          toast({ variant: 'warning', description: MESSAGING_COPY.rateCap });
        }
        // A flush turned queued rows into real sent history — reload so the
        // queued bubbles are replaced by their sent records.
        if (received.length > 0 || flushed > 0) await loadThread();
      } catch (error) {
        if (cancelled) return;
        Logger.error('DM conversation poll failed', { error });
        setErrorMessage(isMarkerReadError(error) ? MESSAGING_COPY.counterpartyUnreachable : getErrorMessage(error));
        setStatus('error');
      }
    };

    const open = async () => {
      const result = await MessagingController.openDmConversation(counterpartyPubky);
      applyLinkState(result.state);
      if (result.state.status === 'muted' || result.state.status === 'paused') return;
      opened = true;
      // Opening flushes queued rows when the link is ready — show the result.
      if (result.state.status === 'ready') await loadThread();
    };

    const begin = async () => {
      setStatus('loading');
      setErrorMessage(null);
      await loadThread();
      try {
        const messagingStatus = await MessagingController.getMessagingStatus();
        if (cancelled) return;
        setReceiverProvisioned(messagingStatus.receiverProvisioned);
        if (messagingStatus.ownKeyRepublished) {
          toast({ variant: 'warning', description: ownKeyRepublishedCopy(messagingStatus.ownKeyRepublished) });
        }
        if (!messagingStatus.sessionActive) {
          setStatus('needs-enable');
          return;
        }
        await open();
      } catch (error) {
        if (cancelled) return;
        Logger.error('Failed to open the DM conversation', { error });
        setErrorMessage(isMarkerReadError(error) ? MESSAGING_COPY.counterpartyUnreachable : getErrorMessage(error));
        setStatus('error');
        return;
      }
      // Poll only while this surface stays open and visible; a hidden tab
      // pauses (the visibility listener resumes it on focus).
      timer = window.setInterval(() => void poll(), getCommercePollIntervalMs());
    };

    const onVisibilityChange = () => {
      if (document.hidden) return;
      MessagingController.restartDmConversationRetries(counterpartyPubky);
      void poll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    void begin();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [active, enabledPubky, refreshNonce, counterpartyPubky, loadThread, applyThreadState]);

  const send = useCallback(async (): Promise<EncryptedSendOutcome> => {
    const body = draft.trim();
    if (!body || isSending) return 'failed';
    if (draftBytes > bodyBudgetBytes) {
      setSendError(`Message is ${draftBytes - bodyBudgetBytes} bytes over the encrypted transport limit.`);
      return 'failed';
    }
    setIsSending(true);
    setSendError(null);
    try {
      const outcome = await MessagingController.sendOrQueueDmMessage(counterpartyPubky, body);
      setDraft('');
      await loadThread();
      if (!outcome.delivered && !queuedToastShownRef.current) {
        queuedToastShownRef.current = true;
        toast({ description: MESSAGING_COPY.queuedToast });
      }
      return outcome.delivered ? 'delivered' : 'queued';
    } catch (error) {
      Logger.error('Failed to send a direct message', { error });
      // The draft is kept: a failed send loses nothing the user typed.
      setSendError(getErrorMessage(error));
      return 'failed';
    } finally {
      setIsSending(false);
    }
  }, [draft, isSending, draftBytes, bodyBudgetBytes, counterpartyPubky, loadThread]);

  const cancelQueued = useCallback(
    async (id: string) => {
      try {
        await MessagingController.cancelQueuedMessage(id);
        await loadThread();
      } catch (error) {
        Logger.warn('Failed to cancel a queued message', { error });
      }
    },
    [loadThread],
  );

  const acceptKeyChange = useCallback(async () => {
    if (!keyChange || isAcceptingKey) return;
    setIsAcceptingKey(true);
    try {
      const state = await MessagingController.acceptCounterpartyKey(counterpartyPubky, keyChange.observedKey);
      applyThreadState(state);
      await loadThread();
      if (state.status !== 'key-changed') toast({ description: MESSAGING_COPY.keyAccepted });
    } catch (error) {
      Logger.error('Failed to accept a changed messaging key', { error });
      toast({ variant: 'warning', description: MESSAGING_COPY.keyAcceptFailed });
    } finally {
      setIsAcceptingKey(false);
    }
  }, [keyChange, isAcceptingKey, counterpartyPubky, applyThreadState, loadThread]);

  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), []);

  return {
    status,
    errorMessage,
    thread,
    receiverProvisioned,
    draft,
    setDraft,
    bodyBudgetBytes,
    draftBytes,
    isSending,
    sendError,
    send,
    cancelQueued,
    refresh,
    pausedReason,
    keyChange,
    acceptKeyChange,
    isAcceptingKey,
  };
}
