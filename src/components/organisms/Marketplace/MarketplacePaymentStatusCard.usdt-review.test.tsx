import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { createOrderFixture, createPaymentFixture } from '@/test/fixtures/commerce/orders';
import { USDT_RESOLVE_TX_HASH } from '@/test/fixtures/commerce/usdt-payment-review.wire';
import { createUsdtOrderFixture } from '@/test/fixtures/commerce/usdt-orders';
import { REFUND_FIXTURE_ADDRESS } from '@/test/fixtures/commerce/usdt-refund.wire';
import { MarketplacePaymentStatusCard } from './MarketplacePaymentStatusCard';

const auth = vi.hoisted(() => ({ currentUserPubky: 's'.repeat(52) }));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => 'production' };
});

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
  }),
}));

vi.mock('@/hooks/useBuyerPaykitWallet/useBuyerPaykitWallet', () => ({
  useBuyerPaykitWallet: () => ({ state: 'payable', recheck: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceOrderPayment/useMarketplaceOrderPayment', () => ({
  useMarketplaceOrderPayment: () => ({
    availableMethods: null,
    bitcoinOfferUnavailable: false,
    configError: null,
    pendingAction: null,
    bind: vi.fn(),
    verifyStripe: vi.fn(),
    markPaid: vi.fn(),
    confirmReceived: vi.fn(),
  }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getOrFetchListing: vi.fn(async () => ({ digitalLock: null })),
    executeMarketplaceCommand: vi.fn(async () => ({ ok: true })),
    confirmBitcoinPayment: vi.fn(),
    resolveBitcoinPayment: vi.fn(),
  },
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: auth.currentUserPubky }),
}));

const HASH_COPY = 'Enter the Arbitrum transaction hash (0x followed by 64 characters).';
const NO_ADDRESS_COPY = "Ask the buyer to confirm a refund address first. It's on their order page.";

const CONFIRMED_DESTINATION = {
  address: REFUND_FIXTURE_ADDRESS,
  network: 'arbitrum-one',
  asset: 'USDT',
  source: 'buyer_entered',
  confirmedAt: '2026-10-09T16:00:00.000Z',
} as const;

function reviewFixtures(
  options: {
    destination?: boolean;
    reviewReason?: string;
    orderOverrides?: Partial<ReturnType<typeof createOrderFixture>>;
  } = {},
) {
  const { order } = createUsdtOrderFixture('final', {
    refundDestination: options.destination === false ? null : CONFIRMED_DESTINATION,
    ...options.orderOverrides,
  });
  const payment = createPaymentFixture('manual_review', {
    adapter: 'paykit',
    reviewReason: options.reviewReason ?? 'amount_mismatch',
    manualReviewEnteredAt: '2026-10-09T15:00:00.000Z',
  });
  return { order, payment };
}

function renderCard(
  { order, payment }: ReturnType<typeof reviewFixtures>,
  { isBuyer = false, onPaymentChanged = vi.fn(), adapterMode = 'transaction-service' as const } = {},
) {
  auth.currentUserPubky = isBuyer ? order.buyerPubky : order.sellerPubky;
  return render(
    <MarketplacePaymentStatusCard
      order={order}
      payment={payment}
      isBuyer={isBuyer}
      adapterMode={adapterMode}
      advancePayment={async () => false}
      onPaymentChanged={onPaymentChanged}
    />,
  );
}

async function chooseOutcome(outcome: 'paid' | 'refunded' | 'abandoned') {
  await userEvent.setup().selectOptions(screen.getByLabelText('Outcome'), outcome);
}

describe('MarketplacePaymentStatusCard: seller resolution of a USDT payment in manual review', () => {
  beforeEach(() => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockReset();
  });

  it('offers the seller the resolution panel with the total beside its parity USDT amount', () => {
    renderCard(reviewFixtures());

    expect(screen.getByTestId('seller-usdt-resolve-prompt')).toHaveTextContent('Resolve USDT payment review');
    expect(screen.getByTestId('usdt-resolution-total')).toHaveTextContent('$137.00 · 137.000000 USDT');
    expect(screen.getByRole('option', { name: 'Paid' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Refunded' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Abandoned' })).toBeInTheDocument();
    expect(screen.queryByText('Resolve Bitcoin payment review')).not.toBeInTheDocument();
  });

  it('keys on the order asset: a USDT order stays resolvable whatever the new-offer flag says', () => {
    renderCard(reviewFixtures({ orderOverrides: { paymentMethod: null } }));

    expect(screen.getByTestId('seller-usdt-resolution')).toBeInTheDocument();
  });

  it('never shows the resolution to the buyer, who only sees the review copy', () => {
    renderCard(reviewFixtures(), { isBuyer: true });

    expect(screen.queryByTestId('seller-usdt-resolution')).not.toBeInTheDocument();
    expect(screen.getByTestId('payment-manual-review-copy')).toBeInTheDocument();
  });

  it.each([
    [
      'a payment that is not in manual review',
      () => ({ payment: createPaymentFixture('confirmed', { adapter: 'paykit' }) }),
    ],
    ['a non-Paykit payment', () => ({ payment: createPaymentFixture('manual_review', { adapter: 'locks' }) })],
  ])('shows nothing for %s', (_label, override) => {
    renderCard({ ...reviewFixtures(), ...override() });

    expect(screen.queryByTestId('seller-usdt-resolution')).not.toBeInTheDocument();
  });

  it('shows nothing outside the durable service', () => {
    renderCard(reviewFixtures(), { adapterMode: 'sandbox' });

    expect(screen.queryByTestId('seller-usdt-resolution')).not.toBeInTheDocument();
  });

  it('leaves a Bitcoin payment on its own panel, unchanged', () => {
    const payment = createPaymentFixture('manual_review', { adapter: 'paykit', confirmations: 0 });
    const order = createOrderFixture('pending_payment', { paymentId: payment.id, paymentMethod: 'bitcoin' });
    auth.currentUserPubky = order.sellerPubky;
    const { container } = render(
      <MarketplacePaymentStatusCard
        order={order}
        payment={payment}
        isBuyer={false}
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText('Resolve Bitcoin payment review')).toBeInTheDocument();
    expect(screen.queryByTestId('seller-usdt-resolution')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/USDT|Arbitrum/);
  });

  it('hides Paid when the seller must return the money', () => {
    renderCard(reviewFixtures({ reviewReason: 'refund_required' }));

    expect(screen.queryByRole('option', { name: 'Paid' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Refunded' })).toBeInTheDocument();
  });

  it('shows the refund amount and the buyer address, and says the refund is recorded by the seller', async () => {
    renderCard(reviewFixtures());
    await chooseOutcome('refunded');

    expect(screen.getByTestId('usdt-resolution-address')).toHaveTextContent(REFUND_FIXTURE_ADDRESS);
    expect(screen.getByTestId('usdt-resolution-refund')).toHaveTextContent('Refund to send');
    expect(screen.getByTestId('usdt-resolution-refund')).toHaveTextContent('$137.00 · 137.000000 USDT');
    expect(screen.getByTestId('usdt-resolution-recorded-note')).toHaveTextContent(
      'The refund is recorded by the seller with this transaction hash. The Shop does not check it on Arbitrum.',
    );
    expect(screen.getByTestId('seller-usdt-resolution')).not.toHaveTextContent(/verified|confirmed on arbitrum/i);
    expect(screen.getByLabelText(/Arbitrum transaction hash/)).toBeInTheDocument();
  });

  it('blocks a refund until the reference is an Arbitrum transaction hash, then sends it lowercase', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockResolvedValue({} as never);
    const onPaymentChanged = vi.fn();
    const user = userEvent.setup();
    renderCard(reviewFixtures(), { onPaymentChanged });
    await chooseOutcome('refunded');
    const resolve = screen.getByRole('button', { name: 'Resolve payment' });

    expect(screen.getByTestId('usdt-resolution-reference-error')).toHaveTextContent(HASH_COPY);
    expect(resolve).toBeDisabled();

    await user.type(screen.getByLabelText(/Arbitrum transaction hash/), 'tx-contract-refund');
    expect(resolve).toBeDisabled();

    await user.clear(screen.getByLabelText(/Arbitrum transaction hash/));
    await user.type(
      screen.getByLabelText(/Arbitrum transaction hash/),
      USDT_RESOLVE_TX_HASH.toUpperCase().replace('0X', '0x'),
    );
    expect(screen.queryByTestId('usdt-resolution-reference-error')).not.toBeInTheDocument();
    expect(resolve).toBeEnabled();
    await user.type(screen.getByLabelText('Reason (optional)'), 'Returned the late payment');
    await user.click(resolve);

    await waitFor(() => expect(CommerceController.resolveBitcoinPayment).toHaveBeenCalledTimes(1));
    expect(CommerceController.resolveBitcoinPayment).toHaveBeenCalledWith(
      expect.any(String),
      { outcome: 'refunded', reason: 'Returned the late payment', externalRefundReference: USDT_RESOLVE_TX_HASH },
      expect.any(String),
    );
    await waitFor(() => expect(onPaymentChanged).toHaveBeenCalled());
  });

  it('asks the seller to wait for the buyer address instead of letting a refund be recorded without one', async () => {
    const user = userEvent.setup();
    renderCard(reviewFixtures({ destination: false }));
    await chooseOutcome('refunded');
    await user.type(screen.getByLabelText(/Arbitrum transaction hash/), USDT_RESOLVE_TX_HASH);

    expect(screen.getByTestId('usdt-resolution-no-address')).toHaveTextContent(NO_ADDRESS_COPY);
    expect(screen.queryByTestId('usdt-resolution-address')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve payment' })).toBeDisabled();
  });

  it.each(['paid', 'abandoned'] as const)('resolves %s with no reference and no address', async (outcome) => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderCard(reviewFixtures({ destination: false }));
    await chooseOutcome(outcome);

    expect(screen.queryByTestId('usdt-resolution-refund')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resolve payment' }));

    await waitFor(() => expect(CommerceController.resolveBitcoinPayment).toHaveBeenCalledTimes(1));
    expect(CommerceController.resolveBitcoinPayment).toHaveBeenCalledWith(
      expect.any(String),
      { outcome, reason: '', externalRefundReference: undefined },
      expect.any(String),
    );
  });

  it('shows the service refusal of a reference in USDT terms', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockRejectedValue(
      Err.client(ClientErrorCode.BAD_REQUEST, 'static', {
        service: ErrorService.Marketplace,
        operation: 'resolveBitcoinPayment',
        context: { statusCode: 422, reason: 'invalid_refund_reference' },
      }),
    );
    const user = userEvent.setup();
    renderCard(reviewFixtures());
    await chooseOutcome('refunded');
    await user.type(screen.getByLabelText(/Arbitrum transaction hash/), USDT_RESOLVE_TX_HASH);
    await user.click(screen.getByRole('button', { name: 'Resolve payment' }));

    expect(await screen.findByText(HASH_COPY, { selector: '#usdt-resolution-error' })).toBeInTheDocument();
  });

  it('shows the refusal that the buyer has not confirmed an address', async () => {
    vi.mocked(CommerceController.resolveBitcoinPayment).mockRejectedValue(
      Err.client(ClientErrorCode.CONFLICT, 'static', {
        service: ErrorService.Marketplace,
        operation: 'resolveBitcoinPayment',
        context: { statusCode: 409, reason: 'refund_destination_required' },
      }),
    );
    const user = userEvent.setup();
    renderCard(reviewFixtures());
    await chooseOutcome('refunded');
    await user.type(screen.getByLabelText(/Arbitrum transaction hash/), USDT_RESOLVE_TX_HASH);
    await user.click(screen.getByRole('button', { name: 'Resolve payment' }));

    expect(await screen.findByText(NO_ADDRESS_COPY, { selector: '#usdt-resolution-error' })).toBeInTheDocument();
  });
});
