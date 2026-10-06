import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import { HomeserverService } from '@/services/homeserver/homeserver';
import captured from '@/test/fixtures/auth/marketplace-bootstrap-url.staging.json';
import parityCapture from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import { beginMarketplaceBootstrapFlow } from './marketplace-bootstrap-client';
import {
  MARKETPLACE_DISCLOSURE_INVENTORY,
  MARKETPLACE_DISCLOSURE_PRIVATE_DATA,
  MARKETPLACE_PREVIOUS_SESSION_GRANT,
  MARKETPLACE_SESSION_GRANT,
  marketplaceApprovalDisclosure,
} from './marketplace-session-grant';

vi.mock('@/services/homeserver/homeserver', () => ({
  HomeserverService: { request: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/libs/utils/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/utils/utils')>()),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const PUBKY = 'y'.repeat(52);
const CHALLENGE_ID = '018f4f36-7a61-7d4e-8f22-3e31ed45d2af';
const STATE_ID = '11111111-1111-4111-8111-111111111111';
const PROOF_URI = `pubky://${PUBKY}/pub/pubky.app/marketplace/v1/cli-grant-proofs/${CHALLENGE_ID}`;
const PROOF_DOCUMENT = { aud: 'https://shop.example', challenge_id: CHALLENGE_ID, pubky: PUBKY };

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    challenge_id: CHALLENGE_ID,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    nonce: 'n'.repeat(43),
    proof_document: PROOF_DOCUMENT,
    proof_uri: PROOF_URI,
    result_cpk: 'c'.repeat(52),
    result_delivery_id: 'd'.repeat(43),
    ...overrides,
  };
}

const BOOTSTRAP_URL =
  'pubkyauth://signin_grant?caps=%2Fpub%2Fpubky.app%2Fmarketplace-service%2Fv1%2F%3Arw&relay=https%3A%2F%2Frelay.example%2Finbox&secret=s&cid=shop.example&cpk=k';

const verified = {
  authorization_url: BOOTSTRAP_URL,
  expires_at: new Date(Date.now() + 120_000).toISOString(),
  state_id: STATE_ID,
  status: 'awaiting',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('marketplace purchase bootstrap client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(HomeserverService.request).mockResolvedValue(undefined as never);
    vi.mocked(HomeserverService.delete).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('grant session writes proof document', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(challenge(), 201)).mockResolvedValueOnce(jsonResponse(verified));

    const flow = await beginMarketplaceBootstrapFlow({ pubky: PUBKY });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/marketplace/bootstrap-challenges');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ pubky: PUBKY });
    expect(HomeserverService.request).toHaveBeenCalledWith({
      method: HttpMethod.PUT,
      url: PROOF_URI,
      bodyJson: PROOF_DOCUMENT,
    });
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/marketplace/bootstrap-challenges/${CHALLENGE_ID}/verify`);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ nonce: 'n'.repeat(43) });
    expect(flow.authorizationUrl).toBe(verified.authorization_url);
  });

  it('proof deleted after verify', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(challenge(), 201)).mockResolvedValueOnce(jsonResponse(verified));
    await beginMarketplaceBootstrapFlow({ pubky: PUBKY });
    expect(HomeserverService.delete).toHaveBeenCalledWith(PROOF_URI);

    vi.mocked(HomeserverService.delete).mockClear();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(challenge(), 201))
      .mockResolvedValueOnce(jsonResponse({ error: 'homeserver_proof_invalid' }, 401));
    await expect(beginMarketplaceBootstrapFlow({ pubky: PUBKY })).rejects.toThrow('homeserver_proof_invalid');
    expect(HomeserverService.delete).toHaveBeenCalledWith(PROOF_URI);
  });

  it('proof for a pubky the session cannot write fails', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(challenge({ proof_uri: `pubky://${'o'.repeat(52)}/pub/pubky.app/x` }), 201),
    );

    await expect(beginMarketplaceBootstrapFlow({ pubky: PUBKY })).rejects.toThrow('invalid_request');
    expect(HomeserverService.request).not.toHaveBeenCalled();
  });

  it('maps a refused homeserver write to shop_session_expired and never verifies', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(challenge(), 201));
    vi.mocked(HomeserverService.request).mockRejectedValue(
      new AppError({
        category: ErrorCategory.Auth,
        code: AuthErrorCode.SESSION_EXPIRED,
        message: 'Session expired',
        service: ErrorService.Homeserver,
        operation: 'request',
      }),
    );

    await expect(beginMarketplaceBootstrapFlow({ pubky: PUBKY })).rejects.toThrow('shop_session_expired');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(HomeserverService.delete).toHaveBeenCalledWith(PROOF_URI);
  });

  it('keeps polling while another poll holds the claim, then returns the claimed session', async () => {
    const claimed = {
      capabilities: '/pub/pubky.app/marketplace-service/v1/:rw',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      pubky: PUBKY,
      state_id: STATE_ID,
      status: 'connected',
      token: 'bearer',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(challenge(), 201))
      .mockResolvedValueOnce(jsonResponse(verified))
      .mockResolvedValueOnce(jsonResponse({ state_id: STATE_ID, status: 'awaiting', expires_at: verified.expires_at }))
      .mockResolvedValueOnce(jsonResponse({ error: 'claim_in_progress' }, 409))
      .mockResolvedValueOnce(jsonResponse(claimed));

    const flow = await beginMarketplaceBootstrapFlow({ pubky: PUBKY });
    await expect(flow.awaitResult()).resolves.toMatchObject({ status: 'connected', pubky: PUBKY, token: 'bearer' });
    expect(fetchMock.mock.calls.slice(2).map((call) => call[0])).toEqual([
      `/api/marketplace/bootstrap-flows/${STATE_ID}/status`,
      `/api/marketplace/bootstrap-flows/${STATE_ID}/status`,
      `/api/marketplace/bootstrap-flows/${STATE_ID}/status`,
    ]);
  });

  it('refuses and cancels a bootstrap QR that asks Bitkit for more than the marketplace session grant', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(challenge(), 201))
      .mockResolvedValueOnce(
        jsonResponse({
          ...verified,
          authorization_url: BOOTSTRAP_URL.replace(
            'caps=%2Fpub%2Fpubky.app%2Fmarketplace-service%2Fv1%2F%3Arw',
            'caps=%2Fpub%2Fpubky.app%2F%3Arw',
          ),
        }),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(beginMarketplaceBootstrapFlow({ pubky: PUBKY })).rejects.toThrow('result_denied');
    expect(fetchMock.mock.calls.map((call) => call[0])).toContain(
      `/api/marketplace/bootstrap-flows/${STATE_ID}/cancel`,
    );
  });

  function capturedUrl(shape: { scheme: string; host: string; params: string[]; caps: string; cid: string }) {
    const values: Record<string, string> = {
      caps: shape.caps,
      relay: 'https://relay.example/inbox',
      secret: 's',
      cid: shape.cid,
      cpk: 'k',
    };
    return `${shape.scheme}//${shape.host}?${shape.params
      .map((name) => `${name}=${encodeURIComponent(values[name])}`)
      .join('&')}`;
  }

  it('accepts the bootstrap url the service emitted before it requested /priv', async () => {
    const url = capturedUrl(captured);
    expect(captured.caps).toBe(MARKETPLACE_PREVIOUS_SESSION_GRANT);
    expect([...new URL(url).searchParams.keys()]).toEqual(captured.params);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(challenge(), 201))
      .mockResolvedValueOnce(jsonResponse({ ...verified, authorization_url: url }));
    const flow = await beginMarketplaceBootstrapFlow({ pubky: PUBKY });

    expect(flow.authorizationUrl).toBe(url);
    expect(marketplaceApprovalDisclosure(url)).toBe(MARKETPLACE_DISCLOSURE_INVENTORY);
  });

  it('accepts the /priv parity grant Bitkit approved on staging', async () => {
    const url = capturedUrl(parityCapture.parity_request);
    expect(parityCapture.parity_request.caps).toBe(MARKETPLACE_SESSION_GRANT);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(challenge(), 201))
      .mockResolvedValueOnce(jsonResponse({ ...verified, authorization_url: url }));
    const flow = await beginMarketplaceBootstrapFlow({ pubky: PUBKY });

    expect(flow.authorizationUrl).toBe(url);
    expect(marketplaceApprovalDisclosure(url)).toBe(MARKETPLACE_DISCLOSURE_PRIVATE_DATA);
  });

  it('cancel posts to the bootstrap cancel route once', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(challenge(), 201))
      .mockResolvedValueOnce(jsonResponse(verified))
      .mockResolvedValue(new Response(null, { status: 204 }));

    const flow = await beginMarketplaceBootstrapFlow({ pubky: PUBKY });
    await flow.cancel();
    await flow.cancel();

    const cancels = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/cancel'));
    expect(cancels.map((call) => call[0])).toEqual([`/api/marketplace/bootstrap-flows/${STATE_ID}/cancel`]);
  });
});
