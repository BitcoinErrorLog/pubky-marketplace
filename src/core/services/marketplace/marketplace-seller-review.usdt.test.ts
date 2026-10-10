import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientErrorCode } from '@/libs/error/error.codes';
import {
  USDT_RESOLVE_IDEMPOTENCY_KEY,
  USDT_RESOLVE_ORDER_ID,
  USDT_RESOLVE_REFUNDED_WIRE_REQUEST,
  USDT_RESOLVE_REFUNDED_WIRE_RESPONSE,
  USDT_RESOLVE_REFUSAL_WIRES,
  USDT_RESOLVE_TX_HASH,
} from '@/test/fixtures/commerce/usdt-payment-review.wire';
import { MarketplaceSessionService } from './marketplace-session';
import { MarketplaceTransactionService } from './marketplace-transaction';

const ACTOR = 's'.repeat(52);

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => 'transaction-service',
    getMarketplaceUrl: () => 'http://marketplace.test',
  };
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function establishSession() {
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

describe('Marketplace seller payment review transport for a USDT order', () => {
  beforeEach(() => {
    MarketplaceSessionService.clearSession();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('posts the refund and its Arbitrum hash to the shared resolve route and reads the resolved order', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, USDT_RESOLVE_REFUNDED_WIRE_RESPONSE));

    const result = await MarketplaceTransactionService.resolveBitcoinPayment(
      ACTOR,
      USDT_RESOLVE_ORDER_ID,
      {
        outcome: 'refunded',
        reason: USDT_RESOLVE_REFUNDED_WIRE_REQUEST.body.reason,
        externalRefundReference: USDT_RESOLVE_TX_HASH,
      },
      USDT_RESOLVE_IDEMPOTENCY_KEY,
    );

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://marketplace.test${USDT_RESOLVE_REFUNDED_WIRE_REQUEST.path}`);
    expect(init.method).toBe(USDT_RESOLVE_REFUNDED_WIRE_REQUEST.method);
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(USDT_RESOLVE_IDEMPOTENCY_KEY);
    expect(JSON.parse(init.body as string)).toEqual(USDT_RESOLVE_REFUNDED_WIRE_REQUEST.body);
    expect(result.resolution).toMatchObject({ outcome: 'refunded', basis: 'seller_attestation' });
    expect(result.order).toMatchObject({
      state: 'refunded_external',
      paymentAsset: 'USDT',
      externalRefund: { transactionId: USDT_RESOLVE_TX_HASH },
    });
  });

  it.each([
    ['invalid_refund_reference', ClientErrorCode.BAD_REQUEST],
    ['refund_destination_required', ClientErrorCode.CONFLICT],
  ] as const)('maps the %s refusal to its static reason, never the service text', async (reason, code) => {
    await establishSession();
    const wire = USDT_RESOLVE_REFUSAL_WIRES[reason];
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(wire.status, wire.body));

    const failure = await MarketplaceTransactionService.resolveBitcoinPayment(
      ACTOR,
      USDT_RESOLVE_ORDER_ID,
      { outcome: 'refunded', externalRefundReference: USDT_RESOLVE_TX_HASH },
      USDT_RESOLVE_IDEMPOTENCY_KEY,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code, context: { statusCode: wire.status, reason } });
    expect(String((failure as Error).message)).not.toContain(wire.body.error.message);
  });
});
