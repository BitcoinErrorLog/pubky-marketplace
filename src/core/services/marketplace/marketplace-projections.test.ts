import { describe, expect, it } from 'vitest';
import { MAX_BITCOIN_BASE_UNITS } from '@/libs/commerce/pricing';
import { orderStateSchema } from '@/libs/commerce/transaction-contracts';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import sellerOffersCapture from '@/test/fixtures/commerce/live/seller-offers-v062.json';
import { ACCEPTED_OFFER_AWARD_WIRE_FIXTURE, createOfferFixture } from '@/test/fixtures/commerce/offers';
import { createBitcoinQuotedOrderFixture, createOrderFixture } from '@/test/fixtures/commerce/orders';
import { LIVE_OFFER_ORDER_WIRE_FIXTURE } from '@/test/fixtures/commerce/orders-award.wire';
import {
  createAuctionProjectionFixture,
  createViewerBidAuctionProjectionFixture,
} from '@/test/fixtures/commerce/projections';
import sellerPaidShippingAddress from '@/test/fixtures/commerce/seller-paid-shipping-address.json';
import {
  isMarketplaceAwardCheckoutEligible,
  marketplaceBidHistorySchema,
  marketplaceBitcoinQuoteSchema,
  marketplaceDeliveryAddressSchema,
  marketplaceListingProjectionSchema,
  marketplaceOfferSchema,
  marketplaceOrderProjectionSchema,
  marketplaceOrderSchema,
  marketplaceParticipantOrderSchema,
  marketplaceSellerListingProjectionSchema,
  stripSellerReserveAuthorityFields,
} from './marketplace-projections';

/**
 * Taxation was removed from the marketplace: no tax computation in checkout
 * (the sandbox service no longer adds an 8% line), no `tax` money field on
 * the order projection, and no Tax line in the UI.
 *
 * This test is the guard against it coming back: the shared order-projection
 * schema must not expose a `tax` field, and a wire payload that still
 * carries one (a stale or non-conforming service) must not surface it in the
 * parsed order the UI renders from.
 */
describe('marketplace order projection — taxation removed', () => {
  it('exposes no tax field and a tax-free total on a valid order', () => {
    const fixture = createOrderFixture('pending_payment');
    const parsed = marketplaceOrderSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('tax' in parsed.data).toBe(false);
      // The total stands on its own: subtotal + shipping, nothing added for tax.
      expect(parsed.data.total.amountMinor).toBe(parsed.data.subtotal.amountMinor + parsed.data.shipping.amountMinor);
    }
  });

  it('ignores a tax field on the wire rather than reintroducing it', () => {
    const fixture = createOrderFixture('pending_payment');
    const payload = { ...fixture, tax: { amountMinor: 1_096, currency: 'USD', exponent: 2 } };
    const parsed = marketplaceOrderSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // `.passthrough()` keeps unknown wire keys on the object; the declared
      // projection (schema shape / parse result fields the UI types from)
      // must still omit `tax`.
      expect('tax' in marketplaceOrderProjectionSchema.shape).toBe(false);
      expect(parsed.data.total.amountMinor).toBe(parsed.data.subtotal.amountMinor + parsed.data.shipping.amountMinor);
    }
  });
});

describe('marketplace seller delivery address projection', () => {
  it('parses the captured plaintext_v1 contract fixture through wire casing', () => {
    const parsed = marketplaceDeliveryAddressSchema.safeParse(toCamelCaseWire(sellerPaidShippingAddress));

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        format: 'plaintext_v1',
        address: {
          name: 'Alice Buyer',
          line1: '1 Market Street',
          line2: '',
          city: 'New York',
          region: 'NY',
          postalCode: '10001',
          countryCode: 'US',
        },
      });
    }
  });

  it.each([
    ['absent undefined', undefined, undefined],
    ['null', null, undefined],
    ['string', '1 Market Street', { format: 'unsupported' }],
    ['number', 12, { format: 'unsupported' }],
    ['untagged object', { address: { name: 'legacy' } }, { format: 'unsupported' }],
    ['unknown format', { format: 'ciphertext_v1', value: 'secret' }, { format: 'unsupported' }],
    [
      'malformed plaintext country code',
      {
        format: 'plaintext_v1',
        address: {
          name: 'Alice Buyer',
          line1: '1 Market Street',
          line2: '',
          city: 'New York',
          region: 'NY',
          postalCode: '10001',
          countryCode: 'USA',
        },
      },
      { format: 'unsupported' },
    ],
    [
      'malformed plaintext line one',
      {
        format: 'plaintext_v1',
        address: {
          name: 'Alice Buyer',
          line1: 'a'.repeat(201),
          line2: '',
          city: 'New York',
          region: 'NY',
          postalCode: '10001',
          countryCode: 'US',
        },
      },
      { format: 'unsupported' },
    ],
  ])('parses %s delivery addresses without failing the order', (_name, deliveryAddress, expected) => {
    const parsed = marketplaceOrderSchema.safeParse({
      ...createOrderFixture('paid'),
      ...(deliveryAddress === undefined ? {} : { deliveryAddress }),
    });
    const participantParsed = marketplaceParticipantOrderSchema.safeParse({
      ...createOrderFixture('paid'),
      ...(deliveryAddress === undefined ? {} : { deliveryAddress }),
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.deliveryAddress).toEqual(expected);
    }
    expect(participantParsed.success).toBe(true);
    if (participantParsed.success) expect('deliveryAddress' in participantParsed.data).toBe(false);
  });
});

describe('marketplace order projection — Bitcoin quote', () => {
  const quote = (quotedSats: number) => ({
    quotedSats,
    currency: null,
    exponent: null,
    rate: null,
    source: null,
    fetchedAt: null,
    expiresAt: null,
    spreadBps: null,
  });

  it('parses the live FX-quoted Bitcoin order shape', () => {
    const parsed = marketplaceOrderSchema.safeParse(createBitcoinQuotedOrderFixture());

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bitcoinQuote).toMatchObject({
        quotedSats: 2_588,
        currency: 'USD',
        exponent: 2,
        expiresAt: '2026-09-13T20:15:09.050Z',
      });
    }
  });

  it.each(['pending', 'delivered', 'failed', 'a_future_state', null])(
    'carries paykit_delivery_state=%s from the wire without failing the order',
    (value) => {
      const parsed = marketplaceOrderSchema.safeParse({
        ...createOrderFixture('pending_payment'),
        ...(toCamelCaseWire({ paykit_delivery_state: value }) as Record<string, unknown>),
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.paykitDeliveryState).toBe(value);
    },
  );

  it.each([undefined, null])('accepts an order with bitcoin_quote %s', (bitcoinQuote) => {
    const parsed = marketplaceOrderSchema.safeParse({
      ...createOrderFixture('pending_payment'),
      bitcoinQuote,
    });

    expect(parsed.success).toBe(true);
  });

  it.each([0, -1, 1.5, Infinity, MAX_BITCOIN_BASE_UNITS + 1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects quotedSats=%s',
    (quotedSats) => {
      expect(marketplaceBitcoinQuoteSchema.safeParse(quote(quotedSats)).success).toBe(false);
    },
  );

  it.each([1, MAX_BITCOIN_BASE_UNITS])('accepts quotedSats=%s', (quotedSats) => {
    expect(marketplaceBitcoinQuoteSchema.safeParse(quote(quotedSats)).success).toBe(true);
  });

  it.each(['77287', 100_000, null])('accepts rate=%s', (rate) => {
    expect(marketplaceBitcoinQuoteSchema.safeParse({ ...quote(2_588), rate }).success).toBe(true);
  });

  it('relies on installed Zod to reject unsafe integers', () => {
    expect(Number.MAX_SAFE_INTEGER + 1).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(marketplaceBitcoinQuoteSchema.shape.quotedSats.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });
});

describe('marketplace order projection — offer-priced orders', () => {
  it('parses the captured offer-priced order through wire casing', () => {
    const parsed = marketplaceOrderSchema.safeParse(toCamelCaseWire(LIVE_OFFER_ORDER_WIRE_FIXTURE));

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pricedFrom).toBe('offer');
      expect(parsed.data.offerAwardId).toBe('bf50a192-3b30-46af-9c41-909b2bf7f784');
      expect(parsed.data.lines[0]).toMatchObject({
        pricedFrom: 'offer',
        offerId: '9ff7f42a-4380-4144-b7d6-3ac6ec7b4a56',
        awardId: 'bf50a192-3b30-46af-9c41-909b2bf7f784',
      });
    }
  });

  it('keeps ordinary order fixtures parsing unchanged', () => {
    expect(marketplaceOrderSchema.safeParse(createOrderFixture('pending_payment')).success).toBe(true);
    expect(marketplaceOrderSchema.safeParse(createBitcoinQuotedOrderFixture()).success).toBe(true);
  });
});

describe('marketplace order projection — digital lines (digital delivery design §2)', () => {
  it('reads the kind each digital line was bought as, and ignores an unknown kind', () => {
    const order = createOrderFixture('paid');
    const parsed = marketplaceOrderSchema.parse({
      ...order,
      fulfillment: 'digital',
      lines: [
        { ...order.lines[0], fulfillment: 'digital', digitalKind: 'file' },
        { ...order.lines[0], fulfillment: 'digital', digitalKind: 'hologram' },
      ],
    });
    expect(parsed.fulfillment).toBe('digital');
    expect(parsed.lines.map((line) => line.digitalKind)).toEqual(['file', undefined]);
  });
});

describe('marketplace order projection — partial refund', () => {
  it('keeps refunded_partial off the vendored order enum and readable on the order projection', () => {
    expect(orderStateSchema.safeParse('refunded_partial').success).toBe(false);
    const parsed = marketplaceOrderSchema.safeParse(
      createOrderFixture('refunded_partial', {
        total: { amountMinor: 250, currency: 'USD', exponent: 2 },
        externalRefund: {
          amountMinor: 189,
          transactionId: 'PAYPAL-REFUND-189',
          recordedAt: '2026-08-19T18:00:00.000Z',
        },
      }),
    );

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.state).toBe('refunded_partial');
      expect(parsed.data.externalRefund).toMatchObject({ amountMinor: 189, transactionId: 'PAYPAL-REFUND-189' });
    }
  });
});

describe('marketplace offer projection — award degradation', () => {
  const restoreRedactedIdentities = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll('…', 'z'.repeat(44));
    if (Array.isArray(value)) return value.map(restoreRedactedIdentities);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoreRedactedIdentities(entry)]));
    }
    return value;
  };

  it('parses the captured seller list and preserves row-level award eligibility', () => {
    const offers = sellerOffersCapture.offers.map((offer) =>
      marketplaceOfferSchema.parse(toCamelCaseWire(restoreRedactedIdentities(offer))),
    );

    expect(offers).toHaveLength(sellerOffersCapture.offers.length);
    expect(offers.find((offer) => offer.state === 'converted')?.award).toBeDefined();
    expect(offers.filter((offer) => offer.state === 'pending').every((offer) => offer.award === undefined)).toBe(true);
    const converted = offers.find((offer) => offer.state === 'converted');
    expect(converted?.state).not.toBe('accepted');
    expect(isMarketplaceAwardCheckoutEligible(converted?.award)).toBe(true);
  });

  it('does not offer checkout for a legacy expired row', () => {
    const expired = restoreRedactedIdentities({
      ...sellerOffersCapture.offers[0],
      state: 'expired',
      award: null,
    });

    const parsed = marketplaceOfferSchema.parse(toCamelCaseWire(expired));

    expect(parsed.state).toBe('expired');
    expect(parsed.award).toBeUndefined();
    expect(isMarketplaceAwardCheckoutEligible(parsed.award)).toBe(false);
  });

  it('drops only the corrupted award while preserving the rest of the list', () => {
    const offers = sellerOffersCapture.offers.map((offer) =>
      marketplaceOfferSchema.parse(toCamelCaseWire(restoreRedactedIdentities(offer))),
    );
    const corrupted = {
      ...offers[2],
      award: { id: 'not-a-uuid' },
    };

    const parsed = offers.map((offer, index) => marketplaceOfferSchema.parse(index === 2 ? corrupted : offer));

    expect(parsed).toHaveLength(offers.length);
    expect(parsed[2].award).toBeUndefined();
    expect(parsed[0].state).toBe('pending');
    expect(parsed[1].state).toBe('pending');
  });

  it('parses the accepted award wire fixture through casing and the offer schema', () => {
    const parsed = marketplaceOfferSchema.safeParse(
      toCamelCaseWire({
        ...createOfferFixture('accepted'),
        award: {
          ...ACCEPTED_OFFER_AWARD_WIRE_FIXTURE,
          id: '018f47d2-6a27-7c23-b51e-000000000902',
        },
      }),
    );

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.award).toMatchObject({
        subtotal: { amountMinor: expect.any(Number) },
        shipping: { amountMinor: expect.any(Number) },
        merchandiseTotal: { amountMinor: expect.any(Number) },
        unitPrice: { amountMinor: expect.any(Number) },
      });
    }
  });

  const offer = {
    id: '018f47d2-6a27-7c23-b51e-000000000001',
    aggregateId: 'offer:018f47d2-6a27-7c23-b51e-000000000002',
    listingAggregateId: 'listing:' + 's'.repeat(52) + '_boots',
    buyerPubky: 'b'.repeat(52),
    sellerPubky: 's'.repeat(52),
    revision: 2,
    state: 'accepted',
    offeredBy: 'b'.repeat(52),
    amount: { amountMinor: 1000, currency: 'USD', exponent: 2 },
    quantity: 1,
    message: '',
    expiresAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    award: {
      id: '018f47d2-6a27-7c23-b51e-000000000003',
      state: 'active',
      listing: {
        aggregateId: 'listing:' + 's'.repeat(52) + '_boots',
        sellerPubky: 's'.repeat(52),
        listingId: 'boots',
        title: 'Boots',
        listingRevision: 1,
        listingRecordSha256: 'a'.repeat(64),
      },
      variant: { id: 'variant_1', sku: null, options: [] },
      unitPrice: { amountMinor: 1000, currency: 'USD', exponent: 2 },
      quantity: 1,
      acceptedAt: '2026-09-15T00:00:00.000Z',
      convertBy: '2026-09-15T00:30:00.000Z',
      convertedOrderId: null,
      subtotal: { amountMinor: 1000, currency: 'USD', exponent: 2 },
      shipping: { amountMinor: 100, currency: 'USD', exponent: 2 },
      merchandiseTotal: { amountMinor: 1100, currency: 'USD', exponent: 2 },
    },
  };

  it('keeps a valid award on the accepted row', () => {
    expect(marketplaceOfferSchema.parse(offer).award?.id).toBe(offer.award.id);
  });

  it('drops only a malformed optional award', () => {
    const parsed = marketplaceOfferSchema.parse({ ...offer, award: { id: 'not-a-uuid' } });
    expect(parsed.state).toBe('accepted');
    expect(parsed.award).toBeUndefined();
  });

  it.each(['subtotal', 'shipping', 'merchandiseTotal'])('drops an award missing %s', (field) => {
    const award = { ...offer.award };
    delete award[field as keyof typeof award];
    const parsed = marketplaceOfferSchema.parse({ ...offer, award });
    expect(parsed.award).toBeUndefined();
  });

  it('drops an award whose money fields use different currency or exponent', () => {
    const parsed = marketplaceOfferSchema.parse({
      ...offer,
      award: { ...offer.award, shipping: { amountMinor: 100, currency: 'EUR', exponent: 2 } },
    });
    expect(parsed.award).toBeDefined();
    expect(isMarketplaceAwardCheckoutEligible(parsed.award)).toBe(false);
  });
});

describe('marketplace listing projection — viewer bid', () => {
  it.each(['reservePrice', 'reserve_price', 'reserveMet', 'reserve_met'])('rejects a nested public %s leak', (key) => {
    const fixture = createAuctionProjectionFixture() as Record<string, unknown>;
    fixture.extension = { nested: [{ [key]: null }] };
    expect(marketplaceListingProjectionSchema.safeParse(fixture).success).toBe(false);
  });

  it('accepts reserve authority only in the seller projection', () => {
    const fixture = {
      ...createAuctionProjectionFixture(),
      reservePrice: { amountMinor: 8_000, currency: 'USD', exponent: 2 },
      reserveMet: false,
      reserveRecordRevision: 1,
      lastReserveCommandId: '00000000-0000-4000-8000-000000000001',
    };
    expect(marketplaceListingProjectionSchema.safeParse(fixture).success).toBe(false);
    expect(marketplaceSellerListingProjectionSchema.safeParse(fixture).success).toBe(true);
  });

  it('rejects a live auction seller projection with null reserve command extras', () => {
    const live = {
      ...createAuctionProjectionFixture(),
      auction: { ...createAuctionProjectionFixture().auction!, status: 'active' },
      reservePrice: null,
      reserveMet: false,
      reserveRecordRevision: 0,
      lastReserveCommandId: null,
    };
    expect(marketplaceSellerListingProjectionSchema.safeParse(live).success).toBe(false);
    expect(
      marketplaceSellerListingProjectionSchema.safeParse({
        ...createAuctionProjectionFixture(),
        auction: { ...createAuctionProjectionFixture().auction!, status: 'scheduled' },
        lastReserveCommandId: null,
        reserveRecordRevision: 0,
      }).success,
    ).toBe(false);
  });

  it('accepts an ended auction seller projection with null or absent reserve authority', () => {
    const fixture = {
      ...createAuctionProjectionFixture(),
      auction: {
        ...createAuctionProjectionFixture().auction!,
        status: 'sold',
        endsAt: '2026-08-21T09:00:00.000Z',
      },
      reservePrice: null,
      reserveMet: false,
      reserveRecordRevision: 0,
      lastReserveCommandId: null,
    };
    expect(marketplaceSellerListingProjectionSchema.safeParse(fixture).success).toBe(true);
    expect(
      marketplaceSellerListingProjectionSchema.safeParse({
        ...createAuctionProjectionFixture(),
        auction: { ...createAuctionProjectionFixture().auction!, status: 'unsold' },
      }).success,
    ).toBe(true);
  });

  it('strips seller reserve authority keys before a public parse', () => {
    const stripped = stripSellerReserveAuthorityFields({
      ...createAuctionProjectionFixture(),
      reservePrice: null,
      reserve_met: false,
      reserveRecordRevision: 0,
      last_reserve_command_id: null,
    }) as Record<string, unknown>;
    expect(stripped).not.toHaveProperty('reservePrice');
    expect(stripped).not.toHaveProperty('reserve_met');
    expect(stripped).not.toHaveProperty('reserveRecordRevision');
    expect(stripped).not.toHaveProperty('last_reserve_command_id');
    expect(marketplaceListingProjectionSchema.safeParse(stripped).success).toBe(true);
  });

  it('parses the live bidder viewer_bid shape', () => {
    const parsed = marketplaceListingProjectionSchema.safeParse(createViewerBidAuctionProjectionFixture());

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.viewerBid).toEqual({
        maximumAmount: { amountMinor: 7_000, currency: 'USD', exponent: 2 },
        minimumNextBid: { amountMinor: 7_001, currency: 'USD', exponent: 2 },
      });
    }
  });

  it('accepts projections without viewer_bid for sellers and other bidders', () => {
    const parsed = marketplaceListingProjectionSchema.safeParse(createAuctionProjectionFixture());

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.viewerBid).toBeUndefined();
  });

  it.each([
    ['currency', { currency: 'EUR' }],
    ['exponent', { exponent: 3 }],
  ])('drops viewer_bid when its %s does not match the auction money', (_field, mismatch) => {
    const fixture = createViewerBidAuctionProjectionFixture();
    fixture.viewerBid = {
      ...fixture.viewerBid!,
      minimumNextBid: { ...fixture.viewerBid!.minimumNextBid, ...mismatch },
    };

    const parsed = marketplaceListingProjectionSchema.safeParse(fixture);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.viewerBid).toBeUndefined();
      expect(parsed.data.auction?.currentPrice.amountMinor).toBe(4_500);
      expect(parsed.data.auction?.minimumIncrement.amountMinor).toBe(500);
    }
  });

  it('drops viewer_bid when maximumAmount alone has a currency mismatch', () => {
    const fixture = createViewerBidAuctionProjectionFixture();
    fixture.viewerBid = {
      ...fixture.viewerBid!,
      maximumAmount: { ...fixture.viewerBid!.maximumAmount, currency: 'EUR' },
    };

    const parsed = marketplaceListingProjectionSchema.safeParse(fixture);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.viewerBid).toBeUndefined();
  });

  it('drops viewer_bid when minimumIncrement alone has a currency mismatch', () => {
    const fixture = createViewerBidAuctionProjectionFixture();
    fixture.auction = {
      ...fixture.auction!,
      minimumIncrement: { ...fixture.auction!.minimumIncrement, currency: 'EUR' },
    };

    const parsed = marketplaceListingProjectionSchema.safeParse(fixture);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.viewerBid).toBeUndefined();
  });

  it('drops viewer_bid when minimumIncrement alone has an exponent mismatch', () => {
    const fixture = createViewerBidAuctionProjectionFixture();
    fixture.auction = {
      ...fixture.auction!,
      minimumIncrement: { ...fixture.auction!.minimumIncrement, exponent: 3 },
    };

    const parsed = marketplaceListingProjectionSchema.safeParse(fixture);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.viewerBid).toBeUndefined();
  });

  it('keeps viewer_bid when all bid money fields match the auction', () => {
    const parsed = marketplaceListingProjectionSchema.safeParse(createViewerBidAuctionProjectionFixture());

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.viewerBid).toBeDefined();
  });
});

describe('marketplace bid history reserve secrecy', () => {
  it.each(['reservePrice', 'reserve_price', 'reserveMet', 'reserve_met'])(
    'rejects nested %s from the public auction summary',
    (key) => {
      expect(
        marketplaceBidHistorySchema.safeParse({
          bids: [],
          auction: {
            endsAt: '2026-08-21T09:00:00.000Z',
            status: 'active',
            bidCount: 0,
            extension: [{ [key]: null }],
          },
          serverTime: '2026-08-20T09:00:00.000Z',
        }).success,
      ).toBe(false);
    },
  );
});

describe('marketplace order projection — PayPal refund notification fields', () => {
  // Key names and value types from pubky-marketplace-service 94ecb0d
  // `contracts/samples/projections.json` and `OrderRow::view`.
  const wire = (values: Record<string, unknown>) => ({
    ...createOrderFixture('refunded_external'),
    ...(toCamelCaseWire(values) as Record<string, unknown>),
  });

  it('reads the reversal, cancelled-reversal, review, and hold fields through wire casing', () => {
    const parsed = marketplaceOrderSchema.parse(
      wire({
        payment_reversed_at: '2026-09-24T18:00:00.000Z',
        payment_reversal_cancelled_at: null,
        gateway_refund_review_at: '2026-09-24T18:05:00.000Z',
        gateway_refund_unmatched: true,
      }),
    );
    expect(parsed.paymentReversedAt).toBe('2026-09-24T18:00:00.000Z');
    expect(parsed.paymentReversalCancelledAt).toBeNull();
    expect(parsed.gatewayRefundReviewAt).toBe('2026-09-24T18:05:00.000Z');
    expect(parsed.gatewayRefundUnmatched).toBe(true);
  });

  it('keeps the order when a refund flag is malformed and drops only that flag', () => {
    const parsed = marketplaceOrderSchema.parse(
      wire({ payment_reversed_at: 17, gateway_refund_review_at: {}, gateway_refund_unmatched: 'yes' }),
    );
    expect(parsed.paymentReversedAt).toBeNull();
    expect(parsed.gatewayRefundReviewAt).toBeNull();
    expect(parsed.gatewayRefundUnmatched).toBe(false);
  });
});
