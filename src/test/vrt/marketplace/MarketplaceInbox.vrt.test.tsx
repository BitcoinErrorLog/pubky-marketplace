// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, renderForVRT } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceInbox } from '@/templates/Marketplace/MarketplaceInbox';

const fixtures = vi.hoisted(async () => {
  const { createInboxConversationsFixture, CONVERSATION_FIXTURE_BUYER } =
    await import('@/test/fixtures/commerce/conversations');
  return {
    buyer: CONVERSATION_FIXTURE_BUYER,
    conversations: createInboxConversationsFixture(),
  };
});

const view = vi.hoisted(() => ({
  conversations: [] as unknown[],
  isLoading: false,
  error: null as string | null,
  isSandbox: true,
}));

const encryptedView = vi.hoisted(() => ({
  status: 'ready' as string,
  conversations: [] as unknown[],
  receiverProvisioned: false,
  errorMessage: null as string | null,
  mutesStatus: 'ready' as string | null,
}));

const config = vi.hoisted(() => ({ mode: 'sandbox' as string }));

const ENCRYPTED_SELLER = 's'.repeat(52);
const ENCRYPTED_LISTING = '0033GVVN22HJ0FYQGZZS8R2BFC';

const REQUEST_BUYER = 'q'.repeat(52);

function requestConversationFixture(seller: string, withMessage: boolean) {
  const conversationId = `conversation:${seller}_${REQUEST_BUYER}_${ENCRYPTED_LISTING}`;
  return {
    id: `${seller}:${conversationId}`,
    owner_id: seller,
    conversation_id: conversationId,
    listing_ref: `listing:${seller}_${ENCRYPTED_LISTING}`,
    counterparty_pubky: REQUEST_BUYER,
    origin: 'request',
    last_message_at: withMessage ? 1_787_227_200_000 : null,
    last_read_at: null,
    created_at: 1_787_140_800_000,
    updated_at: 1_787_227_200_000,
    lastQueued: null,
    lastMessage: withMessage
      ? {
          id: `${seller}:r1`,
          owner_id: seller,
          conversation_id: conversationId,
          listing_ref: `listing:${seller}_${ENCRYPTED_LISTING}`,
          counterparty_pubky: REQUEST_BUYER,
          direction: 'received',
          body: 'Hi, is the record player still available?',
          sent_at: 1_787_227_200_000,
          recorded_at: 1_787_227_200_000,
        }
      : null,
  };
}

function encryptedConversationFixture(buyer: string) {
  const conversationId = `conversation:${ENCRYPTED_SELLER}_${buyer}_${ENCRYPTED_LISTING}`;
  return {
    id: `${buyer}:${conversationId}`,
    owner_id: buyer,
    conversation_id: conversationId,
    listing_ref: `listing:${ENCRYPTED_SELLER}:${ENCRYPTED_LISTING}`,
    counterparty_pubky: ENCRYPTED_SELLER,
    last_message_at: 1_755_691_200_000,
    last_read_at: 1_755_691_200_000,
    created_at: 1_755_604_800_000,
    updated_at: 1_755_691_200_000,
    lastMessage: {
      id: `${buyer}:m1`,
      owner_id: buyer,
      conversation_id: conversationId,
      listing_ref: `listing:${ENCRYPTED_SELLER}:${ENCRYPTED_LISTING}`,
      counterparty_pubky: ENCRYPTED_SELLER,
      direction: 'received',
      body: 'Yes — happy to answer questions about the record player.',
      sent_at: 1_787_227_200_000,
      recorded_at: 1_787_227_200_000,
    },
  };
}

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/marketplace/messages',
  useSearchParams: () => search.params,
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

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/stores/auth/auth.store', async () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: (await fixtures).buyer }),
}));

vi.mock('@/hooks/useMarketplaceInbox/useMarketplaceInbox', () => ({
  useMarketplaceInbox: () => ({
    conversations: view.conversations,
    isLoading: view.isLoading,
    error: view.error,
    isSandbox: view.isSandbox,
  }),
}));

const grantView = vi.hoisted(() => ({ signer: null as 'bitkit' | 'passport' | null }));

vi.mock('@/hooks/useGrantSigner/useGrantSigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useGrantSigner/useGrantSigner')>()),
  useGrantSigner: () => grantView.signer,
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

vi.mock('@/hooks/useMessagingSafety/useMessagingSafety', () => ({
  useMessagingSafety: () => ({
    isPending: false,
    mute: vi.fn(async () => true),
    unmute: vi.fn(async () => true),
    accept: vi.fn(async () => true),
    report: vi.fn(async () => true),
  }),
}));

vi.mock('@/organisms/Marketplace/MarketplaceReauthDialog', () => ({
  MarketplaceReauthDialog: ({ triggerLabel }: { triggerLabel: string }) => (
    <button type="button" className="rounded-full border px-4 py-2 text-sm">
      {triggerLabel}
    </button>
  ),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace inbox — visual regression', () => {
  beforeEach(() => {
    search.params = new URLSearchParams();
    config.mode = 'sandbox';
    view.conversations = [];
    view.isLoading = false;
    view.error = null;
    view.isSandbox = true;
    grantView.signer = null;
    encryptedView.status = 'ready';
    encryptedView.conversations = [];
    encryptedView.receiverProvisioned = false;
    encryptedView.errorMessage = null;
    encryptedView.mutesStatus = 'ready';
  });

  it('renders the conversations list at desktop viewport', async () => {
    const { conversations } = await fixtures;
    view.conversations = conversations;

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-conversations-desktop');
  });

  it('renders the conversations list at mobile viewport', async () => {
    const { conversations } = await fixtures;
    view.conversations = conversations;

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-conversations-mobile');
  });

  it('renders the empty state at desktop viewport', async () => {
    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-empty-desktop');
  });

  it('renders the error state at desktop viewport', async () => {
    view.error = 'Marketplace messages are unavailable.';

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-error-desktop');
  });

  it('renders the loading state at desktop viewport', async () => {
    view.isLoading = true;

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-loading-desktop');
  });

  // Modes with no messaging backend at all (`unavailable`): honest dead end.
  it('renders the unavailable notice in modes with no messaging backend at desktop viewport', async () => {
    view.isSandbox = false;

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-unavailable-desktop');
  });

  // Durable modes: the encrypted inbox.
  it('renders the encrypted enable prompt when messaging was never enabled at desktop viewport', async () => {
    config.mode = 'transaction-service';
    encryptedView.status = 'needs-enable';

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-enable-desktop');
  });

  it('renders the encrypted reconnect prompt with readable local history at desktop viewport', async () => {
    const { buyer } = await fixtures;
    config.mode = 'transaction-service';
    encryptedView.status = 'needs-enable';
    encryptedView.receiverProvisioned = true;
    encryptedView.conversations = [encryptedConversationFixture(buyer)];

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-reconnect-desktop');
  });

  it('renders the encrypted conversations list at desktop viewport', async () => {
    const { buyer } = await fixtures;
    config.mode = 'transaction-service';
    encryptedView.conversations = [encryptedConversationFixture(buyer)];

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-conversations-desktop');
  });

  it('renders the encrypted empty state at desktop viewport', async () => {
    config.mode = 'transaction-service';

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-empty-desktop');
  });

  it('renders the encrypted empty state at mobile viewport', async () => {
    config.mode = 'transaction-service';

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-empty-mobile');
  });

  it('renders the encrypted enable prompt at mobile viewport', async () => {
    config.mode = 'transaction-service';
    encryptedView.status = 'needs-enable';

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-enable-mobile');
  });

  it('renders the grant sign-in notice in place of the enable prompt at desktop viewport', async () => {
    config.mode = 'transaction-service';
    encryptedView.status = 'needs-enable';
    grantView.signer = 'passport';

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-grant-unavailable-desktop');
  });

  it('renders the grant sign-in notice in place of the enable prompt at mobile viewport', async () => {
    config.mode = 'transaction-service';
    encryptedView.status = 'needs-enable';
    grantView.signer = 'passport';

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-grant-unavailable-mobile');
  });

  it('renders the empty state at mobile viewport', async () => {
    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-empty-mobile');
  });

  it('renders the error state at mobile viewport', async () => {
    view.error = 'Marketplace messages are unavailable.';

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-error-mobile');
  });

  it('renders Requests from people the seller does not know yet at desktop viewport', async () => {
    const { buyer } = await fixtures;
    config.mode = 'transaction-service';
    encryptedView.conversations = [
      encryptedConversationFixture(buyer),
      requestConversationFixture(buyer, true),
      {
        ...requestConversationFixture(buyer, false),
        id: 'second',
        conversation_id: `conversation:${buyer}_${'r'.repeat(52)}_L2`,
        counterparty_pubky: 'r'.repeat(52),
      },
    ];

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-requests-desktop');
  });

  it('renders Requests at mobile viewport', async () => {
    const { buyer } = await fixtures;
    config.mode = 'transaction-service';
    encryptedView.conversations = [requestConversationFixture(buyer, true)];

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-requests-mobile');
  });

  it('renders the paused-delivery notice when mutes need approval at desktop viewport', async () => {
    config.mode = 'transaction-service';
    encryptedView.mutesStatus = 'needs_approval';
    // While the list is unconfirmed the controller returns no conversations at all.
    encryptedView.conversations = [];

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-encrypted-mutes-paused-desktop');
  });

  it('renders the fail-closed invalid conversation query at desktop viewport', async () => {
    config.mode = 'transaction-service';
    search.params = new URLSearchParams('conversation=not-a-conversation');

    await renderForVRT(<MarketplaceInbox />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(await expectVrtSurface('marketplace-inbox')).toMatchScreenshot('inbox-invalid-conversation-desktop');
  });
});
