export interface NotificationState {
  lastRead: number;
  lastPolledTimestamp: number | undefined;
  unread: number;
  /**
   * Unread marketplace notifications from the transactional backend, counted
   * separately from the Nexus-backed `unread` so neither poll can clobber the
   * other. Only the sandbox stores read state, so this is 0 in every other
   * adapter mode — the badge never shows a count the user cannot clear.
   */
  marketplaceUnread: number;
}

export interface NotificationActions {
  setState: (state: Partial<NotificationState>) => void;
  setLastRead: (lastRead: number) => void;
  setLastPolledTimestamp: (lastPolledTimestamp: number | undefined) => void;
  setUnread: (unread: number) => void;
  setMarketplaceUnread: (marketplaceUnread: number) => void;
  reset: () => void;
}

export interface NotificationSelectors {
  selectLastRead: () => number;
  selectLastPolledTimestamp: () => number | undefined;
  selectUnread: () => number;
  selectMarketplaceUnread: () => number;
  /** Badge count: social unread plus marketplace unread. */
  selectTotalUnread: () => number;
}

export type NotificationStore = NotificationState & NotificationActions & NotificationSelectors;

export const notificationInitialState: NotificationState = {
  lastRead: 0,
  lastPolledTimestamp: undefined,
  unread: 0,
  marketplaceUnread: 0,
};

export enum NotificationActionTypes {
  INIT = 'INIT',
  SET_LAST_READ = 'SET_LAST_READ',
  SET_LAST_POLLED_TIMESTAMP = 'SET_LAST_POLLED_TIMESTAMP',
  SET_UNREAD = 'SET_UNREAD',
  SET_MARKETPLACE_UNREAD = 'SET_MARKETPLACE_UNREAD',
  MARK_ALL_AS_READ = 'MARK_ALL_AS_READ',
  RESET = 'RESET',
}
