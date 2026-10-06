import { ZustandSet } from '../stores.types';
import {
  NotificationActions,
  NotificationActionTypes,
  notificationInitialState,
  NotificationState,
  NotificationStore,
} from './notification.types';

// Actions/Mutators - State modification functions
export const createNotificationActions = (set: ZustandSet<NotificationStore>): NotificationActions => ({
  setState: (state: Partial<NotificationState>) => {
    if (typeof state.unread === 'number') {
      state.unread = Math.max(0, state.unread);
    }
    set(state, false, NotificationActionTypes.INIT);
  },

  setLastRead: (lastRead: number) => {
    set({ lastRead }, false, NotificationActionTypes.SET_LAST_READ);
  },

  setLastPolledTimestamp: (lastPolledTimestamp: number | undefined) => {
    set({ lastPolledTimestamp }, false, NotificationActionTypes.SET_LAST_POLLED_TIMESTAMP);
  },

  setUnread: (unread: number) => {
    // Ensure unread count is never negative
    const validUnread = Math.max(0, unread);
    set({ unread: validUnread }, false, NotificationActionTypes.SET_UNREAD);
  },

  setMarketplaceUnread: (marketplaceUnread: number) => {
    // Clamped like `unread` so a bad count can never render a negative badge
    const validUnread = Math.max(0, marketplaceUnread);
    set({ marketplaceUnread: validUnread }, false, NotificationActionTypes.SET_MARKETPLACE_UNREAD);
  },

  reset: () => {
    set(notificationInitialState, false, NotificationActionTypes.RESET);
  },
});
