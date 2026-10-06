import { z } from 'zod';
import { ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { getMarketplaceGrantPollMilliseconds } from '@/libs/runtime-config/runtime-config';
import { sleep } from '@/libs/utils/utils';
import { isMarketplaceSessionGrantUrl } from './marketplace-session-grant';

const createSchema = z.object({
  authorization_url: z.string().startsWith('pubkyauth://signin_grant'),
  expires_at: z.iso.datetime({ offset: true }),
  state_id: z.uuid(),
  status: z.literal('awaiting'),
});
const statusSchema = z.object({
  status: z.enum(['awaiting', 'verifying', 'connected', 'mismatch', 'expired', 'cancelled', 'failed', 'abandoned']),
  state_id: z.uuid().optional(),
  token: z.string().optional(),
  pubky: z.string().optional(),
  capabilities: z.string().optional(),
  expires_at: z.string().optional(),
});

export type MarketplaceGrantFlow = {
  authorizationUrl: string;
  awaitResult: () => Promise<z.infer<typeof statusSchema>>;
  cancel: () => Promise<void>;
};

async function json(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const code =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'grant_unavailable';
    throw new Error(code);
  }
  return body;
}

export async function pairMarketplaceBffSession(session: {
  token: string;
  pubky: string;
  sessionId: string;
}): Promise<void> {
  const response = await fetch('/api/marketplace/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ pubky: session.pubky, session_id: session.sessionId }),
  });
  if (!response.ok) throw new Error('marketplace_session_pair_failed');
}

/**
 * Unpairs the BFF session. With `ownedSessionId` the BFF unpairs only when
 * its bridge still holds that marketplace session: the cookie is shared
 * across tabs, and another tab may have paired a newer one. Without it (sign-
 * out) the bridge is removed whatever it holds.
 */
export async function clearMarketplaceBffSession(ownedSessionId?: string): Promise<void> {
  const query = ownedSessionId === undefined ? '' : `?session_id=${encodeURIComponent(ownedSessionId)}`;
  await fetch(`/api/marketplace/session${query}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  }).catch(() => undefined);
}

export async function beginMarketplaceGrantFlow(): Promise<MarketplaceGrantFlow> {
  const created = createSchema.parse(
    await json(
      await fetch('/api/marketplace/grant-flows', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ),
  );
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    await fetch(`/api/marketplace/grant-flows/${created.state_id}/cancel`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => undefined);
  };
  // Never show a signer a QR that asks for more than the marketplace session grant.
  if (!isMarketplaceSessionGrantUrl(created.authorization_url)) {
    await cancel();
    throw Err.server(ServerErrorCode.SERVICE_UNAVAILABLE, 'result_denied', {
      service: ErrorService.Marketplace,
      operation: 'marketplaceGrantReconnect',
    });
  }
  return {
    authorizationUrl: created.authorization_url,
    awaitResult: async () => {
      while (!cancelled && Date.now() < Date.parse(created.expires_at)) {
        const result = statusSchema.parse(
          await json(
            await fetch(`/api/marketplace/grant-flows/${created.state_id}/status`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            }),
          ),
        );
        if (!['awaiting', 'verifying'].includes(result.status)) return result;
        await sleep(getMarketplaceGrantPollMilliseconds());
      }
      throw new Error(cancelled ? 'flow_cancelled' : 'flow_expired');
    },
    cancel,
  };
}
