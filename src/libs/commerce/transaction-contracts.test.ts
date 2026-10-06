import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  auctionStateSchema,
  COMMERCE_CONTRACT_VERSION,
  commerceAggregateIdSchema,
  commerceCommandBaseSchema,
  commerceCurrencySchema,
  commerceEventBaseSchema,
  commerceMoneySchema,
  commercePositiveMoneySchema,
  commercePubkySchema,
  createCommerceCommandResultSchema,
  createCommerceCommandSchema,
  createCommerceEventSchema,
  listingStateSchema,
  offerStateSchema,
  orderStateSchema,
  paymentStateSchema,
  reservationStateSchema,
} from './transaction-contracts';

const PUBKY = 'y'.repeat(52);
const COMMAND_ID = '018f47d2-6a27-7c23-a49d-6b21bb770120';
const EVENT_ID = '018f47d2-6a27-7c23-a49d-6b21bb770121';
const ISSUED_AT = '2026-08-19T22:00:00.000Z';

describe('commerce transaction contract primitives', () => {
  it('accepts a closed versioned command contract', () => {
    const schema = createCommerceCommandSchema(
      'inventory.reserve',
      z
        .object({
          listingId: z.string(),
          quantity: z.number().int().positive(),
        })
        .strict(),
    );

    expect(
      schema.parse({
        version: COMMERCE_CONTRACT_VERSION,
        commandId: COMMAND_ID,
        aggregateId: 'listing:boots_01',
        expectedRevision: 7,
        issuedAt: ISSUED_AT,
        kind: 'inventory.reserve',
        payload: {
          listingId: 'boots_01',
          quantity: 1,
        },
      }),
    ).toEqual({
      version: COMMERCE_CONTRACT_VERSION,
      commandId: COMMAND_ID,
      aggregateId: 'listing:boots_01',
      expectedRevision: 7,
      issuedAt: ISSUED_AT,
      kind: 'inventory.reserve',
      payload: {
        listingId: 'boots_01',
        quantity: 1,
      },
    });
  });

  it('rejects unknown command fields and changed command kinds', () => {
    const schema = createCommerceCommandSchema('offer.accept', z.object({ offerId: z.string() }).strict());
    const command = {
      version: COMMERCE_CONTRACT_VERSION,
      commandId: COMMAND_ID,
      aggregateId: 'offer:offer_01',
      expectedRevision: 2,
      issuedAt: ISSUED_AT,
      kind: 'offer.reject',
      payload: { offerId: 'offer_01' },
      actorPubky: PUBKY,
    };

    expect(schema.safeParse(command).success).toBe(false);
  });

  it.each([
    ['negative revision', { expectedRevision: -1 }],
    ['fractional revision', { expectedRevision: 1.5 }],
    ['invalid timestamp', { issuedAt: 'tomorrow' }],
    ['invalid command id', { commandId: 'command-1' }],
    ['invalid aggregate id', { aggregateId: '../listing' }],
  ])('rejects %s', (_label, replacement) => {
    const result = commerceCommandBaseSchema.safeParse({
      version: COMMERCE_CONTRACT_VERSION,
      commandId: COMMAND_ID,
      aggregateId: 'listing:boots_01',
      expectedRevision: 0,
      issuedAt: ISSUED_AT,
      ...replacement,
    });

    expect(result.success).toBe(false);
  });

  it('accepts a closed immutable event contract', () => {
    const schema = createCommerceEventSchema(
      'inventory.reserved',
      z.object({ quantity: z.number().int().positive() }).strict(),
    );

    expect(
      schema.parse({
        version: COMMERCE_CONTRACT_VERSION,
        eventId: EVENT_ID,
        commandId: COMMAND_ID,
        aggregateId: 'listing:boots_01',
        revision: 8,
        actorPubky: PUBKY,
        occurredAt: ISSUED_AT,
        kind: 'inventory.reserved',
        payload: { quantity: 1 },
      }),
    ).toMatchObject({
      eventId: EVENT_ID,
      revision: 8,
      kind: 'inventory.reserved',
    });
  });

  it('rejects revision zero for events', () => {
    expect(
      commerceEventBaseSchema.safeParse({
        version: COMMERCE_CONTRACT_VERSION,
        eventId: EVENT_ID,
        commandId: COMMAND_ID,
        aggregateId: 'listing:boots_01',
        revision: 0,
        actorPubky: PUBKY,
        occurredAt: ISSUED_AT,
      }).success,
    ).toBe(false);
  });

  it('accepts a command result tied to its revision and event ids', () => {
    const schema = createCommerceCommandResultSchema(z.object({ reservationId: z.string() }).strict());

    expect(
      schema.parse({
        version: COMMERCE_CONTRACT_VERSION,
        commandId: COMMAND_ID,
        aggregateId: 'listing:boots_01',
        revision: 8,
        eventIds: [EVENT_ID],
        result: { reservationId: 'reservation_01' },
      }),
    ).toMatchObject({
      commandId: COMMAND_ID,
      revision: 8,
      eventIds: [EVENT_ID],
    });
  });
});

describe('commerce identifiers and money', () => {
  it('accepts z-base-32 Pubky identities and typed aggregate ids', () => {
    expect(commercePubkySchema.parse(PUBKY)).toBe(PUBKY);
    expect(commerceAggregateIdSchema.parse('auction:auction_01')).toBe('auction:auction_01');
  });

  it.each(['short', '0'.repeat(52), `${'y'.repeat(51)}l`])('rejects invalid Pubky %s', (pubky) => {
    expect(commercePubkySchema.safeParse(pubky).success).toBe(false);
  });

  it.each(['usd', 'US$', 'TOO-LONG-ASSET', ''])('rejects invalid currency %s', (currency) => {
    expect(commerceCurrencySchema.safeParse(currency).success).toBe(false);
  });

  it('accepts integer minor-unit money including zero', () => {
    expect(
      commerceMoneySchema.parse({
        amountMinor: 1250,
        currency: 'USD',
        exponent: 2,
      }),
    ).toEqual({
      amountMinor: 1250,
      currency: 'USD',
      exponent: 2,
    });
  });

  it.each([
    { amountMinor: -1, currency: 'USD', exponent: 2 },
    { amountMinor: 1.5, currency: 'USD', exponent: 2 },
    { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'USD', exponent: 2 },
    { amountMinor: 1, currency: 'USD', exponent: 19 },
  ])('rejects unsafe money %#', (money) => {
    expect(commerceMoneySchema.safeParse(money).success).toBe(false);
  });

  it('requires positive money when a command transfers value', () => {
    expect(commercePositiveMoneySchema.safeParse({ amountMinor: 0, currency: 'BTC', exponent: 8 }).success).toBe(false);
    expect(commercePositiveMoneySchema.safeParse({ amountMinor: 10_000, currency: 'BTC', exponent: 8 }).success).toBe(
      true,
    );
  });
});

describe('commerce state vocabularies', () => {
  it.each([
    [listingStateSchema, 'reserved'],
    [reservationStateSchema, 'converted'],
    [offerStateSchema, 'countered'],
    [auctionStateSchema, 'unsold'],
    [paymentStateSchema, 'detected'],
    [orderStateSchema, 'return_approved'],
    // Wave 7 local pickup (§A6): the state the seller's `fulfillment.mark_ready` arms.
    [orderStateSchema, 'ready_for_pickup'],
  ])('accepts a canonical state', (schema, state) => {
    expect(schema.parse(state)).toBe(state);
  });

  it.each([
    listingStateSchema,
    reservationStateSchema,
    offerStateSchema,
    auctionStateSchema,
    paymentStateSchema,
    orderStateSchema,
  ])('rejects unknown states', (schema) => {
    expect(schema.safeParse('processing_payment').success).toBe(false);
  });

  it.each([
    [listingStateSchema, 'draft'],
    [listingStateSchema, 'paused'],
    [paymentStateSchema, 'created'],
    [paymentStateSchema, 'window_elapsed'],
    [paymentStateSchema, 'external_refund_required'],
    [orderStateSchema, 'return_in_transit'],
    [orderStateSchema, 'return_inspection'],
  ])('rejects states the canonical service contract resolved away', (schema, state) => {
    expect(schema.safeParse(state).success).toBe(false);
  });
});
