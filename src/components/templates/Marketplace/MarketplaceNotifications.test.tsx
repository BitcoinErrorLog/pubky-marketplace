import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MarketplaceNotifications } from './MarketplaceNotifications';

const authStoreState = vi.hoisted(() => ({ session: {} as unknown, currentUserPubky: null as string | null }));
const markAllSeen = vi.hoisted(() => vi.fn(async () => {}));
const marketplaceView = vi.hoisted(() => ({ notifications: [] as unknown[] }));
const ordersView = vi.hoisted(() => ({
  orders: [] as {
    order: {
      id: string;
      state?: string;
      buyerPubky?: string;
      total?: { amountMinor: number; currency: string; exponent: number };
      externalRefund?: { amountMinor: number } | null;
      paymentReversedAt?: string | null;
      returnRequest?: { reason?: string | null } | null;
    };
  }[],
  isLoading: false,
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { session: unknown | null; currentUserPubky: string | null }) => unknown) =>
    selector(authStoreState),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    markActivityRead: vi.fn(async () => {}),
  },
}));

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ordersView,
}));

vi.mock('@/hooks/useMarketplaceNotifications/useMarketplaceNotifications', () => ({
  useMarketplaceNotifications: () => ({
    notifications: marketplaceView.notifications,
    preferences: null,
    unreadCount: 0,
    isLoading: false,
    error: null,
    needsSession: false,
    canMarkRead: false,
    markAllRead: vi.fn(),
    updatePreferences: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed', () => ({
  useMarketplaceWatchAlertFeed: () => ({ items: [], markAllSeen }),
}));

vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/organisms/Marketplace/MarketplaceSectionNav', () => ({
  MarketplaceSectionNav: () => <nav data-testid="marketplace-section-nav" />,
}));

describe('MarketplaceNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authStoreState.session = {};
    authStoreState.currentUserPubky = null;
    marketplaceView.notifications = [];
    ordersView.orders = [];
    ordersView.isLoading = false;
  });

  it('clears the device-local read state on entry: watch alerts seen, activity checkpoint advanced', async () => {
    render(<MarketplaceNotifications />);

    await waitFor(() => expect(markAllSeen).toHaveBeenCalledOnce());
    expect(CommerceController.markActivityRead).toHaveBeenCalledOnce();
  });

  it('does not touch device-local read state while no session is restored', () => {
    authStoreState.session = null;

    render(<MarketplaceNotifications />);

    expect(markAllSeen).not.toHaveBeenCalled();
    expect(CommerceController.markActivityRead).not.toHaveBeenCalled();
  });

  it('renders system actors and quarantined rows without failing the history list', () => {
    marketplaceView.notifications = [
      {
        id: '00000000-0000-4000-8000-000000000931',
        recipientPubky: 'y'.repeat(52),
        actorPubky: 'system',
        type: 'payment_confirmed',
        aggregateId: 'order:placeholder',
        createdAt: '2026-08-20T11:00:00.000Z',
        readAt: null,
      },
      {
        kind: 'unrecognized',
        id: 'row-1',
        type: 'payment_method_bound',
        createdAt: '2026-08-20T11:01:00.000Z',
      },
    ];

    const { getByText, queryByText } = render(<MarketplaceNotifications />);

    expect(getByText('From System')).toBeInTheDocument();
    expect(getByText('Payment method connected')).toBeInTheDocument();
    expect(queryByText(/history may be incomplete/)).not.toBeInTheDocument();
    expect(queryByText('Integrity notice')).not.toBeInTheDocument();
    expect(queryByText(/not available yet/)).not.toBeInTheDocument();
  });

  it('keeps the incomplete-history banner for a type the Shop has no copy for', () => {
    marketplaceView.notifications = [
      {
        kind: 'unrecognized',
        id: 'row-gap',
        type: 'payment_hold_acquired_unknown',
        createdAt: '2026-08-20T11:02:00.000Z',
      },
    ];

    render(<MarketplaceNotifications />);

    expect(screen.getByRole('status')).toHaveTextContent(/history may be incomplete/);
    expect(screen.getByText('Integrity notice')).toBeInTheDocument();
    expect(screen.getByText('Unrecognized marketplace event')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Unrecognized marketplace event' })).not.toBeInTheDocument();
  });

  it('links a new offer activity row to its offer anchor', () => {
    marketplaceView.notifications = [
      {
        id: '00000000-0000-4000-8000-000000000932',
        recipientPubky: 'y'.repeat(52),
        actorPubky: 'b'.repeat(52),
        type: 'offer_received',
        aggregateId: 'offer:00000000-0000-4000-8000-000000000933',
        createdAt: '2026-08-20T11:00:00.000Z',
        readAt: null,
      },
    ];

    render(<MarketplaceNotifications />);

    const link = screen.getByRole('link', { name: 'New offer received' });
    expect(link).toHaveAttribute('href', '/marketplace/offers#offer-00000000-0000-4000-8000-000000000933');
    expect(link.tagName).toBe('A');
    expect(link).not.toHaveAttribute('tabindex', '-1');
  });

  it('links an order event to that order and a message to its thread', () => {
    const orderId = '018f47d2-6a27-7c23-a62f-000000000001';
    const seller = 's'.repeat(52);
    const buyer = 'b'.repeat(52);
    const conversation = `conversation:${seller}_${buyer}_listing-1`;
    marketplaceView.notifications = [
      {
        id: '00000000-0000-4000-8000-000000000934',
        recipientPubky: 'y'.repeat(52),
        actorPubky: buyer,
        type: 'payment_confirmed',
        aggregateId: `order:${orderId}`,
        createdAt: '2026-08-20T11:00:00.000Z',
        readAt: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000935',
        recipientPubky: 'y'.repeat(52),
        actorPubky: buyer,
        type: 'message_received',
        aggregateId: conversation,
        createdAt: '2026-08-20T11:01:00.000Z',
        readAt: null,
      },
    ];

    render(<MarketplaceNotifications />);

    expect(screen.getByRole('link', { name: 'Payment confirmed' })).toHaveAttribute(
      'href',
      `/marketplace/orders#order-${orderId}`,
    );
    expect(screen.getByRole('link', { name: 'New marketplace message' })).toHaveAttribute(
      'href',
      `/marketplace/messages?conversation=${encodeURIComponent(conversation)}`,
    );
  });

  it('titles a digital delivery as a purchase, and a shipped one as before', () => {
    const buyer = 'y'.repeat(52);
    const seller = 's'.repeat(52);
    const row = (id: string, actorPubky: string, orderFulfillment: string | null, createdAt: string) => ({
      id,
      recipientPubky: buyer,
      actorPubky,
      type: 'order_delivered',
      aggregateId: 'order:018f47d2-6a27-7c23-a62f-000000000002',
      createdAt,
      readAt: null,
      orderFulfillment,
    });
    marketplaceView.notifications = [
      row('00000000-0000-4000-8000-000000000941', 'system', 'digital', '2026-09-27T07:03:00.000Z'),
      row('00000000-0000-4000-8000-000000000942', seller, 'digital', '2026-09-27T07:02:00.000Z'),
      row('00000000-0000-4000-8000-000000000943', buyer, 'shipping', '2026-09-27T07:01:00.000Z'),
    ];

    render(<MarketplaceNotifications />);

    expect(screen.getByRole('link', { name: 'Purchase ready to download' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Purchase delivered' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Delivery confirmed' })).toBeInTheDocument();
  });

  it('says what a return update was, in the order the events happened', () => {
    const orderId = '018f47d2-6a27-7c23-a62f-000000000001';
    ordersView.orders = [{ order: { id: orderId, returnRequest: { reason: 'mistake on my part' } } }];
    marketplaceView.notifications = [
      {
        id: '00000000-0000-4000-8000-000000000942',
        recipientPubky: 'y'.repeat(52),
        actorPubky: 's'.repeat(52),
        type: 'return_updated',
        aggregateId: `order:${orderId}`,
        createdAt: '2026-08-19T00:00:00.000Z',
        readAt: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000941',
        recipientPubky: 'y'.repeat(52),
        actorPubky: 'b'.repeat(52),
        type: 'return_updated',
        aggregateId: `order:${orderId}`,
        createdAt: '2026-08-14T00:00:00.000Z',
        readAt: null,
      },
    ];

    render(<MarketplaceNotifications />);

    expect(screen.getByRole('link', { name: 'Return requested — mistake on my part' })).toHaveAttribute(
      'href',
      `/marketplace/orders#order-${orderId}`,
    );
    expect(screen.getByRole('link', { name: 'Return approved' })).toHaveAttribute(
      'href',
      `/marketplace/orders#order-${orderId}`,
    );
  });

  it('labels each PayPal refund row from its own data, not the order it later became', () => {
    const orderId = '018f47d2-6a27-7c23-a62f-000000000003';
    const total = { amountMinor: 250, currency: 'USD', exponent: 2 };
    const row = (id: string, type: string, createdAt: string) => ({
      id,
      recipientPubky: 'y'.repeat(52),
      actorPubky: 'paypal-ipn',
      type,
      aggregateId: `order:${orderId}`,
      createdAt,
      readAt: null,
    });
    // An ordinary partial refund, then a reversal: the service sends both as
    // `refund_recorded` with no subtype and no amount.
    marketplaceView.notifications = [
      row('00000000-0000-4000-8000-000000000946', 'refund_recorded', '2026-09-24T19:00:00.000Z'),
      row('00000000-0000-4000-8000-000000000945', 'refund_recorded', '2026-09-24T18:00:00.000Z'),
    ];
    ordersView.orders = [
      {
        order: {
          id: orderId,
          state: 'shipped',
          total,
          externalRefund: { amountMinor: 189 },
          paymentReversedAt: '2026-09-24T19:00:00.000Z',
        },
      },
    ];

    const { rerender } = render(<MarketplaceNotifications />);

    const titles = () => screen.getAllByRole('link').map((link) => link.getAttribute('aria-label'));
    expect(titles()).toEqual(['Refund recorded', 'Refund recorded']);
    expect(screen.queryByText(/Payment reversed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Refunded \$1\.89 of \$2\.50/)).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('href', `/marketplace/orders#order-${orderId}`);
    }

    // PayPal cancels the reversal: the same rows keep the same titles.
    marketplaceView.notifications = [
      row('00000000-0000-4000-8000-000000000947', 'payment_reversal_cancelled', '2026-09-24T20:00:00.000Z'),
      ...marketplaceView.notifications,
    ];
    ordersView.orders = [
      { order: { id: orderId, state: 'shipped', total, externalRefund: { amountMinor: 50 }, paymentReversedAt: null } },
    ];
    rerender(<MarketplaceNotifications />);

    expect(titles()).toEqual(['Disputed payment restored', 'Refund recorded', 'Refund recorded']);
    expect(screen.queryByText(/history may be incomplete/)).not.toBeInTheDocument();
    expect(screen.queryByText('Unrecognized marketplace event')).not.toBeInTheDocument();
  });

  it('shows a refund amount only when the row itself carries one', () => {
    marketplaceView.notifications = [
      {
        id: '00000000-0000-4000-8000-000000000948',
        recipientPubky: 'y'.repeat(52),
        actorPubky: 'paypal-ipn',
        type: 'refund_recorded',
        aggregateId: 'order:018f47d2-6a27-7c23-a62f-000000000004',
        amount: { amountMinor: 189, currency: 'USD', exponent: 2 },
        createdAt: '2026-09-24T18:00:00.000Z',
        readAt: null,
      },
    ];

    render(<MarketplaceNotifications />);

    expect(screen.getByText('Refund recorded · $1.89')).toBeInTheDocument();
  });

  it('opens Checkout started on that order, and on checkout only while the order can still be checked out', () => {
    const orderId = '018f47d2-6a27-7c23-a62f-000000000010';
    const buyer = 'b'.repeat(52);
    authStoreState.currentUserPubky = buyer;
    marketplaceView.notifications = [
      {
        id: '00000000-0000-4000-8000-000000000950',
        recipientPubky: buyer,
        actorPubky: 's'.repeat(52),
        type: 'order_created',
        aggregateId: `order:${orderId}`,
        createdAt: '2026-08-20T00:00:00.000Z',
        readAt: null,
      },
    ];
    ordersView.orders = [{ order: { id: orderId, state: 'cancelled', buyerPubky: buyer } }];

    const { rerender } = render(<MarketplaceNotifications />);
    const link = () => screen.getByRole('link', { name: 'Checkout started' });

    expect(link()).toHaveAttribute('href', `/marketplace/orders#order-${orderId}`);

    ordersView.orders = [{ order: { id: orderId, state: 'pending_payment', buyerPubky: buyer } }];
    rerender(<MarketplaceNotifications />);
    expect(link()).toHaveAttribute('href', `/marketplace/checkout#${orderId}`);

    authStoreState.currentUserPubky = 's'.repeat(52);
    rerender(<MarketplaceNotifications />);
    expect(link()).toHaveAttribute('href', `/marketplace/orders#order-${orderId}`);

    authStoreState.currentUserPubky = buyer;
    ordersView.orders = [];
    rerender(<MarketplaceNotifications />);
    expect(link()).toHaveAttribute('href', `/marketplace/orders#order-${orderId}`);

    ordersView.isLoading = true;
    ordersView.orders = [{ order: { id: orderId, state: 'pending_payment', buyerPubky: buyer } }];
    rerender(<MarketplaceNotifications />);
    expect(link()).toHaveAttribute('href', `/marketplace/orders#order-${orderId}`);
  });

  it('still links a known event whose row failed schema checks', () => {
    marketplaceView.notifications = [
      {
        kind: 'unrecognized',
        id: 'row-known',
        type: 'payment_method_bound',
        createdAt: '2026-08-20T11:01:00.000Z',
      },
    ];

    render(<MarketplaceNotifications />);

    expect(screen.getByRole('link', { name: 'Payment method connected' })).toHaveAttribute(
      'href',
      '/marketplace/orders',
    );
  });

  it('shows the buyer confirming a USDT refund address as a known event that links to the order', () => {
    const orderId = '018f47d2-6a27-7c23-a62f-0000000000d1';
    marketplaceView.notifications = [
      {
        id: '018f47d2-6a27-7c23-a62f-0000000000d2',
        recipientPubky: 's'.repeat(52),
        actorPubky: 'b'.repeat(52),
        type: 'refund_destination_confirmed',
        aggregateId: `order:${orderId}`,
        createdAt: '2026-10-10T09:00:00.000Z',
        readAt: null,
      },
    ];

    render(<MarketplaceNotifications />);

    expect(screen.getByRole('link', { name: 'The buyer confirmed a USDT refund address' })).toHaveAttribute(
      'href',
      `/marketplace/orders#order-${orderId}`,
    );
    expect(screen.queryByText(/history may be incomplete/)).not.toBeInTheDocument();
    expect(screen.queryByText('Unrecognized marketplace event')).not.toBeInTheDocument();
  });

  it('shows each seller Bitcoin notice as its own sentence and links it to the order', () => {
    const orderId = '018f47d2-6a27-7c23-a62f-0000000000c1';
    const seller = 's'.repeat(52);
    const row = (id: string, type: string, reviewReason: string | null) => ({
      id,
      recipientPubky: seller,
      actorPubky: 'system',
      type,
      aggregateId: `order:${orderId}`,
      createdAt: '2026-09-28T10:56:41.000Z',
      readAt: null,
      reviewReason,
    });
    marketplaceView.notifications = [
      row('018f47d2-6a27-7c23-a62f-0000000000b1', 'bitcoin_payment_seen', null),
      row('018f47d2-6a27-7c23-a62f-0000000000b2', 'bitcoin_manual_review', 'late_settlement'),
      row('018f47d2-6a27-7c23-a62f-0000000000b3', 'bitcoin_manual_review', 'amount_mismatch'),
      row('018f47d2-6a27-7c23-a62f-0000000000b4', 'bitcoin_manual_review', 'confirmation_failed'),
      row('018f47d2-6a27-7c23-a62f-0000000000b5', 'bitcoin_manual_review', 'seller_confirmation_window_elapsed'),
      row('018f47d2-6a27-7c23-a62f-0000000000b6', 'bitcoin_manual_review', 'seller_response_overdue'),
      { kind: 'unrecognized', id: 'future', type: 'future_bitcoin_notice', createdAt: '2026-09-28T10:56:41.000Z' },
    ];

    render(<MarketplaceNotifications />);

    const orderHref = `/marketplace/orders#order-${orderId}`;
    const sentences = [
      'A Bitcoin payment is waiting for your confirmation',
      'A Bitcoin payment settled late and needs your decision',
      'A Bitcoin payment amount does not match the invoice',
      'A confirmed Bitcoin payment could not be applied to this order',
      'The confirmation window ended before you confirmed this payment',
      'This Bitcoin payment has waited two business days for your decision',
    ];
    for (const sentence of sentences) {
      expect(screen.getByRole('link', { name: sentence })).toHaveAttribute('href', orderHref);
    }
    expect(screen.getByText('Unrecognized marketplace event')).toBeInTheDocument();
    expect(screen.getByText(/1 unrecognized marketplace event/)).toBeInTheDocument();
  });
});
