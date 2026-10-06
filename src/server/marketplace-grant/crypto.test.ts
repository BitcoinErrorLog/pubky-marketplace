/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { MarketplaceGrantConfig } from './config';
import {
  cookieMatches,
  decodeBase64Url32,
  encodeBase64Url,
  hashBoundCookie,
  hashCliDeliveryId,
  hashCliToken,
  makeBoundCookie,
  openBearer,
  openCliFlowContext,
  openFlowContext,
  resultPublicKey,
  sealBearer,
  sealCliFlowContext,
  sealFlowContext,
  signBootstrapAssertion,
  signDeliveryAssertion,
  signServiceBody,
} from './crypto';

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

describe('marketplace grant BFF cryptography', () => {
  it('binds session cookies to the exact id and secret', () => {
    const id = randomUUID();
    const bound = makeBoundCookie(id);
    const digest = hashBoundCookie(config, 1, 'session', id, bound.secret);
    expect(cookieMatches(digest, hashBoundCookie(config, 1, 'session', id, bound.secret))).toBe(true);
    expect(cookieMatches(digest, hashBoundCookie(config, 1, 'flow', id, bound.secret))).toBe(false);
  });

  it('revert-fail: sealBearer round-trips a migration-0035 session id and rejects a plain string', () => {
    const bridgeId = randomUUID();
    const sessionId = 'c91ac604-4109-a63d-ab8b-327fc9decd05';
    expect(z.uuid().safeParse(sessionId).success).toBe(false);
    const pubky = 'y'.repeat(52);
    const bearer = 'A'.repeat(43);
    const sealed = sealBearer(config, bridgeId, sessionId, pubky, bearer);
    expect(openBearer(config, bridgeId, sessionId, pubky, 1, sealed)).toBe(bearer);
    expect(() => sealBearer(config, bridgeId, 'shop-session-id-plain-string-1234567', pubky, bearer)).toThrow(
      /Expected canonical UUID/,
    );
  });

  it('round-trips and context-binds the sealed bearer', () => {
    const bridgeId = randomUUID();
    const sessionId = randomUUID();
    const pubky = 'y'.repeat(52);
    const bearer = 'A'.repeat(43);
    const sealed = sealBearer(config, bridgeId, sessionId, pubky, bearer);
    expect(openBearer(config, bridgeId, sessionId, pubky, 1, sealed)).toBe(bearer);
    expect(() => openBearer(config, bridgeId, randomUUID(), pubky, 1, sealed)).toThrow();
  });

  it('round-trips the atomic result context and rejects transplant', () => {
    const stateId = randomUUID();
    const bridgeId = randomUUID();
    const context = {
      resultDeliveryId: encodeBase64Url(new Uint8Array(32).fill(4)),
      resultPopSeed: encodeBase64Url(new Uint8Array(32).fill(5)),
      version: 1 as const,
    };
    const sealed = sealFlowContext(config, stateId, bridgeId, context);
    expect(openFlowContext(config, stateId, bridgeId, 1, sealed)).toEqual(context);
    expect(() => openFlowContext(config, stateId, randomUUID(), 1, sealed)).toThrow();
  });

  it('creates canonical service and delivery signatures without exposing seeds', () => {
    const deliveryId = encodeBase64Url(new Uint8Array(32).fill(6));
    const resultCpk = resultPublicKey(new Uint8Array(32).fill(7));
    expect(resultCpk).toMatch(/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/);
    const assertion = signDeliveryAssertion(config, deliveryId, resultCpk, 'y'.repeat(52), 1_760_000_000, randomUUID());
    expect(assertion.split('.')).toHaveLength(3);
    const signed = signServiceBody(config, { method: 'POST', path: '/v1/example', request_id: randomUUID() });
    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(new TextDecoder().decode(signed.bytes)).toContain('"method":"POST"');
    expect(decodeBase64Url32(deliveryId)).toHaveLength(32);
  });

  it('signs a bootstrap assertion with purpose marketplace-grant-flow', () => {
    const deliveryId = encodeBase64Url(new Uint8Array(32).fill(6));
    const resultCpk = resultPublicKey(new Uint8Array(32).fill(7));
    const assertion = signBootstrapAssertion(
      config,
      deliveryId,
      resultCpk,
      'y'.repeat(52),
      1_760_000_000,
      randomUUID(),
    );
    const payload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString()) as { purpose: string };
    expect(payload.purpose).toBe('marketplace-grant-flow');
  });

  it('binds CLI flow tokens and delivery-id hashes to distinct keys', () => {
    const challengeId = randomUUID();
    const stateId = randomUUID();
    const secret = makeBoundCookie(stateId).secret;
    const deliveryId = new Uint8Array(32).fill(8);
    const tokenDigest = hashCliToken(config, 1, secret);
    expect(cookieMatches(tokenDigest, hashCliToken(config, 1, secret))).toBe(true);
    expect(cookieMatches(tokenDigest, hashBoundCookie(config, 1, 'flow', stateId, secret))).toBe(false);
    expect(
      cookieMatches(
        hashCliDeliveryId(config, 1, challengeId, deliveryId),
        hashCliDeliveryId(config, 1, randomUUID(), deliveryId),
      ),
    ).toBe(false);
    const sealed = sealCliFlowContext(config, stateId, 'y'.repeat(52), {
      resultDeliveryId: encodeBase64Url(deliveryId),
      version: 1,
    });
    expect(openCliFlowContext(config, stateId, 'y'.repeat(52), 1, sealed).resultDeliveryId).toBe(
      encodeBase64Url(deliveryId),
    );
    expect(() => openCliFlowContext(config, stateId, 'b'.repeat(52), 1, sealed)).toThrow();
  });
});
