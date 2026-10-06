'use client';

import { useEffect, useState } from 'react';
import { getCommerceAdapterMode, getCommercePollIntervalMs } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import { toast } from '@/molecules/Toaster/use-toast';
import type {
  MarketplaceNotificationEntry,
  MarketplaceNotificationPreferences,
} from '@/services/marketplace/marketplace';
import { isRecognizedMarketplaceNotification } from '@/services/marketplace/marketplace-projections';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

/**
 * Commerce notifications from whichever transactional backend the mode
 * selects. Read state and preferences are SANDBOX-ONLY and stay that way
 * honestly: the durable service delivers notifications as immutable outbox
 * rows with no `revision`, no `notification.mark_read` command, and no
 * preference tables at all — so in `transaction-service` mode this hook
 * never fetches preferences and refuses to mark anything read, and the UI
 * must not pretend otherwise.
 */
export function useMarketplaceNotifications() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  // Refetch trigger: connecting a session replaces this store object, so the
  // effect below re-runs immediately instead of waiting for the next poll.
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const adapterMode = getCommerceAdapterMode();
  const canMarkRead = adapterMode === 'sandbox';
  const [notifications, setNotifications] = useState<MarketplaceNotificationEntry[]>([]);
  const [preferences, setPreferences] = useState<MarketplaceNotificationPreferences | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(currentUserPubky));
  const [error, setError] = useState<string | null>(null);
  const [needsSession, setNeedsSession] = useState(false);

  useEffect(() => {
    if (!currentUserPubky) {
      setIsLoading(false);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const [next, nextPreferences] = await Promise.all([
          CommerceController.getMarketplaceNotifications(),
          canMarkRead ? CommerceController.getMarketplaceNotificationPreferences() : Promise.resolve(null),
        ]);
        if (active) {
          setNotifications(next);
          setPreferences(nextPreferences);
          setError(null);
          setNeedsSession(false);
        }
      } catch (loadError) {
        if (active) {
          // A missing/expired marketplace session is not a dead end: flag it
          // so the surface renders the session-connect affordance.
          setNeedsSession(isMarketplaceSessionRequiredError(loadError));
          setError(
            marketplaceFailureMessage(
              marketplaceErrorCode(loadError),
              MARKETPLACE_FAILURE_MESSAGES.notificationsUnavailable,
            ),
          );
        }
      } finally {
        if (active) setIsLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, getCommercePollIntervalMs());
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [canMarkRead, currentUserPubky, marketplaceSession]);

  const markAllRead = async () => {
    // Re-checked at call time: `notification.mark_read` does not exist on the
    // durable service (delivered notifications are immutable outbox rows).
    if (getCommerceAdapterMode() !== 'sandbox') {
      toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.notificationsReadUnavailable });
      return;
    }
    const unread = notifications.filter(isRecognizedMarketplaceNotification).filter(({ readAt }) => !readAt);
    try {
      const results = await Promise.all(
        unread.map((notification) =>
          CommerceController.executeMarketplaceCommand({
            version: 1,
            commandId: crypto.randomUUID(),
            aggregateId: `notification:${notification.id}`,
            expectedRevision: notification.revision,
            issuedAt: new Date().toISOString(),
            kind: 'notification.mark_read',
            payload: { notificationId: notification.id },
          }),
        ),
      );
      const failed = results.find((result) => !result.ok);
      if (failed && !failed.ok) {
        toast({
          variant: 'error',
          description: marketplaceFailureMessage(failed.error.code, MARKETPLACE_FAILURE_MESSAGES.notifications),
        });
        return;
      }
      setNotifications((current) =>
        current.map((notification) =>
          !isRecognizedMarketplaceNotification(notification) || notification.readAt
            ? notification
            : {
                ...notification,
                ...(notification.revision === undefined ? {} : { revision: notification.revision + 1 }),
                readAt: new Date().toISOString(),
              },
        ),
      );
    } catch {
      toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.notificationsReadFailed });
    }
  };

  const updatePreferences = async (
    changes: Pick<MarketplaceNotificationPreferences, 'messages' | 'offers' | 'bids' | 'auctions'>,
  ) => {
    if (!currentUserPubky || !preferences) return false;
    // Re-checked at call time: `notification.preferences.update` has no
    // durable counterpart — preference tables do not exist on the service.
    if (getCommerceAdapterMode() !== 'sandbox') {
      toast({
        variant: 'error',
        description: MARKETPLACE_FAILURE_MESSAGES.notificationPreferencesUnavailable,
      });
      return false;
    }
    try {
      const response = await CommerceController.executeMarketplaceCommand({
        version: 1,
        commandId: crypto.randomUUID(),
        aggregateId: `notification_preferences:${currentUserPubky}`,
        expectedRevision: preferences.revision,
        issuedAt: new Date().toISOString(),
        kind: 'notification.preferences.update',
        payload: changes,
      });
      if (!response.ok) {
        toast({
          variant: 'error',
          description: marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.notifications),
        });
        return false;
      }
      setPreferences({
        ...preferences,
        ...changes,
        revision: preferences.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      return true;
    } catch {
      toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.notificationPreferencesFailed });
      return false;
    }
  };

  return {
    notifications,
    preferences,
    unreadCount: notifications.filter(
      (notification) => isRecognizedMarketplaceNotification(notification) && !notification.readAt,
    ).length,
    isLoading,
    error,
    needsSession,
    canMarkRead,
    markAllRead,
    updatePreferences,
  };
}
