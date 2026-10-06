/**
 * A listing projection as the durable service serves it (snake_case wire),
 * pinned from `contracts/samples/projections.json`
 * (`auction_non_seller_bidder_projection`, BitcoinErrorLog/pubky-marketplace-service
 * `d7c3c759`). Placeholders are replaced with valid values; every field and
 * its type is the service's.
 */
export function serviceListingProjectionWire(): Record<string, unknown> {
  return {
    aggregate_id: `listing:${'s'.repeat(52)}_boots_01`,
    auction: {
      anti_sniping_extension_seconds: 120,
      anti_sniping_window_seconds: 60,
      bid_count: 1,
      current_price: { amount_minor: 4500, currency: 'USD', exponent: 2 },
      ends_at: '2026-09-25T12:00:00.000Z',
      leader_pubky: 'b'.repeat(52),
      minimum_increment: { amount_minor: 500, currency: 'USD', exponent: 2 },
      starts_at: '2026-09-24T12:00:00.000Z',
      status: 'active',
    },
    available_quantity: 1,
    content_hash: 'a'.repeat(64),
    digital_delivery: null,
    fulfillment_methods: ['shipping'],
    listing_id: 'boots_01',
    listing_revision: 1,
    reserved_quantity: 0,
    sale_format: 'auction',
    seller_pubky: 's'.repeat(52),
    server_revision: 2,
    shipping: { amount_minor: 1200, currency: 'USD', exponent: 2 },
    sold_quantity: 0,
    state: 'available',
    title: 'Marketplace item',
    total_quantity: 1,
    unit_price: { amount_minor: 4500, currency: 'USD', exponent: 2 },
    updated_at: '2026-09-24T12:00:00.000Z',
    viewer_bid: {
      maximum_amount: { amount_minor: 7000, currency: 'USD', exponent: 2 },
      minimum_next_bid: { amount_minor: 7001, currency: 'USD', exponent: 2 },
    },
  };
}
