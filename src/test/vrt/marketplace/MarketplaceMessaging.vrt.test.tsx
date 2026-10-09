// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, preloadImages, renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_FROZEN_NOW_MS } from '@/test-utils/vrt.clock';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { Button } from '@/atoms/Button/Button';
import { MarketplaceEncryptedConversationDialog } from '@/organisms/Marketplace/MarketplaceEncryptedConversationDialog';
import { MarketplaceMessageDialog } from '@/organisms/Marketplace/MarketplaceMessageDialog';
import { MarketplaceMessagingEnableDialog } from '@/organisms/Marketplace/MarketplaceMessagingEnableDialog';
import type { CommerceMessagingMessageModelSchema } from '@/models/messaging/messaging.schema';

const SELLER = 's'.repeat(52);
const BUYER = 'b'.repeat(52);
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';
const CONVERSATION_ID = `conversation:${SELLER}_${BUYER}_${LISTING_ID}`;

// Fixed fake pubkyauth URL: the QR encodes it verbatim, so it must be
// byte-stable across runs and OSes. It is never dereferenced.
const VRT_AUTH_URL =
  'pubkyauth:///?relay=https%3A%2F%2Fvrt.invalid%2Flink%2F&capabilities=%2Fpub%2Fpaykit%2F%3Arw&secret=vrt-fixed-secret';

const QR_LOGO_URLS = ['/images/ring-logo.svg'];

function fixedMessage(
  id: string,
  direction: 'sent' | 'received',
  body: string,
  recordedAt: number,
): { deliveryState: 'sent'; message: CommerceMessagingMessageModelSchema } {
  return {
    deliveryState: 'sent',
    message: {
      id,
      owner_id: BUYER,
      conversation_id: CONVERSATION_ID,
      listing_ref: `listing:${SELLER}:${LISTING_ID}`,
      counterparty_pubky: SELLER,
      direction,
      body,
      sent_at: 1_767_268_800_000,
      recorded_at: recordedAt,
    },
  };
}

function fixedQueued(id: string, body: string, queuedAt: number, lastError: string | null = null) {
  return {
    deliveryState: 'queued' as const,
    queued: {
      id,
      owner_pubky: BUYER,
      counterparty_pubky: SELLER,
      kind: 'chat' as const,
      conversation_id: CONVERSATION_ID,
      listing_ref: `listing:${SELLER}:${LISTING_ID}`,
      body,
      queued_at: queuedAt,
      attempts: lastError === null ? 0 : 1,
      last_attempt_at: lastError === null ? null : queuedAt + 1,
      last_error: lastError,
    },
  };
}

const conversationView = vi.hoisted(() => ({
  status: 'ready' as string,
  errorMessage: null as string | null,
  thread: [] as unknown[],
  receiverProvisioned: false,
  draft: '',
  bodyBudgetBytes: 620,
  draftBytes: 0,
  isSending: false,
  sendError: null as string | null,
  followOnSend: false,
  firstContactNotice: null as string | null,
  pausedReason: null as string | null,
  keyChange: null as { pinnedKey: string; observedKey: string } | null,
}));

const enableView = vi.hoisted(() => ({
  status: 'awaiting' as string,
  authorizationUrl: '',
  errorMessage: null as string | null,
  isOpeningRing: false,
}));

const listingMode = vi.hoisted(() => ({
  mode: 'sandbox' as string,
  currentUserPubky: 'b'.repeat(52),
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => listingMode.mode };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { currentUserPubky: string }) => unknown) =>
      selector({ currentUserPubky: listingMode.currentUserPubky }),
    {
      getState: () => ({ currentUserPubky: listingMode.currentUserPubky }),
      setState: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: <T,>(action: () => T) => action() }),
}));

vi.mock('@/hooks/useUserDetails/useUserDetails', () => ({
  useUserDetails: () => ({ userDetails: { name: 'Ada' }, isLoading: false }),
}));

vi.mock('@/hooks/useEncryptedConversation/useEncryptedConversation', () => ({
  useEncryptedConversation: () => ({
    status: conversationView.status,
    errorMessage: conversationView.errorMessage,
    thread: conversationView.thread,
    receiverProvisioned: conversationView.receiverProvisioned,
    draft: conversationView.draft,
    setDraft: vi.fn(),
    bodyBudgetBytes: conversationView.bodyBudgetBytes,
    draftBytes: conversationView.draftBytes,
    isSending: conversationView.isSending,
    sendError: conversationView.sendError,
    send: vi.fn(async () => 'queued'),
    cancelQueued: vi.fn(async () => {}),
    refresh: vi.fn(),
    followOnSend: conversationView.followOnSend,
    firstContactNotice: conversationView.firstContactNotice,
    pausedReason: conversationView.pausedReason,
    keyChange: conversationView.keyChange,
    acceptKeyChange: vi.fn(async () => {}),
    isAcceptingKey: false,
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

vi.mock('@/hooks/useMarketplaceMessagingEnable/useMarketplaceMessagingEnable', () => ({
  useMarketplaceMessagingEnable: () => ({
    status: enableView.status,
    authorizationUrl: enableView.authorizationUrl,
    errorMessage: enableView.errorMessage,
    start: vi.fn(),
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: enableView.isOpeningRing,
  }),
}));

async function openDialog(trigger: { click: () => Promise<void> }) {
  await trigger.click();
  await vi.waitFor(() => {
    if (!document.querySelector('[role="dialog"][data-state="open"], [role="dialog"]')) {
      throw new Error('Dialog has not opened yet.');
    }
  });
  const focused = document.activeElement;
  if (focused instanceof HTMLElement) focused.blur();
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog) {
    const images = Array.from(dialog.querySelectorAll('img'));
    await Promise.all(images.map((img) => img.decode?.().catch(() => undefined) ?? Promise.resolve()));
  }
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function Harness({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">{children}</main>;
}

function renderConversationDialog() {
  return (
    <Harness>
      <MarketplaceEncryptedConversationDialog
        sellerPubky={SELLER}
        buyerPubky={BUYER}
        listingId={LISTING_ID}
        counterpartyPubky={SELLER}
        trigger={<Button variant="secondary">Message seller</Button>}
      />
    </Harness>
  );
}

describe('Marketplace encrypted messaging — visual regression', () => {
  beforeEach(() => {
    conversationView.status = 'ready';
    conversationView.errorMessage = null;
    conversationView.thread = [];
    conversationView.receiverProvisioned = false;
    conversationView.draft = '';
    conversationView.draftBytes = 0;
    conversationView.isSending = false;
    conversationView.sendError = null;
    conversationView.followOnSend = false;
    conversationView.firstContactNotice = null;
    conversationView.pausedReason = null;
    conversationView.keyChange = null;
    enableView.status = 'awaiting';
    enableView.authorizationUrl = '';
    enableView.errorMessage = null;
    enableView.isOpeningRing = false;
    listingMode.mode = 'sandbox';
    listingMode.currentUserPubky = BUYER;
    if (!document.getElementById('__vrt_messaging_stabilizer__')) {
      const styleEl = document.createElement('style');
      styleEl.id = '__vrt_messaging_stabilizer__';
      styleEl.textContent = `
        [data-slot="dialog-overlay"],
        [data-slot="dialog-content"] {
          animation: none !important;
          transition: none !important;
        }
        .animate-spin,
        [data-state].zoom-in-95,
        [data-state].zoom-out-95,
        [data-state][class*="slide-in-"],
        [data-state][class*="slide-out-"] {
          animation: none !important;
          transition: none !important;
          transform: none !important;
        }
        textarea:focus,
        textarea:focus-visible {
          caret-color: transparent !important;
          outline: none !important;
          box-shadow: none !important;
        }
      `;
      document.head.appendChild(styleEl);
    }
  });

  it('renders the active conversation with messages and byte budget at desktop viewport', async () => {
    conversationView.thread = [
      fixedMessage('m1', 'sent', 'Is this still available?', VRT_FROZEN_NOW_MS - 3 * 60_000),
      fixedMessage('m2', 'received', 'Yes — happy to answer questions.', VRT_FROZEN_NOW_MS - 2 * 60_000),
      fixedMessage('m3', 'sent', 'Great. Does the price include shipping to Lisbon?', VRT_FROZEN_NOW_MS - 60_000),
    ];
    conversationView.draft = 'Asking because the listing does not say.';
    conversationView.draftBytes = 40;

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-conversation-ready-desktop',
    );
  });

  it('renders the active conversation at mobile viewport', async () => {
    conversationView.thread = [
      fixedMessage('m1', 'sent', 'Is this still available?', VRT_FROZEN_NOW_MS - 3 * 60_000),
      fixedMessage('m2', 'received', 'Yes — happy to answer questions.', VRT_FROZEN_NOW_MS - 2 * 60_000),
    ];

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_MOBILE });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-conversation-ready-mobile',
    );
  });

  it('renders the over-budget composer state at desktop viewport', async () => {
    conversationView.draft = 'x'.repeat(700);
    conversationView.draftBytes = 700;

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-conversation-over-budget-desktop',
    );
  });

  it('renders the send-failure state with the kept draft at desktop viewport', async () => {
    conversationView.thread = [fixedMessage('m1', 'sent', 'First message went through.', VRT_FROZEN_NOW_MS - 60_000)];
    conversationView.draft = 'This one failed to send.';
    conversationView.draftBytes = 24;
    conversationView.sendError = 'The homeserver write failed. Your draft is kept — try again.';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-conversation-send-failed-desktop',
    );
  });

  it('renders the waiting-for-counterparty handshake state at desktop viewport', async () => {
    conversationView.status = 'handshaking-initiator';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-handshake-initiator-desktop',
    );
  });

  it('renders queued messages with cancel affordances while the handshake is pending at desktop viewport', async () => {
    conversationView.status = 'handshaking-initiator';
    conversationView.thread = [
      fixedQueued('00000000-0000-4000-8000-000000000901', 'Is this still available?', VRT_FROZEN_NOW_MS - 2 * 60_000),
      fixedQueued(
        '00000000-0000-4000-8000-000000000902',
        'Happy to pick it up in person too.',
        VRT_FROZEN_NOW_MS - 60_000,
      ),
    ];

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-queued-pending-desktop',
    );
  });

  it('renders a queued message whose last flush attempt failed (honest retry note) at desktop viewport', async () => {
    conversationView.status = 'handshaking-initiator';
    conversationView.thread = [
      fixedQueued(
        '00000000-0000-4000-8000-000000000903',
        'This one hit a transient failure.',
        VRT_FROZEN_NOW_MS - 60_000,
        'The homeserver write failed.',
      ),
    ];

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-queued-retrying-desktop',
    );
  });

  it('renders the link-recovery state with a kept queued message at desktop viewport', async () => {
    conversationView.status = 'recovery-needed';
    conversationView.thread = [
      fixedQueued(
        '00000000-0000-4000-8000-000000000904',
        'Still interested if it is available.',
        VRT_FROZEN_NOW_MS - 60_000,
      ),
    ];

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-recovery-needed-desktop',
    );
  });

  it('renders the changed-key notice with a held queued message at desktop viewport', async () => {
    conversationView.status = 'key-changed';
    conversationView.keyChange = { pinnedKey: 'p'.repeat(52), observedKey: 'q'.repeat(52) };
    conversationView.thread = [
      fixedQueued('00000000-0000-4000-8000-000000000905', 'Is it still available?', VRT_FROZEN_NOW_MS - 60_000),
    ];

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-key-changed-desktop',
    );
  });

  it('renders the changed-key notice with both keys shown for verification at desktop viewport', async () => {
    conversationView.status = 'key-changed';
    conversationView.keyChange = { pinnedKey: 'p'.repeat(52), observedKey: 'q'.repeat(52) };

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await screen.getByRole('button', { name: 'Verify key' }).click();
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-key-changed-verify-desktop',
    );
  });

  it('renders the answering-handshake (responder) state at desktop viewport', async () => {
    conversationView.status = 'handshaking-responder';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-handshake-responder-desktop',
    );
  });

  it('renders the counterparty-not-enrolled state at desktop viewport', async () => {
    conversationView.status = 'not-enrolled';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-not-enrolled-desktop',
    );
  });

  it('renders the in-conversation enable step when no session exists at desktop viewport', async () => {
    conversationView.status = 'needs-enable';
    enableView.authorizationUrl = VRT_AUTH_URL;

    await preloadImages(QR_LOGO_URLS);
    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-needs-enable-desktop',
    );
  });

  it('renders the transport error state at desktop viewport', async () => {
    conversationView.status = 'error';
    conversationView.errorMessage = 'The homeserver could not be reached. Nothing was sent.';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-error-desktop',
    );
  });

  it('renders the standalone enable dialog awaiting Ring approval at desktop viewport', async () => {
    enableView.authorizationUrl = VRT_AUTH_URL;

    await preloadImages(QR_LOGO_URLS);
    const screen = await renderForVRT(
      <Harness>
        <MarketplaceMessagingEnableDialog reconnect={false} />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Enable messages' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messaging-enable-awaiting-desktop');
  });

  it('renders the enable dialog failure state at desktop viewport', async () => {
    enableView.status = 'error';
    enableView.errorMessage = 'The authorization request expired before it was approved. Start a new attempt.';

    const screen = await renderForVRT(
      <Harness>
        <MarketplaceMessagingEnableDialog reconnect />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Reconnect messages' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messaging-enable-error-desktop');
  });

  it('renders the counterparty-not-enrolled state at mobile viewport', async () => {
    conversationView.status = 'not-enrolled';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_MOBILE });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-not-enrolled-mobile',
    );
  });

  it('renders queued messages at mobile viewport', async () => {
    conversationView.status = 'handshaking-initiator';
    conversationView.thread = [
      fixedQueued('00000000-0000-4000-8000-000000000901', 'Is this still available?', VRT_FROZEN_NOW_MS - 2 * 60_000),
    ];

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_MOBILE });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-queued-pending-mobile',
    );
  });

  it('renders the handshake initiator state at mobile viewport', async () => {
    conversationView.status = 'handshaking-initiator';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_MOBILE });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-handshake-initiator-mobile',
    );
  });

  it('renders the follow line above Send on a first message to a seller at desktop viewport', async () => {
    conversationView.followOnSend = true;
    conversationView.draft = 'Is this still available?';
    conversationView.draftBytes = 24;

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-follow-on-send-desktop',
    );
  });

  it('renders the follow line above Send at mobile viewport', async () => {
    conversationView.followOnSend = true;

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_MOBILE });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-follow-on-send-mobile',
    );
  });

  it('renders the notice after a first message whose follow failed at desktop viewport', async () => {
    conversationView.status = 'handshaking-initiator';
    conversationView.thread = [
      fixedQueued('00000000-0000-4000-8000-000000000905', 'Is this still available?', VRT_FROZEN_NOW_MS - 60_000),
    ];
    conversationView.firstContactNotice =
      'We could not follow this shop for you. The seller sees your message after you follow them.';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-follow-failed-desktop',
    );
  });

  it('renders a paused conversation while the mute list cannot be read at desktop viewport', async () => {
    conversationView.status = 'paused';
    conversationView.pausedReason = 'error';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-paused-desktop',
    );
  });

  it('renders a muted conversation with the way to unmute at desktop viewport', async () => {
    conversationView.status = 'muted';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_DESKTOP });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-muted-desktop',
    );
  });

  it('renders a muted conversation at mobile viewport', async () => {
    conversationView.status = 'muted';

    const screen = await renderForVRT(renderConversationDialog(), { viewport: VRT_VIEWPORT_MOBILE });
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(await expectVrtSurface('marketplace-encrypted-conversation')).toMatchScreenshot(
      'messaging-muted-mobile',
    );
  });

  it('renders the seller-disabled listing CTA at desktop viewport', async () => {
    listingMode.mode = 'transaction-service';
    listingMode.currentUserPubky = SELLER;

    const screen = await renderForVRT(
      <Harness>
        <MarketplaceMessageDialog sellerPubky={SELLER} listingId={LISTING_ID} />
      </Harness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messaging-seller-disabled-desktop');
  });

  it('renders the seller-disabled listing CTA at mobile viewport', async () => {
    listingMode.mode = 'transaction-service';
    listingMode.currentUserPubky = SELLER;

    const screen = await renderForVRT(
      <Harness>
        <MarketplaceMessageDialog sellerPubky={SELLER} listingId={LISTING_ID} />
      </Harness>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('messaging-seller-disabled-mobile');
  });
});
