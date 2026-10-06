// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { USD_ASSET } from '@/libs/commerce/pricing';
import { MarketplaceBidDialog } from '@/organisms/Marketplace/MarketplaceBidDialog';
import { MarketplaceMessageDialog } from '@/organisms/Marketplace/MarketplaceMessageDialog';
import { MarketplaceOfferDialog } from '@/organisms/Marketplace/MarketplaceOfferDialog';

// 8x8 solid-color PNG so the message-attachment scenario shows a real image
// without any network fetch.
const ATTACHMENT_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=';

const fixtures = vi.hoisted(async () => {
  const { createAuctionProjectionFixture } = await import('@/test/fixtures/commerce/projections');
  const { createConversationFixture, CONVERSATION_FIXTURE_BUYER, CONVERSATION_FIXTURE_SELLER } =
    await import('@/test/fixtures/commerce/conversations');
  return {
    buyer: CONVERSATION_FIXTURE_BUYER,
    seller: CONVERSATION_FIXTURE_SELLER,
    auctionProjection: createAuctionProjectionFixture(),
    conversation: createConversationFixture(),
  };
});

const view = vi.hoisted(() => ({
  conversation: null as unknown,
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: (action: () => void) => action() }),
}));

vi.mock('@/stores/auth/auth.store', async () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: (await fixtures).buyer }),
}));

vi.mock('@/hooks/useMarketplaceBid/useMarketplaceBid', async () => {
  const { useForm } = await import('react-hook-form');
  const { marketplaceBidDefaults } = await import('@/hooks/useMarketplaceBid/useMarketplaceBid.types');
  return {
    useMarketplaceBid: () => ({
      form: useForm({ defaultValues: marketplaceBidDefaults }),
      submit: vi.fn(async () => false),
      reset: vi.fn(),
    }),
  };
});

vi.mock('@/hooks/useMarketplaceOffer/useMarketplaceOffer', async () => {
  const { useForm } = await import('react-hook-form');
  const { marketplaceOfferDefaults } = await import('@/hooks/useMarketplaceOffer/useMarketplaceOffer.types');
  return {
    useMarketplaceOffer: () => ({
      form: useForm({ defaultValues: marketplaceOfferDefaults }),
      submit: vi.fn(async () => false),
      reset: vi.fn(),
    }),
  };
});

vi.mock('@/hooks/useMarketplaceMessages/useMarketplaceMessages', async () => {
  const { useForm } = await import('react-hook-form');
  const { marketplaceMessageDefaults } = await import('@/hooks/useMarketplaceMessages/useMarketplaceMessages.types');
  return {
    useMarketplaceMessages: () => ({
      form: useForm({ defaultValues: marketplaceMessageDefaults }),
      conversation: view.conversation,
      isLoading: false,
      error: null,
      isSandbox: true,
      attachment: {
        file: null,
        previewUrl: null,
        error: null,
        inputRef: { current: null },
        onInputChange: vi.fn(),
        choose: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
        upload: vi.fn(),
      },
      submit: vi.fn(async () => false),
      refresh: vi.fn(async () => {}),
    }),
  };
});

vi.mock('@/hooks/useMarketplaceAttachmentUrl/useMarketplaceAttachmentUrl', () => ({
  useMarketplaceAttachmentUrl: () => ({ url: ATTACHMENT_DATA_URL, error: null }),
}));

async function openDialog(trigger: { click: () => Promise<void> }) {
  await trigger.click();
  await vi.waitFor(() => {
    if (!document.querySelector('[role="dialog"]')) throw new Error('Dialog has not opened yet.');
  });
}

function DialogHarness({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">{children}</main>;
}

describe('Marketplace dialogs — visual regression', () => {
  it('renders the open bid dialog at desktop viewport', async () => {
    const { auctionProjection } = await fixtures;

    const screen = await renderForVRT(
      <DialogHarness>
        <MarketplaceBidDialog
          aggregateId={auctionProjection.aggregateId}
          projection={auctionProjection}
          priceAsset={USD_ASSET}
          onAccepted={() => {}}
        />
      </DialogHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Place a bid' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dialog-bid-open-desktop');
  });

  it('renders the open bid dialog at mobile viewport', async () => {
    const { auctionProjection } = await fixtures;

    const screen = await renderForVRT(
      <DialogHarness>
        <MarketplaceBidDialog
          aggregateId={auctionProjection.aggregateId}
          projection={auctionProjection}
          priceAsset={USD_ASSET}
          onAccepted={() => {}}
        />
      </DialogHarness>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await openDialog(screen.getByRole('button', { name: 'Place a bid' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dialog-bid-open-mobile');
  });

  it('renders the open offer dialog at desktop viewport', async () => {
    const { auctionProjection } = await fixtures;

    const screen = await renderForVRT(
      <DialogHarness>
        <MarketplaceOfferDialog
          aggregateId={auctionProjection.aggregateId}
          expectedRevision={3}
          priceAsset={USD_ASSET}
          askingPrice={auctionProjection.unitPrice}
          onAccepted={() => {}}
        />
      </DialogHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Make offer' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dialog-offer-open-desktop');
  });

  it('renders the open message dialog with an image attachment at desktop viewport', async () => {
    const { seller, conversation } = await fixtures;
    view.conversation = conversation;

    const screen = await renderForVRT(
      <DialogHarness>
        <MarketplaceMessageDialog sellerPubky={seller} listingId="leather_boots" />
      </DialogHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await vi.waitFor(() => {
      const image = document.querySelector<HTMLImageElement>('img[alt="Private marketplace message attachment"]');
      if (!image || !image.complete || image.naturalWidth === 0) throw new Error('Attachment has not loaded yet.');
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dialog-message-attachment-open-desktop');
  });

  it('renders the open message dialog before any messages exist at desktop viewport', async () => {
    const { seller } = await fixtures;
    view.conversation = null;

    const screen = await renderForVRT(
      <DialogHarness>
        <MarketplaceMessageDialog sellerPubky={seller} listingId="leather_boots" />
      </DialogHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Message seller' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dialog-message-empty-open-desktop');
  });
});
