import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import type { AppError } from '@/libs/error/error';
import { ErrorService } from '@/libs/error/error.types';
import { PARSE_JSON_WITH_BODY_EXCERPT, parseResponseOrThrow } from '@/libs/http/response.utils';
import { Logger } from '@/libs/logger/logger';
import { scrubSensitiveData } from '@/libs/observability/sentry.utils';
import { MarketplaceNotificationNormalizer } from '@/pipes/marketplaceNotification/marketplaceNotification.normalizer';
import sellerDropCapture from '@/test/fixtures/commerce/live/seller-drop-v0621.json';
import { LIVE_ORDERS_WIRE_FIXTURE } from '@/test/fixtures/commerce/orders.wire';
import { asOpaque } from '@/test-utils/type-assertions';
import { MARKETPLACE_NOTIFICATION_TYPE_MAX_LENGTH, marketplaceNotificationSchema } from './marketplace-projections';
import { MARKETPLACE_SESSION_STORAGE_KEY, MarketplaceSessionService } from './marketplace-session';
import { MARKETPLACE_SESSION_GRANT } from './marketplace-session-grant';
import { MarketplaceTransactionService } from './marketplace-transaction';

const ACTOR = 'y'.repeat(52);
const OTHER_ACTOR = 'b'.repeat(52);
const SESSION_BEARER = `Bearer ${'A'.repeat(43)}`;
const AGGREGATE_ID = buildMarketplaceListingAggregateId(ACTOR, 'boots_01');
const COMMAND_ID = '00000000-0000-4000-8000-000000000700';
// Captured from https://marketplace-service-production-ce23.up.railway.app/health at 2026-09-13T12:01:05Z.
const LIVE_HEALTH_RESPONSE =
  '{"status":"ok","pickup_available":true,"paykit_rail":{"bitcoin_offer_available":true,"age_seconds":9}}';
// Minimized live capture from GET /v1/notifications at
// https://marketplace-service-production-ce23.up.railway.app on 2026-09-13.
// Values are replaced with non-identifying placeholders; only the wire shape
// and literals needed to exercise the client parser are retained.
const LIVE_NOTIFICATION_ROWS = [
  {
    id: '00000000-0000-4000-8000-000000000931',
    recipient_pubky: ACTOR,
    actor_pubky: OTHER_ACTOR,
    type: 'order_created',
    aggregate_id: 'order:placeholder',
    created_at: '2026-08-20T11:00:00.000Z',
    read_at: null,
    amount: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000932',
    recipient_pubky: ACTOR,
    actor_pubky: OTHER_ACTOR,
    type: 'future_event_bound',
    aggregate_id: 'seller-payment:placeholder',
    created_at: '2026-08-20T11:01:00.000Z',
    read_at: null,
    amount: null,
  },
] as const;

const config = vi.hoisted(() => ({
  mode: 'transaction-service' as string,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => config.mode,
    getMarketplaceUrl: () => 'http://127.0.0.1:8080',
  };
});

vi.mock('@/services/homeserver/homeserver', () => ({
  HomeserverService: { generateAuthTokenFlow: vi.fn() },
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function bidCommand() {
  return {
    version: 1 as const,
    commandId: COMMAND_ID,
    aggregateId: AGGREGATE_ID,
    expectedRevision: 1,
    issuedAt: '2026-08-19T23:00:00.000Z',
    kind: 'auction.place_bid' as const,
    payload: {
      maximumAmount: { amountMinor: 10_000, currency: 'USD', exponent: 2 },
    },
  };
}

async function establishSession(): Promise<void> {
  vi.mocked(fetch).mockResolvedValueOnce(
    jsonResponse(201, {
      token: 'A'.repeat(43),
      pubky: ACTOR,
      capabilities: '',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  );
  await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), ACTOR);
  vi.mocked(fetch).mockClear();
}

describe('MarketplaceTransactionService.execute', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  it('sends a snake_case envelope with the session bearer and returns the camelCase response', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        version: 1,
        command_id: COMMAND_ID,
        aggregate_id: AGGREGATE_ID,
        revision: 2,
        event_ids: ['00000000-0000-4000-8000-000000000701'],
        result: { kind: 'bid', current_price: { amount_minor: 10_000, currency: 'USD', exponent: 2 } },
      }),
    );

    const response = await MarketplaceTransactionService.execute(ACTOR, bidCommand());

    expect(response).toMatchObject({
      ok: true,
      commandId: COMMAND_ID,
      revision: 2,
      result: { kind: 'bid', currentPrice: { amountMinor: 10_000 } },
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/v1/commands');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      authorization: SESSION_BEARER,
    });
    expect(JSON.parse(init.body as string)).toEqual({
      version: 1,
      command_id: COMMAND_ID,
      aggregate_id: AGGREGATE_ID,
      expected_revision: 1,
      issued_at: '2026-08-19T23:00:00.000Z',
      kind: 'auction.place_bid',
      payload: {
        maximum_amount: { amount_minor: 10_000, currency: 'USD', exponent: 2 },
      },
    });
    // The forgeable sandbox identity header must never reach the real service.
    expect(JSON.stringify(init.headers)).not.toContain('x-pubky-actor');
  });

  it('surfaces command failures as parsed camelCase error responses', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(409, {
        ok: false,
        error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.', current_revision: 5 },
      }),
    );

    await expect(MarketplaceTransactionService.execute(ACTOR, bidCommand())).resolves.toEqual({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.', currentRevision: 5 },
    });
  });

  it.each([
    [409, { code: 'BID_TOO_LOW', message: 'A new proxy maximum must exceed the bidder previous maximum.' }],
    [403, { code: 'UNAUTHORIZED', message: 'A seller cannot bid on their own auction.' }],
  ] as const)('preserves typed bid refusal responses from the live command envelope (%s)', async (status, error) => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(status, { ok: false, error }));

    await expect(MarketplaceTransactionService.execute(ACTOR, bidCommand())).resolves.toEqual({
      ok: false,
      error,
    });
  });

  it('returns the 404 NOT_FOUND refusal of a registration with no homeserver record as a parsed response', async () => {
    await establishSession();
    // pubky-marketplace-service 14dca9c `record_not_found` + `CommandFailure::body`, answered with HTTP 404.
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, {
        ok: false,
        error: { code: 'NOT_FOUND', message: "The seller's homeserver has no such listing record." },
      }),
    );
    const register = {
      version: 1 as const,
      commandId: COMMAND_ID,
      aggregateId: AGGREGATE_ID,
      expectedRevision: 0,
      issuedAt: '2026-09-30T04:24:31.974Z',
      kind: 'listing.register' as const,
      payload: {
        sellerPubky: ACTOR,
        listingId: 'boots_01',
        title: 'Boots',
        listingRevision: 1,
        contentHash: 'a'.repeat(64),
        quantity: 1,
        unitPrice: { amountMinor: 1_000, currency: 'USD', exponent: 2 },
        shippingMinor: 0,
        saleFormat: 'fixed_price' as const,
        fulfillmentMethods: ['shipping' as const],
      },
    };

    await expect(MarketplaceTransactionService.execute(ACTOR, register)).resolves.toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: "The seller's homeserver has no such listing record." },
    });
  });

  it('returns the 200 listing_deleted result of a listing.sync as a parsed success, not INVALID_RESPONSE', async () => {
    await establishSession();
    // pubky-marketplace-service `sync_listing.rs` `deleted_success` wrapped in the command envelope.
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        version: 1,
        command_id: COMMAND_ID,
        aggregate_id: AGGREGATE_ID,
        revision: 2,
        event_ids: ['00000000-0000-4000-8000-000000000702'],
        result: {
          kind: 'listing_deleted',
          listing: {
            aggregate_id: AGGREGATE_ID,
            seller_pubky: ACTOR,
            listing_id: 'boots_01',
            server_revision: 2,
            deleted_at: '2026-09-30T12:00:00.000Z',
          },
        },
      }),
    );
    const sync = {
      version: 1 as const,
      commandId: COMMAND_ID,
      aggregateId: AGGREGATE_ID,
      expectedRevision: 0,
      issuedAt: '2026-09-30T12:00:00.000Z',
      kind: 'listing.sync' as const,
      payload: { sellerPubky: ACTOR, listingId: 'boots_01' },
    };

    await expect(MarketplaceTransactionService.execute(ACTOR, sync)).resolves.toMatchObject({
      ok: true,
      commandId: COMMAND_ID,
      aggregateId: AGGREGATE_ID,
      revision: 2,
      result: { kind: 'listing_deleted', listing: { listingId: 'boots_01', serverRevision: 2 } },
    });
  });

  it('passes the caller deadline to the command request', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(409, { ok: false, error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.' } }),
    );
    const deadline = new AbortController();

    await MarketplaceTransactionService.execute(ACTOR, bidCommand(), { signal: deadline.signal });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(deadline.signal);
  });

  it('requires an established session before any bytes leave the client', async () => {
    await expect(MarketplaceTransactionService.execute(ACTOR, bidCommand())).rejects.toMatchObject({
      name: 'AppError',
      code: 'SESSION_EXPIRED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops the session and asks for a fresh approval when the service answers 401', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(401, { error: { message: 'The session is invalid or expired.' } }),
    );

    await expect(MarketplaceTransactionService.execute(ACTOR, bidCommand())).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('a 401 for the bearer a request carried keeps a newer session adopted while it was in flight', async () => {
    await establishSession();
    const newer = 'B'.repeat(43);
    vi.mocked(fetch).mockImplementationOnce(async () => {
      MarketplaceSessionService.establishClaimedGrantSession(
        {
          token: newer,
          pubky: ACTOR,
          capabilities: MARKETPLACE_SESSION_GRANT,
          expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        },
        ACTOR,
      );
      return jsonResponse(401, { error: { message: 'The session is invalid or expired.' } });
    });

    await expect(MarketplaceTransactionService.execute(ACTOR, bidCommand())).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(newer);
    expect(JSON.parse(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY) ?? '{}')).toMatchObject({
      token: newer,
    });
  });

  it('refuses to act for a different pubky than the session was minted for', async () => {
    await establishSession();

    await expect(MarketplaceTransactionService.execute(OTHER_ACTOR, bidCommand())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it.each([
    'payment.sandbox_advance',
    'message.send',
    'notification.mark_read',
    'notification.preferences.update',
  ] as const)('rejects the sandbox-only command kind %s before sending', async (kind) => {
    await establishSession();

    await expect(
      MarketplaceTransactionService.execute(ACTOR, { ...bidCommand(), kind } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'fulfillment.ship',
    'fulfillment.confirm_delivery',
    'order.cancel_request',
    'order.cancel_approve',
    'return.request',
    'return.approve',
    'return.receive',
    'refund.record_external',
    'review.create',
    'review.update',
  ] as const)('sends the ported post-purchase command kind %s to the service', async (kind) => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        version: 1,
        command_id: COMMAND_ID,
        aggregate_id: 'order:00000000-0000-4000-8000-000000000720',
        revision: 3,
        event_ids: ['00000000-0000-4000-8000-000000000721'],
        result: { kind: 'order' },
      }),
    );

    const response = await MarketplaceTransactionService.execute(ACTOR, { ...bidCommand(), kind } as never);

    expect(response).toMatchObject({ ok: true, result: { kind: 'order' } });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ kind });
  });

  it('fails closed outside transaction-service mode', async () => {
    config.mode = 'sandbox';

    await expect(MarketplaceTransactionService.execute(ACTOR, bidCommand())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('MarketplaceTransactionService read projections', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  const ORDER_ID = '00000000-0000-4000-8000-000000000910';
  const PAYMENT_ID = '00000000-0000-4000-8000-000000000911';
  const RECEIPT_ID = '00000000-0000-4000-8000-000000000912';

  function orderWire(overrides: Record<string, unknown> = {}) {
    return {
      id: ORDER_ID,
      buyer_pubky: ACTOR,
      seller_pubky: OTHER_ACTOR,
      revision: 2,
      state: 'pending_payment',
      lines: [
        {
          listing_aggregate_id: AGGREGATE_ID,
          listing_revision: 1,
          content_hash: 'a'.repeat(64),
          title: 'Boots',
          quantity: 1,
          unit_price: { amount_minor: 12_500, currency: 'USD', exponent: 2 },
          subtotal: { amount_minor: 12_500, currency: 'USD', exponent: 2 },
        },
      ],
      subtotal: { amount_minor: 12_500, currency: 'USD', exponent: 2 },
      shipping: { amount_minor: 1_200, currency: 'USD', exponent: 2 },
      total: { amount_minor: 13_700, currency: 'USD', exponent: 2 },
      guarantee_policy_version: 1,
      payment_id: PAYMENT_ID,
      receipt_id: null,
      cancellation_reason: null,
      shipment: null,
      return_request: null,
      external_refund: null,
      reviews: [],
      created_at: '2026-08-20T10:00:00.000Z',
      updated_at: '2026-08-20T10:00:00.000Z',
      ...overrides,
    };
  }

  // The wire payment deliberately has NO locks_bundle_id (ADR-0019 §8).
  function paymentWire() {
    return {
      id: PAYMENT_ID,
      order_id: ORDER_ID,
      buyer_pubky: ACTOR,
      seller_pubky: OTHER_ACTOR,
      revision: 1,
      adapter: 'sandbox',
      state: 'awaiting_entitlement',
      confirmations: 0,
      amount: { amount_minor: 13_700, currency: 'USD', exponent: 2 },
      created_at: '2026-08-20T10:00:00.000Z',
      updated_at: '2026-08-20T10:00:00.000Z',
    };
  }

  it('keeps participant order list reads cacheable', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { orders: [orderWire()] }));

    await MarketplaceTransactionService.getOrders(ACTOR);

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBeUndefined();
  });

  it('sends cache: no-store on seller single-order reads', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, orderWire()));

    await MarketplaceTransactionService.getOrder(ACTOR, ORDER_ID);

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('no-store');
  });

  it('reads the listing projection with the bearer session and camel-cases the auction state', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        aggregate_id: AGGREGATE_ID,
        seller_pubky: ACTOR,
        listing_id: 'boots_01',
        title: 'Boots',
        listing_revision: 1,
        content_hash: 'a'.repeat(64),
        server_revision: 4,
        state: 'available',
        total_quantity: 5,
        available_quantity: 4,
        reserved_quantity: 1,
        sold_quantity: 0,
        unit_price: { amount_minor: 12_500, currency: 'USD', exponent: 2 },
        sale_format: 'auction',
        reserve_price: { amount_minor: 20_000, currency: 'USD', exponent: 2 },
        reserve_met: false,
        reserve_record_revision: 1,
        last_reserve_command_id: '00000000-0000-4000-8000-000000000001',
        auction: {
          starts_at: '2026-08-20T09:00:00.000Z',
          ends_at: '2026-08-21T09:00:00.000Z',
          minimum_increment: { amount_minor: 100, currency: 'USD', exponent: 2 },
          anti_sniping_window_seconds: 120,
          anti_sniping_extension_seconds: 120,
          status: 'active',
          current_price: { amount_minor: 13_000, currency: 'USD', exponent: 2 },
          leader_pubky: OTHER_ACTOR,
          bid_count: 3,
        },
        viewer_bid: {
          maximum_amount: { amount_minor: 7_000, currency: 'USD', exponent: 2 },
          minimum_next_bid: { amount_minor: 7_001, currency: 'USD', exponent: 2 },
        },
        updated_at: '2026-08-20T10:00:00.000Z',
      }),
    );

    const listing = await MarketplaceTransactionService.getListing(ACTOR, AGGREGATE_ID);

    expect(listing).toMatchObject({
      aggregateId: AGGREGATE_ID,
      serverRevision: 4,
      state: 'available',
      viewerBid: {
        maximumAmount: { amountMinor: 7_000 },
        minimumNextBid: { amountMinor: 7_001 },
      },
    });
    expect(listing).not.toHaveProperty('reservePrice');
    expect(listing).not.toHaveProperty('reserveMet');
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8080/v1/listings/${encodeURIComponent(AGGREGATE_ID)}`);
    expect(init.headers).toEqual({ authorization: SESSION_BEARER });
  });

  it('returns a public ended-auction listing when seller reserve extras are null', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        aggregate_id: AGGREGATE_ID,
        seller_pubky: ACTOR,
        listing_id: 'come_and_buy',
        listing_revision: 1,
        content_hash: 'a'.repeat(64),
        server_revision: 2,
        state: 'available',
        available_quantity: 1,
        reserved_quantity: 0,
        unit_price: { amount_minor: 4_500, currency: 'USD', exponent: 2 },
        sale_format: 'auction',
        reserve_price: null,
        reserve_met: false,
        reserve_record_revision: 0,
        last_reserve_command_id: null,
        auction: {
          starts_at: '2026-08-20T09:00:00.000Z',
          ends_at: '2026-08-21T09:00:00.000Z',
          minimum_increment: { amount_minor: 100, currency: 'USD', exponent: 2 },
          status: 'sold',
          current_price: { amount_minor: 13_000, currency: 'USD', exponent: 2 },
          leader_pubky: OTHER_ACTOR,
          bid_count: 3,
        },
        updated_at: '2026-08-21T09:00:00.000Z',
      }),
    );

    const listing = await MarketplaceTransactionService.getListing(ACTOR, AGGREGATE_ID);

    expect(listing).toMatchObject({
      aggregateId: AGGREGATE_ID,
      saleFormat: 'auction',
      auction: { status: 'sold', bidCount: 3 },
    });
    expect(listing).not.toHaveProperty('reservePrice');
    expect(listing).not.toHaveProperty('reserveMet');
    expect(listing).not.toHaveProperty('reserveRecordRevision');
    expect(listing).not.toHaveProperty('lastReserveCommandId');
  });

  it('falls back to the public listing when seller extras are malformed', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        aggregate_id: AGGREGATE_ID,
        seller_pubky: ACTOR,
        listing_id: 'come_and_buy',
        listing_revision: 1,
        content_hash: 'a'.repeat(64),
        server_revision: 2,
        state: 'available',
        available_quantity: 1,
        reserved_quantity: 0,
        unit_price: { amount_minor: 4_500, currency: 'USD', exponent: 2 },
        sale_format: 'auction',
        reserve_price: null,
        last_reserve_command_id: 'not-a-uuid',
        auction: {
          starts_at: '2026-08-20T09:00:00.000Z',
          ends_at: '2026-08-21T09:00:00.000Z',
          minimum_increment: { amount_minor: 100, currency: 'USD', exponent: 2 },
          status: 'unsold',
          current_price: { amount_minor: 4_500, currency: 'USD', exponent: 2 },
          leader_pubky: null,
          bid_count: 0,
        },
        updated_at: '2026-08-21T09:00:00.000Z',
      }),
    );

    const listing = await MarketplaceTransactionService.getListing(ACTOR, AGGREGATE_ID);

    expect(listing).toMatchObject({ auction: { status: 'unsold' } });
    expect(listing).not.toHaveProperty('lastReserveCommandId');
  });

  it('reads an ended auction as the seller when reserve command id is absent', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        aggregate_id: AGGREGATE_ID,
        seller_pubky: ACTOR,
        listing_id: 'come_and_buy',
        listing_revision: 1,
        content_hash: 'a'.repeat(64),
        server_revision: 2,
        state: 'available',
        available_quantity: 1,
        reserved_quantity: 0,
        unit_price: { amount_minor: 4_500, currency: 'USD', exponent: 2 },
        sale_format: 'auction',
        reserve_price: null,
        reserve_record_revision: 0,
        auction: {
          starts_at: '2026-08-20T09:00:00.000Z',
          ends_at: '2026-08-21T09:00:00.000Z',
          minimum_increment: { amount_minor: 100, currency: 'USD', exponent: 2 },
          status: 'sold',
          current_price: { amount_minor: 13_000, currency: 'USD', exponent: 2 },
          leader_pubky: OTHER_ACTOR,
          bid_count: 3,
        },
        updated_at: '2026-08-21T09:00:00.000Z',
      }),
    );

    await expect(MarketplaceTransactionService.getSellerListing(ACTOR, AGGREGATE_ID)).resolves.toMatchObject({
      saleFormat: 'auction',
      reservePrice: null,
      reserveRecordRevision: 0,
      auction: { status: 'sold' },
    });
  });

  it('rejects a live seller auction whose reserve command extras are null', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        aggregate_id: AGGREGATE_ID,
        seller_pubky: ACTOR,
        listing_id: 'come_and_buy',
        listing_revision: 1,
        content_hash: 'a'.repeat(64),
        server_revision: 2,
        state: 'available',
        available_quantity: 1,
        reserved_quantity: 0,
        unit_price: { amount_minor: 4_500, currency: 'USD', exponent: 2 },
        sale_format: 'auction',
        reserve_price: null,
        reserve_met: false,
        reserve_record_revision: 0,
        last_reserve_command_id: null,
        auction: {
          starts_at: '2026-08-20T09:00:00.000Z',
          ends_at: '2026-08-21T09:00:00.000Z',
          minimum_increment: { amount_minor: 100, currency: 'USD', exponent: 2 },
          status: 'active',
          current_price: { amount_minor: 13_000, currency: 'USD', exponent: 2 },
          leader_pubky: OTHER_ACTOR,
          bid_count: 3,
        },
        updated_at: '2026-08-21T09:00:00.000Z',
      }),
    );

    await expect(MarketplaceTransactionService.getSellerListing(ACTOR, AGGREGATE_ID)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('returns null for an unregistered listing (service 404)', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'The listing was not found.' } }),
    );

    await expect(MarketplaceTransactionService.getListing(ACTOR, AGGREGATE_ID)).resolves.toBeNull();
  });

  it('rejects a seller projection whose seller does not match the bearer actor', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        seller_pubky: OTHER_ACTOR,
        reserve_price: { amount_minor: 20_000, currency: 'USD', exponent: 2 },
      }),
    );

    await expect(MarketplaceTransactionService.getSellerListing(ACTOR, AGGREGATE_ID)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('reads participant offers and maps the negotiation view', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        offers: [
          {
            id: '00000000-0000-4000-8000-000000000920',
            aggregate_id: 'offer:00000000-0000-4000-8000-000000000920',
            listing_aggregate_id: AGGREGATE_ID,
            buyer_pubky: ACTOR,
            seller_pubky: OTHER_ACTOR,
            revision: 2,
            state: 'countered',
            offered_by: OTHER_ACTOR,
            amount: { amount_minor: 11_000, currency: 'USD', exponent: 2 },
            quantity: 1,
            message: 'Meet in the middle?',
            history: [],
            expires_at: '2026-08-21T10:00:00.000Z',
            created_at: '2026-08-20T10:00:00.000Z',
            updated_at: '2026-08-20T11:00:00.000Z',
          },
        ],
      }),
    );

    await expect(MarketplaceTransactionService.getOffers(ACTOR)).resolves.toEqual([
      expect.objectContaining({
        aggregateId: 'offer:00000000-0000-4000-8000-000000000920',
        revision: 2,
        state: 'countered',
        offeredBy: OTHER_ACTOR,
        amount: { amountMinor: 11_000, currency: 'USD', exponent: 2 },
      }),
    ]);
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:8080/v1/offers');
  });

  it('reads orders with embedded payment and post-purchase sub-objects, redactions honored', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        orders: [
          orderWire({
            state: 'delivered',
            payment: paymentWire(),
            payment_method: 'bitcoin',
            bitcoin_quote: {
              quoted_sats: 2_588,
              currency: 'USD',
              exponent: 2,
              rate: '77287',
              source: 'captured',
              fetched_at: '2026-08-20T10:00:00.000Z',
              expires_at: '2026-08-20T11:00:00.000Z',
              spread_bps: 0,
            },
            shipment: {
              carrier: 'DHL',
              tracking_number: 'JD014600003RU',
              state: 'delivered',
              shipped_at: '2026-08-20T11:00:00.000Z',
              delivered_at: '2026-08-20T12:00:00.000Z',
            },
          }),
        ],
      }),
    );

    const orders = await MarketplaceTransactionService.getOrders(ACTOR);

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: ORDER_ID,
      revision: 2,
      state: 'delivered',
      deliveryAssumed: false,
      nextActor: 'none',
      payment: { id: PAYMENT_ID, state: 'awaiting_entitlement', adapter: 'sandbox' },
      paymentMethod: 'bitcoin',
      bitcoinQuote: { quotedSats: 2_588, currency: 'USD', exponent: 2 },
      shipment: { carrier: 'DHL', trackingNumber: 'JD014600003RU', state: 'delivered' },
      receiptId: null,
    });
    expect(orders[0]).not.toHaveProperty('deliveryAddress');
    expect(orders[0].payment).not.toHaveProperty('locksBundleId');
  });

  it('strips delivery addresses from participant list projections', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        orders: [
          orderWire({
            delivery_address: {
              format: 'plaintext_v1',
              address: {
                name: 'Alice Buyer',
                line1: '1 Market Street',
                line2: '',
                city: 'New York',
                region: 'NY',
                postal_code: '10001',
                country_code: 'US',
              },
            },
          }),
        ],
      }),
    );

    const [order] = await MarketplaceTransactionService.getOrders(ACTOR);

    expect(order).not.toHaveProperty('deliveryAddress');
  });

  it('reads the captured wire orders, including the locked and all-null quotes', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, LIVE_ORDERS_WIRE_FIXTURE));

    const orders = await MarketplaceTransactionService.getOrders(ACTOR);

    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ bitcoinQuote: { quotedSats: 2_588, rate: '77287' } });
    expect(orders[1]).toMatchObject({ paymentMethod: null, bitcoinQuote: { quotedSats: null } });
  });

  it.each([2_100_000_000_000_001, 0])(
    'drops malformed quoted_sats=%s without dropping the order list',
    async (quotedSats) => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          orders: [
            orderWire({
              bitcoin_quote: {
                quoted_sats: quotedSats,
                currency: 'USD',
                exponent: 2,
                rate: '77287',
                source: 'blocktank',
                fetched_at: '2026-09-13T19:14:48.286Z',
                expires_at: '2026-09-13T20:15:09.050Z',
                spread_bps: 0,
              },
            }),
            orderWire({
              id: '00000000-0000-4000-8000-000000000913',
              bitcoin_quote: {
                quoted_sats: 2_588,
                currency: 'USD',
                exponent: 2,
                rate: '77287',
                source: 'blocktank',
                fetched_at: '2026-09-13T19:14:48.286Z',
                expires_at: '2026-09-13T20:15:09.050Z',
                spread_bps: 0,
              },
            }),
          ],
        }),
      );

      const orders = await MarketplaceTransactionService.getOrders(ACTOR);

      expect(orders).toHaveLength(2);
      expect(orders[0]?.bitcoinQuote).toBeUndefined();
      expect(orders[1]?.bitcoinQuote).toMatchObject({ quotedSats: 2_588, rate: '77287' });
    },
  );

  it('reads assumed-delivery and next-actor order projection fields when present', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        orders: [
          orderWire({
            state: 'delivered',
            delivery_assumed: true,
            next_actor: 'buyer',
          }),
        ],
      }),
    );

    const [order] = await MarketplaceTransactionService.getOrders(ACTOR);

    expect(order).toMatchObject({
      deliveryAssumed: true,
      nextActor: 'buyer',
    });
  });

  it('reads a single payment and returns null for foreign/absent payments', async () => {
    await establishSession();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, paymentWire()))
      .mockResolvedValueOnce(
        jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'The payment was not found.' } }),
      );

    await expect(MarketplaceTransactionService.getPayment(ACTOR, PAYMENT_ID)).resolves.toMatchObject({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      revision: 1,
    });
    await expect(MarketplaceTransactionService.getPayment(ACTOR, PAYMENT_ID)).resolves.toBeNull();
  });

  it('reads a receipt with its integrity hash', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        id: RECEIPT_ID,
        order_id: ORDER_ID,
        payment_id: PAYMENT_ID,
        issuer_pubky: OTHER_ACTOR,
        recipient_pubky: ACTOR,
        total: { amount_minor: 13_700, currency: 'USD', exponent: 2 },
        content_hash: 'b'.repeat(64),
        issued_at: '2026-08-20T12:00:00.000Z',
      }),
    );

    await expect(MarketplaceTransactionService.getReceipt(ACTOR, RECEIPT_ID)).resolves.toMatchObject({
      id: RECEIPT_ID,
      contentHash: 'b'.repeat(64),
      total: { amountMinor: 13_700 },
    });
  });

  it('reads recipient notifications that carry no revision', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        notifications: [
          {
            id: '00000000-0000-4000-8000-000000000930',
            recipient_pubky: ACTOR,
            actor_pubky: OTHER_ACTOR,
            type: 'order_shipped',
            aggregate_id: `order:${ORDER_ID}`,
            created_at: '2026-08-20T11:00:00.000Z',
            read_at: null,
          },
        ],
      }),
    );

    const notifications = await MarketplaceTransactionService.getNotifications(ACTOR);

    expect(notifications).toEqual([
      expect.objectContaining({ type: 'order_shipped', aggregateId: `order:${ORDER_ID}`, readAt: null }),
    ]);
    expect('revision' in notifications[0] ? notifications[0].revision : undefined).toBeUndefined();
  });

  it("reads the order's fulfillment the service names on an order notification", async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        notifications: [
          {
            id: '00000000-0000-4000-8000-000000000931',
            recipient_pubky: ACTOR,
            actor_pubky: 'system',
            type: 'order_delivered',
            aggregate_id: `order:${ORDER_ID}`,
            amount: null,
            created_at: '2026-09-27T07:00:00.000Z',
            read_at: null,
            order_fulfillment: 'digital',
          },
          {
            id: '00000000-0000-4000-8000-000000000932',
            recipient_pubky: ACTOR,
            actor_pubky: OTHER_ACTOR,
            type: 'offer_received',
            aggregate_id: 'offer:00000000-0000-4000-8000-000000000933',
            amount: null,
            created_at: '2026-09-27T06:00:00.000Z',
            read_at: null,
            order_fulfillment: null,
          },
        ],
      }),
    );

    const notifications = await MarketplaceTransactionService.getNotifications(ACTOR);

    expect(notifications).toEqual([
      expect.objectContaining({ type: 'order_delivered', orderFulfillment: 'digital' }),
      expect.objectContaining({ type: 'offer_received', orderFulfillment: null }),
    ]);
  });

  it('keeps valid rows when a live row has an unknown type and does not log its body', async () => {
    const oldAtomicParse = z.object({ notifications: z.array(marketplaceNotificationSchema) }).safeParse({
      notifications: [
        {
          id: LIVE_NOTIFICATION_ROWS[0].id,
          recipientPubky: LIVE_NOTIFICATION_ROWS[0].recipient_pubky,
          actorPubky: LIVE_NOTIFICATION_ROWS[0].actor_pubky,
          type: LIVE_NOTIFICATION_ROWS[0].type,
          aggregateId: LIVE_NOTIFICATION_ROWS[0].aggregate_id,
          createdAt: LIVE_NOTIFICATION_ROWS[0].created_at,
          readAt: LIVE_NOTIFICATION_ROWS[0].read_at,
          amount: LIVE_NOTIFICATION_ROWS[0].amount,
        },
        {
          id: LIVE_NOTIFICATION_ROWS[1].id,
          recipientPubky: LIVE_NOTIFICATION_ROWS[1].recipient_pubky,
          actorPubky: LIVE_NOTIFICATION_ROWS[1].actor_pubky,
          type: LIVE_NOTIFICATION_ROWS[1].type,
          aggregateId: LIVE_NOTIFICATION_ROWS[1].aggregate_id,
          createdAt: LIVE_NOTIFICATION_ROWS[1].created_at,
          readAt: LIVE_NOTIFICATION_ROWS[1].read_at,
          amount: LIVE_NOTIFICATION_ROWS[1].amount,
        },
      ],
    });
    expect(oldAtomicParse.success).toBe(false);

    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        notifications: [
          ...LIVE_NOTIFICATION_ROWS,
          {
            ...LIVE_NOTIFICATION_ROWS[0],
            id: '00000000-0000-4000-8000-000000000933',
            actor_pubky: 'system',
            type: 'payment_confirmed',
          },
        ],
      }),
    );
    const loggerError = vi.spyOn(Logger, 'error');

    const notifications = await MarketplaceTransactionService.getNotifications(ACTOR);

    expect(notifications).toHaveLength(3);
    expect(notifications[0]).toMatchObject({ type: 'order_created' });
    expect(notifications[1]).toEqual({
      kind: 'unrecognized',
      id: '00000000-0000-4000-8000-000000000932',
      index: 1,
      type: 'future_event_bound',
      createdAt: '2026-08-20T11:01:00.000Z',
    });
    expect(notifications[2]).toMatchObject({ type: 'payment_confirmed', actorPubky: 'system' });
    expect(loggerError).toHaveBeenCalledOnce();
    expect(loggerError.mock.calls[0]?.[1]).toBe('Marketplace notification history was partially unrecognized.');
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('seller-payment:placeholder');
  });

  it('bounds an unrecognized type in telemetry and the normalized feed id', async () => {
    await establishSession();
    const oversizedType = 'x'.repeat(1_024);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        notifications: [
          {
            ...LIVE_NOTIFICATION_ROWS[0],
            type: oversizedType,
          },
        ],
      }),
    );
    const loggerError = vi.spyOn(Logger, 'error');

    const [notification] = await MarketplaceTransactionService.getNotifications(ACTOR);
    expect(notification).toMatchObject({
      kind: 'unrecognized',
      index: 0,
      type: 'x'.repeat(MARKETPLACE_NOTIFICATION_TYPE_MAX_LENGTH),
    });
    expect(JSON.stringify(loggerError.mock.calls)).toContain('x'.repeat(MARKETPLACE_NOTIFICATION_TYPE_MAX_LENGTH));
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(oversizedType);
    expect(MarketplaceNotificationNormalizer.toFeedNotification(notification, 'transaction-service').id).toContain(
      `marketplace:unrecognized:${'x'.repeat(MARKETPLACE_NOTIFICATION_TYPE_MAX_LENGTH)}`,
    );
  });

  it('keeps identical quarantined rows distinct with a bounded raw id', async () => {
    await establishSession();
    const oversizedId = 'i'.repeat(1_024);
    const row = { ...LIVE_NOTIFICATION_ROWS[1], id: oversizedId };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { notifications: [row, row] }));

    const notifications = await MarketplaceTransactionService.getNotifications(ACTOR);
    const first = MarketplaceNotificationNormalizer.toFeedNotification(notifications[0]!, 'transaction-service');
    const second = MarketplaceNotificationNormalizer.toFeedNotification(notifications[1]!, 'transaction-service');

    expect(first.id).not.toBe(second.id);
    expect(first.id).toContain(`:${'i'.repeat(MARKETPLACE_NOTIFICATION_TYPE_MAX_LENGTH)}:0`);
    expect(first.id).not.toContain(oversizedId);
  });

  it('quarantines malformed notification timestamps at epoch', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        notifications: [{ ...LIVE_NOTIFICATION_ROWS[1], created_at: 'not-a-date' }],
      }),
    );

    const [notification] = await MarketplaceTransactionService.getNotifications(ACTOR);
    expect(notification).toMatchObject({
      kind: 'unrecognized',
      index: 0,
      createdAt: '1970-01-01T00:00:00.000Z',
    });
    expect(MarketplaceNotificationNormalizer.toFeedNotification(notification, 'transaction-service').timestamp).toBe(0);
  });

  it('reports each distinct invalid-type set once until the session ends', async () => {
    await establishSession();
    const invalidRow = { ...LIVE_NOTIFICATION_ROWS[1] };
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { notifications: [invalidRow] }))
      .mockResolvedValueOnce(jsonResponse(200, { notifications: [invalidRow] }));
    const loggerError = vi.spyOn(Logger, 'error');

    await MarketplaceTransactionService.getNotifications(ACTOR);
    await MarketplaceTransactionService.getNotifications(ACTOR);

    expect(loggerError).toHaveBeenCalledOnce();
  });

  it('caps distinct invalid-type telemetry per session and re-arms after reset', async () => {
    await establishSession();
    const loggerError = vi.spyOn(Logger, 'error');
    for (let index = 0; index < 33; index += 1) {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          notifications: [{ ...LIVE_NOTIFICATION_ROWS[1], type: `future_event_${index}` }],
        }),
      );
      await MarketplaceTransactionService.getNotifications(ACTOR);
    }

    expect(loggerError).toHaveBeenCalledTimes(32);

    MarketplaceSessionService.clearSession();
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        notifications: [{ ...LIVE_NOTIFICATION_ROWS[1], type: 'future_event_after_reset' }],
      }),
    );
    await MarketplaceTransactionService.getNotifications(ACTOR);

    expect(loggerError).toHaveBeenCalledTimes(33);
  });

  it('requires a session for every projection read', async () => {
    await expect(MarketplaceTransactionService.getListing(ACTOR, AGGREGATE_ID)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    await expect(MarketplaceTransactionService.getOffers(ACTOR)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(MarketplaceTransactionService.getOrders(ACTOR)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(MarketplaceTransactionService.getPayment(ACTOR, PAYMENT_ID)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    await expect(MarketplaceTransactionService.getReceipt(ACTOR, RECEIPT_ID)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    await expect(MarketplaceTransactionService.getNotifications(ACTOR)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed outside transaction-service mode', async () => {
    config.mode = 'sandbox';

    await expect(MarketplaceTransactionService.getOrders(ACTOR)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops the session when a projection read answers 401', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(401, { error: { message: 'The session is invalid or expired.' } }),
    );

    await expect(MarketplaceTransactionService.getOrders(ACTOR)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  describe('seller payment methods', () => {
    beforeEach(() => {
      config.mode = 'transaction-service';
      MarketplaceSessionService.clearSession();
    });

    it('reads a seller payment config publicly, without any session', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          bitcoin_available: true,
          bitcoin_offer_available: true,
          paypal_available: true,
          stripe_available: true,
        }),
      );

      const configView = await MarketplaceTransactionService.getSellerPaymentConfig(OTHER_ACTOR);

      expect(configView).toEqual({
        bitcoinAvailable: true,
        bitcoinOfferAvailable: true,
        paypalAvailable: true,
      });
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://127.0.0.1:8080/v0/sellers/${OTHER_ACTOR}/payment-config`);
      expect(init.headers).toEqual(expect.not.objectContaining({ authorization: expect.anything() }));
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('drops payout identifiers from a service that still sends them', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          bitcoin_available: false,
          bitcoin_offer_available: true,
          stripe_payment_link: 'https://buy.stripe.com/test_abc',
          paypal_merchant_email: 'seller@example.com',
        }),
      );

      const configView = await MarketplaceTransactionService.getSellerPaymentConfig(OTHER_ACTOR);

      expect(configView).toEqual({ bitcoinAvailable: false, bitcoinOfferAvailable: true, paypalAvailable: true });
      expect(JSON.stringify(configView)).not.toMatch(/@|stripe\.com|example\.com/);
    });

    it('keeps a truncated legacy body out of the error context and the log', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('{"bitcoin_available":false,"paypal_merchant_email":"seller@example.com","stripe_pay', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const loggerError = vi.spyOn(Logger, 'error');

      const error = (await MarketplaceTransactionService.getSellerPaymentConfig(OTHER_ACTOR).catch(
        (caught: unknown) => caught,
      )) as AppError;

      expect(error).toMatchObject({ name: 'AppError', code: 'INVALID_RESPONSE' });
      expect(error.context).not.toHaveProperty('responseText');
      expect(JSON.stringify(error.context)).not.toContain('seller@example.com');
      expect(loggerError).toHaveBeenCalled();
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain('seller@example.com');
      loggerError.mockRestore();
    });

    it('saves the own config with the bearer, omitting the key unless provided, and never gets it back', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          payment_config: {
            bitcoin_enabled: true,
            stripe_payment_link: 'https://buy.stripe.com/test_abc',
            paypal_merchant_email: null,
            stripe_restricted_key_set: true,
            updated_at: '2026-08-22T12:00:00.000Z',
          },
        }),
      );

      const saved = await MarketplaceTransactionService.putMyPaymentConfig(ACTOR, {
        bitcoinEnabled: true,
        stripePaymentLink: 'https://buy.stripe.com/test_abc',
        paypalMerchantEmail: null,
      });

      expect(saved.stripeRestrictedKeySet).toBe(true);
      expect(Object.keys(saved)).not.toContain('stripeRestrictedKey');
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty('stripe_restricted_key');
      expect((init.headers as Record<string, string>).authorization).toBe(SESSION_BEARER);
    });

    it('sends the restricted key on the wire only when the seller supplies one', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          payment_config: {
            bitcoin_enabled: false,
            stripe_payment_link: null,
            paypal_merchant_email: null,
            stripe_restricted_key_set: true,
            updated_at: '2026-08-22T12:00:00.000Z',
          },
        }),
      );

      await MarketplaceTransactionService.putMyPaymentConfig(ACTOR, {
        bitcoinEnabled: false,
        stripePaymentLink: null,
        stripeRestrictedKey: 'rk_test_12345678',
        paypalMerchantEmail: null,
      });

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.stripe_restricted_key).toBe('rk_test_12345678');
    });

    it('surfaces the service error envelope message and reason on a refused binding', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(409, {
          ok: false,
          error: {
            code: 'INVALID_STATE',
            message: 'A different payment method is already bound to this order.',
            reason: 'payment_method_already_bound',
          },
        }),
      );

      await expect(MarketplaceTransactionService.bindPaymentMethod(ACTOR, ORDER_ID, 'stripe')).rejects.toMatchObject({
        message: 'A payment method is already bound to this checkout.',
      });
    });

    it('maps the service#84 wallet-setup refusal to its own copy and reason, with one request and no retry', async () => {
      await establishSession();
      vi.mocked(fetch).mockClear();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(409, {
          ok: false,
          error: {
            code: 'INVALID_STATE',
            message:
              'Reader wallet setup needed. Finish setting up Bitkit (or another Paykit wallet) for this identity, then choose Pay again.',
            reason: 'buyer_paykit_wallet_setup_needed',
          },
        }),
      );

      await expect(MarketplaceTransactionService.bindPaymentMethod(ACTOR, ORDER_ID, 'bitcoin')).rejects.toMatchObject({
        message:
          'Reader wallet setup needed. Finish setting up Bitkit (or another Paykit wallet) for this pubky, then try again.',
        context: { statusCode: 409, reason: 'buyer_paykit_wallet_setup_needed', serviceCode: 'INVALID_STATE' },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('sends usdt as the bind method and reads each USDT refusal in USDT copy, tagged with the rail', async () => {
      await establishSession();
      vi.mocked(fetch).mockClear();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(409, {
          ok: false,
          error: {
            code: 'INVALID_STATE',
            message: 'SENTINEL_SERVER_TEXT',
            reason: 'usdt_seller_not_ready',
          },
        }),
      );

      await expect(MarketplaceTransactionService.bindPaymentMethod(ACTOR, ORDER_ID, 'usdt')).rejects.toMatchObject({
        message: "This seller can't take USDT right now. Choose another payment method, or contact the seller.",
        context: {
          statusCode: 409,
          reason: 'usdt_seller_not_ready',
          serviceCode: 'INVALID_STATE',
          paymentMethod: 'usdt',
        },
      });
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ method: 'usdt' });

      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(409, {
          ok: false,
          error: { code: 'INVALID_STATE', message: 'SENTINEL', reason: 'buyer_paykit_wallet_required' },
        }),
      );
      await expect(MarketplaceTransactionService.bindPaymentMethod(ACTOR, ORDER_ID, 'usdt')).rejects.toMatchObject({
        message:
          'Connect Bitkit to pay with USDT: this account has no Paykit wallet that can receive a payment request.',
      });
    });

    it('leaves the Bitcoin refusal context untouched: no rail tag', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(409, {
          ok: false,
          error: { code: 'INVALID_STATE', message: 'SENTINEL', reason: 'buyer_paykit_wallet_required' },
        }),
      );

      await expect(MarketplaceTransactionService.bindPaymentMethod(ACTOR, ORDER_ID, 'bitcoin')).rejects.toSatisfy(
        (error: { context?: Record<string, unknown> }) => !('paymentMethod' in (error.context ?? {})),
      );
    });

    it('surfaces capability_required, method_unavailable, and CAS revision conflict as static copy', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(403, {
          ok: false,
          error: {
            code: 'capability_required',
            message: 'The session grant does not authorize inventory access.',
          },
        }),
      );
      await expect(MarketplaceTransactionService.bindPaymentMethod(ACTOR, ORDER_ID, 'paypal')).rejects.toMatchObject({
        message: 'This payment needs a marketplace grant. Approve access on your signer and try again.',
        context: { serviceCode: 'capability_required' },
      });

      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(409, {
          ok: false,
          error: {
            code: 'INVALID_STATE',
            message: 'The seller has no PayPal merchant email configured.',
            reason: 'method_unavailable',
          },
        }),
      );
      await expect(MarketplaceTransactionService.bindPaymentMethod(ACTOR, ORDER_ID, 'paypal')).rejects.toMatchObject({
        message: 'The seller has not configured this payment method.',
        context: { reason: 'method_unavailable', serviceCode: 'INVALID_STATE' },
      });

      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(409, {
          ok: false,
          error: {
            code: 'REVISION_CONFLICT',
            message: 'The aggregate changed.',
          },
        }),
      );
      await expect(MarketplaceTransactionService.bindPaymentMethod(ACTOR, ORDER_ID, 'paypal')).rejects.toMatchObject({
        message: 'This payment changed since you loaded it. The latest state was reloaded — retry from there.',
        context: { serviceCode: 'REVISION_CONFLICT' },
      });
    });

    it('maps payment-method reasons to static copy and never logs the server message', async () => {
      await establishSession();
      const echoed = 'rk_live_echoed_restricted_key_value';
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(400, {
          ok: false,
          error: {
            code: 'INVALID_COMMAND',
            message: `Stripe rejected ${echoed}`,
            reason: 'stripe_key_invalid',
          },
        }),
      );
      const loggerError = vi.spyOn(Logger, 'error');

      const error = (await MarketplaceTransactionService.putMyPaymentConfig(ACTOR, {
        bitcoinEnabled: false,
        stripePaymentLink: null,
        stripeRestrictedKey: 'rk_test_12345678',
        paypalMerchantEmail: null,
      }).catch((caught: unknown) => caught)) as AppError;

      expect(error).toMatchObject({
        message: 'The seller payment key was rejected. The seller must update their payment settings.',
      });
      expect(error.message).not.toContain(echoed);
      expect(JSON.stringify(error.context)).not.toContain(echoed);
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(echoed);
      loggerError.mockRestore();
    });

    it('reports an honest not-found verification without touching the order', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { ok: true, verified: false, status: 'not_found' }));

      const result = await MarketplaceTransactionService.verifyStripePayment(ACTOR, ORDER_ID);

      expect(result).toEqual({ verified: false, order: null });
    });
  });

  describe('seller shipping integration', () => {
    const SHIP_FROM_WIRE = {
      name: 'Olive Farm',
      line1: 'Maslinska 1',
      line2: '',
      city: 'Split',
      region: '',
      postal_code: '21000',
      country_code: 'HR',
      phone: '',
      email: '',
    };

    beforeEach(() => {
      config.mode = 'transaction-service';
      MarketplaceSessionService.clearSession();
    });

    it('saves the shipping config; the Shippo token is write-only and only its presence returns', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          shipping_config: {
            ship_from: SHIP_FROM_WIRE,
            shippo_api_key_set: true,
            updated_at: '2026-08-24T12:00:00.000Z',
          },
        }),
      );

      const saved = await MarketplaceTransactionService.putMyShippingConfig(ACTOR, {
        shippoApiKey: 'shippo_test_1234567890',
        shipFrom: {
          name: 'Olive Farm',
          line1: 'Maslinska 1',
          line2: '',
          city: 'Split',
          region: '',
          postalCode: '21000',
          countryCode: 'HR',
          phone: '',
          email: '',
        },
      });

      expect(saved.shippoApiKeySet).toBe(true);
      expect(saved.shipFrom?.city).toBe('Split');
      expect(Object.keys(saved)).not.toContain('shippoApiKey');
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.shippo_api_key).toBe('shippo_test_1234567890');
      expect((init.headers as Record<string, string>).authorization).toBe(SESSION_BEARER);
    });

    it('quotes rates for a parcel and parses them', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          rates: [
            {
              rate_id: 'rate_1',
              provider: 'USPS',
              servicelevel: 'Ground',
              amount: '7.85',
              currency: 'USD',
              estimated_days: 3,
              duration_terms: null,
            },
          ],
        }),
      );

      const rates = await MarketplaceTransactionService.quoteShippingRates(ACTOR, ORDER_ID, {
        weightGrams: 900,
        lengthMm: 300,
        widthMm: 200,
        heightMm: 150,
      });

      expect(rates).toEqual([
        {
          rateId: 'rate_1',
          provider: 'USPS',
          servicelevel: 'Ground',
          amount: '7.85',
          currency: 'USD',
          estimatedDays: 3,
          durationTerms: null,
        },
      ]);
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://127.0.0.1:8080/v0/orders/${ORDER_ID}/shipping/rates`);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.weight_grams).toBe(900);
    });

    it('purchases a label and reads the stored one back; absent labels are null', async () => {
      await establishSession();
      const labelWire = {
        transaction_id: 'txn_1',
        carrier: 'USPS',
        servicelevel: 'Ground',
        amount: '7.85',
        currency: 'USD',
        tracking_number: 'TRACK123',
        tracking_url: null,
        label_url: 'https://deliver.goshippo.com/label_1.pdf',
        purchased_at: '2026-08-24T12:00:00.000Z',
      };
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse(200, { ok: true, label: labelWire }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true, label: labelWire }))
        .mockResolvedValueOnce(
          jsonResponse(404, {
            ok: false,
            error: { code: 'NOT_FOUND', message: 'No shipping label has been purchased for this order.' },
          }),
        );

      const purchased = await MarketplaceTransactionService.purchaseShippingLabel(ACTOR, ORDER_ID, 'rate_1');
      expect(purchased.trackingNumber).toBe('TRACK123');
      expect(purchased.labelUrl).toContain('.pdf');

      const stored = await MarketplaceTransactionService.getShippingLabel(ACTOR, ORDER_ID);
      expect(stored?.transactionId).toBe('txn_1');

      const missing = await MarketplaceTransactionService.getShippingLabel(ACTOR, ORDER_ID);
      expect(missing).toBeNull();
    });
  });
});

// -----------------------------------------------------------------------------
// Local pickup (Wave 7 safe subset) — request/response shapes captured from
// crates/service/tests/pickup_test.rs (snake_case on the wire).
// -----------------------------------------------------------------------------

const PICKUP_ORDER_ID = '00000000-0000-4000-8000-000000000920';

const spotDetailsWire = {
  kind: 'spot',
  spot: 'Central Station, north entrance',
  instructions: 'Ask for the blue backpack.',
  availability: {
    windows: [{ day: 'sat', start: '10:00', end: '14:00' }],
    zone: 'Europe/Berlin',
  },
};

function setPickupDetailsCommand() {
  return {
    version: 1 as const,
    commandId: COMMAND_ID,
    aggregateId: AGGREGATE_ID,
    expectedRevision: 0,
    issuedAt: '2026-08-19T22:00:00.000Z',
    kind: 'pickup_details.set' as const,
    payload: {
      expectedVersion: 0,
      details: {
        kind: 'spot' as const,
        spot: 'Central Station, north entrance',
        instructions: 'Ask for the blue backpack.',
        availability: {
          windows: [{ day: 'sat' as const, start: '10:00', end: '14:00' }],
          zone: 'Europe/Berlin',
        },
      },
    },
  };
}

describe('MarketplaceTransactionService pickup commands', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  it('sends pickup_details.set as a snake_case envelope with the payload CAS', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        version: 1,
        command_id: COMMAND_ID,
        aggregate_id: AGGREGATE_ID,
        revision: 1,
        event_ids: ['00000000-0000-4000-8000-000000000701'],
        result: {
          kind: 'pickup_details',
          listing_aggregate_id: AGGREGATE_ID,
          version: 1,
          updated_at: '2026-08-19T22:00:00.000Z',
        },
      }),
    );

    const response = await MarketplaceTransactionService.execute(ACTOR, setPickupDetailsCommand());

    expect(response).toMatchObject({ ok: true, result: { kind: 'pickup_details', version: 1 } });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      version: 1,
      command_id: COMMAND_ID,
      aggregate_id: AGGREGATE_ID,
      expected_revision: 0,
      issued_at: '2026-08-19T22:00:00.000Z',
      kind: 'pickup_details.set',
      payload: { expected_version: 0, details: spotDetailsWire },
    });
  });

  it.each(['pickup_details.clear', 'fulfillment.mark_ready', 'fulfillment.confirm_pickup'] as const)(
    'accepts %s as a supported command kind',
    async (kind) => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          version: 1,
          command_id: COMMAND_ID,
          aggregate_id: kind.startsWith('fulfillment') ? `order:${PICKUP_ORDER_ID}` : AGGREGATE_ID,
          revision: 2,
          event_ids: [],
          result: { kind: 'order' },
        }),
      );
      const base = { version: 1 as const, commandId: COMMAND_ID, issuedAt: '2026-08-19T22:00:00.000Z' };
      const command =
        kind === 'pickup_details.clear'
          ? { ...base, aggregateId: AGGREGATE_ID, expectedRevision: 0, kind, payload: { expectedVersion: 3 } }
          : {
              ...base,
              aggregateId: `order:${PICKUP_ORDER_ID}`,
              expectedRevision: 1,
              kind,
              payload: { orderId: PICKUP_ORDER_ID },
            };
      const response = await MarketplaceTransactionService.execute(ACTOR, command);
      expect(response.ok).toBe(true);
    },
  );
});

describe('MarketplaceTransactionService.getOrderPickupDetails (the buyer reveal, §A3)', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  const revealWire = {
    order_id: PICKUP_ORDER_ID,
    first_revealed_at: '2026-08-19T22:05:00.000Z',
    lines: [
      {
        line_index: 0,
        listing_aggregate_id: AGGREGATE_ID,
        version: 1,
        current_version: 2,
        updated_since_payment: true,
        withdrawn_by_seller: false,
        updated_at: '2026-08-19T22:00:00.000Z',
        details: spotDetailsWire,
      },
    ],
  };

  it('reads the pinned snapshot per line with the service flags, camelCased', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, revealWire));

    const reveal = await MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8080/v1/orders/${PICKUP_ORDER_ID}/pickup-details`);
    expect((init.headers as Record<string, string>).authorization).toBe(SESSION_BEARER);
    expect(reveal.orderId).toBe(PICKUP_ORDER_ID);
    expect(reveal.firstRevealedAt).toBe('2026-08-19T22:05:00.000Z');
    expect(reveal.lines).toHaveLength(1);
    expect(reveal.lines[0]).toMatchObject({
      lineIndex: 0,
      version: 1,
      currentVersion: 2,
      updatedSincePayment: true,
      withdrawnBySeller: false,
    });
    expect(reveal.lines[0].details.value.spot).toBe('Central Station, north entrance');
  });

  it('keeps the revealed details masked at every serialization boundary', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, revealWire));

    const reveal = await MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID);

    const serialized = JSON.stringify(reveal);
    expect(serialized).not.toContain('Central Station');
    expect(serialized).not.toContain('blue backpack');
    expect(serialized).toContain('[redacted: pickup details]');
  });

  it.each([
    ['Pickup is unavailable on this deployment.', 'pickup_unavailable'],
    ['The order carries no payment confirmation.', 'payment_unconfirmed'],
    ['The order is terminal; the pickup details are no longer revealed.', 'order_terminal'],
    ['This order was confirmed by a sandbox payment; its pickup details are never revealed.', 'sandbox_confirmed'],
    ['This order carries no pinned pickup details.', 'no_pinned_details'],
    ['Only pickup orders carry pickup details.', 'not_pickup_order'],
  ] as const)('maps the INVALID_STATE refusal "%s" to a typed CONFLICT error', async (message, refusal) => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(409, { ok: false, error: { code: 'INVALID_STATE', message } }));

    await expect(MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID)).rejects.toMatchObject({
      category: 'client',
      code: 'CONFLICT',
      context: { statusCode: 409, refusal },
    });
  });

  it('maps pickup refusals to static copy and never logs the server message', async () => {
    await establishSession();
    const echoed = 'Meet at 14 Oak Lane after 6pm; ask for the red jacket.';
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(409, { ok: false, error: { code: 'INVALID_STATE', message: echoed } }),
    );
    const loggerError = vi.spyOn(Logger, 'error');

    const error = (await MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID).catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toMatchObject({
      category: 'client',
      code: 'CONFLICT',
      message: 'The pickup request was refused.',
      context: { statusCode: 409, refusal: null },
    });
    expect(error.message).not.toContain(echoed);
    expect(JSON.stringify(error.context)).not.toContain(echoed);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(echoed);
    loggerError.mockRestore();
  });

  it('maps the non-buyer 403 to an auth FORBIDDEN error', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(403, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Only the buyer may reveal the pickup details.' },
      }),
    );

    await expect(MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID)).rejects.toMatchObject({
      category: 'auth',
      code: 'FORBIDDEN',
    });
  });

  it('maps an absent or foreign order 404 to a client NOT_FOUND error', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'The order was not found.' } }),
    );

    await expect(MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID)).rejects.toMatchObject({
      category: 'client',
      code: 'NOT_FOUND',
    });
  });

  it('sends cache: no-store on the request, mirroring the service response header (WEB-03)', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, revealWire));

    await MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID);

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('no-store');
  });
});

describe('MarketplaceTransactionService.getListingPickupDetails (the seller owner read, §A4)', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  it('returns the current details with the version counter', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        listing_aggregate_id: AGGREGATE_ID,
        current: { details: spotDetailsWire, version: 4, updated_at: '2026-08-19T22:02:00.000Z' },
        last_version: 4,
      }),
    );

    const read = await MarketplaceTransactionService.getListingPickupDetails(ACTOR, AGGREGATE_ID);

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toBe(`http://127.0.0.1:8080/v1/listings/${encodeURIComponent(AGGREGATE_ID)}/pickup-details`);
    expect(read.listingAggregateId).toBe(AGGREGATE_ID);
    expect(read.current?.version).toBe(4);
    expect(read.current?.details.value.spot).toBe('Central Station, north entrance');
    expect(read.lastVersion).toBe(4);
    expect(JSON.stringify(read)).not.toContain('Central Station');
  });

  it('returns the post-clear shape: no current details, the counter survives', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { listing_aggregate_id: AGGREGATE_ID, current: null, last_version: 4 }),
    );

    const read = await MarketplaceTransactionService.getListingPickupDetails(ACTOR, AGGREGATE_ID);

    expect(read.current).toBeNull();
    expect(read.lastVersion).toBe(4);
  });

  it('maps a foreign or absent listing 404 to a client NOT_FOUND error', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'The listing was not found.' } }),
    );

    await expect(MarketplaceTransactionService.getListingPickupDetails(ACTOR, AGGREGATE_ID)).rejects.toMatchObject({
      category: 'client',
      code: 'NOT_FOUND',
    });
  });

  it('sends cache: no-store on the request, mirroring the service response header (WEB-03)', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { listing_aggregate_id: AGGREGATE_ID, current: null, last_version: 4 }),
    );

    await MarketplaceTransactionService.getListingPickupDetails(ACTOR, AGGREGATE_ID);

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('no-store');
  });
});

describe('pickup entitled reads never leak the plaintext into error telemetry', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  const SENTINEL = 'Central Station, north entrance';
  // A malformed 200 whose body carries revealed pickup plaintext (truncated
  // mid-payload, as a proxy/server fault would produce it).
  const MALFORMED_BODY = `{"order_id":"${PICKUP_ORDER_ID}","lines":[{"details":{"spot":"${SENTINEL}","instructions":"Ask for the blue backpack.`;

  const pickupReads = [
    ['buyer reveal', () => MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID)],
    ['seller owner read', () => MarketplaceTransactionService.getListingPickupDetails(ACTOR, AGGREGATE_ID)],
  ] as const;

  it.each(pickupReads)(
    'a malformed 200 on the %s throws INVALID_RESPONSE whose context, log output, and Sentry scrub carry no body excerpt',
    async (_label, read) => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(MALFORMED_BODY, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const loggerError = vi.spyOn(Logger, 'error');

      const error = (await read().catch((caught: unknown) => caught)) as AppError;

      expect(error).toMatchObject({ name: 'AppError', category: 'server', code: 'INVALID_RESPONSE' });
      // The thrown error's context carries the status code only — no excerpt.
      expect(JSON.stringify(error.context)).not.toContain(SENTINEL);
      expect(error.context).not.toHaveProperty('responseText');
      // No `cause` either: a V8 parse-error message can embed a window of the
      // malformed body, and Sentry's linkedErrors would attach it. (AppError
      // declares the own property unconditionally, so assert the value.)
      expect(error.cause).toBeUndefined();
      // The Err.* factory logged the same context: no excerpt there either.
      expect(loggerError).toHaveBeenCalled();
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(SENTINEL);
      // And the Sentry scrub of the error context is clean.
      const scrubbed = scrubSensitiveData(
        asOpaque<Parameters<typeof scrubSensitiveData>[0]>({
          message: error.message,
          contexts: { 'error.context': error.context },
        }),
      );
      expect(JSON.stringify(scrubbed)).not.toContain(SENTINEL);
      loggerError.mockRestore();
    },
  );

  it('negative control: the generic parseResponseOrThrow WOULD embed the excerpt — and the scrubber denylist now redacts it', async () => {
    const response = new Response(MALFORMED_BODY, { status: 200, headers: { 'content-type': 'application/json' } });

    const error = (await parseResponseOrThrow(
      response,
      ErrorService.Marketplace,
      'negativeControl',
      undefined,
      PARSE_JSON_WITH_BODY_EXCERPT,
    ).catch((caught: unknown) => caught)) as AppError;

    // Proves the fixture is sensitive and the pickup-specific parser above is
    // load-bearing: the generic path puts the body excerpt into the context.
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(JSON.stringify(error.context)).toContain(SENTINEL);
    expect(error.context).toHaveProperty('responseText');

    // Defense in depth: `responseText` is on the scrubber denylist, so even
    // this context is redacted before it can reach Sentry.
    const scrubbed = scrubSensitiveData(
      asOpaque<Parameters<typeof scrubSensitiveData>[0]>({
        message: error.message,
        contexts: { 'error.context': error.context },
      }),
    );
    expect(JSON.stringify(scrubbed)).not.toContain(SENTINEL);
    expect(JSON.stringify(scrubbed)).toContain('[redacted: sensitive field]');
  });
});

describe('MarketplaceTransactionService.getHealth (the pickup_available capability, §A7)', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  it.each([true, false])('parses pickup_available %s from the public health read', async (pickupAvailable) => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { status: 'ok', pickup_available: pickupAvailable }));

    const health = await MarketplaceTransactionService.getHealth();

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/health');
    // The capability read is deliberately public: no session, no bearer.
    expect(init?.headers).toBeUndefined();
    expect(health.pickupAvailable).toBe(pickupAvailable);
  });

  it('parses the pinned live production health response through the transport boundary', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(LIVE_HEALTH_RESPONSE, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const health = await MarketplaceTransactionService.getHealth();

    expect(health.pickupAvailable).toBe(true);
  });

  it('fails closed when pickup_available is missing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { status: 'ok' }));

    await expect(MarketplaceTransactionService.getHealth()).resolves.toMatchObject({ pickupAvailable: false });
  });

  it('fails closed and logs through Err when the health body is malformed JSON', async () => {
    const loggerError = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"status":"ok",', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(MarketplaceTransactionService.getHealth()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'Failed to parse JSON response',
    });
    expect(loggerError).toHaveBeenCalledWith(
      '[marketplace:getHealth]',
      'Failed to parse JSON response',
      expect.objectContaining({ endpoint: 'http://127.0.0.1:8080/health' }),
    );
    expect(JSON.stringify(loggerError.mock.calls[0])).not.toContain('responseText');
    loggerError.mockRestore();
  });
});

describe('MarketplaceTransactionService.getDrop (the seller drop projection)', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  const restoreRedactedIdentities = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll('…', 'z'.repeat(44));
    if (Array.isArray(value)) return value.map(restoreRedactedIdentities);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoreRedactedIdentities(entry)]));
    }
    return value;
  };

  function liveSellerDropBody() {
    return restoreRedactedIdentities(sellerDropCapture.response.body) as { drop: Record<string, unknown> };
  }

  it('parses the pinned live seller drop, reading the exact count from remaining_quantity', async () => {
    await establishSession();
    const body = liveSellerDropBody();
    const aggregateId = String(body.drop.aggregate_id);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(sellerDropCapture.response.status, body));

    const drop = await MarketplaceTransactionService.getDrop(ACTOR, aggregateId);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8080/v1/drops/${encodeURIComponent(aggregateId)}`);
    expect(init.cache).toBe('no-store');
    expect(drop).toMatchObject({
      aggregateId,
      state: 'live',
      stockDisplay: 'exact',
      totalQuantity: 1,
      perBuyerLimit: 1,
      remaining: 1,
      paidQuantity: 0,
      buyerCount: 0,
      listingIds: ['461aabf9c07e42bbbd0e212dc85e4cd8'],
      revision: 5,
      serverTime: '2026-09-23T09:17:09.589Z',
    });
  });

  it('fails closed when the seller read carries no exact count', async () => {
    const loggerError = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    await establishSession();
    const body = liveSellerDropBody();
    delete body.drop.remaining_quantity;
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, body));

    await expect(MarketplaceTransactionService.getDrop(ACTOR, String(body.drop.aggregate_id))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'Marketplace returned an invalid drop projection.',
    });
    loggerError.mockRestore();
  });
});

describe('MarketplaceTransactionService.getListingDigitalDelivery (digital delivery owner read, §6 C5)', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  const LINK_SENTINEL = 'https://example.com/seller-only-course-link';

  it('reads the current delivery with the bearer and no-store', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        listing_aggregate_id: AGGREGATE_ID,
        current: {
          kind: 'link',
          deliverable_id: 'a'.repeat(32),
          version: 2,
          created_at: '2026-09-25T10:00:00.000Z',
          url: LINK_SENTINEL,
        },
        last_version: 2,
        pinned_versions: [{ version: 1, live_orders: 3 }],
      }),
    );

    const read = await MarketplaceTransactionService.getListingDigitalDelivery(ACTOR, AGGREGATE_ID);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8080/v1/listings/${encodeURIComponent(AGGREGATE_ID)}/digital-delivery`);
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer /);
    expect(read.current?.url).toBe(LINK_SENTINEL);
    expect(read.pinnedVersions).toEqual([{ version: 1, liveOrders: 3 }]);
  });

  it('maps the unavailable refusal to a typed conflict carrying only the reason', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(409, {
        ok: false,
        error: {
          code: 'INVALID_STATE',
          message: 'Digital delivery is unavailable on this deployment.',
          reason: 'digital_delivery_unavailable',
        },
      }),
    );

    await expect(MarketplaceTransactionService.getListingDigitalDelivery(ACTOR, AGGREGATE_ID)).rejects.toMatchObject({
      category: 'client',
      code: 'CONFLICT',
      message: "Digital delivery isn't available on this deployment.",
      context: { refusal: 'digital_delivery_unavailable', statusCode: 409 },
    });
  });

  it('maps a foreign or absent listing to NOT_FOUND, and never copies the service message', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: `not found ${LINK_SENTINEL}` } }),
    );

    const error = (await MarketplaceTransactionService.getListingDigitalDelivery(ACTOR, AGGREGATE_ID).catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toMatchObject({ category: 'client', code: 'NOT_FOUND' });
    expect(`${error.message} ${JSON.stringify(error.context)}`).not.toContain(LINK_SENTINEL);
  });

  it('throws INVALID_RESPONSE with no body excerpt for a malformed 200', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(`{"current":{"url":"${LINK_SENTINEL}`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const loggerError = vi.spyOn(Logger, 'error');

    const error = (await MarketplaceTransactionService.getListingDigitalDelivery(ACTOR, AGGREGATE_ID).catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toMatchObject({ category: 'server', code: 'INVALID_RESPONSE' });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error.context)).not.toContain(LINK_SENTINEL);
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(LINK_SENTINEL);
    loggerError.mockRestore();
  });

  it('carries digital_delivery.set and .clear to the service', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        version: 1,
        command_id: '018f47d2-6a27-7c23-a62f-000000000751',
        aggregate_id: AGGREGATE_ID,
        revision: 1,
        event_ids: ['018f47d2-6a27-7c23-a62f-000000000752'],
        result: {
          kind: 'digital_delivery',
          listing_aggregate_id: AGGREGATE_ID,
          delivery_kind: 'email',
          deliverable_id: 'a'.repeat(32),
          version: 1,
          updated_at: '2026-09-25T10:00:00.000Z',
        },
      }),
    );

    const response = await MarketplaceTransactionService.execute(ACTOR, {
      version: 1,
      commandId: '018f47d2-6a27-7c23-a62f-000000000751',
      aggregateId: AGGREGATE_ID,
      expectedRevision: 0,
      issuedAt: '2026-09-25T10:00:00.000Z',
      kind: 'digital_delivery.set',
      payload: { expectedVersion: 0, delivery: { kind: 'email' } },
    });

    expect(response.ok).toBe(true);
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      kind: 'digital_delivery.set',
      payload: { expected_version: 0, delivery: { kind: 'email' } },
    });
  });
});

describe('MarketplaceTransactionService buyer digital reads (digital delivery design §4.2, §4.3, §6 D5–D11, F5–F9)', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  const ORDER_ID = '018f47d2-6a27-7c23-a62f-000000000901';
  const KEY_SENTINEL = 'c'.repeat(64);
  const fileLine = {
    line_index: 0,
    listing_aggregate_id: `listing:${OTHER_ACTOR}_guide`,
    kind: 'file',
    seller_pubky: OTHER_ACTOR,
    deliverable_id: 'a'.repeat(32),
    version: 2,
    key: KEY_SENTINEL,
    iv: 'd'.repeat(24),
    ciphertext_blake3: 'e'.repeat(64),
    plaintext_blake3: 'f'.repeat(64),
    content_type: 'application/pdf',
    file_name: 'Field Guide.pdf',
    size_bytes: 12_582_912,
  };

  it('reads the pinned payload for the buyer with the bearer and no-store', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        order_id: ORDER_ID,
        lines: [fileLine, { ...fileLine, line_index: 1, kind: 'text', text: 'Licence ABC-123', key: undefined }],
      }),
    );

    const read = await MarketplaceTransactionService.getOrderDigitalDelivery(ACTOR, ORDER_ID, 0);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8080/v1/orders/${ORDER_ID}/digital-delivery/0`);
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer /);
    expect(read.lines[0]).toMatchObject({ kind: 'file', sellerPubky: OTHER_ACTOR, key: KEY_SENTINEL, version: 2 });
    expect(read.lines[1]).toEqual({
      lineIndex: 1,
      listingAggregateId: `listing:${OTHER_ACTOR}_guide`,
      kind: 'text',
      sellerPubky: OTHER_ACTOR,
      deliverableId: 'a'.repeat(32),
      version: 2,
      text: 'Licence ABC-123',
    });
  });

  it.each([
    ['not_paid', 'Available as soon as payment is confirmed.'],
    ['delivery_ended', 'This order was refunded or cancelled, so the download is no longer available.'],
    ['sandbox_confirmed', "Sandbox orders don't deliver files."],
  ])('maps the %s refusal to a typed conflict (D8, D9, D11)', async (reason, message) => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(409, { ok: false, error: { code: 'INVALID_STATE', message: 'service words', reason } }),
    );

    await expect(MarketplaceTransactionService.getOrderDigitalDelivery(ACTOR, ORDER_ID, 0)).rejects.toMatchObject({
      category: 'client',
      code: 'CONFLICT',
      message,
      context: { refusal: reason, statusCode: 409 },
    });
  });

  it('maps a seller reading the buyer payload to FORBIDDEN (D6)', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(403, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Only the buyer may open the purchase.' },
      }),
    );

    await expect(MarketplaceTransactionService.getOrderDigitalDelivery(ACTOR, ORDER_ID, 0)).rejects.toMatchObject({
      category: 'auth',
      code: 'FORBIDDEN',
    });
  });

  it('refuses a payload whose file facts are malformed, with no excerpt', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { order_id: ORDER_ID, lines: [{ ...fileLine, key: `${KEY_SENTINEL}zz` }] }),
    );

    const error = (await MarketplaceTransactionService.getOrderDigitalDelivery(ACTOR, ORDER_ID, 0).catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toMatchObject({ category: 'server', code: 'INVALID_RESPONSE' });
    expect(JSON.stringify({ message: error.message, context: error.context ?? null })).not.toContain(KEY_SENTINEL);
    expect(error.cause).toBeUndefined();
  });

  it('reads the seller delivery evidence with the bearer and no-store, and maps a stranger to NOT_FOUND', async () => {
    await establishSession();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          order_id: ORDER_ID,
          delivered_at: '2026-09-26T13:01:00.000Z',
          first_opened_at: '2026-09-26T13:02:00.000Z',
          open_count: 3,
          emailed_at: null,
          message_delivered_at: null,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'nope' } }));

    await expect(MarketplaceTransactionService.getOrderDigitalEvidence(ACTOR, ORDER_ID)).resolves.toEqual({
      orderId: ORDER_ID,
      deliveredAt: '2026-09-26T13:01:00.000Z',
      firstOpenedAt: '2026-09-26T13:02:00.000Z',
      openCount: 3,
      emailedAt: null,
      messageDeliveredAt: null,
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8080/v1/orders/${ORDER_ID}/digital-evidence`);
    expect(init.cache).toBe('no-store');
    await expect(MarketplaceTransactionService.getOrderDigitalEvidence(ACTOR, ORDER_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reads the delivery email, and types a purged address as email_missing (F5, F9)', async () => {
    await establishSession();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(200, { order_id: ORDER_ID, delivery_email: 'buyer@example.com', emailed_at: null }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          ok: false,
          error: { code: 'INVALID_STATE', message: 'No delivery email is on file.', reason: 'email_missing' },
        }),
      );

    await expect(MarketplaceTransactionService.getOrderDeliveryEmail(ACTOR, ORDER_ID)).resolves.toEqual({
      orderId: ORDER_ID,
      deliveryEmail: 'buyer@example.com',
      emailedAt: null,
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8080/v1/orders/${ORDER_ID}/delivery-email`);
    expect(init.cache).toBe('no-store');
    await expect(MarketplaceTransactionService.getOrderDeliveryEmail(ACTOR, ORDER_ID)).rejects.toMatchObject({
      code: 'CONFLICT',
      context: { refusal: 'email_missing' },
    });
  });
});
