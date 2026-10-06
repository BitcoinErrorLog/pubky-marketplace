import { describe, expect, it } from 'vitest';
import { toCamelCaseWire, toSnakeCaseWire } from './wire-casing';

const SELLER = 'y'.repeat(52);

describe('toSnakeCaseWire', () => {
  it('converts a full command envelope the way the Rust service expects it', () => {
    const command = {
      version: 1,
      commandId: '018f47d2-6a27-7c23-a49d-6b21bb770120',
      aggregateId: `listing:${SELLER}_boots_01`,
      expectedRevision: 0,
      issuedAt: '2026-08-19T22:00:00.000Z',
      kind: 'listing.register',
      payload: {
        sellerPubky: SELLER,
        listingId: 'boots_01',
        title: 'Trail boots',
        listingRevision: 1,
        contentHash: 'a'.repeat(64),
        quantity: 3,
        unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        saleFormat: 'auction',
        auctionTerms: {
          startsAt: '2026-08-19T22:00:00.000Z',
          endsAt: '2026-08-20T22:00:00.000Z',
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          antiSnipingWindowSeconds: 60,
          antiSnipingExtensionSeconds: 120,
        },
      },
    };

    expect(toSnakeCaseWire(command)).toEqual({
      version: 1,
      command_id: '018f47d2-6a27-7c23-a49d-6b21bb770120',
      aggregate_id: `listing:${SELLER}_boots_01`,
      expected_revision: 0,
      issued_at: '2026-08-19T22:00:00.000Z',
      kind: 'listing.register',
      payload: {
        seller_pubky: SELLER,
        listing_id: 'boots_01',
        title: 'Trail boots',
        listing_revision: 1,
        content_hash: 'a'.repeat(64),
        quantity: 3,
        unit_price: { amount_minor: 12_500, currency: 'USD', exponent: 2 },
        sale_format: 'auction',
        auction_terms: {
          starts_at: '2026-08-19T22:00:00.000Z',
          ends_at: '2026-08-20T22:00:00.000Z',
          minimum_increment: { amount_minor: 500, currency: 'USD', exponent: 2 },
          anti_sniping_window_seconds: 60,
          anti_sniping_extension_seconds: 120,
        },
      },
    });
  });

  it('leaves digit-suffixed keys and values untouched', () => {
    expect(
      toSnakeCaseWire({
        deliveryAddress: { line1: '1 Main St', line2: '', postalCode: 'A1 2BC', countryCode: 'GB' },
        kind: 'auction.place_bid',
      }),
    ).toEqual({
      delivery_address: { line1: '1 Main St', line2: '', postal_code: 'A1 2BC', country_code: 'GB' },
      kind: 'auction.place_bid',
    });
  });

  it('recurses through arrays and preserves null', () => {
    expect(
      toSnakeCaseWire({
        lines: [{ listingAggregateId: 'listing:a', expectedRevision: 1, quantity: 2 }],
        leaderPubky: null,
      }),
    ).toEqual({
      lines: [{ listing_aggregate_id: 'listing:a', expected_revision: 1, quantity: 2 }],
      leader_pubky: null,
    });
  });
});

describe('toCamelCaseWire', () => {
  it('converts a service command response to the client contract shape', () => {
    const response = {
      ok: true,
      version: 1,
      command_id: '018f47d2-6a27-7c23-a49d-6b21bb770120',
      aggregate_id: `listing:${SELLER}_boots_01`,
      revision: 1,
      event_ids: ['00000000-0000-4000-8000-000000000001'],
      result: {
        kind: 'listing',
        listing: {
          aggregate_id: `listing:${SELLER}_boots_01`,
          seller_pubky: SELLER,
          server_revision: 1,
          unit_price: { amount_minor: 12_500, currency: 'USD', exponent: 2 },
        },
      },
    };

    expect(toCamelCaseWire(response)).toEqual({
      ok: true,
      version: 1,
      commandId: '018f47d2-6a27-7c23-a49d-6b21bb770120',
      aggregateId: `listing:${SELLER}_boots_01`,
      revision: 1,
      eventIds: ['00000000-0000-4000-8000-000000000001'],
      result: {
        kind: 'listing',
        listing: {
          aggregateId: `listing:${SELLER}_boots_01`,
          sellerPubky: SELLER,
          serverRevision: 1,
          unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        },
      },
    });
  });

  it('converts error responses including current_revision and issues', () => {
    expect(
      toCamelCaseWire({
        ok: false,
        error: {
          code: 'REVISION_CONFLICT',
          message: 'The aggregate changed.',
          current_revision: 4,
          issues: [{ path: 'payload.unit_price.amount_minor', message: 'Expected a positive monetary amount' }],
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'REVISION_CONFLICT',
        message: 'The aggregate changed.',
        currentRevision: 4,
        issues: [{ path: 'payload.unit_price.amount_minor', message: 'Expected a positive monetary amount' }],
      },
    });
  });

  it('round-trips with toSnakeCaseWire for wire-shaped objects', () => {
    const camel = {
      expiresAt: '2026-08-20T22:00:00Z',
      antiSnipingWindowSeconds: 60,
      lines: [{ listingAggregateId: 'listing:a', quantity: 1 }],
      leaderPubky: null,
    };
    expect(toCamelCaseWire(toSnakeCaseWire(camel))).toEqual(camel);
  });
});
