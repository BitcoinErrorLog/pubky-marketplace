// Intentional import order — mock factories rely on stable aliases.

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagingConversationSummary } from '@/application/messaging/messaging';
import type { UseEncryptedConversationReturn } from '@/hooks/useEncryptedConversation/useEncryptedConversation.types';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { setSocialHost } from '@/test-utils/social-host';
import { Messages } from './Messages';
import { MessagesConversation } from './MessagesConversation';

const OWNER = 'o'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);

const inboxView = vi.hoisted(() => ({
  status: 'ready' as string,
  receiverProvisioned: true,
  conversations: [] as unknown[],
}));

const grant = vi.hoisted(() => ({ signer: null as 'bitkit' | 'passport' | null }));

vi.mock('@/hooks/useGrantSigner/useGrantSigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useGrantSigner/useGrantSigner')>()),
  useGrantSigner: () => grant.signer,
}));

const dmView = vi.hoisted(() => ({
  status: 'ready' as string,
  thread: [] as unknown[],
  keyChange: null as { pinnedKey: string; observedKey: string } | null,
  acceptKeyChange: (() => Promise.resolve()) as () => Promise<void>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/messages',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: 'o'.repeat(52) }),
}));

vi.mock('@/hooks/useEncryptedInbox/useEncryptedInbox', () => ({
  useEncryptedInbox: () => ({
    status: inboxView.status,
    conversations: inboxView.conversations,
    receiverProvisioned: inboxView.receiverProvisioned,
    errorMessage: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useDmConversation/useDmConversation', () => ({
  useDmConversation: (): UseEncryptedConversationReturn => ({
    status: dmView.status as UseEncryptedConversationReturn['status'],
    errorMessage: null,
    thread: dmView.thread as UseEncryptedConversationReturn['thread'],
    receiverProvisioned: true,
    draft: '',
    setDraft: vi.fn(),
    bodyBudgetBytes: 862,
    draftBytes: 0,
    isSending: false,
    sendError: null,
    send: vi.fn(async () => 'queued' as const),
    cancelQueued: vi.fn(async () => {}),
    refresh: vi.fn(),
    keyChange: dmView.keyChange,
    acceptKeyChange: dmView.acceptKeyChange,
    isAcceptingKey: false,
  }),
}));

vi.mock('@/hooks/useUserDetails/useUserDetails', () => ({
  useUserDetails: () => ({ userDetails: { name: 'Satoshi Nakamoto' }, isLoading: false }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

function dmSummary(overrides: Partial<MessagingConversationSummary>): MessagingConversationSummary {
  const conversationId = `dm:${COUNTERPARTY}`;
  return {
    id: `${OWNER}:${conversationId}`,
    owner_id: OWNER,
    conversation_id: conversationId,
    kind: 'dm',
    listing_ref: null,
    counterparty_pubky: COUNTERPARTY,
    last_message_at: 100,
    last_read_at: null,
    created_at: 50,
    updated_at: 100,
    lastMessage: null,
    lastQueued: null,
    ...overrides,
  };
}

describe('Messages inbox previews', () => {
  beforeEach(() => {
    inboxView.conversations = [];
    dmView.status = 'ready';
    dmView.thread = [];
  });

  it('prefixes the preview with "Queued:" when the newest item is still queued on this device', () => {
    inboxView.conversations = [
      dmSummary({
        lastMessage: {
          id: `${OWNER}:m1`,
          owner_id: OWNER,
          conversation_id: `dm:${COUNTERPARTY}`,
          listing_ref: null,
          counterparty_pubky: COUNTERPARTY,
          direction: 'sent',
          body: 'sent a while ago',
          sent_at: 1_787_562_000_000,
          recorded_at: 100,
        },
        lastQueued: {
          id: '00000000-0000-4000-8000-000000000042',
          owner_pubky: OWNER,
          counterparty_pubky: COUNTERPARTY,
          kind: 'dm',
          conversation_id: null,
          listing_ref: null,
          body: 'not sent yet',
          queued_at: 200,
          attempts: 0,
          last_attempt_at: null,
          last_error: null,
        },
      }),
    ];

    render(<Messages />);

    expect(screen.getByText('Queued: not sent yet')).toBeInTheDocument();
  });

  it('keeps the honest "You:" preview when the newest item was actually sent', () => {
    inboxView.conversations = [
      dmSummary({
        lastMessage: {
          id: `${OWNER}:m1`,
          owner_id: OWNER,
          conversation_id: `dm:${COUNTERPARTY}`,
          listing_ref: null,
          counterparty_pubky: COUNTERPARTY,
          direction: 'sent',
          body: 'the newest message',
          sent_at: 1_787_562_000_000,
          recorded_at: 300,
        },
        lastQueued: {
          id: '00000000-0000-4000-8000-000000000043',
          owner_pubky: OWNER,
          counterparty_pubky: COUNTERPARTY,
          kind: 'dm',
          conversation_id: null,
          listing_ref: null,
          body: 'older queued row',
          queued_at: 200,
          attempts: 0,
          last_attempt_at: null,
          last_error: null,
        },
      }),
    ];

    render(<Messages />);

    expect(screen.getByText('You: the newest message')).toBeInTheDocument();
  });
});

describe('MessagesConversation pending-handshake composer', () => {
  beforeEach(() => {
    dmView.status = 'handshaking-initiator';
    dmView.thread = [];
  });

  it('keeps the composer enabled and shows the honest queue banner while waiting for the counterparty', () => {
    render(<MessagesConversation counterpartyPubky={COUNTERPARTY} />);

    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    expect(screen.getByText(MESSAGING_COPY.handshakeInitiator)).toBeInTheDocument();
  });

  it('keeps the composer enabled while answering an inbound handshake', () => {
    dmView.status = 'handshaking-responder';

    render(<MessagesConversation counterpartyPubky={COUNTERPARTY} />);

    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(screen.getByText(MESSAGING_COPY.handshakeResponder)).toBeInTheDocument();
  });

  it('keeps the history and composer and says nothing was deleted while the link needs recovery', () => {
    dmView.status = 'recovery-needed';

    render(<MessagesConversation counterpartyPubky={COUNTERPARTY} />);

    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(screen.getByText(MESSAGING_COPY.linkRecoveryNeeded)).toBeInTheDocument();
    expect(screen.queryByText(MESSAGING_COPY.handshakeInitiator)).not.toBeInTheDocument();
  });
});

describe('MessagesConversation counterparty links', () => {
  beforeEach(() => {
    dmView.status = 'ready';
    dmView.thread = [];
  });

  afterEach(() => {
    setSocialHost(undefined);
  });

  it('links the avatar to the Shop profile while social link-out is off', () => {
    render(<MessagesConversation counterpartyPubky={COUNTERPARTY} />);

    expect(screen.getByRole('link', { name: 'View profile' })).toHaveAttribute('href', `/profile/${COUNTERPARTY}`);
    expect(screen.queryByRole('link', { name: 'Profile on Pubky' })).not.toBeInTheDocument();
  });

  it('links the avatar to the shop and adds the profile on the social host while on', () => {
    setSocialHost('https://pubky.app');
    render(<MessagesConversation counterpartyPubky={COUNTERPARTY} />);

    expect(screen.getByRole('link', { name: 'View shop' })).toHaveAttribute(
      'href',
      `/marketplace/shop/${COUNTERPARTY}`,
    );
    expect(screen.getByRole('link', { name: 'Profile on Pubky' })).toHaveAttribute(
      'href',
      `https://pubky.app/profile/${COUNTERPARTY}`,
    );
  });
});

describe('Messages inbox for a grant sign-in', () => {
  beforeEach(() => {
    inboxView.status = 'needs-enable';
    inboxView.receiverProvisioned = false;
    inboxView.conversations = [];
    grant.signer = null;
  });

  it.each([
    ['passport', 'Pubky Passport'],
    ['bitkit', 'Bitkit'],
  ] as const)('a %s sign-in reads that messages are not available, with nothing to enable', (signer, name) => {
    grant.signer = signer;
    render(<Messages />);

    expect(screen.getByTestId('grant-session-messaging-unavailable')).toHaveTextContent(
      `Messages are not available for ${name} sign-ins yet. Everything else in Shop works with this sign-in.`,
    );
    expect(screen.queryByText(/Enable encrypted messaging|Reconnect encrypted messaging/)).not.toBeInTheDocument();
    expect(screen.queryByText(MESSAGING_COPY.inboxNeedsEnable)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a Ring (cookie) sign-in still gets the enable prompt', () => {
    render(<Messages />);

    expect(screen.getByRole('heading', { name: 'Enable encrypted messaging' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable messages', exact: true })).toBeInTheDocument();
    expect(screen.queryByTestId('grant-session-messaging-unavailable')).not.toBeInTheDocument();
  });
});

describe('MessagesConversation key change notice', () => {
  const P_KEY = 'p'.repeat(52);
  const Q_KEY = 'q'.repeat(52);

  beforeEach(() => {
    dmView.status = 'key-changed';
    dmView.thread = [];
    dmView.keyChange = { pinnedKey: P_KEY, observedKey: Q_KEY };
  });

  it('says the key changed, keeps the composer for queued notes, and hides the keys until Verify', () => {
    render(<MessagesConversation counterpartyPubky={COUNTERPARTY} />);

    expect(screen.getByRole('alert')).toHaveTextContent(MESSAGING_COPY.keyChangedTitle);
    expect(screen.getByText(MESSAGING_COPY.keyChangedBody)).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(screen.queryByTestId('messaging-key-verify')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: MESSAGING_COPY.keyChangedVerify }));

    const verify = screen.getByTestId('messaging-key-verify');
    expect(verify).toHaveTextContent(MESSAGING_COPY.keyChangedVerifyHelp);
    expect(verify).toHaveTextContent('qqqq qqqq');
    expect(verify).toHaveTextContent('pppp pppp');
  });

  it('accepts only on the explicit action', () => {
    const accept = vi.fn(() => Promise.resolve());
    dmView.acceptKeyChange = accept;
    render(<MessagesConversation counterpartyPubky={COUNTERPARTY} />);
    expect(accept).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: MESSAGING_COPY.keyChangedAccept }));

    expect(accept).toHaveBeenCalledOnce();
  });
});
