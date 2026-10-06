import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { marketplaceSessionIdSchema } from '@/core/services/marketplace/marketplace-session-id';
import { getMarketplaceGrantConfig, type MarketplaceGrantConfig } from './config';
import {
  cookieMatches,
  decodeBase64Url32,
  encodeBase64Url,
  hashBoundCookie,
  makeBoundCookie,
  openBearer,
  openFlowContext,
  parseBoundCookie,
  resultPublicKey,
  sealBearer,
  sealFlowContext,
} from './crypto';
import {
  abandonClaim,
  acquireClaim,
  assertGrantSchema,
  bindFlow,
  completeClaim,
  deleteBridge,
  deleteBridgeForSession,
  getBridge,
  getFlow,
  insertCreatingFlow,
  renewClaim,
  replaceBridge,
  terminalizeFlow,
  touchBridge,
} from './db';
import {
  cancelGrant,
  claimGrantResult,
  createReconnectFlow,
  getGrantStatus,
  GrantServiceError,
  verifyMarketplaceSession,
} from './service';

export const SESSION_COOKIE = '__Host-shop-bff-session';
export const FLOW_COOKIE = '__Host-shop-marketplace-grant';

export const sessionPairSchema = z.object({ pubky: z.string(), session_id: marketplaceSessionIdSchema }).strict();

export class BffError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

export function requiredConfig(): MarketplaceGrantConfig {
  const config = getMarketplaceGrantConfig();
  if (!config) throw new BffError(404, 'grant_unavailable');
  return config;
}

export function assertSameOrigin(request: Request, config: MarketplaceGrantConfig): void {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (!origin || !config.allowedOrigins.includes(origin)) throw new BffError(403, 'origin_denied');
  if (process.env.NODE_ENV === 'production' && fetchSite !== 'same-origin') {
    throw new BffError(403, 'origin_denied');
  }
}

export async function parseStrictJson<T>(request: Request, schema: z.ZodType<T>, limit = 16 * 1024): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new BffError(400, 'invalid_request');
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > limit) throw new BffError(413, 'invalid_request');
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new BffError(400, 'invalid_request');
  }
}

export async function pairSession(
  request: Request,
  authorization: string | null,
): Promise<{ cookie: string; maxAge: number }> {
  const config = requiredConfig();
  assertSameOrigin(request, config);
  await assertGrantSchema(config);
  const input = await parseStrictJson(request, sessionPairSchema);
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const verifiedExpiry = await verifyMarketplaceSession(config, bearer, input.pubky, input.session_id);
  const expiresAt = new Date(Math.min(verifiedExpiry.getTime(), Date.now() + 24 * 60 * 60 * 1000));
  const bridgeId = randomUUID();
  const bound = makeBoundCookie(bridgeId);
  const cookieHash = hashBoundCookie(config, config.stateKeyEpoch, 'session', bridgeId, bound.secret);
  const bearerSealed = sealBearer(config, bridgeId, input.session_id, input.pubky, bearer);
  await replaceBridge(config, {
    bridgeId,
    cookieHash,
    pubky: input.pubky,
    marketplaceSessionId: input.session_id,
    bearerSealed,
    keyEpoch: config.stateKeyEpoch,
    expiresAt,
  });
  return { cookie: bound.value, maxAge: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) };
}

async function authenticatedBridge(cookie: string | undefined): Promise<{
  config: MarketplaceGrantConfig;
  bridge: Awaited<ReturnType<typeof getBridge>> & {};
  bearer: string;
}> {
  const config = requiredConfig();
  const parsed = parseBoundCookie(cookie);
  if (!parsed) throw new BffError(401, 'shop_session_missing');
  const bridge = await getBridge(config, parsed.id);
  if (!bridge) throw new BffError(401, 'shop_session_missing');
  const expectedHash = hashBoundCookie(config, bridge.key_epoch, 'session', bridge.bridge_id, parsed.secret);
  if (!cookieMatches(bridge.cookie_hash, expectedHash)) throw new BffError(403, 'shop_session_denied');
  const bearer = openBearer(
    config,
    bridge.bridge_id,
    bridge.marketplace_session_id,
    bridge.pubky,
    bridge.key_epoch,
    bridge.bearer_sealed,
  );
  await verifyMarketplaceSession(config, bearer, bridge.pubky, bridge.marketplace_session_id);
  if (!(await touchBridge(config, bridge.bridge_id))) throw new BffError(401, 'shop_session_missing');
  return { config, bridge, bearer };
}

export async function createFlow(
  request: Request,
  sessionCookie: string | undefined,
): Promise<{
  cookie: string;
  maxAge: number;
  response: { authorization_url: string; expires_at: string; state_id: string; status: 'awaiting' };
}> {
  const routeConfig = requiredConfig();
  assertSameOrigin(request, routeConfig);
  await parseStrictJson(request, z.object({}).strict());
  const { config, bridge, bearer } = await authenticatedBridge(sessionCookie);
  const stateId = randomUUID();
  const bound = makeBoundCookie(stateId);
  const deliveryId = encodeBase64Url(randomBytes(32));
  const resultPopSeed = Uint8Array.from(randomBytes(32));
  const resultCpk = resultPublicKey(resultPopSeed);
  const contextSealed = sealFlowContext(config, stateId, bridge.bridge_id, {
    resultDeliveryId: deliveryId,
    resultPopSeed: encodeBase64Url(resultPopSeed),
    version: 1,
  });
  const resultBindingHash = hashBoundCookie(config, config.stateKeyEpoch, 'flow', stateId, bound.secret);
  const localExpiry = new Date(Date.now() + config.stateTtlSeconds * 1000);
  await insertCreatingFlow(config, {
    stateId,
    bridgeId: bridge.bridge_id,
    resultBindingHash,
    contextSealed,
    keyEpoch: config.stateKeyEpoch,
    expiresAt: localExpiry,
  });
  try {
    const created = await createReconnectFlow(config, bearer, deliveryId, resultCpk, bridge.pubky);
    const serviceExpiry = new Date(created.expires_at);
    if (!(await bindFlow(config, stateId, created.flow_id, serviceExpiry))) {
      await terminalizeFlow(config, stateId, 'abandoned');
      throw new BffError(409, 'fresh_approval_required');
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
    await terminalizeFlow(config, stateId, 'failed');
    if (error instanceof GrantServiceError && error.status === 401) {
      throw new BffError(401, 'shop_session_expired');
    }
    throw error;
  }
}

async function authenticatedFlow(sessionCookie: string | undefined, flowCookie: string | undefined, stateId: string) {
  const { config, bridge } = await authenticatedBridge(sessionCookie);
  const parsed = parseBoundCookie(flowCookie);
  if (!parsed || parsed.id !== stateId) throw new BffError(401, 'flow_binding_missing');
  const flow = await getFlow(config, stateId);
  if (!flow || flow.bridge_id !== bridge.bridge_id) throw new BffError(404, 'flow_not_found');
  const expectedHash = hashBoundCookie(config, flow.key_epoch, 'flow', stateId, parsed.secret);
  if (!cookieMatches(flow.result_binding_hash, expectedHash)) throw new BffError(403, 'flow_binding_denied');
  return { config, bridge, flow };
}

export async function pollFlow(
  request: Request,
  sessionCookie: string | undefined,
  flowCookie: string | undefined,
  stateId: string,
): Promise<Record<string, unknown>> {
  const routeConfig = requiredConfig();
  assertSameOrigin(request, routeConfig);
  await parseStrictJson(request, z.object({}).strict());
  const initial = await authenticatedFlow(sessionCookie, flowCookie, stateId);
  if (!initial.flow.flow_id) throw new BffError(503, 'grant_unavailable');
  const status = await getGrantStatus(initial.config, initial.flow.flow_id);
  if (status.status === 'awaiting' || status.status === 'verifying') {
    return { expires_at: status.expires_at, state_id: stateId, status: status.status };
  }
  if (status.status !== 'complete') {
    const localStatus = status.status === 'invalid' ? 'failed' : status.status;
    await terminalizeFlow(initial.config, stateId, localStatus);
    return { expires_at: status.expires_at, state_id: stateId, status: localStatus };
  }
  const owner = randomUUID();
  const claimedFlow = await acquireClaim(initial.config, stateId, owner);
  if (!claimedFlow?.context_sealed || !claimedFlow.flow_id) {
    throw new BffError(409, 'claim_in_progress');
  }
  try {
    const context = openFlowContext(
      initial.config,
      stateId,
      claimedFlow.bridge_id,
      claimedFlow.key_epoch,
      claimedFlow.context_sealed,
    );
    const claimed = await claimGrantResult(
      initial.config,
      claimedFlow.flow_id,
      context.resultDeliveryId,
      decodeBase64Url32(context.resultPopSeed),
      async () => {
        if (!(await renewClaim(initial.config, stateId, owner))) {
          throw new BffError(409, 'fresh_approval_required');
        }
      },
    );
    if (claimed.pubky !== initial.bridge.pubky) throw new BffError(409, 'identity_mismatch');
    if (!(await completeClaim(initial.config, stateId, owner))) {
      throw new BffError(409, 'fresh_approval_required');
    }
    return { ...claimed, status: 'connected' };
  } catch (error) {
    await abandonClaim(initial.config, stateId, owner);
    if (error instanceof BffError) throw error;
    throw new BffError(409, 'fresh_approval_required');
  }
}

export async function cancelFlow(
  request: Request,
  sessionCookie: string | undefined,
  flowCookie: string | undefined,
  stateId: string,
): Promise<void> {
  const routeConfig = requiredConfig();
  assertSameOrigin(request, routeConfig);
  await parseStrictJson(request, z.object({}).strict());
  const { config, flow } = await authenticatedFlow(sessionCookie, flowCookie, stateId);
  if (flow.flow_id && flow.context_sealed) {
    const context = openFlowContext(config, stateId, flow.bridge_id, flow.key_epoch, flow.context_sealed);
    await cancelGrant(config, flow.flow_id, context.resultDeliveryId);
  }
  await terminalizeFlow(config, stateId, 'cancelled');
}

/**
 * Unpairs the session cookie's bridge. A `session_id` query scopes it to that
 * marketplace session, so one tab's expired bearer cannot unpair a newer
 * session another tab paired on the shared cookie. Returns whether the
 * cookie should be dropped.
 */
export async function clearSession(request: Request, sessionCookie: string | undefined): Promise<boolean> {
  const config = requiredConfig();
  assertSameOrigin(request, config);
  const ownedSessionId = new URL(request.url).searchParams.get('session_id');
  if (ownedSessionId !== null && !marketplaceSessionIdSchema.safeParse(ownedSessionId).success) {
    throw new BffError(400, 'invalid_request');
  }
  const parsed = parseBoundCookie(sessionCookie);
  if (!parsed) return true;
  if (ownedSessionId === null) {
    await deleteBridge(config, parsed.id);
    return true;
  }
  return await deleteBridgeForSession(config, parsed.id, ownedSessionId);
}

export function mapBffError(error: unknown): { status: number; code: string; retryAfterSeconds?: number } {
  if (error instanceof BffError) {
    return { status: error.status, code: error.code, retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error instanceof GrantServiceError) {
    if (error.status === 401 || error.status === 403) {
      return { status: 401, code: 'shop_session_expired' };
    }
    if (error.status === 409 && error.code === 'identity_mismatch') return { status: 409, code: 'identity_mismatch' };
    if (error.status === 429) return { status: 429, code: 'retry_later', retryAfterSeconds: 60 };
    if (error.status === 410) return { status: 410, code: error.code };
    if (error.status === 422) return { status: 422, code: 'approval_invalid' };
  }
  return { status: 503, code: 'grant_unavailable' };
}
