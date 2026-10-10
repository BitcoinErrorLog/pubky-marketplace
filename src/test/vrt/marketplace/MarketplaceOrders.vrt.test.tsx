// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, parkVrtHover, renderForVRT, VRT_DENSE_CHROME_SCREENSHOT } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceOrders } from '@/templates/Marketplace/MarketplaceOrders';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  createOrderFixture as createUsdtSceneOrder,
  createPaymentFixture as createUsdtScenePayment,
  createReceiptFixture as createUsdtSceneReceipt,
  ORDER_FIXTURE_BUYER as USDT_SCENE_ME,
} from '@/test/fixtures/commerce/orders';
import { USDT_ORDER_FIELDS } from '@/test/fixtures/commerce/usdt-orders';

// Deterministic BTC/USD rate for the capture (1 BTC = $100,000): the "≈"
// estimates render from this fixed value, never from the network.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: (enabled: boolean) =>
    enabled ? { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') } : null,
}));

// Covers every order state and every buyer-visible payment state defined by the
// transaction contract, so a state that only appears after a timeout, a return, or
// a reconciliation still has a reviewable rendering.
const fixtures = vi.hoisted(async () => {
  const {
    createOrderFixture,
    createOrderViewsForEveryState,
    createOrderViewsForEveryPaymentState,
    createPaymentFixture,
    createReceiptFixture,
    createUsdtOrderFixture,
    ORDER_FIXTURE_BUYER,
    ORDER_FIXTURE_SELLER,
  } = await import('@/test/fixtures/commerce/orders');
  const { REFUND_FIXTURE_ADDRESS, REFUND_FIXTURE_TX_HASH } = await import('@/test/fixtures/commerce/usdt-refund.wire');
  const { VRT_FROZEN_NOW_MS, HOUR_MS } = await import('@/test-utils/vrt.clock');
  const sellerNeedsAttention = [
    createOrderFixture('pending_payment', {
      id: '018f47d2-6a27-7c23-a49d-000000000701',
      buyerPubky: 'n'.repeat(52),
      sellerPubky: ORDER_FIXTURE_BUYER,
      lines: [
        {
          listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_camera`,
          listingRevision: 1,
          contentHash: 'b'.repeat(64),
          title: 'Program-mode 35mm SLR',
          quantity: 1,
          unitPrice: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
          subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
        },
      ],
      subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
      total: { amountMinor: 16_200, currency: 'USD', exponent: 2 },
    }),
    createOrderFixture('return_requested', {
      id: '018f47d2-6a27-7c23-a49d-000000000702',
      buyerPubky: 'r'.repeat(52),
      sellerPubky: ORDER_FIXTURE_BUYER,
      lines: [
        {
          listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_boots`,
          listingRevision: 2,
          contentHash: 'c'.repeat(64),
          title: 'Handmade leather boots',
          quantity: 1,
          unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
          subtotal: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        },
      ],
    }),
  ].map((order) => ({
    order,
    payment: createPaymentFixture(order.state === 'pending_payment' ? 'awaiting_entitlement' : 'confirmed', {
      id: order.paymentId,
      orderId: order.id,
    }),
    receipt: null,
  }));

  // A completed order the buyer already reviewed; the review's age relative
  // to the frozen clock decides whether the durable-only 24h edit window is
  // still open when the screenshot is taken.
  const reviewedOrderView = (reviewAgeHours: number) => {
    const order = createOrderFixture('completed', {
      reviews: [
        {
          id: '018f47d2-6a27-7c23-a62f-000000000601',
          reviewerPubky: ORDER_FIXTURE_BUYER,
          subjectPubky: ORDER_FIXTURE_SELLER,
          rating: 5,
          text: 'Accurate and fast.',
          createdAt: new Date(VRT_FROZEN_NOW_MS - reviewAgeHours * HOUR_MS).toISOString(),
        },
      ],
    });
    return { order, payment: createPaymentFixture('confirmed'), receipt: null };
  };

  // A shipped order whose carrier the curated registry resolves (USPS), so
  // the buyer's "Track package" link renders next to the tracking facts. The
  // every-state fixtures keep the unknown carrier ("Local Courier"), whose
  // shipment line stays plain text with no link — both fallbacks get a
  // baseline.
  const trackableShippedView = () => {
    const order = createOrderFixture('shipped', {
      paymentMethod: 'bitcoin',
      paykitTotalSats: 51_637,
      merchandiseTotal: { amountMinor: 51_200, currency: 'BTC', exponent: 8 },
      bitcoinPayable: { amountMinor: 51_637, currency: 'SAT', exponent: 0 },
      subtotal: { amountMinor: 50_000, currency: 'BTC', exponent: 8 },
      shipping: { amountMinor: 1_200, currency: 'BTC', exponent: 8 },
      total: { amountMinor: 51_637, currency: 'BTC', exponent: 8 },
      lines: [
        {
          listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_shipped_bitcoin`,
          listingRevision: 1,
          contentHash: 'a'.repeat(64),
          title: 'Handmade leather boots',
          quantity: 1,
          unitPrice: { amountMinor: 50_000, currency: 'BTC', exponent: 8 },
          subtotal: { amountMinor: 50_000, currency: 'BTC', exponent: 8 },
        },
      ],
      shipment: {
        carrier: 'USPS',
        trackingNumber: '9400111899223197428490',
        state: 'shipped' as const,
        shippedAt: '2026-08-14T10:00:00.000Z',
        deliveredAt: null,
      },
    });
    return {
      order,
      payment: createPaymentFixture('confirmed', { adapter: 'paykit' }),
      receipt: createReceiptFixture({ orderId: order.id, total: order.total }),
    };
  };

  const bitcoinRefundedView = () => {
    const order = createOrderFixture('refunded_external', {
      paymentMethod: 'bitcoin',
      paykitTotalSats: 1_255,
      merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      bitcoinPayable: { amountMinor: 1_255, currency: 'SAT', exponent: 0 },
      subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
      total: { amountMinor: 1_255, currency: 'BTC', exponent: 8 },
      externalRefund: {
        amountMinor: 1_255,
        transactionId: 'txid-canary-refund',
        recordedAt: '2026-09-24T18:00:00.000Z',
      },
      lines: [
        {
          listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_refunded_bitcoin`,
          listingRevision: 1,
          contentHash: 'a'.repeat(64),
          title: 'Handmade leather boots',
          quantity: 1,
          unitPrice: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
          subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
        },
      ],
    });
    return { order, payment: createPaymentFixture('confirmed', { adapter: 'paykit' }), receipt: null };
  };

  // USDT refund address (W4): the buyer's and the seller's views of one
  // return, then the buyer's view once the seller recorded the refund.
  const usdtDestination = {
    address: REFUND_FIXTURE_ADDRESS,
    network: 'arbitrum-one' as const,
    asset: 'USDT' as const,
    source: 'buyer_entered',
    confirmedAt: '2026-10-09T16:00:00.000Z',
  };
  const usdtRefundView = (
    state: 'return_approved' | 'return_received' | 'refunded_external',
    role: 'buyer' | 'seller',
    withDestination: boolean,
  ) => {
    const order = createUsdtOrderFixture(state, {
      id: '018f47d2-6a27-7c23-a49d-000000000750',
      ...(role === 'seller' ? { buyerPubky: 'u'.repeat(52), sellerPubky: ORDER_FIXTURE_BUYER } : {}),
      ...(withDestination ? { refundDestination: usdtDestination } : {}),
      ...(state === 'refunded_external'
        ? {
            externalRefund: {
              amountMinor: 13_700,
              transactionId: REFUND_FIXTURE_TX_HASH,
              recordedAt: '2026-10-10T10:00:00.000Z',
            },
          }
        : {}),
    });
    return {
      order,
      payment: createPaymentFixture('confirmed', { id: order.paymentId, orderId: order.id }),
      receipt: null,
    };
  };

  const deliveryAssumedView = () => ({
    order: createOrderFixture('delivered', {
      id: '018f47d2-6a27-7c23-a49d-000000000703',
      deliveryAssumed: true,
      nextActor: 'none',
    }),
    payment: createPaymentFixture('confirmed'),
    receipt: null,
  });

  // Digital delivery design §3 "After payment": a delivered order with a
  // file, a text and a message-kind line, seen by its buyer.
  const digitalDeliveredView = () => {
    const base = createOrderFixture('delivered', { id: '018f47d2-6a27-7c23-a49d-000000000704', nextActor: 'none' });
    const line = base.lines[0];
    return {
      order: {
        ...base,
        fulfillment: 'digital' as const,
        shipment: null,
        shipping: { ...base.shipping, amountMinor: 0 },
        total: base.subtotal,
        lines: [
          {
            ...line,
            title: 'Field guide to film cameras (PDF)',
            fulfillment: 'digital' as const,
            digitalKind: 'file' as const,
          },
          { ...line, title: 'Darkroom timer licence', fulfillment: 'digital' as const, digitalKind: 'text' as const },
          { ...line, title: 'Portfolio review', fulfillment: 'digital' as const, digitalKind: 'message' as const },
        ],
      },
      payment: createPaymentFixture('confirmed'),
      receipt: null,
    };
  };

  // The viewer's own digital sale with an emailed and a message-kind line to
  // send by hand (§3 "Seller's orders").
  const digitalToDeliverView = () => {
    const base = createOrderFixture('paid', {
      id: '018f47d2-6a27-7c23-a49d-000000000705',
      buyerPubky: 's'.repeat(52),
      sellerPubky: ORDER_FIXTURE_BUYER,
      nextActor: 'seller',
    });
    const line = base.lines[0];
    return {
      order: {
        ...base,
        fulfillment: 'digital' as const,
        shipment: null,
        shipping: { ...base.shipping, amountMinor: 0 },
        total: base.subtotal,
        lines: [
          {
            ...line,
            title: 'Selvedge jacket sewing pattern',
            fulfillment: 'digital' as const,
            digitalKind: 'email' as const,
          },
          { ...line, title: 'Fitting call notes', fulfillment: 'digital' as const, digitalKind: 'message' as const },
        ],
      },
      payment: createPaymentFixture('confirmed'),
      receipt: null,
    };
  };

  const sellerAwaitingPayment = [
    'awaiting_entitlement',
    'detected',
    'confirmed',
    'manual_review',
    'awaiting_entitlement',
  ] as const;
  const sellerAwaitingPaymentViews = sellerAwaitingPayment.map((paymentState, index) => {
    const payment = createPaymentFixture(paymentState, {
      id: `018f47d2-6a27-7c23-a49d-0000000007${10 + index}`,
    });
    const order = createOrderFixture('pending_payment', {
      id: `018f47d2-6a27-7c23-a49d-0000000007${20 + index}`,
      paymentId: payment.id,
      buyerPubky: index === 4 ? ORDER_FIXTURE_BUYER : 's'.repeat(52),
      sellerPubky: index === 4 ? ORDER_FIXTURE_SELLER : ORDER_FIXTURE_BUYER,
      nextActor: index === 4 ? 'none' : 'buyer',
      lines: [
        {
          listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_awaiting_${index}`,
          listingRevision: 1,
          contentHash: `${index}`.repeat(64),
          title: [
            'Seller awaiting entitlement',
            'Seller detected payment',
            'Seller confirmed payment',
            'Seller manual review',
            'Buyer awaiting payment',
          ][index],
          quantity: 1,
          unitPrice: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
          subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
        },
      ],
      subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
      total: { amountMinor: 16_200, currency: 'USD', exponent: 2 },
    });
    return { order, payment, receipt: null };
  });

  const pendingDeadline = new Date(VRT_FROZEN_NOW_MS + 2 * HOUR_MS).toISOString();
  const buyerPendingPayment = [
    {
      order: createOrderFixture('pending_payment', {
        id: '018f47d2-6a27-7c23-a49d-000000000730',
        holdExpiresAt: pendingDeadline,
        nextActor: 'buyer',
        lines: [
          {
            listingAggregateId: `listing:${ORDER_FIXTURE_SELLER}_camera`,
            listingRevision: 1,
            contentHash: 'd'.repeat(64),
            title: 'Buyer pending-payment camera',
            quantity: 1,
            unitPrice: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
            subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
          },
        ],
        subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
        total: { amountMinor: 16_200, currency: 'USD', exponent: 2 },
      }),
      payment: createPaymentFixture('awaiting_entitlement'),
      receipt: null,
    },
  ];
  const sellerPendingPayment = [
    {
      order: createOrderFixture('pending_payment', {
        id: '018f47d2-6a27-7c23-a49d-000000000731',
        buyerPubky: 't'.repeat(52),
        sellerPubky: ORDER_FIXTURE_BUYER,
        // A 24-hour Bitcoin hold: placed yesterday, restocks today.
        createdAt: new Date(VRT_FROZEN_NOW_MS - 22 * HOUR_MS).toISOString(),
        holdExpiresAt: pendingDeadline,
        nextActor: 'buyer',
        lines: [
          {
            listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_zine`,
            listingRevision: 1,
            contentHash: 'e'.repeat(64),
            title: 'Seller pending-payment zine',
            quantity: 1,
            unitPrice: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
            subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
          },
        ],
        subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
        total: { amountMinor: 16_200, currency: 'USD', exponent: 2 },
      }),
      payment: createPaymentFixture('awaiting_entitlement'),
      receipt: null,
    },
  ];

  const sellerUnpaidCancelled = createOrderFixture('cancelled', {
    id: '018f47d2-6a27-7c23-a49d-000000000741',
    buyerPubky: 't'.repeat(52),
    sellerPubky: ORDER_FIXTURE_BUYER,
    receiptId: null,
    lines: [
      {
        listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_lamp`,
        listingRevision: 1,
        contentHash: 'f'.repeat(64),
        title: 'Brass desk lamp',
        quantity: 1,
        unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
        subtotal: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      },
    ],
  });
  const activityLinkedUnlisted = [
    ...sellerPendingPayment,
    { order: sellerUnpaidCancelled, payment: null, receipt: null },
  ];

  return {
    buyer: ORDER_FIXTURE_BUYER,
    activityLinkedUnlisted,
    activityLinkedUnlistedId: sellerUnpaidCancelled.id,
    everyOrderState: createOrderViewsForEveryState(),
    everyPaymentState: createOrderViewsForEveryPaymentState(),
    sellerNeedsAttention,
    reviewedInWindow: [reviewedOrderView(23)],
    reviewedOutOfWindow: [reviewedOrderView(25)],
    trackableShipped: [trackableShippedView()],
    bitcoinRefunded: [bitcoinRefundedView()],
    deliveryAssumed: [deliveryAssumedView()],
    usdtRefundBuyerNeeded: [usdtRefundView('return_approved', 'buyer', false)],
    usdtRefundBuyerConfirmed: [usdtRefundView('return_approved', 'buyer', true)],
    usdtRefundSellerConfirmed: [usdtRefundView('return_received', 'seller', true)],
    usdtRefundSellerWaiting: [usdtRefundView('return_received', 'seller', false)],
    usdtRefundBuyerRecorded: [usdtRefundView('refunded_external', 'buyer', true)],
    digitalDelivered: [digitalDeliveredView()],
    digitalToDeliver: [digitalToDeliverView()],
    sellerAwaitingPayment: sellerAwaitingPaymentViews,
    buyerPendingPayment,
    sellerPendingPayment,
    sellerBitcoinSales: [
      {
        order: createOrderFixture('pending_payment', {
          id: '018f47d2-6a27-7c23-a49d-000000000741',
          buyerPubky: 't'.repeat(52),
          sellerPubky: ORDER_FIXTURE_BUYER,
          paymentMethod: 'bitcoin',
          paykitRequestState: 'awaiting_seller_confirmation',
          paykitDeliveryState: 'delivered',
          nextActor: 'seller',
          lines: [
            {
              listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_confirm`,
              listingRevision: 1,
              contentHash: '1'.repeat(64),
              title: 'Seller confirm Bitcoin boots',
              quantity: 1,
              unitPrice: { amountMinor: 1_000, currency: 'SAT', exponent: 0 },
              subtotal: { amountMinor: 1_000, currency: 'SAT', exponent: 0 },
            },
          ],
          subtotal: { amountMinor: 1_000, currency: 'SAT', exponent: 0 },
          shipping: { amountMinor: 0, currency: 'SAT', exponent: 0 },
          total: { amountMinor: 1_303, currency: 'SAT', exponent: 0 },
        }),
        payment: createPaymentFixture('awaiting_entitlement', {
          id: '018f47d2-6a27-7c23-a49d-000000000742',
          adapter: 'paykit',
          confirmations: 0,
        }),
        receipt: null,
      },
      {
        order: createOrderFixture('pending_payment', {
          id: '018f47d2-6a27-7c23-a49d-000000000743',
          buyerPubky: 'u'.repeat(52),
          sellerPubky: ORDER_FIXTURE_BUYER,
          paymentMethod: 'bitcoin',
          paykitRequestState: 'pending',
          nextActor: 'seller',
          lines: [
            {
              listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_review`,
              listingRevision: 1,
              contentHash: '2'.repeat(64),
              title: 'Seller review Bitcoin hat',
              quantity: 1,
              unitPrice: { amountMinor: 1_000, currency: 'SAT', exponent: 0 },
              subtotal: { amountMinor: 1_000, currency: 'SAT', exponent: 0 },
            },
          ],
          subtotal: { amountMinor: 1_000, currency: 'SAT', exponent: 0 },
          shipping: { amountMinor: 0, currency: 'SAT', exponent: 0 },
          total: { amountMinor: 1_303, currency: 'SAT', exponent: 0 },
        }),
        payment: createPaymentFixture('manual_review', {
          id: '018f47d2-6a27-7c23-a49d-000000000744',
          adapter: 'paykit',
          confirmations: 0,
        }),
        receipt: null,
      },
    ],
  };
});

const ordersState = vi.hoisted(() => ({
  orders: [] as unknown[],
  isLoading: false,
  error: null as string | null,
  adapterMode: 'sandbox' as string,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/orders',
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: <T,>(action: () => T) => action() }),
}));

vi.mock('@/hooks/useUserDetails/useUserDetails', () => ({
  useUserDetails: () => ({ userDetails: null, isLoading: false }),
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

vi.mock('@/stores/auth/auth.store', async () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: (await fixtures).buyer }),
}));

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: ordersState.orders,
    isLoading: ordersState.isLoading,
    error: ordersState.error,
    adapterMode: ordersState.adapterMode,
    advancePayment: vi.fn(),
    actOnOrder: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

// The display store persists to localStorage, which the VRT browser shares
// across test files — pin the defaults so captures never depend on what a
// previously-run file left behind.
beforeEach(async () => {
  const { useMarketplaceDisplayStore } = await import('@/stores/marketplace-display/marketplace-display.store');
  useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: 'metric' });
  ordersState.adapterMode = 'sandbox';
});

describe('Marketplace orders — visual regression', () => {
  it('renders every order state at desktop viewport', async () => {
    const { everyOrderState } = await fixtures;
    ordersState.orders = everyOrderState;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-every-state-desktop');
  });

  it('renders every order state at mobile viewport', async () => {
    const { everyOrderState } = await fixtures;
    ordersState.orders = everyOrderState;
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_MOBILE });
    const tabList = screen.container.querySelector('[role="tablist"]') as HTMLElement;
    tabList.scrollLeft = 0;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    tabList.scrollLeft = 0;
    expect(tabList.scrollLeft).toBe(0);
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-every-state-mobile');
  });

  it('renders seller orders that need attention at desktop viewport', async () => {
    const { sellerNeedsAttention } = await fixtures;
    ordersState.orders = sellerNeedsAttention;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-needs-attention-desktop');
  });

  it('renders a shipped order with a carrier tracking link at desktop viewport', async () => {
    const { trackableShipped } = await fixtures;
    ordersState.orders = trackableShipped;
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByText('Receipt', { exact: true }).click();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-shipped-track-link-desktop');
  });

  it('renders a refunded Bitcoin order with the payment-code equation', async () => {
    const { bitcoinRefunded } = await fixtures;
    ordersState.orders = bitcoinRefunded;
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByTestId('order-refund-record')).toBeVisible();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-bitcoin-refund-desktop');
  });

  it('renders the buyer asking for a USDT refund address at desktop viewport', async () => {
    const { usdtRefundBuyerNeeded } = await fixtures;
    ordersState.orders = usdtRefundBuyerNeeded;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByTestId('usdt-refund-buyer')).toBeVisible();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-usdt-refund-buyer-needed-desktop',
    );
  });

  it('renders the buyer asking for a USDT refund address at mobile viewport', async () => {
    const { usdtRefundBuyerNeeded } = await fixtures;
    ordersState.orders = usdtRefundBuyerNeeded;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect.element(screen.getByTestId('usdt-refund-buyer')).toBeVisible();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-usdt-refund-buyer-needed-mobile',
    );
  });

  it('renders the buyer with a confirmed USDT refund address at desktop viewport', async () => {
    const { usdtRefundBuyerConfirmed } = await fixtures;
    ordersState.orders = usdtRefundBuyerConfirmed;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByTestId('usdt-refund-destination')).toBeVisible();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-usdt-refund-buyer-confirmed-desktop',
    );
  });

  it('renders the seller waiting for the buyer USDT refund address at desktop viewport', async () => {
    const { usdtRefundSellerWaiting } = await fixtures;
    ordersState.orders = usdtRefundSellerWaiting;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByTestId('usdt-refund-seller')).toBeVisible();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-usdt-refund-seller-waiting-desktop',
    );
  });

  it('renders the seller with the buyer USDT refund address and amount at desktop viewport', async () => {
    const { usdtRefundSellerConfirmed } = await fixtures;
    ordersState.orders = usdtRefundSellerConfirmed;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByTestId('usdt-refund-amount')).toBeVisible();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-usdt-refund-seller-confirmed-desktop',
    );
  });

  it('renders a recorded USDT refund as recorded by the seller at desktop viewport', async () => {
    const { usdtRefundBuyerRecorded } = await fixtures;
    ordersState.orders = usdtRefundBuyerRecorded;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByTestId('order-refund-record')).toHaveTextContent('The seller recorded a refund');
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-usdt-refund-recorded-desktop');
  });

  it('renders an assumed-delivery order at desktop viewport', async () => {
    const { deliveryAssumed } = await fixtures;
    ordersState.orders = deliveryAssumed;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-delivery-assumed-desktop');
  });

  it('renders a delivered digital order with the buyer purchase panel at desktop viewport', async () => {
    const { digitalDelivered } = await fixtures;
    ordersState.orders = digitalDelivered;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-digital-delivered-desktop');
    await expect(await expectVrtSurface('order-digital-panel')).toMatchScreenshot('orders-digital-panel-desktop');
  });

  it('renders a paid digital sale the seller delivers by hand at desktop viewport', async () => {
    const { digitalToDeliver } = await fixtures;
    ordersState.orders = digitalToDeliver;
    ordersState.isLoading = false;
    ordersState.error = null;
    const evidence = vi.spyOn(CommerceController, 'fetchOrderDigitalEvidence').mockResolvedValue({
      orderId: digitalToDeliver[0].order.id,
      deliveredAt: null,
      firstOpenedAt: null,
      openCount: 0,
      emailedAt: null,
      messageDeliveredAt: null,
    });

    try {
      await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
      await expect.poll(() => evidence.mock.calls.length).toBeGreaterThan(0);
      await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-digital-to-deliver-desktop');
      await expect(await expectVrtSurface('order-seller-digital-panel')).toMatchScreenshot(
        'orders-seller-digital-panel-desktop',
      );
    } finally {
      evidence.mockRestore();
    }
  });

  it('renders a seller delivery record that failed to load at desktop viewport', async () => {
    const { digitalToDeliver } = await fixtures;
    ordersState.orders = digitalToDeliver;
    ordersState.isLoading = false;
    ordersState.error = null;
    const evidence = vi.spyOn(CommerceController, 'fetchOrderDigitalEvidence').mockRejectedValue(new Error('network'));

    try {
      const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
      await expect.element(screen.getByTestId('seller-digital-evidence-failed')).toBeVisible();
      await expect(await expectVrtSurface('order-seller-digital-panel')).toMatchScreenshot(
        'orders-seller-digital-evidence-failed-desktop',
      );
    } finally {
      evidence.mockRestore();
    }
  });

  it('renders every buyer-visible payment state at desktop viewport', async () => {
    const { everyPaymentState } = await fixtures;
    ordersState.orders = everyPaymentState;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-payment-states-desktop');
  });

  it('renders seller awaiting-payment rows as Reservations at desktop viewport', async () => {
    const { sellerAwaitingPayment } = await fixtures;
    ordersState.orders = sellerAwaitingPayment;
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByRole('heading', { name: 'Reservations' })).toBeVisible();
    expect(screen.getByText('Seller awaiting entitlement')).toBeInTheDocument();
    expect(screen.getByText('Seller detected payment')).toBeInTheDocument();
    expect(screen.getByText('Seller confirmed payment')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue checkout' })).toBeInTheDocument();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-awaiting-payment-seller-desktop',
    );
  });

  it('renders seller awaiting-payment rows as Reservations at mobile viewport', async () => {
    const { sellerAwaitingPayment } = await fixtures;
    ordersState.orders = sellerAwaitingPayment;
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect.element(screen.getByRole('heading', { name: 'Reservations' })).toBeVisible();
    expect(screen.getByText('Seller awaiting entitlement')).toBeInTheDocument();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-awaiting-payment-seller-mobile',
    );
  });

  it('renders a buyer pending-payment checkout with Continue checkout at desktop viewport', async () => {
    const { buyerPendingPayment } = await fixtures;
    ordersState.orders = buyerPendingPayment;
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByRole('heading', { name: 'Checkout in progress' })).toBeVisible();
    await expect.element(screen.getByText('Buyer pending-payment camera')).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Continue checkout' })).toBeVisible();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-pending-payment-buyer-desktop',
    );
  });

  it('renders a bound Bitcoin sale awaiting confirmation on the sales card', async () => {
    const { sellerBitcoinSales } = await fixtures;
    ordersState.orders = [sellerBitcoinSales[0]];
    ordersState.adapterMode = 'transaction-service';
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByText(/Confirm you received/)).toBeVisible();
    await expect.element(screen.getByRole('heading', { name: 'Reservations' })).not.toBeInTheDocument();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-seller-bitcoin-confirm-desktop',
    );
  });

  it('renders a bound Bitcoin sale in review on the sales card', async () => {
    const { sellerBitcoinSales } = await fixtures;
    ordersState.orders = [sellerBitcoinSales[1]];
    ordersState.adapterMode = 'transaction-service';
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByText('Resolve Bitcoin payment review')).toBeVisible();
    await expect.element(screen.getByRole('heading', { name: 'Reservations' })).not.toBeInTheDocument();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-seller-bitcoin-resolve-desktop',
    );
  });

  it('renders a seller pending-payment reservation at desktop viewport', async () => {
    const { sellerPendingPayment } = await fixtures;
    ordersState.orders = sellerPendingPayment;
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByRole('heading', { name: 'Reservations' })).toBeVisible();
    await expect.element(screen.getByText('Seller pending-payment zine')).toBeVisible();
    await expect.element(screen.getByText('Held for a buyer · restocks Jan 1, 2026, 2:00 PM UTC')).toBeVisible();
    await expect.element(screen.getByTestId('order-placed-at')).toHaveTextContent('Placed Dec 31, 2025, 2:00 PM UTC');
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-pending-payment-seller-desktop',
    );
  });

  for (const [label, viewport] of [
    ['desktop', VRT_VIEWPORT_DESKTOP],
    ['mobile', VRT_VIEWPORT_MOBILE],
  ] as const) {
    it(`renders an Activity-linked unpaid cancel the page does not list at ${label} viewport`, async () => {
      const { activityLinkedUnlisted, activityLinkedUnlistedId } = await fixtures;
      ordersState.orders = activityLinkedUnlisted;
      ordersState.isLoading = false;
      ordersState.error = null;
      const previous = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.history.replaceState(null, '', `${window.location.pathname}#order-${activityLinkedUnlistedId}`);
      try {
        const screen = await renderForVRT(<MarketplaceOrders />, { viewport });
        await expect.element(screen.getByRole('heading', { name: 'From Activity' })).toBeVisible();
        await expect.element(screen.getByText('Cancelled before payment')).toBeVisible();
        await expect.element(screen.getByText('Order 018f47d2').first()).toBeVisible();
        await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
          `orders-activity-linked-unlisted-${label}`,
        );
      } finally {
        window.history.replaceState(null, '', previous);
      }
    });
  }

  it('rejects an incorrect production surface marker', async () => {
    ordersState.orders = [];
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    expect(() => expectVrtSurface('wrong-marketplace-orders')).toThrow(/no production \[data-surface/);
  });

  it('renders the loading state at desktop viewport', async () => {
    ordersState.orders = [];
    ordersState.isLoading = true;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-loading-desktop');
  });

  it('renders the empty state at desktop viewport', async () => {
    ordersState.orders = [];
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-empty-desktop');
  });

  it('renders the error state at desktop viewport', async () => {
    ordersState.orders = [];
    ordersState.isLoading = false;
    ordersState.error = 'Transaction service is unavailable.';

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-error-desktop');
  });

  // Durable transaction-service mode: no simulate-payment buttons, no cancel
  // affordances (unported command), and the honest awaiting-payment note.
  it('renders durable-mode payment states without simulate affordances at desktop viewport', async () => {
    const { everyPaymentState } = await fixtures;
    ordersState.orders = everyPaymentState;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-durable-payment-states-desktop',
    );
    ordersState.adapterMode = 'sandbox';
  });

  // `review.update` is durable-only with a 24-hour window from the review's
  // creation: inside the window the reviewer gets an Edit review affordance;
  // once the window closes the affordance is absent instead of failing on
  // submit.
  it('offers review editing inside the 24-hour window in transaction-service mode at desktop viewport', async () => {
    const { reviewedInWindow } = await fixtures;
    ordersState.orders = reviewedInWindow;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await parkVrtHover();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-review-edit-in-window-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
    ordersState.adapterMode = 'sandbox';
  });

  it('withholds review editing once the 24-hour window has closed at desktop viewport', async () => {
    const { reviewedOutOfWindow } = await fixtures;
    ordersState.orders = reviewedOutOfWindow;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await parkVrtHover();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot(
      'orders-review-edit-out-of-window-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
    ordersState.adapterMode = 'sandbox';
  });

  it('renders the no-backend state at desktop viewport', async () => {
    ordersState.orders = [];
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'unavailable';

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-no-backend-desktop');
    ordersState.adapterMode = 'sandbox';
  });

  it('renders the order message CTA at desktop viewport', async () => {
    const { deliveryAssumed } = await fixtures;
    ordersState.orders = deliveryAssumed;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(await expectVrtSurface('marketplace-order-message-cta')).toMatchScreenshot(
      'orders-message-cta-desktop',
    );
  });

  it('renders the order message CTA at mobile viewport', async () => {
    const { deliveryAssumed } = await fixtures;
    ordersState.orders = deliveryAssumed;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(await expectVrtSurface('marketplace-order-message-cta')).toMatchScreenshot(
      'orders-message-cta-mobile',
    );
  });
});

describe('Marketplace orders — USDT orders', () => {
  function usdtView(
    id: string,
    title: string,
    role: 'buyer' | 'seller',
    finality: 'pending' | 'final' | 'reverted',
    withReceipt = false,
  ) {
    const order = createUsdtSceneOrder('paid', {
      id,
      paymentId: `${id}-payment`,
      buyerPubky: role === 'buyer' ? USDT_SCENE_ME : 'n'.repeat(52),
      sellerPubky: role === 'seller' ? USDT_SCENE_ME : 's'.repeat(52),
      nextActor: role === 'seller' ? 'seller' : 'none',
      lines: [
        {
          listingAggregateId: `listing:${'s'.repeat(52)}_${id}`,
          listingRevision: 1,
          contentHash: 'd'.repeat(64),
          title,
          quantity: 1,
          unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
          subtotal: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        },
      ],
      ...USDT_ORDER_FIELDS,
      paymentFinality: finality,
    });
    return {
      order,
      payment: createUsdtScenePayment('confirmed', { id: order.paymentId, orderId: order.id, adapter: 'paykit' }),
      receipt: withReceipt ? createUsdtSceneReceipt({ orderId: order.id }) : null,
    };
  }

  it('renders USDT sales held until Arbitrum finalizes, and a re-checked payment, at desktop viewport', async () => {
    ordersState.orders = [
      usdtView('018f47d2-6a27-7c23-a49d-000000000811', 'USDT sale waiting for finality', 'seller', 'pending'),
      usdtView('018f47d2-6a27-7c23-a49d-000000000812', 'USDT sale ready to ship', 'seller', 'final'),
      usdtView('018f47d2-6a27-7c23-a49d-000000000813', 'USDT sale being re-checked', 'seller', 'reverted'),
    ];
    ordersState.adapterMode = 'transaction-service';
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect.element(screen.getByText('USDT sale waiting for finality × 1')).toBeVisible();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-usdt-seller-finality-desktop');
  });

  it('renders a final USDT purchase with its receipt and paid-as line at desktop viewport', async () => {
    ordersState.orders = [usdtView('018f47d2-6a27-7c23-a49d-000000000821', 'USDT purchase', 'buyer', 'final', true)];
    ordersState.adapterMode = 'transaction-service';
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByText('Receipt', { exact: true }).click();
    await expect.element(screen.getByTestId('order-receipt-usdt-paid-as')).toBeVisible();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-usdt-buyer-receipt-desktop');
  });

  it('renders a USDT purchase received but not yet final at mobile viewport', async () => {
    ordersState.orders = [usdtView('018f47d2-6a27-7c23-a49d-000000000831', 'USDT purchase', 'buyer', 'pending')];
    ordersState.adapterMode = 'transaction-service';
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect.element(screen.getByTestId('usdt-phase-copy')).toBeVisible();
    await expect(await expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-usdt-buyer-received-mobile');
  });
});
