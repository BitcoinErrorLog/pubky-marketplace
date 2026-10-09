import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import {
  PRIV_KEYS_WIRE_CUSTODY_RELEASED,
  PRIV_KEYS_WIRE_KEY_ID,
  PRIV_KEYS_WIRE_KEY_SET_CHANGED,
  PRIV_KEYS_WIRE_NEEDS_REAUTH,
  PRIV_KEYS_WIRE_OK,
  PRIV_KEYS_WIRE_OWNER,
  PRIV_KEYS_WIRE_RELEASE_OK,
  PRIV_KEYS_WIRE_UNAVAILABLE,
} from '@/test/fixtures/commerce/priv-keys.wire';
import { MarketplaceSessionService } from './marketplace-session';
import { MarketplaceTransactionService } from './marketplace-transaction';

const ACTOR = PRIV_KEYS_WIRE_OWNER;
const OTHER_ACTOR = 'b'.repeat(52);

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => 'transaction-service',
    getMarketplaceUrl: () => 'http://127.0.0.1:8080',
  };
});

vi.mock('@/services/homeserver/homeserver', () => ({
  HomeserverService: { generateAuthTokenFlow: vi.fn() },
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function establishSession(): Promise<void> {
  vi.mocked(fetch).mockResolvedValueOnce(
    jsonResponse(201, {
      token: 'A'.repeat(43),
      pubky: ACTOR,
      capabilities: '/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  );
  await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), ACTOR);
  vi.mocked(fetch).mockClear();
}

describe('MarketplaceTransactionService.getPrivKeys', () => {
  beforeEach(async () => {
    MarketplaceSessionService.clearSession();
    await establishSession();
  });

  it('reads the owner keyring with the session bearer and no cache', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, PRIV_KEYS_WIRE_OK));

    const result = await MarketplaceTransactionService.getPrivKeys(ACTOR);

    expect(result.kind).toBe('keys');
    if (result.kind !== 'keys') return;
    expect(result.keyring.ownerPubky).toBe(ACTOR);
    expect(result.keyring.currentKeyId).toBe(PRIV_KEYS_WIRE_KEY_ID);
    expect(result.keyring.keys).toHaveLength(1);
    expect(Array.from(result.keyring.keys[0].key)).toEqual(new Array(32).fill(7));
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/v1/me/priv-keys');
    expect(init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      headers: { authorization: `Bearer ${'A'.repeat(43)}` },
    });
  });

  it('maps 403 needs_reauth and 503 priv_keys_unavailable to states without key material', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(403, PRIV_KEYS_WIRE_NEEDS_REAUTH));
    expect(await MarketplaceTransactionService.getPrivKeys(ACTOR)).toEqual({ kind: 'needs_reauth' });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(503, PRIV_KEYS_WIRE_UNAVAILABLE));
    expect(await MarketplaceTransactionService.getPrivKeys(ACTOR)).toEqual({ kind: 'unavailable' });
  });

  it('reports a 409 custody_released as released keys, with no key material', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(409, PRIV_KEYS_WIRE_CUSTODY_RELEASED));
    expect(await MarketplaceTransactionService.getPrivKeys(ACTOR)).toEqual({ kind: 'released' });
  });

  it('throws a typed HTTP error on any other refusal instead of treating it as a state', async () => {
    for (const [status, body] of [
      [403, { error: { code: 'capability_required' } }],
      [503, { status: 'unavailable' }],
      [409, { error: { code: 'something_else' } }],
      [500, { error: { code: 'internal' } }],
    ] as const) {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(status, body));
      const error = await MarketplaceTransactionService.getPrivKeys(ACTOR).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).context).toMatchObject({ statusCode: status });
    }
  });

  it('refuses keys for another owner, wrong-length keys, duplicate ids and a missing current key', async () => {
    const bad = [
      { ...PRIV_KEYS_WIRE_OK, owner: OTHER_ACTOR },
      {
        ...PRIV_KEYS_WIRE_OK,
        keys: [{ ...PRIV_KEYS_WIRE_OK.keys[0], key: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc' }],
      },
      { ...PRIV_KEYS_WIRE_OK, keys: [PRIV_KEYS_WIRE_OK.keys[0], PRIV_KEYS_WIRE_OK.keys[0]] },
      { ...PRIV_KEYS_WIRE_OK, current_key_id: 'f'.repeat(32) },
      { ...PRIV_KEYS_WIRE_OK, keys: [] },
    ];
    for (const body of bad) {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, body));
      await expect(MarketplaceTransactionService.getPrivKeys(ACTOR)).rejects.toThrow();
    }
  });

  it('tolerates additional response fields', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { ...PRIV_KEYS_WIRE_OK, future_field: true }));
    expect((await MarketplaceTransactionService.getPrivKeys(ACTOR)).kind).toBe('keys');
  });

  it('never asks for another pubky with the current bearer', async () => {
    await expect(MarketplaceTransactionService.getPrivKeys(OTHER_ACTOR)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('MarketplaceTransactionService.releasePrivKeyCustody', () => {
  const KEY_IDS = [PRIV_KEYS_WIRE_KEY_ID];

  beforeEach(async () => {
    MarketplaceSessionService.clearSession();
    await establishSession();
  });

  it('names the keys it wrapped, with the session bearer, and resolves released', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, PRIV_KEYS_WIRE_RELEASE_OK));

    expect(await MarketplaceTransactionService.releasePrivKeyCustody(ACTOR, KEY_IDS)).toBe('released');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/v1/me/priv-keys/release');
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      headers: { authorization: `Bearer ${'A'.repeat(43)}`, 'content-type': 'application/json' },
    });
    expect(JSON.parse(init.body as string)).toEqual({ key_ids: KEY_IDS });
  });

  it('maps the refusals the caller can act on to states', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(403, PRIV_KEYS_WIRE_NEEDS_REAUTH));
    expect(await MarketplaceTransactionService.releasePrivKeyCustody(ACTOR, KEY_IDS)).toBe('needs_reauth');
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(503, PRIV_KEYS_WIRE_UNAVAILABLE));
    expect(await MarketplaceTransactionService.releasePrivKeyCustody(ACTOR, KEY_IDS)).toBe('unavailable');
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(409, PRIV_KEYS_WIRE_KEY_SET_CHANGED));
    expect(await MarketplaceTransactionService.releasePrivKeyCustody(ACTOR, KEY_IDS)).toBe('key_set_changed');
  });

  it('throws a typed HTTP error on any other refusal and on a success body that is not a release', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(400, { error: { code: 'invalid_request' } }));
    const error = await MarketplaceTransactionService.releasePrivKeyCustody(ACTOR, KEY_IDS).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).context).toMatchObject({ statusCode: 400 });

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { released: false }));
    await expect(MarketplaceTransactionService.releasePrivKeyCustody(ACTOR, KEY_IDS)).rejects.toThrow();
  });

  it('never releases for another pubky with the current bearer', async () => {
    await expect(MarketplaceTransactionService.releasePrivKeyCustody(OTHER_ACTOR, KEY_IDS)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
