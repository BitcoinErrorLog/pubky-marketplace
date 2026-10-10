// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP } from '@/test-utils/vrt.viewports';
import { MarketplaceCheckout } from '@/templates/Marketplace/MarketplaceCheckout';
import { MarketplaceOrders } from '@/templates/Marketplace/MarketplaceOrders';
import { MarketplaceListingCard } from '@/organisms/Marketplace/MarketplaceListingCard';
import { MarketplacePickupDetailsEditor } from '@/organisms/Marketplace/MarketplacePickupDetailsEditor';

// Deterministic BTC/USD rate for the capture (1 BTC = $100,000): the "≈"
// estimates render from this fixed value, never from the network.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: (enabled: boolean) =>
    enabled ? { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') } : null,
}));

// Cart rows show the listing's cover photo; a deterministic data-URI keeps
// the capture free of network fetches.
const MEDIA_DATA_URL = vi.hoisted(
  () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=',
);

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks((uri) => (uri ? MEDIA_DATA_URL : null));
});

const fixtures = vi.hoisted(async () => {
  const { MaskedPickupDetails } = await import('@/libs/commerce/pickup');
  const { createOrderFixture, createPaymentFixture, ORDER_FIXTURE_BUYER, ORDER_FIXTURE_SELLER } =
    await import('@/test/fixtures/commerce/orders');
  const { createCommerceListingFixture } = await import('@/test/fixtures/commerce/commerce');
  const { toCommerceListingModel } = await import('@/test/fixtures/commerce/listing-models');

  const spotSnapshot = {
    kind: 'spot' as const,
    spot: 'Central Station, north entrance',
    instructions: 'Ring the bell twice; weekdays after 18:00.',
    availability: {
      windows: [{ day: 'sat' as const, start: '10:00', end: '14:00' }],
      zone: 'Europe/Berlin',
    },
  };

  // The seller's owner read (§A4): current details at version 3.
  const ownerRead = {
    listingAggregateId: `listing:${'y'.repeat(52)}_boots_01`,
    current: {
      details: MaskedPickupDetails.wrap(spotSnapshot),
      version: 3,
      updatedAt: '2026-08-19T20:00:00.000Z',
    },
    lastVersion: 3,
  };

  const pickupOrder = createOrderFixture('ready_for_pickup', {
    fulfillment: 'pickup',
    nextActor: 'buyer',
    lines: [
      {
        listingAggregateId: `listing:${ORDER_FIXTURE_SELLER}_boots`,
        listingRevision: 2,
        contentHash: 'a'.repeat(64),
        title: 'Handmade leather boots',
        quantity: 1,
        unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        subtotal: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        fulfillment: 'pickup',
        versionAtPayment: 2,
      },
    ],
  });

  // The pinned snapshot the reveal read serves (§A3) — here flagged as
  // changed since payment, so the notice renders in the baseline.
  const reveal = {
    orderId: pickupOrder.id,
    firstRevealedAt: '2026-08-19T21:00:00.000Z',
    lines: [
      {
        lineIndex: 0,
        listingAggregateId: `listing:${ORDER_FIXTURE_SELLER}_boots`,
        version: 2,
        currentVersion: 3,
        updatedSincePayment: true,
        withdrawnBySeller: false,
        updatedAt: '2026-08-10T09:00:00.000Z',
        details: MaskedPickupDetails.wrap(spotSnapshot),
      },
    ],
  };

  const pickupListing = toCommerceListingModel(
    createCommerceListingFixture({
      // Publishes BOTH methods, so the cart offers the fulfillment choice.
      fulfillmentMethods: ['physical', 'shipping', 'pickup'],
      variants: [{ id: 'variant_42', options: { size: '42' }, quantity: 3, mediaIds: ['image_01'], enabled: true }],
    }),
  );

  // The fulfillment-badge vocabulary on catalog cards (§A1): the shared
  // fixtures default to shipping (what production emits), so both pickup
  // labels are pinned by EXPLICIT overrides — a pickup-only listing and a
  // both-ways one — next to the default shipped control.
  const { catalogItemFromCatalogEntry } = await import('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils');
  const { createCommerceCatalogEntryFixture } = await import('@/test/fixtures/commerce/commerce');
  const badgeCards = [
    catalogItemFromCatalogEntry(
      createCommerceCatalogEntryFixture({
        id: `${'y'.repeat(52)}:pickup_only_boots`,
        listing_id: 'pickup_only_boots',
        title: 'Pickup-only vintage boots',
        fulfillment_methods: ['pickup'],
      }),
    ),
    catalogItemFromCatalogEntry(
      createCommerceCatalogEntryFixture({
        id: `${'y'.repeat(52)}:both_ways_boots`,
        listing_id: 'both_ways_boots',
        title: 'Boots you can collect or have shipped',
        fulfillment_methods: ['shipping', 'pickup'],
      }),
    ),
    catalogItemFromCatalogEntry(createCommerceCatalogEntryFixture()),
  ];

  return {
    ownerRead,
    reveal,
    badgeCards,
    buyer: ORDER_FIXTURE_BUYER,
    pickupOrderView: [
      {
        order: pickupOrder,
        payment: createPaymentFixture('confirmed', { id: pickupOrder.paymentId, orderId: pickupOrder.id }),
        receipt: null,
      },
    ],
    pickupCartItems: [
      {
        id: `${pickupListing.id}:variant_42`,
        listingId: pickupListing.id,
        variantId: 'variant_42',
        quantity: 1,
        listing: pickupListing,
      },
    ],
  };
});

const view = vi.hoisted(() => ({
  orders: [] as unknown[],
  cartItems: [] as unknown[],
  pathname: '/marketplace/orders',
}));

// The controller seam: the studio reads the capability + owner read; the
// order card's reveal dialog reads the pinned snapshot; the cart's checkout
// hook reads the capability and the address book. HTTP-shaped fixtures
// mirror the service's pickup_test.rs responses (owner read + reveal).
vi.mock('@/controllers/commerce/commerce', async () => {
  const { createMarketplaceVrtCommerceController } = await import('@/test/mocks/marketplace-vrt');
  return {
    CommerceController: {
      ...createMarketplaceVrtCommerceController(),
      fetchPickupAvailable: vi.fn(async () => true),
      fetchSellerPickupDetails: vi.fn(async () => (await fixtures).ownerRead),
      fetchPickupReveal: vi.fn(async () => (await fixtures).reveal),
      // The badge-cards scene renders real listing cards: their favorite
      // toggle reads through the controller seam.
      isFavorite: vi.fn(async () => false),
      // The checkout scene runs the REAL useMarketplaceCheckout (no wholesale mock):
      // the fulfillment derivation is exercised from the listing fixtures.
      hasActiveMarketplaceSession: vi.fn(() => true),
      clearMarketplaceSession: vi.fn(),
      getDeliveryAddresses: vi.fn(async () => []),
      getSellerPaymentConfig: vi.fn(async () => ({
        bitcoinAvailable: true,
        bitcoinOfferAvailable: true,
        paypalAvailable: true,
      })),
      getIndicativeBtcRate: vi.fn(async () => null),
    },
  };
});

vi.mock('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect', () => ({
  useMarketplaceSessionConnect: () => ({
    status: 'idle',
    authorizationUrl: '',
    errorMessage: null,
    requestsFullGrant: true,
    requestsGrantReconnect: false,
    start: vi.fn(),
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: false,
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => view.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/stores/auth/auth.store', async () => {
  const { createMarketplaceVrtAuthStore } = await import('@/test/mocks/marketplace-vrt');
  return {
    useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: (await fixtures).buyer }),
  };
});

vi.mock('@/stores/commerce/commerce.store', () => ({
  useCommerceStore: (
    selector: (state: { receiptsPublicationStatus: string; usdtRefusals: Record<string, string> }) => unknown,
  ) => selector({ receiptsPublicationStatus: 'idle', usdtRefusals: {} }),
}));

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: view.orders,
    isLoading: false,
    error: null,
    needsSession: false,
    adapterMode: 'transaction-service',
    advancePayment: vi.fn(),
    actOnOrder: vi.fn(async () => true),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({ offers: [], isLoading: false, refresh: vi.fn(async () => {}) }),
}));

vi.mock('@/hooks/useMarketplaceOfferCheckout/useMarketplaceOfferCheckout', () => ({
  useMarketplaceOfferCheckout: () => ({ submit: vi.fn(), isSubmitting: false }),
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 3,
}));

vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 2,
}));

vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMarketplaceCart/useMarketplaceCart')>();
  const { sumMoneyByAsset } = await import('@/libs/commerce/pricing');
  return {
    ...actual,
    useMarketplaceCart: () => {
      const items = view.cartItems as Array<{
        listingId: string;
        quantity: number;
        variantId: string;
        listing: {
          record: {
            variants: Array<{
              id: string;
              priceOverride?: { amountMinor: number; currency: string; exponent: number };
            }>;
            sale: { format: string; unitPrice?: { amountMinor: number; currency: string; exponent: number } };
          };
        };
      }>;
      return {
        items,
        ordinaryItems: items,
        awardItems: [],
        itemCount: items.reduce((total, item) => total + item.quantity, 0),
        subtotals: sumMoneyByAsset(
          items.flatMap((item) => {
            const variant = item.listing.record.variants.find(({ id }) => id === item.variantId);
            const price =
              variant?.priceOverride ??
              (item.listing.record.sale.format === 'fixed_price' ? item.listing.record.sale.unitPrice : null);
            return price ? [{ money: price, quantity: item.quantity }] : [];
          }),
        ),
        isLoading: false,
        add: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn(),
        groups: actual.groupMarketplaceCartItems(items as never),
      };
    },
  };
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

vi.mock('@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary', () => ({
  useMarketplaceSellerSummary: () => ({
    shop: null,
    reputation: { status: 'new_seller' },
    displayName: 'Satoshi Vintage',
  }),
}));

vi.mock('@/organisms/Marketplace/MarketplacePaymentStatusCard', () => ({
  MarketplacePaymentStatusCard: () => null,
}));

vi.mock('@/organisms/Marketplace/MarketplaceMyReviews', () => ({
  MarketplaceMyReviews: () => null,
}));

// The display store persists to localStorage, which the VRT browser shares
// across test files — pin the defaults so captures never depend on what a
// previously-run file left behind.
beforeEach(async () => {
  const { useMarketplaceDisplayStore } = await import('@/stores/marketplace-display/marketplace-display.store');
  useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: 'metric' });
  view.orders = [];
  view.cartItems = [];
  view.pathname = '/marketplace/orders';
  window.history.replaceState(null, '', '/marketplace/orders');
});

describe('Marketplace local pickup — visual regression', () => {
  it('renders the sell studio pickup-details section with the saved version counter', async () => {
    await renderForVRT(
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
        <MarketplacePickupDetailsEditor listingId="boots_01" />
      </main>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    // The owner read resolves async; wait for the hydrated field.
    await vi.waitFor(() => {
      const input = document.querySelector('[data-surface="pickup-details-editor"] input');
      if ((input as HTMLInputElement | null)?.value !== 'Central Station, north entrance') {
        throw new Error('The owner read has not hydrated the editor yet.');
      }
    });
    await expect(await expectVrtSurface('pickup-details-editor')).toMatchScreenshot('studio-pickup-details-desktop');
  });

  it('renders the pickup order card with the meeting-point reveal dialog open', async () => {
    const { pickupOrderView } = await fixtures;
    view.orders = pickupOrderView;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByRole('button', { name: 'Show meeting point' }).click();
    await vi.waitFor(() => {
      if (!document.querySelector('[data-surface="pickup-reveal-dialog"]')) {
        throw new Error('The reveal dialog has not opened yet.');
      }
    });
    // The dialog's open-auto-focus paints differently per browser/session;
    // blur so the capture is deterministic (the packing-slip VRT pattern).
    (document.activeElement as HTMLElement | null)?.blur();
    await expect(await expectVrtSurface('pickup-reveal-dialog')).toMatchScreenshot('orders-pickup-reveal-desktop');
  });

  it('renders the checkout with a pickup group: the choice, the note, no address step', async () => {
    const { pickupCartItems } = await fixtures;
    view.cartItems = pickupCartItems;
    view.pathname = '/marketplace/checkout';
    window.history.replaceState(null, '', '/marketplace/checkout');

    const screen = await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    // The REAL checkout hook derives the group's options from the listing
    // fixture (publishes shipping AND pickup) — the capture chooses pickup
    // through the rendered select, never a mocked derivation.
    const sellerPubky = 'y'.repeat(52);
    await vi.waitFor(() => {
      const select = screen.container.querySelector(`[aria-label="Fulfillment for items from ${sellerPubky}"]`);
      if (!select?.textContent?.includes('Ship it')) {
        throw new Error('The fulfillment choice has not hydrated yet.');
      }
    });
    const select = screen.container.querySelector<HTMLElement>(
      `[aria-label="Fulfillment for items from ${sellerPubky}"]`,
    )!;
    select.click();
    await vi.waitFor(() => {
      if (![...document.querySelectorAll('[role="option"]')].some((option) => option.textContent === 'Local pickup')) {
        throw new Error('The Local pickup option has not opened yet.');
      }
    });
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === 'Local pickup')!
      .click();
    await vi.waitFor(() => {
      if (!document.querySelector('[data-surface="checkout-pickup-group"]')) {
        throw new Error('The pickup group has not rendered yet.');
      }
    });
    await expect(await expectVrtSurface('checkout-pickup-group')).toMatchScreenshot('checkout-pickup-group-desktop');
  });

  it('renders the fulfillment badge vocabulary on cards: Local pickup, Pickup or shipping, Shipping', async () => {
    const { badgeCards } = await fixtures;
    const screen = await renderForVRT(
      <div className="grid grid-cols-3 gap-5 p-6">
        {badgeCards.map((listing) => (
          <MarketplaceListingCard key={listing.id} listing={listing} shopName="Satoshi Vintage" />
        ))}
      </div>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-cards-fulfillment-badges-desktop');
  });

  it('rejects a scene without a production data-surface root', async () => {
    await renderForVRT(<main data-testid="stand-in">A test stand-in with no production surface.</main>, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    expect(() => expectVrtSurface('pickup-details-editor')).toThrow(/no production \[data-surface/);
    expect(() => expectVrtSurface('pickup-reveal-dialog')).toThrow(/no production \[data-surface/);
    expect(() => expectVrtSurface('checkout-pickup-group')).toThrow(/no production \[data-surface/);
  });
});
