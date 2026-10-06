import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommerceSellerReputationOverview } from '@/application/commerce/commerce';
import { CAPABILITIES } from '@/config/app';
import { COMMERCE_LISTING_MAX_QUANTITY } from '@/config/commerce';
import { CHECKOUT_HOLD_COPY } from '@/libs/commerce/checkout-hold';
import { getMarketplaceOfferCheckoutRoute } from '@/libs/commerce/checkout-phase';
import type { MarketplaceOffer } from '@/services/marketplace/marketplace';
import {
  COMMERCE_FIXTURE_SELLER,
  createCommerceListingFixture,
  createCommerceShopFixture,
} from '@/test/fixtures/commerce/commerce';
import { toCommerceListingModel, toCommerceShopModel } from '@/test/fixtures/commerce/listing-models';
import { parseContractFaithfulOffer } from '@/test/fixtures/commerce/offer-award';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { createListingProjectionFixture } from '@/test/fixtures/commerce/projections';
import { MarketplaceListing } from './MarketplaceListing';

const LOCKS_POLICY_URL = `pubky://${COMMERCE_FIXTURE_SELLER}/pub/locks.app/boots_01.json`;
const cartAdd = vi.hoisted(() => vi.fn());
const projectionRefresh = vi.hoisted(() => vi.fn());
const confirmRemovedCalls = vi.hoisted(() => vi.fn());
const sellerReputation = vi.hoisted((): { value: CommerceSellerReputationOverview | { status: 'loading' } } => ({
  value: { status: 'new_seller' as const },
}));
const authState = vi.hoisted(() => ({
  currentUserPubky: 'b'.repeat(52) as string | null,
  setShowSignInDialog: vi.fn(),
}));
const sessionState = vi.hoisted(() => ({
  pubky: null as string | null,
}));

const view = vi.hoisted(() => ({
  listing: null as ReturnType<typeof toCommerceListingModel> | null,
  shop: null as ReturnType<typeof toCommerceShopModel> | null,
  projection: null as ReturnType<typeof createListingProjectionFixture> | null,
  projectionError: null as string | null,
  listingRemoved: false,
  fetchFailure: null as unknown,
  confirmedRemoved: false as boolean | Error,
  needsSession: false,
  hasFullHomeserverGrant: false,
  orders: [] as Array<{ order: ReturnType<typeof createOrderFixture> }>,
  offers: [] as MarketplaceOffer[],
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({ useMarketplaceCartCount: () => 0 }));
vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 0,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/marketplace/listing/seller/item',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => 'transaction-service' };
});

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => unknown) => querier(),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getListing: () => view.listing,
    getShop: () => view.shop,
    getOrFetchListing: () => (view.fetchFailure === null ? Promise.resolve(null) : Promise.reject(view.fetchFailure)),
    isListingConfirmedRemoved: (_seller: string, _listing: string, fetchError: unknown) => {
      confirmRemovedCalls(fetchError);
      return view.confirmedRemoved instanceof Error
        ? Promise.reject(view.confirmedRemoved)
        : Promise.resolve(view.confirmedRemoved);
    },
    hasFullHomeserverGrant: () => view.hasFullHomeserverGrant,
  },
}));

vi.mock('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect', () => ({
  useMarketplaceSessionConnect: () => ({
    status: 'awaiting',
    authorizationUrl: '',
    errorMessage: null,
    // Mirrors the hook's single decision: full grant iff the homeserver
    // grant is narrow (the flag defaults on under tests).
    requestsFullGrant: !view.hasFullHomeserverGrant,
    requestsGrantReconnect: false,
    start: vi.fn(),
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: false,
  }),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: Object.assign((selector: (state: typeof authState) => unknown) => selector(authState), {
    getState: () => authState,
  }),
}));

vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: false, isMutating: false, toggle: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', () => ({
  useMarketplaceCart: () => ({
    items: [],
    itemCount: 0,
    subtotals: [],
    isLoading: false,
    add: cartAdd,
    update: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  }),
}));

vi.mock('@/services/marketplace/marketplace-session', () => ({
  MarketplaceSessionService: {
    getActiveSession: () => (sessionState.pubky ? { pubky: sessionState.pubky } : null),
  },
}));

vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({
    offers: view.offers,
    isLoading: false,
    error: null,
    needsSession: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: view.orders,
    isLoading: false,
    error: null,
    needsSession: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceProjection/useMarketplaceProjection', () => ({
  useMarketplaceProjection: () => ({
    projection: view.projection,
    isLoading: false,
    error: view.projectionError,
    listingRemoved: view.listingRemoved,
    needsSession: view.needsSession,
    refresh: projectionRefresh,
  }),
}));

vi.mock('@/hooks/useMarketplaceReviews/useMarketplaceReviews', () => ({
  useSellerReputation: () => sellerReputation.value,
}));

vi.mock('@/hooks/useMeasurementSystem/useMeasurementSystem', () => ({
  useMeasurementSystem: () => 'metric',
}));

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  return await import('@/test/mocks/marketplace-media-hooks');
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/organisms/Marketplace/MarketplaceCommunityTags', () => ({
  MarketplaceCommunityTags: () => null,
}));

vi.mock('@/organisms/Marketplace/MarketplaceListingSavePicker', () => ({
  MarketplaceListingSavePicker: () => null,
}));

vi.mock('@/organisms/Marketplace/MarketplaceMessageDialog', () => ({
  MarketplaceMessageDialog: () => <button type="button">Message seller</button>,
}));

vi.mock('@/organisms/Marketplace/MarketplaceReviewsSection', () => ({
  MarketplaceReviewsSection: () => <section aria-label="Reviews" />,
}));

describe('MarketplaceListing', () => {
  beforeEach(() => {
    view.listing = toCommerceListingModel(createCommerceListingFixture());
    view.shop = toCommerceShopModel(createCommerceShopFixture());
    view.projection = createListingProjectionFixture();
    view.projectionError = null;
    view.listingRemoved = false;
    view.fetchFailure = null;
    view.confirmedRemoved = false;
    confirmRemovedCalls.mockClear();
    view.needsSession = false;
    view.hasFullHomeserverGrant = false;
    view.orders = [];
    view.offers = [];
    sessionState.pubky = null;
    sellerReputation.value = { status: 'new_seller' };
    cartAdd.mockClear();
    projectionRefresh.mockClear();
    authState.currentUserPubky = 'b'.repeat(52);
    authState.setShowSignInDialog.mockClear();
  });

  const renderListing = () => {
    const listing = view.listing;
    if (!listing) throw new Error('Expected listing fixture');
    render(<MarketplaceListing sellerPubky={listing.seller_id} listingId={listing.listing_id} />);
    return listing;
  };

  describe('a listing that is not in the local catalog', () => {
    const notFoundOnHomeserver = new Error('homeserver 404');

    beforeEach(() => {
      view.listing = null;
      view.projection = null;
    });

    it('says the listing was removed when the homeserver and Nexus both answer 404', async () => {
      view.fetchFailure = notFoundOnHomeserver;
      view.confirmedRemoved = true;

      render(<MarketplaceListing sellerPubky={COMMERCE_FIXTURE_SELLER} listingId="boots_01" />);

      expect(await screen.findByText('This listing was removed.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Listing unavailable' })).toBeInTheDocument();
      expect(screen.queryByText('This listing could not be loaded.')).not.toBeInTheDocument();
      expect(confirmRemovedCalls).toHaveBeenCalledWith(notFoundOnHomeserver);
    });

    it('says the listing was removed when the transaction service reports the tombstone', async () => {
      view.fetchFailure = new Error('homeserver unreachable');
      view.listingRemoved = true;

      render(<MarketplaceListing sellerPubky={COMMERCE_FIXTURE_SELLER} listingId="boots_01" />);

      expect(await screen.findByText('This listing was removed.')).toBeInTheDocument();
      expect(screen.queryByText('This listing could not be loaded.')).not.toBeInTheDocument();
    });

    it('keeps the generic copy when the confirmation itself fails', async () => {
      view.fetchFailure = notFoundOnHomeserver;
      view.confirmedRemoved = new Error('confirmation failed');

      render(<MarketplaceListing sellerPubky={COMMERCE_FIXTURE_SELLER} listingId="boots_01" />);

      expect(await screen.findByText('This listing could not be loaded.')).toBeInTheDocument();
    });

    it('keeps the generic copy when the failure is transient or unconfirmed', async () => {
      view.fetchFailure = new Error('homeserver unreachable');

      render(<MarketplaceListing sellerPubky={COMMERCE_FIXTURE_SELLER} listingId="boots_01" />);

      expect(await screen.findByText('This listing could not be loaded.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Listing unavailable' })).toBeInTheDocument();
      expect(screen.queryByText('This listing was removed.')).not.toBeInTheDocument();
    });
  });

  it('does not show the approval card just for viewing a listing without a marketplace session', () => {
    view.projection = null;
    view.projectionError = 'A marketplace session is required.';
    view.needsSession = true;

    renderListing();

    expect(screen.getByRole('heading', { name: 'Vintage leather boots' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message seller' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Reviews' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve in Pubky Ring' })).not.toBeInTheDocument();
  });

  it('renders the seller block with shop identity, actions, and shipping copy', () => {
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        fulfillmentMethods: ['physical'],
        shippingOptions: [
          {
            id: 'ground',
            pricing: 'flat',
            label: 'Ground shipping',
            price: { amountMinor: 899, currency: 'USD', exponent: 2 },
            estimatedMinDays: 3,
            estimatedMaxDays: 5,
          },
        ],
      }),
    );

    renderListing();

    expect(screen.queryByText('Sold by')).not.toBeInTheDocument();
    expect(screen.getByText('Satoshi Vintage')).toBeInTheDocument();
    expect(screen.getByText('No rating yet')).toBeInTheDocument();
    expect(screen.queryByText(/Shop opened/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View shop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message seller' })).toBeInTheDocument();
    expect(screen.getByText('Shipping: $8.99')).toHaveAttribute('data-slot', 'badge');
    expect(screen.queryByText('Shipping: Ground shipping $8.99')).not.toBeInTheDocument();
  });

  it.each(['flat', 'free'] as const)('labels %s zero-cost shipping as free', (pricing) => {
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        fulfillmentMethods: ['physical'],
        shippingOptions: [
          {
            id: 'shipping',
            label: 'Seller shipping',
            ...(pricing === 'flat'
              ? { pricing: 'flat' as const, price: { amountMinor: 0, currency: 'USD', exponent: 2 } }
              : { pricing: 'free' as const }),
            estimatedMinDays: 3,
            estimatedMaxDays: 5,
          },
        ],
      }),
    );
    renderListing();
    expect(screen.getByText('Shipping: Free')).toHaveAttribute('data-slot', 'badge');
    expect(screen.queryByText('Shipping: $0.00')).not.toBeInTheDocument();
  });

  it('describes pickup without promising shipping and keeps purchase ahead of details', () => {
    view.listing = toCommerceListingModel(createCommerceListingFixture({ fulfillmentMethods: ['pickup'] }));
    renderListing();
    expect(screen.getByText('Local pickup only')).toBeInTheDocument();
    expect(screen.getByText('Pickup location')).toBeInTheDocument();
    expect(screen.queryByText('Ships from')).not.toBeInTheDocument();
    expect(screen.queryByText(/Shipping: calculated/)).not.toBeInTheDocument();
    const purchase = screen.getByRole('button', { name: /Add to cart/ });
    expect(
      purchase.compareDocumentPosition(screen.getByRole('heading', { name: 'Item specifics' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Digital delivery design §3 and §6 B7, B8.
  const digitalOnly = () =>
    toCommerceListingModel(
      createCommerceListingFixture({ fulfillmentMethods: ['digital'], package: undefined, shippingOptions: [] }),
    );

  it('badges a digital-only listing by its delivery kind and takes no offers', () => {
    view.listing = digitalOnly();
    view.projection = createListingProjectionFixture({
      fulfillmentMethods: ['digital'],
      digitalDelivery: { kind: 'file', contentType: 'application/pdf', sizeBytes: 12_582_912 },
    });
    renderListing();

    expect(screen.getByTestId('marketplace-listing-digital-badge')).toHaveTextContent('Instant download · PDF · 12 MB');
    expect(screen.queryByText('Ships from')).not.toBeInTheDocument();
    expect(screen.queryByText('Pickup location')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make offer/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('marketplace-listing-digital-offer-note')).toHaveTextContent(
      "Offers aren't available on digital items yet.",
    );
  });

  it('shows the plain digital badge until the seller sets delivery', () => {
    view.listing = digitalOnly();
    view.projection = createListingProjectionFixture({ fulfillmentMethods: ['digital'], digitalDelivery: null });
    renderListing();

    expect(screen.getByTestId('marketplace-listing-digital-badge')).toHaveTextContent(/^Digital delivery$/);
  });

  it('keeps shipping facts and offers on a listing that ships and delivers digitally', () => {
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({ fulfillmentMethods: ['physical', 'shipping', 'digital'] }),
    );
    view.projection = createListingProjectionFixture({
      fulfillmentMethods: ['shipping', 'digital'],
      digitalDelivery: { kind: 'email' },
    });
    renderListing();

    expect(screen.getByText('Shipping: $12.00')).toHaveAttribute('data-slot', 'badge');
    expect(screen.getByTestId('marketplace-listing-digital-badge')).toHaveTextContent(
      'Emailed by the seller after payment',
    );
    expect(screen.getByText('Ships from')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Make offer/ })).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-listing-digital-offer-note')).toHaveTextContent(
      'Offers buy the shipped version.',
    );
  });

  it('takes offers on a listing that offers pickup and delivers digitally, for the pickup version', () => {
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        fulfillmentMethods: ['pickup', 'digital'],
        package: undefined,
        shippingOptions: [],
      }),
    );
    view.projection = createListingProjectionFixture({
      fulfillmentMethods: ['pickup', 'digital'],
      digitalDelivery: { kind: 'file', contentType: 'application/pdf', sizeBytes: 12_582_912 },
    });
    renderListing();

    expect(screen.getByRole('button', { name: /Make offer/ })).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-listing-digital-offer-note')).toHaveTextContent(
      'Offers buy the pickup version.',
    );
  });

  it('leaves a Locks listing on its own digital notice', () => {
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        fulfillmentMethods: ['digital'],
        package: undefined,
        shippingOptions: [],
        digitalLock: {
          policyUri: LOCKS_POLICY_URL,
          criterionId: 'criterion-1',
          contentPath: 'premium.txt',
          resourceHash: 'b'.repeat(64),
          minimumConfirmations: 6,
        },
      }),
    );
    renderListing();

    expect(screen.queryByTestId('marketplace-listing-digital-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('marketplace-listing-digital-offer-note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make offer/ })).not.toBeInTheDocument();
  });

  it('offers Make offer on a pickup-only Buy-now listing that accepts offers', () => {
    view.listing = toCommerceListingModel(createCommerceListingFixture({ fulfillmentMethods: ['pickup'] }));
    renderListing();
    expect(screen.getByRole('button', { name: /Add to cart/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make offer' })).toBeEnabled();
  });

  it('shows no Make offer on a digital-only listing, which the service refuses offers on', () => {
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        fulfillmentMethods: ['digital'],
        digitalLock: {
          policyUri: `pubky://${'s'.repeat(52)}/pub/locks.app/policies/boots_01.json`,
          criterionId: 'criterion-1',
          contentPath: 'boots_01/archive.zip',
          resourceHash: 'a'.repeat(64),
          minimumConfirmations: 3,
        },
      }),
    );
    renderListing();
    expect(screen.queryByRole('button', { name: 'Make offer' })).not.toBeInTheDocument();
  });

  it('shows no Make offer when the listing does not accept offers', () => {
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        fulfillmentMethods: ['pickup'],
        sale: {
          format: 'fixed_price',
          unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
          acceptsOffers: false,
        },
      }),
    );
    renderListing();
    expect(screen.queryByRole('button', { name: 'Make offer' })).not.toBeInTheDocument();
  });

  it('keeps Make offer on a listing that ships as well as offering pickup', () => {
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({ fulfillmentMethods: ['physical', 'shipping', 'pickup'] }),
    );
    renderListing();
    expect(screen.getByRole('button', { name: 'Make offer' })).toBeEnabled();
  });

  it('falls back to the seller pubky when no shop record exists', () => {
    view.shop = null;
    const listing = renderListing();

    expect(screen.getByText(`${listing.seller_id.slice(0, 10)}…`)).toBeInTheDocument();
    expect(screen.getByText('No rating yet')).toBeInTheDocument();
    expect(screen.queryByText('Shop opened Aug 2026')).not.toBeInTheDocument();
  });

  it('renders the seller rating aggregate when reputation is present', () => {
    sellerReputation.value = {
      status: 'rated',
      summary: {
        count: 12,
        verifiedCount: 9,
        avg: 4.7,
        histogram: [0, 0, 1, 2, 9],
        responseCount: 3,
        editedLateCount: 0,
        attestors: {},
        lastReviewedAt: '2026-08-20T12:00:00.000Z',
      },
    };

    renderListing();

    expect(
      screen.getByRole('img', { name: 'Rated 4.7 out of 5 from 12 reviews, 9 verified purchases' }),
    ).toBeInTheDocument();
    expect(screen.getByTitle('12 reviews')).toBeInTheDocument();
    expect(screen.queryByText('No rating yet')).not.toBeInTheDocument();
  });

  it('requires a marketplace session before showing availability', async () => {
    view.projection = null;
    view.projectionError = 'A marketplace session is required.';
    view.needsSession = true;

    renderListing();

    const purchase = screen.getByRole('button', { name: 'Approve to buy' });
    expect(purchase).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Add to cart' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('Connect to see availability before adding this item to your cart.'),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Approve to buy' })).toHaveLength(1);
    expect(cartAdd).not.toHaveBeenCalled();
  });

  it('opens the Ring approval card from the single purchase button, without a duplicate callout', async () => {
    view.projection = null;
    view.projectionError = 'A marketplace session is required.';
    view.needsSession = true;
    const user = userEvent.setup();

    renderListing();

    await user.click(screen.getByRole('button', { name: 'Approve to buy' }));

    expect(screen.getByRole('heading', { name: 'Approve purchases in Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve in Pubky Ring' })).toBeInTheDocument();
    expect(
      screen.queryByText('Connect to see availability before adding this item to your cart.'),
    ).not.toBeInTheDocument();
  });

  it('uses one Sign in to buy path when the viewer has no identity', async () => {
    authState.currentUserPubky = null;
    view.projection = null;
    view.projectionError = 'A marketplace session is required.';
    view.needsSession = true;
    const user = userEvent.setup();

    renderListing();

    const purchase = screen.getByRole('button', { name: 'Sign in to buy' });
    expect(purchase).toBeEnabled();
    expect(screen.getAllByRole('button', { name: 'Sign in to buy' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Make offer' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add to watchlist' })).toBeEnabled();
    expect(
      screen.queryByText('Connect to see availability before adding this item to your cart.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(purchase);
    expect(authState.setShowSignInDialog).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('heading', { name: 'Approve purchases in Pubky Ring' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Make offer' }));
    expect(authState.setShowSignInDialog).toHaveBeenCalledTimes(2);
  });

  it('adds the selected variant to cart when the marketplace session is ready', async () => {
    const user = userEvent.setup();

    const listing = renderListing();
    await user.click(screen.getByRole('button', { name: 'Add to cart' }));

    expect(cartAdd).toHaveBeenCalledWith(`${listing.seller_id}:${listing.listing_id}`, 'variant_01', 1);
    expect(screen.queryByRole('button', { name: 'Approve in Pubky Ring' })).not.toBeInTheDocument();
  });

  it('shows the holding sentence and disables checkout when the listing is reserved', () => {
    view.projection = createListingProjectionFixture({ state: 'reserved', availableQuantity: 0, reservedQuantity: 1 });
    renderListing();

    expect(screen.getByRole('button', { name: 'Held by another buyer' })).toBeDisabled();
    expect(
      screen.getByText(
        'Another buyer is currently paying for this item. If payment does not complete, it will become available again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sold out' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: CHECKOUT_HOLD_COPY.heldWhileAnotherPays })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Make offer' })).not.toBeInTheDocument();
  });

  it('links Held for you to the viewer pending_payment order, not a session id', () => {
    const listing = view.listing;
    if (!listing) throw new Error('Expected listing fixture');
    const sessionId = 'sess_not-a-pubky-identifier';
    const ownHold = createOrderFixture('pending_payment', {
      buyerPubky: authState.currentUserPubky ?? '',
      lines: [
        {
          ...createOrderFixture('pending_payment').lines[0],
          listingAggregateId: `listing:${listing.seller_id}_${listing.listing_id}`,
        },
      ],
    });
    view.projection = createListingProjectionFixture({
      aggregateId: `listing:${listing.seller_id}_${listing.listing_id}`,
      sellerPubky: listing.seller_id,
      listingId: listing.listing_id,
      state: 'reserved',
      availableQuantity: 0,
      reservedQuantity: 1,
    });
    view.orders = [{ order: { ...ownHold, buyerPubky: sessionId } }];

    renderListing();

    expect(screen.getByRole('button', { name: 'Held by another buyer' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: CHECKOUT_HOLD_COPY.heldForYouCta })).not.toBeInTheDocument();
  });

  it('shows Held for you when the pending hold buyerPubky matches the viewer pubky', () => {
    const listing = view.listing;
    if (!listing) throw new Error('Expected listing fixture');
    const ownHold = createOrderFixture('pending_payment', {
      buyerPubky: authState.currentUserPubky ?? '',
      lines: [
        {
          ...createOrderFixture('pending_payment').lines[0],
          listingAggregateId: `listing:${listing.seller_id}_${listing.listing_id}`,
        },
      ],
    });
    view.projection = createListingProjectionFixture({
      aggregateId: `listing:${listing.seller_id}_${listing.listing_id}`,
      sellerPubky: listing.seller_id,
      listingId: listing.listing_id,
      state: 'reserved',
      availableQuantity: 0,
      reservedQuantity: 1,
    });
    view.orders = [{ order: ownHold }];
    view.offers = [
      {
        ...parseContractFaithfulOffer('accepted', 'active'),
        buyerPubky: authState.currentUserPubky ?? '',
        listingAggregateId: `listing:${listing.seller_id}_${listing.listing_id}`,
      },
    ];
    sessionState.pubky = authState.currentUserPubky;

    renderListing();

    const link = screen.getByRole('link', { name: CHECKOUT_HOLD_COPY.heldForYouCta });
    expect(link).toHaveAttribute('href', `/marketplace/checkout#${ownHold.id}`);
    expect(screen.queryByRole('link', { name: CHECKOUT_HOLD_COPY.heldForYouOfferCta })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: CHECKOUT_HOLD_COPY.heldForYouCta })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Held by another buyer' })).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Another buyer is currently paying for this item. If payment does not complete, it will become available again.',
      ),
    ).not.toBeInTheDocument();
  });

  function acceptedOfferForListing(
    listingAggregateId: string,
    buyerPubky: string,
    awardState: 'active' | 'expired' = 'active',
  ) {
    return {
      ...parseContractFaithfulOffer('accepted', awardState),
      buyerPubky,
      listingAggregateId,
    };
  }

  function reserveCurrentListing() {
    const listing = view.listing;
    if (!listing) return { listing: view.listing, aggregateId: '' };
    const aggregateId = `listing:${listing.seller_id}_${listing.listing_id}`;
    view.projection = createListingProjectionFixture({
      aggregateId,
      sellerPubky: listing.seller_id,
      listingId: listing.listing_id,
      state: 'reserved',
      availableQuantity: 0,
      reservedQuantity: 1,
    });
    return { listing, aggregateId };
  }

  it('links the award buyer to checkout when the accepted offer buyerPubky matches the session pubky', () => {
    const { aggregateId } = reserveCurrentListing();
    const sessionPubky = 'b'.repeat(52);
    sessionState.pubky = sessionPubky;
    const offer = acceptedOfferForListing(aggregateId, sessionPubky);
    view.offers = [offer];

    renderListing();

    expect(document.querySelector('[data-surface="marketplace-listing-purchase"]')).toBeTruthy();
    const link = screen.getByRole('link', { name: CHECKOUT_HOLD_COPY.heldForYouOfferCta });
    expect(link).toHaveAttribute('href', getMarketplaceOfferCheckoutRoute(offer.id));
    expect(screen.queryByRole('button', { name: 'Held by another buyer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CHECKOUT_HOLD_COPY.heldWhileAnotherPays })).not.toBeInTheDocument();
    expect(screen.queryByText(CHECKOUT_HOLD_COPY.listingReserved)).not.toBeInTheDocument();
  });

  it("does not treat another pubky accepted offer as the viewer's hold", () => {
    const { aggregateId } = reserveCurrentListing();
    sessionState.pubky = 'b'.repeat(52);
    view.offers = [acceptedOfferForListing(aggregateId, 'c'.repeat(52))];

    renderListing();

    expect(screen.getByRole('button', { name: 'Held by another buyer' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: CHECKOUT_HOLD_COPY.heldForYouOfferCta })).not.toBeInTheDocument();
  });

  it('does not claim an offer hold without an active session pubky', () => {
    const { aggregateId } = reserveCurrentListing();
    sessionState.pubky = null;
    view.offers = [acceptedOfferForListing(aggregateId, 'b'.repeat(52))];

    renderListing();

    expect(screen.getByRole('button', { name: 'Held by another buyer' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: CHECKOUT_HOLD_COPY.heldForYouOfferCta })).not.toBeInTheDocument();
  });

  it('ignores an accepted offer that does not hold this listing', () => {
    const { aggregateId } = reserveCurrentListing();
    const sessionPubky = 'b'.repeat(52);
    sessionState.pubky = sessionPubky;
    view.offers = [
      acceptedOfferForListing('listing:other_item', sessionPubky),
      acceptedOfferForListing(aggregateId, sessionPubky, 'expired'),
    ];

    renderListing();

    expect(screen.getByRole('button', { name: 'Held by another buyer' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: CHECKOUT_HOLD_COPY.heldForYouOfferCta })).not.toBeInTheDocument();
  });

  function renderAuctionListingNeedingSession() {
    const auctionStartsAt = new Date(Date.now() - 60_000).toISOString();
    const auctionEndsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'rangefinder_camera',
        title: '35mm rangefinder camera',
        sale: {
          format: 'auction',
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          startsAt: auctionStartsAt,
          endsAt: auctionEndsAt,
          antiSnipingWindowSeconds: 300,
          antiSnipingExtensionSeconds: 300,
        },
      }),
    );
    view.projection = null;
    view.projectionError = 'A marketplace session is required.';
    view.needsSession = true;
    renderListing();
  }

  it('uses an anti-sniping projection extension to keep bidding live', () => {
    const scheduledEndsAt = new Date(Date.now() - 60_000).toISOString();
    const projectedEndsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        sale: {
          format: 'auction',
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          startsAt: new Date(Date.now() - 2 * 60_000).toISOString(),
          endsAt: scheduledEndsAt,
          antiSnipingWindowSeconds: 300,
          antiSnipingExtensionSeconds: 300,
        },
      }),
    );
    view.projection = createListingProjectionFixture({
      saleFormat: 'auction',
      auction: {
        startsAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        endsAt: projectedEndsAt,
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        currentPrice: { amountMinor: 6_900, currency: 'USD', exponent: 2 },
        leaderPubky: 'b'.repeat(52),
        bidCount: 4,
      },
    });

    renderListing();

    expect(screen.getByRole('button', { name: 'Place a bid' })).toBeEnabled();
  });

  it('reveals the full-grant approval card when a bridged buyer with a narrow grant places a bid', async () => {
    view.hasFullHomeserverGrant = false;
    const user = userEvent.setup();

    renderAuctionListingNeedingSession();
    await user.click(screen.getByRole('button', { name: 'Place a bid' }));

    expect(screen.getByRole('heading', { name: 'Approve purchases in Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve in Pubky Ring' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve in Pubky Ring' }));
    expect(screen.getByText('Sign in to Pubky Shop.')).toBeInTheDocument();
    expect(screen.queryByText(/permission list/i)).not.toBeInTheDocument();
    expect(screen.queryByText(CAPABILITIES)).not.toBeInTheDocument();
    expect(screen.queryByText(/first Shop-scoped approval/i)).not.toBeInTheDocument();
  });

  it('labels an ended auction Auction ended and does not blame the seller for checkout unavailability', () => {
    const endedAt = new Date(Date.now() - 60_000).toISOString();
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        sale: {
          format: 'auction',
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          startsAt: new Date(Date.now() - 2 * 60_000).toISOString(),
          endsAt: endedAt,
          antiSnipingWindowSeconds: 300,
          antiSnipingExtensionSeconds: 300,
        },
      }),
    );
    view.projection = createListingProjectionFixture({
      saleFormat: 'auction',
      auction: {
        startsAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        endsAt: endedAt,
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        currentPrice: { amountMinor: 6_900, currency: 'USD', exponent: 2 },
        leaderPubky: 'b'.repeat(52),
        bidCount: 4,
      },
    });
    view.projectionError = 'This listing could not be prepared for checkout. It may have been removed by the seller.';

    renderListing();

    expect(screen.getByRole('button', { name: 'Auction ended' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('This auction is no longer open for bidding.');
    expect(
      screen.queryByText('This listing could not be prepared for checkout. It may have been removed by the seller.'),
    ).not.toBeInTheDocument();
  });

  it('shows Unlimited on a digital-only variant instead of the quantity cap', () => {
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        fulfillmentMethods: ['digital'],
        package: undefined,
        shippingOptions: [],
        variants: [
          {
            id: 'variant_pdf',
            options: { size: 'PDF' },
            quantity: COMMERCE_LISTING_MAX_QUANTITY,
            mediaIds: ['image_01'],
            enabled: true,
          },
          {
            id: 'variant_epub',
            options: { size: 'EPUB' },
            quantity: COMMERCE_LISTING_MAX_QUANTITY,
            mediaIds: ['image_01'],
            enabled: true,
          },
        ],
      }),
    );

    renderListing();

    const variant = screen.getByRole('combobox', { name: 'Choose listing variant' });
    expect(variant).toHaveTextContent('Unlimited');
    expect(variant).not.toHaveTextContent(String(COMMERCE_LISTING_MAX_QUANTITY));
  });

  it('reveals the empty-caps reconnect card when a full-grant buyer places a bid without a marketplace session', async () => {
    view.hasFullHomeserverGrant = true;
    const user = userEvent.setup();

    renderAuctionListingNeedingSession();
    await user.click(screen.getByRole('button', { name: 'Place a bid' }));

    expect(screen.getByRole('heading', { name: 'Approve purchases in Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve in Pubky Ring' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve in Pubky Ring' }));
    expect(screen.getByText('Approve with Pubky Ring to connect the marketplace on this device.')).toBeInTheDocument();
    expect(screen.queryByText(/permission list/i)).not.toBeInTheDocument();
    expect(screen.queryByText(CAPABILITIES)).not.toBeInTheDocument();
  });
});
