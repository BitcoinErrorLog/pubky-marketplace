export interface MessagingState {
  /**
   * Pubky whose encrypted-messaging session is live in this tab, or null.
   * Public fact only — the session handle itself stays inside the service and
   * is never mirrored here. Surfaces subscribe to refetch when it changes.
   */
  enabledPubky: string | null;
  /**
   * Device-local unread conversation count: conversations holding at least
   * one RECEIVED message persisted after their read checkpoint. Honest by
   * construction — it counts only messages already stored on this device,
   * never undelivered mail on a homeserver. Refreshed by the controller after
   * sync/receive/mark-read.
   */
  unreadConversations: number;
  /**
   * True when this boot's at-rest wrap sweep failed (see
   * `DatabaseInitResult`): legacy plaintext messaging key material may still
   * sit at rest until a later boot succeeds. The messaging enable UI reads
   * this and pauses with "storage protection unavailable" instead of
   * enabling on top of degraded storage protection.
   */
  messagingAtRestDegraded: boolean;
}

export interface MessagingActions {
  setMessagingEnabled: (pubky: string) => void;
  clearMessagingEnabled: () => void;
  setUnreadConversations: (count: number) => void;
  setMessagingAtRestDegraded: (degraded: boolean) => void;
}

export type MessagingStore = MessagingState & MessagingActions;

export const messagingInitialState: MessagingState = {
  enabledPubky: null,
  unreadConversations: 0,
  messagingAtRestDegraded: false,
};

export enum MessagingActionTypes {
  SET_ENABLED = 'messaging/setEnabled',
  CLEAR_ENABLED = 'messaging/clearEnabled',
  SET_UNREAD = 'messaging/setUnreadConversations',
  SET_AT_REST_DEGRADED = 'messaging/setAtRestDegraded',
}
