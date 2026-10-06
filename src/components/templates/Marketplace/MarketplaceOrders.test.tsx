import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { REFUND_ORDER_NOTICES } from '@/libs/commerce/refund-copy';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';
import {
  createOrderFixture,
  createPaymentFixture,
  createReceiptFixture,
  ORDER_FIXTURE_BUYER,
  ORDER_FIXTURE_SELLER,
} from '@/test/fixtures/commerce/orders';
import { setHeavySuiteBudgets } from '@/test-utils/load-budget';
import { MarketplaceOrders } from './MarketplaceOrders';

setHeavySuiteBudgets();

const CURRENT_USER = ORDER_FIXTURE_BUYER;
const OTHER_USER = 'o'.repeat(52);

const ordersState = vi.hoisted(() => ({
  currentUserPubky: 'b'.repeat(52),
  orders: [] as unknown[],
  adapterMode: 'sandbox' as string,
  needsSession: false,
  error: null as string | null,
}));

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: ordersState.orders,
    isLoading: false,
    error: ordersState.error,
    needsSession: ordersState.needsSession,
    adapterMode: ordersState.adapterMode,
    refresh: vi.fn(),
    advancePayment: vi.fn(),
    actOnOrder: vi.fn(),
  }),
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

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: (enabled: boolean) =>
    enabled ? { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-09-13T20:00:00Z') } : null,
}));

vi.mock('@/organisms/Marketplace/MarketplaceIndicativePrice', () => ({
  MarketplaceIndicativePrice: ({ money }: { money: { currency: string } }) =>
    money.currency === 'USD' ? <span>≈ ₿137,000</span> : null,
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { currentUserPubky: string }) => unknown) =>
      selector({ currentUserPubky: ordersState.currentUserPubky }),
    {
      getState: () => ({
        currentUserPubky: ordersState.currentUserPubky,
        selectCurrentUserPubky: () => ordersState.currentUserPubky,
      }),
      setState: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}));

vi.mock('@/stores/commerce/commerce.store', () => ({
  useCommerceStore: (selector: (state: { receiptsPublicationStatus: string }) => unknown) =>
    selector({ receiptsPublicationStatus: 'idle' }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/organisms/Marketplace/MarketplacePaymentStatusCard', () => ({
  MarketplacePaymentStatusCard: () => <div data-testid="payment-status" />,
}));

vi.mock('@/organisms/Marketplace/MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: ({ triggerLabel }: { triggerLabel: string }) => <button>{triggerLabel}</button>,
}));

vi.mock('@/organisms/Marketplace/MarketplaceMyReviews', () => ({
  MarketplaceMyReviews: () => <div data-testid="my-reviews" />,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/marketplace/orders',
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useMarketplaceDisplayStore.setState({ showFxEstimate: false, measurementSystem: null });
});

function orderView(
  state: Parameters<typeof createOrderFixture>[0],
  title: string,
  role: 'buyer' | 'seller',
  overrides: Partial<ReturnType<typeof createOrderFixture>> = {},
  paymentState: Parameters<typeof createPaymentFixture>[0] = 'confirmed',
  paymentOverride: ReturnType<typeof createPaymentFixture> | null | undefined = undefined,
) {
  const id = `test-${title.toLowerCase().replaceAll(' ', '-')}`;
  const order = createOrderFixture(state, {
    id,
    paymentId: `${id}-payment`,
    buyerPubky: role === 'buyer' ? CURRENT_USER : OTHER_USER,
    sellerPubky: role === 'seller' ? CURRENT_USER : ORDER_FIXTURE_SELLER,
    lines: [
      {
        listingAggregateId: `listing:${ORDER_FIXTURE_SELLER}_${title.replaceAll(' ', '_')}`,
        listingRevision: 1,
        contentHash: 'a'.repeat(64),
        title,
        quantity: 1,
        unitPrice: { amountMinor: 10_000, currency: 'USD', exponent: 2 },
        subtotal: { amountMinor: 10_000, currency: 'USD', exponent: 2 },
      },
    ],
    ...overrides,
  });
  return {
    order,
    payment:
      paymentOverride === undefined
        ? createPaymentFixture(paymentState, { id: order.paymentId, orderId: order.id })
        : paymentOverride,
    receipt: null,
  };
}

describe('MarketplaceOrders tabs', () => {
  beforeEach(() => {
    ordersState.currentUserPubky = CURRENT_USER;
    ordersState.orders = [];
    ordersState.adapterMode = 'sandbox';
    ordersState.needsSession = false;
    ordersState.error = null;
    useMarketplaceDisplayStore.setState({ showFxEstimate: false, measurementSystem: null });
  });

  it('defaults to All when the user has seller orders without a next actor', async () => {
    ordersState.orders = [
      orderView('paid', 'Sold paid boots', 'seller', { nextActor: 'none' }),
      orderView('shipped', 'Bought shipped jacket', 'buyer', { nextActor: 'none' }),
    ];

    render(<MarketplaceOrders />);

    await waitFor(() => expect(screen.getByRole('tab', { name: /All 2/i })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText(/Sold paid boots/)).toBeInTheDocument();
    expect(screen.getByText(/Bought shipped jacket/)).toBeInTheDocument();
  });

  it('defaults to All when seller orders have no service actor', async () => {
    ordersState.orders = [
      orderView('paid', 'Sold paid boots', 'seller', { nextActor: 'none' }),
      orderView('return_requested', 'Sold return requested gloves', 'seller', { nextActor: 'none' }),
      orderView('pending_payment', 'Bought pending jacket', 'buyer', { nextActor: 'none' }),
    ];

    render(<MarketplaceOrders />);

    await waitFor(() => expect(screen.getByRole('tab', { name: /All 2/i })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText(/Sold return requested gloves/)).toBeInTheDocument();
    expect(screen.getByText(/Sold paid boots/)).toBeInTheDocument();
    expect(screen.getByText(/Bought pending jacket/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue checkout' })).toBeInTheDocument();
  });

  it('does not infer an action tab for a seller pending payment without a service actor', () => {
    ordersState.orders = [
      orderView('pending_payment', 'Sold pending boots', 'seller', { nextActor: 'none' }, 'awaiting_entitlement'),
    ];

    render(<MarketplaceOrders />);

    expect(screen.getByRole('heading', { name: 'Reservations' })).toBeInTheDocument();
    expect(screen.getByText(/Sold pending boots/)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('defaults to All when the user has no seller orders', () => {
    ordersState.orders = [
      orderView('pending_payment', 'Bought pending boots', 'buyer', { nextActor: 'none' }),
      orderView('shipped', 'Bought shipped jacket', 'buyer', { nextActor: 'none' }),
    ];

    render(<MarketplaceOrders />);

    expect(screen.getByRole('tab', { name: /All 1/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Bought pending boots/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue checkout' })).toBeInTheDocument();
    expect(screen.getByText(/Bought shipped jacket/)).toBeInTheDocument();
  });

  const renderTabFilterFixture = async () => {
    ordersState.orders = [
      orderView('paid', 'Sold paid boots', 'seller', { nextActor: 'none' }),
      orderView('paid', 'Bought paid coat', 'buyer', { nextActor: 'none' }),
      orderView('shipped', 'Sold shipped bag', 'seller', { nextActor: 'none' }),
      orderView('delivered', 'Bought delivered hat', 'buyer', { nextActor: 'none' }),
      orderView('completed', 'Bought completed scarf', 'buyer'),
      orderView('refunded_external', 'Sold refunded belt', 'seller'),
      orderView('cancelled', 'Bought cancelled mittens', 'buyer', { receiptId: null }),
      orderView('return_requested', 'Sold return requested gloves', 'seller'),
    ];

    render(<MarketplaceOrders />);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Needs my action 1/i })).toHaveAttribute('aria-selected', 'true'),
    );
    return userEvent.setup();
  };

  it('keeps every tab count visible and opens on Needs my action', async () => {
    await renderTabFilterFixture();

    expect(screen.getByRole('tab', { name: /Needs my action 1/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /In transit 2/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Completed 2/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Cancelled 0/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /All 7/i })).toBeInTheDocument();
    expect(screen.getByText(/Sold return requested gloves/)).toBeInTheDocument();
    expect(screen.getByText(/Bought cancelled mittens/)).toBeInTheDocument();
    expect(screen.getByText('Checkout ended before payment.')).toBeInTheDocument();
  });

  it('filters the Needs my action tab by state and role', async () => {
    const user = await renderTabFilterFixture();

    await user.click(screen.getByRole('tab', { name: /Needs my action 1/i }));
    expect(screen.queryByText(/Sold paid boots/)).not.toBeInTheDocument();
    expect(screen.getByText(/Sold return requested gloves/)).toBeInTheDocument();
  });

  it('filters the In transit tab by state and role', async () => {
    const user = await renderTabFilterFixture();

    await user.click(screen.getByRole('tab', { name: /In transit 2/i }));
    expect(screen.getByText(/Sold shipped bag/)).toBeInTheDocument();
    expect(screen.getByText(/Bought delivered hat/)).toBeInTheDocument();
    expect(screen.queryByText(/Sold paid boots/)).not.toBeInTheDocument();
  });

  it('filters the Completed tab by state and role', async () => {
    const user = await renderTabFilterFixture();

    await user.click(screen.getByRole('tab', { name: /Completed 2/i }));
    expect(screen.getByText(/Bought completed scarf/)).toBeInTheDocument();
    expect(screen.getByText(/Sold refunded belt/)).toBeInTheDocument();
    expect(screen.getByText(/Bought cancelled mittens/)).toBeInTheDocument();
    expect(screen.queryByText(/Sold return requested gloves/)).not.toBeInTheDocument();
  });

  it('lists the abandoned checkout on the Cancelled tab', async () => {
    const user = await renderTabFilterFixture();

    await user.click(screen.getByRole('tab', { name: /Cancelled 0/i }));
    expect(screen.getByText(/Bought cancelled mittens/)).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-abandoned-checkouts')).toHaveTextContent('Bought cancelled mittens');
  });

  it('returns to every order on the All tab', async () => {
    const user = await renderTabFilterFixture();

    await user.click(screen.getByRole('tab', { name: /All 7/i }));
    expect(screen.getByText(/Sold return requested gloves/)).toBeInTheDocument();
    expect(screen.getByText(/Sold paid boots/)).toBeInTheDocument();
  });

  it('names a refund below the order total on the order card', () => {
    ordersState.orders = [
      orderView('refunded_external', 'Sold partial belt', 'seller', {
        total: { amountMinor: 250, currency: 'USD', exponent: 2 },
        externalRefund: {
          amountMinor: 189,
          transactionId: 'PAYPAL-REFUND-189',
          recordedAt: '2026-08-19T18:00:00.000Z',
        },
      }),
    ];

    render(<MarketplaceOrders />);

    expect(screen.getByText('Refunded $1.89 of $2.50')).toBeInTheDocument();
    expect(screen.getByTestId('order-refund-record')).toHaveTextContent(
      'Refunded $1.89 of $2.50. Reference: PAYPAL-REFUND-189',
    );
  });

  it('names a PayPal full refund, a reversal, and held refund notices in plain words', () => {
    const refund = {
      amountMinor: 250,
      transactionId: '9RF12345AB678901C',
      recordedAt: '2026-09-24T18:00:00.000Z',
    };
    ordersState.orders = [
      orderView('refunded_external', 'Sold refunded lamp', 'seller', {
        total: { amountMinor: 250, currency: 'USD', exponent: 2 },
        externalRefund: refund,
      }),
      orderView('refunded_external', 'Sold reversed lamp', 'seller', {
        total: { amountMinor: 250, currency: 'USD', exponent: 2 },
        externalRefund: refund,
        paymentReversedAt: '2026-09-24T18:00:00.000Z',
        gatewayRefundUnmatched: true,
        gatewayRefundReviewAt: '2026-09-24T18:05:00.000Z',
      }),
    ];

    render(<MarketplaceOrders />);

    const refunded = screen.getByText(/Sold refunded lamp/).closest('[id^="order-"]') as HTMLElement;
    const reversed = screen.getByText(/Sold reversed lamp/).closest('[id^="order-"]') as HTMLElement;
    expect(within(refunded).getByText('Refunded')).toBeInTheDocument();
    expect(within(refunded).getByTestId('order-refund-record')).toHaveTextContent(
      'Refunded in full ($2.50). Reference: 9RF12345AB678901C',
    );
    expect(within(refunded).queryByTestId(/order-refund-notice-/)).not.toBeInTheDocument();
    expect(within(reversed).getByText('Payment reversed')).toBeInTheDocument();
    expect(within(reversed).getByTestId('order-refund-notice-reversed')).toHaveTextContent(
      REFUND_ORDER_NOTICES.reversed,
    );
    expect(within(reversed).getByTestId('order-refund-notice-refundOnHold')).toHaveTextContent(
      REFUND_ORDER_NOTICES.refundOnHold,
    );
    expect(within(reversed).getByTestId('order-refund-notice-refundNeedsCheck')).toHaveTextContent(
      REFUND_ORDER_NOTICES.refundNeedsCheck,
    );
    expect(screen.queryByText(/refunded external/i)).not.toBeInTheDocument();
  });

  it('records a Bitcoin refund with the payment-code equation', () => {
    ordersState.orders = [
      orderView('refunded_external', 'Sold bitcoin refund', 'seller', {
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
      }),
    ];
    render(<MarketplaceOrders />);
    expect(screen.getByTestId('order-refund-record')).toHaveTextContent(
      'Refunded in full (Items ₿1,000 · Shipping ₿0 · Payment code ₿255 = Total ₿1,255). Reference: txid-canary-refund',
    );
  });

  it('explains a cancelled PayPal reversal on the reopened order', () => {
    ordersState.orders = [
      orderView('paid', 'Sold restored lamp', 'seller', {
        paymentReversalCancelledAt: '2026-09-24T19:00:00.000Z',
      }),
    ];

    render(<MarketplaceOrders />);

    expect(screen.getByTestId('order-refund-notice-reversalCancelled')).toHaveTextContent(
      REFUND_ORDER_NOTICES.reversalCancelled,
    );
  });

  it('names a partial-refund state even when the recorded amount matches the total', () => {
    ordersState.orders = [
      orderView('refunded_partial', 'Sold partial state belt', 'seller', {
        total: { amountMinor: 250, currency: 'USD', exponent: 2 },
        externalRefund: {
          amountMinor: 250,
          transactionId: 'PAYPAL-REFUND-250',
          recordedAt: '2026-08-19T18:00:00.000Z',
        },
      }),
    ];

    render(<MarketplaceOrders />);

    expect(screen.getAllByText('Refunded $2.50 of $2.50').length).toBeGreaterThan(0);
    expect(screen.getByTestId('order-refund-record')).toHaveTextContent('Refunded $2.50 of $2.50');
  });

  it('shows seller unpaid holds as Reservations and buyer unpaid as Continue checkout', async () => {
    ordersState.orders = [
      orderView('pending_payment', 'Sold unpaid boots', 'seller', { nextActor: 'buyer' }, 'awaiting_entitlement'),
      orderView('pending_payment', 'Bought unpaid coat', 'buyer', { nextActor: 'buyer' }, 'awaiting_entitlement'),
      orderView('paid', 'Sold paid bag', 'seller', { nextActor: 'seller' }),
      orderView('pending_payment', 'Sold detected hat', 'seller', { nextActor: 'buyer' }, 'detected'),
      orderView('cancelled', 'Sold cancelled scarf', 'seller', { nextActor: 'none', receiptId: null }),
    ];

    render(<MarketplaceOrders />);

    expect(screen.getByRole('heading', { name: 'Reservations' })).toBeInTheDocument();
    expect(screen.getByText(/Sold unpaid boots/)).toBeInTheDocument();
    expect(screen.getByText(/Sold detected hat/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue checkout' })).toBeInTheDocument();
    expect(screen.getByText(/Bought unpaid coat/)).toBeInTheDocument();
    expect(screen.queryByText(/Sold cancelled scarf/)).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /All 1/i })).toBeInTheDocument();
    expect(screen.getByText(/Sold paid bag/)).toBeInTheDocument();
  });

  it('lists a bound Bitcoin payment in sales, and keeps an unbound hold as a reservation', async () => {
    const user = userEvent.setup();
    ordersState.orders = [
      orderView(
        'pending_payment',
        'Sold bitcoin awaiting',
        'seller',
        { paymentMethod: 'bitcoin', paykitRequestState: 'pending', nextActor: 'buyer' },
        'awaiting_entitlement',
      ),
      orderView(
        'pending_payment',
        'Sold bitcoin confirm',
        'seller',
        { paymentMethod: 'bitcoin', paykitRequestState: 'awaiting_seller_confirmation', nextActor: 'seller' },
        'awaiting_entitlement',
      ),
      orderView(
        'pending_payment',
        'Sold bitcoin review',
        'seller',
        { paymentMethod: 'bitcoin', paykitRequestState: 'pending', nextActor: 'seller' },
        'manual_review',
      ),
      orderView(
        'pending_payment',
        'Sold unbound hold',
        'seller',
        { paymentMethod: null, nextActor: 'buyer' },
        'awaiting_entitlement',
      ),
    ];

    render(<MarketplaceOrders />);

    const reservations = screen.getByTestId('marketplace-reservations');
    expect(within(reservations).getByText(/Sold unbound hold/)).toBeInTheDocument();
    expect(within(reservations).queryByText(/Sold bitcoin/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /All/i }));
    expect(screen.getByText(/Sold bitcoin awaiting/)).toBeInTheDocument();
    expect(screen.getByText(/Sold bitcoin confirm/)).toBeInTheDocument();
    expect(screen.getByText(/Sold bitcoin review/)).toBeInTheDocument();
    expect(screen.getAllByText('You sold').length).toBe(3);
    expect(screen.getAllByTestId('payment-status')).toHaveLength(3);
  });

  it('says why a seller approves the marketplace session to see sales', () => {
    ordersState.needsSession = true;
    ordersState.error = 'A marketplace session is required.';

    render(<MarketplaceOrders />);

    expect(
      screen.getByText(
        'Your sales use this same approval, because the marketplace lists them only for a session it can tie to you.',
      ),
    ).toBeInTheDocument();
  });

  it('shows reserved checkout copy on Continue checkout, not a payment deadline on Orders', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-15T10:00:00.000Z'));
    ordersState.orders = [
      orderView(
        'pending_payment',
        'Bought deadline boots',
        'buyer',
        {
          holdExpiresAt: '2026-09-15T10:05:00.000Z',
          paymentMethod: 'bitcoin',
          paykitRequestState: 'pending',
          nextActor: 'buyer',
        },
        'awaiting_entitlement',
      ),
    ];
    const { rerender } = render(<MarketplaceOrders />);
    expect(screen.getByRole('link', { name: 'Continue checkout' })).toBeInTheDocument();
    expect(screen.getByText(/Reserved while you pay · 5:00/)).toBeInTheDocument();
    expect(screen.queryByText(/Open Bitkit to pay/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Complete payment by/)).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();

    ordersState.orders = [
      orderView('pending_payment', 'Bought no deadline boots', 'buyer', { holdExpiresAt: null, nextActor: 'buyer' }),
    ];
    rerender(<MarketplaceOrders />);
    expect(screen.getByRole('heading', { name: 'Checkout in progress' })).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-continue-checkout')).toHaveTextContent('Checkout in progress');

    ordersState.orders = [
      orderView(
        'pending_payment',
        'Bought expired boots',
        'buyer',
        {
          holdExpiresAt: '2026-09-15T09:59:59.000Z',
          paymentMethod: 'bitcoin',
          paykitRequestState: 'pending',
          nextActor: 'buyer',
        },
        'awaiting_entitlement',
      ),
    ];
    rerender(<MarketplaceOrders />);
    expect(screen.getByText(/Reserved while you pay · 0:00/)).toBeInTheDocument();
  });

  it('replaces the pay-by line with the seller confirm-by time after a Bitcoin payment is seen', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-28T11:00:00.000Z'));
    ordersState.orders = [
      orderView(
        'pending_payment',
        'Bought seen boots',
        'buyer',
        {
          paymentMethod: 'bitcoin',
          paykitRequestState: 'awaiting_seller_confirmation',
          paykitSellerConfirmationDeadline: '2026-09-29T10:56:41.980Z',
          holdExpiresAt: '2026-09-29T10:56:41.980Z',
          nextActor: 'buyer',
        },
        'awaiting_entitlement',
      ),
    ];
    render(<MarketplaceOrders />);
    expect(screen.getByText('Seller confirms by Sep 29, 2026, 10:56 AM UTC. 23:56:41 left')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View payment' })).toBeInTheDocument();
    expect(screen.queryByText(/Reserved while you pay/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pay by/)).not.toBeInTheDocument();
  });

  it('shows no countdown once the seller confirm-by time has passed', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T11:00:00.000Z'));
    ordersState.orders = [
      orderView(
        'pending_payment',
        'Bought seen boots',
        'buyer',
        {
          paymentMethod: 'bitcoin',
          paykitRequestState: 'awaiting_seller_confirmation',
          paykitSellerConfirmationDeadline: '2026-09-29T10:56:41.980Z',
          holdExpiresAt: '2026-09-29T10:56:41.980Z',
          nextActor: 'buyer',
        },
        'awaiting_entitlement',
      ),
    ];
    render(<MarketplaceOrders />);
    expect(screen.getByText('Seller confirms by Sep 29, 2026, 10:56 AM UTC.')).toBeInTheDocument();
  });

  it('does not tell a buyer in unconfirmed manual review to pay again', () => {
    ordersState.orders = [
      orderView(
        'pending_payment',
        'Bought review boots',
        'buyer',
        {
          paymentMethod: 'bitcoin',
          paykitRequestState: 'pending',
          holdExpiresAt: '2026-09-29T10:56:41.980Z',
          nextActor: 'buyer',
        },
        'manual_review',
      ),
    ];
    render(<MarketplaceOrders />);
    expect(screen.getByText('Payment received — the seller is reviewing it.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View payment' })).toBeInTheDocument();
    expect(screen.queryByText(/Reserved while you pay/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pay by/)).not.toBeInTheDocument();
    expect(screen.queryByText(/confirmed on-chain/)).not.toBeInTheDocument();
  });

  it('prompts the seller to confirm a seen Bitcoin payment', () => {
    ordersState.adapterMode = 'transaction-service';
    const money = {
      paymentMethod: 'bitcoin' as const,
      paykitRequestState: 'awaiting_seller_confirmation' as const,
      paykitTotalSats: 1_303,
      merchandiseTotal: { amountMinor: 1_000, currency: 'BTC' as const, exponent: 8 as const },
      bitcoinPayable: { amountMinor: 1_303, currency: 'SAT' as const, exponent: 0 },
      subtotal: { amountMinor: 1_000, currency: 'BTC' as const, exponent: 8 as const },
      shipping: { amountMinor: 0, currency: 'BTC' as const, exponent: 8 as const },
      total: { amountMinor: 1_303, currency: 'BTC' as const, exponent: 8 as const },
      nextActor: 'buyer' as const,
    };
    ordersState.orders = [
      orderView(
        'pending_payment',
        'Sold seen boots',
        'seller',
        money,
        'awaiting_entitlement',
        createPaymentFixture('awaiting_entitlement', { adapter: 'paykit' }),
      ),
    ];
    render(<MarketplaceOrders />);
    expect(screen.queryByRole('heading', { name: 'Reservations' })).not.toBeInTheDocument();
    expect(screen.getByText(/Sold seen boots/)).toBeInTheDocument();
    expect(screen.getByText('You sold')).toBeInTheDocument();
    expect(screen.getByTestId('payment-status')).toBeInTheDocument();
    expect(screen.queryByText(/restocks/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pay by/)).not.toBeInTheDocument();
  });

  it('keeps a cancelled paid order in buyer and seller history, never Abandoned', async () => {
    const user = userEvent.setup();
    ordersState.currentUserPubky = CURRENT_USER;
    ordersState.orders = [
      orderView('cancelled', 'Bought paid cancel coat', 'buyer', { nextActor: 'none' }),
      orderView('cancelled', 'Sold paid cancel scarf', 'seller', { nextActor: 'none' }),
    ];
    render(<MarketplaceOrders />);
    expect(screen.queryByText('Checkout ended before payment.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('marketplace-abandoned-checkouts')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Cancelled 2/i })).toBeInTheDocument();
    expect(screen.getByText(/Bought paid cancel coat/)).toBeInTheDocument();
    expect(screen.getByText(/Sold paid cancel scarf/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Cancelled 2/i }));
    expect(screen.getByText(/Bought paid cancel coat/)).toBeInTheDocument();
    expect(screen.getByText(/Sold paid cancel scarf/)).toBeInTheDocument();
  });

  it('does not label an elapsed unpaid order as Your move', () => {
    ordersState.orders = [
      orderView(
        'cancelled',
        'Bought elapsed boots',
        'buyer',
        { cancellationReason: 'payment window elapsed', nextActor: 'none', receiptId: null },
        'expired',
      ),
    ];
    render(<MarketplaceOrders />);
    expect(screen.getByText('Checkout ended before payment.')).toBeInTheDocument();
    expect(screen.queryByText('Your move')).not.toBeInTheDocument();
  });

  it('puts buyer pending payment under Continue checkout, not Needs my action', async () => {
    ordersState.orders = [
      orderView('pending_payment', 'Bought unpaid coat', 'buyer', { nextActor: 'buyer' }, 'awaiting_entitlement'),
    ];

    render(<MarketplaceOrders />);

    expect(screen.getByRole('link', { name: 'Continue checkout' })).toBeInTheDocument();
    expect(screen.getByText(/Bought unpaid coat/)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('excludes buyer, confirmed, manual-review, null-payment, and same-party orders', async () => {
    const user = userEvent.setup();
    ordersState.orders = [
      orderView('pending_payment', 'Bought unpaid coat', 'buyer', { nextActor: 'buyer' }, 'awaiting_entitlement'),
      orderView('paid', 'Sold paid bag', 'seller', { nextActor: 'seller' }),
      orderView('pending_payment', 'Sold confirmed bag', 'seller', { nextActor: 'buyer' }, 'confirmed'),
      orderView('pending_payment', 'Sold manual review bag', 'seller', { nextActor: 'buyer' }, 'manual_review'),
      orderView(
        'pending_payment',
        'Sold null payment bag',
        'seller',
        { nextActor: 'buyer' },
        'awaiting_entitlement',
        null,
      ),
      orderView(
        'pending_payment',
        'Same-party bag',
        'seller',
        { buyerPubky: CURRENT_USER, nextActor: 'buyer' },
        'awaiting_entitlement',
      ),
    ];

    render(<MarketplaceOrders />);
    await user.click(screen.getByRole('tab', { name: /Waiting on the other side 0/i }));

    expect(screen.getAllByRole('link', { name: 'Continue checkout' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Reservations' })).toBeInTheDocument();
    expect(screen.queryByText(/Sold paid bag/)).not.toBeInTheDocument();
  });

  it('keeps the active tab semantically addressable for horizontal visibility management', () => {
    ordersState.orders = [orderView('return_requested', 'Sold return requested gloves', 'seller')];

    render(<MarketplaceOrders />);

    const activeTab = screen.getByRole('tab', { name: /Needs my action 1/i });
    expect(activeTab).toHaveAttribute('aria-selected', 'true');
    expect(activeTab).toHaveAttribute('role', 'tab');
  });

  it.each([
    { prefersReducedMotion: false, behavior: 'smooth' },
    { prefersReducedMotion: true, behavior: 'auto' },
  ])('scrolls a clipped active tab within the tab list ($behavior)', ({ prefersReducedMotion, behavior }) => {
    ordersState.orders = [
      orderView('pending_payment', 'Sold unpaid boots', 'seller', { nextActor: 'buyer' }, 'detected'),
      orderView('return_requested', 'Sold return requested gloves', 'seller'),
    ];
    const tabListScrollTo = vi.fn();
    const pageScrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: prefersReducedMotion,
      }),
    );

    render(<MarketplaceOrders />);

    fireEvent.click(screen.getByRole('tab', { name: /All 1/i }));

    const tabList = screen.getByRole('tablist');
    const actionTab = screen.getByRole('tab', { name: /Needs my action 1/i });
    Object.defineProperties(tabList, {
      clientWidth: { configurable: true, value: 100 },
      scrollLeft: { configurable: true, value: 20, writable: true },
      scrollTo: { configurable: true, value: tabListScrollTo },
    });
    Object.defineProperties(actionTab, {
      offsetLeft: { configurable: true, value: 160 },
      offsetWidth: { configurable: true, value: 80 },
    });

    fireEvent.click(actionTab);

    expect(tabListScrollTo).toHaveBeenCalledWith({ left: 150, behavior });
    expect(tabListScrollTo).toHaveBeenCalledTimes(1);
    expect(pageScrollTo).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not scroll a visible active tab or any page container', () => {
    ordersState.orders = [
      orderView('pending_payment', 'Sold unpaid boots', 'seller', { nextActor: 'buyer' }, 'detected'),
      orderView('return_requested', 'Sold return requested gloves', 'seller'),
    ];
    const tabListScrollTo = vi.fn();
    const pageScrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
      }),
    );

    render(<MarketplaceOrders />);

    const tabList = screen.getByRole('tablist');
    const activeTab = screen.getByRole('tab', { name: /Needs my action 1/i });
    Object.defineProperties(tabList, {
      clientWidth: { configurable: true, value: 240 },
      scrollLeft: { configurable: true, value: 20, writable: true },
      scrollTo: { configurable: true, value: tabListScrollTo },
    });
    Object.defineProperties(activeTab, {
      offsetLeft: { configurable: true, value: 80 },
      offsetWidth: { configurable: true, value: 80 },
    });

    fireEvent.click(activeTab);

    expect(tabListScrollTo).not.toHaveBeenCalled();
    expect(pageScrollTo).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('labels order direction from the signed-in user perspective', async () => {
    const user = userEvent.setup();
    ordersState.orders = [
      orderView('paid', 'Bought paid coat', 'buyer'),
      orderView('paid', 'Sold paid boots', 'seller'),
    ];

    render(<MarketplaceOrders />);
    await user.click(screen.getByRole('tab', { name: /All 2/i }));

    const boughtCard = screen.getByText(/Bought paid coat/).closest('[data-slot="card"]');
    const soldCard = screen.getByText(/Sold paid boots/).closest('[data-slot="card"]');
    expect(within(boughtCard as HTMLElement).getByText('You bought')).toBeInTheDocument();
    expect(within(soldCard as HTMLElement).getByText('You sold')).toBeInTheDocument();
    expect(within(boughtCard as HTMLElement).getByTestId('order-reference-label')).toHaveTextContent('Order test-bou');
    expect(within(soldCard as HTMLElement).getByTestId('order-reference-label')).toHaveTextContent('Order test-sol');
  });

  it('shows when each order was placed, and the day a held item restocks', async () => {
    const user = userEvent.setup();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T09:00:00.000Z'));
    ordersState.orders = [
      orderView('paid', 'Bought dated coat', 'buyer', { createdAt: '2026-09-30T18:45:00.000Z' }),
      orderView(
        'pending_payment',
        'Sold held boots',
        'seller',
        { createdAt: '2026-10-01T08:10:00.000Z', holdExpiresAt: '2026-10-02T08:10:00.000Z', nextActor: 'buyer' },
        'awaiting_entitlement',
      ),
      orderView(
        'pending_payment',
        'Bought checkout scarf',
        'buyer',
        { createdAt: '2026-10-01T08:55:00.000Z', holdExpiresAt: '2026-10-01T09:10:00.000Z', nextActor: 'buyer' },
        'awaiting_entitlement',
      ),
    ];

    render(<MarketplaceOrders />);
    await user.click(screen.getByRole('tab', { name: /^All/i }));

    const placedAt = (title: RegExp) => {
      const card = screen.getAllByText(title)[0].closest('[data-slot="card"]') as HTMLElement;
      return within(card).getByTestId('order-placed-at');
    };
    expect(placedAt(/Bought dated coat/)).toHaveTextContent('Placed Sep 30, 2026, 6:45 PM UTC');
    expect(placedAt(/Bought dated coat/)).toHaveAttribute('dateTime', '2026-09-30T18:45:00.000Z');
    expect(placedAt(/Sold held boots/)).toHaveTextContent('Placed Oct 1, 2026, 8:10 AM UTC');
    expect(placedAt(/Bought checkout scarf/)).toHaveTextContent('Placed Oct 1, 2026, 8:55 AM UTC');
    expect(within(screen.getByTestId('marketplace-reservations')).getByText(/restocks/)).toHaveTextContent(
      'Held for a buyer · restocks Oct 2, 2026, 8:10 AM UTC',
    );
  });

  it('opens PayPal for the seller when the order stores a txn id', async () => {
    ordersState.orders = [
      orderView('paid', 'Bought paypal coat', 'buyer', {
        paymentMethod: 'paypal',
        fiatTransactionRef: '5TY05013RG002845M',
      }),
      orderView('paid', 'Sold paypal boots', 'seller', {
        paymentMethod: 'paypal',
        fiatTransactionRef: '5TY05013RG002845M',
      }),
    ];

    render(<MarketplaceOrders />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /All 2/i }));

    const boughtCard = screen.getByText(/Bought paypal coat/).closest('[data-slot="card"]') as HTMLElement;
    const soldCard = screen.getByText(/Sold paypal boots/).closest('[data-slot="card"]') as HTMLElement;
    expect(within(boughtCard).queryByTestId('open-in-paypal')).toBeNull();
    const link = within(soldCard).getByTestId('open-in-paypal');
    expect(link).toHaveTextContent('Open in PayPal');
    expect(link).toHaveAttribute('href', 'https://www.paypal.com/myaccount/activities/details/5TY05013RG002845M');
  });

  it('shows next-actor hints from the signed-in user perspective', async () => {
    const user = userEvent.setup();
    ordersState.orders = [
      orderView('paid', 'Sold paid boots', 'seller'),
      orderView('paid', 'Bought paid coat', 'buyer'),
    ];

    render(<MarketplaceOrders />);
    await user.click(screen.getByRole('tab', { name: /All 2/i }));

    const soldCard = screen.getByText(/Sold paid boots/).closest('[data-slot="card"]');
    const boughtCard = screen.getByText(/Bought paid coat/).closest('[data-slot="card"]');
    expect(within(soldCard as HTMLElement).getByText('Your move')).toBeInTheDocument();
    expect(within(boughtCard as HTMLElement).getByText('Waiting on seller')).toBeInTheDocument();
  });

  it('renders a neutral hint when the service reports no pending actor', async () => {
    ordersState.orders = [orderView('completed', 'Completed order', 'buyer', { nextActor: 'none' })];

    render(<MarketplaceOrders />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /All 1/i }));

    expect(screen.getByText('No action pending')).toBeInTheDocument();
  });

  it('renders each service actor variant without inventing an actor', async () => {
    ordersState.orders = [
      orderView('paid', 'Seller config needed', 'buyer', { nextActor: 'seller' }),
      orderView('paid', 'Seller confirmation needed', 'seller', { nextActor: 'seller' }),
      orderView('delivered', 'Auto completion pending', 'buyer', { nextActor: 'none' }),
    ];

    render(<MarketplaceOrders />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /All 3/i }));

    expect(screen.getByText('Waiting on seller')).toBeInTheDocument();
    expect(screen.getAllByText('Your move')).toHaveLength(1);
    expect(screen.getByText('No action pending')).toBeInTheDocument();
  });

  it('uses next_actor to place buyer and seller work in Needs my action', async () => {
    ordersState.orders = [
      orderView('pending_payment', 'Bought pending boots', 'buyer'),
      orderView('paid', 'Sold paid boots', 'seller'),
      orderView('completed', 'Bought completed scarf', 'buyer'),
    ];

    render(<MarketplaceOrders />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Needs my action 1/i })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(screen.getByRole('link', { name: 'Continue checkout' })).toBeInTheDocument();
    expect(screen.getByText(/Bought pending boots/)).toBeInTheDocument();
    expect(screen.getByText(/Sold paid boots/)).toBeInTheDocument();
    expect(screen.queryByText(/Bought completed scarf/)).not.toBeInTheDocument();
  });

  it('shows assumed-delivery copy and buyer message affordance only when delivery was assumed', async () => {
    const user = userEvent.setup();
    ordersState.orders = [
      orderView('delivered', 'Bought assumed boots', 'buyer', { deliveryAssumed: true }),
      orderView('delivered', 'Bought confirmed coat', 'buyer', { deliveryAssumed: false }),
    ];

    render(<MarketplaceOrders />);
    await user.click(screen.getByRole('tab', { name: /All 2/i }));

    const assumedCard = screen.getByText(/Bought assumed boots/).closest('[data-slot="card"]');
    const confirmedCard = screen.getByText(/Bought confirmed coat/).closest('[data-slot="card"]');
    expect(within(assumedCard as HTMLElement).getByText(MESSAGING_COPY.assumedDelivery)).toBeInTheDocument();
    expect(within(assumedCard as HTMLElement).getByRole('link', { name: MESSAGING_COPY.orderCta })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/marketplace\/messages\?conversation=/),
    );
    expect(
      within(assumedCard as HTMLElement).getByText(/Completes automatically after the return window/),
    ).toBeInTheDocument();
    expect(within(confirmedCard as HTMLElement).queryByText(MESSAGING_COPY.assumedDelivery)).not.toBeInTheDocument();
    expect(
      within(confirmedCard as HTMLElement).getByRole('link', { name: MESSAGING_COPY.orderCta }),
    ).toBeInTheDocument();
  });

  it('opens the listing conversation dialog from a durable order card', async () => {
    const user = userEvent.setup();
    ordersState.adapterMode = 'transaction-service';
    ordersState.orders = [orderView('paid', 'Bought paid boots', 'buyer', { nextActor: 'none' })];

    render(<MarketplaceOrders />);
    await user.click(screen.getByRole('tab', { name: /All 1/i }));

    const card = screen.getByText(/Bought paid boots/).closest('[data-slot="card"]');
    expect(within(card as HTMLElement).queryByRole('link', { name: MESSAGING_COPY.orderCta })).not.toBeInTheDocument();
    expect((card as HTMLElement).querySelector('[data-surface="marketplace-order-message-cta"]')).toBeTruthy();
    await user.click(within(card as HTMLElement).getByRole('button', { name: MESSAGING_COPY.orderCta }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(document.querySelector('[data-surface="marketplace-encrypted-conversation"]')).toBeTruthy();
  });

  it('keeps icon-only order card buttons accessible when they render', () => {
    ordersState.orders = [orderView('paid', 'Sold paid boots', 'seller')];

    const { container } = render(<MarketplaceOrders />);
    const iconOnlyButtons = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === '' && button.querySelector('svg') !== null,
    );

    expect(iconOnlyButtons.length).toBeGreaterThan(0);
    for (const button of iconOnlyButtons) {
      expect(button).toHaveAttribute('aria-label', expect.stringMatching(/\S/));
    }
  });

  // Quote values are the live capture of 2026-09-14 (`orders.wire.ts`); the
  // lock expired at 2026-09-13T20:15:09.050Z, so the clock is pinned on each
  // side of that instant instead of trusting the wall clock.
  const lockedQuoteOrder = () =>
    orderView('paid', 'Locked quote boots', 'seller', {
      paymentMethod: 'bitcoin',
      bitcoinQuote: {
        quotedSats: 2_588,
        currency: 'USD',
        exponent: 2,
        rate: '77287',
        source: 'blocktank',
        fetchedAt: '2026-09-13T19:14:48.286Z',
        expiresAt: '2026-09-13T20:15:09.050Z',
        spreadBps: 0,
      },
    });

  it('shows the locked Bitcoin quote while the lock is current', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-13T20:00:00.000Z'));
    ordersState.orders = [lockedQuoteOrder()];

    render(<MarketplaceOrders />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /All 1/i }));

    expect(screen.getByText(/Locked Bitcoin amount: ₿2,588/)).toBeInTheDocument();
    expect(screen.queryByText(/Bitcoin quote expired/)).not.toBeInTheDocument();
    expect(screen.queryByText(/≈ ₿/)).not.toBeInTheDocument();
  });

  it('marks the locked Bitcoin quote expired once the lock has lapsed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-13T20:15:09.051Z'));
    ordersState.orders = [lockedQuoteOrder()];

    render(<MarketplaceOrders />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /All 1/i }));

    expect(screen.getByText(/Locked Bitcoin amount: ₿2,588/)).toBeInTheDocument();
    expect(screen.getByText(/ · Bitcoin quote expired/)).toBeInTheDocument();
    expect(screen.queryByText(/≈ ₿/)).not.toBeInTheDocument();
  });

  it('shows items, shipping, and the payment code on the order and its receipt', async () => {
    const user = userEvent.setup();
    const order = createOrderFixture('paid', {
      paymentMethod: 'bitcoin',
      paykitTotalSats: 1_255,
      merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      bitcoinPayable: { amountMinor: 1_255, currency: 'SAT', exponent: 0 },
      subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
      total: { amountMinor: 1_255, currency: 'BTC', exponent: 8 },
      lines: [
        {
          listingAggregateId: `listing:${ORDER_FIXTURE_SELLER}_canary`,
          listingRevision: 1,
          contentHash: 'a'.repeat(64),
          title: 'Canary boots',
          quantity: 1,
          unitPrice: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
          subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
        },
      ],
    });
    ordersState.orders = [
      {
        order,
        payment: createPaymentFixture('confirmed', { id: order.paymentId, orderId: order.id, adapter: 'paykit' }),
        receipt: createReceiptFixture({ orderId: order.id, total: order.total }),
      },
    ];

    render(<MarketplaceOrders />);
    await user.click(screen.getByRole('tab', { name: /All 1/i }));

    const equation = 'Items ₿1,000 · Shipping ₿0 · Payment code ₿255 = Total ₿1,255';
    expect(screen.getByText('₿1,255')).toBeInTheDocument();
    expect(screen.getAllByText(equation)).toHaveLength(2);
    expect(within(screen.getByTestId('order-receipt-details')).getByText(equation)).toBeInTheDocument();
    expect(screen.queryByText(/Locked Bitcoin amount/)).not.toBeInTheDocument();
  });

  it.each([null, undefined])('shows the indicative Bitcoin estimate when the quote is %s', async (bitcoinQuote) => {
    useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: null });
    ordersState.orders = [
      orderView('paid', 'Indicative quote boots', 'buyer', {
        paymentMethod: 'bitcoin',
        bitcoinQuote,
      }),
    ];

    render(<MarketplaceOrders />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /All 1/i }));

    expect(await screen.findByText('≈ ₿137,000')).toBeInTheDocument();
    expect(screen.queryByText(/Locked Bitcoin amount/)).not.toBeInTheDocument();
  });
});

describe('MarketplaceOrders local pickup cards (Wave 7, §A3/§A6)', () => {
  beforeEach(() => {
    ordersState.currentUserPubky = CURRENT_USER;
    ordersState.orders = [];
  });

  it('renders plain-language pickup labels and the Local pickup badge on the buyer card', () => {
    ordersState.orders = [
      orderView('ready_for_pickup', 'Bought pickup boots', 'buyer', { fulfillment: 'pickup', nextActor: 'buyer' }),
    ];

    render(<MarketplaceOrders />);

    const card = screen.getByText(/Bought pickup boots/).closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByText('Local pickup')).toBeInTheDocument();
    expect(within(card).getByText('Ready for pickup')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Show meeting point' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Confirm handover' })).toBeInTheDocument();
  });

  it('labels a delivered pickup order as picked up', () => {
    ordersState.orders = [
      orderView('delivered', 'Bought pickup boots', 'buyer', { fulfillment: 'pickup', nextActor: 'none' }),
    ];

    render(<MarketplaceOrders />);

    const card = screen.getByText(/Bought pickup boots/).closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByText('Picked up')).toBeInTheDocument();
  });

  it('warns the buyer when the pickup terms changed after payment (§A3)', () => {
    ordersState.orders = [
      orderView('paid', 'Bought pickup boots', 'buyer', {
        fulfillment: 'pickup',
        nextActor: 'seller',
        pickupTermsChanged: true,
      }),
    ];

    render(<MarketplaceOrders />);

    const card = screen.getByText(/Bought pickup boots/).closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByText(/The seller changed the pickup terms since you paid/)).toBeInTheDocument();
  });

  it('shows the seller Mark ready for pickup on a paid pickup order', () => {
    ordersState.orders = [orderView('paid', 'Sold pickup boots', 'seller', { fulfillment: 'pickup' })];

    render(<MarketplaceOrders />);

    const card = screen.getByText(/Sold pickup boots/).closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByRole('button', { name: 'Mark ready for pickup' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Add tracking' })).not.toBeInTheDocument();
  });
});

describe('MarketplaceOrders digital cards (digital delivery design §3 "After payment", §6 D1, E4)', () => {
  beforeEach(() => {
    ordersState.currentUserPubky = CURRENT_USER;
    ordersState.orders = [];
  });

  function digitalView(state: 'paid' | 'delivered', role: 'buyer' | 'seller') {
    const view = orderView(state, 'Field guide', role, { fulfillment: 'digital', nextActor: 'none' });
    view.order.lines = view.order.lines.map((line) => ({ ...line, fulfillment: 'digital', digitalKind: 'file' }));
    return view;
  }

  it('shows the buyer a delivered file order as ready to download, with the purchase panel', () => {
    ordersState.orders = [digitalView('delivered', 'buyer')];

    render(<MarketplaceOrders />);

    const card = screen.getAllByText(/Field guide/)[0].closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByText('Delivered · ready to download')).toBeInTheDocument();
    expect(within(card).getByText('Digital delivery')).toBeInTheDocument();
    expect(within(card).getByRole('heading', { name: 'Your purchase' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(within(card).queryByText(/Completes automatically after the return window/)).not.toBeInTheDocument();
  });

  it('shows no shipment or tracking line on a digital order, even when stale shipment data is present (review P2)', () => {
    const view = digitalView('delivered', 'buyer');
    view.order.shipment = {
      carrier: 'USPS',
      trackingNumber: '9400111899223197428490',
      state: 'shipped',
      shippedAt: '2026-08-14T10:00:00.000Z',
      deliveredAt: null,
    };
    ordersState.orders = [view];

    render(<MarketplaceOrders />);

    const card = screen.getAllByText(/Field guide/)[0].closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).queryByText(/9400111899223197428490/)).not.toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Track package/ })).not.toBeInTheDocument();
  });

  it('shows the seller no purchase panel', () => {
    ordersState.orders = [digitalView('delivered', 'seller')];

    render(<MarketplaceOrders />);

    const card = screen.getAllByText(/Field guide/)[0].closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).queryByRole('heading', { name: 'Your purchase' })).not.toBeInTheDocument();
  });

  it('marks a paid email order To deliver for its seller, with the delivery panel (§3 "Seller\u2019s orders")', () => {
    const view = orderView('paid', 'Sewing pattern', 'seller', { fulfillment: 'digital', nextActor: 'seller' });
    view.order.lines = view.order.lines.map((line) => ({ ...line, fulfillment: 'digital', digitalKind: 'email' }));
    ordersState.orders = [view];

    render(<MarketplaceOrders />);

    const card = screen.getAllByText(/Sewing pattern/)[0].closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByText('To deliver')).toBeInTheDocument();
    expect(within(card).getByRole('region', { name: 'Delivery' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Mark emailed' })).toBeInTheDocument();
  });

  it('keeps Your move on a paid shipped order', () => {
    ordersState.orders = [orderView('paid', 'Shipped lamp', 'seller', { nextActor: 'seller' })];

    render(<MarketplaceOrders />);

    const card = screen.getByText(/Shipped lamp/).closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByText('Your move')).toBeInTheDocument();
    expect(within(card).queryByText('To deliver')).not.toBeInTheDocument();
  });

  it('keeps the return-window note on a delivered shipped order', () => {
    ordersState.orders = [orderView('delivered', 'Shipped boots', 'buyer', { nextActor: 'none' })];

    render(<MarketplaceOrders />);

    const card = screen.getByText(/Shipped boots/).closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByText(/Completes automatically after the return window/)).toBeInTheDocument();
    expect(within(card).queryByText('Delivered · ready to download')).not.toBeInTheDocument();
  });
});

describe('MarketplaceOrders seen checkpoint', () => {
  beforeEach(() => {
    ordersState.currentUserPubky = CURRENT_USER;
    ordersState.adapterMode = 'transaction-service';
    ordersState.orders = [orderView('paid', 'Sold paid boots', 'seller')];
  });

  it('saves the Orders checkpoint once per opening, not on every polled order list', async () => {
    const markSeen = vi.spyOn(CommerceController, 'markOrdersAttentionSeen').mockResolvedValue();
    const { rerender } = render(<MarketplaceOrders />);
    await waitFor(() => expect(markSeen).toHaveBeenCalledOnce());

    for (let poll = 0; poll < 3; poll += 1) {
      ordersState.orders = [orderView('paid', 'Sold paid boots', 'seller')];
      rerender(<MarketplaceOrders />);
    }
    await Promise.resolve();

    expect(markSeen).toHaveBeenCalledOnce();
  });
});

describe('MarketplaceOrders Activity link to an order no section lists', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    ordersState.currentUserPubky = CURRENT_USER;
    ordersState.adapterMode = 'transaction-service';
    ordersState.orders = [
      orderView('paid', 'Sold paid boots', 'seller'),
      orderView('cancelled', 'Unpaid sold lamp', 'seller', { receiptId: null }),
    ];
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.spyOn(CommerceController, 'markOrdersAttentionSeen').mockResolvedValue();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('shows the linked order with its state and short ID, and scrolls to it', async () => {
    window.history.replaceState(null, '', '/marketplace/orders#order-test-unpaid-sold-lamp');

    render(<MarketplaceOrders />);

    const section = await screen.findByTestId('marketplace-linked-order');
    expect(within(section).getByRole('heading', { name: 'From Activity' })).toBeInTheDocument();
    expect(within(section).getByText('Your sale')).toBeInTheDocument();
    expect(within(section).getByTestId('marketplace-linked-order-state')).toHaveTextContent('Cancelled before payment');
    expect(within(section).getByText('Unpaid sold lamp × 1')).toBeInTheDocument();
    expect(within(section).getByTestId('order-reference-label')).toHaveTextContent('Order test-unp');
    const card = section.querySelector('[id="order-test-unpaid-sold-lamp"]');
    expect(card).not.toBeNull();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.contexts.some((element) => element === card)).toBe(true);
  });

  it('keeps the unpaid cancel out of the page without an Activity link', () => {
    render(<MarketplaceOrders />);

    expect(screen.queryByTestId('marketplace-linked-order')).toBeNull();
    expect(screen.queryByText(/Unpaid sold lamp/)).toBeNull();
  });

  it('does not duplicate an order another section already lists', async () => {
    window.history.replaceState(null, '', '/marketplace/orders#order-test-sold-paid-boots');

    render(<MarketplaceOrders />);

    await waitFor(() => expect(screen.getByText('Sold paid boots × 1')).toBeInTheDocument());
    expect(screen.queryByTestId('marketplace-linked-order')).toBeNull();
    expect(screen.getAllByText('Sold paid boots × 1')).toHaveLength(1);
  });

  it('shows nothing for a linked order the signed-in account is not part of', async () => {
    const foreign = orderView('cancelled', 'Foreign unpaid lamp', 'seller', {
      receiptId: null,
      buyerPubky: OTHER_USER,
      sellerPubky: ORDER_FIXTURE_SELLER,
    });
    ordersState.orders = [orderView('paid', 'Sold paid boots', 'seller'), foreign];
    window.history.replaceState(null, '', `/marketplace/orders#order-${foreign.order.id}`);

    render(<MarketplaceOrders />);

    await waitFor(() => expect(screen.getByText('Sold paid boots × 1')).toBeInTheDocument());
    expect(screen.queryByTestId('marketplace-linked-order')).toBeNull();
    expect(screen.queryByText(/Foreign unpaid lamp/)).toBeNull();
    expect(document.getElementById(`order-${foreign.order.id}`)).toBeNull();
  });

  it('follows a hash change while the page is open', async () => {
    render(<MarketplaceOrders />);
    expect(screen.queryByTestId('marketplace-linked-order')).toBeNull();

    window.history.replaceState(null, '', '/marketplace/orders#order-test-unpaid-sold-lamp');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(await screen.findByTestId('marketplace-linked-order-state')).toHaveTextContent('Cancelled before payment');
  });
});
