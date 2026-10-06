import type { PollingServiceConfig, PollingServiceState } from '@/coordinators/base/coordinators.types';

export interface MessagingSyncCoordinatorConfig extends PollingServiceConfig {
  /** Routes where no background messaging sync runs. */
  disabledRoutes?: RegExp[];
}

export type MessagingSyncCoordinatorState = PollingServiceState;

/**
 * Spacing of background sync passes on any Shop page. Slower than an open
 * inbox or conversation, which poll on their own, faster than anyone waits
 * for a first message to leave.
 */
export const MESSAGING_BACKGROUND_SYNC_INTERVAL_MS = 15_000;
