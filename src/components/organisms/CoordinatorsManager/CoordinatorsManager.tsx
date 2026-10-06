'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MessagingSyncCoordinator } from '@/coordinators/messaging-sync/messaging-sync';
import { MuteListSyncCoordinator } from '@/coordinators/mute-list-sync/mute-list-sync';
import { NotificationCoordinator } from '@/coordinators/notifications/notifications';
import { StreamCoordinator } from '@/coordinators/streams/stream';
import { TtlCoordinator } from '@/coordinators/ttl/ttl';

function getAppCoordinators() {
  return {
    notification: NotificationCoordinator.getInstance(),
    stream: StreamCoordinator.getInstance(),
    ttl: TtlCoordinator.getInstance(),
    muteListSync: MuteListSyncCoordinator.getInstance(),
    messagingSync: MessagingSyncCoordinator.getInstance(),
  };
}

function applyRouteToCoordinators(pathname: string): void {
  const coordinators = getAppCoordinators();
  void coordinators.notification.setRoute(pathname);
  void coordinators.stream.setRoute(pathname);
  coordinators.ttl.setRoute(pathname);
  coordinators.muteListSync.setRoute(pathname);
  void coordinators.messagingSync.setRoute(pathname);
}

function startAppCoordinators(): void {
  CommerceController.bindMarketplaceSessionStore();
  const coordinators = getAppCoordinators();
  void coordinators.notification.start();
  void coordinators.stream.start();
  coordinators.ttl.start();
  coordinators.muteListSync.start();
  void coordinators.messagingSync.start();
}

function stopAppCoordinators(): void {
  CommerceController.unbindMarketplaceSessionStore();
  const coordinators = getAppCoordinators();
  coordinators.notification.stop();
  coordinators.stream.stop();
  coordinators.ttl.stop();
  coordinators.muteListSync.stop();
  coordinators.messagingSync.stop();
}

/**
 * CoordinatorsManager
 *
 * Centralized component that initializes and manages the coordinators layer lifecycle.
 * This component has no UI - it only manages coordinator lifecycles.
 *
 * Responsibilities:
 * - Initialize coordinators on mount (NotificationCoordinator, StreamCoordinator,
 *   MuteListSyncCoordinator, TtlCoordinator, MessagingSyncCoordinator)
 * - Start coordination when the component is mounted
 * - Track route changes and inform coordinators
 * - Stop coordination and cleanup when unmounted
 *
 * Architecture:
 * This component bridges React lifecycle with the coordinators layer:
 *
 * i.e. CoordinatorsManager (UI) → Coordinators → Controllers → Application → Services
 */
export function CoordinatorsManager() {
  const pathname = usePathname();

  // Apply route before start() on mount so route-based coordinators see the real pathname immediately.
  useEffect(() => {
    applyRouteToCoordinators(pathname);
  }, [pathname]);

  useEffect(() => {
    startAppCoordinators();
    return () => {
      stopAppCoordinators();
    };
  }, []);

  return null;
}
