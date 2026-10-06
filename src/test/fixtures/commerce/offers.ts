import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import type { MarketplaceOffer } from '@/services/marketplace/marketplace';
import { parseContractFaithfulOffer } from './offer-award';

export const OFFER_FIXTURE_BUYER = 'b'.repeat(52);
export const OFFER_FIXTURE_SELLER = 's'.repeat(52);

/**
 * Captured from marketplace-service 9c74945:
 * contracts/samples/projections.json (accepted_offer_with_award.award).
 * Pubkys, UUIDs, timestamps, and the listing-record hash are redacted with
 * well-formed deterministic values; wire keys and sample values are preserved.
 */
export const ACCEPTED_OFFER_AWARD_WIRE_FIXTURE = {
  accepted_at: '2026-09-15T00:00:00.000Z',
  convert_by: '2026-09-15T12:00:00.000Z',
  converted_order_id: null,
  id: '00000000-0000-0000-0000-000000000902',
  listing: {
    aggregate_id: `listing:${OFFER_FIXTURE_SELLER}_boots_01`,
    listing_id: 'boots_01',
    listing_record_sha256: 'a'.repeat(64),
    listing_revision: 1,
    seller_pubky: OFFER_FIXTURE_SELLER,
    title: 'Marketplace item',
  },
  merchandise_total: {
    amount_minor: 10000,
    currency: 'USD',
    exponent: 2,
  },
  quantity: 1,
  shipping: {
    amount_minor: 0,
    currency: 'USD',
    exponent: 2,
  },
  state: 'active',
  subtotal: {
    amount_minor: 10000,
    currency: 'USD',
    exponent: 2,
  },
  unit_price: {
    amount_minor: 10000,
    currency: 'USD',
    exponent: 2,
  },
  variant: {
    id: `listing:${OFFER_FIXTURE_SELLER}_boots_01`,
    options: [],
    sku: null,
  },
} as const;

/**
 * Keyed record instead of a plain array so adding a state to the offer schema
 * union fails compilation here (missing key) instead of leaving the new state
 * silently untested.
 */
const OFFER_STATE_MESSAGES = {
  pending: 'Would you take this for the pair? I can pick up locally this week.',
  countered: 'Meet in the middle? This is my best number for a fast close.',
  accepted: 'Great — accepted. Please proceed to checkout when ready.',
  rejected: 'Sorry, this is below what I can accept for this item.',
  withdrawn: 'Withdrawing this offer — found another option.',
  expired: 'This offer lapsed before the seller responded.',
  converted: 'This offer has been converted into an order.',
} as const satisfies Record<MarketplaceOffer['state'], string>;

/** Every offer state the marketplace offer schema defines. */
export const OFFER_STATES = Object.keys(OFFER_STATE_MESSAGES) as readonly MarketplaceOffer['state'][];

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', exponent: 2 });

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `018f47d2-6a27-7c23-b51e-${hex}`;
}

export function createOfferFixture(
  state: MarketplaceOffer['state'],
  overrides: Partial<MarketplaceOffer> = {},
): MarketplaceOffer {
  const stateIndex = OFFER_STATES.indexOf(state) + 1;
  const fixture = {
    id: uuid(stateIndex),
    aggregateId: `offer:${uuid(100 + stateIndex)}`,
    listingAggregateId: buildMarketplaceListingAggregateId(OFFER_FIXTURE_SELLER, 'leather_boots'),
    buyerPubky: OFFER_FIXTURE_BUYER,
    sellerPubky: OFFER_FIXTURE_SELLER,
    revision: stateIndex,
    state,
    offeredBy: OFFER_FIXTURE_BUYER,
    amount: usd(9_500 + stateIndex * 500),
    quantity: 1,
    message: OFFER_STATE_MESSAGES[state],
    expiresAt: '2026-08-21T12:00:00.000Z',
    updatedAt: '2026-08-19T20:00:00.000Z',
    ...overrides,
  };
  if (state !== 'converted' || fixture.award) return fixture;
  return parseContractFaithfulOffer('converted', 'converted');
}

/** One offer per schema state, authored by `offeredBy` (defaults to the buyer). */
export function createOffersForEveryState(offeredBy: string = OFFER_FIXTURE_BUYER): MarketplaceOffer[] {
  return OFFER_STATES.map((state) => createOfferFixture(state, { offeredBy }));
}
