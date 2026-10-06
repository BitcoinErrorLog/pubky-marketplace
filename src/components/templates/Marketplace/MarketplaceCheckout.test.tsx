import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKETPLACE_DELIVERY_ADDRESS_DISCLOSURE } from '@/config/commerce-copy';
import { CommerceController } from '@/controllers/commerce/commerce';
import { createOrderFixture, createPaymentFixture } from '@/test/fixtures/commerce/orders';
import { setHeavySuiteBudgets } from '@/test-utils/load-budget';
import { MarketplaceCheckout } from './MarketplaceCheckout';

setHeavySuiteBudgets();

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
});

const view = vi.hoisted(() => ({
  items: [] as unknown[],
  orders: [] as unknown[],
  isLoading: false,
  adapterMode: 'sandbox' as string,
  deployEnv: 'production' as 'production' | 'staging' | undefined,
  hasMarketplaceSession: false,
  needsSession: false,
  sessionError: null as string | null,
  addresses: [] as unknown[],
  selectedAddressId: null as string | null,
  fulfillmentOptions: {} as Record<string, Array<'shipping' | 'pickup'>>,
  fulfillmentEffective: {} as Record<string, 'shipping' | 'pickup'>,
  requiresDeliveryAddress: true,
  hasFulfillmentConflict: false,
  isPickupCapabilityLoading: false,
  fulfillmentByItem: {} as Record<string, 'shipping' | 'pickup' | 'digital'>,
  isDigitalReady: true,
  isDigitalCapabilityLoading: false,
  digitalKinds: {} as Record<string, 'file' | 'link' | 'text' | 'email' | 'message' | null | undefined>,
  digitalChoosable: [] as string[],
  digitalNotReadyItemIds: [] as string[],
  requiresDeliveryEmail: false,
  hasInstantDigitalLine: false,
  hasManualDigitalLine: false,
  orderCount: 1,
  payResult: { ok: false, orderIds: [] as string[], boundOrders: [] as unknown[] },
  awardItems: [] as Array<{ awardId: string; listingId: string; variantId: string }>,
}));

const checkoutActions = vi.hoisted(() => ({
  pay: vi.fn(async () => view.payResult),
  setFulfillmentChoice: vi.fn(),
  setDigitalChoice: vi.fn(),
  remove: vi.fn(async () => {}),
  rememberAddress: vi.fn(async () => {}),
  lastAward: undefined as unknown,
}));

const offerState = vi.hoisted(() => ({
  offers: [] as Array<Record<string, unknown>>,
  isLoading: false,
  refresh: vi.fn(async () => {}),
  submit: vi.fn(),
  outcome: { ok: true, orderId: '00000000-0000-4000-8000-000000000803', boundOrder: null } as
    | { ok: true; orderId: string; boundOrder: null }
    | { ok: false; code: string },
}));

const listing = {
  id: 'seller:boots',
  listing_id: 'boots',
  record: {
    ownerPubky: 's'.repeat(52),
    listingId: 'boots',
    title: 'Vintage boots',
    media: [],
    variants: [{ id: 'variant_42', options: { size: '42' }, quantity: 3 }],
    sale: { format: 'fixed_price', unitPrice: { amountMinor: 1200, currency: 'USD', exponent: 2 } },
  },
};

const secondSellerListing = {
  ...listing,
  id: 'other:camera',
  listing_id: 'camera',
  record: {
    ...listing.record,
    ownerPubky: 'o'.repeat(52),
    listingId: 'camera',
    title: 'Rangefinder camera',
    variants: [{ id: 'variant_01', options: {}, quantity: 2 }],
    sale: { format: 'fixed_price', unitPrice: { amountMinor: 15000, currency: 'BTC', exponent: 8 } },
  },
};

const searchParams = vi.hoisted(() => ({ current: new URLSearchParams() }));

const buyerWallet = vi.hoisted(() => ({
  state: 'payable' as 'idle' | 'checking' | 'payable' | 'not_payable' | 'unknown',
  recheck: vi.fn(),
  enabledCalls: [] as boolean[],
}));

vi.mock('@/hooks/useBuyerPaykitWallet/useBuyerPaykitWallet', () => ({
  useBuyerPaykitWallet: (_buyerPubky: string | null, enabled: boolean) => {
    buyerWallet.enabledCalls.push(enabled);
    return { state: enabled ? buyerWallet.state : 'idle', recheck: buyerWallet.recheck };
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/marketplace/checkout',
  useSearchParams: () => searchParams.current,
}));

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => view.adapterMode };
});

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => view.deployEnv };
});

vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMarketplaceCart/useMarketplaceCart')>();
  const { sumMoneyByAsset } = await import('@/libs/commerce/pricing');
  return {
    ...actual,
    useMarketplaceCart: () => {
      const items = view.items as Array<{
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
        pricingSource?: 'listing' | 'offer';
      }>;
      return {
        items,
        ordinaryItems: items,
        awardItems: view.awardItems,
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
        isLoading: view.isLoading,
        add: vi.fn(),
        update: vi.fn(),
        remove: checkoutActions.remove,
        clear: vi.fn(),
        groups: actual.groupMarketplaceCartItems(items as never),
      };
    },
  };
});

vi.mock('@/hooks/useMarketplaceCheckout/useMarketplaceCheckout', async () => {
  const { useForm } = await import('react-hook-form');
  const { zodResolver } = await import('@hookform/resolvers/zod');
  const { marketplaceCheckoutDefaults, marketplaceCheckoutSchema } =
    await import('@/hooks/useMarketplaceCheckout/useMarketplaceCheckout.types');
  return {
    useMarketplaceCheckout: (_items: unknown, _clear: unknown, award?: unknown) => {
      checkoutActions.lastAward = award;
      return {
        // The real hook keeps the hidden address flag in sync with the groups.
        form: useForm({
          resolver: zodResolver(marketplaceCheckoutSchema),
          defaultValues: { ...marketplaceCheckoutDefaults, requiresDeliveryAddress: view.requiresDeliveryAddress },
          mode: 'onTouched',
        }),
        submit: vi.fn(async () => false),
        pay: checkoutActions.pay,
        isPaying: false,
        needsSession: view.needsSession,
        sessionError: view.sessionError,
        hasMarketplaceSession: view.hasMarketplaceSession,
        addresses: view.addresses,
        selectedAddressId: view.selectedAddressId,
        selectAddress: vi.fn(),
        rememberAddress: checkoutActions.rememberAddress,
        fulfillmentOptionsForSeller: (sellerPubky: string) => view.fulfillmentOptions[sellerPubky] ?? ['shipping'],
        fulfillmentForSeller: (sellerPubky: string) => view.fulfillmentEffective[sellerPubky] ?? 'shipping',
        setFulfillmentChoice: checkoutActions.setFulfillmentChoice,
        requiresDeliveryAddress: view.requiresDeliveryAddress,
        hasFulfillmentConflict: view.hasFulfillmentConflict,
        isPickupCapabilityLoadingForSeller: () => view.isPickupCapabilityLoading,
        orderCount: view.orderCount,
        fulfillmentForItem: (itemId: string) => {
          const line = (view.items as Array<{ id: string; listing: { record: { ownerPubky: string } } }>).find(
            ({ id }) => id === itemId,
          );
          return (
            view.fulfillmentByItem[itemId] ??
            view.fulfillmentEffective[line?.listing.record.ownerPubky ?? ''] ??
            'shipping'
          );
        },
        setDigitalChoice: checkoutActions.setDigitalChoice,
        canChooseDigitalForItem: (itemId: string) => view.digitalChoosable.includes(itemId),
        digitalKindForItem: (itemId: string) => view.digitalKinds[itemId],
        isDigitalCapabilityLoading: view.isDigitalCapabilityLoading,
        digitalNotReadyItemIds: view.digitalNotReadyItemIds,
        isDigitalReady: view.isDigitalReady,
        requiresDeliveryEmail: view.requiresDeliveryEmail,
        hasInstantDigitalLine: view.hasInstantDigitalLine,
        hasManualDigitalLine: view.hasManualDigitalLine,
      };
    },
  };
});

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: view.orders,
    isLoading: false,
    error: null,
    needsSession: false,
    adapterMode: view.adapterMode,
    refresh: vi.fn(),
    advancePayment: vi.fn(),
    actOnOrder: vi.fn(),
  }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getSellerPaymentConfig: vi.fn(async () => ({
      bitcoinAvailable: true,
      bitcoinOfferAvailable: true,
      paypalAvailable: true,
    })),
    getIndicativeBtcRate: vi.fn(async () => null),
    getOrFetchListing: vi.fn(async () => listing.record),
    getListing: vi.fn(async () => listing),
    getCartItems: vi.fn(async () => []),
    getManyListings: vi.fn(async () => new Map()),
  },
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 0,
}));

vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 0,
}));

vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({
    offers: offerState.offers,
    isLoading: offerState.isLoading,
    refresh: offerState.refresh,
  }),
}));

vi.mock('@/hooks/useMarketplaceOfferCheckout/useMarketplaceOfferCheckout', () => ({
  useMarketplaceOfferCheckout: () => ({ submit: offerState.submit, isSubmitting: false }),
}));

const approval = vi.hoisted(() => ({ signer: 'Pubky Ring' as 'Bitkit' | 'Pubky Ring' }));
vi.mock('@/hooks/useMarketplaceApprovalSigner/useMarketplaceApprovalSigner', () => ({
  useMarketplaceApprovalSigner: () => approval.signer,
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'b'.repeat(52) }),
}));

vi.mock('@/organisms/Marketplace/MarketplaceIndicativePrice', () => ({
  MarketplaceIndicativePrice: ({ money }: { money: { currency: string } }) =>
    money.currency === 'USD' ? <span>≈ ₿137,000</span> : null,
}));

vi.mock('@/organisms/Marketplace/MarketplacePaymentStatusCard', () => ({
  MarketplacePaymentStatusCard: () => null,
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/organisms/Marketplace/MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: ({ triggerLabel }: { triggerLabel?: string }) => (
    <button type="button">{triggerLabel ?? 'Approve in Pubky Ring'}</button>
  ),
}));

vi.mock('@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary', () => ({
  useMarketplaceSellerSummary: (sellerPubky: string, options?: { includeReputation?: boolean }) => ({
    shop: null,
    reputation: options?.includeReputation === false ? { status: 'unavailable' } : { status: 'new_seller' },
    displayName: sellerPubky === listing.record.ownerPubky ? 'Satoshi Vintage' : 'Film Camera Supply',
  }),
}));

function resetCheckoutView() {
  view.orders = [];
  checkoutActions.pay.mockClear();
  checkoutActions.setFulfillmentChoice.mockReset();
  checkoutActions.remove.mockClear();
  checkoutActions.rememberAddress.mockClear();
  view.items = [];
  view.isLoading = false;
  view.adapterMode = 'sandbox';
  view.deployEnv = 'production';
  view.hasMarketplaceSession = false;
  view.needsSession = false;
  view.sessionError = null;
  view.addresses = [];
  view.selectedAddressId = null;
  view.fulfillmentOptions = {};
  view.fulfillmentEffective = {};
  view.requiresDeliveryAddress = true;
  view.hasFulfillmentConflict = false;
  view.isPickupCapabilityLoading = false;
  view.fulfillmentByItem = {};
  view.isDigitalReady = true;
  view.isDigitalCapabilityLoading = false;
  view.digitalKinds = {};
  view.digitalChoosable = [];
  view.digitalNotReadyItemIds = [];
  view.requiresDeliveryEmail = false;
  view.hasInstantDigitalLine = false;
  view.hasManualDigitalLine = false;
  checkoutActions.setDigitalChoice.mockReset();
  view.orderCount = 1;
  view.payResult = { ok: false, orderIds: [], boundOrders: [] };
  view.awardItems = [];
  offerState.offers = [];
  offerState.isLoading = false;
  offerState.refresh.mockClear();
  offerState.submit.mockReset();
  offerState.outcome = { ok: true, orderId: '00000000-0000-4000-8000-000000000803', boundOrder: null };
  offerState.submit.mockResolvedValue(offerState.outcome);
  searchParams.current = new URLSearchParams();
  window.history.replaceState(null, '', '/marketplace/checkout');
  buyerWallet.state = 'payable';
  buyerWallet.recheck.mockClear();
  buyerWallet.enabledCalls = [];
}

function seededCart() {
  view.items = [
    {
      id: 'seller:boots:variant_42',
      listingId: listing.id,
      variantId: 'variant_42',
      quantity: 1,
      listing,
    },
  ];
  view.isLoading = false;
}

async function fillValidDelivery(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Recipient'), 'Alice Buyer');
  await user.type(screen.getByLabelText('Address line 1'), '1 Market Street');
  await user.type(screen.getByLabelText('City'), 'New York');
  await user.type(screen.getByLabelText('State'), 'NY');
  await user.type(screen.getByLabelText('ZIP code'), '10001');
}

describe('MarketplaceCheckout', () => {
  beforeEach(() => {
    resetCheckoutView();
    approval.signer = 'Pubky Ring';
  });

  it('names Bitkit as the approving signer for a Bitkit sign-in', () => {
    seededCart();
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = true;
    approval.signer = 'Bitkit';

    render(<MarketplaceCheckout />);

    expect(screen.getByRole('heading', { name: 'Approve in Bitkit' })).toBeInTheDocument();
    expect(screen.getByText(/Purchases approved in Bitkit\./)).toBeInTheDocument();
    expect(screen.queryByText(/Pubky Ring/)).not.toBeInTheDocument();
  });

  it('never includes Stripe in the checkout rail list', async () => {
    seededCart();
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = true;

    render(<MarketplaceCheckout />);

    expect(await screen.findByTestId('marketplace-checkout-method-bitcoin')).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-checkout-method-paypal')).toBeInTheDocument();
    expect(screen.queryByTestId('marketplace-checkout-method-stripe')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stripe/ })).not.toBeInTheDocument();
  });

  it('disables Pay without a marketplace session in durable mode', () => {
    seededCart();
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = false;

    render(<MarketplaceCheckout />);

    expect(screen.getByRole('heading', { name: 'Approve in Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Approve purchases in Pubky Ring' })).toBeInTheDocument();
    const pay = screen.getByTestId('marketplace-checkout-pay');
    expect(pay).toBeDisabled();
    expect(pay).not.toHaveAttribute('aria-describedby');
  });

  it.each(['transaction-service', 'locks-paykit', 'unavailable'] as const)(
    'shows muted seller-direct helper in %s production checkout, not an amber money warning',
    (adapterMode) => {
      seededCart();
      view.adapterMode = adapterMode;
      view.hasMarketplaceSession = true;
      view.deployEnv = 'production';

      render(<MarketplaceCheckout />);

      expect(screen.queryByRole('note')).not.toBeInTheDocument();
      expect(
        screen.queryByText('Real money. Payments are final and go directly to the seller.'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('Paid directly to the seller.')).toBeInTheDocument();
      expect(screen.getByText(MARKETPLACE_DELIVERY_ADDRESS_DISCLOSURE)).toBeInTheDocument();
    },
  );

  it('does not show a production money warning when the deploy environment is unknown', () => {
    seededCart();
    view.adapterMode = 'sandbox';
    view.deployEnv = undefined;

    render(<MarketplaceCheckout />);

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Real money/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Staging environment/)).not.toBeInTheDocument();
  });

  it('shows the staging notice regardless of adapter mode', () => {
    seededCart();
    view.adapterMode = 'sandbox';
    view.deployEnv = 'staging';

    render(<MarketplaceCheckout />);

    expect(screen.getByRole('note')).toHaveTextContent('Staging environment — test rails, no real funds move');
    expect(screen.queryByText('Real money. Payments are final and go directly to the seller.')).not.toBeInTheDocument();
    expect(screen.queryByText('Paid directly to the seller.')).not.toBeInTheDocument();
  });

  it.each([false, true])('renders truthful address copy exactly once with saved addresses=%s', (hasSavedAddress) => {
    seededCart();
    view.addresses = hasSavedAddress ? [{ id: 'home', label: 'Home', city: 'New York', is_default: true }] : [];

    render(<MarketplaceCheckout />);

    expect(screen.getAllByText(MARKETPLACE_DELIVERY_ADDRESS_DISCLOSURE)).toHaveLength(1);
    expect(screen.queryByText(/not sent/)).not.toBeInTheDocument();
  });

  it('enables Pay after session plus a valid form', async () => {
    const user = userEvent.setup();
    seededCart();
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = true;

    render(<MarketplaceCheckout />);

    expect(screen.getByText(/Purchases approved in Pubky Ring/)).toBeInTheDocument();
    const pay = screen.getByTestId('marketplace-checkout-pay');
    expect(pay).toBeDisabled();

    await fillValidDelivery(user);
    expect(pay).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /I accept guarantee policy v1/ })).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: /I accept guarantee policy v1/ }));
    await waitFor(() => expect(pay).toBeEnabled());
  });

  it('tells a Bitcoin buyer the payment adds 1–999 sats, and hides that note for PayPal', async () => {
    const user = userEvent.setup();
    seededCart();
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = true;

    render(<MarketplaceCheckout />);

    const note = await screen.findByTestId('marketplace-checkout-bitcoin-amount-note');
    expect(note).toHaveTextContent('The payment adds a small unique amount of 1–999 sats.');
    expect(note).toHaveTextContent('The exact amount appears when you place the order.');
    expect(note.className).not.toMatch(/border|bg-amber|alert/);
    expect(note.textContent).not.toMatch(/paykit|protocol/i);

    await user.click(screen.getByTestId('marketplace-checkout-method-paypal'));
    expect(screen.queryByTestId('marketplace-checkout-bitcoin-amount-note')).not.toBeInTheDocument();
  });

  it('asks a buyer without a Paykit wallet to connect Bitkit instead of letting Bitcoin Pay fail', async () => {
    const user = userEvent.setup();
    seededCart();
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = true;
    buyerWallet.state = 'not_payable';

    render(<MarketplaceCheckout />);

    const pay = screen.getByTestId('marketplace-checkout-pay');
    await fillValidDelivery(user);
    await user.click(screen.getByRole('checkbox', { name: /I accept guarantee policy v1/ }));
    const notice = await screen.findByTestId('marketplace-checkout-bitkit-required');
    expect(notice).toHaveTextContent('Connect Bitkit to pay with Bitcoin');
    expect(notice).toHaveTextContent('You can also pay with PayPal.');
    expect(pay).toBeDisabled();
    expect(
      screen.getByText('Connect Bitkit to pay with Bitcoin, or choose another payment method.'),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId('marketplace-checkout-bitkit-recheck'));
    expect(buyerWallet.recheck).toHaveBeenCalledTimes(1);

    // Another rail stays payable.
    await user.click(screen.getByTestId('marketplace-checkout-method-paypal'));
    await waitFor(() => expect(pay).toBeEnabled());
    expect(screen.queryByTestId('marketplace-checkout-bitkit-required')).not.toBeInTheDocument();
    expect(checkoutActions.pay).not.toHaveBeenCalled();
  });

  it('keeps Bitcoin Pay available while the wallet check is inconclusive, and holds it while checking', async () => {
    const user = userEvent.setup();
    seededCart();
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = true;
    buyerWallet.state = 'checking';

    const { rerender } = render(<MarketplaceCheckout />);
    const pay = screen.getByTestId('marketplace-checkout-pay');
    await fillValidDelivery(user);
    await user.click(screen.getByRole('checkbox', { name: /I accept guarantee policy v1/ }));
    expect(await screen.findByText('Checking your Bitcoin wallet…')).toBeInTheDocument();
    expect(pay).toBeDisabled();

    buyerWallet.state = 'unknown';
    rerender(<MarketplaceCheckout />);
    await waitFor(() => expect(pay).toBeEnabled());
    expect(screen.queryByTestId('marketplace-checkout-bitkit-required')).not.toBeInTheDocument();
    expect(buyerWallet.enabledCalls).toContain(true);
  });

  it('pays on the checkout screen instead of routing to orders', async () => {
    const user = userEvent.setup();
    seededCart();
    view.payResult = { ok: true, orderIds: ['018f47d2-6a27-7c23-a49d-000000000001'], boundOrders: [] };

    render(<MarketplaceCheckout />);
    await fillValidDelivery(user);
    await user.click(screen.getByRole('checkbox', { name: /I accept sandbox guarantee policy v1/ }));
    await user.click(screen.getByTestId('marketplace-checkout-pay'));

    expect(checkoutActions.pay).toHaveBeenCalled();
  });

  it('requires the guarantee after a pay attempt and leaves it unchecked by default', async () => {
    seededCart();

    render(<MarketplaceCheckout />);

    const guarantee = screen.getByRole('checkbox', { name: /I accept sandbox guarantee policy v1/ });
    expect(guarantee).not.toBeChecked();
    expect(screen.queryByText('Accept the guarantee terms.')).not.toBeInTheDocument();

    await fillValidDelivery(userEvent.setup());
    expect(screen.getByTestId('marketplace-checkout-pay')).toBeDisabled();
    expect(
      screen.getByText('Fill in delivery details, accept the guarantee, and choose a payment method to pay.'),
    ).toBeInTheDocument();
  });

  it('re-opens Ring approval when a session expires mid-flow', () => {
    seededCart();
    view.adapterMode = 'locks-paykit';
    view.hasMarketplaceSession = true;
    view.needsSession = true;
    view.sessionError = 'Marketplace session required.';

    render(<MarketplaceCheckout />);

    expect(screen.getByRole('heading', { name: 'Approve purchases in Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-checkout-pay')).toBeDisabled();
  });

  it('shows an empty checkout when the cart has no ordinary items', () => {
    render(<MarketplaceCheckout />);

    expect(screen.getByText('Nothing to check out')).toBeInTheDocument();
  });

  describe('paid order headline', () => {
    afterEach(() => {
      window.location.hash = '';
    });

    const showPaidOrder = (overrides: { paymentMethod: 'bitcoin' | 'paypal'; confirmations: number }) => {
      const payment = createPaymentFixture('confirmed', {
        adapter: overrides.paymentMethod === 'bitcoin' ? 'paykit' : 'paypal',
        confirmations: overrides.confirmations,
      });
      const order = createOrderFixture('paid', {
        paymentId: payment.id,
        paymentMethod: overrides.paymentMethod,
        paykitRequestState: overrides.paymentMethod === 'bitcoin' ? 'confirmed' : null,
      });
      view.orders = [{ order, payment }];
      window.location.hash = `#${order.id}`;
      render(<MarketplaceCheckout />);
    };

    it('names the seller for a Bitcoin order the seller confirmed before any chain confirmation', () => {
      showPaidOrder({ paymentMethod: 'bitcoin', confirmations: 0 });
      expect(screen.getByTestId('marketplace-checkout-paid-headline')).toHaveTextContent(
        /^Seller confirmed payment\.$/,
      );
    });

    it('adds the on-chain state once a confirmation was recorded', () => {
      showPaidOrder({ paymentMethod: 'bitcoin', confirmations: 1 });
      expect(screen.getByTestId('marketplace-checkout-paid-headline')).toHaveTextContent(
        'Seller confirmed payment. Confirmed on-chain.',
      );
    });

    it('keeps the generic line for PayPal', () => {
      showPaidOrder({ paymentMethod: 'paypal', confirmations: 0 });
      expect(screen.getByTestId('marketplace-checkout-paid-headline')).toHaveTextContent(/^Payment confirmed\.$/);
    });
  });
});

describe('MarketplaceCheckout local pickup (Wave 7, §A2)', () => {
  beforeEach(() => {
    resetCheckoutView();
  });

  it('offers the fulfillment choice only when every line in the group publishes both', async () => {
    const user = userEvent.setup();
    seededCart();
    view.fulfillmentOptions = { [listing.record.ownerPubky]: ['shipping', 'pickup'] };

    render(<MarketplaceCheckout />);

    const select = screen.getByLabelText(`Fulfillment for items from ${listing.record.ownerPubky}`);
    expect(select).toHaveTextContent('Ship it');
    await user.click(select);
    await user.click(screen.getByRole('option', { name: 'Local pickup' }));
    expect(checkoutActions.setFulfillmentChoice).toHaveBeenCalledWith(listing.record.ownerPubky, 'pickup');
  });

  it('renders a pickup group with no shipping line and the reveal note', () => {
    seededCart();
    view.fulfillmentEffective = { [listing.record.ownerPubky]: 'pickup' };
    view.requiresDeliveryAddress = false;

    render(<MarketplaceCheckout />);

    expect(screen.getByText(/Local pickup — no delivery address or shipping for these items/)).toBeInTheDocument();
    expect(document.querySelector('[data-surface="checkout-pickup-group"]')).toBeTruthy();
  });

  it('hides the delivery-address step on a pickup-only checkout and says why', () => {
    seededCart();
    view.fulfillmentEffective = { [listing.record.ownerPubky]: 'pickup' };
    view.requiresDeliveryAddress = false;

    render(<MarketplaceCheckout />);

    expect(screen.queryByLabelText('Recipient')).not.toBeInTheDocument();
    expect(screen.getByText(/No delivery address is needed/)).toBeInTheDocument();
    expect(screen.getByText('No shipping — pickup is arranged with the seller after payment.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /I accept sandbox guarantee policy v1/ })).toBeInTheDocument();
  });

  it('states the (seller, fulfillment) split plainly before pay', () => {
    view.items = [
      { id: 'seller:boots:variant_42', listingId: listing.id, variantId: 'variant_42', quantity: 1, listing },
      {
        id: 'other:camera:variant_01',
        listingId: secondSellerListing.id,
        variantId: 'variant_01',
        quantity: 1,
        listing: secondSellerListing,
      },
    ];
    view.orderCount = 2;

    render(<MarketplaceCheckout />);

    expect(screen.getByText('This starts 2 checkouts — one per seller and delivery method.')).toBeInTheDocument();
  });

  it('blocks pay and explains when a group has no common fulfillment', () => {
    seededCart();
    view.fulfillmentOptions = { [listing.record.ownerPubky]: [] };
    view.fulfillmentEffective = {};
    view.hasFulfillmentConflict = true;

    render(<MarketplaceCheckout />);

    expect(screen.getByRole('alert')).toHaveTextContent(/can't be checked out together/);
    expect(screen.getByTestId('marketplace-checkout-pay')).toBeDisabled();
    expect(screen.getByText("Some items can't be checked out together — see the note above.")).toHaveAttribute(
      'id',
      'checkout-pay-reason',
    );
  });

  it('shows a skeleton instead of pickup or conflict copy while pickup capability is loading', () => {
    seededCart();
    view.isPickupCapabilityLoading = true;
    view.fulfillmentOptions = { [listing.record.ownerPubky]: [] };
    view.hasFulfillmentConflict = true;

    render(<MarketplaceCheckout />);

    expect(screen.getByTestId('pickup-capability-skeleton')).toHaveAttribute(
      'aria-label',
      'Checking pickup availability',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Local pickup — no delivery address/)).not.toBeInTheDocument();
  });
});

describe('MarketplaceCheckout digital lines (digital delivery design §3 "Checkout")', () => {
  const CART_ITEM_ID = 'seller:boots:variant_42';

  beforeEach(() => {
    resetCheckoutView();
  });

  it('adds no shipping for a line the buyer takes digitally', () => {
    view.items = [
      {
        id: CART_ITEM_ID,
        listingId: listing.id,
        variantId: 'variant_42',
        quantity: 1,
        listing: {
          ...listing,
          record: {
            ...listing.record,
            shippingOptions: [
              {
                id: 'ground',
                pricing: 'flat',
                label: 'Ground',
                price: { amountMinor: 500, currency: 'USD', exponent: 2 },
                estimatedMinDays: 3,
                estimatedMaxDays: 7,
              },
            ],
          },
        },
      },
    ];
    const { unmount } = render(<MarketplaceCheckout />);
    expect(screen.getByText('Shipping')).toBeInTheDocument();
    unmount();

    view.fulfillmentByItem = { [CART_ITEM_ID]: 'digital' };
    render(<MarketplaceCheckout />);
    expect(screen.queryByText('Shipping')).not.toBeInTheDocument();
  });

  it('shows no fulfillment conflict for a seller whose lines are all digital', () => {
    seededCart();
    view.fulfillmentOptions = { [listing.record.ownerPubky]: [] };
    view.fulfillmentByItem = { [CART_ITEM_ID]: 'digital' };

    render(<MarketplaceCheckout />);

    expect(screen.queryByText(/can't be checked out together/)).not.toBeInTheDocument();
  });

  it('shows no fulfillment conflict while the digital capability loads', () => {
    seededCart();
    view.fulfillmentOptions = { [listing.record.ownerPubky]: [] };
    view.isDigitalCapabilityLoading = true;
    view.isDigitalReady = false;

    render(<MarketplaceCheckout />);

    expect(screen.queryByText(/can't be checked out together/)).not.toBeInTheDocument();
    expect(screen.getByTestId('marketplace-checkout-pay')).toBeDisabled();
  });

  it('labels a digital line with how it arrives', () => {
    seededCart();
    view.requiresDeliveryAddress = false;
    view.fulfillmentByItem = { [CART_ITEM_ID]: 'digital' };
    view.digitalKinds = { [CART_ITEM_ID]: 'file' };

    render(<MarketplaceCheckout />);

    expect(screen.getByTestId('checkout-digital-line')).toHaveTextContent('Digital delivery · Instant download');
  });

  it('says a line cannot be bought until its seller sets delivery (B4)', () => {
    seededCart();
    view.requiresDeliveryAddress = false;
    view.fulfillmentByItem = { [CART_ITEM_ID]: 'digital' };
    view.digitalKinds = { [CART_ITEM_ID]: null };
    view.digitalNotReadyItemIds = [CART_ITEM_ID];
    view.isDigitalReady = false;

    render(<MarketplaceCheckout />);

    expect(screen.getByTestId('checkout-digital-line')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('checkout-digital-line')).toHaveTextContent(
      "The seller hasn't finished setting up delivery for this item.",
    );
    expect(document.getElementById('checkout-pay-reason')).toHaveTextContent(
      "An item's seller hasn't finished setting up delivery. Remove it in the cart to continue.",
    );
  });

  it('says Pay unlocks once delivery options load', () => {
    seededCart();
    view.isDigitalReady = false;

    render(<MarketplaceCheckout />);

    expect(document.getElementById('checkout-pay-reason')).toHaveTextContent('Pay unlocks once delivery options load.');
  });

  it('offers Physical copy or Digital delivery on a line whose listing offers both', async () => {
    const user = userEvent.setup();
    seededCart();
    view.digitalChoosable = [CART_ITEM_ID];

    render(<MarketplaceCheckout />);

    const select = screen.getByLabelText(`Delivery for ${listing.record.title}`);
    expect(select).toHaveTextContent('Physical copy');
    await user.click(select);
    await user.click(screen.getByRole('option', { name: 'Digital delivery' }));
    expect(checkoutActions.setDigitalChoice).toHaveBeenCalledWith(CART_ITEM_ID, true);
  });

  it('asks for the email for an email-kind line, with the disclosure (§3, F1)', () => {
    seededCart();
    view.requiresDeliveryAddress = false;
    view.requiresDeliveryEmail = true;
    view.fulfillmentByItem = { [CART_ITEM_ID]: 'digital' };
    view.digitalKinds = { [CART_ITEM_ID]: 'email' };

    render(<MarketplaceCheckout />);

    expect(screen.getByRole('heading', { name: 'Email for delivery' })).toBeInTheDocument();
    expect(
      screen.getByText(
        "The seller of this item sees this after your payment is confirmed, to send your order. It isn't used for anything else.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('maxLength', '254');
    expect(screen.queryByLabelText('Recipient')).not.toBeInTheDocument();
  });

  it('asks for no email when no line is email-kind', () => {
    seededCart();

    render(<MarketplaceCheckout />);

    expect(screen.queryByRole('heading', { name: 'Email for delivery' })).not.toBeInTheDocument();
  });

  it('states each consent line above Pay', () => {
    seededCart();
    view.hasInstantDigitalLine = true;
    view.hasManualDigitalLine = true;

    render(<MarketplaceCheckout />);

    expect(screen.getByTestId('checkout-consent-instant')).toHaveTextContent(
      "Delivery starts as soon as payment is confirmed. Digital orders can't be cancelled once delivered; message the seller about a refund.",
    );
    expect(screen.getByTestId('checkout-consent-manual')).toHaveTextContent(
      'You can ask to cancel until the seller marks it delivered.',
    );
  });

  it('shows no pickup copy on an all-digital checkout', () => {
    seededCart();
    view.requiresDeliveryAddress = false;
    view.fulfillmentByItem = { [CART_ITEM_ID]: 'digital' };
    view.digitalKinds = { [CART_ITEM_ID]: 'file' };

    render(<MarketplaceCheckout />);

    expect(screen.queryByText(/No delivery address is needed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pickup is arranged/)).not.toBeInTheDocument();
    expect(screen.getByText('No shipping for digital items.')).toBeInTheDocument();
  });

  it('keeps Pay disabled until every digital line is ready', async () => {
    const user = userEvent.setup();
    seededCart();
    view.isDigitalReady = false;

    render(<MarketplaceCheckout />);
    await fillValidDelivery(user);
    await user.click(screen.getByRole('checkbox', { name: /I accept sandbox guarantee policy v1/ }));

    expect(screen.getByTestId('marketplace-checkout-pay')).toBeDisabled();
  });
});

describe('MarketplaceCheckout with no usable payment method', () => {
  const ALL_RAILS = {
    bitcoinAvailable: true,
    bitcoinOfferAvailable: true,
    paypalAvailable: true,
  };
  const NO_RAILS = {
    bitcoinAvailable: false,
    bitcoinOfferAvailable: true,
    paypalAvailable: false,
  };

  beforeEach(() => {
    resetCheckoutView();
    view.adapterMode = 'locks-paykit';
    view.hasMarketplaceSession = true;
  });

  afterEach(() => {
    vi.mocked(CommerceController.getSellerPaymentConfig).mockImplementation(async () => ALL_RAILS);
  });

  it('says the one seller has not set up a method this cart can use, without multi-seller advice', async () => {
    seededCart();
    vi.mocked(CommerceController.getSellerPaymentConfig).mockImplementation(async () => NO_RAILS);

    render(<MarketplaceCheckout />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This seller hasn't set up a payment method this cart can use, so Pay stays disabled.",
    );
    expect(screen.queryByText(/These sellers do not share a payment method/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Remove a seller/)).not.toBeInTheDocument();
    expect(screen.getByText('Pay unlocks once this seller sets up a payment method.')).toHaveAttribute(
      'id',
      'checkout-pay-reason',
    );
    expect(screen.getByTestId('marketplace-checkout-pay')).toBeDisabled();
  });

  it('offers PayPal for a seller whose public config has only a PayPal email', async () => {
    seededCart();
    vi.mocked(CommerceController.getSellerPaymentConfig).mockImplementation(async () => ({
      ...NO_RAILS,
      paypalAvailable: true,
    }));

    render(<MarketplaceCheckout />);

    expect(await screen.findByTestId('marketplace-checkout-method-paypal')).toHaveTextContent('PayPal');
    expect(screen.queryByTestId('marketplace-checkout-method-bitcoin')).not.toBeInTheDocument();
    expect(screen.queryByText(/hasn't set up a payment method/)).not.toBeInTheDocument();
  });

  it('shows loading, not "no payment method", while a PayPal seller config loads after the cart hydrates', async () => {
    let resolveConfig: (config: typeof NO_RAILS) => void = () => {};
    vi.mocked(CommerceController.getSellerPaymentConfig).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve as typeof resolveConfig;
        }),
    );

    const { rerender } = render(<MarketplaceCheckout />);
    expect(screen.getByText('Nothing to check out')).toBeInTheDocument();

    seededCart();
    rerender(<MarketplaceCheckout />);

    expect(await screen.findByLabelText('Loading payment methods')).toBeInTheDocument();
    expect(screen.queryByText(/hasn't set up a payment method/)).not.toBeInTheDocument();
    expect(screen.queryByText('Pay unlocks once this seller sets up a payment method.')).not.toBeInTheDocument();

    resolveConfig({ ...NO_RAILS, paypalAvailable: true });

    expect(await screen.findByTestId('marketplace-checkout-method-paypal')).toBeInTheDocument();
    expect(screen.queryByText(/hasn't set up a payment method/)).not.toBeInTheDocument();
  });

  it('offers Retry, not "no payment method", when the seller config read fails', async () => {
    const user = userEvent.setup();
    seededCart();
    vi.mocked(CommerceController.getSellerPaymentConfig).mockRejectedValueOnce(new Error('network down'));

    render(<MarketplaceCheckout />);

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load payment options.");
    expect(screen.queryByText(/hasn't set up a payment method/)).not.toBeInTheDocument();
    expect(screen.queryByText('Pay unlocks once this seller sets up a payment method.')).not.toBeInTheDocument();
    expect(screen.getByText('Pay unlocks once payment options load.')).toHaveAttribute('id', 'checkout-pay-reason');
    expect(screen.getByTestId('marketplace-checkout-pay')).toBeDisabled();

    vi.mocked(CommerceController.getSellerPaymentConfig).mockImplementation(async () => ({
      ...NO_RAILS,
      paypalAvailable: true,
    }));
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('marketplace-checkout-method-paypal')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load payment options.")).not.toBeInTheDocument();
  });

  it('keeps the shared-rail advice when two sellers have no method in common', async () => {
    view.items = [
      { id: 'seller:boots:variant_42', listingId: listing.id, variantId: 'variant_42', quantity: 1, listing },
      {
        id: 'other:camera:variant_01',
        listingId: secondSellerListing.id,
        variantId: 'variant_01',
        quantity: 1,
        listing: secondSellerListing,
      },
    ];
    vi.mocked(CommerceController.getSellerPaymentConfig).mockImplementation(async (sellerPubky: unknown) =>
      sellerPubky === listing.record.ownerPubky ? { ...NO_RAILS, paypalAvailable: true } : NO_RAILS,
    );

    render(<MarketplaceCheckout />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These sellers do not share a payment method, so Pay stays disabled. Remove a seller in the cart or ask them to add a shared rail.',
    );
    expect(screen.queryByText(/This seller hasn't set up/)).not.toBeInTheDocument();
    expect(screen.getByText('Choose sellers that share a payment method.')).toHaveAttribute(
      'id',
      'checkout-pay-reason',
    );
  });
});

const acceptedOffer = {
  id: 'offer-1',
  state: 'accepted',
  buyerPubky: 'b'.repeat(52),
  award: {
    id: 'award-1',
    state: 'active',
    listing: {
      sellerPubky: 's'.repeat(52),
      listingId: 'boots',
      title: 'Vintage boots',
      aggregateId: 'listing:s_boots',
      listingRevision: 3,
      listingRecordSha256: 'a'.repeat(64),
    },
    variant: { id: 'variant_42', options: [{ name: 'Size', value: '42' }] },
    unitPrice: { amountMinor: 600, currency: 'USD', exponent: 2 },
    quantity: 1,
    convertBy: '2026-09-15T12:00:00.000Z',
    subtotal: { amountMinor: 600, currency: 'USD', exponent: 2 },
    shipping: { amountMinor: 100, currency: 'USD', exponent: 2 },
    merchandiseTotal: { amountMinor: 700, currency: 'USD', exponent: 2 },
    fulfillmentMethods: ['shipping'],
  },
};

describe('MarketplaceCheckout accepted-offer path', () => {
  beforeEach(() => {
    resetCheckoutView();
    searchParams.current = new URLSearchParams('offer=offer-1');
    view.awardItems = [{ awardId: 'award-1', listingId: 's:boots', variantId: 'variant_42' }];
    offerState.offers = [acceptedOffer];
    view.addresses = [
      {
        id: 'home',
        label: 'Home',
        city: 'New York',
        is_default: true,
      },
    ];
    window.history.replaceState(null, '', '/marketplace/checkout?offer=offer-1');
  });

  async function fillAndPay(user: ReturnType<typeof userEvent.setup>) {
    await fillValidDelivery(user);
    await user.click(screen.getByRole('checkbox', { name: /I accept sandbox guarantee policy v1/ }));
    const pay = screen.getByTestId('marketplace-checkout-pay');
    await waitFor(() => expect(pay).toBeEnabled());
    await user.click(pay);
  }

  it('renders server-projected agreed price, shipping, total, and deadline on the one Checkout screen', () => {
    render(<MarketplaceCheckout />);

    expect(screen.getByRole('heading', { name: 'Checkout' })).toBeInTheDocument();
    expect(screen.getByText('Vintage boots')).toBeInTheDocument();
    expect(screen.getByText(/42 · Quantity 1/)).toBeInTheDocument();
    expect(screen.getByText('Subtotal').parentElement).toHaveTextContent('$6.00');
    expect(screen.getByText('Shipping').parentElement).toHaveTextContent('$1.00');
    expect(screen.getByText('Merchandise total').parentElement).toHaveTextContent('$7.00');
    expect(screen.getByText(/Checkout window closes/)).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-checkout-pay')).toBeInTheDocument();
    expect(screen.getByLabelText('Saved addresses')).toBeInTheDocument();
  });

  it('keeps the new-address form when the book is empty instead of gating to settings', () => {
    view.addresses = [];
    render(<MarketplaceCheckout />);

    expect(screen.getByLabelText('Recipient')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add delivery address' })).not.toBeInTheDocument();
    expect(screen.getByTestId('marketplace-checkout-pay')).toBeDisabled();
  });

  it('removes the award line and continues checkout after a successful pay', async () => {
    const user = userEvent.setup();
    render(<MarketplaceCheckout />);
    await fillAndPay(user);

    expect(offerState.submit).toHaveBeenCalled();
    expect(offerState.submit.mock.calls[0]?.[1]).toMatchObject({ name: 'Alice Buyer', line1: '1 Market Street' });
    expect(checkoutActions.remove).toHaveBeenCalledWith('s:boots', 'variant_42', 'award-1');
    expect(offerState.refresh).toHaveBeenCalledTimes(1);
    expect(checkoutActions.rememberAddress).toHaveBeenCalled();
  });

  it('checks out a pickup award with the pickup UI: no address, no shipping, merchandise only', async () => {
    view.fulfillmentEffective = { ['s'.repeat(52)]: 'pickup' };
    view.requiresDeliveryAddress = false;
    const user = userEvent.setup();
    render(<MarketplaceCheckout />);

    expect(
      await screen.findByText(/Local pickup — no delivery address or shipping for these items/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Recipient')).not.toBeInTheDocument();
    expect(screen.getByText('Shipping').parentElement).toHaveTextContent('$0.00');
    expect(screen.getByText('Merchandise total').parentElement).toHaveTextContent('$6.00');

    await user.click(screen.getByRole('checkbox', { name: /I accept sandbox guarantee policy v1/ }));
    const pay = screen.getByTestId('marketplace-checkout-pay');
    await waitFor(() => expect(pay).toBeEnabled());
    await user.click(pay);

    expect(offerState.submit).toHaveBeenCalledTimes(1);
    expect(offerState.submit.mock.calls[0]?.[1]).toBeNull();
    expect(checkoutActions.rememberAddress).not.toHaveBeenCalled();
  });

  it('says a pickup award has no shipping and is collected in person', async () => {
    view.fulfillmentEffective = { ['s'.repeat(52)]: 'pickup' };
    view.requiresDeliveryAddress = false;
    render(<MarketplaceCheckout />);

    expect(
      await screen.findByText('No shipping — pickup is arranged with the seller after payment.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No delivery address is needed — every item here is collected in person/),
    ).toBeInTheDocument();
  });

  it('says a pickup-only award cannot check out while pickup is unavailable', async () => {
    view.fulfillmentOptions = { ['s'.repeat(52)]: [] };
    view.hasFulfillmentConflict = true;
    render(<MarketplaceCheckout />);

    expect(
      await screen.findByText(
        'This listing is local pickup only, and pickup is unavailable on this deployment right now.',
      ),
    ).toHaveAttribute('role', 'alert');
  });

  it('resolves award fulfillment from the accepted snapshot, never the listing as it is now', () => {
    offerState.offers = [{ ...acceptedOffer, award: { ...acceptedOffer.award, fulfillmentMethods: ['pickup'] } }];
    render(<MarketplaceCheckout />);

    expect(checkoutActions.lastAward).toEqual({ sellerPubky: 's'.repeat(52), fulfillmentMethods: ['pickup'] });
    expect(CommerceController.getListing).not.toHaveBeenCalled();
    expect(CommerceController.getOrFetchListing).not.toHaveBeenCalled();
  });

  it('offers the shipping-or-pickup choice for an award on a listing that publishes both', async () => {
    view.fulfillmentOptions = { ['s'.repeat(52)]: ['shipping', 'pickup'] };
    const user = userEvent.setup();
    render(<MarketplaceCheckout />);

    const select = await screen.findByLabelText(`Fulfillment for items from ${'s'.repeat(52)}`);
    await user.click(select);
    await user.click(screen.getByRole('option', { name: 'Local pickup' }));
    expect(checkoutActions.setFulfillmentChoice).toHaveBeenCalledWith('s'.repeat(52), 'pickup');
  });

  it('shows expiry copy, removes the line, refreshes offers, and offers both next actions', async () => {
    offerState.submit.mockResolvedValue({ ok: false, code: 'AWARD_EXPIRED' });
    const user = userEvent.setup();
    render(<MarketplaceCheckout />);
    await fillAndPay(user);

    expect(screen.getByText('This accepted offer expired before checkout. Nothing was reserved.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View offers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buy at current price' })).toBeInTheDocument();
    expect(checkoutActions.remove).toHaveBeenCalledTimes(1);
    expect(offerState.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(['AWARD_ALREADY_CONVERTED', 'REVISION_CONFLICT'])('shows the converted state for %s', async (code) => {
    offerState.submit.mockResolvedValue({ ok: false, code });
    const user = userEvent.setup();
    render(<MarketplaceCheckout />);
    await fillAndPay(user);

    expect(screen.getByText('This accepted offer has already been converted.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View orders' })).toBeInTheDocument();
    expect(checkoutActions.remove).toHaveBeenCalledWith('s:boots', 'variant_42', 'award-1');
  });

  it('removes the award line and refreshes offers when the award is unavailable', async () => {
    offerState.submit.mockResolvedValue({ ok: false, code: 'AWARD_UNAVAILABLE' });
    const user = userEvent.setup();
    render(<MarketplaceCheckout />);
    await fillAndPay(user);

    expect(screen.getByText('This offer is no longer available.')).toBeInTheDocument();
    expect(checkoutActions.remove).toHaveBeenCalledWith('s:boots', 'variant_42', 'award-1');
  });

  it('shows mapped refusal copy and Retry for other checkout refusal codes', async () => {
    offerState.submit.mockResolvedValue({ ok: false, code: 'AWARD_QUANTITY_MISMATCH' });
    const user = userEvent.setup();
    render(<MarketplaceCheckout />);
    await fillAndPay(user);

    expect(screen.getByText('The checkout quantity does not match the accepted offer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('withholds checkout for a malformed award projection', () => {
    offerState.offers = [{ ...acceptedOffer, award: undefined }];
    render(<MarketplaceCheckout />);
    expect(screen.getByText('Checkout for this offer is unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByTestId('marketplace-checkout-pay')).not.toBeInTheDocument();
  });

  it.each(['subtotal', 'shipping', 'merchandiseTotal'])('withholds checkout when %s is absent', (field) => {
    const incomplete = { ...acceptedOffer, award: { ...acceptedOffer.award } };
    delete incomplete.award[field as keyof typeof incomplete.award];
    offerState.offers = [incomplete];
    render(<MarketplaceCheckout />);
    expect(screen.getByText('Checkout for this offer is unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByTestId('marketplace-checkout-pay')).not.toBeInTheDocument();
  });

  it('withholds checkout when award money currencies do not match', () => {
    offerState.offers = [
      {
        ...acceptedOffer,
        award: { ...acceptedOffer.award, shipping: { ...acceptedOffer.award.shipping, currency: 'EUR' } },
      },
    ];
    render(<MarketplaceCheckout />);
    expect(screen.getByText('Checkout for this offer is unavailable right now.')).toBeInTheDocument();
  });

  it('withholds checkout from the seller on the award route', () => {
    offerState.offers = [{ ...acceptedOffer, buyerPubky: 's'.repeat(52) }];
    render(<MarketplaceCheckout />);
    expect(screen.getByText('Checkout for this offer is unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByTestId('marketplace-checkout-pay')).not.toBeInTheDocument();
  });
});

describe('MarketplaceCheckout drop-claim path', () => {
  beforeEach(() => {
    resetCheckoutView();
    searchParams.current = new URLSearchParams({
      seller: listing.record.ownerPubky,
      drop: 'vol1',
      listing: 'boots',
    });
    window.history.replaceState(
      null,
      '',
      `/marketplace/checkout?seller=${listing.record.ownerPubky}&drop=vol1&listing=boots`,
    );
  });

  it('loads the drop listing as quantity 1 on the one Checkout screen', async () => {
    render(<MarketplaceCheckout />);

    expect(await screen.findByRole('heading', { name: 'Checkout' })).toBeInTheDocument();
    expect(await screen.findByText('Vintage boots')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to drop' })).toHaveAttribute(
      'href',
      `/marketplace/drop/${listing.record.ownerPubky}/vol1`,
    );
    expect(screen.getByTestId('marketplace-checkout-pay')).toBeInTheDocument();
    expect(screen.getByLabelText('Recipient')).toBeInTheDocument();
  });
});
