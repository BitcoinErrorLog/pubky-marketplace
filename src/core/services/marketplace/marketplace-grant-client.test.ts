import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import captured from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import { beginMarketplaceGrantFlow } from './marketplace-grant-client';

const STATE_ID = '11111111-1111-4111-8111-111111111111';

type CapturedRequest = { scheme: string; host: string; params: string[]; caps: string; cid: string };

function urlFor(request: CapturedRequest, caps = request.caps): string {
  const values: Record<string, string> = {
    caps,
    relay: 'https://relay.example/inbox',
    secret: 's',
    cid: request.cid,
    cpk: 'k',
  };
  return `${request.scheme}//${request.host}?${request.params
    .map((name) => `${name}=${encodeURIComponent(values[name])}`)
    .join('&')}`;
}

function created(authorizationUrl: string): Response {
  return new Response(
    JSON.stringify({
      authorization_url: authorizationUrl,
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      state_id: STATE_ID,
      status: 'awaiting',
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
}

describe('marketplace reconnect grant client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it.each([
    ['the /priv parity grant', captured.parity_request],
    ['the previous service grant', captured.previous_request],
  ])('shows %s to the signer', async (_label, request) => {
    const url = urlFor(request);
    fetchMock.mockResolvedValueOnce(created(url));

    const flow = await beginMarketplaceGrantFlow();

    expect(flow.authorizationUrl).toBe(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the Shop sign-in grant', captured.shop_signin_request.caps],
    ['homeserver root', '/:rw'],
    ['an extra tree', `${captured.parity_request.caps},/pub/paykit/:rw`],
  ])('cancels instead of showing a QR that asks for %s', async (_label, caps) => {
    fetchMock
      .mockResolvedValueOnce(created(urlFor(captured.parity_request, caps)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(beginMarketplaceGrantFlow()).rejects.toThrow('result_denied');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/marketplace/grant-flows',
      `/api/marketplace/grant-flows/${STATE_ID}/cancel`,
    ]);
  });
});
