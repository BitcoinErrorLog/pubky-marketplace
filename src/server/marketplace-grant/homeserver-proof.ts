import { Pubky, PublicKey } from '@synonymdev/pubky';
import { z } from 'zod';
import { getHomeserver, getHomeserverUrl } from '@/libs/runtime-config/runtime-config';
import type { CliGrantConfig } from './config';
import { canonicalJson, encodeBase64Url, sha256Bytes } from './crypto';
import { assertSafeHomeserverTarget, HomeserverFetchDenied, proofPath } from './ssrf';

const PROOF_BODY_LIMIT = 16 * 1024;
export const PROOF_DOMAIN = 'shop-bff/cli-grant-homeserver-pop/v1';

export type ExpectedProof = {
  aud: string;
  challenge_id: string;
  domain: typeof PROOF_DOMAIN;
  exp: number;
  iat: number;
  nonce_hash: string;
  pubky: string;
  result_cpk: string;
  result_delivery_id: string;
};

const proofSchema = z
  .object({
    aud: z.string(),
    challenge_id: z.string(),
    domain: z.literal(PROOF_DOMAIN),
    exp: z.number().int(),
    iat: z.number().int(),
    nonce_hash: z.string(),
    pubky: z.string(),
    result_cpk: z.string(),
    result_delivery_id: z.string(),
  })
  .strict();

export function proofUri(pubky: string, challengeId: string): string {
  return `pubky://${pubky}/pub/pubky.app/marketplace/v1/cli-grant-proofs/${challengeId}`;
}

export function expectedProofDocument(input: {
  aud: string;
  challengeId: string;
  exp: number;
  iat: number;
  nonce: Uint8Array;
  pubky: string;
  resultCpk: string;
  resultDeliveryId: string;
}): ExpectedProof {
  return {
    aud: input.aud,
    challenge_id: input.challengeId,
    domain: PROOF_DOMAIN,
    exp: input.exp,
    iat: input.iat,
    nonce_hash: encodeBase64Url(sha256Bytes(input.nonce)),
    pubky: input.pubky,
    result_cpk: input.resultCpk,
    result_delivery_id: input.resultDeliveryId,
  };
}

export function parseProofDocument(value: unknown): ExpectedProof {
  try {
    return proofSchema.parse(value);
  } catch {
    throw new HomeserverFetchDenied();
  }
}

export function assertProofMatches(parsed: unknown, expected: ExpectedProof): void {
  if (canonicalJson(parsed) !== canonicalJson(expected)) throw new HomeserverFetchDenied();
}

export type HomeserverProofDeps = {
  resolveHomeserverZ32: (pubky: string) => Promise<string | null>;
  homeserverHttpsOrigin: () => string;
  configuredHomeserverZ32: () => string;
  fetchProof: (url: URL, init: RequestInit) => Promise<Response>;
  checkTarget: (url: URL) => Promise<void>;
};

const defaultDeps: HomeserverProofDeps = {
  async resolveHomeserverZ32(pubky) {
    const user = PublicKey.from(pubky);
    const resolved = await new Pubky().getHomeserverOf(user);
    return resolved?.z32() ?? null;
  },
  homeserverHttpsOrigin: () => getHomeserverUrl(),
  configuredHomeserverZ32: () => getHomeserver(),
  fetchProof: (url, init) => fetch(url, init),
  checkTarget: assertSafeHomeserverTarget,
};

export async function fetchHomeserverProofDocument(
  config: CliGrantConfig,
  pubky: string,
  challengeId: string,
  deps: HomeserverProofDeps = defaultDeps,
): Promise<unknown> {
  try {
    const resolved = await deps.resolveHomeserverZ32(pubky);
    if (!resolved || resolved !== deps.configuredHomeserverZ32()) {
      throw new HomeserverFetchDenied();
    }
    const origin = new URL(deps.homeserverHttpsOrigin());
    origin.pathname = '/';
    origin.search = '';
    origin.hash = '';
    const url = new URL(proofPath(challengeId), origin);
    await deps.checkTarget(url);
    const response = await deps.fetchProof(url, {
      method: 'GET',
      headers: { 'pubky-host': pubky, accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(config.homeserverFetchTimeoutMs),
    });
    if (response.status !== 200) throw new HomeserverFetchDenied();
    const text = await response.text();
    if (Buffer.byteLength(text) > PROOF_BODY_LIMIT) throw new HomeserverFetchDenied();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HomeserverFetchDenied();
    }
  } catch (error) {
    if (error instanceof HomeserverFetchDenied) throw error;
    throw new HomeserverFetchDenied();
  }
}

export async function fetchAndMatchHomeserverProof(
  config: CliGrantConfig,
  expected: ExpectedProof,
  deps: HomeserverProofDeps = defaultDeps,
): Promise<void> {
  const parsed = await fetchHomeserverProofDocument(config, expected.pubky, expected.challenge_id, deps);
  parseProofDocument(parsed);
  assertProofMatches(parsed, expected);
}
