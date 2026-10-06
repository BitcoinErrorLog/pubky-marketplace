'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessagingMutesState } from '@/application/messaging/first-contact';
import type { MessagingConversationSummary } from '@/application/messaging/messaging';
import { getCommercePollIntervalMs } from '@/config/commerce';
import { MessagingController } from '@/controllers/messaging/messaging';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { getErrorMessage } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import { isMarkerReadError } from '@/libs/messaging/marker-read';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useMessagingStore } from '@/stores/messaging/messaging.store';
import { ownKeyRepublishedCopy } from '../useEncryptedConversation/useEncryptedConversation.utils';

export type EncryptedInboxStatus = 'loading' | 'needs-enable' | 'ready' | 'error';

export interface UseEncryptedInboxReturn {
  status: EncryptedInboxStatus;
  /** Device-local conversation list — readable even without a live session. */
  conversations: MessagingConversationSummary[];
  /** True when a receiver key exists on this device (reconnect vs first-enable copy). */
  receiverProvisioned: boolean;
  errorMessage: string | null;
  /**
   * The outcome of the latest read of the mute list. Anything but `ready`
   * or `unavailable` means nothing was received and no conversation is
   * listed until the list reads again.
   */
  mutesStatus: MessagingMutesState['kind'] | null;
  refresh: () => void;
}

/**
 * The encrypted inbox (durable modes): lists device-local conversations as
 * soon as it mounts and — while a messaging session is live — runs the
 * bounded sync pass that
 * advances pending handshakes, answers queued inbound handshakes from known
 * counterparties, and receives new messages. This surface syncs on the
 * commerce poll interval while mounted and visible, resumes on focus, and
 * stops on unmount; elsewhere `MessagingSyncCoordinator` runs the same pass
 * at a slower pace.
 *
 * Local history stays readable without a session (it is on this device); the
 * `needs-enable` status only gates live sending/receiving.
 */
export function useEncryptedInbox(): UseEncryptedInboxReturn {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const enabledPubky = useMessagingStore((state) => state.enabledPubky);
  const [status, setStatus] = useState<EncryptedInboxStatus>('loading');
  const [conversations, setConversations] = useState<MessagingConversationSummary[]>([]);
  const [receiverProvisioned, setReceiverProvisioned] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [mutesStatus, setMutesStatus] = useState<MessagingMutesState['kind'] | null>(null);
  // The receive-cap toast fires once per surface, not per sync.
  const rateCapToastShownRef = useRef(false);

  useEffect(() => {
    if (!currentUserPubky) {
      setStatus('loading');
      setConversations([]);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    let syncing = false;
    // The opening list read and the sync's reads overlap: only a read newer
    // than the last one shown replaces it.
    let listReads = 0;
    let shownRead = 0;
    // Opening or retrying the inbox retries every conversation's failed
    // attempts now; a hidden page keeps backing off.
    if (!document.hidden) MessagingController.restartInboxRetries();

    const loadConversations = async () => {
      const read = ++listReads;
      const next = await MessagingController.getConversations();
      if (cancelled || read < shownRead) return;
      shownRead = read;
      setConversations(next.conversations);
      setMutesStatus(next.mutes);
    };

    // The conversations already on this device are listed at once, before
    // the status read and the first sync pass, which can take long on a slow
    // connection. A failure here is left to the sync, which reports it.
    void loadConversations().catch((error) => {
      Logger.warn('Could not list the saved conversations before the first sync', { error });
    });

    const sync = async () => {
      if (cancelled || document.hidden || syncing) return;
      syncing = true;
      try {
        const messagingStatus = await MessagingController.getMessagingStatus();
        if (cancelled) return;
        setReceiverProvisioned(messagingStatus.receiverProvisioned);
        if (messagingStatus.ownKeyRepublished) {
          toast({ variant: 'warning', description: ownKeyRepublishedCopy(messagingStatus.ownKeyRepublished) });
        }
        if (!messagingStatus.sessionActive) {
          await loadConversations();
          if (!cancelled) setStatus('needs-enable');
          return;
        }
        const synced = await MessagingController.syncInbox();
        await loadConversations();
        if (cancelled) return;
        setStatus('ready');
        if (synced.rateLimited > 0 && !rateCapToastShownRef.current) {
          rateCapToastShownRef.current = true;
          toast({ variant: 'warning', description: MESSAGING_COPY.rateCap });
        }
      } catch (error) {
        if (cancelled) return;
        Logger.error('Encrypted inbox sync failed', { error });
        setErrorMessage(isMarkerReadError(error) ? MESSAGING_COPY.inboxSyncFailed : getErrorMessage(error));
        setStatus('error');
      } finally {
        syncing = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) return;
      MessagingController.restartInboxRetries();
      void sync();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    void sync();
    timer = window.setInterval(() => void sync(), getCommercePollIntervalMs());

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [currentUserPubky, enabledPubky, refreshNonce]);

  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), []);

  return { status, conversations, receiverProvisioned, errorMessage, mutesStatus, refresh };
}
