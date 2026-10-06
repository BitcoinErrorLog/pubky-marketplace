import type { MessagingStatus, MessagingThreadState } from '@/application/messaging/messaging';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import type { EncryptedConversationKeyChange, EncryptedConversationStatus } from './useEncryptedConversation.types';

/** The surface status for one conversation state. */
export function encryptedConversationStatusOf(state: MessagingThreadState): EncryptedConversationStatus {
  switch (state.status) {
    case 'paused':
    case 'muted':
    case 'ready':
    case 'not-enrolled':
    case 'key-changed':
    case 'recovery-needed':
    case 'unreachable':
      return state.status;
    case 'handshaking':
      return state.role === 'initiator' ? 'handshaking-initiator' : 'handshaking-responder';
  }
}

/** The pinned and newly advertised keys while a conversation is held for a key change; `null` otherwise. */
export function keyChangeOf(state: MessagingThreadState): EncryptedConversationKeyChange | null {
  return state.status === 'key-changed' ? { pinnedKey: state.pinnedKey, observedKey: state.observedKey } : null;
}

/** What to tell the user after this device republished its own messaging key. */
export function ownKeyRepublishedCopy(outcome: NonNullable<MessagingStatus['ownKeyRepublished']>): string {
  return outcome === 'replaced' ? MESSAGING_COPY.ownKeyReplaced : MESSAGING_COPY.ownKeyMissing;
}

/** A key in groups of four characters, so two people can read it to each other. */
export function formatMessagingKey(key: string): string {
  return key.match(/.{1,4}/g)?.join(' ') ?? key;
}
