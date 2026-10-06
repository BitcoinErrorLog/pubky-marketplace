import { z } from 'zod';
import { isAppError } from '@/libs/error/error';
import { ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import { getMarketplaceGrantPollMilliseconds } from '@/libs/runtime-config/runtime-config';
import { sleep } from '@/libs/utils/utils';
import { HomeserverService } from '@/services/homeserver/homeserver';
import type { MarketplaceGrantFlow } from './marketplace-grant-client';
import { isMarketplaceSessionGrantUrl } from './marketplace-session-grant';

/**
 * Browser purchase bootstrap for a Bitkit (grant) sign-in. The grant session
 * proves write access to its own homeserver with a single-use proof document,
 * the Shop BFF runs the CLI verifier's checks and opens a marketplace
 * `signin_grant`, and after the Bitkit approval the BFF claims the bearer.
 */
const challengeSchema = z.object({
  challenge_id: z.uuid(),
  expires_at: z.iso.datetime({ offset: true }),
  nonce: z.string().min(1),
  proof_document: z.record(z.string(), z.unknown()),
  proof_uri: z.string().startsWith('pubky://'),
  result_cpk: z.string(),
  result_delivery_id: z.string(),
});
const verifySchema = z.object({
  authorization_url: z.string().startsWith('pubkyauth://signin_grant'),
  expires_at: z.iso.datetime({ offset: true }),
  state_id: z.uuid(),
  status: z.literal('awaiting'),
});
const pollSchema = z.object({
  status: z.enum(['awaiting', 'verifying', 'connected', 'mismatch', 'expired', 'cancelled', 'failed']),
  state_id: z.uuid().optional(),
  token: z.string().optional(),
  pubky: z.string().optional(),
  capabilities: z.string().optional(),
  expires_at: z.string().optional(),
});

function bootstrapFailure(code: string) {
  return Err.server(ServerErrorCode.SERVICE_UNAVAILABLE, code, {
    service: ErrorService.Marketplace,
    operation: 'marketplaceBootstrap',
  });
}

async function readJson(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const code =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'grant_unavailable';
    throw bootstrapFailure(/^[a-z_]{1,64}$/.test(code) ? code : 'grant_unavailable');
  }
  return body;
}

async function post(path: string, body: unknown): Promise<unknown> {
  return await readJson(
    await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function beginMarketplaceBootstrapFlow({ pubky }: { pubky: string }): Promise<MarketplaceGrantFlow> {
  const challenge = challengeSchema.parse(await post('/api/marketplace/bootstrap-challenges', { pubky }));
  if (!challenge.proof_uri.startsWith(`pubky://${pubky}/`)) throw bootstrapFailure('invalid_request');

  let verified: z.infer<typeof verifySchema>;
  try {
    try {
      await HomeserverService.request({
        method: HttpMethod.PUT,
        url: challenge.proof_uri,
        bodyJson: challenge.proof_document,
      });
    } catch (error) {
      // The grant session could not write its own homeserver: it expired or was revoked.
      if (isAppError(error) && error.category === ErrorCategory.Auth) throw bootstrapFailure('shop_session_expired');
      throw error;
    }
    verified = verifySchema.parse(
      await post(`/api/marketplace/bootstrap-challenges/${challenge.challenge_id}/verify`, { nonce: challenge.nonce }),
    );
  } finally {
    // Single-use either way: the verify consumed the challenge or refused it.
    await HomeserverService.delete(challenge.proof_uri).catch(() => {
      Logger.warn('Could not delete the purchase bootstrap proof document');
    });
  }

  const cancelFlow = async () => {
    await post(`/api/marketplace/bootstrap-flows/${verified.state_id}/cancel`, {}).catch(() => undefined);
  };
  // Never show Bitkit a QR that asks for more than the marketplace session grant.
  if (!isMarketplaceSessionGrantUrl(verified.authorization_url)) {
    await cancelFlow();
    throw bootstrapFailure('result_denied');
  }

  let cancelled = false;
  return {
    authorizationUrl: verified.authorization_url,
    awaitResult: async () => {
      while (!cancelled && Date.now() < Date.parse(verified.expires_at)) {
        let result: z.infer<typeof pollSchema>;
        try {
          result = pollSchema.parse(await post(`/api/marketplace/bootstrap-flows/${verified.state_id}/status`, {}));
        } catch (error) {
          // Another poll holds the claim lease; it finishes the approval.
          if (!(error instanceof Error && error.message === 'claim_in_progress')) throw error;
          await sleep(getMarketplaceGrantPollMilliseconds());
          continue;
        }
        if (!['awaiting', 'verifying'].includes(result.status)) return result;
        await sleep(getMarketplaceGrantPollMilliseconds());
      }
      throw bootstrapFailure(cancelled ? 'flow_cancelled' : 'flow_expired');
    },
    cancel: async () => {
      if (cancelled) return;
      cancelled = true;
      await cancelFlow();
    },
  };
}
