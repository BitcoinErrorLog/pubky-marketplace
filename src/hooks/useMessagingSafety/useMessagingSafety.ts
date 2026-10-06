'use client';

import { useState } from 'react';
import { MessagingController } from '@/controllers/messaging/messaging';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { Logger } from '@/libs/logger/logger';
import { toast } from '@/molecules/Toaster/use-toast';
import type { UseMessagingSafetyReturn } from './useMessagingSafety.types';

/**
 * The person-level controls of a conversation: mute and unmute (saved in the
 * account's private mute list), accept a request into the inbox, and copy
 * report details to the clipboard. Each action tells the user what happened
 * and resolves `true` only when it took effect.
 */
export function useMessagingSafety(): UseMessagingSafetyReturn {
  const [isPending, setIsPending] = useState(false);

  const setMuted = async (counterpartyPubky: string, muted: boolean): Promise<boolean> => {
    setIsPending(true);
    try {
      const state = await MessagingController.setCounterpartyMuted(counterpartyPubky, muted);
      if (state.kind === 'ready') {
        toast({ description: muted ? MESSAGING_COPY.muted : MESSAGING_COPY.unmuted });
        return true;
      }
      const approval = state.kind === 'needs_approval' || state.kind === 'needs_reauth';
      toast({
        variant: approval ? 'warning' : 'error',
        description: approval
          ? MESSAGING_COPY.muteNeedsApproval
          : state.kind === 'full'
            ? MESSAGING_COPY.muteListFull
            : MESSAGING_COPY.muteFailed,
      });
      return false;
    } catch {
      Logger.warn('Could not change a messaging mute', { reason: 'mute_change_failed' });
      toast({ variant: 'error', description: MESSAGING_COPY.muteFailed });
      return false;
    } finally {
      setIsPending(false);
    }
  };

  const accept = async (counterpartyPubky: string): Promise<boolean> => {
    setIsPending(true);
    try {
      await MessagingController.acceptRequest(counterpartyPubky);
      toast({ description: MESSAGING_COPY.requestAccepted });
      return true;
    } catch {
      Logger.warn('Could not accept a message request', { reason: 'request_accept_failed' });
      return false;
    } finally {
      setIsPending(false);
    }
  };

  const report = async (conversationId: string): Promise<boolean> => {
    try {
      const details = await MessagingController.getReportDetails(conversationId);
      await navigator.clipboard.writeText(details);
      toast({ description: MESSAGING_COPY.reportCopied });
      return true;
    } catch {
      Logger.warn('Could not copy report details', { reason: 'report_copy_failed' });
      toast({ variant: 'error', description: MESSAGING_COPY.reportFailed });
      return false;
    }
  };

  return {
    isPending,
    mute: (counterpartyPubky) => setMuted(counterpartyPubky, true),
    unmute: (counterpartyPubky) => setMuted(counterpartyPubky, false),
    accept,
    report,
  };
}
