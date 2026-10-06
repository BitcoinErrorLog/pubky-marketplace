/** @vitest-environment node */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z, ZodError } from 'zod';
import type { MarketplaceGrantConfig } from './config';
import { claimGrantResult, getGrantStatus, GrantServiceError, verifyMarketplaceSession } from './service';

/**
 * `GET /v1/auth/sessions` ids created 17–20 Sep 2026. Captured in
 * `.evidence/release-2026-09-28-shop-v0.6.33/DECISIONS-2026-09-28.md` item 2
 * and `staging/diag-sessions-schema.mjs`: the example `20ef0b02-b05d-aee7-…`
 * fails RFC 4122 because the version nibble is `a`. The full values were
 * truncated in that note. These are the same text migration 0035 stored:
 * `md5(encode(token_hash, 'hex'))` hyphenated as a PostgreSQL uuid.
 */
function migration0035SessionId(tokenHashHex: string): string {
  const hex = createHash('md5').update(tokenHashHex).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const legacySessionIds = {
  zeroTokenHash: migration0035SessionId('0'.repeat(64)),
  ffTokenHash: migration0035SessionId('f'.repeat(64)),
  versionNibbleA: migration0035SessionId((43).toString(16).padStart(64, '0')),
} as const;

const config: MarketplaceGrantConfig = {
  allowedOrigins: ['https://shop.example'],
  publicOrigin: 'https://shop.example',
  serviceUrl: 'https://service.example',
  databaseUrl: 'postgres://example',
  cronSecret: 'c'.repeat(32),
  assertionIssuer: 'https://shop.example',
  assertionKeyId: 'shop-bff-test-0001',
  assertionKeyEpoch: 1,
  assertionSigningKey: '11'.repeat(32),
  requestKeyId: 'shop-bff-test-request-0001',
  requestKeyEpoch: 1,
  requestSigningKey: '22'.repeat(32),
  stateKey: Buffer.alloc(32, 3).toString('base64'),
  stateKeyEpoch: 1,
  stateTtlSeconds: 300,
  claimLeaseSeconds: 25,
  databaseTimeoutMs: 2000,
  serviceTimeoutMs: 5000,
};

const pubky = 'y'.repeat(52);
const bearer = 'A'.repeat(43);
const sessionId = '018f4f36-7a61-7d4e-8f22-3e31ed45d2af';

describe('marketplace service session pairing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts only a seller-bound bearer with the exact live session id', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          schema_version: 1,
          sessions: [
            {
              id: sessionId,
              expires_at: '2099-01-01T00:00:00Z',
              revoked_at: null,
            },
          ],
        }),
      );
    await expect(verifyMarketplaceSession(config, bearer, pubky, sessionId)).resolves.toEqual(
      new Date('2099-01-01T00:00:00Z'),
    );
    expect(fetchMock.mock.calls[0][0]).toBe(`https://service.example/v1/sellers/${pubky}/listings?limit=1`);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ authorization: `Bearer ${bearer}` });
  });

  it('rejects a bearer whose service actor does not match the claimed Shop pubky', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(verifyMarketplaceSession(config, bearer, pubky, sessionId)).rejects.toEqual(
      new GrantServiceError(403, 'invalid_session_pair'),
    );
  });

  it('pairs a session list that contains migration-0035 ids', async () => {
    expect(legacySessionIds.zeroTokenHash).toBe('10eab600-8d56-42cf-42ab-d2aa41f847cb');
    expect(legacySessionIds.ffTokenHash).toBe('baf13e8b-16d8-c063-24d7-c9ab32cb7ff0');
    expect(legacySessionIds.versionNibbleA).toBe('c91ac604-4109-a63d-ab8b-327fc9decd05');
    expect(legacySessionIds.versionNibbleA[14]).toBe('a');

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          schema_version: 1,
          sessions: [
            {
              id: legacySessionIds.versionNibbleA,
              expires_at: '2099-01-01T00:00:00Z',
              revoked_at: null,
              created_at: '2026-09-18T12:00:00Z',
            },
            {
              id: sessionId,
              expires_at: '2099-01-01T00:00:00Z',
              revoked_at: null,
            },
            {
              id: legacySessionIds.zeroTokenHash,
              expires_at: '2099-01-01T00:00:00Z',
              revoked_at: null,
            },
            {
              id: legacySessionIds.ffTokenHash,
              expires_at: '2099-01-01T00:00:00Z',
              revoked_at: '2026-09-20T16:00:00Z',
            },
          ],
        }),
      );
    await expect(verifyMarketplaceSession(config, bearer, pubky, sessionId)).resolves.toEqual(
      new Date('2099-01-01T00:00:00Z'),
    );
  });

  it('revert-fail: session list pairs when the live id itself is a migration-0035 id', async () => {
    expect(z.uuid().safeParse(legacySessionIds.versionNibbleA).success).toBe(false);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          schema_version: 1,
          sessions: [
            {
              id: legacySessionIds.versionNibbleA,
              expires_at: '2099-06-01T00:00:00Z',
              revoked_at: null,
            },
          ],
        }),
      );
    await expect(verifyMarketplaceSession(config, bearer, pubky, legacySessionIds.versionNibbleA)).resolves.toEqual(
      new Date('2099-06-01T00:00:00Z'),
    );
  });

  it('still requires exact equality after a legacy id has parsed', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          schema_version: 1,
          sessions: [
            {
              id: legacySessionIds.zeroTokenHash,
              expires_at: '2099-01-01T00:00:00Z',
              revoked_at: null,
            },
          ],
        }),
      );
    await expect(verifyMarketplaceSession(config, bearer, pubky, sessionId)).rejects.toEqual(
      new GrantServiceError(401, 'invalid_session_pair'),
    );
  });

  it.each([
    ['plain string', 'shop-session-id-plain-string-1234567'],
    ['uppercase', 'C91AC604-4109-A63D-AB8B-327FC9DECD05'],
    ['without hyphens', 'c91ac6044109a63dab8b327fc9decd05'],
    ['empty', ''],
    ['newline', 'abc\n'],
    ['nul', 'ab\u0000c'],
    ['del', 'ab\u007Fc'],
  ])('rejects a session id that is %s', async (_label, id) => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          schema_version: 1,
          sessions: [{ id, expires_at: '2099-01-01T00:00:00Z', revoked_at: null }],
        }),
      );
    await expect(verifyMarketplaceSession(config, bearer, pubky, sessionId)).rejects.toBeInstanceOf(ZodError);
  });

  it('rejects a revoked service session even when the seller probe passes', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          schema_version: 1,
          sessions: [
            {
              id: sessionId,
              expires_at: '2099-01-01T00:00:00Z',
              revoked_at: '2026-09-20T16:00:00Z',
            },
          ],
        }),
      );
    await expect(verifyMarketplaceSession(config, bearer, pubky, sessionId)).rejects.toEqual(
      new GrantServiceError(401, 'invalid_session_pair'),
    );
  });
});

describe('marketplace grant status', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses a live awaiting GET body', async () => {
    const flowId = '018f4f36-7a61-7d4e-8f22-3e31ed45d2af';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({
        expires_at: '2026-09-21T10:05:00.000Z',
        flow_id: flowId,
        status: 'awaiting',
      }),
    );
    await expect(getGrantStatus(config, flowId)).resolves.toEqual({
      expires_at: '2026-09-21T10:05:00.000Z',
      flow_id: flowId,
      status: 'awaiting',
    });
  });

  it('maps a redacted 410 terminal body to invalid without throwing ZodError', async () => {
    const flowId = '018f4f36-7a61-7d4e-8f22-3e31ed45d2af';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'terminal' }), {
        status: 410,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const status = await getGrantStatus(config, flowId);
    expect(status.status).toBe('invalid');
    expect(status.flow_id).toBe(flowId);
    expect(status.terminal_code).toBeNull();
  });

  it('maps a live-shaped 410 body to invalid and does not parse it as awaiting', async () => {
    const flowId = '018f4f36-7a61-7d4e-8f22-3e31ed45d2af';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          expires_at: '2026-09-21T10:05:00.000Z',
          flow_id: flowId,
          status: 'awaiting',
        }),
        {
          status: 410,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const status = await getGrantStatus(config, flowId);
    expect(status.status).toBe('invalid');
    expect(status.flow_id).toBe(flowId);
    expect(status.terminal_code).toBeNull();
  });
});

describe('marketplace grant claim heartbeats', () => {
  afterEach(() => vi.restoreAllMocks());

  it('heartbeats after each slowed service call and still claims', async () => {
    const flowId = '018f4f36-7a61-7d4e-8f22-3e31ed45d2af';
    const order: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      order.push(`fetch:${url.slice(url.lastIndexOf('/') + 1)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (url.endsWith('/result-nonces')) {
        return Response.json({
          expires_at: '2099-01-01T00:00:00Z',
          nonce: 'nonce',
          nonce_id: sessionId,
        });
      }
      if (url.endsWith('/result-ticket')) {
        return Response.json({ expires_at: '2099-01-01T00:00:00Z', result_token: 'ticket' });
      }
      if (url.endsWith('/claim')) {
        return Response.json({
          capabilities: '',
          expires_at: '2099-01-01T00:00:00Z',
          pubky,
          token: bearer,
        });
      }
      return new Response('{}', { status: 500 });
    });
    const heartbeat = vi.fn(async () => {
      order.push('heartbeat');
    });
    await expect(
      claimGrantResult(
        config,
        flowId,
        'd'.repeat(43),
        Uint8Array.from({ length: 32 }, () => 7),
        heartbeat,
      ),
    ).resolves.toMatchObject({ pubky, token: bearer });
    expect(heartbeat).toHaveBeenCalledTimes(4);
    expect(order).toEqual([
      'fetch:result-nonces',
      'heartbeat',
      'fetch:result-ticket',
      'heartbeat',
      'fetch:result-nonces',
      'heartbeat',
      'fetch:claim',
      'heartbeat',
    ]);
  });
});
