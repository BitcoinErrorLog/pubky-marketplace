import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CommerceListingRecord } from '@/libs/commerce/marketplace-records';
import type { MarketplaceOffer } from '@/services/marketplace/marketplace';
import { parseContractFaithfulOffer } from '@/test/fixtures/commerce/offer-award';
import { asInvalid } from '@/test-utils/type-assertions';
import {
  isLinkedOfferMissing,
  loadOfferListings,
  MarketplaceOffers,
  offerIsOpen,
  OfferListingSummary,
  offerStateLabel,
  parseListingAggregateId,
} from './MarketplaceOffers';

const getOrFetchListing = vi.hoisted(() => vi.fn());
const getManyListings = vi.hoisted(() => vi.fn());

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getManyListings,
    getOrFetchListing,
    getMarketplaceOrder: vi.fn(async () => ({ state: 'cancelled' })),
  },
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', () => ({
  useMarketplaceFirstMediaUrl: (uris: readonly string[]) => uris[0] ?? null,
}));

const offerView = vi.hoisted(() => ({
  offers: [] as MarketplaceOffer[],
  addAward: vi.fn(async () => true),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: offerView.push }),
  usePathname: () => '/marketplace/offers',
}));
vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'b'.repeat(52) }),
}));
vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({
    offers: offerView.offers,
    isLoading: false,
    error: null,
    needsSession: false,
    refresh: vi.fn(async () => {}),
    form: {},
    act: vi.fn(async () => false),
    counter: vi.fn(async () => false),
  }),
}));
vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', () => ({
  useMarketplaceCart: () => ({ addAward: offerView.addAward }),
}));
vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({ useMarketplaceCartCount: () => 0 }));
vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 0,
}));
vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

const seller = 's'.repeat(52);
const offer = {
  id: '018f47d2-6a27-7c23-b51e-000000000001',
  aggregateId: 'offer:018f47d2-6a27-7c23-b51e-000000000002',
  listingAggregateId: `listing:${seller}_boots`,
  buyerPubky: 'b'.repeat(52),
  sellerPubky: seller,
  revision: 1,
  state: 'accepted',
  offeredBy: 'b'.repeat(52),
  amount: { amountMinor: 1000, currency: 'USD', exponent: 2 },
  quantity: 1,
  message: '',
  expiresAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
} as MarketplaceOffer;

describe('Marketplace offers UX', () => {
  it('labels an accepted offer as expired after its expiry without changing its state', () => {
    expect(offerStateLabel('accepted', '2026-09-13T00:00:00.000Z', Date.parse('2026-09-14T00:00:00.000Z'))).toBe(
      'Expired',
    );
    expect(offer.state).toBe('accepted');
  });

  it('names a rejected offer Declined for the seller and the buyer', () => {
    expect(offerStateLabel('rejected', '2026-09-13T00:00:00.000Z')).toBe('Declined');
    expect(offerStateLabel('withdrawn', '2026-09-13T00:00:00.000Z')).toBe('withdrawn');
  });

  it('hides expiry once an offer is declined, accepted, withdrawn, expired, or converted', () => {
    expect(offerIsOpen('pending')).toBe(true);
    expect(offerIsOpen('countered')).toBe(true);
    for (const state of ['accepted', 'rejected', 'withdrawn', 'expired', 'converted'] as const) {
      expect(offerIsOpen(state)).toBe(false);
    }
  });

  it('parses listing references into the listing route parts', () => {
    expect(parseListingAggregateId(offer.listingAggregateId)).toEqual({ sellerPubky: seller, listingId: 'boots' });
  });

  it('shows a hydrated listing title and thumbnail as a listing link', async () => {
    const listing = {
      title: 'Vintage boots',
      media: [{ type: 'image', url: 'https://cdn.example/boots.jpg' }],
    } as CommerceListingRecord;

    render(<OfferListingSummary offer={offer} listing={listing} />);

    await waitFor(() => expect(screen.getByRole('link', { name: /Vintage boots/ })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Vintage boots/ })).toHaveAttribute(
      'href',
      `/marketplace/listing/${seller}/boots`,
    );
    expect(screen.getByRole('img', { name: 'Vintage boots thumbnail' })).toBeInTheDocument();
  });

  it('uses local listings without fetching', async () => {
    const listing = asInvalid<CommerceListingRecord>({ title: 'Local boots', media: [] });
    getManyListings.mockResolvedValue(new Map([[`${seller}:boots`, { record: listing }]]));

    await expect(loadOfferListings([offer])).resolves.toEqual(new Map([[`${seller}:boots`, listing]]));
    expect(getOrFetchListing).not.toHaveBeenCalled();
  });

  it('hydrates each missing listing exactly once and deduplicates duplicate offers', async () => {
    getManyListings.mockResolvedValue(new Map());
    getOrFetchListing.mockImplementation(async (_seller: string, listingId: string) => ({
      title: listingId,
      media: [],
    }));

    const second = { ...offer, id: 'second', listingAggregateId: `listing:${seller}_camera` } as MarketplaceOffer;
    await loadOfferListings([offer, second, offer]);

    expect(getOrFetchListing).toHaveBeenCalledTimes(2);
    expect(getOrFetchListing).toHaveBeenCalledWith(seller, 'boots');
    expect(getOrFetchListing).toHaveBeenCalledWith(seller, 'camera');
  });

  it('shows the missing-offer fallback only for a loaded, unmatched anchor', () => {
    expect(isLinkedOfferMissing('missing', [offer], false, null)).toBe(true);
    expect(isLinkedOfferMissing(offer.id, [offer], false, null)).toBe(false);
    expect(isLinkedOfferMissing('missing', [], true, null)).toBe(false);
    expect(isLinkedOfferMissing('missing', [], false, 'unavailable')).toBe(false);
  });

  it('shows the buyer merchandise total and creates one award cart line before routing', async () => {
    const accepted = {
      ...offer,
      award: {
        id: '00000000-0000-4000-8000-000000000801',
        state: 'active',
        listing: {
          aggregateId: offer.listingAggregateId,
          sellerPubky: seller,
          listingId: 'boots',
          title: 'Vintage boots',
          listingRevision: 2,
          listingRecordSha256: 'a'.repeat(64),
        },
        variant: { id: 'variant_42', sku: null, options: [{ name: 'Size', value: '42' }] },
        unitPrice: { amountMinor: 600, currency: 'USD', exponent: 2 },
        quantity: 1,
        acceptedAt: '2026-09-15T10:00:00.000Z',
        convertBy: '2026-09-15T12:00:00.000Z',
        convertedOrderId: null,
        subtotal: { amountMinor: 600, currency: 'USD', exponent: 2 },
        shipping: { amountMinor: 100, currency: 'USD', exponent: 2 },
        merchandiseTotal: { amountMinor: 700, currency: 'USD', exponent: 2 },
        fulfillmentMethods: ['shipping'],
      },
    } as MarketplaceOffer;
    offerView.offers = [accepted];
    const user = userEvent.setup();
    render(<MarketplaceOffers />);

    expect(screen.getByRole('button', { name: 'Buy for $6.00 + shipping' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Buy for $6.00 + shipping' }));

    await waitFor(() => expect(offerView.addAward).toHaveBeenCalledTimes(1));
    expect(offerView.addAward).toHaveBeenCalledWith(`${seller}:boots`, 'variant_42', 1, accepted.award?.id, 1);
    expect(offerView.push).toHaveBeenCalledWith('/marketplace/checkout?offer=018f47d2-6a27-7c23-b51e-000000000001');
  });

  it('does not offer checkout to the seller on an accepted seller-side row', () => {
    offerView.offers = [{ ...offer, buyerPubky: 'b'.repeat(52), offeredBy: seller, award: undefined }];
    render(<MarketplaceOffers />);
    expect(screen.queryByRole('button', { name: /Buy for/ })).not.toBeInTheDocument();
  });

  it('renders converted awards as an order link without a Buy control', async () => {
    const convertedOffer = parseContractFaithfulOffer('converted', 'converted');
    offerView.offers = [convertedOffer];

    render(<MarketplaceOffers />);

    expect(screen.queryByRole('button', { name: /Buy for/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Converted to an order/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View order' })).toHaveAttribute(
      'href',
      `/marketplace/orders#${convertedOffer.award?.convertedOrderId}`,
    );
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Make a new offer to buy this item' })).toBeInTheDocument(),
    );
  });

  it('shows a static error and does not navigate when award cart setup fails', async () => {
    offerView.addAward.mockResolvedValueOnce(false);
    const accepted = {
      ...offer,
      award: {
        id: '00000000-0000-4000-8000-000000000801',
        state: 'active',
        listing: {
          aggregateId: offer.listingAggregateId,
          sellerPubky: seller,
          listingId: 'boots',
          title: 'Vintage boots',
          listingRevision: 2,
          listingRecordSha256: 'a'.repeat(64),
        },
        variant: { id: 'variant_42', sku: null, options: [] },
        unitPrice: { amountMinor: 600, currency: 'USD', exponent: 2 },
        quantity: 1,
        acceptedAt: '2026-09-15T10:00:00.000Z',
        convertBy: '2026-09-15T12:00:00.000Z',
        convertedOrderId: null,
        subtotal: { amountMinor: 600, currency: 'USD', exponent: 2 },
        shipping: { amountMinor: 100, currency: 'USD', exponent: 2 },
        merchandiseTotal: { amountMinor: 700, currency: 'USD', exponent: 2 },
        fulfillmentMethods: ['shipping'],
      },
    } as MarketplaceOffer;
    offerView.offers = [accepted];
    const user = userEvent.setup();
    render(<MarketplaceOffers />);

    await user.click(screen.getByRole('button', { name: 'Buy for $6.00 + shipping' }));
    await waitFor(() => expect(offerView.addAward).toHaveBeenCalledTimes(1));
    expect(offerView.push).not.toHaveBeenCalled();
  });
});
