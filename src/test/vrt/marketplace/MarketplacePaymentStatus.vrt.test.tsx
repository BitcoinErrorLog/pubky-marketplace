// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore, createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { HOUR_MS, MINUTE_MS, VRT_FROZEN_NOW_MS } from '@/test-utils/vrt.clock';
import projectionSamples from '@/libs/commerce/contracts/samples/projections.json';
import { marketplaceOrderSchema } from '@/core/services/marketplace/marketplace-projections';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import { MarketplacePaymentStatusCard } from '@/organisms/Marketplace/MarketplacePaymentStatusCard';

/**
 * Every buyer-visible payment state of the truthful status card (plan task
 * 4.6), rendered for baselines (task 4.8):
 *
 * - `locks-paykit` mode: awaiting (start / registered / poll-bound reached),
 *   confirmed with the digital delivery view (locked and unlocked), expired,
 *   and manual review. Detection and confirmation counts are deliberately
 *   absent from every one of these — the upstream contract keeps them
 *   internal.
 * - sandbox mode: the simulate affordances and the finer-grained simulated
 *   `detected` state, which may exist ONLY under the visible sandbox label —
 *   the label is part of these baselines on purpose.
 */

const fixtures = vi.hoisted(async () => {
  const { createOrderFixture, createPaymentFixture, ORDER_FIXTURE_BUYER } =
    await import('@/test/fixtures/commerce/orders');
  return { createOrderFixture, createPaymentFixture, buyer: ORDER_FIXTURE_BUYER };
});

const view = vi.hoisted(() => ({
  deployEnv: 'production' as 'production' | 'staging' | undefined,
  currentUserPubky: 's'.repeat(52) as string | null,
  locks: {
    enabled: true,
    correlation: null as unknown,
    isStarting: false,
    isUnlocking: false,
    delivery: null as unknown,
    error: null as string | null,
    pollExhausted: false,
  },
  sellerConfig: {
    bitcoinAvailable: true,
    bitcoinOfferAvailable: true,
    paypalAvailable: true,
  },
}));

vi.mock('@/hooks/useMarketplaceLocksPayment/useMarketplaceLocksPayment', () => ({
  useMarketplaceLocksPayment: () => ({
    ...view.locks,
    start: vi.fn(async () => false),
    unlock: vi.fn(async () => false),
    resumePolling: vi.fn(),
  }),
}));

// Staging amber is gated on the deploy environment. Each scene names its
// environment: locks-paykit and the production method-picker run on
// production (no amber money notice; awaiting payment shows muted hold
// copy). Other transaction-service scenes run on staging (test rails —
// no real funds move). Sandbox scenes render no notice.
vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => view.deployEnv };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({
    getCurrentUserPubky: () => view.currentUserPubky,
  }),
}));

vi.mock('@/controllers/commerce/commerce', async () => {
  const { ORDER_FIXTURE_SELLER } = await import('@/test/fixtures/commerce/orders');
  return {
    CommerceController: {
      ...createMarketplaceVrtCommerceController(),
      getOrFetchListing: vi.fn(async () => ({
        digitalLock: {
          policyUri: `pubky://${ORDER_FIXTURE_SELLER}/pub/locks.app/${'0'.repeat(52)}.json`,
          criterionId: 'criterion-1',
          contentPath: 'field_recordings/archive.zip',
          resourceHash: 'a'.repeat(64),
          minimumConfirmations: 1,
        },
      })),
      getSellerPaymentConfig: vi.fn(async () => view.sellerConfig),
      bindPaymentMethod: vi.fn(async () => ({})),
      verifyStripePayment: vi.fn(async () => ({ verified: false, order: null })),
      markFiatPaid: vi.fn(async () => ({})),
      confirmFiatReceived: vi.fn(async () => ({})),
      executeMarketplaceCommand: vi.fn(async () => ({ ok: true })),
    },
  };
});

function makeCorrelation(registered: boolean) {
  return {
    id: 'fixture-correlation',
    owner_id: 'b'.repeat(52),
    payment_id: '018f47d2-6a27-7c23-a49d-000000000301',
    order_id: '018f47d2-6a27-7c23-a49d-000000000001',
    seller_pubky: 's'.repeat(52),
    bundle_id: '000G40R40M30E209185GR38E1W',
    policy_uri: `pubky://${'s'.repeat(52)}/pub/locks.app/${'0'.repeat(52)}.json`,
    criterion_id: 'criterion-1',
    content_path: 'field_recordings/archive.zip',
    resource_hash: 'a'.repeat(64),
    window_expires_at: '2026-08-20T21:00:00.000Z',
    registered,
    created_at: 1,
    updated_at: 1,
  };
}

const HOLD_DEADLINE = '2026-08-20T21:15:00.000Z';

function Harness({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">{children}</main>;
}

async function renderCard(
  paymentState: 'awaiting_entitlement' | 'detected' | 'confirmed' | 'expired' | 'manual_review',
  adapterMode: 'sandbox' | 'transaction-service' | 'locks-paykit',
  options: {
    adapter?: 'sandbox' | 'locks' | 'paykit' | 'stripe' | 'paypal';
    orderState?: 'pending_payment' | 'paid' | 'cancelled';
    orderOverrides?: Record<string, unknown>;
    paymentOverrides?: Record<string, unknown>;
    isBuyer?: boolean;
    viewport?: object;
    deployEnv?: 'production' | 'staging';
    currentUserPubky?: string | null;
  } = {},
) {
  const { createOrderFixture, createPaymentFixture } = await fixtures;
  view.deployEnv = options.deployEnv ?? 'production';
  view.currentUserPubky = options.currentUserPubky ?? 's'.repeat(52);
  const payment = createPaymentFixture(paymentState, {
    adapter: options.adapter ?? 'sandbox',
    locksBundleId: undefined,
    ...(options.paymentOverrides ?? {}),
  });
  const order = createOrderFixture(options.orderState ?? (paymentState === 'confirmed' ? 'paid' : 'pending_payment'), {
    paymentId: payment.id,
    ...(options.orderOverrides ?? {}),
  });
  return await renderForVRT(
    <Harness>
      <MarketplacePaymentStatusCard
        order={order}
        payment={payment}
        isBuyer={options.isBuyer ?? true}
        adapterMode={adapterMode}
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />
    </Harness>,
    { viewport: (options.viewport as never) ?? VRT_VIEWPORT_DESKTOP },
  );
}

describe('Marketplace payment status card — visual regression', () => {
  it('renders awaiting entitlement with the wallet payment request action (locks-paykit) at desktop viewport', async () => {
    view.locks = { ...view.locks, correlation: null, delivery: null, error: null, pollExhausted: false };
    const screen = await renderCard('awaiting_entitlement', 'locks-paykit', { adapter: 'sandbox' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-awaiting-start-desktop');
  });

  it('renders awaiting entitlement with the wallet payment request action at mobile viewport', async () => {
    view.locks = { ...view.locks, correlation: null, delivery: null, error: null, pollExhausted: false };
    const screen = await renderCard('awaiting_entitlement', 'locks-paykit', {
      adapter: 'sandbox',
      viewport: VRT_VIEWPORT_MOBILE,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-awaiting-start-mobile');
  });

  it('renders a registered payment request awaiting server-side verification at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: null,
      error: null,
      pollExhausted: false,
    };
    const screen = await renderCard('awaiting_entitlement', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-awaiting-registered-desktop');
  });

  it('renders the bounded-poll limit with its explicit resume action at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: null,
      error: null,
      pollExhausted: true,
    };
    const screen = await renderCard('awaiting_entitlement', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-poll-exhausted-desktop');
  });

  it('renders a confirmed payment with the locked digital delivery at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: null,
      error: null,
      pollExhausted: false,
    };
    const screen = await renderCard('confirmed', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-confirmed-locked-desktop');
  });

  it('renders the unlocked digital delivery with its verified file at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: { objectUrl: 'blob:vrt-fixture', fileName: 'archive.zip', byteSize: 48_213 },
      error: null,
      pollExhausted: false,
    };
    const screen = await renderCard('confirmed', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-delivery-unlocked-desktop');
  });

  it('renders the marketplace-expired state at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: null,
      error: null,
      pollExhausted: false,
    };
    const screen = await renderCard('expired', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-expired-desktop');
  });

  it('renders the manual-review state at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: null,
      error: null,
      pollExhausted: false,
    };
    const screen = await renderCard('manual_review', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-manual-review-desktop');
  });

  it('renders the payment method picker with the seller-configured rails at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'production',
      orderOverrides: { holdExpiresAt: HOLD_DEADLINE, holdSource: 'checkout' },
    });
    await expect.element(screen.getByText('₿ Bitcoin')).toBeInTheDocument();
    await expect.element(screen.getByText(/The item is held for you until/)).toBeInTheDocument();
    await expect
      .element(screen.getByText('Real money. Payments are final and go directly to the seller.'))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText(/Choose how to pay/i)).not.toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-picker-desktop');
    view.locks.enabled = true;
  });

  it('renders the honest empty state when the seller configured no payment methods', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const previous = view.sellerConfig;
    view.sellerConfig = {
      bitcoinAvailable: false,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', { deployEnv: 'staging' });
    await expect.element(screen.getByText(/has not set up any payment methods/)).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-none-desktop');
    view.sellerConfig = previous;
    view.locks.enabled = true;
  });

  it('renders the bound bitcoin wait state at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      orderOverrides: {
        paymentMethod: 'bitcoin',
        paykitRequestState: 'pending',
        holdExpiresAt: HOLD_DEADLINE,
        holdSource: 'bind',
        paykitTotalSats: 1_255,
        merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
        bitcoinPayable: { amountMinor: 1_255, currency: 'SAT', exponent: 0 },
        subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
        shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
        total: { amountMinor: 1_255, currency: 'BTC', exponent: 8 },
      },
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-bitcoin-desktop');
    view.locks.enabled = true;
  });

  it('renders a seen Bitcoin payment without telling the buyer to pay again', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const deadline = new Date(VRT_FROZEN_NOW_MS + (23 * HOUR_MS + 56 * MINUTE_MS + 41_000)).toISOString();
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      orderOverrides: {
        paymentMethod: 'bitcoin',
        paykitRequestState: 'awaiting_seller_confirmation',
        paykitDeliveryState: 'delivered',
        paykitSellerConfirmationDeadline: deadline,
        holdExpiresAt: deadline,
        holdSource: 'bind',
        paykitTotalSats: 1_303,
        merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
        bitcoinPayable: { amountMinor: 1_303, currency: 'SAT', exponent: 0 },
        subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
        shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
        total: { amountMinor: 1_303, currency: 'BTC', exponent: 8 },
      },
    });
    await expect.element(screen.getByText('Payment seen', { exact: true })).toBeInTheDocument();
    await expect.element(screen.getByText(/Open Bitkit to pay/)).not.toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-bitcoin-seen-desktop');
    view.locks.enabled = true;
  });

  it('renders an unconfirmed Bitcoin manual review without calling it confirmed', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('manual_review', 'transaction-service', {
      deployEnv: 'staging',
      adapter: 'paykit',
      isBuyer: true,
      currentUserPubky: 'b'.repeat(52),
      paymentOverrides: { confirmations: 0 },
      orderOverrides: {
        paymentMethod: 'bitcoin',
        paykitRequestState: 'pending',
        paykitDeliveryState: 'delivered',
        holdExpiresAt: '2026-09-29T10:56:41.980Z',
        holdSource: 'bind',
      },
    });
    await expect.element(screen.getByText('Payment received — the seller is reviewing it.')).toBeInTheDocument();
    await expect.element(screen.getByText(/confirmed on-chain/)).not.toBeInTheDocument();
    await expect.element(screen.getByText(/Open Bitkit to pay/)).not.toBeInTheDocument();
    await expect.element(screen.getByText(/Pay by/)).not.toBeInTheDocument();
    await expect.element(screen.getByText('Resolve Bitcoin payment review')).not.toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'payment-status-bitcoin-review-unconfirmed-desktop',
    );
    view.locks.enabled = true;
  });

  it('renders a seller-confirmed Bitcoin payment apart from its on-chain state', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('confirmed', 'transaction-service', {
      deployEnv: 'staging',
      adapter: 'paykit',
      orderState: 'paid',
      currentUserPubky: 'b'.repeat(52),
      paymentOverrides: { confirmations: 0 },
      orderOverrides: {
        paymentMethod: 'bitcoin',
        paykitRequestState: 'confirmed',
        paykitDeliveryState: 'delivered',
        paykitTotalSats: 1_753,
        merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
        bitcoinPayable: { amountMinor: 1_753, currency: 'SAT', exponent: 0 },
        subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
        shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
        total: { amountMinor: 1_753, currency: 'BTC', exponent: 8 },
      },
    });
    await expect.element(screen.getByText('Seller confirmed payment')).toBeInTheDocument();
    await expect.element(screen.getByTestId('bitcoin-seller-confirmed-before-chain')).toBeInTheDocument();
    await expect.element(screen.getByText('Payment confirmed', { exact: true })).not.toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'payment-status-bitcoin-seller-confirmed-desktop',
    );
    view.locks.enabled = true;
  });

  it('renders a bound card order without offering card checkout at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      orderOverrides: {
        paymentMethod: 'stripe',
        fiatCheckoutUrl: 'https://buy.stripe.com/test_fixture?client_reference_id=order-1',
        fiatVerification: 'processor',
        holdExpiresAt: HOLD_DEADLINE,
        holdSource: 'bind',
      },
    });
    await expect.element(screen.getByRole('button', { name: /Stripe/ })).not.toBeInTheDocument();
    await expect.element(screen.getByText('Card (Stripe)')).not.toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-stripe-desktop');
    view.locks.enabled = true;
  });

  it('renders the buyer paypal report affordances at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      orderOverrides: {
        paymentMethod: 'paypal',
        fiatCheckoutUrl: 'https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=seller%40example.com',
        fiatVerification: 'seller-attested',
        holdExpiresAt: HOLD_DEADLINE,
        holdSource: 'bind',
      },
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-paypal-desktop');
    view.locks.enabled = true;
  });

  it('renders the buyer paypal reported state at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      orderOverrides: {
        paymentMethod: 'paypal',
        fiatCheckoutUrl: 'https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=seller%40example.com',
        fiatVerification: 'seller-attested',
        paymentReportedAt: '2026-08-22T12:00:00.000Z',
        fiatTransactionRef: '7AB12345CD678901E',
        holdExpiresAt: HOLD_DEADLINE,
        holdSource: 'bind',
      },
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'payment-status-method-paypal-reported-desktop',
    );
    view.locks.enabled = true;
  });

  it('renders the seller paypal receipt confirmation at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      isBuyer: false,
      orderOverrides: {
        paymentMethod: 'paypal',
        fiatCheckoutUrl: 'https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=seller%40example.com',
        fiatVerification: 'seller-attested',
        paymentReportedAt: '2026-08-22T12:00:00.000Z',
        fiatTransactionRef: '7AB12345CD678901E',
      },
    });
    await expect.element(screen.getByText('Confirm payment received')).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-paypal-confirm-desktop');
    view.locks.enabled = true;
  });

  it('renders the sandbox simulate affordances under the visible sandbox label at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'sandbox');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-sandbox-awaiting-desktop');
    view.locks.enabled = true;
  });

  it('renders the simulated detected state, which exists only under the sandbox label, at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('detected', 'sandbox');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-sandbox-detected-desktop');
    view.locks.enabled = true;
  });

  it('renders seller-observed Bitcoin facts and confirmation CTA', async () => {
    const screen = await renderCapturedCard('seller_awaiting_confirmation', false);
    await expect.element(screen.getByText(/Confirm you received/)).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'payment-status-seller-awaiting-review-desktop',
    );
  });

  it('renders seller manual resolution outcomes and entered context', async () => {
    const screen = await renderCapturedCard('seller_manual_review_held', false);
    await expect.element(screen.getByText('Resolve Bitcoin payment review')).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'payment-status-seller-manual-review-held-desktop',
    );
  });

  it('renders seller late manual resolution from the captured projection', async () => {
    const screen = await renderCapturedCard('seller_manual_review_late', false);
    await expect.element(screen.getByText('Resolve Bitcoin payment review')).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'payment-status-seller-manual-review-late-desktop',
    );
  });

  it('renders buyer projections without seller evidence or controls', async () => {
    const screen = await renderCapturedCard('buyer_manual_review_held', true);
    await expect.element(screen.getByText('Under manual review')).toBeInTheDocument();
    await expect.element(screen.getByText('Resolve Bitcoin payment review')).not.toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'payment-status-buyer-manual-review-redacted-desktop',
    );
  });

  it('suppresses Bitcoin review controls for a non-Bitcoin rail', async () => {
    const screen = await renderCard('manual_review', 'transaction-service', {
      isBuyer: false,
      currentUserPubky: 's'.repeat(52),
      orderOverrides: { paymentMethod: 'stripe' },
      deployEnv: 'staging',
    });
    await expect.element(screen.getByText('Resolve Bitcoin payment review')).not.toBeInTheDocument();
  });

  it('renders late-completion copy for the buyer at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('confirmed', 'transaction-service', {
      deployEnv: 'staging',
      orderState: 'paid',
      orderOverrides: { cancellationReason: 'payment window elapsed' },
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-late-completion-buyer-desktop');
    view.locks.enabled = true;
  });

  it('renders late-completion copy for the seller at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('confirmed', 'transaction-service', {
      deployEnv: 'staging',
      isBuyer: false,
      orderState: 'paid',
      orderOverrides: { cancellationReason: 'payment window elapsed' },
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'payment-status-late-completion-seller-desktop',
    );
    view.locks.enabled = true;
  });

  it('renders refund_required copy for the buyer at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('manual_review', 'transaction-service', {
      deployEnv: 'staging',
      currentUserPubky: 'b'.repeat(52),
      orderState: 'cancelled',
      paymentOverrides: { reviewReason: 'refund_required' },
      orderOverrides: { cancellationReason: 'payment window elapsed', paymentMethod: 'bitcoin' },
    });
    await expect.element(screen.getByText(/The seller must return your funds/)).toBeInTheDocument();
    await expect.element(screen.getByText(/Return the observed bitcoin/)).not.toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-refund-required-buyer-desktop');
    view.locks.enabled = true;
  });

  it('renders refund_required seller bitcoin resolution without Paid at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('manual_review', 'transaction-service', {
      deployEnv: 'staging',
      isBuyer: false,
      adapter: 'paykit',
      orderState: 'cancelled',
      paymentOverrides: { reviewReason: 'refund_required', adapter: 'paykit' },
      orderOverrides: { cancellationReason: 'payment window elapsed', paymentMethod: 'bitcoin' },
    });
    await expect.element(screen.getByText('Resolve Bitcoin payment review')).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'payment-status-refund-required-seller-bitcoin-desktop',
    );
    view.locks.enabled = true;
  });

  it('renders elapsed unpaid copy at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('expired', 'transaction-service', {
      deployEnv: 'staging',
      orderState: 'cancelled',
      orderOverrides: { cancellationReason: 'payment window elapsed' },
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-elapsed-desktop');
    view.locks.enabled = true;
  });
});

async function renderCapturedCard(scene: keyof typeof projectionSamples, isBuyer: boolean) {
  view.deployEnv = 'staging';
  view.currentUserPubky = isBuyer ? 'b'.repeat(52) : 's'.repeat(52);
  const body = projectionBody(scene);
  const order = marketplaceOrderSchema.parse(toCamelCaseWire(body));
  const screen = await renderForVRT(
    <Harness>
      <MarketplacePaymentStatusCard
        order={order}
        payment={order.payment ?? null}
        isBuyer={isBuyer}
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />
    </Harness>,
    { viewport: VRT_VIEWPORT_DESKTOP },
  );
  expect(expectVrtSurface('marketplace-payment-status-card')).toBeInTheDocument();
  return screen;
}

function projectionBody(scene: keyof typeof projectionSamples): Record<string, unknown> {
  const source = projectionSamples[scene].response.body;
  const replacements: Record<string, string> = {
    '<uuid:1>': '018f47d2-6a27-7c23-a49d-000000000001',
    '<uuid:2>': '018f47d2-6a27-7c23-a49d-000000000002',
    '<uuid:3>': '018f47d2-6a27-7c23-a49d-000000000003',
    '<uuid:4>': '018f47d2-6a27-7c23-a49d-000000000004',
    '<uuid:5>': '018f47d2-6a27-7c23-a49d-000000000005',
    '<uuid:6>': '018f47d2-6a27-7c23-a49d-000000000006',
    '<pubky:buyer>': 'b'.repeat(52),
    '<pubky:seller>': 's'.repeat(52),
    '<timestamp:1>': '2026-08-20T20:00:00.000Z',
    '<timestamp:2>': '2026-08-20T21:00:00.000Z',
    '<timestamp:3>': '2026-08-27T20:00:00.000Z',
    '<paykit-reference:1>': 'paykit-reference-1',
    '<paykit-reference:2>': 'paykit-reference-2',
    '<paykit-reference:3>': 'paykit-reference-3',
  };
  return JSON.parse(
    JSON.stringify(source, (_key, value: unknown) =>
      typeof value === 'string' ? (replacements[value] ?? value) : value,
    ),
  ) as Record<string, unknown>;
}
