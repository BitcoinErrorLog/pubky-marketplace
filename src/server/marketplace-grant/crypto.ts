import { randomBytes, timingSafeEqual } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Keypair } from '@synonymdev/pubky';
import canonicalize from 'canonicalize';
import type { MarketplaceGrantConfig } from './config';

const utf8 = new TextEncoder();
const STATE_SALT = utf8.encode('marketplace/shop-bff-state/hkdf-salt/v1');

export type StateContext = {
  resultDeliveryId: string;
  resultPopSeed: string;
  version: 1;
};

export function canonicalJson(value: unknown): string {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new TypeError('Value is not canonical JSON');
  return encoded;
}

export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export function decodeBase64Url32(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) {
    throw new TypeError('Expected canonical Base64url for 32 bytes');
  }
  return Uint8Array.from(bytes);
}

function uuidBytes(value: string): Uint8Array {
  const compact = value.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new TypeError('Expected canonical UUID');
  return Uint8Array.from(Buffer.from(compact, 'hex'));
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}

function concat(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, value) => sum + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function rootForEpoch(config: MarketplaceGrantConfig, epoch: number): Uint8Array {
  if (epoch === config.stateKeyEpoch) return Uint8Array.from(Buffer.from(config.stateKey, 'base64'));
  if (epoch === config.previousStateKeyEpoch && config.previousStateKey) {
    return Uint8Array.from(Buffer.from(config.previousStateKey, 'base64'));
  }
  throw new TypeError('Unknown BFF state key epoch');
}

function derive(config: MarketplaceGrantConfig, epoch: number, label: string): Uint8Array {
  return hkdf(sha256, rootForEpoch(config, epoch), STATE_SALT, concat(utf8.encode(label), u16(epoch)), 32);
}

function cookieHash(
  config: MarketplaceGrantConfig,
  epoch: number,
  kind: 'session' | 'flow',
  id: string,
  secret: Uint8Array,
): Uint8Array {
  const key = derive(config, epoch, `marketplace/shop-bff-state/${kind}-cookie-key/v1`);
  return hmac(sha256, key, concat(utf8.encode(`marketplace/shop-bff-state/${kind}-cookie/v1`), uuidBytes(id), secret));
}

export function makeBoundCookie(id: string): { value: string; secret: Uint8Array } {
  const secret = Uint8Array.from(randomBytes(32));
  return { value: `${id}.${encodeBase64Url(secret)}`, secret };
}

export function parseBoundCookie(value: string | undefined): { id: string; secret: Uint8Array } | null {
  if (!value) return null;
  const [id, encoded, extra] = value.split('.');
  if (extra !== undefined || !/^[0-9a-f-]{36}$/.test(id)) return null;
  try {
    uuidBytes(id);
    return { id, secret: decodeBase64Url32(encoded) };
  } catch {
    return null;
  }
}

export function hashBoundCookie(
  config: MarketplaceGrantConfig,
  epoch: number,
  kind: 'session' | 'flow',
  id: string,
  secret: Uint8Array,
): Uint8Array {
  return cookieHash(config, epoch, kind, id, secret);
}

export function cookieMatches(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function bridgeAad(bridgeId: string, sessionId: string, pubky: string, epoch: number): Uint8Array {
  const pubkyBytes = utf8.encode(pubky);
  return concat(
    utf8.encode('marketplace/shop-bff-session/bearer/v1'),
    uuidBytes(bridgeId),
    uuidBytes(sessionId),
    u16(pubkyBytes.length),
    pubkyBytes,
    u16(epoch),
  );
}

function flowAad(stateId: string, bridgeId: string, epoch: number): Uint8Array {
  return concat(
    utf8.encode('marketplace/shop-bff-state/envelope/v1'),
    uuidBytes(stateId),
    uuidBytes(bridgeId),
    u16(epoch),
  );
}

function seal(config: MarketplaceGrantConfig, epoch: number, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const nonce = Uint8Array.from(randomBytes(24));
  const key = derive(config, epoch, 'marketplace/shop-bff-state/seal-key/v1');
  const encrypted = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return concat(Uint8Array.of(1), nonce, encrypted);
}

function open(config: MarketplaceGrantConfig, epoch: number, sealed: Uint8Array, aad: Uint8Array): Uint8Array {
  if (sealed.length < 42 || sealed[0] !== 1) throw new TypeError('Unknown BFF envelope');
  const key = derive(config, epoch, 'marketplace/shop-bff-state/seal-key/v1');
  return xchacha20poly1305(key, sealed.slice(1, 25), aad).decrypt(sealed.slice(25));
}

export function sealBearer(
  config: MarketplaceGrantConfig,
  bridgeId: string,
  sessionId: string,
  pubky: string,
  bearer: string,
): Uint8Array {
  return seal(
    config,
    config.stateKeyEpoch,
    utf8.encode(canonicalJson({ bearer, version: 1 })),
    bridgeAad(bridgeId, sessionId, pubky, config.stateKeyEpoch),
  );
}

export function openBearer(
  config: MarketplaceGrantConfig,
  bridgeId: string,
  sessionId: string,
  pubky: string,
  epoch: number,
  sealed: Uint8Array,
): string {
  const parsed = JSON.parse(
    new TextDecoder().decode(open(config, epoch, sealed, bridgeAad(bridgeId, sessionId, pubky, epoch))),
  ) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test((parsed as { bearer?: string }).bearer ?? '')
  ) {
    throw new TypeError('Invalid BFF bearer envelope');
  }
  return (parsed as { bearer: string }).bearer;
}

export function sealFlowContext(
  config: MarketplaceGrantConfig,
  stateId: string,
  bridgeId: string,
  context: StateContext,
): Uint8Array {
  return seal(
    config,
    config.stateKeyEpoch,
    utf8.encode(canonicalJson(context)),
    flowAad(stateId, bridgeId, config.stateKeyEpoch),
  );
}

export function openFlowContext(
  config: MarketplaceGrantConfig,
  stateId: string,
  bridgeId: string,
  epoch: number,
  sealed: Uint8Array,
): StateContext {
  const text = new TextDecoder().decode(open(config, epoch, sealed, flowAad(stateId, bridgeId, epoch)));
  const parsed = JSON.parse(text) as StateContext;
  if (
    parsed.version !== 1 ||
    canonicalJson(parsed) !== text ||
    decodeBase64Url32(parsed.resultDeliveryId).length !== 32 ||
    decodeBase64Url32(parsed.resultPopSeed).length !== 32
  ) {
    throw new TypeError('Invalid BFF flow envelope');
  }
  return parsed;
}

export function resultPublicKey(seed: Uint8Array): string {
  return Keypair.fromSecret(seed)
    .publicKey.toString()
    .replace(/^pubky/, '');
}

function signCompact(seedHex: string, header: unknown, payload: unknown): string {
  const encodedHeader = encodeBase64Url(utf8.encode(canonicalJson(header)));
  const encodedPayload = encodeBase64Url(utf8.encode(canonicalJson(payload)));
  const message = utf8.encode(`${encodedHeader}.${encodedPayload}`);
  const signature = ed25519.sign(message, Uint8Array.from(Buffer.from(seedHex, 'hex')));
  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(signature)}`;
}

export function signDeliveryAssertion(
  config: MarketplaceGrantConfig,
  deliveryId: string,
  resultCpk: string,
  expectedPubky: string,
  nowSeconds: number,
  jti: string,
): string {
  return signCompact(
    config.assertionSigningKey,
    { alg: 'EdDSA', kid: config.assertionKeyId, typ: 'JWT' },
    {
      aud: 'marketplace-service',
      exp: nowSeconds + 60,
      iat: nowSeconds,
      iss: config.assertionIssuer,
      jti,
      purpose: 'marketplace-result-delivery',
      result_cpk: resultCpk,
      result_delivery_id: deliveryId,
      sub: expectedPubky,
    },
  );
}

export function signBootstrapAssertion(
  config: MarketplaceGrantConfig,
  deliveryId: string,
  resultCpk: string,
  expectedPubky: string,
  nowSeconds: number,
  jti: string,
): string {
  return signCompact(
    config.assertionSigningKey,
    { alg: 'EdDSA', kid: config.assertionKeyId, typ: 'JWT' },
    {
      aud: 'marketplace-service',
      exp: nowSeconds + 60,
      iat: nowSeconds,
      iss: config.assertionIssuer,
      jti,
      purpose: 'marketplace-grant-flow',
      result_cpk: resultCpk,
      result_delivery_id: deliveryId,
      sub: expectedPubky,
    },
  );
}

const CLI_TOKEN_SALT = utf8.encode('shop-bff/cli-flow-token/hkdf-salt/v1');

function cliTokenKey(config: MarketplaceGrantConfig, epoch: number): Uint8Array {
  return hkdf(
    sha256,
    rootForEpoch(config, epoch),
    CLI_TOKEN_SALT,
    concat(utf8.encode('shop-bff/cli-flow-token/token-key/v1'), u16(epoch)),
    32,
  );
}

export function hashCliToken(config: MarketplaceGrantConfig, epoch: number, secret: Uint8Array): Uint8Array {
  return hmac(sha256, cliTokenKey(config, epoch), secret);
}

const CLI_DELIVERY_SALT = utf8.encode('shop-bff/cli-challenge/hkdf-salt/v1');

function cliDeliveryKey(config: MarketplaceGrantConfig, epoch: number): Uint8Array {
  return hkdf(
    sha256,
    rootForEpoch(config, epoch),
    CLI_DELIVERY_SALT,
    concat(utf8.encode('shop-bff/cli-challenge/delivery-key/v1'), u16(epoch)),
    32,
  );
}

export function hashCliDeliveryId(
  config: MarketplaceGrantConfig,
  epoch: number,
  challengeId: string,
  deliveryId: Uint8Array,
): Uint8Array {
  return hmac(
    sha256,
    cliDeliveryKey(config, epoch),
    concat(utf8.encode('shop-bff/cli-challenge/delivery-id/v1'), uuidBytes(challengeId), deliveryId),
  );
}

export type CliStateContext = {
  resultDeliveryId: string;
  version: 1;
};

const BROWSER_BOOTSTRAP_SALT = utf8.encode('shop-bff/browser-bootstrap/hkdf-salt/v1');

function browserSeedKey(config: MarketplaceGrantConfig, epoch: number): Uint8Array {
  return hkdf(
    sha256,
    rootForEpoch(config, epoch),
    BROWSER_BOOTSTRAP_SALT,
    concat(utf8.encode('shop-bff/browser-bootstrap/seed-key/v1'), u16(epoch)),
    32,
  );
}

export type BrowserBootstrapSecrets = {
  resultPopSeed: Uint8Array;
  resultCpk: string;
  resultDeliveryId: Uint8Array;
};

/**
 * The browser bootstrap's result PoP seed and delivery id are a pure function
 * of the state key epoch and the challenge id, so verify can recompute them
 * without storing a secret on the challenge row. Anyone holding the epoch's
 * state key can recompute them; a public challenge id alone cannot.
 */
export function deriveBrowserBootstrap(
  config: MarketplaceGrantConfig,
  epoch: number,
  challengeId: string,
): BrowserBootstrapSecrets {
  const key = browserSeedKey(config, epoch);
  const id = uuidBytes(challengeId);
  const resultPopSeed = hmac(sha256, key, concat(utf8.encode('shop-bff/browser-bootstrap/result-pop-seed/v1'), id));
  const resultDeliveryId = hmac(
    sha256,
    key,
    concat(utf8.encode('shop-bff/browser-bootstrap/result-delivery-id/v1'), id),
  );
  return { resultPopSeed, resultCpk: resultPublicKey(resultPopSeed), resultDeliveryId };
}

/** Test-only: the raw browser bootstrap key, for the key-separation vector. */
export function browserSeedKeyForTests(config: MarketplaceGrantConfig, epoch: number): Uint8Array {
  return browserSeedKey(config, epoch);
}

export type BrowserStateContext = {
  kind: 'browser';
  resultDeliveryId: string;
  resultPopSeed: string;
  version: 2;
};

function cliFlowAad(stateId: string, pubky: string, epoch: number): Uint8Array {
  const pubkyBytes = utf8.encode(pubky);
  return concat(
    utf8.encode('marketplace/shop-bff-cli-state/envelope/v1'),
    uuidBytes(stateId),
    u16(pubkyBytes.length),
    pubkyBytes,
    u16(epoch),
  );
}

function cliResultTokenAad(stateId: string, epoch: number): Uint8Array {
  return concat(utf8.encode('marketplace/shop-bff-cli-result-token/v1'), uuidBytes(stateId), u16(epoch));
}

export function sealCliFlowContext(
  config: MarketplaceGrantConfig,
  stateId: string,
  pubky: string,
  context: CliStateContext,
): Uint8Array {
  return seal(
    config,
    config.stateKeyEpoch,
    utf8.encode(canonicalJson(context)),
    cliFlowAad(stateId, pubky, config.stateKeyEpoch),
  );
}

export function sealBrowserFlowContext(
  config: MarketplaceGrantConfig,
  stateId: string,
  pubky: string,
  context: BrowserStateContext,
): Uint8Array {
  return seal(
    config,
    config.stateKeyEpoch,
    utf8.encode(canonicalJson(context)),
    cliFlowAad(stateId, pubky, config.stateKeyEpoch),
  );
}

export class BrowserContextRefused extends Error {
  constructor(readonly reason: 'epoch_unavailable' | 'not_browser') {
    super(reason);
  }
}

/**
 * Opens a browser bootstrap context. An epoch whose key is gone is
 * `epoch_unavailable` (fresh approval); anything that is not a canonical
 * `{version: 2, kind: 'browser'}` envelope, including a CLI context, is
 * `not_browser` (result denied).
 */
export function openBrowserFlowContext(
  config: MarketplaceGrantConfig,
  stateId: string,
  pubky: string,
  epoch: number,
  sealed: Uint8Array,
): BrowserStateContext {
  try {
    rootForEpoch(config, epoch);
  } catch {
    throw new BrowserContextRefused('epoch_unavailable');
  }
  let parsed: BrowserStateContext;
  let text: string;
  try {
    text = new TextDecoder().decode(open(config, epoch, sealed, cliFlowAad(stateId, pubky, epoch)));
    parsed = JSON.parse(text) as BrowserStateContext;
  } catch {
    throw new BrowserContextRefused('not_browser');
  }
  if (
    parsed.version !== 2 ||
    parsed.kind !== 'browser' ||
    canonicalJson(parsed) !== text ||
    decodeBase64Url32(parsed.resultDeliveryId).length !== 32 ||
    decodeBase64Url32(parsed.resultPopSeed).length !== 32
  ) {
    throw new BrowserContextRefused('not_browser');
  }
  return parsed;
}

export function openCliFlowContext(
  config: MarketplaceGrantConfig,
  stateId: string,
  pubky: string,
  epoch: number,
  sealed: Uint8Array,
): CliStateContext {
  const text = new TextDecoder().decode(open(config, epoch, sealed, cliFlowAad(stateId, pubky, epoch)));
  const parsed = JSON.parse(text) as CliStateContext;
  if (
    parsed.version !== 1 ||
    canonicalJson(parsed) !== text ||
    decodeBase64Url32(parsed.resultDeliveryId).length !== 32
  ) {
    throw new TypeError('Invalid CLI BFF flow envelope');
  }
  return parsed;
}

export function sealCliResultToken(config: MarketplaceGrantConfig, stateId: string, resultToken: string): Uint8Array {
  return seal(
    config,
    config.stateKeyEpoch,
    utf8.encode(canonicalJson({ resultToken, version: 1 })),
    cliResultTokenAad(stateId, config.stateKeyEpoch),
  );
}

export function openCliResultToken(
  config: MarketplaceGrantConfig,
  stateId: string,
  epoch: number,
  sealed: Uint8Array,
): string {
  const text = new TextDecoder().decode(open(config, epoch, sealed, cliResultTokenAad(stateId, epoch)));
  const parsed = JSON.parse(text) as { resultToken?: string; version?: number };
  if (parsed.version !== 1 || typeof parsed.resultToken !== 'string' || canonicalJson(parsed) !== text) {
    throw new TypeError('Invalid CLI result-token envelope');
  }
  return parsed.resultToken;
}

export function sha256Bytes(value: Uint8Array): Uint8Array {
  return sha256(value);
}

export function signServiceBody(
  config: MarketplaceGrantConfig,
  body: unknown,
): {
  bytes: Uint8Array;
  signature: string;
} {
  const bytes = utf8.encode(canonicalJson(body));
  return {
    bytes,
    signature: encodeBase64Url(ed25519.sign(bytes, Uint8Array.from(Buffer.from(config.requestSigningKey, 'hex')))),
  };
}

export function signResultProof(seed: Uint8Array, message: unknown): string {
  return encodeBase64Url(ed25519.sign(utf8.encode(canonicalJson(message)), Uint8Array.from(seed)));
}
