import { type MarketplaceOffer, marketplaceOfferSchema } from '@/core/services/marketplace/marketplace-projections';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';

const CONTRACT_FIXTURE_BUYER = 'y'.repeat(52);
const CONTRACT_FIXTURE_SELLER = 'n'.repeat(52);

/**
 * Redacted from seller-offers-v062.json:130-170. The field names remain the
 * durable service's snake_case response so these tests exercise both the wire
 * casing boundary and the production offer projection schema.
 */
export const CONTRACT_FAITHFUL_OFFER_WIRE = {
  id: 'bf50a192-3b30-46af-9c41-909b2bf7f784',
  aggregate_id: 'offer:5734477e29b0464dbc7682b76e6f1d34',
  listing_aggregate_id: `listing:${CONTRACT_FIXTURE_SELLER}_5734477e29b0464dbc7682b76e6f1d34`,
  buyer_pubky: CONTRACT_FIXTURE_BUYER,
  seller_pubky: CONTRACT_FIXTURE_SELLER,
  revision: 2,
  state: 'converted',
  offered_by: CONTRACT_FIXTURE_BUYER,
  amount: { amount_minor: 100, currency: 'USD', exponent: 2 },
  quantity: 1,
  message: '',
  expires_at: '2026-09-16T09:26:17.675Z',
  updated_at: '2026-09-15T09:37:40.084Z',
  award: {
    id: 'bf50a192-3b30-46af-9c41-909b2bf7f784',
    state: 'converted',
    listing: {
      aggregate_id: `listing:${CONTRACT_FIXTURE_SELLER}_5734477e29b0464dbc7682b76e6f1d34`,
      seller_pubky: CONTRACT_FIXTURE_SELLER,
      listing_id: '5734477e29b0464dbc7682b76e6f1d34',
      title: 'Cutover test — do not buy',
      listing_revision: 1,
      listing_record_sha256: '645a42ca' + 'e'.repeat(56),
    },
    variant: { id: 'variant_1', sku: null, options: [] },
    unit_price: { amount_minor: 100, currency: 'USD', exponent: 2 },
    subtotal: { amount_minor: 100, currency: 'USD', exponent: 2 },
    shipping: { amount_minor: 100, currency: 'USD', exponent: 2 },
    merchandise_total: { amount_minor: 200, currency: 'USD', exponent: 2 },
    quantity: 1,
    accepted_at: '2026-09-15T09:28:42.884Z',
    convert_by: '2026-09-15T09:58:42.884Z',
    converted_order_id: '6f5c25fa-d5c2-4c74-ad2e-8884269e8796',
  },
} as const;

export function parseContractFaithfulOffer(
  offerState: MarketplaceOffer['state'] = 'converted',
  awardState: 'active' | 'converted' | 'expired' = 'converted',
): MarketplaceOffer {
  const wire = {
    ...CONTRACT_FAITHFUL_OFFER_WIRE,
    state: offerState,
    award: {
      ...CONTRACT_FAITHFUL_OFFER_WIRE.award,
      state: awardState,
      converted_order_id: awardState === 'converted' ? CONTRACT_FAITHFUL_OFFER_WIRE.award.converted_order_id : null,
    },
  };
  return marketplaceOfferSchema.parse(toCamelCaseWire(wire));
}
