import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { parseContractFaithfulOffer } from '@/test/fixtures/commerce/offer-award';
import { MarketplaceCart } from './MarketplaceCart';

const view = vi.hoisted(() => ({
  items: [] as unknown[],
  offers: [] as unknown[],
  isLoading: false,
}));

const cartActions = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/cart',
}));

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
        ordinaryItems: items.filter((item) => item.pricingSource !== 'offer'),
        awardItems: items.filter((item) => item.pricingSource === 'offer'),
        itemCount: items.reduce((total, item) => total + item.quantity, 0),
        subtotals: sumMoneyByAsset(
          items
            .filter((item) => item.pricingSource !== 'offer')
            .flatMap((item) => {
              const variant = item.listing.record.variants.find(({ id }) => id === item.variantId);
              const price =
                variant?.priceOverride ??
                (item.listing.record.sale.format === 'fixed_price' ? item.listing.record.sale.unitPrice : null);
              return price ? [{ money: price, quantity: item.quantity }] : [];
            }),
        ),
        isLoading: view.isLoading,
        add: vi.fn(),
        update: cartActions.update,
        remove: cartActions.remove,
        clear: vi.fn(),
        groups: actual.groupMarketplaceCartItems(items.filter((item) => item.pricingSource !== 'offer') as never),
      };
    },
  };
});

vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({ offers: view.offers, isLoading: false, error: null, needsSession: false }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary', () => ({
  useMarketplaceSellerSummary: (sellerPubky: string, options?: { includeReputation?: boolean }) => ({
    shop: null,
    reputation: options?.includeReputation === false ? { status: 'unavailable' } : { status: 'new_seller' },
    displayName: sellerPubky === listing.record.ownerPubky ? 'Satoshi Vintage' : 'Film Camera Supply',
  }),
}));

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

describe('MarketplaceCart', () => {
  beforeEach(() => {
    cartActions.update.mockReset();
    cartActions.remove.mockReset();
    view.items = [];
    view.offers = [];
    view.isLoading = false;
  });

  it('links Checkout to the checkout screen without placing an order', () => {
    seededCart();
    render(<MarketplaceCart />);

    const checkout = screen.getByTestId('marketplace-cart-checkout');
    expect(checkout).toHaveAttribute('href', MARKETPLACE_ROUTES.CHECKOUT);
    expect(checkout).toHaveTextContent('Checkout');
    expect(screen.queryByRole('button', { name: /Place order/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Recipient')).not.toBeInTheDocument();
  });

  it('renders a two-column loading skeleton', () => {
    view.isLoading = true;
    view.items = [];

    render(<MarketplaceCart />);

    const skeleton = screen.getByTestId('marketplace-cart-skeleton');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton.className).toContain('lg:grid-cols-[1fr_420px]');
    expect(within(skeleton).getAllByRole('generic').length).toBeGreaterThan(1);
    expect(document.querySelector('[data-surface="marketplace-cart"]')).toContainElement(skeleton);
  });

  it('marks the empty cart surface', () => {
    render(<MarketplaceCart />);

    expect(document.querySelector('[data-surface="marketplace-cart"]')).toHaveTextContent('Your cart is empty');
  });

  it('groups multi-seller cart items by seller with per-asset subtotals', () => {
    seededCart();
    view.items = [
      ...(view.items as unknown[]),
      {
        id: 'other:camera:variant_01',
        listingId: secondSellerListing.id,
        variantId: 'variant_01',
        quantity: 2,
        listing: secondSellerListing,
      },
    ];

    render(<MarketplaceCart />);

    expect(screen.getByText('Each seller ships separately; shipping is calculated at checkout.')).toBeInTheDocument();
    expect(screen.getByText('Satoshi Vintage')).toBeInTheDocument();
    expect(screen.getByText('Film Camera Supply')).toBeInTheDocument();
    expect(screen.getAllByText('Seller subtotal')).toHaveLength(2);
    expect(screen.getAllByText('$12.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/₿/).length).toBeGreaterThan(0);
  });

  it('does not render a seller header for a single-seller cart', () => {
    seededCart();

    render(<MarketplaceCart />);

    expect(screen.getByText('Each seller ships separately; shipping is calculated at checkout.')).toBeInTheDocument();
    expect(screen.queryByText('Satoshi Vintage')).not.toBeInTheDocument();
    expect(screen.queryByText('Seller subtotal')).not.toBeInTheDocument();
    expect(screen.getByText('Vintage boots')).toBeInTheDocument();
  });

  it('keeps remove and quantity actions scoped to the cart line', async () => {
    const user = userEvent.setup();
    seededCart();

    render(<MarketplaceCart />);

    await user.click(screen.getByRole('button', { name: 'Increase Vintage boots quantity' }));
    expect(cartActions.update).toHaveBeenCalledWith(listing.id, 'variant_42', 2);

    const ordinaryGroup = screen.getByRole('region', { name: `Cart items from ${listing.record.ownerPubky}` });
    await user.click(within(ordinaryGroup).getByRole('button', { name: 'Remove Vintage boots' }));
    expect(cartActions.remove).toHaveBeenCalledWith(listing.id, 'variant_42');
  });

  it('renders award lines in their own group with a Checkout link', () => {
    seededCart();
    const offer = parseContractFaithfulOffer('accepted', 'active');
    view.items = [
      ...(view.items as unknown[]),
      {
        id: 'seller:boots:award-1',
        listingId: listing.id,
        variantId: 'variant_42',
        quantity: 1,
        awardId: offer.award?.id,
        pricingSource: 'offer',
        listing,
      },
    ];
    view.offers = [offer];

    render(<MarketplaceCart />);

    const awardGroup = screen.getByRole('region', { name: 'Accepted offer checkout' });
    expect(awardGroup).toHaveAttribute('data-surface', 'marketplace-award-cart-group');
    expect(within(awardGroup).getByText('Accepted offer')).toBeInTheDocument();
    expect(within(awardGroup).getByText('Quantity and variant are fixed at the accepted offer.')).toBeInTheDocument();
    expect(within(awardGroup).getByText('$1.00 × 1 + $1.00 shipping = $2.00')).toBeInTheDocument();
    expect(within(awardGroup).getByText(/Buy by/)).toBeInTheDocument();
    expect(within(awardGroup).getByRole('link', { name: 'Checkout' })).toHaveAttribute(
      'href',
      `${MARKETPLACE_ROUTES.CHECKOUT}?offer=${offer.award?.id}`,
    );
    expect(within(awardGroup).queryByRole('button', { name: /Increase|Decrease/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('marketplace-cart-checkout')).toBeInTheDocument();
    expect(screen.getAllByText('$12.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('$24.00')).not.toBeInTheDocument();
  });

  it('removes award and ordinary rows by their distinct identities', async () => {
    const user = userEvent.setup();
    seededCart();
    view.items = [
      ...(view.items as unknown[]),
      {
        id: 'seller:boots:award-1',
        listingId: listing.id,
        variantId: 'variant_42',
        quantity: 1,
        awardId: 'award-1',
        pricingSource: 'offer',
        listing,
      },
    ];

    render(<MarketplaceCart />);

    const awardGroup = screen.getByRole('region', { name: 'Accepted offer checkout' });
    await user.click(within(awardGroup).getByRole('button', { name: 'Remove Vintage boots' }));
    expect(cartActions.remove).toHaveBeenCalledWith(listing.id, 'variant_42', 'award-1');

    const ordinaryGroup = screen.getByRole('region', { name: `Cart items from ${listing.record.ownerPubky}` });
    await user.click(within(ordinaryGroup).getByRole('button', { name: 'Remove Vintage boots' }));
    expect(cartActions.remove).toHaveBeenCalledWith(listing.id, 'variant_42');
  });
});
