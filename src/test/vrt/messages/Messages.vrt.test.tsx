// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { Messages } from '@/templates/Messages/Messages';
import { MessagesConversation } from '@/templates/Messages/MessagesConversation';
import { setSocialHost } from '@/test-utils/social-host';

const OWNER = 'o'.repeat(52);
const DM_COUNTERPARTY = 'z'.repeat(52);
const LISTING_SELLER = 's'.repeat(52);
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';

const auth = vi.hoisted(() => ({ currentUserPubky: 'o'.repeat(52) as string | null }));

const inboxView = vi.hoisted(() => ({
  status: 'ready' as string,
  conversations: [] as unknown[],
  receiverProvisioned: false,
  errorMessage: null as string | null,
}));

const dmView = vi.hoisted(() => ({
  status: 'ready' as string,
  errorMessage: null as string | null,
  thread: [] as unknown[],
  receiverProvisioned: false,
  draft: '',
  bodyBudgetBytes: 862,
  draftBytes: 0,
  isSending: false,
  sendError: null as string | null,
  keyChange: null as { pinnedKey: string; observedKey: string } | null,
}));

function dmConversationFixture(unread: boolean) {
  const conversationId = `dm:${DM_COUNTERPARTY}`;
  return {
    id: `${OWNER}:${conversationId}`,
    owner_id: OWNER,
    conversation_id: conversationId,
    kind: 'dm',
    listing_ref: null,
    counterparty_pubky: DM_COUNTERPARTY,
    last_message_at: 1_755_691_200_000,
    last_read_at: unread ? null : 1_755_777_600_000,
    created_at: 1_755_604_800_000,
    updated_at: 1_755_691_200_000,
    lastMessage: {
      id: `${OWNER}:dm1`,
      owner_id: OWNER,
      conversation_id: conversationId,
      listing_ref: null,
      counterparty_pubky: DM_COUNTERPARTY,
      direction: 'received',
      body: 'Hey — are you going to the meetup on Saturday?',
      sent_at: 1_787_227_200_000,
      recorded_at: 1_755_691_200_000,
    },
    lastQueued: null,
  };
}

function queuedDmConversationFixture() {
  const base = dmConversationFixture(false);
  return {
    ...base,
    lastQueued: {
      id: '00000000-0000-4000-8000-000000000910',
      owner_pubky: OWNER,
      counterparty_pubky: DM_COUNTERPARTY,
      kind: 'dm',
      conversation_id: null,
      listing_ref: null,
      body: 'See you there — saving you a seat.',
      queued_at: 1_755_777_700_000,
      attempts: 0,
      last_attempt_at: null,
      last_error: null,
    },
  };
}

function listingConversationFixture() {
  const conversationId = `conversation:${LISTING_SELLER}_${OWNER}_${LISTING_ID}`;
  return {
    id: `${OWNER}:${conversationId}`,
    owner_id: OWNER,
    conversation_id: conversationId,
    kind: 'listing',
    listing_ref: `listing:${LISTING_SELLER}:${LISTING_ID}`,
    counterparty_pubky: LISTING_SELLER,
    last_message_at: 1_755_604_800_000,
    last_read_at: 1_755_777_600_000,
    created_at: 1_755_518_400_000,
    updated_at: 1_755_604_800_000,
    lastMessage: {
      id: `${OWNER}:m1`,
      owner_id: OWNER,
      conversation_id: conversationId,
      listing_ref: `listing:${LISTING_SELLER}:${LISTING_ID}`,
      counterparty_pubky: LISTING_SELLER,
      direction: 'sent',
      body: 'Is this still available?',
      sent_at: 1_787_140_800_000,
      recorded_at: 1_755_604_800_000,
    },
    lastQueued: null,
  };
}

function dmMessageFixture(id: string, direction: 'sent' | 'received', body: string, recordedAt: number) {
  return {
    deliveryState: 'sent' as const,
    message: {
      id: `${OWNER}:${id}`,
      owner_id: OWNER,
      conversation_id: `dm:${DM_COUNTERPARTY}`,
      listing_ref: null,
      counterparty_pubky: DM_COUNTERPARTY,
      direction,
      body,
      sent_at: 1_787_227_200_000,
      recorded_at: recordedAt,
    },
  };
}

function dmQueuedFixture(id: string, body: string, queuedAt: number, lastError: string | null = null) {
  return {
    deliveryState: 'queued' as const,
    queued: {
      id,
      owner_pubky: OWNER,
      counterparty_pubky: DM_COUNTERPARTY,
      kind: 'dm' as const,
      conversation_id: null,
      listing_ref: null,
      body,
      queued_at: queuedAt,
      attempts: lastError === null ? 0 : 1,
      last_attempt_at: lastError === null ? null : queuedAt + 1,
      last_error: lastError,
    },
  };
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/messages',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: auth.currentUserPubky }),
}));

const grantView = vi.hoisted(() => ({ signer: null as 'bitkit' | 'passport' | null }));

vi.mock('@/hooks/useGrantSigner/useGrantSigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useGrantSigner/useGrantSigner')>()),
  useGrantSigner: () => grantView.signer,
}));

vi.mock('@/hooks/useEncryptedInbox/useEncryptedInbox', () => ({
  useEncryptedInbox: () => ({
    status: inboxView.status,
    conversations: inboxView.conversations,
    receiverProvisioned: inboxView.receiverProvisioned,
    errorMessage: inboxView.errorMessage,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useDmConversation/useDmConversation', () => ({
  useDmConversation: () => ({
    status: dmView.status,
    errorMessage: dmView.errorMessage,
    thread: dmView.thread,
    receiverProvisioned: dmView.receiverProvisioned,
    draft: dmView.draft,
    setDraft: vi.fn(),
    bodyBudgetBytes: dmView.bodyBudgetBytes,
    draftBytes: dmView.draftBytes,
    isSending: dmView.isSending,
    sendError: dmView.sendError,
    send: vi.fn(async () => 'queued'),
    cancelQueued: vi.fn(async () => {}),
    refresh: vi.fn(),
    keyChange: dmView.keyChange,
    acceptKeyChange: vi.fn(async () => {}),
    isAcceptingKey: false,
  }),
}));

vi.mock('@/hooks/useUserDetails/useUserDetails', () => ({
  useUserDetails: (userId: string | null | undefined) => ({
    userDetails: userId === 'z'.repeat(52) ? { name: 'Satoshi Nakamoto' } : null,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useMarketplaceMessagingEnable/useMarketplaceMessagingEnable', () => ({
  useMarketplaceMessagingEnable: () => ({
    status: 'awaiting',
    authorizationUrl:
      'pubkyauth:///?relay=https%3A%2F%2Fvrt.invalid%2Flink%2F&capabilities=%2Fpub%2Fpaykit%2F%3Arw&secret=vrt-fixed-secret',
    errorMessage: null,
    start: vi.fn(),
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: false,
  }),
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => 'transaction-service' };
});

vi.mock('@/hooks/useMessagingSafety/useMessagingSafety', () => ({
  useMessagingSafety: () => ({
    isPending: false,
    mute: vi.fn(async () => true),
    unmute: vi.fn(async () => true),
    accept: vi.fn(async () => true),
    report: vi.fn(async () => true),
  }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Messages area — visual regression', () => {
  beforeEach(() => {
    grantView.signer = null;
    auth.currentUserPubky = OWNER;
    inboxView.status = 'ready';
    inboxView.conversations = [];
    inboxView.receiverProvisioned = false;
    inboxView.errorMessage = null;
    dmView.status = 'ready';
    dmView.errorMessage = null;
    dmView.thread = [];
    dmView.receiverProvisioned = false;
    dmView.draft = '';
    dmView.draftBytes = 0;
    dmView.isSending = false;
    dmView.sendError = null;
    dmView.keyChange = null;
  });

  it('renders the mixed conversation list (unread DM + listing) at desktop viewport', async () => {
    inboxView.conversations = [dmConversationFixture(true), listingConversationFixture()];

    const screen = await renderForVRT(<Messages />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messages-list-desktop');
  });

  it('renders the mixed conversation list at mobile viewport', async () => {
    inboxView.conversations = [dmConversationFixture(true), listingConversationFixture()];

    const screen = await renderForVRT(<Messages />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messages-list-mobile');
  });

  it('renders the empty state with the Requests note at desktop viewport', async () => {
    const screen = await renderForVRT(<Messages />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messages-empty-desktop');
  });

  it('renders a direct-message request below the inbox at desktop viewport', async () => {
    inboxView.conversations = [listingConversationFixture(), { ...dmConversationFixture(true), origin: 'request' }];

    const screen = await renderForVRT(<Messages />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messages-requests-desktop');
  });

  it('renders a muted DM conversation with the way to unmute at desktop viewport', async () => {
    dmView.status = 'muted';

    const screen = await renderForVRT(<MessagesConversation counterpartyPubky={DM_COUNTERPARTY} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dm-conversation-muted-desktop');
  });

  it('links the counterparty to their shop with a Profile on Pubky link under social link-out at desktop viewport', async () => {
    dmView.status = 'muted';
    setSocialHost('https://pubky.app');
    try {
      const screen = await renderForVRT(<MessagesConversation counterpartyPubky={DM_COUNTERPARTY} />, {
        viewport: VRT_VIEWPORT_DESKTOP,
      });
      await expect
        .element(screen.getByRole('link', { name: 'Profile on Pubky' }))
        .toHaveAttribute('href', `https://pubky.app/profile/${DM_COUNTERPARTY}`);
      await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dm-conversation-social-linkout-desktop');
    } finally {
      setSocialHost(undefined);
    }
  });

  it('renders the signed-out state at desktop viewport', async () => {
    auth.currentUserPubky = null;

    const screen = await renderForVRT(<Messages />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messages-signed-out-desktop');
  });

  it('renders the reconnect prompt (failed silent restore) with readable history at desktop viewport', async () => {
    inboxView.status = 'needs-enable';
    inboxView.receiverProvisioned = true;
    inboxView.conversations = [dmConversationFixture(false)];

    const screen = await renderForVRT(<Messages />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messages-reconnect-desktop');
  });

  it('renders the grant sign-in notice in place of the enable prompt at desktop viewport', async () => {
    grantView.signer = 'passport';
    inboxView.status = 'needs-enable';

    const screen = await renderForVRT(<Messages />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messages-grant-unavailable-desktop');
  });

  it('renders the grant sign-in notice in place of the enable prompt at mobile viewport', async () => {
    grantView.signer = 'passport';
    inboxView.status = 'needs-enable';

    const screen = await renderForVRT(<Messages />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messages-grant-unavailable-mobile');
  });

  it('renders the error state at desktop viewport', async () => {
    inboxView.status = 'error';
    inboxView.errorMessage = 'The homeserver could not be reached. Nothing was sent.';

    const screen = await renderForVRT(<Messages />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messages-error-desktop');
  });

  it('renders a ready DM conversation with messages at desktop viewport', async () => {
    dmView.thread = [
      dmMessageFixture('d1', 'sent', 'Hey! Long time.', 10),
      dmMessageFixture('d2', 'received', 'Hey — are you going to the meetup on Saturday?', 20),
      dmMessageFixture('d3', 'sent', 'Planning to. Want to share a ride?', 30),
    ];
    dmView.draft = 'Leaving around 6pm.';
    dmView.draftBytes = 19;

    const screen = await renderForVRT(<MessagesConversation counterpartyPubky={DM_COUNTERPARTY} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dm-conversation-ready-desktop');
  });

  it('renders a ready DM conversation at mobile viewport', async () => {
    dmView.thread = [
      dmMessageFixture('d1', 'sent', 'Hey! Long time.', 10),
      dmMessageFixture('d2', 'received', 'Hey — are you going to the meetup on Saturday?', 20),
    ];

    const screen = await renderForVRT(<MessagesConversation counterpartyPubky={DM_COUNTERPARTY} />, {
      viewport: VRT_VIEWPORT_MOBILE,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dm-conversation-ready-mobile');
  });

  it('renders the counterparty-not-enrolled DM state at desktop viewport', async () => {
    dmView.status = 'not-enrolled';

    const screen = await renderForVRT(<MessagesConversation counterpartyPubky={DM_COUNTERPARTY} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dm-conversation-not-enrolled-desktop');
  });

  it('renders the waiting-for-counterparty DM handshake state at desktop viewport', async () => {
    dmView.status = 'handshaking-initiator';

    const screen = await renderForVRT(<MessagesConversation counterpartyPubky={DM_COUNTERPARTY} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dm-conversation-handshake-desktop');
  });

  it('renders queued DM messages with cancel affordances while the handshake is pending at desktop viewport', async () => {
    dmView.status = 'handshaking-initiator';
    dmView.thread = [
      dmQueuedFixture('00000000-0000-4000-8000-000000000911', 'Hey! Long time.', 10),
      dmQueuedFixture(
        '00000000-0000-4000-8000-000000000912',
        'This one hit a transient failure.',
        20,
        'The homeserver write failed.',
      ),
    ];

    const screen = await renderForVRT(<MessagesConversation counterpartyPubky={DM_COUNTERPARTY} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dm-conversation-queued-desktop');
  });

  it('renders the changed-key notice with a held queued message at desktop viewport', async () => {
    dmView.status = 'key-changed';
    dmView.keyChange = { pinnedKey: 'p'.repeat(52), observedKey: 'q'.repeat(52) };
    dmView.thread = [dmQueuedFixture('00000000-0000-4000-8000-000000000913', 'Are we still on for Saturday?', 10)];

    const screen = await renderForVRT(<MessagesConversation counterpartyPubky={DM_COUNTERPARTY} />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dm-conversation-key-changed-desktop');
  });

  it('renders the changed-key notice with both keys shown for verification at mobile viewport', async () => {
    dmView.status = 'key-changed';
    dmView.keyChange = { pinnedKey: 'p'.repeat(52), observedKey: 'q'.repeat(52) };

    const screen = await renderForVRT(<MessagesConversation counterpartyPubky={DM_COUNTERPARTY} />, {
      viewport: VRT_VIEWPORT_MOBILE,
    });
    await screen.getByRole('button', { name: 'Verify key' }).click();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dm-conversation-key-changed-verify-mobile');
  });

  it('renders the conversation list with a Queued preview when the newest item awaits delivery', async () => {
    inboxView.conversations = [queuedDmConversationFixture(), listingConversationFixture()];

    const screen = await renderForVRT(<Messages />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messages-list-queued-preview-desktop');
  });
});
