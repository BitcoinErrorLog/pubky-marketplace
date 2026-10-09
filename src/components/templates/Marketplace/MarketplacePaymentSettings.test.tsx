import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { LOCKS_STATUS_CHECK_ERROR } from '@/hooks/useMarketplaceLocksConnect/useMarketplaceLocksConnect';
import type { SellerPaymentConfigOwnView } from '@/libs/commerce/payment-methods';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { setSocialHost } from '@/test-utils/social-host';
import { MarketplacePaymentSettings } from './MarketplacePaymentSettings';

const view = vi.hoisted(() => ({
  locksConnect: {
    connectedCreator: null,
    isExchanging: false,
    error: null,
    connectOpen: false,
    connectUrl: null,
  } as {
    connectedCreator: string | null;
    isExchanging: boolean;
    error: string | null;
    reapproveNotice?: string | null;
    connectOpen: boolean;
    connectUrl: string | null;
  },
}));
const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
  usePathname: () => '/marketplace/settings',
  useSearchParams: () => navigation.searchParams,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getSellerPaymentConfig: vi.fn(),
    getPaykitSetupUrl: vi.fn((returnTo: string, state: string, creator: string) => {
      const url = new URL('https://paykit.example/setup');
      url.searchParams.set('return_to', returnTo);
      url.searchParams.set('state', state);
      url.searchParams.set('creator', creator);
      return url.toString();
    }),
    getMyPaymentConfig: vi.fn(),
    isOwnPaykitAccountClaimed: vi.fn(),
    putMyPaymentConfig: vi.fn(),
    beginMarketplaceSessionConnect: vi.fn(),
    hasFullHomeserverGrant: vi.fn(() => false),
    createLocksFrontendSession: vi.fn(),
  },
}));

vi.mock('@/organisms/Marketplace/MarketplaceSectionNav', () => ({
  MarketplaceSectionNav: () => <nav aria-label="Marketplace sections" />,
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceLocksConnect/useMarketplaceLocksConnect', async (importOriginal) => ({
  LOCKS_STATUS_CHECK_ERROR: (
    await importOriginal<typeof import('@/hooks/useMarketplaceLocksConnect/useMarketplaceLocksConnect')>()
  ).LOCKS_STATUS_CHECK_ERROR,
  useMarketplaceLocksConnect: () => ({
    ...view.locksConnect,
    setConnectIframe: vi.fn(),
    openConnect: vi.fn(),
    closeConnect: vi.fn(),
  }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

const mockedController = vi.mocked(CommerceController);
const mockedToast = vi.mocked(toast);

const EMPTY_CONFIG: SellerPaymentConfigOwnView = {
  bitcoinEnabled: false,
  stripePaymentLink: null,
  paypalMerchantEmail: null,
  stripeRestrictedKeySet: false,
  updatedAt: '2026-08-22T12:00:00.000Z',
};

beforeEach(() => {
  vi.useRealTimers();
  mockedToast.mockReset();
  sessionStorage.clear();
  navigation.push.mockReset();
  navigation.searchParams = new URLSearchParams();
  view.locksConnect = {
    connectedCreator: null,
    isExchanging: false,
    error: null,
    connectOpen: false,
    connectUrl: null,
  };
  mockedController.getSellerPaymentConfig.mockReset().mockResolvedValue({
    bitcoinAvailable: false,
    bitcoinOfferAvailable: true,
    paypalAvailable: false,
  });
  mockedController.getMyPaymentConfig.mockReset().mockResolvedValue(EMPTY_CONFIG);
  mockedController.isOwnPaykitAccountClaimed.mockReset().mockResolvedValue(false);
  mockedController.putMyPaymentConfig.mockReset().mockImplementation(async (input) => ({
    bitcoinEnabled: input.bitcoinEnabled,
    stripePaymentLink: input.stripePaymentLink,
    paypalMerchantEmail: input.paypalMerchantEmail,
    stripeRestrictedKeySet: Boolean('stripeRestrictedKey' in input && input.stripeRestrictedKey),
    updatedAt: '2026-08-22T12:30:00.000Z',
  }));
  // A marketplace session makes the stored-rail forms render; the page is the
  // seller's own settings, never a guest surface.
  useCommerceStore.setState({
    marketplaceSession: {
      pubky: 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
      capabilities: '/pub/pubky.app/:rw',
      issuedAt: '2026-08-21T12:00:00.000Z',
      expiresAt: '2026-09-21T12:00:00.000Z',
    },
  });
  useAuthStore.setState({ currentUserPubky: 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco' });
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderSettings() {
  render(<MarketplacePaymentSettings />);
  await screen.findByLabelText('PayPal merchant email');
}

function setPaykitIframeSource(iframe: HTMLIFrameElement): WindowProxy {
  const source = {} as WindowProxy;
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: source });
  return source;
}

describe('MarketplacePaymentSettings', () => {
  it('leads with how-you-get-paid setup copy, not a funds warning', async () => {
    await renderSettings();

    expect(screen.getByRole('heading', { name: 'Payment settings' })).toBeInTheDocument();
    expect(screen.getByText('Manage your payment methods and preferences.')).toBeInTheDocument();
    expect(screen.queryByText(/pays the seller directly/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/never holds funds/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pre-production/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/this prototype/i)).not.toBeInTheDocument();
  });

  it('shows an enabled Bitcoin rail honestly and lets the seller turn it off without reconnecting', async () => {
    mockedController.getMyPaymentConfig.mockResolvedValue({ ...EMPTY_CONFIG, bitcoinEnabled: true });
    await renderSettings();
    const bitcoin = screen.getByRole('switch', { name: 'Accept bitcoin' });
    expect(bitcoin).toBeChecked();
    expect(bitcoin).toBeEnabled();
    await userEvent.click(bitcoin);
    await userEvent.click(screen.getAllByRole('button', { name: 'Save payment settings' })[0]);
    await waitFor(() =>
      expect(mockedController.putMyPaymentConfig).toHaveBeenCalledWith(
        expect.objectContaining({ bitcoinEnabled: false }),
      ),
    );
    expect(bitcoin).not.toBeChecked();
    expect(bitcoin).toBeDisabled();
  });

  it('renders PayPal and Bitcoin and does not show a card rail', async () => {
    await renderSettings();

    const methodsSection = screen.getByRole('region', { name: 'Payment methods' });
    const titles = within(methodsSection)
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual(['PayPal', 'Bitcoin wallet']);
    expect(screen.queryByText(/Stripe/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Stripe payment link')).not.toBeInTheDocument();
  });

  it('derives each status pill from the loaded configuration state', async () => {
    mockedController.getMyPaymentConfig.mockResolvedValue({
      ...EMPTY_CONFIG,
      paypalMerchantEmail: 'seller@example.com',
      // Stripe link without the restricted key cannot verify payments.
      stripePaymentLink: 'https://buy.stripe.com/test_abc',
    });
    mockedController.isOwnPaykitAccountClaimed.mockResolvedValue(true);

    await renderSettings();

    expect(screen.getByTestId('payment-method-status-paypal')).toHaveTextContent('Email saved');
    expect(screen.queryByTestId('payment-method-status-stripe')).not.toBeInTheDocument();
    // Claim without Lock Server authorization is not Connected.
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Needs attention');
    expect(screen.getByRole('button', { name: /Connect Lock Server/ })).toBeInTheDocument();
    expect(screen.queryByTestId('payment-methods-ready-summary')).not.toBeInTheDocument();
  });

  it('shows Bitcoin Connected only when Lock Server authorization and the Paykit claim are both present', async () => {
    view.locksConnect = {
      connectedCreator: 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
      isExchanging: false,
      error: null,
      connectOpen: false,
      connectUrl: null,
    };
    mockedController.getMyPaymentConfig.mockResolvedValue({
      ...EMPTY_CONFIG,
      paypalMerchantEmail: 'seller@example.com',
      stripePaymentLink: 'https://buy.stripe.com/test_abc',
      stripeRestrictedKeySet: true,
    });
    mockedController.isOwnPaykitAccountClaimed.mockResolvedValue(true);

    await renderSettings();

    expect(screen.getByTestId('payment-method-status-paypal')).toHaveTextContent('Email saved');
    expect(screen.queryByTestId('payment-method-status-stripe')).not.toBeInTheDocument();
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Connected');
    expect(screen.queryByTestId('payment-methods-ready-summary')).not.toBeInTheDocument();
  });

  it('shows Not set up on every pill for a new seller', async () => {
    await renderSettings();

    expect(screen.getByTestId('payment-method-status-paypal')).toHaveTextContent('Not set up');
    expect(screen.queryByTestId('payment-method-status-stripe')).not.toBeInTheDocument();
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Not set up');
    expect(screen.queryByTestId('payment-methods-ready-summary')).not.toBeInTheDocument();
  });

  it('needs attention when the Lock Server connect errored', async () => {
    view.locksConnect = {
      connectedCreator: null,
      isExchanging: false,
      error: 'connect rejected',
      connectOpen: false,
      connectUrl: null,
    };

    await renderSettings();

    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Needs attention');
  });

  it('keeps the bitcoin protocol details collapsed until asked', async () => {
    const user = userEvent.setup();
    await renderSettings();

    const detailsToggle = screen.getByRole('button', { name: 'Technical details' });
    expect(detailsToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/shares a watch-only account with Paykit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Lock Server:/)).not.toBeInTheDocument();

    await user.click(detailsToggle);

    expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/shares a watch-only account with Paykit/)).toBeInTheDocument();
    expect(screen.getByText(/Connect Bitkit to finish wallet setup/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Account xpub')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claim with signer' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Locks Server' })).toHaveAttribute('target', '_blank');
  });

  it('keeps enabling Bitcoin disabled until both setup steps are Connected', async () => {
    mockedController.getMyPaymentConfig.mockResolvedValue(EMPTY_CONFIG);
    mockedController.isOwnPaykitAccountClaimed.mockResolvedValue(true);

    await renderSettings();

    const accept = screen.getByRole('switch', { name: 'Accept bitcoin' });
    expect(accept).toBeDisabled();
    expect(accept).not.toBeChecked();
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Needs attention');
  });

  it('saves PayPal for a seller whose stored payment config is null', async () => {
    const user = userEvent.setup();
    mockedController.getMyPaymentConfig.mockResolvedValue(null);

    await renderSettings();
    const save = screen.getAllByRole('button', { name: 'Save changes' })[0];
    await waitFor(() => expect(save).toBeEnabled());

    await user.type(screen.getByLabelText('PayPal merchant email'), 'new-seller@example.com');
    await user.click(save);

    await waitFor(() => expect(mockedController.putMyPaymentConfig).toHaveBeenCalledTimes(1));
    expect(mockedController.putMyPaymentConfig).toHaveBeenLastCalledWith({
      bitcoinEnabled: false,
      paypalMerchantEmail: 'new-seller@example.com',
      stripePaymentLink: null,
    });
  });

  it('keeps stored bitcoin and the Stripe link when an existing config PayPal email changes', async () => {
    const user = userEvent.setup();
    mockedController.getMyPaymentConfig.mockResolvedValue({
      ...EMPTY_CONFIG,
      bitcoinEnabled: true,
      paypalMerchantEmail: 'old@example.com',
      stripePaymentLink: 'https://buy.stripe.com/test_kept',
    });

    await renderSettings();
    const save = screen.getAllByRole('button', { name: 'Save changes' })[0];
    await waitFor(() => expect(save).toBeEnabled());

    const email = screen.getByLabelText('PayPal merchant email');
    await user.clear(email);
    await user.type(email, 'updated@example.com');
    await user.click(save);

    await waitFor(() => expect(mockedController.putMyPaymentConfig).toHaveBeenCalledTimes(1));
    expect(mockedController.putMyPaymentConfig).toHaveBeenLastCalledWith({
      bitcoinEnabled: true,
      paypalMerchantEmail: 'updated@example.com',
      stripePaymentLink: 'https://buy.stripe.com/test_kept',
    });
  });

  it('saves PayPal without writing a card key', async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.type(screen.getByLabelText('PayPal merchant email'), 'seller@example.com');
    expect(screen.getByRole('switch', { name: 'Accept bitcoin' })).toBeDisabled();

    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[0]);

    await waitFor(() => expect(mockedController.putMyPaymentConfig).toHaveBeenCalledTimes(1));
    expect(mockedController.putMyPaymentConfig).toHaveBeenLastCalledWith({
      bitcoinEnabled: false,
      paypalMerchantEmail: 'seller@example.com',
      stripePaymentLink: null,
    });
  });

  it('saves Accept bitcoin only after both bitcoin steps are Connected', async () => {
    const user = userEvent.setup();
    view.locksConnect = {
      connectedCreator: 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
      isExchanging: false,
      error: null,
      connectOpen: false,
      connectUrl: null,
    };
    mockedController.isOwnPaykitAccountClaimed.mockResolvedValue(true);

    await renderSettings();

    const accept = screen.getByRole('switch', { name: 'Accept bitcoin' });
    expect(accept).toBeEnabled();
    await user.click(accept);
    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[1]);

    await waitFor(() => expect(mockedController.putMyPaymentConfig).toHaveBeenCalled());
    expect(mockedController.putMyPaymentConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ bitcoinEnabled: true }),
    );
  });

  it('tells a seller why Step 1 asks for a fresh approval, beside Connect Lock Server', async () => {
    const notice = 'Connected before? Approve once more in Pubky Ring or Bitkit.';
    view.locksConnect = {
      connectedCreator: null,
      isExchanging: false,
      error: null,
      reapproveNotice: notice,
      connectOpen: false,
      connectUrl: null,
    };

    await renderSettings();

    expect(screen.getByTestId('locks-reapprove-notice')).toHaveTextContent(notice);
    expect(screen.getByRole('button', { name: /Connect Lock Server/ })).toBeInTheDocument();
  });

  it('shows a failed Lock Server status check as Needs attention with the reason, never Not set up', async () => {
    view.locksConnect = {
      connectedCreator: null,
      isExchanging: false,
      error: LOCKS_STATUS_CHECK_ERROR,
      connectOpen: false,
      connectUrl: null,
    };

    await renderSettings();

    expect(screen.getByRole('alert')).toHaveTextContent(LOCKS_STATUS_CHECK_ERROR);
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Needs attention');
    expect(screen.getByTestId('payment-method-status-bitcoin')).not.toHaveTextContent('Not set up');
  });

  it('hides the fresh-approval notice once Step 1 is connected', async () => {
    view.locksConnect = {
      connectedCreator: 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
      isExchanging: false,
      error: null,
      reapproveNotice: 'Connected before? Approve once more in Pubky Ring or Bitkit.',
      connectOpen: false,
      connectUrl: null,
    };

    await renderSettings();

    expect(screen.queryByTestId('locks-reapprove-notice')).not.toBeInTheDocument();
  });

  it('preserves server bitcoin when Step 1 names a different Lock Server creator', async () => {
    const user = userEvent.setup();
    view.locksConnect = {
      connectedCreator: 'ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u',
      isExchanging: false,
      error: null,
      connectOpen: false,
      connectUrl: null,
    };
    mockedController.getMyPaymentConfig.mockResolvedValue({ ...EMPTY_CONFIG, bitcoinEnabled: true });
    mockedController.isOwnPaykitAccountClaimed.mockResolvedValue(true);

    await renderSettings();

    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Needs attention');
    expect(screen.getByRole('switch', { name: 'Accept bitcoin' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Accept bitcoin' })).toBeChecked();
    expect(screen.queryByText(/Creator authority connected/)).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[1]);

    await waitFor(() => expect(mockedController.putMyPaymentConfig).toHaveBeenCalled());
    expect(mockedController.putMyPaymentConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ bitcoinEnabled: true }),
    );
  });

  it('renders the Lock Server connect dialog instead of a raw error page', async () => {
    view.locksConnect = {
      connectedCreator: null,
      isExchanging: false,
      error: 'This Lock Server connection did not finish. Approve it again from this page.',
      connectOpen: true,
      connectUrl: 'https://locks.example.com/connect?delivery=postmessage&state=abc',
    };

    await renderSettings();

    expect(screen.getByTitle('Connect Lock Server')).toBeInTheDocument();
    expect(screen.getByTitle('Connect Lock Server')).toHaveAttribute(
      'src',
      'https://locks.example.com/connect?delivery=postmessage&state=abc',
    );
    expect(
      screen.getAllByRole('alert').some((el) => el.textContent?.includes('Approve it again from this page.')),
    ).toBe(true);
    expect(screen.queryByText(/creator_connect_flow_unavailable/)).not.toBeInTheDocument();
  });

  // The pages inside the payout setup iframes hand off to pubkyring:// and pubkyauth:// links;
  // without these sandbox tokens a tap on Android Chrome does nothing.
  const HANDOFF_SANDBOX_TOKENS = ['allow-popups', 'allow-top-navigation-to-custom-protocols'];

  it('lets the Lock Server connect iframe open Pubky Ring', async () => {
    view.locksConnect = {
      connectedCreator: null,
      isExchanging: false,
      error: null,
      connectOpen: true,
      connectUrl: 'https://locks.example.com/connect?delivery=postmessage&state=abc',
    };

    await renderSettings();

    const sandbox = screen.getByTitle('Connect Lock Server').getAttribute('sandbox')?.split(' ') ?? [];
    expect(sandbox).toEqual(expect.arrayContaining(HANDOFF_SANDBOX_TOKENS));
  });

  it('lets the Bitkit setup iframe open Bitkit', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Connect Bitkit/ }));

    const sandbox = screen.getByTitle('Connect Bitkit').getAttribute('sandbox')?.split(' ') ?? [];
    expect(sandbox).toEqual(expect.arrayContaining(HANDOFF_SANDBOX_TOKENS));
  });

  it('does not offer a card rail to a seller who already saved one', async () => {
    mockedController.getMyPaymentConfig.mockResolvedValue({
      ...EMPTY_CONFIG,
      stripePaymentLink: 'https://buy.stripe.com/test_kept',
      stripeRestrictedKeySet: true,
    });

    await renderSettings();

    expect(screen.queryByText('Card via Stripe')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Stripe payment link')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Stripe restricted key')).not.toBeInTheDocument();
    expect(screen.queryByText(/Stripe/)).not.toBeInTheDocument();
  });

  it('explains the Bitkit connection and preserves the mobile handoff', async () => {
    await renderSettings();

    const helper = 'Approve payment setup in Bitkit to receive bitcoin.';
    expect(screen.getByText(helper)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connect Bitkit/ }));
    expect(screen.getAllByText(helper)).toHaveLength(1);
    expect(
      screen.getByText('Scan the code with Bitkit, or open this page on your phone and tap Open in Bitkit.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Bitkit 2\.5 or newer is required/)).not.toBeInTheDocument();
    const iframe = screen.getByTitle('Connect Bitkit');
    const dialog = iframe.closest('[data-testid="dialog-content"]');
    expect(dialog?.className).toMatch(/overflow-y-auto/);
    expect(dialog?.className).not.toMatch(/overflow-hidden/);
    expect(iframe.className).not.toMatch(/overflow-y-auto|overflow-auto|h-\[min\(22rem/);
    expect(iframe).toHaveAttribute('scrolling', 'no');
  });

  it('validates the Bitkit setup callback', async () => {
    render(<MarketplacePaymentSettings />);
    expect(screen.getByRole('heading', { name: 'PayPal' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connect Bitkit/ }));

    expect(mockedController.getPaykitSetupUrl).toHaveBeenCalledTimes(1);
    const iframe = screen.getByTitle('Connect Bitkit') as HTMLIFrameElement;
    const setupUrl = new URL(iframe.getAttribute('src')!);
    const productionSetupUrl = String(mockedController.getPaykitSetupUrl.mock.results[0]?.value);
    expect(setupUrl.origin).toBe('https://paykit.example');
    expect(iframe.getAttribute('src')).toBe(`${productionSetupUrl}#embed`);
    expect(setupUrl.search).toBe(new URL(productionSetupUrl).search);
    expect(setupUrl.hash).toBe('#embed');
    expect(setupUrl.searchParams.has('embed')).toBe(false);
    const state = String(setupUrl.searchParams.get('state'));
    expect(setupUrl.searchParams.get('creator')).toBe('gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco');
    expect(state).toHaveLength(22);
    const source = setPaykitIframeSource(iframe);
    mockedController.isOwnPaykitAccountClaimed.mockResolvedValueOnce(true);

    const message = new MessageEvent('message', {
      origin: 'https://paykit.example',
      source,
      data: { type: 'paykit-setup-callback', state },
    });
    act(() => window.dispatchEvent(message));

    await waitFor(() => expect(screen.queryByTitle('Connect Bitkit')).not.toBeInTheDocument());
    expect(mockedToast).toHaveBeenCalledWith({ title: 'Bitkit setup connected' });
    await waitFor(() => expect(mockedController.getMyPaymentConfig).toHaveBeenCalledTimes(2));
  });

  it('unlocks Accept bitcoin as soon as Step 2 reports Connected', async () => {
    view.locksConnect = {
      connectedCreator: 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
      isExchanging: false,
      error: null,
      connectOpen: false,
      connectUrl: null,
    };
    let releaseStaleClaim: (claimed: boolean) => void = () => {};
    mockedController.isOwnPaykitAccountClaimed.mockReset();
    mockedController.isOwnPaykitAccountClaimed
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseStaleClaim = resolve;
          }),
      )
      .mockResolvedValue(true);

    await renderSettings();
    expect(screen.getByRole('switch', { name: 'Accept bitcoin' })).toBeDisabled();
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Needs attention');

    await act(async () => {
      useCommerceStore.setState({
        marketplaceSession: {
          pubky: 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
          capabilities: '/pub/pubky.app/:rw',
          issuedAt: '2026-08-21T12:00:00.000Z',
          expiresAt: '2026-09-21T12:00:00.000Z',
        },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /Connect Bitkit/ }));
    const iframe = screen.getByTitle('Connect Bitkit') as HTMLIFrameElement;
    const source = setPaykitIframeSource(iframe);
    const state = new URL(iframe.src).searchParams.get('state');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://paykit.example',
          source,
          data: { type: 'paykit-setup-callback', state },
        }),
      );
    });

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Accept bitcoin' })).toBeEnabled());
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Connected');
    expect(mockedToast).toHaveBeenCalledWith({ title: 'Bitkit setup connected' });

    await act(async () => {
      releaseStaleClaim(false);
    });
    expect(screen.getByRole('switch', { name: 'Accept bitcoin' })).toBeEnabled();
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Connected');
  });

  it('shows the timeout state and retries with a fresh setup state', async () => {
    await renderSettings();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /Connect Bitkit/ }));
    const firstState = new URL((screen.getByTitle('Connect Bitkit') as HTMLIFrameElement).src).searchParams.get(
      'state',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 1_000);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('No approval received.');
    expect(screen.queryByTitle('Connect Bitkit')).not.toBeInTheDocument();
    expect(screen.getByTestId('paykit-setup-qr-expired')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const secondState = new URL((screen.getByTitle('Connect Bitkit') as HTMLIFrameElement).src).searchParams.get(
      'state',
    );
    expect(secondState).not.toBe(firstState);
    vi.useRealTimers();
  });

  it('keeps the dialog open and shows an identity mismatch when verification is not claimed', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Connect Bitkit/ }));
    const iframe = screen.getByTitle('Connect Bitkit') as HTMLIFrameElement;
    const source = setPaykitIframeSource(iframe);
    const state = new URL(iframe.src).searchParams.get('state');
    mockedController.isOwnPaykitAccountClaimed.mockResolvedValueOnce(false);

    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://paykit.example',
          source,
          data: { type: 'paykit-setup-callback', state },
        }),
      ),
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          'Bitkit approved a different account. In Bitkit, sign in with the same Pubky identity you use here, then try again.',
        ),
      ).toBeInTheDocument(),
    );
    expect(mockedToast).not.toHaveBeenCalled();
    expect(screen.getByTitle('Connect Bitkit')).toBeInTheDocument();
  });

  it('maps identity mismatch separately from other setup errors', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Connect Bitkit/ }));
    const iframe = screen.getByTitle('Connect Bitkit') as HTMLIFrameElement;
    const source = setPaykitIframeSource(iframe);
    const state = new URL(iframe.src).searchParams.get('state');

    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://paykit.example',
          source,
          data: { type: 'paykit-setup-callback', state, error: 'identity-mismatch' },
        }),
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Bitkit approved a different account');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const secondIframe = screen.getByTitle('Connect Bitkit') as HTMLIFrameElement;
    const secondSource = setPaykitIframeSource(secondIframe);
    const secondState = new URL(secondIframe.src).searchParams.get('state');
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://paykit.example',
          source: secondSource,
          data: { type: 'paykit-setup-callback', state: secondState, error: 'setup-failed' },
        }),
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Bitkit setup failed. Try again.');
  });

  it('closes the setup dialog when the viewer identity is cleared', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Connect Bitkit/ }));
    const iframe = screen.getByTitle('Connect Bitkit') as HTMLIFrameElement;
    const source = setPaykitIframeSource(iframe);
    const state = new URL(iframe.src).searchParams.get('state');

    act(() => useAuthStore.setState({ currentUserPubky: null }));
    expect(screen.queryByTitle('Connect Bitkit')).not.toBeInTheDocument();

    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://paykit.example',
          source,
          data: { type: 'paykit-setup-callback', state },
        }),
      ),
    );
    expect(mockedToast).not.toHaveBeenCalled();
  });

  it('ignores callbacks that fail any message guard', async () => {
    const user = userEvent.setup();
    await renderSettings();
    await user.click(screen.getByRole('button', { name: /Connect Bitkit/ }));
    const iframe = screen.getByTitle('Connect Bitkit') as HTMLIFrameElement;
    const source = setPaykitIframeSource(iframe);
    const state = new URL(iframe.src).searchParams.get('state');
    const messages = [
      { origin: 'https://wrong.example', source, data: { type: 'paykit-setup-callback', state } },
      { origin: 'https://paykit.example', source: window, data: { type: 'paykit-setup-callback', state } },
      { origin: 'https://paykit.example', source, data: { type: 'other', state } },
      {
        origin: 'https://paykit.example',
        source,
        data: { type: 'paykit-setup-callback', state: 'wrong' },
      },
    ];
    act(() => {
      messages.forEach((message) => window.dispatchEvent(new MessageEvent('message', message)));
    });

    expect(screen.getByTitle('Connect Bitkit')).toBeInTheDocument();
    expect(mockedController.getMyPaymentConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Bitkit setup connected')).not.toBeInTheDocument();
  });

  it('shows failure and retries with a new setup state', async () => {
    const user = userEvent.setup();
    await renderSettings();
    await user.click(screen.getByRole('button', { name: /Connect Bitkit/ }));
    const firstIframe = screen.getByTitle('Connect Bitkit') as HTMLIFrameElement;
    const firstState = String(new URL(firstIframe.src).searchParams.get('state'));
    const source = setPaykitIframeSource(firstIframe);
    const message = new MessageEvent('message', {
      origin: 'https://paykit.example',
      source,
      data: { type: 'paykit-setup-callback', state: firstState, error: 'setup-failed' },
    });
    act(() => window.dispatchEvent(message));

    expect(screen.getByRole('alert')).toHaveTextContent('Bitkit setup failed. Try again.');
    expect(screen.queryByTitle('Connect Bitkit')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    const secondIframe = screen.getByTitle('Connect Bitkit') as HTMLIFrameElement;
    expect(new URL(secondIframe.src).searchParams.get('state')).not.toBe(firstState);
  });

  it('removes the expired Step 2 QR so nothing is left to scan', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Connect Bitkit/ }));
    const iframe = screen.getByTitle('Connect Bitkit') as HTMLIFrameElement;
    const source = setPaykitIframeSource(iframe);
    const state = new URL(iframe.src).searchParams.get('state');

    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://paykit.example',
          source,
          data: { type: 'paykit-setup-callback', state, error: 'setup-failed' },
        }),
      ),
    );

    const dialog = screen.getByTestId('dialog-content');
    expect(screen.getByRole('alert')).toHaveTextContent('Bitkit setup failed. Try again.');
    expect(within(dialog).queryByTitle('Connect Bitkit')).not.toBeInTheDocument();
    expect(dialog.querySelector('iframe, img, canvas')).toBeNull();
    const placeholder = screen.getByTestId('paykit-setup-qr-expired');
    expect(placeholder).toHaveTextContent('This code expired.');
    expect(placeholder.querySelector('iframe, img, canvas')).toBeNull();
  });

  it('removes the callback listener when the settings surface unmounts', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const user = userEvent.setup();
    const { unmount } = render(<MarketplacePaymentSettings />);
    await screen.findByRole('heading', { name: 'PayPal' });
    await user.click(screen.getByRole('button', { name: /Connect Bitkit/ }));
    unmount();
    expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('keeps Save unavailable until the server payment config has loaded', async () => {
    mockedController.getMyPaymentConfig.mockReturnValue(new Promise(() => {}));
    render(<MarketplacePaymentSettings />);

    expect(await screen.findAllByText('Loading payment settings…')).toHaveLength(2);
    expect(document.querySelector('[data-surface="marketplace-get-paid"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('preserves server bitcoin when Accept bitcoin was not toggled', async () => {
    const user = userEvent.setup();
    mockedController.getMyPaymentConfig.mockResolvedValue({
      ...EMPTY_CONFIG,
      bitcoinEnabled: true,
      paypalMerchantEmail: 'kept@example.com',
      stripePaymentLink: 'https://buy.stripe.com/test_kept',
    });

    await renderSettings();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Save changes' })[1]).toBeEnabled());

    const accept = screen.getByRole('switch', { name: 'Accept bitcoin' });
    expect(accept).toBeEnabled();
    expect(accept).toBeChecked();

    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[1]);

    await waitFor(() => expect(mockedController.putMyPaymentConfig).toHaveBeenCalledTimes(1));
    expect(mockedController.putMyPaymentConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bitcoinEnabled: true,
        paypalMerchantEmail: 'kept@example.com',
        stripePaymentLink: 'https://buy.stripe.com/test_kept',
      }),
    );
  });

  it('saves an explicit Accept bitcoin off after the seller toggles it', async () => {
    const user = userEvent.setup();
    view.locksConnect = {
      connectedCreator: 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
      isExchanging: false,
      error: null,
      connectOpen: false,
      connectUrl: null,
    };
    mockedController.getMyPaymentConfig.mockResolvedValue({ ...EMPTY_CONFIG, bitcoinEnabled: true });
    mockedController.isOwnPaykitAccountClaimed.mockResolvedValue(true);

    await renderSettings();

    const accept = screen.getByRole('switch', { name: 'Accept bitcoin' });
    await waitFor(() => expect(accept).toBeEnabled());
    expect(accept).toBeChecked();
    await user.click(accept);
    expect(accept).not.toBeChecked();
    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[1]);

    await waitFor(() => expect(mockedController.putMyPaymentConfig).toHaveBeenCalled());
    expect(mockedController.putMyPaymentConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ bitcoinEnabled: false }),
    );
  });

  it('does not clear an untouched Stripe link when PayPal is saved', async () => {
    const user = userEvent.setup();
    mockedController.getMyPaymentConfig.mockResolvedValue({
      ...EMPTY_CONFIG,
      stripePaymentLink: 'https://buy.stripe.com/test_keep',
    });

    await renderSettings();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Save changes' })[0]).toBeEnabled());
    expect(screen.queryByLabelText('Stripe payment link')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('PayPal merchant email'), 'seller@example.com');
    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[0]);

    await waitFor(() => expect(mockedController.putMyPaymentConfig).toHaveBeenCalledTimes(1));
    expect(mockedController.putMyPaymentConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paypalMerchantEmail: 'seller@example.com',
        stripePaymentLink: 'https://buy.stripe.com/test_keep',
        bitcoinEnabled: false,
      }),
    );
  });

  it('does not offer Claim with signer', async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.click(screen.getByRole('button', { name: 'Technical details' }));

    expect(screen.queryByRole('button', { name: 'Claim with signer' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Account xpub')).not.toBeInTheDocument();
    expect(screen.getByText(/Connect Bitkit to finish wallet setup/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect Bitkit/ })).toBeInTheDocument();
  });

  it('keeps a back link to the listing composer before setup', async () => {
    navigation.searchParams = new URLSearchParams('returnTo=/marketplace/sell');
    await renderSettings();

    expect(screen.getByRole('link', { name: /Back to listing/ })).toHaveAttribute('href', '/marketplace/sell');
    expect(screen.getByTestId('listing-composer-return')).toHaveTextContent('Back to listing');
  });

  it('returns to the listing composer after a payment method is saved', async () => {
    navigation.searchParams = new URLSearchParams('returnTo=/marketplace/sell');
    const user = userEvent.setup();
    await renderSettings();

    await user.type(screen.getByLabelText('PayPal merchant email'), 'seller@example.com');
    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[0]);

    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith('/marketplace/sell');
    });
    expect(sessionStorage.getItem('pubky.marketplace.listingComposerReturnTo')).toBeNull();
  });

  it('leaves sign-out to account settings while social link-out is off', async () => {
    await renderSettings();

    expect(screen.queryByTestId('marketplace-sign-out-card')).not.toBeInTheDocument();
  });

  it('offers Shop sign-out while social link-out is on', async () => {
    setSocialHost('https://pubky.app');
    try {
      await renderSettings();

      const card = screen.getByTestId('marketplace-sign-out-card');
      expect(within(card).getByRole('button', { name: 'Sign out' })).toBeEnabled();
    } finally {
      setSocialHost(undefined);
    }
  });

  it('lets a buyer sign out without a marketplace purchase session or seller payment setup', () => {
    setSocialHost('https://pubky.app');
    useCommerceStore.setState({ marketplaceSession: null });
    try {
      render(<MarketplacePaymentSettings />);
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
    } finally {
      setSocialHost(undefined);
    }
  });
});
