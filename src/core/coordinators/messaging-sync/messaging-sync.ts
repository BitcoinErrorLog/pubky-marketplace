import { AUTH_ROUTES } from '@/app/routes';
import { MessagingController } from '@/controllers/messaging/messaging';
import { Coordinator } from '@/coordinators/base/coordinator';
import { PollingInactiveReason } from '@/coordinators/base/coordinators.types';
import { routeToRegex } from '@/coordinators/base/coordinators.utils';
import {
  MESSAGING_BACKGROUND_SYNC_INTERVAL_MS,
  type MessagingSyncCoordinatorConfig,
  type MessagingSyncCoordinatorState,
} from '@/coordinators/messaging-sync/messaging-sync.types';
import { Logger } from '@/libs/logger/logger';
import { MESSAGING_SYNC_PASS_TIMEOUT_MS, withPassDeadline } from '@/libs/messaging/pass-deadline';
import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * Runs the encrypted inbox sync on every Shop page, not only while Messages
 * or a conversation is open, so a first message moves as soon as both
 * people have the Shop open: the seller's device answers a buyer's queued
 * handshake, and the buyer's device then finishes it and sends what is
 * queued. Nothing can run while every tab of an account is closed.
 *
 * It keeps running in a hidden tab (the browser spaces its timers), and
 * only one tab of the origin runs a pass at a time. Each pass belongs to the
 * account signed in when it started and stops when that changes. It acts
 * only where this browser already holds that account's messaging key and
 * never creates, replaces or publishes one, so it cannot take new
 * conversations away from the device the person actually messages from
 * ({@link MessagingController.syncInboxInBackground}). A pass that runs
 * past {@link MESSAGING_SYNC_PASS_TIMEOUT_MS} is told to stop and gives up
 * the cross-tab lock.
 */
export class MessagingSyncCoordinator extends Coordinator<
  MessagingSyncCoordinatorConfig,
  MessagingSyncCoordinatorState
> {
  private static instance: MessagingSyncCoordinator | null = null;

  private disabledRoutes: RegExp[] = [
    routeToRegex('/onboarding'),
    routeToRegex(AUTH_ROUTES.LOGOUT),
    routeToRegex(AUTH_ROUTES.SIGN_IN),
  ];

  private constructor() {
    super({
      initialConfig: {
        intervalMs: MESSAGING_BACKGROUND_SYNC_INTERVAL_MS,
        pollOnStart: true,
        respectPageVisibility: false,
      },
    });
  }

  public static getInstance(): MessagingSyncCoordinator {
    if (!MessagingSyncCoordinator.instance) {
      MessagingSyncCoordinator.instance = new MessagingSyncCoordinator();
    }
    return MessagingSyncCoordinator.instance;
  }

  public static resetInstance(): void {
    if (MessagingSyncCoordinator.instance) {
      MessagingSyncCoordinator.instance.destroy();
      MessagingSyncCoordinator.instance = null;
    }
  }

  public configure(config: Partial<MessagingSyncCoordinatorConfig>): void {
    super.configure(config);
    if (config.disabledRoutes) this.disabledRoutes = config.disabledRoutes;
  }

  protected async poll(): Promise<void> {
    const ownerPubky = useAuthStore.getState().currentUserPubky;
    if (!ownerPubky) return;
    try {
      await runInOneTab(`pubky-messaging-background-sync|${ownerPubky}`, async () => {
        let expired = false;
        await withPassDeadline(
          MessagingController.syncInboxInBackground(ownerPubky, () => !expired),
          {
            timeoutMs: MESSAGING_SYNC_PASS_TIMEOUT_MS,
            operation: 'backgroundMessagingSync',
            onExpire: () => {
              expired = true;
            },
          },
        );
      });
    } catch (error) {
      Logger.warn('Background messaging sync failed; the next pass retries', { error });
    }
  }

  protected isRouteAllowed(): boolean {
    const { currentRoute } = this.getState();
    return !this.disabledRoutes.some((pattern) => pattern.test(currentRoute));
  }

  /** Messaging needs a signed-in account, not a profile. */
  protected shouldPoll(): boolean {
    const authState = useAuthStore.getState();
    return (
      this.getState().isManuallyStarted &&
      authState.selectIsAuthenticated() &&
      authState.currentUserPubky !== null &&
      this.isRouteAllowed()
    );
  }

  protected getInactiveReason(): PollingInactiveReason {
    if (!this.getState().isManuallyStarted) return PollingInactiveReason.NOT_STARTED;
    const authState = useAuthStore.getState();
    if (!authState.selectIsAuthenticated() || authState.currentUserPubky === null) {
      return PollingInactiveReason.NOT_AUTHENTICATED;
    }
    if (!this.isRouteAllowed()) return PollingInactiveReason.ROUTE_DISABLED;
    return PollingInactiveReason.MANUALLY_STOPPED;
  }
}

/**
 * Runs `operation` unless another tab of the origin holds `name` right now,
 * in which case that tab's pass stands in for this one. Without the Web
 * Locks API nothing runs: the messaging layer refuses to work without it.
 */
async function runInOneTab(name: string, operation: () => Promise<void>): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (typeof locks?.request !== 'function') return;
  await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (lock) await operation();
  });
}
