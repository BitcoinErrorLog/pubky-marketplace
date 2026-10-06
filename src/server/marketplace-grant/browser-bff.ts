import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertSameOrigin, BffError, FLOW_COOKIE, parseStrictJson } from './bff';
import { canonicalZ32, clientIp, hashesEqual, requireUuid } from './cli-bff';
import type { CliGrantConfig } from './config';
import { getBrowserBootstrapConfig } from './config';
import {
  BrowserContextRefused,
  cookieMatches,
  decodeBase64Url32,
  deriveBrowserBootstrap,
  encodeBase64Url,
  hashBoundCookie,
  hashCliDeliveryId,
  makeBoundCookie,
  openBrowserFlowContext,
  parseBoundCookie,
  sealBrowserFlowContext,
  sha256Bytes,
} from './crypto';
import {
  abandonCliClaim,
  abandonLapsedCliClaim,
  acquireCliClaim,
  assertCliGrantSchema,
  bindCliFlow,
  CliChallengeConsumeConflict,
  type CliFlowRow,
  completeCliClaim,
  consumeChallengeAndInsertCliFlow,
  consumeCliRateLimit,
  getCliChallenge,
  getCliFlow,
  insertCliChallenge,
  renewCliClaim,
  terminalizeCliFlow,
} from './db';
import {
  assertProofMatches,
  type ExpectedProof,
  expectedProofDocument,
  fetchHomeserverProofDocument,
  parseProofDocument,
  proofUri,
} from './homeserver-proof';
import { cancelGrant, claimGrantResult, createBootstrapFlow, getGrantStatus } from './service';

/**
 * Browser purchase bootstrap for a Bitkit (grant) sign-in: the CLI verifier's
 * checks, run by the BFF for a same-origin browser. The result PoP seed is
 * derived from the state key and the challenge id (never stored on the
 * challenge row, never sent to the browser); the flow is bound to the
 * reconnect flow's `__Host-shop-marketplace-grant` cookie, not a CLI token.
 */
export const BOOTSTRAP_FLOW_COOKIE = FLOW_COOKIE;

const challengeBody = z.object({ pubky: z.string() }).strict();
const verifyBody = z.object({ nonce: z.string() }).strict();
const emptyBody = z.object({}).strict();
const VERIFY_PER_CHALLENGE_PER_MINUTE = 5;

export function requiredBrowserConfig(): CliGrantConfig {
  let config: CliGrantConfig | null;
  try {
    config = getBrowserBootstrapConfig();
  } catch {
    // A missing or invalid state key, database URL or verifier parameter.
    config = null;
  }
  if (!config) throw new BffError(404, 'grant_unavailable');
  return config;
}

async function rateLimit(config: CliGrantConfig, key: string, limit: number): Promise<void> {
  if (!(await consumeCliRateLimit(config, key, limit))) {
    throw new BffError(429, 'retry_later', 60);
  }
}

function proofInvalid(): never {
  throw new BffError(401, 'homeserver_proof_invalid');
}

export type BrowserChallengeResponse = {
  challenge_id: string;
  expires_at: string;
  nonce: string;
  proof_document: ExpectedProof;
  proof_uri: string;
  result_cpk: string;
  result_delivery_id: string;
};

export async function createBrowserChallenge(request: Request): Promise<BrowserChallengeResponse> {
  const config = requiredBrowserConfig();
  assertSameOrigin(request, config);
  await assertCliGrantSchema(config);
  const input = await parseStrictJson(request, challengeBody);
  const pubky = canonicalZ32(input.pubky);
  // No per-pubky bucket, for the reason at `createCliChallenge`.
  await rateLimit(
    config,
    `browser_challenge_ip:${clientIp(request, config.trustedProxyCount)}`,
    config.createPerIpPerMinute,
  );

  const challengeId = randomUUID();
  const derived = deriveBrowserBootstrap(config, config.stateKeyEpoch, challengeId);
  const nonce = Uint8Array.from(randomBytes(32));
  const expiresAt = new Date(Date.now() + config.challengeTtlSeconds * 1000);
  const resultDeliveryId = encodeBase64Url(derived.resultDeliveryId);
  await insertCliChallenge(config, {
    challengeId,
    pubky,
    resultCpk: derived.resultCpk,
    resultDeliveryIdHash: hashCliDeliveryId(config, config.stateKeyEpoch, challengeId, derived.resultDeliveryId),
    nonceHash: sha256Bytes(nonce),
    expiresAt,
  });
  // The proof body the grant session writes: only public, verifier-bound fields.
  // Its window comes from the stored row (database clock), which verify checks.
  const stored = await getCliChallenge(config, challengeId);
  if (!stored) throw new BffError(503, 'grant_unavailable');
  const iat = Math.ceil(stored.created_at.getTime() / 1000);
  const exp = Math.floor(stored.expires_at.getTime() / 1000);
  if (!(exp > iat)) throw new BffError(503, 'grant_unavailable');
  return {
    challenge_id: challengeId,
    expires_at: stored.expires_at.toISOString(),
    nonce: encodeBase64Url(nonce),
    proof_document: expectedProofDocument({
      aud: config.publicOrigin,
      challengeId,
      exp,
      iat,
      nonce,
      pubky,
      resultCpk: derived.resultCpk,
      resultDeliveryId,
    }),
    proof_uri: proofUri(pubky, challengeId),
    result_cpk: derived.resultCpk,
    result_delivery_id: resultDeliveryId,
  };
}

export async function verifyBrowserChallenge(
  request: Request,
  challengeIdParam: string,
): Promise<{
  cookie: string;
  maxAge: number;
  response: { authorization_url: string; expires_at: string; state_id: string; status: 'awaiting' };
}> {
  const config = requiredBrowserConfig();
  assertSameOrigin(request, config);
  await assertCliGrantSchema(config);
  const challengeId = requireUuid(challengeIdParam);
  const input = await parseStrictJson(request, verifyBody);
  let nonce: Uint8Array;
  try {
    nonce = decodeBase64Url32(input.nonce);
  } catch {
    throw new BffError(400, 'invalid_request');
  }
  await rateLimit(
    config,
    `browser_verify_ip:${clientIp(request, config.trustedProxyCount)}`,
    config.verifyPerIpPerMinute,
  );
  await rateLimit(config, `browser_verify_challenge:${challengeId}`, VERIFY_PER_CHALLENGE_PER_MINUTE);

  const challenge = await getCliChallenge(config, challengeId);
  if (!challenge) throw new BffError(404, 'challenge_not_found');
  if (challenge.consumed_at) throw new BffError(409, 'challenge_consumed');

  // Re-derive under the current epoch only. A rotation inside the challenge
  // window (or a CLI row, whose key the CLI chose) no longer matches: refuse
  // before consume, so no flow is created.
  const derived = deriveBrowserBootstrap(config, config.stateKeyEpoch, challengeId);
  if (
    derived.resultCpk !== challenge.result_cpk ||
    !hashesEqual(
      hashCliDeliveryId(config, config.stateKeyEpoch, challengeId, derived.resultDeliveryId),
      challenge.result_delivery_id_hash,
    )
  ) {
    throw new BffError(409, 'fresh_approval_required');
  }
  if (challenge.expires_at.getTime() <= Date.now()) proofInvalid();
  if (!hashesEqual(sha256Bytes(nonce), challenge.nonce_hash)) proofInvalid();

  const resultDeliveryId = encodeBase64Url(derived.resultDeliveryId);
  try {
    const parsed = await fetchHomeserverProofDocument(config, challenge.pubky, challengeId);
    const document = parseProofDocument(parsed);
    const createdSeconds = Math.floor(challenge.created_at.getTime() / 1000);
    const expiresSeconds = Math.floor(challenge.expires_at.getTime() / 1000);
    if (document.iat < createdSeconds) proofInvalid();
    if (document.exp > expiresSeconds) proofInvalid();
    if (!(document.exp > document.iat && document.exp - document.iat <= config.challengeTtlSeconds)) {
      proofInvalid();
    }
    if (document.result_delivery_id !== resultDeliveryId) proofInvalid();
    assertProofMatches(
      parsed,
      expectedProofDocument({
        aud: config.publicOrigin,
        challengeId,
        exp: document.exp,
        iat: document.iat,
        nonce,
        pubky: challenge.pubky,
        resultCpk: challenge.result_cpk,
        resultDeliveryId,
      }),
    );
  } catch (error) {
    if (error instanceof BffError) throw error;
    proofInvalid();
  }

  const stateId = randomUUID();
  const bound = makeBoundCookie(stateId);
  const tokenHash = hashBoundCookie(config, config.stateKeyEpoch, 'flow', stateId, bound.secret);
  const contextSealed = sealBrowserFlowContext(config, stateId, challenge.pubky, {
    kind: 'browser',
    resultDeliveryId,
    resultPopSeed: encodeBase64Url(derived.resultPopSeed),
    version: 2,
  });
  const localExpiry = new Date(Date.now() + config.stateTtlSeconds * 1000);
  try {
    await consumeChallengeAndInsertCliFlow(config, challengeId, {
      stateId,
      pubky: challenge.pubky,
      resultCpk: challenge.result_cpk,
      tokenHash,
      contextSealed,
      keyEpoch: config.stateKeyEpoch,
      expiresAt: localExpiry,
    });
  } catch (error) {
    if (error instanceof CliChallengeConsumeConflict) {
      throw new BffError(
        error.reason === 'consumed' ? 409 : 401,
        error.reason === 'consumed' ? 'challenge_consumed' : 'homeserver_proof_invalid',
      );
    }
    throw error;
  }

  try {
    const created = await createBootstrapFlow(config, resultDeliveryId, challenge.result_cpk, challenge.pubky);
    const serviceExpiry = new Date(created.expires_at);
    if (!(await bindCliFlow(config, stateId, created.flow_id, serviceExpiry))) {
      await terminalizeCliFlow(config, stateId, 'abandoned');
      throw new BffError(503, 'grant_unavailable');
    }
    return {
      cookie: bound.value,
      maxAge: Math.max(1, Math.floor((Math.min(localExpiry.getTime(), serviceExpiry.getTime()) - Date.now()) / 1000)),
      response: {
        authorization_url: created.authorization_url,
        expires_at: created.expires_at,
        state_id: stateId,
        status: 'awaiting',
      },
    };
  } catch (error) {
    await terminalizeCliFlow(config, stateId, 'abandoned');
    throw error;
  }
}

async function authenticatedBrowserFlow(
  request: Request,
  flowCookie: string | undefined,
  stateIdParam: string,
): Promise<{ config: CliGrantConfig; flow: CliFlowRow }> {
  const config = requiredBrowserConfig();
  assertSameOrigin(request, config);
  await assertCliGrantSchema(config);
  const stateId = requireUuid(stateIdParam);
  const parsed = parseBoundCookie(flowCookie);
  if (!parsed || parsed.id !== stateId) throw new BffError(401, 'flow_binding_missing');
  const flow = await getCliFlow(config, stateId);
  if (!flow) throw new BffError(404, 'flow_not_found');
  let expectedHash: Uint8Array;
  try {
    expectedHash = hashBoundCookie(config, flow.key_epoch, 'flow', stateId, parsed.secret);
  } catch {
    throw new BffError(422, 'fresh_approval_required');
  }
  if (!cookieMatches(flow.token_hash, expectedHash)) throw new BffError(403, 'flow_binding_denied');
  return { config, flow };
}

function openContext(config: CliGrantConfig, flow: CliFlowRow) {
  if (!flow.context_sealed) throw new BffError(403, 'result_denied');
  try {
    return openBrowserFlowContext(config, flow.state_id, flow.pubky, flow.key_epoch, flow.context_sealed);
  } catch (error) {
    if (error instanceof BrowserContextRefused && error.reason === 'epoch_unavailable') {
      throw new BffError(422, 'fresh_approval_required');
    }
    throw new BffError(403, 'result_denied');
  }
}

export type BrowserFlowPoll =
  | { expires_at: string; state_id: string; status: 'awaiting' | 'verifying' }
  | { state_id: string; status: 'mismatch' | 'expired' | 'cancelled' | 'failed' }
  | { capabilities: string; expires_at: string; pubky: string; state_id: string; status: 'connected'; token: string };

export async function pollBrowserFlow(
  request: Request,
  flowCookie: string | undefined,
  stateIdParam: string,
): Promise<BrowserFlowPoll> {
  const { config, flow } = await authenticatedBrowserFlow(request, flowCookie, stateIdParam);
  await parseStrictJson(request, emptyBody);
  await rateLimit(config, `browser_status_flow:${flow.state_id}`, config.statusPerTokenPerMinute);
  if (flow.expires_at.getTime() <= Date.now() && (flow.status === 'creating' || flow.status === 'awaiting')) {
    await terminalizeCliFlow(config, flow.state_id, 'expired');
    throw new BffError(410, 'flow_expired');
  }
  if (flow.status === 'expired') throw new BffError(410, 'flow_expired');
  if (flow.status === 'cancelled') throw new BffError(410, 'flow_cancelled');
  if (flow.status === 'mismatch') return { state_id: flow.state_id, status: 'mismatch' };
  if (flow.status === 'claiming') {
    // A claimer that died mid-claim leaves the row here until cleanup; once
    // its lease lapses the flow ends and the browser starts a fresh approval.
    if (await abandonLapsedCliClaim(config, flow.state_id)) throw new BffError(422, 'fresh_approval_required');
    throw new BffError(409, 'claim_in_progress');
  }
  if (flow.status !== 'awaiting' || !flow.flow_id) {
    throw new BffError(422, 'fresh_approval_required');
  }

  const status = await getGrantStatus(config, flow.flow_id);
  if (status.status === 'awaiting' || status.status === 'verifying') {
    return { expires_at: status.expires_at, state_id: flow.state_id, status: status.status };
  }
  if (status.status !== 'complete') {
    const localStatus = status.status === 'invalid' ? 'failed' : status.status;
    await terminalizeCliFlow(config, flow.state_id, localStatus);
    return {
      state_id: flow.state_id,
      status:
        localStatus === 'mismatch' || localStatus === 'expired' || localStatus === 'cancelled' ? localStatus : 'failed',
    };
  }

  const owner = randomUUID();
  const claimedFlow = await acquireCliClaim(config, flow.state_id, owner);
  if (!claimedFlow?.context_sealed || !claimedFlow.flow_id) {
    if (claimedFlow) await abandonCliClaim(config, flow.state_id, owner);
    throw new BffError(409, 'claim_in_progress');
  }
  try {
    const context = openContext(config, claimedFlow);
    const claimed = await claimGrantResult(
      config,
      claimedFlow.flow_id,
      context.resultDeliveryId,
      decodeBase64Url32(context.resultPopSeed),
      async () => {
        if (!(await renewCliClaim(config, flow.state_id, owner))) {
          throw new BffError(422, 'fresh_approval_required');
        }
      },
    );
    if (claimed.pubky !== claimedFlow.pubky) {
      await terminalizeCliFlow(config, flow.state_id, 'mismatch');
      throw new BffError(409, 'identity_mismatch');
    }
    if (!(await completeCliClaim(config, flow.state_id, owner))) {
      throw new BffError(422, 'fresh_approval_required');
    }
    return { ...claimed, state_id: flow.state_id, status: 'connected' };
  } catch (error) {
    if (!(error instanceof BffError && error.code === 'identity_mismatch')) {
      await abandonCliClaim(config, flow.state_id, owner);
    }
    if (error instanceof BffError) throw error;
    throw new BffError(422, 'fresh_approval_required');
  }
}

export async function cancelBrowserFlow(
  request: Request,
  flowCookie: string | undefined,
  stateIdParam: string,
): Promise<void> {
  const { config, flow } = await authenticatedBrowserFlow(request, flowCookie, stateIdParam);
  await parseStrictJson(request, emptyBody);
  if (flow.status !== 'awaiting' && flow.status !== 'creating') throw new BffError(403, 'result_denied');
  // Terminal first, so a context that cannot be opened still ends the flow
  // and no later poll can claim it. The service flow then expires on its own.
  // A flow whose key epoch left the config never reaches this line: its
  // cookie cannot be checked, and it cannot be claimed either.
  await terminalizeCliFlow(config, flow.state_id, 'cancelled');
  if (flow.flow_id && flow.context_sealed) {
    const context = openContext(config, flow);
    await cancelGrant(config, flow.flow_id, context.resultDeliveryId);
  }
}
