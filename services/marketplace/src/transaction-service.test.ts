import { describe, expect, it } from 'vitest';
import expectedWave7StateMachines from '../contracts/expected-state-machines.wave7.json';
import {
  buildMarketplaceCheckoutAggregateId,
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
  buildMarketplaceOfferAggregateId,
  buildMarketplacePaymentAggregateId,
} from './contracts';
import {
  buildPrototypeStateMachineDocument,
  InMemoryMarketplaceRepository,
  MarketplaceTransactionService,
  ORDER_AUTO_COMPLETE_AFTER_MS,
} from './transaction-service';

const SELLER = 'y'.repeat(52);
const BUYER = 'b'.repeat(52);
const OTHER_BUYER = 'n'.repeat(52);
const AGGREGATE_ID = buildMarketplaceListingAggregateId(SELLER, 'boots_01');
const NOW = new Date('2026-08-19T22:00:00.000Z');
const REGISTER_COMMAND_ID = '018f47d2-6a27-7c23-a49d-6b21bb770120';

function registerCommand(quantity = 1, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    commandId: REGISTER_COMMAND_ID,
    aggregateId: AGGREGATE_ID,
    expectedRevision: 0,
    issuedAt: NOW.toISOString(),
    kind: 'listing.register',
    payload: {
      sellerPubky: SELLER,
      listingId: 'boots_01',
      listingRevision: 1,
      contentHash: 'a'.repeat(64),
      quantity,
      unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
    },
    ...overrides,
  };
}

function registerAuctionCommand() {
  return registerCommand(1, {
    commandId: '00000000-0000-4000-8000-000000000600',
    payload: {
      ...registerCommand().payload,
      listingRevision: 1,
      unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      saleFormat: 'auction',
      auctionTerms: {
        startsAt: NOW.toISOString(),
        endsAt: new Date(NOW.getTime() + 10 * 60 * 1_000).toISOString(),
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        antiSnipingWindowSeconds: 60,
        antiSnipingExtensionSeconds: 120,
      },
      auctionReserve: {
        expectedRecordRevision: 0,
        recordRevision: 1,
        reservePrice: { amountMinor: 6_000, currency: 'USD', exponent: 2 },
      },
    },
  });
}

function reserveCommand(index = 1, quantity = 1, expectedRevision = 1) {
  return {
    version: 1,
    commandId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    aggregateId: AGGREGATE_ID,
    expectedRevision,
    issuedAt: NOW.toISOString(),
    kind: 'inventory.reserve',
    payload: {
      quantity,
      reservationTtlSeconds: 600,
    },
  };
}

function createOfferCommand(quantity = 1) {
  return {
    version: 1,
    commandId: '00000000-0000-4000-8000-000000000500',
    aggregateId: AGGREGATE_ID,
    expectedRevision: 1,
    issuedAt: NOW.toISOString(),
    kind: 'offer.create',
    payload: {
      amount: { amountMinor: 10_000, currency: 'USD', exponent: 2 },
      quantity,
      expiresInSeconds: 3_600,
      message: 'Would you take this?',
    },
  };
}

function offerAction(
  kind: 'offer.accept' | 'offer.reject' | 'offer.withdraw',
  expectedRevision: number,
  commandId: string,
) {
  const offerId = createOfferCommand().commandId;
  return {
    version: 1,
    commandId,
    aggregateId: buildMarketplaceOfferAggregateId(offerId),
    expectedRevision,
    issuedAt: NOW.toISOString(),
    kind,
    payload: { offerId },
  };
}

function counterOfferCommand(expectedRevision = 1) {
  const offerId = createOfferCommand().commandId;
  return {
    version: 1,
    commandId: '00000000-0000-4000-8000-000000000501',
    aggregateId: buildMarketplaceOfferAggregateId(offerId),
    expectedRevision,
    issuedAt: NOW.toISOString(),
    kind: 'offer.counter',
    payload: {
      offerId,
      amount: { amountMinor: 11_000, currency: 'USD', exponent: 2 },
      quantity: 1,
      expiresInSeconds: 3_600,
      message: 'Meet me here.',
    },
  };
}

function placeBidCommand(actorIndex: number, maximumMinor: number, expectedRevision: number) {
  return {
    version: 1,
    commandId: `00000000-0000-4000-8001-${actorIndex.toString().padStart(12, '0')}`,
    aggregateId: AGGREGATE_ID,
    expectedRevision,
    issuedAt: NOW.toISOString(),
    kind: 'auction.place_bid',
    payload: {
      maximumAmount: { amountMinor: maximumMinor, currency: 'USD', exponent: 2 },
    },
  };
}

function messageCommand(sender: string, recipient: string, expectedRevision: number, commandId: string, text: string) {
  const buyer = sender === SELLER ? recipient : sender;
  return {
    version: 1,
    commandId,
    aggregateId: buildMarketplaceConversationAggregateId(SELLER, buyer, 'boots_01'),
    expectedRevision,
    issuedAt: NOW.toISOString(),
    kind: 'message.send',
    payload: {
      listingAggregateId: AGGREGATE_ID,
      recipientPubky: recipient,
      text,
      attachmentIds: [] as string[],
    },
  };
}

function closeAuctionCommand(expectedRevision: number, commandNumber = 950) {
  return {
    version: 1,
    commandId: `00000000-0000-4000-8000-${commandNumber.toString().padStart(12, '0')}`,
    aggregateId: AGGREGATE_ID,
    expectedRevision,
    issuedAt: NOW.toISOString(),
    kind: 'auction.close',
    payload: {},
  };
}

function notificationPreferencesCommand(expectedRevision: number, messages: boolean, commandNumber = 960) {
  return {
    version: 1,
    commandId: `00000000-0000-4000-8000-${commandNumber.toString().padStart(12, '0')}`,
    aggregateId: `notification_preferences:${SELLER}`,
    expectedRevision,
    issuedAt: NOW.toISOString(),
    kind: 'notification.preferences.update',
    payload: { messages, offers: true, bids: true, auctions: true },
  };
}

function checkoutCommand() {
  const commandId = '00000000-0000-4000-8000-000000001000';
  return {
    version: 1,
    commandId,
    aggregateId: buildMarketplaceCheckoutAggregateId(commandId),
    expectedRevision: 0,
    issuedAt: NOW.toISOString(),
    kind: 'checkout.create',
    payload: {
      lines: [{ listingAggregateId: AGGREGATE_ID, expectedRevision: 1, quantity: 1 }],
      deliveryAddress: {
        name: 'Alice Buyer',
        line1: '1 Market Street',
        line2: '',
        city: 'New York',
        region: 'NY',
        postalCode: '10001',
        countryCode: 'US',
      },
      guaranteePolicyVersion: 1,
    },
  };
}

function paymentCommand(
  paymentId: string,
  expectedRevision: number,
  target: 'detected' | 'confirmed' | 'expired' | 'manual_review',
  confirmations: number,
  commandNumber: number,
) {
  return {
    version: 1,
    commandId: `00000000-0000-4000-8000-${commandNumber.toString().padStart(12, '0')}`,
    aggregateId: buildMarketplacePaymentAggregateId(paymentId),
    expectedRevision,
    issuedAt: NOW.toISOString(),
    kind: 'payment.sandbox_advance',
    payload: { paymentId, target, confirmations },
  };
}

function orderCommand(
  kind: string,
  orderId: string,
  expectedRevision: number,
  payload: Record<string, unknown>,
  commandNumber: number,
) {
  return {
    version: 1,
    commandId: `00000000-0000-4000-8000-${commandNumber.toString().padStart(12, '0')}`,
    aggregateId: `order:${orderId}`,
    expectedRevision,
    issuedAt: NOW.toISOString(),
    kind,
    payload: { orderId, ...payload },
  };
}

function createService() {
  const repository = new InMemoryMarketplaceRepository();
  return {
    repository,
    service: new MarketplaceTransactionService(repository, () => new Date(NOW)),
  };
}

async function createPaidOrder(service: MarketplaceTransactionService) {
  await service.execute(SELLER, registerCommand());
  const checkout = await service.execute(BUYER, checkoutCommand());
  if (!checkout.ok || checkout.result.kind !== 'checkout') throw new Error('Checkout fixture failed');
  const payment = checkout.result.payments[0];
  const confirmed = await service.execute(BUYER, paymentCommand(payment.id, 1, 'confirmed', 1, 1_050));
  if (!confirmed.ok || confirmed.result.kind !== 'payment') throw new Error('Payment fixture failed');
  return confirmed.result.order;
}

// ---------------------------------------------------------------------------
// Wave 7 local-pickup fixtures — PART A of docs/ecommerce/local-pickup-design.md.
// ---------------------------------------------------------------------------

const SELLER_2 = 'c'.repeat(52);

function spotPickupDetails(spot: string) {
  return {
    location: { kind: 'spot', spot },
    instructions: 'Ring the bell twice; weekdays after 18:00.',
    availability: {
      kind: 'windows',
      zone: 'Europe/Lisbon',
      windows: [{ day: 'saturday', start: '10:00', end: '14:00' }],
    },
  };
}

const PICKUP_SPOT_DETAILS = spotPickupDetails('Central Station, north entrance');

function nextCommandIds(start: number) {
  let current = start;
  return () => `00000000-0000-4000-8000-${(++current).toString().padStart(12, '0')}`;
}

function registerFulfillmentCommand(
  seller: string,
  listingId: string,
  fulfillmentMethods: Array<'shipping' | 'pickup'>,
  commandId: string,
  quantity = 1,
) {
  return {
    version: 1,
    commandId,
    aggregateId: buildMarketplaceListingAggregateId(seller, listingId),
    expectedRevision: 0,
    issuedAt: NOW.toISOString(),
    kind: 'listing.register',
    payload: {
      sellerPubky: seller,
      listingId,
      listingRevision: 1,
      contentHash: 'a'.repeat(64),
      quantity,
      unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
      fulfillmentMethods,
    },
  };
}

function setPickupDetailsCommand(
  aggregateId: string,
  expectedVersion: number,
  commandId: string,
  details: unknown = PICKUP_SPOT_DETAILS,
) {
  return {
    version: 1,
    commandId,
    aggregateId,
    expectedRevision: expectedVersion,
    issuedAt: NOW.toISOString(),
    kind: 'pickup_details.set',
    payload: { details },
  };
}

function clearPickupDetailsCommand(aggregateId: string, expectedVersion: number, commandId: string) {
  return {
    version: 1,
    commandId,
    aggregateId,
    expectedRevision: expectedVersion,
    issuedAt: NOW.toISOString(),
    kind: 'pickup_details.clear',
    payload: {},
  };
}

function fulfillmentCheckoutCommand(
  commandId: string,
  lines: Array<{
    aggregateId: string;
    expectedRevision: number;
    quantity?: number;
    fulfillment?: 'shipping' | 'pickup';
  }>,
  withDeliveryAddress: boolean,
) {
  const base = checkoutCommand();
  return {
    ...base,
    commandId,
    aggregateId: buildMarketplaceCheckoutAggregateId(commandId),
    payload: {
      lines: lines.map((line) => ({
        listingAggregateId: line.aggregateId,
        expectedRevision: line.expectedRevision,
        quantity: line.quantity ?? 1,
        ...(line.fulfillment ? { fulfillment: line.fulfillment } : {}),
      })),
      ...(withDeliveryAddress ? { deliveryAddress: base.payload.deliveryAddress } : {}),
      guaranteePolicyVersion: 1,
    },
  };
}

/**
 * Non-sandbox ("durable") mode — used ONLY by tests that exercise the pickup
 * reveal path. The prototype IS the sandbox adapter, so the capability flag
 * is off by default; these tests explicitly enable non-sandbox mode and
 * confirm payments through the verification-worker path
 * (`confirmPaymentAsWorker`), never through `payment.sandbox_advance`, whose
 * pinned adapter the reveal refuses by design (§A3).
 */
function createDurableService(now: () => Date = () => new Date(NOW)) {
  const repository = new InMemoryMarketplaceRepository();
  return {
    repository,
    service: new MarketplaceTransactionService(repository, now, { sandboxPaymentsEnabled: false }),
  };
}

async function createConfirmedPickupOrder(
  service: MarketplaceTransactionService,
  nextId: () => string,
  options: { listingId?: string; details?: unknown; quantity?: number } = {},
) {
  const listingId = options.listingId ?? 'boots_pickup';
  const aggregateId = buildMarketplaceListingAggregateId(SELLER, listingId);
  await service.execute(
    SELLER,
    registerFulfillmentCommand(SELLER, listingId, ['pickup'], nextId(), options.quantity ?? 1),
  );
  await service.execute(
    SELLER,
    setPickupDetailsCommand(aggregateId, 0, nextId(), options.details ?? PICKUP_SPOT_DETAILS),
  );
  const checkoutId = nextId();
  const checkout = await service.execute(
    BUYER,
    fulfillmentCheckoutCommand(checkoutId, [{ aggregateId, expectedRevision: 1, fulfillment: 'pickup' }], false),
  );
  if (!checkout.ok || checkout.result.kind !== 'checkout') throw new Error('Pickup checkout fixture failed');
  const payment = checkout.result.payments[0];
  const confirmed = await service.confirmPaymentAsWorker(payment.id);
  if (!confirmed.ok) throw new Error('Worker confirmation fixture failed');
  return { order: confirmed.order, payment, aggregateId };
}

describe('MarketplaceTransactionService', () => {
  it('registers seller-owned inventory at revision one', async () => {
    const { repository, service } = createService();

    const result = await service.execute(SELLER, registerCommand());

    expect(result).toMatchObject({
      ok: true,
      aggregateId: AGGREGATE_ID,
      revision: 1,
      result: {
        kind: 'listing',
        listing: {
          availableQuantity: 1,
          reservedQuantity: 0,
          serverRevision: 1,
          state: 'available',
        },
      },
    });
    expect(repository.getEvents()).toHaveLength(1);
  });

  it('rejects registration by anyone other than the public listing seller', async () => {
    const { service } = createService();

    await expect(service.execute(BUYER, registerCommand())).resolves.toEqual({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Only the listing seller may register inventory.',
      },
    });
  });

  it('returns the exact stored result for an idempotent replay', async () => {
    const { repository, service } = createService();
    const command = registerCommand();

    const first = await service.execute(SELLER, command);
    const replay = await service.execute(SELLER, command);

    expect(replay).toEqual(first);
    expect(repository.getEvents()).toHaveLength(1);
  });

  it('rejects changed input under an already accepted command id', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());

    const changed = registerCommand(2);

    await expect(service.execute(SELLER, changed)).resolves.toEqual({
      ok: false,
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The command id was already used with different input.',
      },
    });
  });

  it('allows exactly one of 100 concurrent buyers to reserve one unit', async () => {
    const { repository, service } = createService();
    await service.execute(SELLER, registerCommand());

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => service.execute(BUYER, reserveCommand(index + 1))),
    );
    const accepted = results.filter(({ ok }) => ok);
    const rejected = results.filter(({ ok }) => !ok);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(99);
    expect(rejected.every((result) => !result.ok && result.error.code === 'REVISION_CONFLICT')).toBe(true);
    expect(repository.getListing(AGGREGATE_ID)).toMatchObject({
      availableQuantity: 0,
      reservedQuantity: 1,
      serverRevision: 2,
      state: 'reserved',
    });
    expect(repository.getEvents()).toHaveLength(2);
  });

  it('uses server time for reservation expiry', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());

    const result = await service.execute(BUYER, reserveCommand());

    expect(result).toMatchObject({
      ok: true,
      result: {
        kind: 'reservation',
        reservation: {
          createdAt: '2026-08-19T22:00:00.000Z',
          expiresAt: '2026-08-19T22:10:00.000Z',
        },
      },
    });
  });

  it('rejects seller self-reservation and stale buyer revisions', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());

    await expect(service.execute(SELLER, reserveCommand())).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });
    await expect(service.execute(BUYER, reserveCommand(2, 1, 0))).resolves.toMatchObject({
      ok: false,
      error: { code: 'REVISION_CONFLICT', currentRevision: 1 },
    });
  });

  it('prevents a seller update from reducing total quantity below reservations', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand(2));
    await service.execute(BUYER, reserveCommand(1, 2));
    const update = registerCommand(1, {
      commandId: '018f47d2-6a27-7c23-a49d-6b21bb770121',
      expectedRevision: 2,
      payload: {
        ...registerCommand(1).payload,
        listingRevision: 2,
      },
    });

    await expect(service.execute(SELLER, update)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVARIANT_VIOLATION', currentRevision: 2 },
    });
  });

  it('returns redacted validation issues for malformed commands', async () => {
    const { service } = createService();

    const result = await service.execute('not-a-pubky', {
      ...registerCommand(),
      privateAddress: 'secret-address',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_COMMAND',
        issues: expect.any(Array),
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret-address');
  });

  it('supports private offer, counteroffer, and atomic acceptance history', async () => {
    const { repository, service } = createService();
    await service.execute(SELLER, registerCommand(2));

    const created = await service.execute(BUYER, createOfferCommand());
    const countered = await service.execute(SELLER, counterOfferCommand());
    const accepted = await service.execute(
      BUYER,
      offerAction('offer.accept', 2, '00000000-0000-4000-8000-000000000502'),
    );

    expect(created).toMatchObject({
      ok: true,
      revision: 1,
      result: { kind: 'offer', offer: { buyerPubky: BUYER, sellerPubky: SELLER, state: 'pending' } },
    });
    expect(countered).toMatchObject({
      ok: true,
      revision: 2,
      result: { kind: 'offer', offer: { state: 'countered', offeredBy: SELLER, amount: { amountMinor: 11_000 } } },
    });
    expect(accepted).toMatchObject({
      ok: true,
      revision: 3,
      eventIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
      result: {
        kind: 'accepted_offer',
        offer: { state: 'accepted', revision: 3 },
        listing: { availableQuantity: 1, reservedQuantity: 1, serverRevision: 2 },
        reservation: { buyerPubky: BUYER, quantity: 1 },
      },
    });
    expect(repository.getOffer(createOfferCommand().commandId)?.history.map(({ action }) => action)).toEqual([
      'created',
      'countered',
      'accepted',
    ]);
  });

  it('enforces participant roles for counter, reject, and withdraw', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());
    await service.execute(BUYER, createOfferCommand());

    await expect(service.execute(BUYER, counterOfferCommand())).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });
    await expect(service.execute(OTHER_BUYER, counterOfferCommand())).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });
    await expect(
      service.execute(SELLER, offerAction('offer.withdraw', 1, '00000000-0000-4000-8000-000000000503')),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });
    await expect(
      service.execute(BUYER, offerAction('offer.reject', 1, '00000000-0000-4000-8000-000000000504')),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });
  });

  it('supports rejection by the recipient and withdrawal by the current author', async () => {
    const rejectedService = createService().service;
    await rejectedService.execute(SELLER, registerCommand());
    await rejectedService.execute(BUYER, createOfferCommand());
    await expect(
      rejectedService.execute(SELLER, offerAction('offer.reject', 1, '00000000-0000-4000-8000-000000000505')),
    ).resolves.toMatchObject({ ok: true, result: { offer: { state: 'rejected' } } });

    const withdrawnService = createService().service;
    await withdrawnService.execute(SELLER, registerCommand());
    await withdrawnService.execute(BUYER, createOfferCommand());
    await expect(
      withdrawnService.execute(BUYER, offerAction('offer.withdraw', 1, '00000000-0000-4000-8000-000000000506')),
    ).resolves.toMatchObject({ ok: true, result: { offer: { state: 'withdrawn' } } });
  });

  it('does not accept an offer after another buyer reserves the inventory', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());
    await service.execute(BUYER, createOfferCommand());
    await service.execute(OTHER_BUYER, reserveCommand(20));

    await expect(
      service.execute(SELLER, offerAction('offer.accept', 1, '00000000-0000-4000-8000-000000000507')),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INSUFFICIENT_INVENTORY' },
    });
  });

  it('rejects actions after server-time offer expiry', async () => {
    let now = new Date(NOW);
    const repository = new InMemoryMarketplaceRepository();
    const service = new MarketplaceTransactionService(repository, () => new Date(now));
    await service.execute(SELLER, registerCommand());
    await service.execute(BUYER, createOfferCommand());
    now = new Date(NOW.getTime() + 3_601_000);

    await expect(service.execute(SELLER, counterOfferCommand())).resolves.toMatchObject({
      ok: false,
      error: { code: 'OFFER_EXPIRED' },
    });
  });

  it('applies deterministic proxy bidding and reserve status', async () => {
    const { repository, service } = createService();
    await service.execute(SELLER, registerAuctionCommand());

    const first = await service.execute(BUYER, placeBidCommand(1, 10_000, 1));
    const second = await service.execute(OTHER_BUYER, placeBidCommand(2, 8_000, 2));

    expect(first).toMatchObject({
      ok: true,
      result: {
        kind: 'bid',
        listing: {
          auction: {
            currentPrice: { amountMinor: 4_500 },
            leaderPubky: BUYER,
            bidCount: 1,
          },
        },
      },
    });
    expect(second).toMatchObject({
      ok: true,
      revision: 3,
      result: {
        kind: 'bid',
        listing: {
          auction: {
            currentPrice: { amountMinor: 8_500 },
            leaderPubky: BUYER,
            bidCount: 2,
          },
        },
      },
    });
    expect(repository.getBidsForListing(AGGREGATE_ID)).toHaveLength(2);
  });

  it('uses first accepted sequence as the proxy-bid tie breaker', async () => {
    const { repository, service } = createService();
    await service.execute(SELLER, registerAuctionCommand());
    await service.execute(BUYER, placeBidCommand(1, 10_000, 1));
    await service.execute(OTHER_BUYER, placeBidCommand(2, 10_000, 2));

    expect(repository.getListing(AGGREGATE_ID)?.auction).toMatchObject({
      currentPrice: { amountMinor: 10_000 },
      leaderPubky: BUYER,
    });
  });

  it('rejects seller, low, stale, and post-close bids', async () => {
    let now = new Date(NOW);
    const repository = new InMemoryMarketplaceRepository();
    const service = new MarketplaceTransactionService(repository, () => new Date(now));
    await service.execute(SELLER, registerAuctionCommand());

    await expect(service.execute(SELLER, placeBidCommand(1, 10_000, 1))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });
    await expect(service.execute(BUYER, placeBidCommand(2, 4_500, 1))).resolves.toMatchObject({
      ok: false,
      error: { code: 'BID_TOO_LOW' },
    });
    await service.execute(BUYER, placeBidCommand(3, 10_000, 1));
    await expect(service.execute(OTHER_BUYER, placeBidCommand(4, 11_000, 1))).resolves.toMatchObject({
      ok: false,
      error: { code: 'REVISION_CONFLICT', currentRevision: 2 },
    });
    now = new Date(NOW.getTime() + 11 * 60 * 1_000);
    await expect(service.execute(OTHER_BUYER, placeBidCommand(5, 11_000, 2))).resolves.toMatchObject({
      ok: false,
      error: { code: 'AUCTION_CLOSED' },
    });
  });

  it('extends an auction when a valid bid lands inside the anti-sniping window', async () => {
    let now = new Date(NOW);
    const repository = new InMemoryMarketplaceRepository();
    const service = new MarketplaceTransactionService(repository, () => new Date(now));
    await service.execute(SELLER, registerAuctionCommand());
    now = new Date(NOW.getTime() + 9 * 60 * 1_000 + 30_000);

    await service.execute(BUYER, placeBidCommand(1, 10_000, 1));

    expect(repository.getListing(AGGREGATE_ID)?.auction?.endsAt).toBe(new Date(now.getTime() + 120_000).toISOString());
  });

  it('stores participant-only listing messages with immutable revisions', async () => {
    const { repository, service } = createService();
    await service.execute(SELLER, registerCommand());

    const first = await service.execute(
      BUYER,
      messageCommand(BUYER, SELLER, 0, '00000000-0000-4000-8000-000000000900', 'Is this still available?'),
    );
    const reply = await service.execute(
      SELLER,
      messageCommand(SELLER, BUYER, 1, '00000000-0000-4000-8000-000000000901', 'Yes, it is.'),
    );

    expect(first).toMatchObject({ ok: true, revision: 1, result: { kind: 'message' } });
    expect(reply).toMatchObject({
      ok: true,
      revision: 2,
      result: { conversation: { messages: [{ text: 'Is this still available?' }, { text: 'Yes, it is.' }] } },
    });
    expect(service.getParticipantConversations(BUYER)).toHaveLength(1);
    expect(service.getParticipantConversations(SELLER)).toHaveLength(1);
    expect(service.getParticipantConversations(OTHER_BUYER)).toEqual([]);
    expect(repository.getEvents().filter(({ kind }) => kind === 'message.sent')).toHaveLength(2);
  });

  it('rejects unrelated message recipients and stale conversation revisions', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());

    await expect(
      service.execute(BUYER, messageCommand(BUYER, OTHER_BUYER, 0, '00000000-0000-4000-8000-000000000902', 'Private')),
    ).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });

    await service.execute(BUYER, messageCommand(BUYER, SELLER, 0, '00000000-0000-4000-8000-000000000903', 'First'));
    await expect(
      service.execute(BUYER, messageCommand(BUYER, SELLER, 0, '00000000-0000-4000-8000-000000000904', 'Stale')),
    ).resolves.toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT', currentRevision: 1 } });
  });

  it('validates image signatures and binds one-use private attachments to messages', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02]);
    const stored = service.storeAttachment(BUYER, SELLER, 'image/jpeg', bytes);
    expect(stored).toMatchObject({
      ok: true,
      attachment: {
        senderPubky: BUYER,
        recipientPubky: SELLER,
        mimeType: 'image/jpeg',
        byteSize: 5,
      },
    });
    if (!stored.ok) return;
    const command = messageCommand(BUYER, SELLER, 0, '00000000-0000-4000-8000-000000000906', 'Photo attached');
    command.payload.attachmentIds = [stored.attachment.id];

    await expect(service.execute(BUYER, command)).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'message',
        message: {
          attachments: [{ id: stored.attachment.id, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }],
        },
      },
    });
    expect(service.getAttachment(BUYER, stored.attachment.id)?.bytes).toEqual(bytes);
    expect(service.getAttachment(SELLER, stored.attachment.id)?.bytes).toEqual(bytes);
    expect(service.getAttachment(OTHER_BUYER, stored.attachment.id)).toBeNull();

    const reused = messageCommand(BUYER, SELLER, 1, '00000000-0000-4000-8000-000000000907', 'Reuse');
    reused.payload.attachmentIds = [stored.attachment.id];
    await expect(service.execute(BUYER, reused)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_COMMAND' },
    });
  });

  it('rejects spoofed and oversized attachment payloads', () => {
    const { service } = createService();

    expect(service.storeAttachment(BUYER, SELLER, 'image/jpeg', new Uint8Array([1, 2, 3]))).toMatchObject({
      ok: false,
      code: 'INVALID_ATTACHMENT',
    });
    expect(
      service.storeAttachment(BUYER, SELLER, 'image/svg+xml', new Uint8Array([0x3c, 0x73, 0x76, 0x67])),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_ATTACHMENT',
    });
    expect(service.storeAttachment(BUYER, SELLER, 'image/png', new Uint8Array(5 * 1024 * 1024 + 1))).toMatchObject({
      ok: false,
      code: 'INVALID_ATTACHMENT',
    });
  });

  it('emits role-scoped message, offer, and outbid notifications', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerAuctionCommand());
    await service.execute(BUYER, messageCommand(BUYER, SELLER, 0, '00000000-0000-4000-8000-000000000905', 'Hello'));
    await service.execute(BUYER, createOfferCommand());
    await service.execute(BUYER, placeBidCommand(10, 10_000, 1));
    await service.execute(OTHER_BUYER, placeBidCommand(11, 12_000, 2));

    expect(
      service
        .getNotifications(SELLER)
        .map(({ type }) => type)
        .sort(),
    ).toEqual(['message_received', 'offer_received']);
    expect(service.getNotifications(BUYER).map(({ type }) => type)).toContain('outbid');
    expect(service.getNotifications(OTHER_BUYER)).toEqual([]);
  });

  it('closes a reserve-met auction with one winner and reservation', async () => {
    let now = new Date(NOW);
    const repository = new InMemoryMarketplaceRepository();
    const service = new MarketplaceTransactionService(repository, () => new Date(now));
    await service.execute(SELLER, registerAuctionCommand());
    await service.execute(BUYER, placeBidCommand(20, 10_000, 1));
    await service.execute(OTHER_BUYER, placeBidCommand(21, 8_000, 2));
    now = new Date(NOW.getTime() + 11 * 60 * 1_000);

    const result = await service.execute(SELLER, closeAuctionCommand(3));

    expect(result).toMatchObject({
      ok: true,
      revision: 4,
      result: {
        kind: 'auction_result',
        outcome: 'sold',
        winnerPubky: BUYER,
        listing: { state: 'reserved', auction: { status: 'sold' } },
        reservation: { buyerPubky: BUYER, quantity: 1 },
      },
    });
    expect(service.getNotifications(BUYER).map(({ type }) => type)).toContain('auction_won');
    await expect(service.execute(SELLER, closeAuctionCommand(4, 951))).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
  });

  it('closes an auction without a reserve-met leader as unsold', async () => {
    let now = new Date(NOW);
    const repository = new InMemoryMarketplaceRepository();
    const service = new MarketplaceTransactionService(repository, () => new Date(now));
    await service.execute(SELLER, registerAuctionCommand());
    now = new Date(NOW.getTime() + 11 * 60 * 1_000);

    await expect(service.execute(SELLER, closeAuctionCommand(1))).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'auction_result',
        outcome: 'unsold',
        winnerPubky: null,
        listing: { state: 'available', auction: { status: 'unsold' } },
        reservation: null,
      },
    });
  });

  it('applies revisioned notification preferences before delivery', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());
    await service.execute(SELLER, notificationPreferencesCommand(0, false));
    await service.execute(
      BUYER,
      messageCommand(BUYER, SELLER, 0, '00000000-0000-4000-8000-000000000970', 'Muted message'),
    );
    await service.execute(BUYER, createOfferCommand());

    expect(service.getNotificationPreferences(SELLER)).toMatchObject({ revision: 1, messages: false, offers: true });
    expect(service.getNotifications(SELLER).map(({ type }) => type)).toEqual(['offer_received']);
    await expect(service.execute(SELLER, notificationPreferencesCommand(0, true, 961))).resolves.toMatchObject({
      ok: false,
      error: { code: 'REVISION_CONFLICT', currentRevision: 1 },
    });
  });

  it('allows only a notification recipient to mark it read once', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());
    await service.execute(BUYER, createOfferCommand());
    const notification = service.getNotifications(SELLER)[0];
    const command = {
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000971',
      aggregateId: `notification:${notification.id}`,
      expectedRevision: notification.revision,
      issuedAt: NOW.toISOString(),
      kind: 'notification.mark_read',
      payload: { notificationId: notification.id },
    };

    await expect(service.execute(BUYER, command)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });
    await expect(service.execute(SELLER, command)).resolves.toMatchObject({
      ok: true,
      result: { kind: 'notification', notification: { revision: 2, readAt: NOW.toISOString() } },
    });
    await expect(
      service.execute(SELLER, {
        ...command,
        commandId: '00000000-0000-4000-8000-000000000972',
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
  });

  it('creates an immutable checkout snapshot, reservation, order, and sandbox payment', async () => {
    const { repository, service } = createService();
    await service.execute(SELLER, registerCommand());

    const result = await service.execute(BUYER, checkoutCommand());

    expect(result).toMatchObject({
      ok: true,
      revision: 1,
      result: {
        kind: 'checkout',
        orders: [
          {
            buyerPubky: BUYER,
            sellerPubky: SELLER,
            state: 'pending_payment',
            subtotal: { amountMinor: 12_500 },
            shipping: { amountMinor: 1_200 },
            total: { amountMinor: 13_700 },
            guaranteePolicyVersion: 1,
            lines: [{ listingRevision: 1, contentHash: 'a'.repeat(64), quantity: 1 }],
          },
        ],
        payments: [{ state: 'awaiting_entitlement', adapter: 'sandbox', amount: { amountMinor: 13_700 } }],
      },
    });
    expect(repository.getListing(AGGREGATE_ID)).toMatchObject({
      state: 'reserved',
      availableQuantity: 0,
      reservedQuantity: 1,
      serverRevision: 2,
    });
    expect(service.getOrders(BUYER)).toHaveLength(1);
    expect(service.getOrders(SELLER)).toHaveLength(1);
    expect(service.getOrders(OTHER_BUYER)).toEqual([]);
    expect(service.getNotifications(SELLER).map(({ type }) => type)).toContain('order_created');
  });

  it('echoes the checkout line variant snapshot onto the order line and omits it when absent', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand(2));

    // A variant-less line carries no variant keys at all on the order.
    const plain = checkoutCommand();
    const plainResult = await service.execute(BUYER, plain);
    expect(plainResult.ok).toBe(true);
    const plainLine = service.getOrders(BUYER)[0].lines[0];
    expect('variantId' in plainLine).toBe(false);
    expect('variantOptions' in plainLine).toBe(false);

    const base = checkoutCommand();
    const commandId = '00000000-0000-4000-8000-000000001001';
    const command = {
      ...base,
      commandId,
      aggregateId: buildMarketplaceCheckoutAggregateId(commandId),
      payload: {
        ...base.payload,
        // The plain checkout reserved one of two units and advanced the listing.
        lines: [
          {
            listingAggregateId: AGGREGATE_ID,
            expectedRevision: 2,
            quantity: 1,
            variantId: 'variant_forest_m',
            variantOptions: [
              { name: 'Size', value: 'M' },
              { name: 'Color', value: 'Forest green' },
            ],
          },
        ],
      },
    };
    const result = await service.execute(BUYER, command);

    expect(result).toMatchObject({
      ok: true,
      result: {
        orders: [
          {
            lines: [
              {
                variantId: 'variant_forest_m',
                variantOptions: [
                  { name: 'Size', value: 'M' },
                  { name: 'Color', value: 'Forest green' },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it('advances sandbox payment through detection to confirmation and issues a receipt', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());
    const checkout = await service.execute(BUYER, checkoutCommand());
    if (!checkout.ok || checkout.result.kind !== 'checkout') return;
    const payment = checkout.result.payments[0];

    await expect(service.execute(BUYER, paymentCommand(payment.id, 1, 'detected', 0, 1_001))).resolves.toMatchObject({
      ok: true,
      result: { kind: 'payment', payment: { state: 'detected', revision: 2 }, receipt: null },
    });
    const confirmed = await service.execute(BUYER, paymentCommand(payment.id, 2, 'confirmed', 1, 1_002));

    expect(confirmed).toMatchObject({
      ok: true,
      result: {
        kind: 'payment',
        payment: { state: 'confirmed', confirmations: 1, revision: 3 },
        order: { state: 'paid', revision: 2, receiptId: expect.any(String) },
        receipt: { contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), total: { amountMinor: 13_700 } },
      },
    });
    if (!confirmed.ok || confirmed.result.kind !== 'payment' || !confirmed.result.receipt) return;
    expect(service.getReceipt(BUYER, confirmed.result.receipt.id)).toEqual(confirmed.result.receipt);
    expect(service.getReceipt(OTHER_BUYER, confirmed.result.receipt.id)).toBeNull();
    expect(service.getNotifications(SELLER).map(({ type }) => type)).toContain('payment_confirmed');
  });

  it('rejects duplicate checkout lines, stale stock, self-purchase, and invalid payment transitions', async () => {
    const { service } = createService();
    await service.execute(SELLER, registerCommand());
    const duplicate = checkoutCommand();
    duplicate.payload.lines.push({ ...duplicate.payload.lines[0] });
    await expect(service.execute(BUYER, duplicate)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_COMMAND' },
    });
    await expect(service.execute(SELLER, checkoutCommand())).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });

    const checkout = await service.execute(BUYER, checkoutCommand());
    if (!checkout.ok || checkout.result.kind !== 'checkout') return;
    const payment = checkout.result.payments[0];
    await expect(service.execute(BUYER, paymentCommand(payment.id, 1, 'confirmed', 0, 1_003))).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_COMMAND' },
    });
    await expect(
      service.execute(OTHER_BUYER, paymentCommand(payment.id, 1, 'detected', 0, 1_004)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });
  });

  it('ships, confirms delivery, and allows one review per participant', async () => {
    const { service } = createService();
    const order = await createPaidOrder(service);

    await expect(
      service.execute(
        SELLER,
        orderCommand('fulfillment.ship', order.id, 2, { carrier: 'Sandbox Post', trackingNumber: 'TRACK-123' }, 1_201),
      ),
    ).resolves.toMatchObject({ ok: true, result: { order: { state: 'shipped', revision: 3 } } });
    await expect(
      service.execute(BUYER, orderCommand('fulfillment.confirm_delivery', order.id, 3, {}, 1_202)),
    ).resolves.toMatchObject({ ok: true, result: { order: { state: 'delivered', revision: 4 } } });
    await expect(
      service.execute(
        BUYER,
        orderCommand('review.create', order.id, 4, { rating: 5, text: 'Accurate and fast.' }, 1_203),
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: 'review', order: { state: 'completed', reviews: [{ rating: 5 }] } },
    });
    await expect(
      service.execute(SELLER, orderCommand('review.create', order.id, 5, { rating: 5, text: 'Great buyer.' }, 1_204)),
    ).resolves.toMatchObject({ ok: true, result: { order: { revision: 6, reviews: expect.any(Array) } } });
    await expect(
      service.execute(BUYER, orderCommand('review.create', order.id, 6, { rating: 4, text: 'Duplicate.' }, 1_205)),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    // Review editing exists only on the durable service (24-hour window); the
    // sandbox prototype refuses instead of silently mutating a review.
    await expect(
      service.execute(BUYER, orderCommand('review.update', order.id, 6, { rating: 3, text: 'Edited.' }, 1_206)),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_COMMAND' } });
  });

  it('runs return approval, receipt, and externally verified refund without claiming custody', async () => {
    const { service } = createService();
    const order = await createPaidOrder(service);
    await service.execute(
      SELLER,
      orderCommand('fulfillment.ship', order.id, 2, { carrier: 'Sandbox Post', trackingNumber: 'TRACK-RETURN' }, 1_210),
    );
    await service.execute(BUYER, orderCommand('fulfillment.confirm_delivery', order.id, 3, {}, 1_211));

    await expect(
      service.execute(
        BUYER,
        orderCommand(
          'return.request',
          order.id,
          4,
          { reason: 'Item differs from description', requestedAmountMinor: order.total.amountMinor },
          1_212,
        ),
      ),
    ).resolves.toMatchObject({ ok: true, result: { order: { state: 'return_requested', revision: 5 } } });
    await service.execute(SELLER, orderCommand('return.approve', order.id, 5, {}, 1_213));
    await service.execute(SELLER, orderCommand('return.receive', order.id, 6, {}, 1_214));
    const refunded = await service.execute(
      SELLER,
      orderCommand(
        'refund.record_external',
        order.id,
        7,
        { amountMinor: order.total.amountMinor, transactionId: 'bitcoin-tx-evidence-123' },
        1_215,
      ),
    );

    expect(refunded).toMatchObject({
      ok: true,
      result: {
        order: {
          state: 'refunded_external',
          externalRefund: { amountMinor: order.total.amountMinor, transactionId: 'bitcoin-tx-evidence-123' },
        },
      },
    });
  });

  it('cancels unpaid checkout immediately and releases reserved inventory once', async () => {
    const { repository, service } = createService();
    await service.execute(SELLER, registerCommand());
    const checkout = await service.execute(BUYER, checkoutCommand());
    if (!checkout.ok || checkout.result.kind !== 'checkout') return;
    const order = checkout.result.orders[0];

    await expect(
      service.execute(BUYER, orderCommand('order.cancel_request', order.id, 1, { reason: 'Changed mind' }, 1_220)),
    ).resolves.toMatchObject({ ok: true, result: { order: { state: 'cancelled', revision: 2 } } });
    expect(repository.getListing(AGGREGATE_ID)).toMatchObject({
      state: 'available',
      availableQuantity: 1,
      reservedQuantity: 0,
    });
  });

  describe('Wave 7 local pickup — capability and public record (§A1, §A7)', () => {
    it('defaults the capability off (the prototype IS the sandbox adapter) and refuses details and the reveal', async () => {
      // Sandbox mode is the default; the reveal is exercised only by tests
      // that explicitly enable non-sandbox mode (see createDurableService).
      const { service } = createService();
      expect(service.getPickupCapability()).toEqual({ pickupAvailable: false, sandboxPaymentsEnabled: true });
      const nextId = nextCommandIds(2_000);
      const aggregateId = buildMarketplaceListingAggregateId(SELLER, 'boots_pickup');
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'boots_pickup', ['pickup'], nextId()));

      await expect(service.execute(SELLER, setPickupDetailsCommand(aggregateId, 0, nextId()))).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_COMMAND' },
      });

      // A pickup checkout still works against the sandbox adapter — but the
      // reveal read is refused at the deployment boundary.
      const checkoutId = nextId();
      const checkout = await service.execute(
        BUYER,
        fulfillmentCheckoutCommand(checkoutId, [{ aggregateId, expectedRevision: 1, fulfillment: 'pickup' }], false),
      );
      if (!checkout.ok || checkout.result.kind !== 'checkout') throw new Error('Pickup checkout fixture failed');
      const payment = checkout.result.payments[0];
      await service.execute(BUYER, paymentCommand(payment.id, 1, 'confirmed', 1, 2_099));
      expect(service.revealPickupDetails(BUYER, checkout.result.orders[0].id)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_COMMAND' },
      });
    });

    it('carries fulfillmentMethods on the public listing record but never the pickup details', async () => {
      const { service } = createDurableService();
      const nextId = nextCommandIds(2_100);
      const { aggregateId } = await createConfirmedPickupOrder(service, nextId);

      const listing = service.getListingProjection(aggregateId);
      expect(listing).toMatchObject({ fulfillmentMethods: ['pickup'] });
      // Details are held by the service in memory — never in the public
      // listing record — and never on the cached order projection either.
      expect(JSON.stringify(listing)).not.toContain('Central Station');
      expect(JSON.stringify(service.getOrders(BUYER))).not.toContain('Central Station');
      expect(JSON.stringify(service.getOrders(SELLER))).not.toContain('Central Station');
    });

    it('serves the seller owner read, refuses other actors, and reports no-details with the surviving counter after clear', async () => {
      const { service } = createDurableService();
      const nextId = nextCommandIds(2_150);
      const { aggregateId } = await createConfirmedPickupOrder(service, nextId);

      expect(service.getSellerPickupDetails(SELLER, aggregateId)).toMatchObject({
        ok: true,
        version: 1,
        details: { location: { spot: 'Central Station, north entrance' } },
      });
      expect(service.getSellerPickupDetails(OTHER_BUYER, aggregateId)).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' },
      });

      await service.execute(SELLER, clearPickupDetailsCommand(aggregateId, 1, nextId()));
      expect(service.getSellerPickupDetails(SELLER, aggregateId)).toEqual({
        ok: true,
        listingAggregateId: aggregateId,
        version: 1,
        details: null,
      });
    });

    it('refuses offers on non-shipping listings and pickup auction registration with typed errors', async () => {
      const { service } = createService();
      const nextId = nextCommandIds(2_180);
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'boots_01', ['pickup'], nextId()));

      await expect(service.execute(BUYER, createOfferCommand())).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_COMMAND' },
      });

      const auction = registerAuctionCommand();
      await expect(
        service.execute(SELLER, {
          ...auction,
          commandId: nextId(),
          payload: { ...auction.payload, fulfillmentMethods: ['pickup'] },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_COMMAND' } });
    });
  });

  describe('Wave 7 local pickup — checkout (§A2)', () => {
    // Structure and negatives adapted from the two sandbox tests in
    // BitcoinErrorLog/pubky-app PR 22 (credited prior art). The Wave 7
    // semantics differ by design: the choice is per line and splits per
    // (seller, fulfillment), details never ride `listing.register`, and the
    // reveal is a dedicated per-line read against pinned snapshots rather
    // than a copy onto the order projection.
    it('rejects a shipped checkout without a delivery address and a pickup-only checkout with one', async () => {
      const { service } = createService();
      await service.execute(SELLER, registerCommand());

      const missingAddress = fulfillmentCheckoutCommand(
        '00000000-0000-4000-8000-000000002201',
        [{ aggregateId: AGGREGATE_ID, expectedRevision: 1, fulfillment: 'shipping' }],
        false,
      );
      await expect(service.execute(BUYER, missingAddress)).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_COMMAND' },
      });

      const { service: pickupService } = createService();
      const aggregateId = buildMarketplaceListingAggregateId(SELLER, 'boots_pickup');
      await pickupService.execute(
        SELLER,
        registerFulfillmentCommand(SELLER, 'boots_pickup', ['pickup'], '00000000-0000-4000-8000-000000002202'),
      );
      const pickupWithAddress = fulfillmentCheckoutCommand(
        '00000000-0000-4000-8000-000000002203',
        [{ aggregateId, expectedRevision: 1, fulfillment: 'pickup' }],
        true,
      );
      await expect(pickupService.execute(BUYER, pickupWithAddress)).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_COMMAND' },
      });
    });

    it('refuses a fulfillment choice the listing does not publish instead of falling back to shipping', async () => {
      const { service } = createService();
      const nextId = nextCommandIds(2_250);
      await service.execute(SELLER, registerCommand());
      const pickupAggregateId = buildMarketplaceListingAggregateId(SELLER, 'boots_pickup');
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'boots_pickup', ['pickup'], nextId()));

      // Shipping-only listing, pickup chosen.
      await expect(
        service.execute(
          BUYER,
          fulfillmentCheckoutCommand(
            nextId(),
            [{ aggregateId: AGGREGATE_ID, expectedRevision: 1, fulfillment: 'pickup' }],
            false,
          ),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_COMMAND' } });
      // Pickup-only listing, choice omitted (defaults to shipping).
      await expect(
        service.execute(
          BUYER,
          fulfillmentCheckoutCommand(nextId(), [{ aggregateId: pickupAggregateId, expectedRevision: 1 }], true),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_COMMAND' } });
    });

    it('splits a mixed cart per (seller, fulfillment), sharing one pickup order per seller and zeroing its shipping', async () => {
      const { service } = createService();
      const nextId = nextCommandIds(2_300);
      const shippedId = buildMarketplaceListingAggregateId(SELLER, 'mixed_ship');
      const pickupId = buildMarketplaceListingAggregateId(SELLER, 'mixed_pick');
      const otherId = buildMarketplaceListingAggregateId(SELLER_2, 'other_ship');
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'mixed_ship', ['shipping', 'pickup'], nextId()));
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'mixed_pick', ['shipping', 'pickup'], nextId()));
      await service.execute(SELLER_2, registerFulfillmentCommand(SELLER_2, 'other_ship', ['shipping'], nextId()));

      const result = await service.execute(
        BUYER,
        fulfillmentCheckoutCommand(
          nextId(),
          [
            { aggregateId: shippedId, expectedRevision: 1, fulfillment: 'shipping' },
            { aggregateId: pickupId, expectedRevision: 1, fulfillment: 'pickup' },
            { aggregateId: otherId, expectedRevision: 1, fulfillment: 'shipping' },
          ],
          true,
        ),
      );

      if (!result.ok || result.result.kind !== 'checkout') throw new Error('Mixed checkout failed');
      const { orders, payments } = result.result;
      // Seller A shipping + seller A pickup + seller B shipping: three orders.
      expect(orders).toHaveLength(3);
      const pickupOrder = orders.find((order) => order.fulfillment === 'pickup')!;
      const shippedOrders = orders.filter((order) => order.fulfillment === 'shipping');
      expect(pickupOrder).toMatchObject({
        sellerPubky: SELLER,
        shipping: { amountMinor: 0 },
        total: { amountMinor: 12_500 },
        deliveryAddress: null,
      });
      expect(shippedOrders).toHaveLength(2);
      for (const order of shippedOrders) {
        expect(order.shipping.amountMinor).toBe(1_200);
        expect(order.deliveryAddress).toMatchObject({ city: 'New York' });
      }
      expect(payments.find((payment) => payment.orderId === pickupOrder.id)?.amount.amountMinor).toBe(12_500);
    });

    it('shares one pickup order across several pickup lines from one seller', async () => {
      const { service } = createService();
      const nextId = nextCommandIds(2_350);
      const firstId = buildMarketplaceListingAggregateId(SELLER, 'spot_a');
      const secondId = buildMarketplaceListingAggregateId(SELLER, 'spot_b');
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'spot_a', ['pickup'], nextId()));
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'spot_b', ['pickup'], nextId()));

      const result = await service.execute(
        BUYER,
        fulfillmentCheckoutCommand(
          nextId(),
          [
            { aggregateId: firstId, expectedRevision: 1, fulfillment: 'pickup' },
            { aggregateId: secondId, expectedRevision: 1, fulfillment: 'pickup' },
          ],
          false,
        ),
      );

      if (!result.ok || result.result.kind !== 'checkout') throw new Error('Pickup checkout failed');
      expect(result.result.orders).toHaveLength(1);
      expect(result.result.orders[0]).toMatchObject({
        fulfillment: 'pickup',
        shipping: { amountMinor: 0 },
        total: { amountMinor: 25_000 },
        deliveryAddress: null,
      });
      expect(result.result.orders[0].lines.map((line) => line.fulfillment)).toEqual(['pickup', 'pickup']);
    });
  });

  describe('Wave 7 local pickup — reveal and pinning (§A3)', () => {
    // Adapted from PR 22's "withholds pickup details until the payment
    // confirms, then reveals them" (credited prior art), reworked to the
    // Wave 7 semantics: details are set via `pickup_details.set` (never
    // riding `listing.register`), confirmation goes through the worker path
    // in explicitly non-sandbox mode, and the reveal is a dedicated read.
    it('withholds pickup details until the payment confirms, then reveals the pinned snapshot per line', async () => {
      const { repository, service } = createDurableService();
      const nextId = nextCommandIds(2_400);
      const aggregateId = buildMarketplaceListingAggregateId(SELLER, 'spot_a');
      const secondAggregateId = buildMarketplaceListingAggregateId(SELLER, 'spot_b');
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'spot_a', ['pickup'], nextId()));
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'spot_b', ['pickup'], nextId()));
      await service.execute(SELLER, setPickupDetailsCommand(aggregateId, 0, nextId(), spotPickupDetails('Alpha spot')));
      await service.execute(
        SELLER,
        setPickupDetailsCommand(secondAggregateId, 0, nextId(), spotPickupDetails('Beta spot')),
      );
      const checkout = await service.execute(
        BUYER,
        fulfillmentCheckoutCommand(
          nextId(),
          [
            { aggregateId, expectedRevision: 1, fulfillment: 'pickup' },
            { aggregateId: secondAggregateId, expectedRevision: 1, fulfillment: 'pickup' },
          ],
          false,
        ),
      );
      if (!checkout.ok || checkout.result.kind !== 'checkout') throw new Error('Pickup checkout fixture failed');
      const order = checkout.result.orders[0];
      const payment = checkout.result.payments[0];

      // The unpaid buyer gets a typed refusal (no durable payment fact yet).
      expect(service.revealPickupDetails(BUYER, order.id)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_STATE' },
      });

      const confirmed = await service.confirmPaymentAsWorker(payment.id);
      if (!confirmed.ok) throw new Error('Worker confirmation fixture failed');
      // The pin records, per line, the version and the confirming adapter.
      expect(confirmed.order.lines.map((line) => line.versionAtPayment)).toEqual([1, 1]);
      expect(repository.getPickupSnapshot(order.id, 0)).toMatchObject({
        version: 1,
        pinnedAdapter: 'locks_verification',
        terms: { location: { spot: 'Alpha spot' } },
      });

      const reveal = service.revealPickupDetails(BUYER, order.id);
      expect(reveal).toMatchObject({ ok: true, firstRevealedAt: NOW.toISOString() });
      if (!reveal.ok) return;
      // Every line is served from its OWN pinned snapshot — never
      // first-line-only, never the listing's current details.
      expect(reveal.lines).toHaveLength(2);
      expect(reveal.lines[0]).toMatchObject({
        lineIndex: 0,
        version: 1,
        terms: { location: { spot: 'Alpha spot' } },
        updatedSincePayment: false,
        withdrawnBySeller: false,
      });
      expect(reveal.lines[1]).toMatchObject({ lineIndex: 1, version: 1, terms: { location: { spot: 'Beta spot' } } });
      // Availability windows and their IANA zone ride the pinned terms, read-only.
      expect(reveal.lines[0].terms?.availability).toMatchObject({
        kind: 'windows',
        zone: 'Europe/Lisbon',
        windows: [{ day: 'saturday', start: '10:00', end: '14:00' }],
      });
      // The first successful read stamped the bounded-withdrawal window.
      expect(repository.getOrder(order.id)?.firstRevealedAt).toBe(NOW.toISOString());
    });

    it('refuses the reveal for non-buyers, non-pickup orders, and orders cancelled from pending_payment', async () => {
      const { service } = createDurableService();
      const nextId = nextCommandIds(2_500);
      const { order } = await createConfirmedPickupOrder(service, nextId);

      expect(service.revealPickupDetails(SELLER, order.id)).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' },
      });
      expect(service.revealPickupDetails(OTHER_BUYER, order.id)).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' },
      });
      expect(service.revealPickupDetails(BUYER, '00000000-0000-4000-8000-000000009999')).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND' },
      });

      // A shipped order has no pickup reveal.
      const { service: shippingService } = createDurableService();
      await shippingService.execute(SELLER, registerCommand());
      const shippedCheckout = await shippingService.execute(BUYER, checkoutCommand());
      if (!shippedCheckout.ok || shippedCheckout.result.kind !== 'checkout') throw new Error('Checkout fixture failed');
      const shippedOrder = shippedCheckout.result.orders[0];
      const workerConfirmed = await shippingService.confirmPaymentAsWorker(shippedCheckout.result.payments[0].id);
      if (!workerConfirmed.ok) throw new Error('Worker confirmation fixture failed');
      expect(shippingService.revealPickupDetails(BUYER, shippedOrder.id)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_STATE' },
      });

      // Cancelled from pending_payment: receipt_id is null — no durable
      // payment fact was ever recorded, so nothing was ever revealed.
      const { service: cancelledService } = createDurableService();
      const cancelledNextId = nextCommandIds(2_550);
      const aggregateId = buildMarketplaceListingAggregateId(SELLER, 'boots_pickup');
      await cancelledService.execute(
        SELLER,
        registerFulfillmentCommand(SELLER, 'boots_pickup', ['pickup'], cancelledNextId()),
      );
      await cancelledService.execute(SELLER, setPickupDetailsCommand(aggregateId, 0, cancelledNextId()));
      const pendingCheckout = await cancelledService.execute(
        BUYER,
        fulfillmentCheckoutCommand(
          cancelledNextId(),
          [{ aggregateId, expectedRevision: 1, fulfillment: 'pickup' }],
          false,
        ),
      );
      if (!pendingCheckout.ok || pendingCheckout.result.kind !== 'checkout') throw new Error('Checkout fixture failed');
      const pendingOrder = pendingCheckout.result.orders[0];
      await cancelledService.execute(
        BUYER,
        orderCommand('order.cancel_request', pendingOrder.id, 1, { reason: 'Changed mind' }, 2_551),
      );
      expect(cancelledService.revealPickupDetails(BUYER, pendingOrder.id)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_STATE' },
      });
    });

    it('keeps serving the pinned snapshot after later edits, flags the update, and notifies exactly the paid buyers', async () => {
      const { service } = createDurableService();
      const nextId = nextCommandIds(2_600);
      const { order, aggregateId } = await createConfirmedPickupOrder(service, nextId, { quantity: 2 });
      // A second buyer with an UNPAID order on the same listing is not notified.
      const pendingCheckout = await service.execute(
        OTHER_BUYER,
        fulfillmentCheckoutCommand(nextId(), [{ aggregateId, expectedRevision: 2, fulfillment: 'pickup' }], false),
      );
      if (!pendingCheckout.ok) throw new Error('Pending checkout fixture failed');

      const edited = spotPickupDetails('Moved to the west entrance');
      await service.execute(SELLER, setPickupDetailsCommand(aggregateId, 1, nextId(), edited));

      expect(service.getNotifications(BUYER).map(({ type }) => type)).toContain('pickup_details_updated');
      expect(service.getNotifications(OTHER_BUYER).map(({ type }) => type)).not.toContain('pickup_details_updated');

      const reveal = service.revealPickupDetails(BUYER, order.id);
      if (!reveal.ok) throw new Error('Reveal fixture failed');
      expect(reveal.lines[0]).toMatchObject({
        version: 1,
        terms: { location: { spot: 'Central Station, north entrance' } },
        currentVersion: 2,
        updatedSincePayment: true,
        withdrawnBySeller: false,
      });
    });

    it('refuses a sandbox_advance-pinned reveal even after the deployment flag toggles back off', async () => {
      const { service } = createDurableService();
      const nextId = nextCommandIds(2_700);
      const aggregateId = buildMarketplaceListingAggregateId(SELLER, 'boots_pickup');
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'boots_pickup', ['pickup'], nextId()));
      await service.execute(SELLER, setPickupDetailsCommand(aggregateId, 0, nextId()));
      const checkout = await service.execute(
        BUYER,
        fulfillmentCheckoutCommand(nextId(), [{ aggregateId, expectedRevision: 1, fulfillment: 'pickup' }], false),
      );
      if (!checkout.ok || checkout.result.kind !== 'checkout') throw new Error('Checkout fixture failed');
      const order = checkout.result.orders[0];
      const payment = checkout.result.payments[0];

      // The flag-toggle window (off→on): while on, storing details and the
      // worker path are refused, and the sandbox adapter confirms instead.
      service.setSandboxPaymentsEnabled(true);
      expect(service.getPickupCapability().pickupAvailable).toBe(false);
      await expect(service.execute(SELLER, setPickupDetailsCommand(aggregateId, 1, nextId()))).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_COMMAND' },
      });
      await expect(service.confirmPaymentAsWorker(payment.id)).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_COMMAND' },
      });
      const confirmed = await service.execute(BUYER, paymentCommand(payment.id, 1, 'confirmed', 1, 2_701));
      if (!confirmed.ok) throw new Error('Sandbox confirmation fixture failed');

      // …and off again: the pinned adapter, not the current flag, decides.
      service.setSandboxPaymentsEnabled(false);
      expect(service.revealPickupDetails(BUYER, order.id)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_STATE' },
      });
      // The window never opened for a fake-money order.
      expect(service.getOrders(BUYER)[0].firstRevealedAt).toBeNull();
    });

    it('keeps the reveal open through cancel_requested and ends it at the cancel event', async () => {
      const { service } = createDurableService();
      const nextId = nextCommandIds(2_800);
      const { order } = await createConfirmedPickupOrder(service, nextId);

      // No terms change and no first reveal yet: the ordinary path.
      await expect(
        service.execute(BUYER, orderCommand('order.cancel_request', order.id, 2, { reason: 'Changed mind' }, 5_201)),
      ).resolves.toMatchObject({ ok: true, result: { order: { state: 'cancel_requested' } } });
      expect(service.revealPickupDetails(BUYER, order.id)).toMatchObject({ ok: true });

      await service.execute(SELLER, orderCommand('order.cancel_approve', order.id, 3, {}, 5_202));
      expect(service.revealPickupDetails(BUYER, order.id)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_STATE' },
      });
    });

    it('refuses the reveal when a pinned snapshot does not match its order line (version or line transplant)', async () => {
      // Two pickup lines: listing A pinned at v1, listing B pinned at v2.
      const setup = async (start: number) => {
        const { repository, service } = createDurableService();
        const nextId = nextCommandIds(start);
        const aggregateA = buildMarketplaceListingAggregateId(SELLER, 'spot_a');
        const aggregateB = buildMarketplaceListingAggregateId(SELLER, 'spot_b');
        await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'spot_a', ['pickup'], nextId()));
        await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'spot_b', ['pickup'], nextId()));
        await service.execute(
          SELLER,
          setPickupDetailsCommand(aggregateA, 0, nextId(), spotPickupDetails('Alpha spot')),
        );
        await service.execute(SELLER, setPickupDetailsCommand(aggregateB, 0, nextId(), spotPickupDetails('Beta spot')));
        await service.execute(
          SELLER,
          setPickupDetailsCommand(aggregateB, 1, nextId(), spotPickupDetails('Beta spot, moved')),
        );
        const checkout = await service.execute(
          BUYER,
          fulfillmentCheckoutCommand(
            nextId(),
            [
              { aggregateId: aggregateA, expectedRevision: 1, fulfillment: 'pickup' },
              { aggregateId: aggregateB, expectedRevision: 1, fulfillment: 'pickup' },
            ],
            false,
          ),
        );
        if (!checkout.ok || checkout.result.kind !== 'checkout') throw new Error('Checkout fixture failed');
        const order = checkout.result.orders[0];
        const confirmed = await service.confirmPaymentAsWorker(checkout.result.payments[0].id);
        if (!confirmed.ok) throw new Error('Worker confirmation fixture failed');
        expect(confirmed.order.lines.map((line) => line.versionAtPayment)).toEqual([1, 2]);
        // Sanity: the untampered reveal is served.
        expect(service.revealPickupDetails(BUYER, order.id)).toMatchObject({ ok: true });
        return { repository, service, order };
      };

      // A snapshot whose VERSION does not match the line's pin is refused.
      const wrongVersion = await setup(4_500);
      const pinned = wrongVersion.repository.getPickupSnapshot(wrongVersion.order.id, 0);
      if (!pinned) throw new Error('Snapshot fixture failed');
      wrongVersion.repository.putPickupSnapshot({ ...pinned, version: 2 });
      expect(wrongVersion.service.revealPickupDetails(BUYER, wrongVersion.order.id)).toMatchObject({
        ok: false,
        error: { code: 'INVARIANT_VIOLATION' },
      });

      // A snapshot TRANSPLANTED across lines — line 0's pin stored under
      // line 1's key — is refused: its version is not line 1's
      // version_at_payment.
      const transplanted = await setup(4_600);
      const lineZero = transplanted.repository.getPickupSnapshot(transplanted.order.id, 0);
      if (!lineZero) throw new Error('Snapshot fixture failed');
      transplanted.repository.putPickupSnapshot({ ...lineZero, lineIndex: 1 });
      expect(transplanted.service.revealPickupDetails(BUYER, transplanted.order.id)).toMatchObject({
        ok: false,
        error: { code: 'INVARIANT_VIOLATION' },
      });
    });
  });

  describe('Wave 7 local pickup — handover flow (§A6)', () => {
    it('marks ready by the seller only, arms next_actor, and refuses mark_ready on shipped orders', async () => {
      const { service } = createDurableService();
      const nextId = nextCommandIds(2_900);
      const { order } = await createConfirmedPickupOrder(service, nextId);

      expect(service.getNextActor(service.getOrders(BUYER)[0])).toBe('seller');
      await expect(
        service.execute(BUYER, orderCommand('fulfillment.mark_ready', order.id, 2, {}, 5_301)),
      ).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      await expect(
        service.execute(SELLER, orderCommand('fulfillment.mark_ready', order.id, 2, {}, 5_302)),
      ).resolves.toMatchObject({ ok: true, result: { order: { state: 'ready_for_pickup', revision: 3 } } });
      expect(service.getNextActor(service.getOrders(BUYER)[0])).toBe('buyer');
      expect(service.getNotifications(BUYER).map(({ type }) => type)).toContain('pickup_ready');
      await expect(
        service.execute(SELLER, orderCommand('fulfillment.mark_ready', order.id, 3, {}, 5_303)),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });

      const { service: shippingService } = createService();
      const shippedOrder = await createPaidOrder(shippingService);
      await expect(
        shippingService.execute(SELLER, orderCommand('fulfillment.mark_ready', shippedOrder.id, 2, {}, 5_304)),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
      await expect(
        shippingService.execute(BUYER, orderCommand('fulfillment.confirm_pickup', shippedOrder.id, 2, {}, 5_305)),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    });

    it('confirms the handover by buyer or seller from paid or ready_for_pickup, writing one attested handover record', async () => {
      // Buyer confirms from `paid`.
      const buyerFromPaid = createDurableService();
      const first = await createConfirmedPickupOrder(buyerFromPaid.service, nextCommandIds(3_000));
      await expect(
        buyerFromPaid.service.execute(BUYER, orderCommand('fulfillment.confirm_pickup', first.order.id, 2, {}, 3_050)),
      ).resolves.toMatchObject({ ok: true, result: { order: { state: 'delivered' } } });
      expect(buyerFromPaid.repository.getHandover(first.order.id)).toEqual({
        orderId: first.order.id,
        confirmedBy: BUYER,
        attestation: 'buyer_confirmed',
        confirmedAt: NOW.toISOString(),
      });
      // A duplicate confirm cannot write a second handover row.
      await expect(
        buyerFromPaid.service.execute(BUYER, orderCommand('fulfillment.confirm_pickup', first.order.id, 3, {}, 3_051)),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
      expect(buyerFromPaid.repository.getHandover(first.order.id)?.confirmedBy).toBe(BUYER);
      expect(buyerFromPaid.repository.getEvents().filter(({ kind }) => kind === 'fulfillment.delivered')).toHaveLength(
        1,
      );

      // Seller confirms from `ready_for_pickup`: seller-attested.
      const sellerFromReady = createDurableService();
      const second = await createConfirmedPickupOrder(sellerFromReady.service, nextCommandIds(3_100));
      await sellerFromReady.service.execute(
        SELLER,
        orderCommand('fulfillment.mark_ready', second.order.id, 2, {}, 3_150),
      );
      await expect(
        sellerFromReady.service.execute(
          SELLER,
          orderCommand('fulfillment.confirm_pickup', second.order.id, 3, {}, 3_151),
        ),
      ).resolves.toMatchObject({ ok: true, result: { order: { state: 'delivered' } } });
      expect(sellerFromReady.repository.getHandover(second.order.id)).toMatchObject({
        confirmedBy: SELLER,
        attestation: 'seller_attested',
      });
      expect(sellerFromReady.service.getNotifications(BUYER).map(({ type }) => type)).toContain('order_delivered');
    });

    it('refuses fulfillment.ship on pickup orders', async () => {
      const { service } = createDurableService();
      const { order } = await createConfirmedPickupOrder(service, nextCommandIds(3_200));

      await expect(
        service.execute(
          SELLER,
          orderCommand('fulfillment.ship', order.id, 2, { carrier: 'Sandbox Post', trackingNumber: 'TRACK-1' }, 5_501),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    });

    it('refuses a seller-actor confirm_pickup while a terms change is unresolved, but allows the buyer', async () => {
      const { service } = createDurableService();
      const nextId = nextCommandIds(3_300);
      const { order, aggregateId } = await createConfirmedPickupOrder(service, nextId);
      // The seller moves the meeting point after payment.
      await service.execute(
        SELLER,
        setPickupDetailsCommand(aggregateId, 1, nextId(), spotPickupDetails('Moved to the west entrance')),
      );

      await expect(
        service.execute(SELLER, orderCommand('fulfillment.confirm_pickup', order.id, 2, {}, 5_601)),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
      // The buyer may accept the new terms by showing up.
      await expect(
        service.execute(BUYER, orderCommand('fulfillment.confirm_pickup', order.id, 2, {}, 5_602)),
      ).resolves.toMatchObject({ ok: true, result: { order: { state: 'delivered' } } });
    });

    it('auto-completes a delivered pickup order from the handover instant on the shipped-order deadline', async () => {
      let now = new Date(NOW);
      const { service } = createDurableService(() => new Date(now));
      const { order } = await createConfirmedPickupOrder(service, nextCommandIds(3_400));
      await service.execute(BUYER, orderCommand('fulfillment.confirm_pickup', order.id, 2, {}, 5_701));

      now = new Date(NOW.getTime() + ORDER_AUTO_COMPLETE_AFTER_MS - 1_000);
      expect(service.completeDueDeliveredOrders()).toEqual([]);
      now = new Date(NOW.getTime() + ORDER_AUTO_COMPLETE_AFTER_MS + 1_000);
      const completed = service.completeDueDeliveredOrders();
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ id: order.id, state: 'completed' });
      // Terminal: the reveal entitlement has ended.
      expect(service.revealPickupDetails(BUYER, order.id)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_STATE' },
      });

      // Shipped parity: same deadline from shipment.delivered_at.
      let shippedNow = new Date(NOW);
      const shippedRepository = new InMemoryMarketplaceRepository();
      const shippedService = new MarketplaceTransactionService(shippedRepository, () => new Date(shippedNow));
      const shippedOrder = await createPaidOrder(shippedService);
      await shippedService.execute(
        SELLER,
        orderCommand('fulfillment.ship', shippedOrder.id, 2, { carrier: 'Sandbox Post', trackingNumber: 'T' }, 3_402),
      );
      await shippedService.execute(BUYER, orderCommand('fulfillment.confirm_delivery', shippedOrder.id, 3, {}, 3_403));
      shippedNow = new Date(NOW.getTime() + ORDER_AUTO_COMPLETE_AFTER_MS + 1_000);
      expect(shippedService.completeDueDeliveredOrders()).toHaveLength(1);
    });
  });

  describe('Wave 7 local pickup — unilateral exits and terms changes (§A3, §A6)', () => {
    it('cancels unilaterally on a post-payment terms change, releasing inventory like approve', async () => {
      const { repository, service } = createDurableService();
      const nextId = nextCommandIds(3_500);
      const { order, aggregateId } = await createConfirmedPickupOrder(service, nextId);
      await service.execute(
        SELLER,
        setPickupDetailsCommand(aggregateId, 1, nextId(), spotPickupDetails('Moved to the west entrance')),
      );

      await expect(
        service.execute(SELLER, orderCommand('order.cancel_request', order.id, 2, { reason: 'Not yours' }, 5_801)),
      ).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      const cancelled = await service.execute(
        BUYER,
        orderCommand('order.cancel_request', order.id, 2, { reason: 'Meeting point moved' }, 5_802),
      );

      expect(cancelled).toMatchObject({ ok: true, result: { order: { state: 'cancelled', revision: 3 } } });
      // The distinct event kind — not `order.cancelled` — and inventory
      // released exactly like an approved cancel (listing sold → available).
      const eventKinds = repository.getEvents().map(({ kind }) => kind);
      expect(eventKinds).toContain('order.cancelled_terms_change');
      expect(eventKinds).not.toContain('order.cancelled');
      expect(repository.getListing(aggregateId)).toMatchObject({
        state: 'available',
        availableQuantity: 1,
        reservedQuantity: 0,
      });
      expect(service.getNotifications(SELLER).map(({ type }) => type)).toContain('order_cancelled');
      // The reveal entitlement ended at the cancel event.
      expect(service.revealPickupDetails(BUYER, order.id)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_STATE' },
      });
    });

    it('cancels unilaterally during the bounded withdrawal window — mark_ready does not close it', async () => {
      const { repository, service } = createDurableService();
      const nextId = nextCommandIds(3_600);
      const { order, aggregateId } = await createConfirmedPickupOrder(service, nextId);

      // First reveal opens the window; mark_ready must NOT close it.
      expect(service.revealPickupDetails(BUYER, order.id)).toMatchObject({ ok: true });
      await service.execute(SELLER, orderCommand('fulfillment.mark_ready', order.id, 2, {}, 5_901));

      const cancelled = await service.execute(
        BUYER,
        orderCommand('order.cancel_request', order.id, 3, { reason: 'Spot is unusable as revealed' }, 5_902),
      );
      expect(cancelled).toMatchObject({ ok: true, result: { order: { state: 'cancelled' } } });
      expect(repository.getEvents().map(({ kind }) => kind)).toContain('order.cancelled_terms_change');
      expect(repository.getListing(aggregateId)).toMatchObject({ state: 'available', availableQuantity: 1 });

      // Once the handover is confirmed, the window is closed.
      const { service: handedOver } = createDurableService();
      const secondNextId = nextCommandIds(3_650);
      const second = await createConfirmedPickupOrder(handedOver, secondNextId);
      expect(handedOver.revealPickupDetails(BUYER, second.order.id)).toMatchObject({ ok: true });
      await handedOver.execute(BUYER, orderCommand('fulfillment.confirm_pickup', second.order.id, 2, {}, 5_951));
      await expect(
        handedOver.execute(
          BUYER,
          orderCommand('order.cancel_request', second.order.id, 3, { reason: 'Too late' }, 5_952),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    });

    it('degrades to cancel_requested when neither unilateral condition holds (racing mark_ready before the first reveal)', async () => {
      const { service } = createDurableService();
      const nextId = nextCommandIds(3_700);
      const { order } = await createConfirmedPickupOrder(service, nextId);
      await service.execute(SELLER, orderCommand('fulfillment.mark_ready', order.id, 2, {}, 6_001));

      // No terms change, no stamped first_revealed_at: the ordinary path,
      // rendered honestly as a degraded response (slice 7.2 copy).
      const command = orderCommand('order.cancel_request', order.id, 3, { reason: 'Changed mind' }, 6_002);
      const first = await service.execute(BUYER, command);
      expect(first).toMatchObject({ ok: true, result: { order: { state: 'cancel_requested' } } });
      // Command replay is idempotent.
      await expect(service.execute(BUYER, command)).resolves.toEqual(first);
    });

    it('treats details cleared BEFORE checkout as no terms change: ordinary cancel, seller confirm, clean reveal', async () => {
      // The seller sets v1, then clears before any checkout: the buyer's
      // payment pins NOTHING (no version_at_payment), so a "cleared" flag is
      // meaningless against this order — no unilateral exit, no seller
      // confirm refusal, no withdrawn-by-seller flag (§A3).
      const { repository, service } = createDurableService();
      const nextId = nextCommandIds(4_300);
      const aggregateId = buildMarketplaceListingAggregateId(SELLER, 'cleared_pre_checkout');
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'cleared_pre_checkout', ['pickup'], nextId()));
      await service.execute(SELLER, setPickupDetailsCommand(aggregateId, 0, nextId()));
      await service.execute(SELLER, clearPickupDetailsCommand(aggregateId, 1, nextId()));
      const checkout = await service.execute(
        BUYER,
        fulfillmentCheckoutCommand(nextId(), [{ aggregateId, expectedRevision: 1, fulfillment: 'pickup' }], false),
      );
      if (!checkout.ok || checkout.result.kind !== 'checkout') throw new Error('Checkout fixture failed');
      const order = checkout.result.orders[0];
      const confirmed = await service.confirmPaymentAsWorker(checkout.result.payments[0].id);
      if (!confirmed.ok) throw new Error('Worker confirmation fixture failed');
      // Nothing was pinned: the line carries no version_at_payment and the
      // snapshot records a null version.
      expect(confirmed.order.lines[0].versionAtPayment).toBeUndefined();
      expect(repository.getPickupSnapshot(order.id, 0)).toMatchObject({ version: null, terms: null });

      // No terms change is unresolved: the buyer's cancel degrades to the
      // ordinary cancel_requested path (asserted BEFORE any reveal, so the
      // bounded withdrawal window is not what decides it).
      await expect(
        service.execute(BUYER, orderCommand('order.cancel_request', order.id, 2, { reason: 'Changed mind' }, 4_350)),
      ).resolves.toMatchObject({ ok: true, result: { order: { state: 'cancel_requested' } } });
      const eventKinds = repository.getEvents().map(({ kind }) => kind);
      expect(eventKinds).toContain('order.cancel_requested');
      expect(eventKinds).not.toContain('order.cancelled_terms_change');

      // The reveal (still open through cancel_requested) is not flagged
      // withdrawn-by-seller: nothing was ever pinned against this order.
      const reveal = service.revealPickupDetails(BUYER, order.id);
      if (!reveal.ok) throw new Error('Reveal fixture failed');
      expect(reveal.lines[0]).toMatchObject({ version: null, terms: null, withdrawnBySeller: false });

      // …and the seller may confirm the handover on a twin order.
      const { service: confirmService } = createDurableService();
      const confirmNextId = nextCommandIds(4_400);
      const confirmAggregateId = buildMarketplaceListingAggregateId(SELLER, 'cleared_pre_checkout');
      await confirmService.execute(
        SELLER,
        registerFulfillmentCommand(SELLER, 'cleared_pre_checkout', ['pickup'], confirmNextId()),
      );
      await confirmService.execute(SELLER, setPickupDetailsCommand(confirmAggregateId, 0, confirmNextId()));
      await confirmService.execute(SELLER, clearPickupDetailsCommand(confirmAggregateId, 1, confirmNextId()));
      const confirmCheckout = await confirmService.execute(
        BUYER,
        fulfillmentCheckoutCommand(
          confirmNextId(),
          [{ aggregateId: confirmAggregateId, expectedRevision: 1, fulfillment: 'pickup' }],
          false,
        ),
      );
      if (!confirmCheckout.ok || confirmCheckout.result.kind !== 'checkout') throw new Error('Checkout fixture failed');
      const confirmOrder = confirmCheckout.result.orders[0];
      const workerConfirmed = await confirmService.confirmPaymentAsWorker(confirmCheckout.result.payments[0].id);
      if (!workerConfirmed.ok) throw new Error('Worker confirmation fixture failed');
      await expect(
        confirmService.execute(SELLER, orderCommand('fulfillment.confirm_pickup', confirmOrder.id, 2, {}, 4_450)),
      ).resolves.toMatchObject({ ok: true, result: { order: { state: 'delivered' } } });
    });
  });

  describe('Wave 7 local pickup — versioning, clear, and retention (§A3)', () => {
    it('keeps versions monotonic per listing across clear, CASing on the surviving counter', async () => {
      const { service } = createDurableService();
      const nextId = nextCommandIds(3_800);
      const aggregateId = buildMarketplaceListingAggregateId(SELLER, 'boots_pickup');
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'boots_pickup', ['pickup'], nextId()));

      await expect(service.execute(SELLER, setPickupDetailsCommand(aggregateId, 0, nextId()))).resolves.toMatchObject({
        ok: true,
        revision: 1,
      });
      // Stale expected versions conflict — against the counter, not the listing.
      await expect(service.execute(SELLER, setPickupDetailsCommand(aggregateId, 0, nextId()))).resolves.toMatchObject({
        ok: false,
        error: { code: 'REVISION_CONFLICT', currentRevision: 1 },
      });
      await expect(service.execute(SELLER, clearPickupDetailsCommand(aggregateId, 1, nextId()))).resolves.toMatchObject(
        { ok: true, result: { kind: 'pickup_details', details: null, version: 1 } },
      );
      // The counter survives the clear: the next set continues the sequence
      // (post-clear CAS) — no version number is ever reused.
      await expect(service.execute(SELLER, setPickupDetailsCommand(aggregateId, 0, nextId()))).resolves.toMatchObject({
        ok: false,
        error: { code: 'REVISION_CONFLICT', currentRevision: 1 },
      });
      await expect(service.execute(SELLER, setPickupDetailsCommand(aggregateId, 1, nextId()))).resolves.toMatchObject({
        ok: true,
        revision: 2,
      });
      await expect(service.execute(SELLER, clearPickupDetailsCommand(aggregateId, 1, nextId()))).resolves.toMatchObject(
        { ok: false, error: { code: 'REVISION_CONFLICT', currentRevision: 2 } },
      );
    });

    it('clear retains versions pinned by paid non-terminal orders, hard-deletes the rest, and serves the pinned snapshot flagged withdrawn', async () => {
      const { repository, service } = createDurableService();
      const nextId = nextCommandIds(3_900);
      const aggregateId = buildMarketplaceListingAggregateId(SELLER, 'boots_pickup');
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'boots_pickup', ['pickup'], nextId()));
      await service.execute(SELLER, setPickupDetailsCommand(aggregateId, 0, nextId(), spotPickupDetails('First spot')));
      await service.execute(
        SELLER,
        setPickupDetailsCommand(aggregateId, 1, nextId(), spotPickupDetails('Second spot')),
      );
      // Payment pins v2.
      const checkoutId = nextId();
      const checkout = await service.execute(
        BUYER,
        fulfillmentCheckoutCommand(checkoutId, [{ aggregateId, expectedRevision: 1, fulfillment: 'pickup' }], false),
      );
      if (!checkout.ok || checkout.result.kind !== 'checkout') throw new Error('Checkout fixture failed');
      const order = checkout.result.orders[0];
      const confirmed = await service.confirmPaymentAsWorker(checkout.result.payments[0].id);
      if (!confirmed.ok) throw new Error('Worker confirmation fixture failed');
      expect(confirmed.order.lines[0].versionAtPayment).toBe(2);
      await service.execute(SELLER, setPickupDetailsCommand(aggregateId, 2, nextId(), spotPickupDetails('Third spot')));

      await service.execute(SELLER, clearPickupDetailsCommand(aggregateId, 3, nextId()));

      // Retention: v2 is referenced as version_at_payment by a paid,
      // non-terminal order; v1 and v3 are hard-deleted. The counter survives.
      expect(repository.getPickupDetailsVersions(aggregateId).map(({ version }) => version)).toEqual([2]);
      expect(service.getSellerPickupDetails(SELLER, aggregateId)).toMatchObject({ version: 3, details: null });
      expect(service.getNotifications(BUYER).map(({ type }) => type)).toContain('pickup_details_cleared');

      // The reveal keeps working, serving the pinned v2 snapshot flagged
      // withdrawn-by-seller — terms-change detection still fires against the
      // pre-clear pin, so the buyer may cancel unilaterally.
      const reveal = service.revealPickupDetails(BUYER, order.id);
      if (!reveal.ok) throw new Error('Reveal fixture failed');
      expect(reveal.lines[0]).toMatchObject({
        version: 2,
        terms: { location: { spot: 'Second spot' } },
        currentVersion: 3,
        updatedSincePayment: true,
        withdrawnBySeller: true,
      });
      await expect(
        service.execute(
          BUYER,
          orderCommand('order.cancel_request', order.id, 2, { reason: 'Details withdrawn' }, 6_101),
        ),
      ).resolves.toMatchObject({ ok: true, result: { order: { state: 'cancelled' } } });
    });

    it('retains a cancelled order’s pinned snapshot as dispute evidence until refund evidence is recorded, then purges it', async () => {
      const { repository, service } = createDurableService();
      const nextId = nextCommandIds(4_000);
      const { order, aggregateId } = await createConfirmedPickupOrder(service, nextId);
      await service.execute(
        SELLER,
        setPickupDetailsCommand(aggregateId, 1, nextId(), spotPickupDetails('Moved to the west entrance')),
      );
      await service.execute(
        BUYER,
        orderCommand('order.cancel_request', order.id, 2, { reason: 'Meeting point moved' }, 6_201),
      );

      // Cancelled-after-payment: the snapshot outlives the cancel as the
      // dispute exhibit…
      expect(repository.getPickupSnapshot(order.id, 0)).toMatchObject({ version: 1 });
      // …until the seller's refund evidence is recorded (ADR-0019).
      await service.execute(
        SELLER,
        orderCommand(
          'refund.record_external',
          order.id,
          3,
          { amountMinor: order.total.amountMinor, transactionId: 'bitcoin-tx-evidence-456' },
          6_202,
        ),
      );
      expect(repository.getPickupSnapshot(order.id, 0)).toBeUndefined();
    });

    it('scopes the terminal-order retention purge to the listings the terminal order referenced', async () => {
      let now = new Date(NOW);
      const { repository, service } = createDurableService(() => new Date(now));
      const nextId = nextCommandIds(4_700);
      // Listing A: a pickup listing with version history — v1 superseded,
      // v2 current — that no paid order ever references.
      const listingA = buildMarketplaceListingAggregateId(SELLER, 'retention_pickup');
      await service.execute(SELLER, registerFulfillmentCommand(SELLER, 'retention_pickup', ['pickup'], nextId()));
      await service.execute(SELLER, setPickupDetailsCommand(listingA, 0, nextId(), spotPickupDetails('First spot')));
      await service.execute(SELLER, setPickupDetailsCommand(listingA, 1, nextId(), spotPickupDetails('Second spot')));

      // An UNRELATED shipped order runs to completion.
      await service.execute(SELLER, registerCommand(1, { commandId: nextId() }));
      const shippedCheckout = await service.execute(BUYER, checkoutCommand());
      if (!shippedCheckout.ok || shippedCheckout.result.kind !== 'checkout') throw new Error('Checkout fixture failed');
      const shippedOrder = shippedCheckout.result.orders[0];
      const workerConfirmed = await service.confirmPaymentAsWorker(shippedCheckout.result.payments[0].id);
      if (!workerConfirmed.ok) throw new Error('Worker confirmation fixture failed');
      await service.execute(
        SELLER,
        orderCommand('fulfillment.ship', shippedOrder.id, 2, { carrier: 'Sandbox Post', trackingNumber: 'T' }, 4_750),
      );
      await service.execute(BUYER, orderCommand('fulfillment.confirm_delivery', shippedOrder.id, 3, {}, 4_751));
      now = new Date(now.getTime() + ORDER_AUTO_COMPLETE_AFTER_MS + 1_000);
      expect(service.completeDueDeliveredOrders()).toHaveLength(1);

      // The unrelated completion cannot purge listing A's version rows: the
      // unreferenced, superseded v1 AND the live current v2 both survive.
      expect(repository.getPickupDetailsVersions(listingA).map(({ version }) => version)).toEqual([1, 2]);

      // A pickup order whose pinned version IS the listing's current row:
      // completing it purges the pinned snapshot but never the live current
      // version row.
      const { order: pickupOrder, aggregateId: listingB } = await createConfirmedPickupOrder(service, nextId, {
        listingId: 'retention_live',
      });
      await service.execute(BUYER, orderCommand('fulfillment.confirm_pickup', pickupOrder.id, 2, {}, 4_752));
      now = new Date(now.getTime() + ORDER_AUTO_COMPLETE_AFTER_MS + 1_000);
      expect(service.completeDueDeliveredOrders()).toHaveLength(1);
      expect(repository.getPickupSnapshot(pickupOrder.id, 0)).toBeUndefined();
      expect(repository.getPickupDetailsVersions(listingB).map(({ version }) => version)).toEqual([1]);
      expect(repository.getCurrentPickupDetails(listingB)).toMatchObject({ version: 1 });
      // Listing A's rows are still untouched.
      expect(repository.getPickupDetailsVersions(listingA).map(({ version }) => version)).toEqual([1, 2]);
    });
  });

  describe('Wave 7 local pickup — emitted machine document (§A6, §A8)', () => {
    it('matches the checked-in expected Wave 7 document', () => {
      const expected = expectedWave7StateMachines;

      // The prototype's emitted document IS the executable specification 7.1
      // diffs its exported contracts/state-machines.json against.
      expect(buildPrototypeStateMachineDocument()).toEqual(expected);

      // The aggregate count stays 8 (pickup_schedule is a Wave 7b aggregate).
      expect(expected.aggregates).toHaveLength(8);
      expect(expected.contract_version).toBe(1);
      const order = expected.aggregates.find(({ aggregate }) => aggregate === 'order')!;
      expect(order.states).toContain('ready_for_pickup');
      expect(order.transitions).toContainEqual({
        from: 'paid',
        to: 'ready_for_pickup',
        via: [{ trigger: 'command', name: 'fulfillment.mark_ready' }],
      });
      expect(order.transitions).toContainEqual({
        from: 'ready_for_pickup',
        to: 'cancelled',
        via: [{ trigger: 'command', name: 'order.cancel_request' }],
      });
      // The listing machine's sold → available edge gains order.cancel_request
      // (the unilateral exits release inventory through approve's path).
      const listing = expected.aggregates.find(({ aggregate }) => aggregate === 'listing')!;
      const soldEdge = listing.transitions.find(({ from, to }) => from === 'sold' && to === 'available')!;
      expect(soldEdge.via.map(({ name }) => name)).toEqual(['order.cancel_request', 'order.cancel_approve']);
    });
  });
});

describe('MarketplaceTransactionService digital delivery (digital delivery design §6 A1, B5)', () => {
  it('refuses digital_delivery.set, .clear, order.set_delivery_email and fulfillment.deliver_digital the way an unkeyed durable service does', async () => {
    const { service } = createService();
    for (const [kind, payload] of [
      ['digital_delivery.set', { expectedVersion: 0, delivery: { kind: 'email' } }],
      ['digital_delivery.clear', { expectedVersion: 0 }],
      [
        'order.set_delivery_email',
        { orderId: '00000000-0000-4000-8000-000000000001', deliveryEmail: 'buyer@example.com' },
      ],
      ['fulfillment.deliver_digital', { orderId: '00000000-0000-4000-8000-000000000001', channel: 'email' }],
    ] as const) {
      const result = await service.execute(SELLER, {
        version: 1,
        commandId: crypto.randomUUID(),
        aggregateId: AGGREGATE_ID,
        expectedRevision: 0,
        issuedAt: NOW.toISOString(),
        kind,
        payload,
      });
      expect(result, kind).toMatchObject({
        ok: false,
        error: { code: 'INVALID_STATE', reason: 'digital_delivery_unavailable' },
      });
    }
  });

  it('stores a digital listing as registered but never sells it as shipping', async () => {
    const { service } = createService();
    const registered = await service.execute(
      SELLER,
      registerCommand(1, { payload: { ...registerCommand().payload, fulfillmentMethods: ['digital'] } }),
    );
    expect(registered.ok).toBe(true);

    const checkout = await service.execute(BUYER, checkoutCommand());

    expect(checkout).toMatchObject({ ok: false, error: { code: 'INVALID_COMMAND' } });
  });
});
