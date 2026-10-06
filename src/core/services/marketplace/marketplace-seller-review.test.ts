import { beforeEach, describe, expect, it, vi } from 'vitest';
import confirmSamples from '@/libs/commerce/contracts/samples/confirm.json';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import { ClientErrorCode } from '@/libs/error/error.codes';
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

describe('Marketplace seller payment review transport', () => {
  beforeEach(() => {
    MarketplaceSessionService.clearSession();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('sends only the confirm reason body and preserves 403 session state', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(403, { ok: false, error: { reason: 'not_order_seller', message: 'attacker text' } }),
    );

    await expect(MarketplaceTransactionService.confirmBitcoinPayment(ACTOR, 'order-1', 'note')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'note' });
    expect(JSON.parse(init.body as string)).not.toHaveProperty('txid');
    expect(JSON.parse(init.body as string)).not.toHaveProperty('amount');
    expect(MarketplaceSessionService.getActiveSession()).not.toBeNull();
  });

  it('sends a stable idempotency header and maps conflict statically', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(409, { ok: false, error: { reason: 'conflict', message: 'attacker text' } }),
    );
    const key = crypto.randomUUID();
    await expect(
      MarketplaceTransactionService.resolveBitcoinPayment(ACTOR, 'order-1', { outcome: 'paid' }, key),
    ).rejects.toMatchObject({ code: ClientErrorCode.CONFLICT });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(key);
    expect(JSON.parse(init.body as string)).toEqual({ outcome: 'paid' });
  });

  it('accepts both captured confirmation success and replay responses', async () => {
    await establishSession();
    const confirmation = hydrate(confirmSamples.success.response.body.confirmation);
    const replay = hydrate(confirmSamples.replay.response.body.confirmation);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, confirmation }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, confirmation: replay }));

    await expect(MarketplaceTransactionService.confirmBitcoinPayment(ACTOR, 'order-1')).resolves.toMatchObject({
      order: null,
      confirmation: { confirmationBasis: 'seller_attestation' },
    });
    await expect(MarketplaceTransactionService.confirmBitcoinPayment(ACTOR, 'order-1')).resolves.toMatchObject({
      order: null,
      confirmation: { confirmationBasis: 'seller_attestation' },
    });
    expect(toCamelCaseWire(confirmation)).toHaveProperty('paykitObservation');
  });
});

function hydrate(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item !== 'string') return item;
      if (item.startsWith('<uuid:')) {
        const number = item.match(/\d+/)?.[0] ?? '1';
        return `018f47d2-6a27-7c23-a49d-${number.padStart(12, '0')}`;
      }
      if (item === '<pubky:buyer>') return 'b'.repeat(52);
      if (item === '<pubky:seller>') return 's'.repeat(52);
      return item;
    }),
  );
}
