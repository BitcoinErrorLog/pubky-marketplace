import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { marketplaceSessionIdSchema } from '@/core/services/marketplace/marketplace-session-id';
import type { MarketplaceGrantConfig } from './config';
import {
  canonicalJson,
  signBootstrapAssertion,
  signDeliveryAssertion,
  signResultProof,
  signServiceBody,
} from './crypto';

const PUBKY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const BEARER = /^[A-Za-z0-9_-]{43}$/;

const sessionsSchema = z.object({
  schema_version: z.literal(1),
  sessions: z.array(
    z.object({
      id: marketplaceSessionIdSchema,
      expires_at: z.iso.datetime({ offset: true }),
      revoked_at: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
});
const createSchema = z.object({
  authorization_url: z.string().startsWith('pubkyauth://signin_grant'),
  expires_at: z.iso.datetime({ offset: true }),
  flow_id: z.uuid(),
  status: z.literal('awaiting'),
});
const statusSchema = z.object({
  expires_at: z.iso.datetime({ offset: true }),
  flow_id: z.uuid(),
  status: z.enum(['awaiting', 'verifying', 'complete', 'mismatch', 'expired', 'cancelled', 'invalid', 'failed']),
  terminal_code: z.string().nullable().optional(),
});
const nonceSchema = z.object({
  expires_at: z.iso.datetime({ offset: true }),
  nonce: z.string(),
  nonce_id: z.uuid(),
});
const ticketSchema = z.object({
  expires_at: z.iso.datetime({ offset: true }),
  result_token: z.string(),
});
export const claimedSessionSchema = z.object({
  capabilities: z.string(),
  expires_at: z.iso.datetime({ offset: true }),
  pubky: z.string().regex(PUBKY),
  token: z.string().regex(BEARER),
});

export class GrantServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Marketplace grant service failed: ${code}`);
  }
}

async function request(config: MarketplaceGrantConfig, path: string, init: RequestInit): Promise<Response> {
  return await fetch(`${config.serviceUrl}${path}`, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(config.serviceTimeoutMs),
  });
}

async function jsonOrError(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const code =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'grant_unavailable';
    throw new GrantServiceError(response.status, code);
  }
  return body;
}

export async function verifyMarketplaceSession(
  config: MarketplaceGrantConfig,
  bearer: string,
  pubky: string,
  sessionId: string,
): Promise<Date> {
  if (!BEARER.test(bearer) || !PUBKY.test(pubky)) throw new GrantServiceError(400, 'invalid_session_pair');
  const headers = { authorization: `Bearer ${bearer}` };
  const seller = await request(config, `/v1/sellers/${pubky}/listings?limit=1`, { method: 'GET', headers });
  if (!seller.ok) throw new GrantServiceError(seller.status, 'invalid_session_pair');
  const listed = sessionsSchema.parse(
    await jsonOrError(await request(config, '/v1/auth/sessions', { method: 'GET', headers })),
  );
  const matched = listed.sessions.find((session) => session.id === sessionId && session.revoked_at === null);
  if (!matched) throw new GrantServiceError(401, 'invalid_session_pair');
  const expiresAt = new Date(matched.expires_at);
  if (expiresAt.getTime() <= Date.now()) throw new GrantServiceError(401, 'invalid_session_pair');
  return expiresAt;
}

export async function createReconnectFlow(
  config: MarketplaceGrantConfig,
  bearer: string,
  deliveryId: string,
  resultCpk: string,
  expectedPubky: string,
): Promise<z.infer<typeof createSchema>> {
  const assertion = signDeliveryAssertion(
    config,
    deliveryId,
    resultCpk,
    expectedPubky,
    Math.floor(Date.now() / 1000),
    randomUUID(),
  );
  const response = await request(config, '/v1/auth/grant-flows', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ delivery_assertion: assertion }),
  });
  return createSchema.parse(await jsonOrError(response));
}

export async function createBootstrapFlow(
  config: MarketplaceGrantConfig,
  deliveryId: string,
  resultCpk: string,
  expectedPubky: string,
): Promise<z.infer<typeof createSchema>> {
  const assertion = signBootstrapAssertion(
    config,
    deliveryId,
    resultCpk,
    expectedPubky,
    Math.floor(Date.now() / 1000),
    randomUUID(),
  );
  const response = await request(config, '/v1/auth/grant-flows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion }),
  });
  return createSchema.parse(await jsonOrError(response));
}

export async function getGrantStatus(
  config: MarketplaceGrantConfig,
  flowId: string,
): Promise<z.infer<typeof statusSchema>> {
  const response = await request(config, `/v1/auth/grant-flows/${flowId}`, { method: 'GET' });
  const body = (await response.json().catch(() => null)) as unknown;
  if (response.status === 410) {
    return {
      expires_at: new Date().toISOString(),
      flow_id: flowId,
      status: 'invalid',
      terminal_code: null,
    };
  }
  if (![200, 409, 422].includes(response.status)) {
    const code =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'grant_unavailable';
    throw new GrantServiceError(response.status, code);
  }
  return statusSchema.parse(body);
}

async function signedPost(
  config: MarketplaceGrantConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const signed = signServiceBody(config, body);
  const response = await request(config, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-marketplace-signature': signed.signature,
    },
    body: signed.bytes as BodyInit,
  });
  return await jsonOrError(response);
}

export async function issueNonce(
  config: MarketplaceGrantConfig,
  flowId: string,
  purpose: 'ticket' | 'claim',
): Promise<z.infer<typeof nonceSchema>> {
  const path = `/v1/auth/grant-flows/${flowId}/result-nonces`;
  return nonceSchema.parse(
    await signedPost(config, path, {
      method: 'POST',
      path,
      purpose,
      request_id: randomUUID(),
    }),
  );
}

function proof(
  seed: Uint8Array,
  flowId: string,
  path: string,
  purpose: 'ticket' | 'claim',
  resultDeliveryId: string,
  nonce: z.infer<typeof nonceSchema>,
): { issued_at: number; nonce: string; nonce_id: string; signature: string } {
  const issuedAt = Math.floor(Date.now() / 1000);
  const message = {
    domain: 'marketplace/grant-result-pop/v1',
    flow_id: flowId,
    issued_at: issuedAt,
    method: 'POST',
    nonce: nonce.nonce,
    nonce_id: nonce.nonce_id,
    path,
    purpose,
    result_delivery_id: resultDeliveryId,
  };
  return {
    issued_at: issuedAt,
    nonce: nonce.nonce,
    nonce_id: nonce.nonce_id,
    signature: signResultProof(seed, message),
  };
}

export async function claimGrantResult(
  config: MarketplaceGrantConfig,
  flowId: string,
  deliveryId: string,
  resultPopSeed: Uint8Array,
  onHeartbeat?: () => Promise<void>,
): Promise<z.infer<typeof claimedSessionSchema>> {
  const heartbeat = async () => {
    if (onHeartbeat) await onHeartbeat();
  };
  const ticketPath = `/v1/auth/grant-flows/${flowId}/result-ticket`;
  const ticketNonce = await issueNonce(config, flowId, 'ticket');
  await heartbeat();
  const ticket = ticketSchema.parse(
    await signedPost(config, ticketPath, {
      method: 'POST',
      path: ticketPath,
      proof: proof(resultPopSeed, flowId, ticketPath, 'ticket', deliveryId, ticketNonce),
      request_id: randomUUID(),
      result_delivery_id: deliveryId,
    }),
  );
  await heartbeat();
  const claimPath = `/v1/auth/grant-flows/${flowId}/claim`;
  const claimNonce = await issueNonce(config, flowId, 'claim');
  await heartbeat();
  const claimed = claimedSessionSchema.parse(
    await signedPost(config, claimPath, {
      method: 'POST',
      path: claimPath,
      proof: proof(resultPopSeed, flowId, claimPath, 'claim', deliveryId, claimNonce),
      request_id: randomUUID(),
      result_delivery_id: deliveryId,
      result_token: ticket.result_token,
    }),
  );
  await heartbeat();
  return claimed;
}

export type ResultProof = {
  issued_at: number;
  nonce: string;
  nonce_id: string;
  signature: string;
};

export async function ticketGrantResult(
  config: MarketplaceGrantConfig,
  flowId: string,
  deliveryId: string,
  proof: ResultProof,
): Promise<z.infer<typeof ticketSchema>> {
  const ticketPath = `/v1/auth/grant-flows/${flowId}/result-ticket`;
  return ticketSchema.parse(
    await signedPost(config, ticketPath, {
      method: 'POST',
      path: ticketPath,
      proof,
      request_id: randomUUID(),
      result_delivery_id: deliveryId,
    }),
  );
}

export async function claimGrantResultWithProof(
  config: MarketplaceGrantConfig,
  flowId: string,
  deliveryId: string,
  resultToken: string,
  proof: ResultProof,
): Promise<z.infer<typeof claimedSessionSchema>> {
  const claimPath = `/v1/auth/grant-flows/${flowId}/claim`;
  return claimedSessionSchema.parse(
    await signedPost(config, claimPath, {
      method: 'POST',
      path: claimPath,
      proof,
      request_id: randomUUID(),
      result_delivery_id: deliveryId,
      result_token: resultToken,
    }),
  );
}

export async function cancelGrant(config: MarketplaceGrantConfig, flowId: string, deliveryId: string): Promise<void> {
  const path = `/v1/auth/grant-flows/${flowId}/cancel`;
  const body = {
    method: 'POST',
    path,
    request_id: randomUUID(),
    result_delivery_id: deliveryId,
  };
  const signed = signServiceBody(config, body);
  const response = await request(config, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-marketplace-signature': signed.signature,
    },
    body: signed.bytes as BodyInit,
  });
  if (response.status !== 204) await jsonOrError(response);
}

export function canonicalBody(value: unknown): string {
  return canonicalJson(value);
}
