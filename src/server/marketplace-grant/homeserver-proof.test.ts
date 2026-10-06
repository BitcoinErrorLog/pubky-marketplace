/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CliGrantConfig } from './config';
import { encodeBase64Url, sha256Bytes } from './crypto';
import {
  assertProofMatches,
  expectedProofDocument,
  fetchHomeserverProofDocument,
  type HomeserverProofDeps,
  parseProofDocument,
} from './homeserver-proof';
import { HomeserverFetchDenied } from './ssrf';

const config = {
  homeserverFetchTimeoutMs: 5000,
} as CliGrantConfig;

const pubky = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const challengeId = '018f4f36-7a61-7d4e-8f22-3e31ed45d2af';
const nonce = new Uint8Array(32).fill(9);
const expected = expectedProofDocument({
  aud: 'https://shop.example',
  challengeId,
  exp: 1_760_000_060,
  iat: 1_760_000_000,
  nonce,
  pubky,
  resultCpk: pubky,
  resultDeliveryId: encodeBase64Url(new Uint8Array(32).fill(4)),
});

function deps(overrides: Partial<HomeserverProofDeps> = {}): HomeserverProofDeps {
  return {
    resolveHomeserverZ32: async () => 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy',
    homeserverHttpsOrigin: () => 'https://homeserver.example',
    configuredHomeserverZ32: () => 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy',
    fetchProof: async () => new Response(JSON.stringify(expected), { status: 200 }),
    checkTarget: async () => undefined,
    ...overrides,
  };
}

describe('CLI homeserver-session proof fetch', () => {
  it('does not GET when pkarr z32 does not match this deploy', async () => {
    const fetchProof = vi.fn();
    await expect(
      fetchHomeserverProofDocument(
        config,
        pubky,
        challengeId,
        deps({
          resolveHomeserverZ32: async () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          fetchProof,
        }),
      ),
    ).rejects.toBeInstanceOf(HomeserverFetchDenied);
    expect(fetchProof).not.toHaveBeenCalled();
  });

  it('does not GET when the SSRF check fails', async () => {
    const fetchProof = vi.fn();
    await expect(
      fetchHomeserverProofDocument(
        config,
        pubky,
        challengeId,
        deps({
          checkTarget: async () => {
            throw new HomeserverFetchDenied();
          },
          fetchProof,
        }),
      ),
    ).rejects.toBeInstanceOf(HomeserverFetchDenied);
    expect(fetchProof).not.toHaveBeenCalled();
  });

  it('GETs with pubky-host and no cookies, then requires JCS equality', async () => {
    const fetchProof = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.href).toBe(`https://homeserver.example/pub/pubky.app/marketplace/v1/cli-grant-proofs/${challengeId}`);
      expect(url.search).toBe('');
      expect(init.headers).toEqual({ 'pubky-host': pubky, accept: 'application/json' });
      expect(init.redirect).toBe('error');
      return new Response(JSON.stringify(expected), { status: 200 });
    });
    const parsed = await fetchHomeserverProofDocument(config, pubky, challengeId, deps({ fetchProof }));
    expect(parseProofDocument(parsed)).toEqual(expected);
    expect(() => assertProofMatches(parsed, expected)).not.toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => parseProofDocument({ ...expected, extra: true })).toThrow(HomeserverFetchDenied);
  });

  it('rejects a document that does not JCS-equal the expected object', () => {
    const other = { ...expected, aud: 'https://other.example' };
    expect(() => assertProofMatches(other, expected)).toThrow(HomeserverFetchDenied);
  });

  it('uses a distinct challenge id per call', () => {
    expect(expected.challenge_id).not.toBe(randomUUID());
    expect(expected.nonce_hash).toBe(encodeBase64Url(sha256Bytes(nonce)));
  });
});
