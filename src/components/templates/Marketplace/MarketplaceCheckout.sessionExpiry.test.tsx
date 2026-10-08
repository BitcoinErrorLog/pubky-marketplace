import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceApplication } from '@/application/commerce/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { MARKETPLACE_SESSION_STORAGE_KEY, MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { MARKETPLACE_SESSION_GRANT } from '@/services/marketplace/marketplace-session-grant';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { setHeavySuiteBudgets } from '@/test-utils/load-budget';
import { MarketplaceCheckout } from './MarketplaceCheckout';

setHeavySuiteBudgets();

const BUYER = 'b'.repeat(52);
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
/** Must match `SESSION_TOKEN_PATTERN` (43 URL-safe chars) or restore returns null. */
const SESSION_TOKEN = 'A'.repeat(43);

/** Captured 2026-09-06 from MarketplaceTransactionService.throwIfSessionRejected. */
const SESSION_EXPIRED_MESSAGE =
  'The marketplace session expired. Approve the marketplace connection on your signer and try again.';

const listing = {
  id: `${BUYER}:boots`,
  listing_id: 'boots',
  record: {
    ownerPubky: BUYER,
    listingId: 'boots',
    title: 'Vintage boots',
    media: [],
    variants: [{ id: 'variant_42', options: { size: '42' }, quantity: 3 }],
    sale: { format: 'fixed_price', unitPrice: { amountMinor: 1200, currency: 'USD', exponent: 2 } },
    fulfillmentMethods: ['physical'],
  },
};

const view = vi.hoisted(() => ({
  items: [] as unknown[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/marketplace/checkout',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => 'transaction-service' };
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

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: [],
    isLoading: false,
    error: null,
    needsSession: false,
    adapterMode: 'transaction-service',
    refresh: vi.fn(),
    advancePayment: vi.fn(),
    actOnOrder: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({ offers: [], isLoading: false, refresh: vi.fn(async () => {}) }),
}));

vi.mock('@/hooks/useMarketplaceOfferCheckout/useMarketplaceOfferCheckout', () => ({
  useMarketplaceOfferCheckout: () => ({ submit: vi.fn(), isSubmitting: false }),
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 0,
}));

vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 0,
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/organisms/Marketplace/MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: ({ triggerLabel }: { triggerLabel?: string }) => (
    <button type="button">{triggerLabel ?? 'Approve in Pubky Ring'}</button>
  ),
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

describe('MarketplaceCheckout session expiry (real checkout hook)', () => {
  beforeEach(() => {
    view.items = [
      {
        id: `${listing.id}:variant_42`,
        listingId: listing.id,
        variantId: 'variant_42',
        quantity: 1,
        listing,
      },
    ];
    MarketplaceSessionService.clearSession();
    useCommerceStore.getState().reset();
    useAuthStore.setState({ currentUserPubky: BUYER });
    window.localStorage.setItem(
      MARKETPLACE_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: SESSION_TOKEN,
        pubky: BUYER,
        capabilities: MARKETPLACE_SESSION_GRANT,
        expiresAt: EXPIRES_AT,
      }),
    );
    const restored = MarketplaceSessionService.restorePersistedSession(BUYER);
    useCommerceStore.getState().setMarketplaceSession(restored);
    CommerceController.bindMarketplaceSessionStore();
    vi.spyOn(CommerceApplication, 'getDeliveryAddresses').mockResolvedValue([]);
    vi.spyOn(CommerceApplication, 'fetchPickupAvailable').mockResolvedValue(true);
    vi.spyOn(CommerceApplication, 'getSellerPaymentConfig').mockResolvedValue({
      bitcoinAvailable: true,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    });
    vi.spyOn(CommerceApplication, 'fetchBuyerPaykitWallet').mockResolvedValue('payable');
    vi.spyOn(CommerceApplication, 'getMarketplaceListingProjection').mockResolvedValue({
      aggregateId: `listing:${BUYER}_boots`,
      sellerPubky: BUYER,
      listingId: 'boots',
      listingRevision: 1,
      contentHash: 'c'.repeat(64),
      serverRevision: 1,
      state: 'available',
      availableQuantity: 1,
      reservedQuantity: 0,
      unitPrice: { amountMinor: 1200, currency: 'USD', exponent: 2 },
      saleFormat: 'fixed_price',
      fulfillmentMethods: ['shipping'],
      auction: null,
    });
    vi.spyOn(CommerceApplication, 'executeMarketplaceCommand').mockImplementation(async () => {
      MarketplaceSessionService.clearSession();
      throw Err.auth(AuthErrorCode.SESSION_EXPIRED, SESSION_EXPIRED_MESSAGE, {
        service: ErrorService.Marketplace,
        operation: 'execute',
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    CommerceController.unbindMarketplaceSessionStore();
    MarketplaceSessionService.clearSession();
    useCommerceStore.getState().reset();
  });

  it('reopens Ring approval and nulls the store when executeMarketplaceCommand returns SESSION_EXPIRED', async () => {
    const user = userEvent.setup();
    render(<MarketplaceCheckout />);

    expect(screen.getByText(/Purchases approved in Pubky Ring/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Recipient'), 'Alice Buyer');
    await user.type(screen.getByLabelText('Address line 1'), '1 Market Street');
    await user.type(screen.getByLabelText('City'), 'New York');
    await user.type(screen.getByLabelText('State'), 'NY');
    await user.type(screen.getByLabelText('ZIP code'), '10001');
    await user.click(screen.getByRole('checkbox', { name: /I accept guarantee policy v1/ }));

    const pay = screen.getByTestId('marketplace-checkout-pay');
    await waitFor(() => expect(pay).toBeEnabled());
    await user.click(pay);

    expect(await screen.findByRole('heading', { name: 'Approve purchases in Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-checkout-pay')).toBeDisabled();
    await waitFor(() => {
      expect(useCommerceStore.getState().marketplaceSession).toBeNull();
    });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });
});
