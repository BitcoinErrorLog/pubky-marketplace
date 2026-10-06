'use client';

import { useEffect } from 'react';
import { MessagingController } from '@/controllers/messaging/messaging';
import { Logger } from '@/libs/logger/logger';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useMessagingStore } from '@/stores/messaging/messaging.store';

/**
 * Device-local unread conversation count for the Messages entry points.
 *
 * HONESTY CONTRACT: this counts only messages already RECEIVED AND PERSISTED
 * on this device past each conversation's read checkpoint. It does not poll
 * homeservers itself: receiving happens in the inbox sync (an open messaging
 * surface, or `MessagingSyncCoordinator` on any page), so this badge can lag
 * reality but can never invent it. Hydrates once per sign-in/enable change;
 * afterwards the controller keeps the store fact fresh on every
 * sync/receive/mark-read.
 */
export function useMessagesUnread(): number {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const enabledPubky = useMessagingStore((state) => state.enabledPubky);
  const unreadConversations = useMessagingStore((state) => state.unreadConversations);

  useEffect(() => {
    if (!currentUserPubky) return;
    MessagingController.refreshUnreadCount().catch((error) => {
      Logger.warn('Failed to hydrate the local unread message count', { error });
    });
  }, [currentUserPubky, enabledPubky]);

  return unreadConversations;
}
