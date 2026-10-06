export interface UseMessagingSafetyReturn {
  /** True while a mute, unmute or accept is being saved. */
  isPending: boolean;
  mute: (counterpartyPubky: string) => Promise<boolean>;
  unmute: (counterpartyPubky: string) => Promise<boolean>;
  /** Moves the person's Requests into the inbox. */
  accept: (counterpartyPubky: string) => Promise<boolean>;
  /** Copies the conversation id and the other account to the clipboard. */
  report: (conversationId: string) => Promise<boolean>;
}
