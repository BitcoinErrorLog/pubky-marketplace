'use client';

import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { getCommerceAdapterMode, getCommercePollIntervalMs } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMessageAttachmentPicker } from '@/hooks/useMessageAttachmentPicker/useMessageAttachmentPicker';
import { MARKETPLACE_FAILURE_MESSAGES, marketplaceFailureMessage } from '@/libs/commerce/failure-messages';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceConversation } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';
import {
  type MarketplaceMessageData,
  marketplaceMessageDefaults,
  marketplaceMessageSchema,
} from './useMarketplaceMessages.types';

export interface UseMarketplaceMessagesResult {
  form: UseFormReturn<MarketplaceMessageData>;
  conversation: MarketplaceConversation | null;
  isLoading: boolean;
  error: string | null;
  /**
   * This hook serves the SANDBOX transport only: the durable transaction
   * service has no conversation/message tables and `message.send` was never
   * ported. In any other mode this hook loads nothing and refuses to send —
   * durable modes carry messaging over the encrypted transport instead
   * (`useEncryptedConversation`).
   */
  isSandbox: boolean;
  attachment: ReturnType<typeof useMessageAttachmentPicker>;
  submit: () => Promise<boolean>;
  refresh: () => Promise<void>;
}

export function useMarketplaceMessages(sellerPubky: string, listingId: string): UseMarketplaceMessagesResult {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isSandbox = getCommerceAdapterMode() === 'sandbox';
  const [conversation, setConversation] = useState<MarketplaceConversation | null>(null);
  const [isLoading, setIsLoading] = useState(isSandbox && Boolean(currentUserPubky));
  const [error, setError] = useState<string | null>(null);
  const attachment = useMessageAttachmentPicker();
  const form = useForm<MarketplaceMessageData>({
    resolver: zodResolver(marketplaceMessageSchema),
    defaultValues: marketplaceMessageDefaults,
    mode: 'onChange',
  });

  const refresh = () =>
    loadConversation(currentUserPubky, sellerPubky, listingId, setConversation, setIsLoading, setError);

  useEffect(() => {
    if (!currentUserPubky || !isSandbox) {
      setIsLoading(false);
      return;
    }
    let active = true;
    void loadConversation(currentUserPubky, sellerPubky, listingId, setConversation, setIsLoading, setError);
    const timer = window.setInterval(() => {
      if (active) {
        void loadConversation(currentUserPubky, sellerPubky, listingId, setConversation, setIsLoading, setError);
      }
    }, getCommercePollIntervalMs());
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [currentUserPubky, isSandbox, listingId, sellerPubky]);

  const submit = async (): Promise<boolean> => {
    if (!currentUserPubky || currentUserPubky === sellerPubky) return false;
    // Re-checked at call time: `message.send` has no durable counterpart.
    if (getCommerceAdapterMode() !== 'sandbox') {
      toast({
        variant: 'error',
        description: 'This transport is sandbox-only; use the encrypted conversation instead.',
      });
      return false;
    }
    let succeeded = false;
    await form.handleSubmit(async (data) => {
      try {
        const uploadedAttachment = attachment.file ? await attachment.upload(sellerPubky) : null;
        if (attachment.file && !uploadedAttachment) return;
        const response = await CommerceController.executeMarketplaceCommand({
          version: 1,
          commandId: crypto.randomUUID(),
          aggregateId: buildMarketplaceConversationAggregateId(sellerPubky, currentUserPubky, listingId),
          expectedRevision: conversation?.revision ?? 0,
          issuedAt: new Date().toISOString(),
          kind: 'message.send',
          payload: {
            listingAggregateId: buildMarketplaceListingAggregateId(sellerPubky, listingId),
            recipientPubky: sellerPubky,
            text: data.text,
            attachmentIds: uploadedAttachment ? [uploadedAttachment.id] : [],
          },
        });
        if (!response.ok) {
          toast({
            variant: 'error',
            description: marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.message),
          });
          return;
        }
        succeeded = true;
        form.reset(marketplaceMessageDefaults);
        attachment.reset();
        await refresh();
      } catch {
        toast({ variant: 'error', description: 'Could not send this message.' });
      }
    })();
    return succeeded;
  };

  return { form, conversation, isLoading, error, isSandbox, attachment, submit, refresh };
}

async function loadConversation(
  currentUserPubky: string | null,
  sellerPubky: string,
  listingId: string,
  setConversation: Dispatch<SetStateAction<MarketplaceConversation | null>>,
  setIsLoading: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | null>>,
): Promise<void> {
  if (!currentUserPubky) return;
  try {
    const id = buildMarketplaceConversationAggregateId(sellerPubky, currentUserPubky, listingId);
    const conversations = await CommerceController.getMarketplaceConversations();
    setConversation(conversations.find((conversation) => conversation.id === id) ?? null);
    setError(null);
  } catch {
    setError('Messages are temporarily unavailable.');
  } finally {
    setIsLoading(false);
  }
}
