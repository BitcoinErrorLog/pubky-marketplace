/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BffError } from './bff';
import { type CliGrantConfig, resetMarketplaceGrantConfigForTests } from './config';
import {
  BrowserContextRefused,
  browserSeedKeyForTests,
  deriveBrowserBootstrap,
  encodeBase64Url,
  hashBoundCookie,
  hashCliDeliveryId,
  hashCliToken,
  makeBoundCookie,
  openBrowserFlowContext,
  sealBrowserFlowContext,
  sealCliFlowContext,
  sha256Bytes,
} from './crypto';

const insertCliChallenge = vi.fn();
const consumeCliRateLimit = vi.fn();
const getCliChallenge = vi.fn();
const consumeChallengeAndInsertCliFlow = vi.fn();
const bindCliFlow = vi.fn();
const terminalizeCliFlow = vi.fn();
const getCliFlow = vi.fn();
const acquireCliClaim = vi.fn();
const completeCliClaim = vi.fn();
const abandonCliClaim = vi.fn();
const abandonLapsedCliClaim = vi.fn();
const renewCliClaim = vi.fn();
const assertCliGrantSchema = vi.fn();
const fetchHomeserverProofDocument = vi.fn();
const createBootstrapFlow = vi.fn();
const getGrantStatus = vi.fn();
const claimGrantResult = vi.fn();
const ticketGrantResult = vi.fn();
const cancelGrant = vi.fn();

vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>();
  return {
    ...actual,
    assertCliGrantSchema: (...args: unknown[]) => assertCliGrantSchema(...args),
    insertCliChallenge: (...args: unknown[]) => insertCliChallenge(...args),
    consumeCliRateLimit: (...args: unknown[]) => consumeCliRateLimit(...args),
    getCliChallenge: (...args: unknown[]) => getCliChallenge(...args),
    consumeChallengeAndInsertCliFlow: (...args: unknown[]) => consumeChallengeAndInsertCliFlow(...args),
    bindCliFlow: (...args: unknown[]) => bindCliFlow(...args),
    terminalizeCliFlow: (...args: unknown[]) => terminalizeCliFlow(...args),
    getCliFlow: (...args: unknown[]) => getCliFlow(...args),
    acquireCliClaim: (...args: unknown[]) => acquireCliClaim(...args),
    completeCliClaim: (...args: unknown[]) => completeCliClaim(...args),
    abandonCliClaim: (...args: unknown[]) => abandonCliClaim(...args),
    abandonLapsedCliClaim: (...args: unknown[]) => abandonLapsedCliClaim(...args),
    renewCliClaim: (...args: unknown[]) => renewCliClaim(...args),
  };
});

vi.mock('./homeserver-proof', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./homeserver-proof')>();
  return {
    ...actual,
    fetchHomeserverProofDocument: (...args: unknown[]) => fetchHomeserverProofDocument(...args),
  };
});

vi.mock('./service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./service')>();
  return {
    ...actual,
    createBootstrapFlow: (...args: unknown[]) => createBootstrapFlow(...args),
    getGrantStatus: (...args: unknown[]) => getGrantStatus(...args),
    claimGrantResult: (...args: unknown[]) => claimGrantResult(...args),
    ticketGrantResult: (...args: unknown[]) => ticketGrantResult(...args),
    cancelGrant: (...args: unknown[]) => cancelGrant(...args),
  };
});

const ENV = { ...process.env };
const ORIGIN = 'https://shop.example';
const pubky = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const otherPubky = 'o1gg8yc7mj4ksrzr6ms3s5rs8h7bo8y7ohcq7j88wbkm7ns7tuxo';
const challengeId = '018f4f36-7a61-7d4e-8f22-3e31ed45d2af';
const STATE_KEY_1 = Buffer.alloc(32, 3).toString('base64');
const STATE_KEY_2 = Buffer.alloc(32, 5).toString('base64');
const STATE_KEY_3 = Buffer.alloc(32, 7).toString('base64');
const ASSERTION_SEED_HEX = '11'.repeat(32);
const REQUEST_SEED_HEX = '22'.repeat(32);

function grantEnv(overrides: Record<string, string | undefined> = {}): void {
  process.env = {
    ...ENV,
    SHOP_BFF_GRANT_FLOW_ENABLED: 'true',
    SHOP_ALLOWED_ORIGINS: `["${ORIGIN}"]`,
    SHOP_PUBLIC_ORIGIN: ORIGIN,
    MARKETPLACE_SERVICE_URL: 'https://service.example',
    SHOP_BFF_GRANT_STATE_DATABASE_URL: 'postgres://example',
    CRON_SECRET: 'c'.repeat(32),
    SHOP_GRANT_ASSERTION_ISSUER: ORIGIN,
    SHOP_GRANT_ASSERTION_KEY_ID: 'shop-bff-test-0001',
    SHOP_GRANT_ASSERTION_KEY_EPOCH: '1',
    SHOP_GRANT_ASSERTION_SIGNING_KEY: ASSERTION_SEED_HEX,
    MARKETPLACE_SERVICE_REQUEST_KEY_ID: 'shop-bff-request-test-0001',
    MARKETPLACE_SERVICE_REQUEST_KEY_EPOCH: '1',
    MARKETPLACE_SERVICE_REQUEST_SIGNING_KEY: REQUEST_SEED_HEX,
    SHOP_BFF_GRANT_STATE_ENCRYPTION_KEY_B64: STATE_KEY_1,
    SHOP_BFF_GRANT_STATE_KEY_EPOCH: '1',
  };
  delete process.env.VERCEL;
  delete process.env.SHOP_BFF_CLI_GRANT_ENABLED;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetMarketplaceGrantConfigForTests();
}

function rotateTo(epoch: number, key: string, previous?: { epoch: number; key: string }): void {
  process.env.SHOP_BFF_GRANT_STATE_ENCRYPTION_KEY_B64 = key;
  process.env.SHOP_BFF_GRANT_STATE_KEY_EPOCH = String(epoch);
  if (previous) {
    process.env.SHOP_BFF_GRANT_STATE_PREVIOUS_ENCRYPTION_KEY_B64 = previous.key;
    process.env.SHOP_BFF_GRANT_STATE_PREVIOUS_KEY_EPOCH = String(previous.epoch);
  } else {
    delete process.env.SHOP_BFF_GRANT_STATE_PREVIOUS_ENCRYPTION_KEY_B64;
    delete process.env.SHOP_BFF_GRANT_STATE_PREVIOUS_KEY_EPOCH;
  }
  resetMarketplaceGrantConfigForTests();
}

async function browserConfig(): Promise<CliGrantConfig> {
  const { getBrowserBootstrapConfig } = await import('./config');
  const config = getBrowserBootstrapConfig();
  if (!config) throw new Error('browser bootstrap config missing');
  return config;
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

const challengeRequest = (body: unknown = { pubky }, headers: Record<string, string> = {}) =>
  jsonRequest(`${ORIGIN}/api/marketplace/bootstrap-challenges`, body, headers);
const verifyRequest = (nonce: string) =>
  jsonRequest(`${ORIGIN}/api/marketplace/bootstrap-challenges/${challengeId}/verify`, { nonce });
const flowRequest = (stateId: string, headers: Record<string, string> = {}) =>
  jsonRequest(`${ORIGIN}/api/marketplace/bootstrap-flows/${stateId}/status`, {}, headers);

type StoredChallenge = {
  challenge_id: string;
  pubky: string;
  result_cpk: string;
  result_delivery_id_hash: Uint8Array;
  nonce_hash: Uint8Array;
  consumed_at: Date | null;
  created_at: Date;
  expires_at: Date;
};

/** Mirrors `insertCliChallenge` into `getCliChallenge`, the way the table would. */
function storeInsertedChallenges(): Map<string, StoredChallenge> {
  const rows = new Map<string, StoredChallenge>();
  insertCliChallenge.mockImplementation(async (_config: unknown, row: Record<string, unknown>) => {
    const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    rows.set(String(row.challengeId), {
      challenge_id: String(row.challengeId),
      pubky: String(row.pubky),
      result_cpk: String(row.resultCpk),
      result_delivery_id_hash: row.resultDeliveryIdHash as Uint8Array,
      nonce_hash: row.nonceHash as Uint8Array,
      consumed_at: null,
      created_at: createdAt,
      expires_at: row.expiresAt as Date,
    });
  });
  getCliChallenge.mockImplementation(async (_config: unknown, id: string) => rows.get(id) ?? null);
  return rows;
}

/** A challenge row as the browser route stores it for `challengeId`. */
function browserChallengeRow(config: CliGrantConfig, epoch = config.stateKeyEpoch, nonce = new Uint8Array(32).fill(9)) {
  const derived = deriveBrowserBootstrap(config, epoch, challengeId);
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  return {
    derived,
    nonce,
    row: {
      challenge_id: challengeId,
      pubky,
      result_cpk: derived.resultCpk,
      result_delivery_id_hash: hashCliDeliveryId(config, epoch, challengeId, derived.resultDeliveryId),
      nonce_hash: sha256Bytes(nonce),
      consumed_at: null,
      created_at: createdAt,
      expires_at: new Date(createdAt.getTime() + 60_000),
    } satisfies StoredChallenge,
  };
}

function browserFlowRow(
  config: CliGrantConfig,
  opts: { tokenHash?: Uint8Array; contextSealed?: Uint8Array; status?: string; epoch?: number } = {},
) {
  const stateId = randomUUID();
  const bound = makeBoundCookie(stateId);
  const epoch = opts.epoch ?? config.stateKeyEpoch;
  const derived = deriveBrowserBootstrap(config, epoch, challengeId);
  const row = {
    state_id: stateId,
    challenge_id: challengeId,
    flow_id: randomUUID(),
    pubky,
    result_cpk: derived.resultCpk,
    token_hash: opts.tokenHash ?? hashBoundCookie(config, epoch, 'flow', stateId, bound.secret),
    context_sealed:
      opts.contextSealed ??
      sealBrowserFlowContext(config, stateId, pubky, {
        kind: 'browser',
        resultDeliveryId: encodeBase64Url(derived.resultDeliveryId),
        resultPopSeed: encodeBase64Url(derived.resultPopSeed),
        version: 2,
      }),
    result_token_sealed: null,
    key_epoch: epoch,
    status: opts.status ?? 'awaiting',
    lease_owner: null,
    lease_until: null,
    version: '1',
    created_at: new Date(),
    expires_at: new Date(Date.now() + 60_000),
    terminal_at: null,
  };
  return { bound, derived, row, stateId };
}

function completeServiceFlow(flowId: string) {
  getGrantStatus.mockResolvedValue({
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    flow_id: flowId,
    status: 'complete',
    terminal_code: null,
  });
}

const claimedSession = (claimedPubky = pubky) => ({
  capabilities: '/pub/pubky.app/marketplace-service/v1/:rw',
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  pubky: claimedPubky,
  token: 'marketplace-bearer',
});

function secretForms(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  return [buffer.toString('hex'), buffer.toString('base64'), buffer.toString('base64url')];
}

describe('browser purchase bootstrap BFF', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    consumeCliRateLimit.mockResolvedValue(true);
    assertCliGrantSchema.mockResolvedValue(undefined);
    insertCliChallenge.mockResolvedValue(undefined);
    bindCliFlow.mockResolvedValue(true);
    consumeChallengeAndInsertCliFlow.mockResolvedValue(undefined);
    completeCliClaim.mockResolvedValue(true);
    renewCliClaim.mockResolvedValue(true);
    abandonCliClaim.mockResolvedValue(undefined);
    terminalizeCliFlow.mockResolvedValue(undefined);
    createBootstrapFlow.mockResolvedValue({
      authorization_url: 'pubkyauth://signin_grant?caps=x',
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      flow_id: randomUUID(),
      status: 'awaiting',
    });
    grantEnv();
  });

  afterEach(() => {
    process.env = { ...ENV };
    resetMarketplaceGrantConfigForTests();
    vi.restoreAllMocks();
  });

  // A1
  it('browser challenge stores derived result_cpk and delivery hash', async () => {
    const rows = storeInsertedChallenges();
    const { createBrowserChallenge } = await import('./browser-bff');
    const config = await browserConfig();

    const created = await createBrowserChallenge(challengeRequest());
    const derived = deriveBrowserBootstrap(config, 1, created.challenge_id);
    const stored = rows.get(created.challenge_id)!;

    expect(stored.result_cpk).toBe(derived.resultCpk);
    expect(Buffer.from(stored.result_delivery_id_hash)).toEqual(
      Buffer.from(hashCliDeliveryId(config, 1, created.challenge_id, derived.resultDeliveryId)),
    );
    expect(created.result_cpk).toBe(derived.resultCpk);
    expect(created.result_delivery_id).toBe(encodeBase64Url(derived.resultDeliveryId));
    expect(created.proof_uri).toBe(
      `pubky://${pubky}/pub/pubky.app/marketplace/v1/cli-grant-proofs/${created.challenge_id}`,
    );
    expect(created.proof_document).toMatchObject({
      aud: ORIGIN,
      challenge_id: created.challenge_id,
      pubky,
      result_cpk: derived.resultCpk,
      result_delivery_id: created.result_delivery_id,
    });
  });

  // A2
  it('result seed never leaves bff', async () => {
    const rows = storeInsertedChallenges();
    const logged: unknown[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const { createBrowserChallenge, verifyBrowserChallenge, pollBrowserFlow } = await import('./browser-bff');
    const { grantError } = await import('./http');
    const config = await browserConfig();

    const created = await createBrowserChallenge(challengeRequest());
    expect(Object.keys(created).sort()).toEqual([
      'challenge_id',
      'expires_at',
      'nonce',
      'proof_document',
      'proof_uri',
      'result_cpk',
      'result_delivery_id',
    ]);
    const seed = deriveBrowserBootstrap(config, 1, created.challenge_id).resultPopSeed;
    fetchHomeserverProofDocument.mockResolvedValue(created.proof_document);
    const verifyUrl = `${ORIGIN}/api/marketplace/bootstrap-challenges/${created.challenge_id}/verify`;
    const verified = await verifyBrowserChallenge(
      jsonRequest(verifyUrl, { nonce: created.nonce }),
      created.challenge_id,
    );
    expect(Object.keys(verified.response).sort()).toEqual(['authorization_url', 'expires_at', 'state_id', 'status']);

    const flowInsert = consumeChallengeAndInsertCliFlow.mock.calls[0][2] as Record<string, unknown>;
    const stateId = String(flowInsert.stateId);
    const flow = {
      state_id: stateId,
      challenge_id: created.challenge_id,
      flow_id: randomUUID(),
      pubky,
      result_cpk: created.result_cpk,
      token_hash: flowInsert.tokenHash,
      context_sealed: flowInsert.contextSealed,
      result_token_sealed: null,
      key_epoch: 1,
      status: 'awaiting',
      lease_owner: null,
      lease_until: null,
      version: '1',
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      terminal_at: null,
    };
    getCliFlow.mockResolvedValue(flow);
    acquireCliClaim.mockResolvedValue(flow);
    completeServiceFlow(flow.flow_id);
    claimGrantResult.mockResolvedValue(claimedSession());
    const polled = await pollBrowserFlow(flowRequest(stateId), verified.cookie, stateId);
    expect(polled.status).toBe('connected');
    expect(Buffer.from(claimGrantResult.mock.calls[0][3] as Uint8Array)).toEqual(Buffer.from(seed));

    // A refusal body goes through the same logger path.
    const refusal = grantError(new BffError(409, 'fresh_approval_required'));
    const refusalBody = await refusal.json();

    const outbound = JSON.stringify({
      created,
      proofDocument: created.proof_document,
      verified,
      polled,
      refusalBody,
      logged,
      serviceBootstrapArgs: createBootstrapFlow.mock.calls,
    });
    for (const form of secretForms(seed)) expect(outbound).not.toContain(form);
    expect(rows.size).toBe(1);
  });

  // A3
  it('verify refuses a challenge after a state key rotation', async () => {
    storeInsertedChallenges();
    const { createBrowserChallenge, verifyBrowserChallenge } = await import('./browser-bff');
    const created = await createBrowserChallenge(challengeRequest());

    rotateTo(2, STATE_KEY_2, { epoch: 1, key: STATE_KEY_1 });
    const verifyUrl = `${ORIGIN}/api/marketplace/bootstrap-challenges/${created.challenge_id}/verify`;
    await expect(
      verifyBrowserChallenge(jsonRequest(verifyUrl, { nonce: created.nonce }), created.challenge_id),
    ).rejects.toEqual(new BffError(409, 'fresh_approval_required'));
    expect(fetchHomeserverProofDocument).not.toHaveBeenCalled();
    expect(consumeChallengeAndInsertCliFlow).not.toHaveBeenCalled();
    expect(createBootstrapFlow).not.toHaveBeenCalled();
  });

  // A4
  it('claim opens a context sealed under the previous epoch', async () => {
    const epoch1 = await browserConfig();
    const { bound, derived, row, stateId } = browserFlowRow(epoch1);
    rotateTo(2, STATE_KEY_2, { epoch: 1, key: STATE_KEY_1 });
    getCliFlow.mockResolvedValue(row);
    acquireCliClaim.mockResolvedValue(row);
    completeServiceFlow(row.flow_id);
    claimGrantResult.mockResolvedValue(claimedSession());
    const { pollBrowserFlow } = await import('./browser-bff');

    await expect(pollBrowserFlow(flowRequest(stateId), bound.value, stateId)).resolves.toMatchObject({
      status: 'connected',
      pubky,
    });
    expect(claimGrantResult).toHaveBeenCalledWith(
      expect.anything(),
      row.flow_id,
      encodeBase64Url(derived.resultDeliveryId),
      derived.resultPopSeed,
      expect.any(Function),
    );
  });

  it('claim fails closed when the sealing epoch is gone', async () => {
    const epoch1 = await browserConfig();
    const { bound, row, stateId } = browserFlowRow(epoch1);
    rotateTo(3, STATE_KEY_3, { epoch: 2, key: STATE_KEY_2 });
    getCliFlow.mockResolvedValue(row);
    acquireCliClaim.mockResolvedValue(row);
    completeServiceFlow(row.flow_id);
    const { pollBrowserFlow } = await import('./browser-bff');

    await expect(pollBrowserFlow(flowRequest(stateId), bound.value, stateId)).rejects.toEqual(
      new BffError(422, 'fresh_approval_required'),
    );
    expect(claimGrantResult).not.toHaveBeenCalled();
    const current = await browserConfig();
    expect(() => openBrowserFlowContext(current, stateId, pubky, 1, row.context_sealed)).toThrow(
      new BrowserContextRefused('epoch_unavailable'),
    );
  });

  // A5
  it('browser seed key differs from every existing BFF key for the same epoch', async () => {
    const config = await browserConfig();
    const root = Uint8Array.from(Buffer.from(STATE_KEY_1, 'base64'));
    const utf8 = new TextEncoder();
    const epochBytes = Uint8Array.of(0, 1);
    const info = (label: string) => Uint8Array.from([...utf8.encode(label), ...epochBytes]);
    const stateSalt = utf8.encode('marketplace/shop-bff-state/hkdf-salt/v1');
    const existing = {
      sessionCookie: hkdf(sha256, root, stateSalt, info('marketplace/shop-bff-state/session-cookie-key/v1'), 32),
      flowCookie: hkdf(sha256, root, stateSalt, info('marketplace/shop-bff-state/flow-cookie-key/v1'), 32),
      seal: hkdf(sha256, root, stateSalt, info('marketplace/shop-bff-state/seal-key/v1'), 32),
      cliToken: hkdf(
        sha256,
        root,
        utf8.encode('shop-bff/cli-flow-token/hkdf-salt/v1'),
        info('shop-bff/cli-flow-token/token-key/v1'),
        32,
      ),
      cliDelivery: hkdf(
        sha256,
        root,
        utf8.encode('shop-bff/cli-challenge/hkdf-salt/v1'),
        info('shop-bff/cli-challenge/delivery-key/v1'),
        32,
      ),
    };
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    const seedKey = hex(browserSeedKeyForTests(config, 1));
    for (const key of Object.values(existing)) expect(hex(key)).not.toBe(seedKey);

    const derived = deriveBrowserBootstrap(config, 1, challengeId);
    const raw = [hex(root), ASSERTION_SEED_HEX, REQUEST_SEED_HEX, ...Object.values(existing).map(hex)];
    for (const output of [hex(derived.resultPopSeed), hex(derived.resultDeliveryId)]) {
      expect(raw).not.toContain(output);
    }
    expect(hex(derived.resultPopSeed)).not.toBe(hex(derived.resultDeliveryId));
    expect(deriveBrowserBootstrap(config, 1, randomUUID()).resultCpk).not.toBe(derived.resultCpk);

    // Known-answer vector, computed with an independent HKDF/HMAC implementation
    // for state key 0x03×32, epoch 1 and the fixed challenge id.
    expect(seedKey).toBe('a72aa8ce19621199841f1658d6cff9c5eb4645845143c9bffb745793f6003817');
    expect(hex(derived.resultPopSeed)).toBe('837f6142178ab22ae96c2bf7e30a9d124e9eeab49f2d94df0994dbfe35be1c4c');
    expect(hex(derived.resultDeliveryId)).toBe('9f0f3139a127cc702c3275a7a644892eac828b9cf4aa112e0cf5fbf2dace6e71');
  });

  // A6
  it('cli routes refuse a browser bootstrap flow', async () => {
    grantEnv({ SHOP_BFF_CLI_GRANT_ENABLED: 'true' });
    const config = await browserConfig();
    const { bound, row, stateId } = browserFlowRow(config);
    getCliFlow.mockResolvedValue(row);
    const { cliFlowStatus } = await import('./cli-bff');

    await expect(
      cliFlowStatus(flowRequest(stateId, { authorization: `PubkyShopCli ${bound.value}` }), stateId),
    ).rejects.toEqual(new BffError(401, 'cli_token_denied'));
    expect(getGrantStatus).not.toHaveBeenCalled();
    expect(ticketGrantResult).not.toHaveBeenCalled();
  });

  it('browser routes refuse a cli flow', async () => {
    grantEnv({ SHOP_BFF_CLI_GRANT_ENABLED: 'true' });
    const config = await browserConfig();
    const stateId = randomUUID();
    const bound = makeBoundCookie(stateId);
    const { row } = browserFlowRow(config, { tokenHash: hashCliToken(config, 1, bound.secret) });
    getCliFlow.mockResolvedValue({ ...row, state_id: stateId });
    const { pollBrowserFlow } = await import('./browser-bff');

    await expect(pollBrowserFlow(flowRequest(stateId), bound.value, stateId)).rejects.toEqual(
      new BffError(403, 'flow_binding_denied'),
    );
    expect(getGrantStatus).not.toHaveBeenCalled();
    expect(claimGrantResult).not.toHaveBeenCalled();
  });

  it('cli verify refuses a browser bootstrap challenge before consume', async () => {
    grantEnv({ SHOP_BFF_CLI_GRANT_ENABLED: 'true' });
    const config = await browserConfig();
    const { nonce, row } = browserChallengeRow(config);
    getCliChallenge.mockResolvedValue(row);
    const { verifyCliChallenge } = await import('./cli-bff');

    await expect(
      verifyCliChallenge(
        jsonRequest(`${ORIGIN}/api/cli/grant-challenges/${challengeId}/verify`, { nonce: encodeBase64Url(nonce) }),
        challengeId,
      ),
    ).rejects.toEqual(new BffError(404, 'challenge_not_found'));
    expect(fetchHomeserverProofDocument).not.toHaveBeenCalled();
    expect(consumeChallengeAndInsertCliFlow).not.toHaveBeenCalled();
  });

  it('browser verify refuses a cli challenge before consume', async () => {
    const config = await browserConfig();
    const nonce = new Uint8Array(32).fill(9);
    const cliDeliveryId = new Uint8Array(32).fill(4);
    getCliChallenge.mockResolvedValue({
      challenge_id: challengeId,
      pubky,
      result_cpk: pubky,
      result_delivery_id_hash: hashCliDeliveryId(config, 1, challengeId, cliDeliveryId),
      nonce_hash: sha256Bytes(nonce),
      consumed_at: null,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
    });
    const { verifyBrowserChallenge } = await import('./browser-bff');

    await expect(verifyBrowserChallenge(verifyRequest(encodeBase64Url(nonce)), challengeId)).rejects.toEqual(
      new BffError(409, 'fresh_approval_required'),
    );
    expect(fetchHomeserverProofDocument).not.toHaveBeenCalled();
    expect(consumeChallengeAndInsertCliFlow).not.toHaveBeenCalled();
  });

  // A7
  it('browser claim refuses a cli context', async () => {
    const config = await browserConfig();
    const stateId = randomUUID();
    const bound = makeBoundCookie(stateId);
    const cliContext = sealCliFlowContext(config, stateId, pubky, {
      resultDeliveryId: encodeBase64Url(new Uint8Array(32).fill(4)),
      version: 1,
    });
    const { row } = browserFlowRow(config, {
      tokenHash: hashBoundCookie(config, 1, 'flow', stateId, bound.secret),
      contextSealed: cliContext,
    });
    const flow = { ...row, state_id: stateId };
    getCliFlow.mockResolvedValue(flow);
    acquireCliClaim.mockResolvedValue(flow);
    completeServiceFlow(flow.flow_id);
    const { pollBrowserFlow } = await import('./browser-bff');

    await expect(pollBrowserFlow(flowRequest(stateId), bound.value, stateId)).rejects.toEqual(
      new BffError(403, 'result_denied'),
    );
    expect(claimGrantResult).not.toHaveBeenCalled();
    expect(abandonCliClaim).toHaveBeenCalledWith(expect.anything(), stateId, expect.any(String));
  });

  // A8
  it('browser bootstrap does not need the cli flag', async () => {
    storeInsertedChallenges();
    const { getCliGrantConfig } = await import('./config');
    const { createBrowserChallenge } = await import('./browser-bff');

    expect(process.env.SHOP_BFF_CLI_GRANT_ENABLED).toBeUndefined();
    expect(getCliGrantConfig()).toBeNull();
    await expect(createBrowserChallenge(challengeRequest())).resolves.toMatchObject({ proof_uri: expect.any(String) });
  });

  it.each([
    ['the grant flag is off', { SHOP_BFF_GRANT_FLOW_ENABLED: 'false' }],
    ['the state key is missing', { SHOP_BFF_GRANT_STATE_ENCRYPTION_KEY_B64: undefined }],
    ['the database url is missing', { SHOP_BFF_GRANT_STATE_DATABASE_URL: undefined }],
  ])('browser bootstrap 404s without grant config (%s)', async (_label, overrides) => {
    grantEnv(overrides);
    const { createBrowserChallenge, verifyBrowserChallenge, pollBrowserFlow } = await import('./browser-bff');
    const unavailable = new BffError(404, 'grant_unavailable');
    const stateId = randomUUID();

    await expect(createBrowserChallenge(challengeRequest())).rejects.toEqual(unavailable);
    await expect(verifyBrowserChallenge(verifyRequest('x'), challengeId)).rejects.toEqual(unavailable);
    await expect(pollBrowserFlow(flowRequest(stateId), undefined, stateId)).rejects.toEqual(unavailable);
    expect(insertCliChallenge).not.toHaveBeenCalled();
  });

  // R3.1
  it('bootstrap routes reject cross-origin', async () => {
    const { createBrowserChallenge, verifyBrowserChallenge } = await import('./browser-bff');
    const denied = new BffError(403, 'origin_denied');

    await expect(
      createBrowserChallenge(challengeRequest({ pubky }, { origin: 'https://evil.example' })),
    ).rejects.toEqual(denied);
    await expect(
      verifyBrowserChallenge(
        jsonRequest(
          `${ORIGIN}/api/marketplace/bootstrap-challenges/${challengeId}/verify`,
          { nonce: 'x' },
          {
            origin: 'https://evil.example',
          },
        ),
        challengeId,
      ),
    ).rejects.toEqual(denied);
    expect(insertCliChallenge).not.toHaveBeenCalled();
    expect(getCliChallenge).not.toHaveBeenCalled();
  });

  // R3.5
  it('replayed challenge is consumed', async () => {
    const config = await browserConfig();
    const { nonce, row } = browserChallengeRow(config);
    getCliChallenge.mockResolvedValue({ ...row, consumed_at: new Date() });
    const { verifyBrowserChallenge } = await import('./browser-bff');

    await expect(verifyBrowserChallenge(verifyRequest(encodeBase64Url(nonce)), challengeId)).rejects.toEqual(
      new BffError(409, 'challenge_consumed'),
    );
    expect(consumeChallengeAndInsertCliFlow).not.toHaveBeenCalled();
  });

  it('expired challenge rejected', async () => {
    const config = await browserConfig();
    const { nonce, row } = browserChallengeRow(config);
    getCliChallenge.mockResolvedValue({ ...row, expires_at: new Date(Date.now() - 1_000) });
    const { verifyBrowserChallenge } = await import('./browser-bff');

    await expect(verifyBrowserChallenge(verifyRequest(encodeBase64Url(nonce)), challengeId)).rejects.toEqual(
      new BffError(401, 'homeserver_proof_invalid'),
    );
    expect(fetchHomeserverProofDocument).not.toHaveBeenCalled();
    expect(consumeChallengeAndInsertCliFlow).not.toHaveBeenCalled();
  });

  it('missing nonce rejected', async () => {
    const config = await browserConfig();
    const { row } = browserChallengeRow(config);
    getCliChallenge.mockResolvedValue(row);
    const { verifyBrowserChallenge } = await import('./browser-bff');

    await expect(verifyBrowserChallenge(jsonRequest(`${ORIGIN}/verify`, {}), challengeId)).rejects.toEqual(
      new BffError(400, 'invalid_request'),
    );
    await expect(
      verifyBrowserChallenge(verifyRequest(encodeBase64Url(new Uint8Array(32).fill(1))), challengeId),
    ).rejects.toEqual(new BffError(401, 'homeserver_proof_invalid'));
    expect(fetchHomeserverProofDocument).not.toHaveBeenCalled();
    expect(consumeChallengeAndInsertCliFlow).not.toHaveBeenCalled();
  });

  it('proof from another pubky rejected', async () => {
    storeInsertedChallenges();
    const { createBrowserChallenge, verifyBrowserChallenge } = await import('./browser-bff');
    const created = await createBrowserChallenge(challengeRequest());
    fetchHomeserverProofDocument.mockResolvedValue({ ...created.proof_document, pubky: otherPubky });
    const verifyUrl = `${ORIGIN}/api/marketplace/bootstrap-challenges/${created.challenge_id}/verify`;

    await expect(
      verifyBrowserChallenge(jsonRequest(verifyUrl, { nonce: created.nonce }), created.challenge_id),
    ).rejects.toEqual(new BffError(401, 'homeserver_proof_invalid'));
    expect(consumeChallengeAndInsertCliFlow).not.toHaveBeenCalled();
    expect(createBootstrapFlow).not.toHaveBeenCalled();
  });

  it('foreign homeserver proof rejected', async () => {
    storeInsertedChallenges();
    const { HomeserverFetchDenied } = await import('./ssrf');
    const { createBrowserChallenge, verifyBrowserChallenge } = await import('./browser-bff');
    const created = await createBrowserChallenge(challengeRequest());
    fetchHomeserverProofDocument.mockRejectedValue(new HomeserverFetchDenied());
    const verifyUrl = `${ORIGIN}/api/marketplace/bootstrap-challenges/${created.challenge_id}/verify`;

    await expect(
      verifyBrowserChallenge(jsonRequest(verifyUrl, { nonce: created.nonce }), created.challenge_id),
    ).rejects.toEqual(new BffError(401, 'homeserver_proof_invalid'));
    expect(consumeChallengeAndInsertCliFlow).not.toHaveBeenCalled();
  });

  it('verify binds the flow to the bootstrap cookie with a version 2 browser context', async () => {
    storeInsertedChallenges();
    const { createBrowserChallenge, verifyBrowserChallenge } = await import('./browser-bff');
    const config = await browserConfig();
    const created = await createBrowserChallenge(challengeRequest());
    fetchHomeserverProofDocument.mockResolvedValue(created.proof_document);
    const verifyUrl = `${ORIGIN}/api/marketplace/bootstrap-challenges/${created.challenge_id}/verify`;

    const verified = await verifyBrowserChallenge(
      jsonRequest(verifyUrl, { nonce: created.nonce }),
      created.challenge_id,
    );
    const insert = consumeChallengeAndInsertCliFlow.mock.calls[0][2] as {
      stateId: string;
      tokenHash: Uint8Array;
      contextSealed: Uint8Array;
      keyEpoch: number;
    };
    const [, secret] = verified.cookie.split('.');
    expect(verified.response.state_id).toBe(insert.stateId);
    expect(Buffer.from(insert.tokenHash)).toEqual(
      Buffer.from(hashBoundCookie(config, 1, 'flow', insert.stateId, Buffer.from(secret, 'base64url'))),
    );
    const context = openBrowserFlowContext(config, insert.stateId, pubky, insert.keyEpoch, insert.contextSealed);
    expect(context).toMatchObject({ kind: 'browser', version: 2 });
    expect(createBootstrapFlow).toHaveBeenCalledWith(
      expect.anything(),
      created.result_delivery_id,
      created.result_cpk,
      pubky,
    );
    expect(bindCliFlow).toHaveBeenCalledOnce();
    expect(verified).not.toHaveProperty('cli_token');
  });

  // R3.7
  it('claim pubky mismatch rejected', async () => {
    const config = await browserConfig();
    const { bound, row, stateId } = browserFlowRow(config);
    getCliFlow.mockResolvedValue(row);
    acquireCliClaim.mockResolvedValue(row);
    completeServiceFlow(row.flow_id);
    claimGrantResult.mockResolvedValue(claimedSession(otherPubky));
    const { pollBrowserFlow } = await import('./browser-bff');

    await expect(pollBrowserFlow(flowRequest(stateId), bound.value, stateId)).rejects.toEqual(
      new BffError(409, 'identity_mismatch'),
    );
    expect(terminalizeCliFlow).toHaveBeenCalledWith(expect.anything(), stateId, 'mismatch');
    expect(completeCliClaim).not.toHaveBeenCalled();
  });

  it('a claim whose lease lapsed ends the flow and asks for a fresh approval', async () => {
    const config = await browserConfig();
    const { bound, row, stateId } = browserFlowRow(config, { status: 'claiming' });
    getCliFlow.mockResolvedValue({ ...row, lease_owner: randomUUID(), lease_until: new Date(Date.now() - 1_000) });
    abandonLapsedCliClaim.mockResolvedValue(true);
    const { pollBrowserFlow } = await import('./browser-bff');

    await expect(pollBrowserFlow(flowRequest(stateId), bound.value, stateId)).rejects.toEqual(
      new BffError(422, 'fresh_approval_required'),
    );
    expect(abandonLapsedCliClaim).toHaveBeenCalledWith(expect.anything(), stateId);
    expect(getGrantStatus).not.toHaveBeenCalled();
  });

  it('a claim with a live lease stays in progress', async () => {
    const config = await browserConfig();
    const { bound, row, stateId } = browserFlowRow(config, { status: 'claiming' });
    getCliFlow.mockResolvedValue({ ...row, lease_owner: randomUUID(), lease_until: new Date(Date.now() + 30_000) });
    abandonLapsedCliClaim.mockResolvedValue(false);
    const { pollBrowserFlow } = await import('./browser-bff');

    await expect(pollBrowserFlow(flowRequest(stateId), bound.value, stateId)).rejects.toEqual(
      new BffError(409, 'claim_in_progress'),
    );
  });

  it('cancel ends the flow even when its context cannot be opened', async () => {
    const config = await browserConfig();
    const stateId = randomUUID();
    const bound = makeBoundCookie(stateId);
    const cliContext = sealCliFlowContext(config, stateId, pubky, {
      resultDeliveryId: encodeBase64Url(new Uint8Array(32).fill(4)),
      version: 1,
    });
    const { row } = browserFlowRow(config, {
      tokenHash: hashBoundCookie(config, 1, 'flow', stateId, bound.secret),
      contextSealed: cliContext,
    });
    getCliFlow.mockResolvedValue({ ...row, state_id: stateId });
    const { cancelBrowserFlow } = await import('./browser-bff');

    await expect(
      cancelBrowserFlow(
        jsonRequest(`${ORIGIN}/api/marketplace/bootstrap-flows/${stateId}/cancel`, {}),
        bound.value,
        stateId,
      ),
    ).rejects.toEqual(new BffError(403, 'result_denied'));
    expect(terminalizeCliFlow).toHaveBeenCalledWith(expect.anything(), stateId, 'cancelled');
    expect(cancelGrant).not.toHaveBeenCalled();
  });

  it('a flow whose key epoch rotated out can be neither cancelled nor claimed', async () => {
    const epoch1 = await browserConfig();
    const { bound, row, stateId } = browserFlowRow(epoch1);
    rotateTo(3, STATE_KEY_3, { epoch: 2, key: STATE_KEY_2 });
    getCliFlow.mockResolvedValue(row);
    acquireCliClaim.mockResolvedValue(row);
    completeServiceFlow(row.flow_id);
    const { cancelBrowserFlow, pollBrowserFlow } = await import('./browser-bff');
    const freshApproval = new BffError(422, 'fresh_approval_required');

    await expect(
      cancelBrowserFlow(
        jsonRequest(`${ORIGIN}/api/marketplace/bootstrap-flows/${stateId}/cancel`, {}),
        bound.value,
        stateId,
      ),
    ).rejects.toEqual(freshApproval);
    await expect(pollBrowserFlow(flowRequest(stateId), bound.value, stateId)).rejects.toEqual(freshApproval);
    expect(acquireCliClaim).not.toHaveBeenCalled();
    expect(claimGrantResult).not.toHaveBeenCalled();
  });

  it('cancel ends the flow locally and cancels it at the service', async () => {
    const config = await browserConfig();
    const { bound, derived, row, stateId } = browserFlowRow(config);
    getCliFlow.mockResolvedValue(row);
    cancelGrant.mockResolvedValue(undefined);
    const { cancelBrowserFlow } = await import('./browser-bff');

    await cancelBrowserFlow(
      jsonRequest(`${ORIGIN}/api/marketplace/bootstrap-flows/${stateId}/cancel`, {}),
      bound.value,
      stateId,
    );

    expect(terminalizeCliFlow).toHaveBeenCalledWith(expect.anything(), stateId, 'cancelled');
    expect(cancelGrant).toHaveBeenCalledWith(expect.anything(), row.flow_id, encodeBase64Url(derived.resultDeliveryId));
  });

  function countingRateLimit(): void {
    const buckets = new Map<string, number>();
    consumeCliRateLimit.mockImplementation(async (_config: unknown, key: string, limit: number) => {
      const count = (buckets.get(key) ?? 0) + 1;
      buckets.set(key, count);
      return count <= limit;
    });
  }

  it("challenges a NAT peer creates for someone's pubky never lock the owner out", async () => {
    storeInsertedChallenges();
    process.env.VERCEL = '1';
    resetMarketplaceGrantConfigForTests();
    const { createBrowserChallenge } = await import('./browser-bff');
    countingRateLimit();
    const natExit = { 'x-vercel-forwarded-for': '203.0.113.66' };

    // Five was the old per-pubky allowance; the peer spends it naming the owner's pubky.
    for (let i = 0; i < 5; i += 1) await createBrowserChallenge(challengeRequest({ pubky }, natExit));

    await expect(createBrowserChallenge(challengeRequest({ pubky }, natExit))).resolves.toMatchObject({
      proof_uri: expect.stringContaining(pubky),
    });
  });

  it('rotating a client-written forwarded-for hop does not escape the per-IP bucket', async () => {
    storeInsertedChallenges();
    process.env.VERCEL = '1';
    resetMarketplaceGrantConfigForTests();
    const { createBrowserChallenge } = await import('./browser-bff');
    countingRateLimit();
    const config = await browserConfig();
    const spoofed = (i: number) =>
      challengeRequest({ pubky }, { 'x-vercel-forwarded-for': `10.0.${i}.1, 203.0.113.66` });

    for (let i = 0; i < config.createPerIpPerMinute; i += 1) await createBrowserChallenge(spoofed(i));

    await expect(createBrowserChallenge(spoofed(999))).rejects.toEqual(new BffError(429, 'retry_later', 60));
  });

  it('the per-IP bucket is shared behind one NAT (accepted limit of unauthenticated creation)', async () => {
    storeInsertedChallenges();
    process.env.VERCEL = '1';
    resetMarketplaceGrantConfigForTests();
    const { createBrowserChallenge } = await import('./browser-bff');
    countingRateLimit();
    const config = await browserConfig();
    const from = (ip: string, who = pubky) => challengeRequest({ pubky: who }, { 'x-vercel-forwarded-for': ip });

    for (let i = 0; i < config.createPerIpPerMinute; i += 1) await createBrowserChallenge(from('203.0.113.66'));

    await expect(createBrowserChallenge(from('203.0.113.66', otherPubky))).rejects.toEqual(
      new BffError(429, 'retry_later', 60),
    );
    await expect(createBrowserChallenge(from('198.51.100.7', otherPubky))).resolves.toMatchObject({
      proof_uri: expect.any(String),
    });
  });

  // A9
  it('no migration added by the browser bootstrap', () => {
    const migrations = readdirSync(path.resolve(process.cwd(), 'db/bff'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(migrations).toEqual(['0001_shop_grant_bff.sql', '0002_shop_grant_bff_cli.sql']);
  });
});
