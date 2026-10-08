import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceOrderPayment } from '@/hooks/useMarketplaceOrderPayment/useMarketplaceOrderPayment';
import {
  CHECKOUT_HOLD_COPY,
  holderBoundCopy,
  holderUnboundCopy,
  UNBOUND_BACK_CANCEL_REASON,
} from '@/libs/commerce/checkout-hold';
import { LOCKS_ADMISSION_COPY } from '@/libs/commerce/locks-lifecycle';
import { createOrderFixture, createPaymentFixture } from '@/test/fixtures/commerce/orders';
import { MarketplacePaymentStatusCard } from './MarketplacePaymentStatusCard';

const runtime = vi.hoisted(() => ({ deployEnv: 'production' as 'production' | 'staging' | undefined }));
const auth = vi.hoisted(() => ({ currentUserPubky: 's'.repeat(52) }));
const buyerWallet = vi.hoisted(() => ({
  state: 'payable' as 'checking' | 'payable' | 'not_payable' | 'unsupported' | 'unverified' | 'unknown',
  calls: [] as { buyerPubky: string | null; enabled: boolean }[],
  recheck: vi.fn(),
}));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => runtime.deployEnv };
});

const locksView = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));

vi.mock('@/hooks/useMarketplaceLocksPayment/useMarketplaceLocksPayment', () => ({
  useMarketplaceLocksPayment: () => ({
    enabled: false,
    correlation: null,
    isStarting: false,
    isUnlocking: false,
    delivery: null,
    error: null,
    pollExhausted: false,
    start: vi.fn(),
    unlock: vi.fn(),
    resumePolling: vi.fn(),
    admission: null,
    ...locksView.overrides,
  }),
}));

vi.mock('@/hooks/useBuyerPaykitWallet/useBuyerPaykitWallet', () => ({
  useBuyerPaykitWallet: (buyerPubky: string | null, enabled: boolean) => {
    buyerWallet.calls.push({ buyerPubky, enabled });
    return { state: enabled ? buyerWallet.state : 'idle', recheck: buyerWallet.recheck };
  },
}));

vi.mock('@/hooks/useMarketplaceOrderPayment/useMarketplaceOrderPayment', () => ({
  useMarketplaceOrderPayment: vi.fn(() => ({
    availableMethods: null,
    bitcoinOfferUnavailable: false,
    configError: null,
    pendingAction: null,
    bind: vi.fn(),
    verifyStripe: vi.fn(),
    markPaid: vi.fn(),
    confirmReceived: vi.fn(),
  })),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getOrFetchListing: vi.fn(async () => ({ digitalLock: null })),
    executeMarketplaceCommand: vi.fn(async () => ({ ok: true })),
  },
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: auth.currentUserPubky }),
}));

describe('MarketplacePaymentStatusCard', () => {
  beforeEach(() => {
    runtime.deployEnv = 'production';
    auth.currentUserPubky = 's'.repeat(52);
    buyerWallet.state = 'payable';
    buyerWallet.calls = [];
    buyerWallet.recheck.mockReset();
    vi.mocked(useMarketplaceOrderPayment).mockReturnValue({
      availableMethods: null,
      bitcoinOfferUnavailable: false,
      configError: null,
      pendingAction: null,
      bind: vi.fn(),
      verifyStripe: vi.fn(),
      markPaid: vi.fn(),
      confirmReceived: vi.fn(),
    });
  });

  it('renders every null seller observation fact as Not provided without hiding the CTA', () => {
    const payment = createPaymentFixture('awaiting_entitlement', { adapter: 'paykit' });
    const order = createOrderFixture('pending_payment', {
      paymentId: payment.id,
      paymentMethod: 'bitcoin',
      paykitRequestState: 'awaiting_seller_confirmation',
      paykitObservation: {
        txid: null,
        observedSats: null,
        confirmations: null,
        amountMatched: null,
        disappeared: null,
        observedAt: null,
      },
    });

    render(
      <MarketplacePaymentStatusCard
        order={order}
        payment={payment}
        isBuyer={false}
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByTestId('seller-bitcoin-confirm-prompt')).toHaveTextContent(/^Confirm you received /);
    expect(screen.getAllByText('Not provided')).toHaveLength(7);
  });

  it('prompts the seller with the exact bitcoin amount once a payment is seen', () => {
    const payment = createPaymentFixture('awaiting_entitlement', { adapter: 'paykit' });
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', {
          paymentId: payment.id,
          paymentMethod: 'bitcoin',
          paykitRequestState: 'awaiting_seller_confirmation',
          paykitTotalSats: 1_303,
          merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
          bitcoinPayable: { amountMinor: 1_303, currency: 'SAT', exponent: 0 },
          subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
          shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
          total: { amountMinor: 1_303, currency: 'BTC', exponent: 8 },
        })}
        payment={payment}
        isBuyer={false}
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByTestId('seller-bitcoin-confirm-prompt')).toHaveTextContent('Confirm you received ₿1,303');
    expect(screen.queryByText(/Open Bitkit to pay/)).not.toBeInTheDocument();
  });

  it('focuses the confirmation reason after static validation fails', async () => {
    const payment = createPaymentFixture('awaiting_entitlement', { adapter: 'paykit' });
    const order = createOrderFixture('pending_payment', {
      paymentId: payment.id,
      paymentMethod: 'bitcoin',
      paykitRequestState: 'awaiting_seller_confirmation',
      paykitObservation: {},
    });
    render(
      <MarketplacePaymentStatusCard
        order={order}
        payment={payment}
        isBuyer={false}
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    const reason = screen.getByLabelText('Seller note (optional)');
    fireEvent.change(reason, { target: { value: 'x'.repeat(501) } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm payment received' }));

    await waitFor(() => expect(reason).toHaveFocus());
  });

  it.each(['transaction-service', 'locks-paykit', 'unavailable'] as const)(
    'does not show a production money warning in %s mode',
    (adapterMode) => {
      render(
        <MarketplacePaymentStatusCard
          order={createOrderFixture('pending_payment')}
          payment={createPaymentFixture('awaiting_entitlement')}
          isBuyer
          adapterMode={adapterMode}
          advancePayment={async () => false}
          onPaymentChanged={() => {}}
        />,
      );

      expect(screen.queryByRole('note')).not.toBeInTheDocument();
      expect(
        screen.queryByText('Real money. Payments are final and go directly to the seller.'),
      ).not.toBeInTheDocument();
    },
  );

  it('shows the staging notice on a staging deploy', () => {
    runtime.deployEnv = 'staging';
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment')}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByRole('note')).toHaveTextContent('Staging environment — test rails, no real funds move');
    expect(screen.queryByText(/Real money/)).not.toBeInTheDocument();
  });

  it('does not show a production money warning when the deploy environment is unknown', () => {
    runtime.deployEnv = undefined;
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment')}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Real money/)).not.toBeInTheDocument();
  });

  it('shows the sandbox badge without any payment notice, even on a staging deploy', () => {
    runtime.deployEnv = 'staging';
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment')}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="sandbox"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText('Sandbox · simulated payment · no real funds')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('does not show the payment notice for sellers or terminal orders', () => {
    const payment = createPaymentFixture('awaiting_entitlement');
    const seller = render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', { paymentId: payment.id })}
        payment={payment}
        isBuyer={false}
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );
    expect(seller.queryByRole('note')).not.toBeInTheDocument();

    seller.unmount();
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('completed', { paymentId: payment.id })}
        payment={payment}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('explains that PayPal buyer self-reporting does not confirm marketplace payment', () => {
    const payment = createPaymentFixture('awaiting_entitlement');
    const order = createOrderFixture('pending_payment', {
      paymentId: payment.id,
      paymentMethod: 'paypal',
      fiatCheckoutUrl: 'https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=seller%40example.com',
      fiatVerification: 'seller-attested',
    });

    render(
      <MarketplacePaymentStatusCard
        order={order}
        payment={payment}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText(/Use this only if automatic confirmation fails/i)).toBeInTheDocument();
    expect(screen.getByText(/seller must verify your PayPal transaction ID before shipping/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /I.ve paid/ })).toBeInTheDocument();
  });

  it('explains when Bitcoin is temporarily unavailable while other methods remain available', () => {
    vi.mocked(useMarketplaceOrderPayment).mockReturnValue({
      availableMethods: ['stripe'],
      bitcoinOfferUnavailable: true,
      configError: null,
      pendingAction: null,
      bind: vi.fn(),
      verifyStripe: vi.fn(),
      markPaid: vi.fn(),
      confirmReceived: vi.fn(),
    });

    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment')}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(
      screen.getByText('Bitcoin is temporarily unavailable. Other payment methods are unaffected.'),
    ).toBeInTheDocument();
    expect(screen.getByText('The item is held for you once a payment starts.')).toBeInTheDocument();
    expect(screen.queryByText(/never holds funds/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stripe/ })).not.toBeInTheDocument();
  });

  it.each(['cancelled', 'refunded_external', 'closed', 'completed'] as const)(
    'does not show payment instructions for terminal %s orders',
    (state) => {
      const payment = createPaymentFixture('awaiting_entitlement');

      render(
        <MarketplacePaymentStatusCard
          order={createOrderFixture(state, { paymentId: payment.id })}
          payment={payment}
          isBuyer
          adapterMode="transaction-service"
          advancePayment={async () => false}
          onPaymentChanged={() => {}}
        />,
      );

      expect(screen.queryByText('Awaiting payment')).not.toBeInTheDocument();
      expect(screen.queryByText(/seller has not set up any payment methods/i)).not.toBeInTheDocument();
    },
  );

  it('keeps confirmed Locks delivery visible after order completion', () => {
    const payment = createPaymentFixture('confirmed', { adapter: 'locks' });

    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('completed', { paymentId: payment.id })}
        payment={payment}
        isBuyer
        adapterMode="locks-paykit"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
  });

  describe('Locks invoice admission (pubky/locks#72)', () => {
    const registered = { id: 'c', registered: true, window_expires_at: null };
    const renderAwaiting = () => {
      const payment = createPaymentFixture('awaiting_entitlement', { adapter: 'locks' });
      render(
        <MarketplacePaymentStatusCard
          order={createOrderFixture('pending_payment', { paymentId: payment.id })}
          payment={payment}
          isBuyer
          adapterMode="locks-paykit"
          advancePayment={async () => false}
          onPaymentChanged={() => {}}
        />,
      );
    };

    afterEach(() => {
      locksView.overrides = {};
    });

    it('shows Reader wallet setup needed while the request is admitted, with no new request action', () => {
      locksView.overrides = {
        correlation: registered,
        admission: { kind: 'in_flight', readerWalletSetupNeeded: true },
      };
      renderAwaiting();

      expect(screen.getByTestId('locks-reader-wallet-setup')).toHaveTextContent(LOCKS_ADMISSION_COPY.walletSetupTitle);
      expect(screen.getByTestId('locks-reader-wallet-setup')).toHaveTextContent(
        'This page keeps checking, so you don’t need to request the payment again.',
      );
      expect(screen.getByText(/Payment request sent/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Request payment in your wallet|Retry registration/ })).toBeNull();
    });

    it.each([
      ['reader_not_payable', LOCKS_ADMISSION_COPY.readerNotPayable],
      ['admission_deadline_exceeded', LOCKS_ADMISSION_COPY.admissionDeadlineExceeded],
      ['failed', LOCKS_ADMISSION_COPY.failed],
    ] as const)('shows the %s admission failure in place of the wait, with no retry', (failure, copy) => {
      locksView.overrides = { correlation: registered, admission: { kind: 'failed', failure } };
      renderAwaiting();

      expect(screen.getByTestId('locks-admission-failed')).toHaveTextContent(copy);
      expect(screen.queryByText(/Payment request sent/)).toBeNull();
      expect(screen.queryByTestId('locks-reader-wallet-setup')).toBeNull();
      expect(screen.queryByRole('button', { name: /Request payment|Retry|Keep checking/ })).toBeNull();
    });
  });

  it('renders unbound hold copy and Back cancel on the method picker', async () => {
    const onPaymentChanged = vi.fn();
    vi.mocked(useMarketplaceOrderPayment).mockReturnValue({
      availableMethods: ['bitcoin', 'stripe', 'paypal'],
      bitcoinOfferUnavailable: false,
      configError: null,
      pendingAction: null,
      bind: vi.fn(),
      verifyStripe: vi.fn(),
      markPaid: vi.fn(),
      confirmReceived: vi.fn(),
    });
    const holdExpiresAt = '2026-08-20T21:15:00.000Z';
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', { holdExpiresAt, holdSource: 'checkout' })}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={onPaymentChanged}
      />,
    );

    expect(screen.getByText(holderUnboundCopy(holdExpiresAt))).toBeInTheDocument();
    expect(screen.queryByText('Real money. Payments are final and go directly to the seller.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Choose how to pay/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pays the seller directly/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/never holds funds/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() =>
      expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'order.cancel_request',
          payload: expect.objectContaining({ reason: UNBOUND_BACK_CANCEL_REASON }),
        }),
      ),
    );
    await waitFor(() => expect(onPaymentChanged).toHaveBeenCalled());
  });

  it('keeps a Bitkit 2.6 buyer off Bitcoin on the method picker and leaves PayPal open', () => {
    const buyer = 'b'.repeat(52);
    auth.currentUserPubky = buyer;
    buyerWallet.state = 'unsupported';
    vi.mocked(useMarketplaceOrderPayment).mockReturnValue({
      availableMethods: ['bitcoin', 'paypal'],
      bitcoinOfferUnavailable: false,
      configError: null,
      pendingAction: null,
      bind: vi.fn(),
      verifyStripe: vi.fn(),
      markPaid: vi.fn(),
      confirmReceived: vi.fn(),
    });
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', { holdSource: 'checkout' })}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(buyerWallet.calls).toContainEqual({ buyerPubky: buyer, enabled: true });
    const notice = screen.getByTestId('order-payment-bitkit-unsupported');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent('Bitcoin checkout does not support Bitkit 2.6 yet');
    expect(notice).toHaveTextContent('You can pay with PayPal instead.');
    expect(screen.getByRole('button', { name: /Bitcoin/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /PayPal/ })).toBeEnabled();
  });

  it('holds Bitcoin on the method picker until an unverified wallet is checked again', () => {
    buyerWallet.state = 'unverified';
    vi.mocked(useMarketplaceOrderPayment).mockReturnValue({
      availableMethods: ['bitcoin', 'paypal'],
      bitcoinOfferUnavailable: false,
      configError: null,
      pendingAction: null,
      bind: vi.fn(),
      verifyStripe: vi.fn(),
      markPaid: vi.fn(),
      confirmReceived: vi.fn(),
    });
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', { holdSource: 'checkout' })}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    const notice = screen.getByTestId('order-payment-bitkit-unverified');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent("Couldn't verify your Bitcoin wallet");
    expect(screen.getByRole('button', { name: /Bitcoin/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /PayPal/ })).toBeEnabled();
    fireEvent.click(screen.getByTestId('order-payment-bitkit-unverified-recheck'));
    expect(buyerWallet.recheck).toHaveBeenCalledTimes(1);
  });

  it('holds Bitcoin on the method picker while checking, then leaves it open for a payable or unchecked wallet', () => {
    vi.mocked(useMarketplaceOrderPayment).mockReturnValue({
      availableMethods: ['bitcoin', 'paypal'],
      bitcoinOfferUnavailable: false,
      configError: null,
      pendingAction: null,
      bind: vi.fn(),
      verifyStripe: vi.fn(),
      markPaid: vi.fn(),
      confirmReceived: vi.fn(),
    });
    const props = {
      order: createOrderFixture('pending_payment', { holdSource: 'checkout' }),
      payment: createPaymentFixture('awaiting_entitlement'),
      adapterMode: 'transaction-service' as const,
      advancePayment: async () => false,
      onPaymentChanged: () => {},
    };
    buyerWallet.state = 'checking';
    const { rerender } = render(<MarketplacePaymentStatusCard {...props} isBuyer />);
    expect(screen.getByRole('button', { name: /Bitcoin/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /PayPal/ })).toBeEnabled();
    expect(screen.getByText('Checking your Bitcoin wallet…')).toBeInTheDocument();

    buyerWallet.state = 'payable';
    rerender(<MarketplacePaymentStatusCard {...props} isBuyer />);
    expect(screen.getByRole('button', { name: /Bitcoin/ })).toBeEnabled();
    expect(screen.queryByText('Checking your Bitcoin wallet…')).not.toBeInTheDocument();
    expect(screen.queryByTestId('order-payment-bitkit-unsupported')).not.toBeInTheDocument();

    buyerWallet.state = 'unknown';
    rerender(<MarketplacePaymentStatusCard {...props} isBuyer />);
    expect(screen.getByRole('button', { name: /Bitcoin/ })).toBeEnabled();

    // A seller viewing the order never triggers the buyer wallet read.
    buyerWallet.calls = [];
    buyerWallet.state = 'unsupported';
    rerender(<MarketplacePaymentStatusCard {...props} isBuyer={false} />);
    expect(buyerWallet.calls.every((call) => !call.enabled)).toBe(true);
    expect(screen.queryByTestId('order-payment-bitkit-unsupported')).not.toBeInTheDocument();
  });

  it('renders bound hold copy after a payment method is chosen', () => {
    const holdExpiresAt = '2026-08-20T21:15:00.000Z';
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', {
          holdExpiresAt,
          holdSource: 'bind',
          paymentMethod: 'bitcoin',
          paykitRequestState: 'pending',
        })}
        payment={createPaymentFixture('awaiting_entitlement', { adapter: 'paykit' })}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText(holderBoundCopy(holdExpiresAt))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('says the Bitcoin request is waiting for the wallet, then delivered, never "delivered" at activation', () => {
    const renderBound = (paykitDeliveryState: string | null) =>
      render(
        <MarketplacePaymentStatusCard
          order={createOrderFixture('pending_payment', {
            holdExpiresAt: '2026-08-20T21:15:00.000Z',
            holdSource: 'bind',
            paymentMethod: 'bitcoin',
            paykitRequestState: 'pending',
            paykitDeliveryState,
          })}
          payment={createPaymentFixture('awaiting_entitlement', { adapter: 'paykit' })}
          isBuyer
          adapterMode="transaction-service"
          advancePayment={async () => false}
          onPaymentChanged={() => {}}
        />,
      );
    for (const state of [null, 'pending']) {
      const { unmount } = renderBound(state);
      expect(screen.getByTestId('paykit-delivery-status')).toHaveTextContent('Waiting for your wallet');
      expect(screen.queryByText(/delivered privately/)).not.toBeInTheDocument();
      unmount();
    }
    const { unmount } = renderBound('delivered');
    expect(screen.getByTestId('paykit-delivery-status')).toHaveTextContent('Sent to your wallet');
    expect(screen.queryByText(/Delivered/)).not.toBeInTheDocument();
    unmount();
  });

  it('stops telling the buyer to pay once the payment has been seen', () => {
    const deadline = '2026-09-29T10:56:41.980Z';
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', {
          holdExpiresAt: deadline,
          holdSource: 'bind',
          paymentMethod: 'bitcoin',
          paykitRequestState: 'awaiting_seller_confirmation',
          paykitDeliveryState: 'delivered',
          paykitSellerConfirmationDeadline: deadline,
          paykitTotalSats: 1_303,
          merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
          bitcoinPayable: { amountMinor: 1_303, currency: 'SAT', exponent: 0 },
          subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
          shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
          total: { amountMinor: 1_303, currency: 'BTC', exponent: 8 },
        })}
        payment={createPaymentFixture('awaiting_entitlement', { adapter: 'paykit' })}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByTestId('bitcoin-payment-seen')).toHaveTextContent(
      "Payment seen — waiting for confirmation. You don't need to do anything else.",
    );
    expect(screen.getByTestId('bitcoin-seller-confirms-by')).toHaveTextContent(
      'Seller confirms by Sep 29, 2026, 10:56 AM UTC.',
    );
    expect(screen.queryByText(/Open Bitkit to pay/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pay exactly/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pay by/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reserved while you pay/)).not.toBeInTheDocument();
  });

  describe('Bitcoin payment after broadcast', () => {
    const DEADLINE = '2026-09-29T10:56:41.980Z';
    const bitcoinAmounts = {
      merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
    } as const;

    const renderBitcoin = ({
      requestState,
      isBuyer = true,
      confirmations = 0,
      sats = 1_303,
    }: {
      requestState: 'pending' | 'detected' | 'awaiting_seller_confirmation';
      isBuyer?: boolean;
      confirmations?: number;
      sats?: number;
    }) =>
      render(
        <MarketplacePaymentStatusCard
          order={createOrderFixture('pending_payment', {
            holdExpiresAt: DEADLINE,
            holdSource: 'bind',
            paymentMethod: 'bitcoin',
            paykitRequestState: requestState,
            paykitDeliveryState: 'delivered',
            paykitSellerConfirmationDeadline: requestState === 'pending' ? null : DEADLINE,
            paykitTotalSats: sats,
            bitcoinPayable: { amountMinor: sats, currency: 'SAT', exponent: 0 },
            total: { amountMinor: sats, currency: 'BTC', exponent: 8 },
            ...bitcoinAmounts,
          })}
          payment={createPaymentFixture('awaiting_entitlement', { adapter: 'paykit', confirmations })}
          isBuyer={isBuyer}
          adapterMode="transaction-service"
          advancePayment={async () => false}
          onPaymentChanged={() => {}}
        />,
      );

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(new Date('2026-09-28T11:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('labels the payment seen, not awaiting payment, once the service has seen the transaction', () => {
      renderBitcoin({ requestState: 'awaiting_seller_confirmation' });
      const card = screen.getByText('Payment seen');
      expect(card).toBeInTheDocument();
      expect(screen.queryByText('Awaiting payment')).not.toBeInTheDocument();
      expect(screen.queryByText(/Open Bitkit to pay/)).not.toBeInTheDocument();
    });

    it('labels a chain-confirmed payment that is waiting on the seller', () => {
      renderBitcoin({ requestState: 'awaiting_seller_confirmation', confirmations: 1 });
      expect(screen.getByText('Confirmed on-chain')).toBeInTheDocument();
      expect(screen.queryByText('Awaiting payment')).not.toBeInTheDocument();
    });

    it('keeps Awaiting payment and the wallet instruction until the transaction is seen, and covers a payment already sent', () => {
      renderBitcoin({ requestState: 'pending', sats: 1_255 });
      expect(screen.getByText('Awaiting payment')).toBeInTheDocument();
      expect(screen.queryByText('Payment seen')).not.toBeInTheDocument();
      expect(screen.getByTestId('paykit-delivery-status')).toHaveTextContent(
        "Sent to your wallet. Open Bitkit to pay. If the request isn't there, check that the seller is one of your Bitkit contacts. If you have already sent the payment, this page updates as soon as the marketplace sees the transaction.",
      );
    });

    it('states the 24-hour hold and counts it down as H:MM:SS', () => {
      renderBitcoin({ requestState: 'awaiting_seller_confirmation' });
      expect(screen.getByTestId('bitcoin-seen-hold-copy')).toHaveTextContent(
        'Your payment was seen, so the item is held for you for up to 24 hours while the seller confirms it.',
      );
      expect(screen.getByTestId('bitcoin-seller-confirms-by')).toHaveTextContent(
        'Seller confirms by Sep 29, 2026, 10:56 AM UTC.',
      );
      expect(screen.getByTestId('bitcoin-hold-countdown')).toHaveTextContent('23:56:41 left');

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId('bitcoin-hold-countdown')).toHaveTextContent('23:56:40 left');

      act(() => {
        vi.advanceTimersByTime(59 * 1000);
      });
      expect(screen.getByTestId('bitcoin-hold-countdown')).toHaveTextContent('23:55:41 left');
    });

    it('keeps H:MM:SS under one hour', () => {
      vi.setSystemTime(new Date('2026-09-29T10:56:40.000Z'));
      renderBitcoin({ requestState: 'awaiting_seller_confirmation' });
      expect(screen.getByTestId('bitcoin-hold-countdown')).toHaveTextContent('0:00:01 left');
    });

    it('drops the countdown once the confirmation window has ended', () => {
      vi.setSystemTime(new Date('2026-09-29T11:00:00.000Z'));
      renderBitcoin({ requestState: 'awaiting_seller_confirmation' });
      expect(screen.queryByTestId('bitcoin-hold-countdown')).not.toBeInTheDocument();
      expect(screen.getByTestId('bitcoin-seller-confirms-by')).toHaveTextContent(
        'Seller confirms by Sep 29, 2026, 10:56 AM UTC.',
      );
    });

    it('explains the payment code to the buyer beside the breakdown', () => {
      renderBitcoin({ requestState: 'pending', sats: 1_255 });
      expect(screen.getByTestId('bitcoin-amount-due')).toHaveTextContent('Pay exactly ₿1,255');
      expect(screen.getByTestId('bitcoin-amount-breakdown')).toHaveTextContent(
        'Items ₿1,000 · Shipping ₿0 · Payment code ₿255 = Total ₿1,255',
      );
      expect(screen.getByTestId('bitcoin-payment-code-explanation')).toHaveTextContent(
        "Payment code ₿255: a small unique amount (1–999 sats) added so the seller's wallet can match your payment. It is included in the total you send.",
      );
    });

    it('keeps the payment-code explanation off the seller view', () => {
      renderBitcoin({ requestState: 'pending', isBuyer: false, sats: 1_255 });
      expect(screen.getByTestId('bitcoin-amount-breakdown')).toBeInTheDocument();
      expect(screen.queryByTestId('bitcoin-payment-code-explanation')).not.toBeInTheDocument();
    });
  });

  it('tells the buyer a confirmed payment in review is with the seller', () => {
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', {
          paymentMethod: 'bitcoin',
          paykitRequestState: 'confirmed',
          paykitDeliveryState: 'delivered',
        })}
        payment={createPaymentFixture('manual_review', { adapter: 'paykit', reviewReason: 'late_settlement' })}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByTestId('payment-manual-review-copy')).toHaveTextContent(
      'Payment confirmed on-chain. The seller is reviewing it.',
    );
    expect(screen.queryByText(/Open Bitkit to pay/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pay exactly/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pay by/)).not.toBeInTheDocument();
  });

  it('does not call a review the seller-confirmation window sent with 0 confirmations confirmed on-chain', () => {
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', {
          paymentMethod: 'bitcoin',
          paykitRequestState: 'confirmed',
          paykitDeliveryState: 'delivered',
        })}
        payment={createPaymentFixture('manual_review', { adapter: 'paykit', reviewReason: null, confirmations: 0 })}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByTestId('payment-manual-review-copy')).toHaveTextContent(
      'Payment received — the seller is reviewing it.',
    );
    expect(screen.queryByText(/on-chain/)).not.toBeInTheDocument();
  });

  it('does not call an unconfirmed manual review a chain confirmation', () => {
    auth.currentUserPubky = 'b'.repeat(52);
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', {
          holdExpiresAt: '2026-09-29T10:56:41.980Z',
          paymentMethod: 'bitcoin',
          paykitRequestState: 'pending',
          paykitDeliveryState: 'delivered',
        })}
        payment={createPaymentFixture('manual_review', { adapter: 'paykit', confirmations: 0 })}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByTestId('payment-manual-review-copy')).toHaveTextContent(
      'Payment received — the seller is reviewing it.',
    );
    expect(screen.queryByText(/confirmed on-chain/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open Bitkit to pay/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pay by/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reserved while you pay/)).not.toBeInTheDocument();
    expect(screen.queryByText('Resolve Bitcoin payment review')).not.toBeInTheDocument();
  });

  it('tells the buyer to add the seller as a Bitkit contact when delivery failed', () => {
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', {
          holdExpiresAt: '2026-08-20T21:15:00.000Z',
          holdSource: 'bind',
          paymentMethod: 'bitcoin',
          paykitRequestState: 'pending',
          paykitDeliveryState: 'failed',
        })}
        payment={createPaymentFixture('awaiting_entitlement', { adapter: 'paykit' })}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );
    expect(screen.getByTestId('paykit-delivery-failed')).toHaveTextContent(
      "Your wallet didn't receive the request. In Bitkit, add the seller as a contact, then try again.",
    );
    expect(screen.queryByTestId('paykit-delivery-status')).not.toBeInTheDocument();
  });

  it('keeps the wallet hint on an elapsed Bitcoin checkout whose request was never delivered', () => {
    const payment = createPaymentFixture('expired', { adapter: 'paykit' });
    const { unmount } = render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('cancelled', {
          paymentId: payment.id,
          cancellationReason: 'payment window elapsed',
          paymentMethod: 'bitcoin',
          paykitDeliveryState: 'pending',
        })}
        payment={payment}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );
    expect(screen.getByTestId('paykit-delivery-failed')).toBeInTheDocument();
    unmount();
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('cancelled', {
          paymentId: payment.id,
          cancellationReason: 'payment window elapsed',
          paymentMethod: 'bitcoin',
          paykitDeliveryState: 'delivered',
        })}
        payment={payment}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );
    expect(screen.queryByTestId('paykit-delivery-failed')).not.toBeInTheDocument();
  });

  it('renders late-completion copy for buyer and seller', () => {
    const payment = createPaymentFixture('confirmed');
    const { rerender } = render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('paid', {
          paymentId: payment.id,
          cancellationReason: 'payment window elapsed',
        })}
        payment={payment}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );
    expect(screen.getByText(CHECKOUT_HOLD_COPY.lateCompleteBuyer)).toBeInTheDocument();

    rerender(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('paid', {
          paymentId: payment.id,
          cancellationReason: 'payment window elapsed',
        })}
        payment={payment}
        isBuyer={false}
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );
    expect(screen.getByText(CHECKOUT_HOLD_COPY.lateCompleteSeller)).toBeInTheDocument();
  });

  it('renders refund_required copy for the buyer without seller bitcoin instructions', () => {
    auth.currentUserPubky = 'b'.repeat(52);
    const payment = createPaymentFixture('manual_review', {
      adapter: 'paykit',
      reviewReason: 'refund_required',
    });
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('cancelled', {
          paymentId: payment.id,
          paymentMethod: 'bitcoin',
          cancellationReason: 'payment window elapsed',
        })}
        payment={payment}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText(CHECKOUT_HOLD_COPY.refundRequiredBuyer)).toBeInTheDocument();
    expect(screen.queryByText(CHECKOUT_HOLD_COPY.refundRequiredBitcoinSeller)).not.toBeInTheDocument();
    expect(screen.queryByText('Resolve Bitcoin payment review')).not.toBeInTheDocument();
  });

  it('renders refund_required copy and hides Paid for the seller', () => {
    const payment = createPaymentFixture('manual_review', {
      adapter: 'paykit',
      reviewReason: 'refund_required',
    });
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('cancelled', {
          paymentId: payment.id,
          paymentMethod: 'bitcoin',
          cancellationReason: 'payment window elapsed',
        })}
        payment={payment}
        isBuyer={false}
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText(CHECKOUT_HOLD_COPY.refundRequiredBitcoinSeller)).toBeInTheDocument();
    expect(screen.queryByText(CHECKOUT_HOLD_COPY.refundRequiredBuyer)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Outcome')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Paid' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Refunded' })).toBeInTheDocument();
  });

  it('shows the exact bitcoin amount as items + shipping + payment code', () => {
    const payment = createPaymentFixture('awaiting_entitlement', { adapter: 'paykit' });
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', {
          paymentId: payment.id,
          paymentMethod: 'bitcoin',
          paykitRequestState: 'pending',
          paykitTotalSats: 1_255,
          merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
          bitcoinPayable: { amountMinor: 1_255, currency: 'SAT', exponent: 0 },
          subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
          shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
          total: { amountMinor: 1_255, currency: 'BTC', exponent: 8 },
        })}
        payment={payment}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByTestId('bitcoin-amount-due')).toHaveTextContent('Pay exactly ₿1,255');
    expect(screen.getByTestId('bitcoin-amount-breakdown')).toHaveTextContent(
      'Items ₿1,000 · Shipping ₿0 · Payment code ₿255 = Total ₿1,255',
    );
  });

  it('renders elapsed copy instead of the generic expired explanation', () => {
    const payment = createPaymentFixture('expired');
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('cancelled', {
          paymentId: payment.id,
          cancellationReason: 'payment window elapsed',
        })}
        payment={payment}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText(CHECKOUT_HOLD_COPY.expiredNoLateMoney)).toBeInTheDocument();
    expect(screen.queryByText(/reconciled manually/)).not.toBeInTheDocument();
  });

  describe('paid Bitcoin order', () => {
    const renderPaid = ({
      isBuyer = true,
      payment = {},
      order = {},
    }: {
      isBuyer?: boolean;
      payment?: Parameters<typeof createPaymentFixture>[1];
      order?: Parameters<typeof createOrderFixture>[1];
    }) => {
      const paid = createPaymentFixture('confirmed', { adapter: 'paykit', confirmations: 0, ...payment });
      return render(
        <MarketplacePaymentStatusCard
          order={createOrderFixture('paid', {
            paymentId: paid.id,
            paymentMethod: 'bitcoin',
            paykitRequestState: 'confirmed',
            paykitDeliveryState: 'delivered',
            ...order,
          })}
          payment={paid}
          isBuyer={isBuyer}
          adapterMode="transaction-service"
          advancePayment={async () => false}
          onPaymentChanged={() => {}}
        />,
      );
    };

    it('names the seller, not the chain, when the seller confirmed at 0 confirmations', () => {
      renderPaid({});
      expect(screen.getByText('Seller confirmed payment')).toBeInTheDocument();
      expect(screen.getByTestId('bitcoin-seller-confirmed-before-chain')).toHaveTextContent(
        'The seller confirmed they received your payment before the marketplace saw an on-chain confirmation. Your wallet shows when the transaction confirms.',
      );
      expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument();
      expect(screen.queryByText(/Confirmed on-chain/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('bitcoin-on-chain-badge')).not.toBeInTheDocument();
    });

    it('tells the seller they confirmed before the chain did', () => {
      renderPaid({ isBuyer: false });
      expect(screen.getByText('Seller confirmed payment')).toBeInTheDocument();
      expect(screen.getByTestId('bitcoin-seller-confirmed-before-chain')).toHaveTextContent(
        'You confirmed this payment before the marketplace saw an on-chain confirmation.',
      );
    });

    it('shows the on-chain state as its own badge once a confirmation was recorded', () => {
      renderPaid({ payment: { confirmations: 1 } });
      expect(screen.getByText('Seller confirmed payment')).toBeInTheDocument();
      expect(screen.getByTestId('bitcoin-on-chain-badge')).toHaveTextContent('Confirmed on-chain');
      expect(screen.queryByTestId('bitcoin-seller-confirmed-before-chain')).not.toBeInTheDocument();
    });

    it('counts a resolved late settlement as on-chain even with 0 recorded confirmations', () => {
      renderPaid({ payment: { reviewReason: 'late_settlement', resolutionOutcome: 'paid' } });
      expect(screen.getByText('Seller confirmed payment')).toBeInTheDocument();
      expect(screen.getByTestId('bitcoin-on-chain-badge')).toHaveTextContent('Confirmed on-chain');
    });

    it('does not credit the seller for late money that completed the order on its own', () => {
      renderPaid({ order: { cancellationReason: 'payment window elapsed' } });
      expect(screen.getByText('Confirmed on-chain')).toBeInTheDocument();
      expect(screen.queryByText('Seller confirmed payment')).not.toBeInTheDocument();
      expect(screen.getByText(CHECKOUT_HOLD_COPY.lateCompleteBuyer)).toBeInTheDocument();
    });

    it('keeps the generic label on a paid PayPal order', () => {
      renderPaid({
        payment: { adapter: 'paypal' },
        order: { paymentMethod: 'paypal', paykitRequestState: null, fiatVerification: 'seller-attested' },
      });
      expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
      expect(screen.queryByText('Seller confirmed payment')).not.toBeInTheDocument();
    });
  });

  describe('seller confirm-by time', () => {
    const DEADLINE = '2026-10-02T09:28:10.186Z';

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(new Date('2026-10-01T09:28:30.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const renderSellerReview = () => {
      const payment = createPaymentFixture('awaiting_entitlement', { adapter: 'paykit' });
      return render(
        <MarketplacePaymentStatusCard
          order={createOrderFixture('pending_payment', {
            paymentId: payment.id,
            paymentMethod: 'bitcoin',
            paykitRequestState: 'awaiting_seller_confirmation',
            paykitSellerConfirmationDeadline: DEADLINE,
            paykitObservation: {
              txid: null,
              observedSats: null,
              confirmations: 0,
              amountMatched: true,
              disappeared: false,
              observedAt: '2026-10-01T09:28:54.000Z',
            },
          })}
          payment={payment}
          isBuyer={false}
          adapterMode="transaction-service"
          advancePayment={async () => false}
          onPaymentChanged={() => {}}
        />,
      );
    };

    it('shows a readable deadline with the live countdown instead of the raw timestamp', () => {
      renderSellerReview();
      const deadline = screen.getByTestId('seller-bitcoin-confirm-deadline');
      expect(deadline).toHaveTextContent('Confirm by');
      expect(deadline).toHaveTextContent('Oct 2, 2026, 9:28 AM UTC · 23:59:40 left');
      expect(screen.getByText('Oct 1, 2026, 9:28 AM UTC')).toBeInTheDocument();
      expect(screen.queryByText(/2026-10-0\dT/)).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(deadline).toHaveTextContent('23:59:39 left');
    });

    it('drops the countdown once the window has ended', () => {
      vi.setSystemTime(new Date('2026-10-02T10:00:00.000Z'));
      renderSellerReview();
      const deadline = screen.getByTestId('seller-bitcoin-confirm-deadline');
      expect(deadline).toHaveTextContent('Oct 2, 2026, 9:28 AM UTC');
      expect(deadline).not.toHaveTextContent('left');
    });
  });
});
