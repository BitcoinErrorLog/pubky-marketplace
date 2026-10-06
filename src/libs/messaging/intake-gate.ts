import type { ConversationOrigin } from './first-contact';

/**
 * One authenticated inbound event, as the link runtime hands it to the Shop
 * before storing it. `counterpartyPubky` is the authenticated link peer.
 * For `listing` and `dm`, `conversationId` has already passed the binding
 * check against both endpoints. `unknown` is an event of a kind or version
 * this build cannot interpret; it is kept unprocessed, never shown.
 */
export type MessagingIntakeCandidate =
  | { counterpartyPubky: string; kind: 'listing' | 'dm'; conversationId: string }
  | { counterpartyPubky: string; kind: 'unknown'; conversationId: null };

export type MessagingIntakeDecision =
  | { store: false; reason: 'muted' | 'rate_limited' }
  /** `origin` applies only when this message creates its conversation row. */
  | { store: true; origin: ConversationOrigin };

/**
 * The seam between the link runtime (which authenticates peers, decrypts and
 * persists) and Shop policy (mutes, rate caps, Requests). The runtime asks
 * once per new event, after routing and before persistence, and never stores
 * an event the gate refuses. A refused event is still consumed: the runtime
 * advances its read position past it exactly as for a stored one.
 */
export interface MessagingIntakeGate {
  admit(candidate: MessagingIntakeCandidate): Promise<MessagingIntakeDecision>;
}

/**
 * Proof that the account's mute list was read and confirmed for this
 * operation. Every operation that contacts a counterparty (opening or
 * advancing a link, sending, flushing queued messages, receiving) takes one,
 * so none can run while the list is unknown. It is built from one fresh
 * read and is not kept between operations.
 */
export interface MessagingPolicy {
  readonly gate: MessagingIntakeGate;
  isMuted(counterpartyPubky: string): boolean;
}
