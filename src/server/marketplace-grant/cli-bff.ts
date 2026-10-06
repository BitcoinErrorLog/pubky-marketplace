import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PublicKey } from '@synonymdev/pubky';
import { z } from 'zod';
import { BffError, parseStrictJson } from './bff';
import type { CliGrantConfig } from './config';
import { getCliGrantConfig } from './config';
import {
  cookieMatches,
  decodeBase64Url32,
  deriveBrowserBootstrap,
  encodeBase64Url,
  hashCliDeliveryId,
  hashCliToken,
  makeBoundCookie,
  openCliFlowContext,
  openCliResultToken,
  parseBoundCookie,
  sealCliFlowContext,
  sealCliResultToken,
  sha256Bytes,
} from './crypto';
import {
  abandonCliClaim,
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
  storeCliResultToken,
  terminalizeCliFlow,
} from './db';
import {
  assertProofMatches,
  expectedProofDocument,
  fetchHomeserverProofDocument,
  parseProofDocument,
  proofUri,
} from './homeserver-proof';
import {
  cancelGrant,
  claimGrantResultWithProof,
  createBootstrapFlow,
  getGrantStatus,
  GrantServiceError,
  issueNonce,
  ticketGrantResult,
} from './service';
import { HomeserverFetchDenied } from './ssrf';

const Z32 = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLI_AUTH_SCHEME = 'PubkyShopCli ';
const RESULT_FLOW_PER_MINUTE = 10;
const VERIFY_PER_CHALLENGE_PER_MINUTE = 5;

const challengeBody = z
  .object({
    pubky: z.string(),
    result_cpk: z.string(),
    result_delivery_id: z.string(),
  })
  .strict();
const verifyBody = z.object({ nonce: z.string() }).strict();
const emptyBody = z.object({}).strict();
const nonceBody = z.object({ purpose: z.enum(['ticket', 'claim']) }).strict();
const proofBody = z
  .object({
    proof: z
      .object({
        issued_at: z.number().int(),
        nonce: z.string(),
        nonce_id: z.uuid(),
        signature: z.string(),
      })
      .strict(),
  })
  .strict();

export function canonicalZ32(value: string): string {
  if (!Z32.test(value)) throw new BffError(400, 'invalid_request');
  let key: PublicKey;
  try {
    key = PublicKey.from(value);
  } catch {
    throw new BffError(400, 'invalid_request');
  }
  if (key.z32() !== value) throw new BffError(400, 'invalid_request');
  return value;
}

export function requireUuid(value: string): string {
  if (!UUID.test(value)) throw new BffError(400, 'invalid_request');
  return value;
}

/**
 * The hop the platform wrote. Vercel overwrites `x-vercel-forwarded-for`
 * with the address it received the request from; a proxy that appends
 * instead leaves any client-written hops to the left, so the leftmost hop is
 * never trusted.
 */
function lastHop(value: string | null): string {
  const hops =
    value
      ?.split(',')
      .map((hop) => hop.trim())
      .filter(Boolean) ?? [];
  return hops.at(-1) ?? '';
}

function platformRequestIp(request: Request): string {
  if ('ip' in request && typeof (request as { ip?: unknown }).ip === 'string') {
    return (request as { ip: string }).ip.trim();
  }
  return '';
}

function xffHopBehindTrustedProxies(forwarded: string | null, trustedProxyCount: number): string {
  if (trustedProxyCount < 1 || !forwarded) return '';
  const hops = forwarded
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  const index = hops.length - trustedProxyCount;
  if (index < 0) return '';
  return hops[index] ?? '';
}

export function clientIp(request: Request, trustedProxyCount: number): string {
  if (process.env.VERCEL === '1') {
    return lastHop(request.headers.get('x-vercel-forwarded-for')) || platformRequestIp(request) || '0.0.0.0';
  }
  return xffHopBehindTrustedProxies(request.headers.get('x-forwarded-for'), trustedProxyCount) || '0.0.0.0';
}

function tokenBucketKey(prefix: string, digest: Uint8Array): string {
  return `${prefix}:${Buffer.from(digest).toString('hex')}`;
}

export function hashesEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function requiredCliConfig(): CliGrantConfig {
  const config = getCliGrantConfig();
  if (!config) throw new BffError(404, 'grant_unavailable');
  return config;
}

async function rateLimit(config: CliGrantConfig, key: string, limit: number): Promise<void> {
  if (!(await consumeCliRateLimit(config, key, limit))) {
    throw new BffError(429, 'retry_later', 60);
  }
}

export function isBrowserBootstrapRow(config: CliGrantConfig, challengeId: string, resultCpk: string): boolean {
  const epochs = [config.stateKeyEpoch];
  if (config.previousStateKey && config.previousStateKeyEpoch !== undefined) epochs.push(config.previousStateKeyEpoch);
  return epochs.some((epoch) => deriveBrowserBootstrap(config, epoch, challengeId).resultCpk === resultCpk);
}

function proofInvalid(): never {
  throw new BffError(401, 'homeserver_proof_invalid');
}

export async function createCliChallenge(request: Request): Promise<{
  challenge_id: string;
  expires_at: string;
  nonce: string;
  proof_uri: string;
}> {
  const config = requiredCliConfig();
  await assertCliGrantSchema(config);
  const input = await parseStrictJson(request, challengeBody);
  const pubky = canonicalZ32(input.pubky);
  const resultCpk = canonicalZ32(input.result_cpk);
  let deliveryId: Uint8Array;
  try {
    deliveryId = decodeBase64Url32(input.result_delivery_id);
  } catch {
    throw new BffError(400, 'invalid_request');
  }
  // Challenge creation is unauthenticated and may name any pubky, so there is
  // no per-pubky bucket: whoever spends it could lock the owner out, from any
  // address. The per-IP bucket alone bounds creation. Clients behind one NAT or
  // VPN exit share it, as with every per-source limit on unauthenticated input.
  await rateLimit(
    config,
    `cli_challenge_ip:${clientIp(request, config.trustedProxyCount)}`,
    config.createPerIpPerMinute,
  );
  const challengeId = randomUUID();
  const nonce = Uint8Array.from(randomBytes(32));
  const expiresAt = new Date(Date.now() + config.challengeTtlSeconds * 1000);
  await insertCliChallenge(config, {
    challengeId,
    pubky,
    resultCpk,
    resultDeliveryIdHash: hashCliDeliveryId(config, config.stateKeyEpoch, challengeId, deliveryId),
    nonceHash: sha256Bytes(nonce),
    expiresAt,
  });
  return {
    challenge_id: challengeId,
    expires_at: expiresAt.toISOString(),
    nonce: encodeBase64Url(nonce),
    proof_uri: proofUri(pubky, challengeId),
  };
}

export async function verifyCliChallenge(
  request: Request,
  challengeIdParam: string,
): Promise<{
  authorization_url: string;
  cli_token: string;
  expires_at: string;
  flow_id: string;
  state_id: string;
  status: 'awaiting';
}> {
  const config = requiredCliConfig();
  await assertCliGrantSchema(config);
  const challengeId = requireUuid(challengeIdParam);
  const input = await parseStrictJson(request, verifyBody);
  let nonce: Uint8Array;
  try {
    nonce = decodeBase64Url32(input.nonce);
  } catch {
    throw new BffError(400, 'invalid_request');
  }
  await rateLimit(config, `cli_verify_ip:${clientIp(request, config.trustedProxyCount)}`, config.verifyPerIpPerMinute);
  await rateLimit(config, `cli_verify_challenge:${challengeId}`, VERIFY_PER_CHALLENGE_PER_MINUTE);
  const challenge = await getCliChallenge(config, challengeId);
  if (!challenge) throw new BffError(404, 'challenge_not_found');
  if (challenge.consumed_at) throw new BffError(409, 'challenge_consumed');
  // A browser bootstrap row carries a server-derived result key; the CLI
  // route must not consume it (the CLI context it would write holds no seed).
  if (isBrowserBootstrapRow(config, challengeId, challenge.result_cpk)) {
    throw new BffError(404, 'challenge_not_found');
  }
  if (challenge.expires_at.getTime() <= Date.now()) proofInvalid();
  if (!hashesEqual(sha256Bytes(nonce), challenge.nonce_hash)) proofInvalid();

  let deliveryIdCanonical: string;
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
    const deliveryId = decodeBase64Url32(document.result_delivery_id);
    if (
      !hashesEqual(
        hashCliDeliveryId(config, config.stateKeyEpoch, challengeId, deliveryId),
        challenge.result_delivery_id_hash,
      )
    ) {
      proofInvalid();
    }
    const expected = expectedProofDocument({
      aud: config.publicOrigin,
      challengeId,
      exp: document.exp,
      iat: document.iat,
      nonce,
      pubky: challenge.pubky,
      resultCpk: challenge.result_cpk,
      resultDeliveryId: document.result_delivery_id,
    });
    assertProofMatches(parsed, expected);
    deliveryIdCanonical = document.result_delivery_id;
  } catch (error) {
    if (error instanceof BffError) throw error;
    proofInvalid();
  }

  const stateId = randomUUID();
  const bound = makeBoundCookie(stateId);
  const tokenHash = hashCliToken(config, config.stateKeyEpoch, bound.secret);
  const contextSealed = sealCliFlowContext(config, stateId, challenge.pubky, {
    resultDeliveryId: deliveryIdCanonical,
    version: 1,
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
    const created = await createBootstrapFlow(config, deliveryIdCanonical, challenge.result_cpk, challenge.pubky);
    const serviceExpiry = new Date(created.expires_at);
    if (!(await bindCliFlow(config, stateId, created.flow_id, serviceExpiry))) {
      await terminalizeCliFlow(config, stateId, 'abandoned');
      throw new BffError(503, 'grant_unavailable');
    }
    return {
      authorization_url: created.authorization_url,
      cli_token: bound.value,
      expires_at: created.expires_at,
      flow_id: created.flow_id,
      state_id: stateId,
      status: 'awaiting',
    };
  } catch (error) {
    await terminalizeCliFlow(config, stateId, 'abandoned');
    if (error instanceof BffError) throw error;
    throw error;
  }
}

async function authenticateCliFlow(
  request: Request,
  stateIdParam: string,
  missing: 'status' | 'result',
): Promise<{ config: CliGrantConfig; flow: CliFlowRow; tokenHash: Uint8Array }> {
  const config = requiredCliConfig();
  await assertCliGrantSchema(config);
  const stateId = requireUuid(stateIdParam);
  const header = request.headers.get('authorization');
  if (!header?.startsWith(CLI_AUTH_SCHEME)) throw new BffError(401, 'cli_token_denied');
  const parsed = parseBoundCookie(header.slice(CLI_AUTH_SCHEME.length));
  if (!parsed || parsed.id !== stateId) throw new BffError(401, 'cli_token_denied');
  const flow = await getCliFlow(config, stateId);
  if (!flow) {
    throw new BffError(missing === 'status' ? 404 : 403, missing === 'status' ? 'flow_not_found' : 'result_denied');
  }
  const expectedHash = hashCliToken(config, flow.key_epoch, parsed.secret);
  if (!cookieMatches(flow.token_hash, expectedHash)) throw new BffError(401, 'cli_token_denied');
  return { config, flow, tokenHash: flow.token_hash };
}

async function requireLiveFlow(
  request: Request,
  stateIdParam: string,
  kind: 'status' | 'result',
): Promise<{ config: CliGrantConfig; flow: CliFlowRow; tokenHash: Uint8Array }> {
  const authenticated = await authenticateCliFlow(request, stateIdParam, kind);
  const { config, flow } = authenticated;
  if (flow.expires_at.getTime() <= Date.now() && (flow.status === 'creating' || flow.status === 'awaiting')) {
    await terminalizeCliFlow(config, flow.state_id, 'expired');
    throw new BffError(410, 'flow_expired');
  }
  if (kind === 'status') {
    if (flow.status === 'creating' && !flow.flow_id) throw new BffError(503, 'grant_unavailable');
    return authenticated;
  }
  if (flow.status === 'expired') throw new BffError(410, 'flow_expired');
  if (flow.status === 'cancelled') throw new BffError(410, 'flow_cancelled');
  if (flow.status !== 'awaiting' && flow.status !== 'claiming') {
    throw new BffError(403, 'result_denied');
  }
  if (!flow.flow_id) throw new BffError(403, 'result_denied');
  return authenticated;
}

export async function cliFlowStatus(
  request: Request,
  stateIdParam: string,
): Promise<{
  expires_at: string;
  flow_id: string | null;
  state_id: string;
  status: string;
  terminal_code: string | null;
}> {
  const { config, flow, tokenHash } = await requireLiveFlow(request, stateIdParam, 'status');
  await parseStrictJson(request, emptyBody);
  await rateLimit(config, tokenBucketKey('cli_status_token', tokenHash), config.statusPerTokenPerMinute);

  if (flow.status === 'claimed') {
    return {
      expires_at: flow.expires_at.toISOString(),
      flow_id: flow.flow_id,
      state_id: flow.state_id,
      status: 'complete',
      terminal_code: null,
    };
  }
  if (flow.status === 'expired') throw new BffError(410, 'flow_expired');
  if (flow.status === 'cancelled') throw new BffError(410, 'flow_cancelled');
  if (flow.status === 'failed' || flow.status === 'abandoned') {
    throw new BffError(422, 'fresh_approval_required');
  }
  if (flow.status === 'mismatch') {
    return {
      expires_at: flow.expires_at.toISOString(),
      flow_id: flow.flow_id,
      state_id: flow.state_id,
      status: 'mismatch',
      terminal_code: null,
    };
  }
  if (!flow.flow_id) throw new BffError(503, 'grant_unavailable');

  const status = await getGrantStatus(config, flow.flow_id);
  if (status.status === 'awaiting' || status.status === 'verifying' || status.status === 'complete') {
    return {
      expires_at: status.expires_at,
      flow_id: flow.flow_id,
      state_id: flow.state_id,
      status: status.status,
      terminal_code: status.terminal_code ?? null,
    };
  }
  const localStatus = status.status === 'invalid' ? 'failed' : status.status;
  await terminalizeCliFlow(config, flow.state_id, localStatus);
  return {
    expires_at: status.expires_at,
    flow_id: flow.flow_id,
    state_id: flow.state_id,
    status: status.status,
    terminal_code: status.terminal_code ?? null,
  };
}

async function rateLimitResult(config: CliGrantConfig, flow: CliFlowRow, tokenHash: Uint8Array): Promise<void> {
  await rateLimit(config, tokenBucketKey('cli_result_token', tokenHash), config.resultPerTokenPerMinute);
  await rateLimit(config, `cli_result_flow:${flow.state_id}`, RESULT_FLOW_PER_MINUTE);
}

function openDeliveryId(config: CliGrantConfig, flow: CliFlowRow): string {
  if (!flow.context_sealed) throw new BffError(403, 'result_denied');
  return openCliFlowContext(config, flow.state_id, flow.pubky, flow.key_epoch, flow.context_sealed).resultDeliveryId;
}

export async function issueCliResultNonce(
  request: Request,
  stateIdParam: string,
): Promise<{ expires_at: string; nonce: string; nonce_id: string }> {
  const { config, flow, tokenHash } = await requireLiveFlow(request, stateIdParam, 'result');
  const input = await parseStrictJson(request, nonceBody);
  await rateLimitResult(config, flow, tokenHash);
  if (!flow.flow_id) throw new BffError(403, 'result_denied');
  return await issueNonce(config, flow.flow_id, input.purpose);
}

export async function ticketCliResult(request: Request, stateIdParam: string): Promise<{ expires_at: string }> {
  const { config, flow, tokenHash } = await requireLiveFlow(request, stateIdParam, 'result');
  const input = await parseStrictJson(request, proofBody);
  await rateLimitResult(config, flow, tokenHash);
  if (flow.status !== 'awaiting' || !flow.flow_id || flow.result_token_sealed) {
    throw new BffError(403, 'result_denied');
  }
  const deliveryId = openDeliveryId(config, flow);
  const ticket = await ticketGrantResult(config, flow.flow_id, deliveryId, input.proof);
  const sealed = sealCliResultToken(config, flow.state_id, ticket.result_token);
  if (!(await storeCliResultToken(config, flow.state_id, sealed))) {
    throw new BffError(403, 'result_denied');
  }
  return { expires_at: ticket.expires_at };
}

export async function claimCliResult(
  request: Request,
  stateIdParam: string,
): Promise<{
  capabilities: string;
  expires_at: string;
  pubky: string;
  token: string;
}> {
  const { config, flow, tokenHash } = await requireLiveFlow(request, stateIdParam, 'result');
  const input = await parseStrictJson(request, proofBody);
  await rateLimitResult(config, flow, tokenHash);
  if (flow.status !== 'awaiting' || !flow.result_token_sealed || !flow.flow_id || !flow.context_sealed) {
    throw new BffError(403, 'result_denied');
  }
  const owner = randomUUID();
  const claimedFlow = await acquireCliClaim(config, flow.state_id, owner);
  if (!claimedFlow?.result_token_sealed || !claimedFlow.flow_id || !claimedFlow.context_sealed) {
    if (claimedFlow) await abandonCliClaim(config, flow.state_id, owner);
    throw new BffError(403, 'result_denied');
  }
  try {
    const deliveryId = openCliFlowContext(
      config,
      claimedFlow.state_id,
      claimedFlow.pubky,
      claimedFlow.key_epoch,
      claimedFlow.context_sealed,
    ).resultDeliveryId;
    const resultToken = openCliResultToken(
      config,
      claimedFlow.state_id,
      claimedFlow.key_epoch,
      claimedFlow.result_token_sealed,
    );
    if (!(await renewCliClaim(config, flow.state_id, owner))) {
      throw new BffError(422, 'fresh_approval_required');
    }
    const claimed = await claimGrantResultWithProof(config, claimedFlow.flow_id, deliveryId, resultToken, input.proof);
    if (claimed.pubky !== claimedFlow.pubky) {
      await terminalizeCliFlow(config, flow.state_id, 'mismatch');
      throw new BffError(409, 'identity_mismatch');
    }
    if (!(await completeCliClaim(config, flow.state_id, owner))) {
      throw new BffError(422, 'fresh_approval_required');
    }
    return {
      capabilities: claimed.capabilities,
      expires_at: claimed.expires_at,
      pubky: claimed.pubky,
      token: claimed.token,
    };
  } catch (error) {
    if (!(error instanceof BffError && error.code === 'identity_mismatch')) {
      await abandonCliClaim(config, flow.state_id, owner);
    }
    if (error instanceof BffError) throw error;
    throw new BffError(422, 'fresh_approval_required');
  }
}

export async function cancelCliFlow(request: Request, stateIdParam: string): Promise<void> {
  const { config, flow, tokenHash } = await requireLiveFlow(request, stateIdParam, 'result');
  await parseStrictJson(request, emptyBody);
  await rateLimitResult(config, flow, tokenHash);
  if (flow.status !== 'awaiting' && flow.status !== 'creating') throw new BffError(403, 'result_denied');
  if (flow.flow_id && flow.context_sealed) {
    const deliveryId = openDeliveryId(config, flow);
    await cancelGrant(config, flow.flow_id, deliveryId);
  }
  await terminalizeCliFlow(config, flow.state_id, 'cancelled');
}

export function mapCliBffError(error: unknown): { status: number; code: string; retryAfterSeconds?: number } {
  if (error instanceof BffError) {
    return { status: error.status, code: error.code, retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error instanceof HomeserverFetchDenied) {
    return { status: 401, code: 'homeserver_proof_invalid' };
  }
  if (error instanceof GrantServiceError) {
    if (error.status === 429 || error.code === 'capacity_exhausted') {
      return { status: 429, code: 'retry_later', retryAfterSeconds: 60 };
    }
    if (error.status === 410) {
      return {
        status: 410,
        code: error.code === 'flow_cancelled' ? 'flow_cancelled' : 'flow_expired',
      };
    }
    if (error.status === 422) {
      return {
        status: 422,
        code: error.code === 'fresh_approval_required' ? 'fresh_approval_required' : 'approval_invalid',
      };
    }
    if (error.status === 409 && error.code === 'identity_mismatch') {
      return { status: 409, code: 'identity_mismatch' };
    }
    if (error.status === 401 || error.status === 403) return { status: 403, code: 'result_denied' };
    if (error.status === 404) return { status: 403, code: 'result_denied' };
  }
  return { status: 503, code: 'grant_unavailable' };
}
