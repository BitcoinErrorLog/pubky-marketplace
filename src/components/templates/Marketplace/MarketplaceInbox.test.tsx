import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { buildMarketplaceConversationAggregateId } from '@/libs/commerce/transaction-commands';
import { Logger } from '@/libs/logger/logger';
import { MarketplaceInbox } from './MarketplaceInbox';

const SELLER = 's'.repeat(52);
const BUYER = 'b'.repeat(52);
const OTHER = 'o'.repeat(52);
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';
const CONVERSATION_ID = buildMarketplaceConversationAggregateId(SELLER, BUYER, LISTING_ID);

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const auth = vi.hoisted(() => ({ currentUserPubky: 'b'.repeat(52) }));
const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));
const encryptedView = vi.hoisted(() => ({
  status: 'ready' as string,
  conversations: [] as unknown[],
  receiverProvisioned: false,
  errorMessage: null as string | null,
  mutesStatus: 'ready' as string | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/marketplace/messages',
  useSearchParams: () => search.params,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { currentUserPubky: string }) => unknown) =>
      selector({ currentUserPubky: auth.currentUserPubky }),
    {
      getState: () => ({
        currentUserPubky: auth.currentUserPubky,
        selectCurrentUserPubky: () => auth.currentUserPubky,
      }),
      setState: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}));

const grant = vi.hoisted(() => ({ signer: null as 'bitkit' | 'passport' | null }));

vi.mock('@/hooks/useGrantSigner/useGrantSigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useGrantSigner/useGrantSigner')>()),
  useGrantSigner: () => grant.signer,
}));

vi.mock('@/hooks/useEncryptedInbox/useEncryptedInbox', () => ({
  useEncryptedInbox: () => ({
    status: encryptedView.status,
    conversations: encryptedView.conversations,
    receiverProvisioned: encryptedView.receiverProvisioned,
    errorMessage: encryptedView.errorMessage,
    mutesStatus: encryptedView.mutesStatus,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceInbox/useMarketplaceInbox', () => ({
  useMarketplaceInbox: () => ({ conversations: [], isLoading: false, error: null, isSandbox: false }),
}));

vi.mock('@/hooks/useUserDetails/useUserDetails', () => ({
  useUserDetails: () => ({ userDetails: null, isLoading: false }),
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: <T,>(action: () => T) => action() }),
}));

vi.mock('@/hooks/useEncryptedConversation/useEncryptedConversation', () => ({
  useEncryptedConversation: () => ({
    status: 'ready',
    errorMessage: null,
    thread: [],
    receiverProvisioned: false,
    draft: '',
    setDraft: vi.fn(),
    bodyBudgetBytes: 620,
    draftBytes: 0,
    isSending: false,
    sendError: null,
    send: vi.fn(async () => 'queued'),
    cancelQueued: vi.fn(async () => {}),
    refresh: vi.fn(),
  }),
}));

const safety = vi.hoisted(() => ({ accept: async (_pubky: string) => true }));

vi.mock('@/hooks/useMessagingSafety/useMessagingSafety', () => ({
  useMessagingSafety: () => ({
    isPending: false,
    mute: async () => true,
    unmute: async () => true,
    accept: (pubky: string) => safety.accept(pubky),
    report: async () => true,
  }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/organisms/Marketplace/MarketplaceSectionNav', () => ({
  MarketplaceSectionNav: () => null,
}));

describe('MarketplaceInbox conversation query', () => {
  beforeEach(() => {
    search.params = new URLSearchParams();
    router.push.mockReset();
    router.replace.mockReset();
    auth.currentUserPubky = BUYER;
    config.mode = 'transaction-service';
    encryptedView.status = 'ready';
    encryptedView.conversations = [];
    encryptedView.receiverProvisioned = false;
    encryptedView.errorMessage = null;
    encryptedView.mutesStatus = 'ready';
  });

  it('shows the fail-closed copy for a malformed query and does not open a thread', async () => {
    const warn = vi.spyOn(Logger, 'warn');
    search.params = new URLSearchParams('conversation=not-a-conversation');
    render(<MarketplaceInbox />);
    expect(screen.getByText(MESSAGING_COPY.deepLinkInvalid)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('[data-surface="marketplace-inbox"]')).toBeTruthy();
    await waitFor(() => {
      expect(JSON.stringify(warn.mock.calls)).toContain('invalid_conversation_query');
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not-a-conversation');
    warn.mockRestore();
  });

  it('rejects dm: ids on the marketplace route', () => {
    search.params = new URLSearchParams(`conversation=dm:${SELLER}`);
    render(<MarketplaceInbox />);
    expect(screen.getByText(MESSAGING_COPY.deepLinkInvalid)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the other-account copy without opening a thread', () => {
    auth.currentUserPubky = OTHER;
    search.params = new URLSearchParams(`conversation=${CONVERSATION_ID}`);
    render(<MarketplaceInbox />);
    expect(screen.getByText(MESSAGING_COPY.deepLinkOtherAccount)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the listing conversation for a participant query', async () => {
    search.params = new URLSearchParams(`conversation=${CONVERSATION_ID}`);
    render(<MarketplaceInbox />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(document.querySelector('[data-surface="marketplace-encrypted-conversation"]')).toBeTruthy();
    expect(screen.queryByText(MESSAGING_COPY.deepLinkInvalid)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/marketplace/messages');
    });
  });

  it('strips conversation= from the address bar after consuming the first searchParams read', async () => {
    search.params = new URLSearchParams(`conversation=${CONVERSATION_ID}`);
    render(<MarketplaceInbox />);
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/marketplace/messages');
    });
    expect(router.replace.mock.calls.some((call) => String(call[0]).includes('conversation='))).toBe(false);
  });

  it('marks a received message unread from Dexie last_read_at only', async () => {
    encryptedView.conversations = [
      {
        id: `${BUYER}:${CONVERSATION_ID}`,
        owner_id: BUYER,
        conversation_id: CONVERSATION_ID,
        listing_ref: `listing:${SELLER}:${LISTING_ID}`,
        counterparty_pubky: SELLER,
        last_message_at: 200,
        last_read_at: 50,
        created_at: 1,
        updated_at: 200,
        lastMessage: {
          id: `${BUYER}:m1`,
          owner_id: BUYER,
          conversation_id: CONVERSATION_ID,
          listing_ref: `listing:${SELLER}:${LISTING_ID}`,
          counterparty_pubky: SELLER,
          direction: 'received',
          body: 'About the order',
          sent_at: 200,
          recorded_at: 200,
        },
        lastQueued: null,
      },
    ];
    render(<MarketplaceInbox />);
    expect(await screen.findByLabelText('Unread messages')).toBeInTheDocument();
    expect(screen.getByText(MESSAGING_COPY.thisSeller)).toBeInTheDocument();
  });

  it('lists a stranger’s unread message under Requests with no unread dot, and accepts it', async () => {
    const accept = vi.fn(async () => true);
    safety.accept = accept;
    encryptedView.conversations = [
      {
        id: `${SELLER}:${CONVERSATION_ID}`,
        owner_id: SELLER,
        conversation_id: CONVERSATION_ID,
        listing_ref: `listing:${SELLER}:${LISTING_ID}`,
        counterparty_pubky: BUYER,
        origin: 'request',
        last_message_at: 200,
        last_read_at: null,
        created_at: 1,
        updated_at: 200,
        lastMessage: {
          id: `${SELLER}:m1`,
          owner_id: SELLER,
          conversation_id: CONVERSATION_ID,
          listing_ref: `listing:${SELLER}:${LISTING_ID}`,
          counterparty_pubky: BUYER,
          direction: 'received',
          body: 'Is it still available?',
          sent_at: 200,
          recorded_at: 200,
        },
        lastQueued: null,
      },
    ];
    auth.currentUserPubky = SELLER;
    render(<MarketplaceInbox />);

    const requests = await screen.findByRole('region', { name: MESSAGING_COPY.requestsTitle });
    expect(requests).toHaveTextContent('Is it still available?');
    expect(screen.queryByLabelText('Unread messages')).not.toBeInTheDocument();
    screen.getByRole('button', { name: `${MESSAGING_COPY.requestAccept} ${MESSAGING_COPY.thisBuyer}` }).click();
    await waitFor(() => expect(accept).toHaveBeenCalledWith(BUYER));
    expect(screen.getByRole('button', { name: `${MESSAGING_COPY.mute} ${MESSAGING_COPY.thisBuyer}` })).toBeEnabled();
  });

  it('shows only the paused notice, with no empty state or rows, while the mute list is unconfirmed', () => {
    encryptedView.mutesStatus = 'error';
    encryptedView.conversations = [];
    render(<MarketplaceInbox />);

    expect(screen.getByText(MESSAGING_COPY.mutesUnavailable)).toBeInTheDocument();
    expect(screen.queryByText(MESSAGING_COPY.inboxEmptyTitle)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: MESSAGING_COPY.requestsTitle })).not.toBeInTheDocument();
  });
});

describe('MarketplaceInbox for a grant sign-in', () => {
  beforeEach(() => {
    search.params = new URLSearchParams();
    auth.currentUserPubky = BUYER;
    config.mode = 'transaction-service';
    encryptedView.status = 'needs-enable';
    encryptedView.conversations = [];
    encryptedView.receiverProvisioned = false;
    encryptedView.errorMessage = null;
    encryptedView.mutesStatus = 'ready';
    grant.signer = null;
  });

  it('a Pubky Passport sign-in reads that messages are not available, with no enable button', () => {
    grant.signer = 'passport';
    render(<MarketplaceInbox />);

    expect(screen.getByTestId('grant-session-messaging-unavailable')).toHaveTextContent(
      'Messages are not available for Pubky Passport sign-ins yet. Everything else in Shop works with this sign-in.',
    );
    expect(screen.queryByRole('button', { name: /encrypted messaging/i })).not.toBeInTheDocument();
    expect(screen.queryByText(MESSAGING_COPY.inboxNeedsEnable)).not.toBeInTheDocument();
  });

  it('a Ring (cookie) sign-in still gets the enable prompt', () => {
    render(<MarketplaceInbox />);

    expect(screen.getByRole('button', { name: /Enable encrypted messaging/ })).toBeInTheDocument();
    expect(screen.queryByTestId('grant-session-messaging-unavailable')).not.toBeInTheDocument();
  });
});
