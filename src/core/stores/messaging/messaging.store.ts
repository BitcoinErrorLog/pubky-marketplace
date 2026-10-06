import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { MessagingActionTypes, messagingInitialState, type MessagingStore } from './messaging.types';

export const useMessagingStore = create<MessagingStore>()(
  devtools(
    (set) => ({
      ...messagingInitialState,
      setMessagingEnabled: (pubky) => set({ enabledPubky: pubky }, false, MessagingActionTypes.SET_ENABLED),
      clearMessagingEnabled: () =>
        set({ enabledPubky: null, unreadConversations: 0 }, false, MessagingActionTypes.CLEAR_ENABLED),
      setUnreadConversations: (count) => set({ unreadConversations: count }, false, MessagingActionTypes.SET_UNREAD),
      setMessagingAtRestDegraded: (degraded) =>
        set({ messagingAtRestDegraded: degraded }, false, MessagingActionTypes.SET_AT_REST_DEGRADED),
    }),
    { name: 'messaging-store' },
  ),
);
