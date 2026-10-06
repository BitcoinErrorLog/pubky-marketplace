import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConversationThreadItem,
  UseEncryptedConversationReturn,
} from '@/hooks/useEncryptedConversation/useEncryptedConversation.types';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import type {
  CommerceMessagingMessageModelSchema,
  CommerceMessagingOutboxModelSchema,
} from '@/models/messaging/messaging.schema';
import { EncryptedConversationBody } from './EncryptedConversationBody';

const OWNER = 'o'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);

function sentItem(id: string, body: string): ConversationThreadItem {
  const message: CommerceMessagingMessageModelSchema = {
    id: `${OWNER}:${id}`,
    owner_id: OWNER,
    conversation_id: `dm:${COUNTERPARTY}`,
    listing_ref: null,
    counterparty_pubky: COUNTERPARTY,
    direction: 'sent',
    body,
    sent_at: 1_787_565_600_000,
    recorded_at: 10,
  };
  return { deliveryState: 'sent', message };
}

function queuedItem(body: string, lastError: string | null = null): ConversationThreadItem {
  const queued: CommerceMessagingOutboxModelSchema = {
    id: '00000000-0000-4000-8000-000000000042',
    owner_pubky: OWNER,
    counterparty_pubky: COUNTERPARTY,
    kind: 'dm',
    conversation_id: null,
    listing_ref: null,
    body,
    queued_at: 20,
    attempts: lastError === null ? 0 : 1,
    last_attempt_at: lastError === null ? null : 30,
    last_error: lastError,
  };
  return { deliveryState: 'queued', queued };
}

function conversationFixture(
  thread: ConversationThreadItem[],
  cancelQueued = vi.fn(async () => {}),
): UseEncryptedConversationReturn {
  return {
    status: 'handshaking-initiator',
    errorMessage: null,
    thread,
    receiverProvisioned: true,
    draft: '',
    setDraft: vi.fn(),
    bodyBudgetBytes: 862,
    draftBytes: 0,
    isSending: false,
    sendError: null,
    send: vi.fn(async () => 'queued' as const),
    cancelQueued,
    refresh: vi.fn(),
    keyChange: null,
    acceptKeyChange: vi.fn(async () => {}),
    isAcceptingKey: false,
  };
}

describe('EncryptedConversationBody queued rendering', () => {
  it('renders queued messages after sent history, labeled Queued with a cancel affordance', () => {
    const cancelQueued = vi.fn(async () => {});
    const conversation = conversationFixture(
      [sentItem('m1', 'already delivered'), queuedItem('waiting')],
      cancelQueued,
    );

    render(<EncryptedConversationBody conversation={conversation} />);

    expect(screen.getByText('already delivered')).toBeInTheDocument();
    expect(screen.getByText('waiting')).toBeInTheDocument();
    expect(screen.getByText('Queued')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }));
    expect(cancelQueued).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000042');
  });

  it('shows the honest retry note once a flush attempt failed — never a sent state', () => {
    const conversation = conversationFixture([queuedItem('stuck message', 'homeserver write failed')]);

    render(<EncryptedConversationBody conversation={conversation} />);

    expect(screen.getByText(MESSAGING_COPY.queued)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Not sent yet: homeserver write failed. Trying again.');
    expect(screen.queryByText('Sent')).not.toBeInTheDocument();
  });

  it('shows no failure note on a queued message no send has failed for', () => {
    render(<EncryptedConversationBody conversation={conversationFixture([queuedItem('waiting')])} />);

    expect(screen.queryByText(/Not sent yet/)).not.toBeInTheDocument();
  });

  it('keeps the composer enabled while the handshake is pending', () => {
    const conversation = conversationFixture([]);

    render(<EncryptedConversationBody conversation={conversation} />);

    expect(screen.getByLabelText('Message')).toBeEnabled();
  });
});
