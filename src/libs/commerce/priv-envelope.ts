import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { isAppError } from '@/libs/error/error';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';

// -----------------------------------------------------------------------------
// Encrypted `/priv` records (priv-encryption-plan.md, Phase 2).
//
// Each owner has one or more 32-byte data keys released by the marketplace
// service (`GET /v1/me/priv-keys`). From each data key, HKDF-SHA256 derives
// two subkeys:
//
//   record key = HKDF(ikm = data key, salt = "pubky-priv-aead/v1", info = "record", 32)
//   path key   = HKDF(ikm = data key, salt = "pubky-priv-aead/v1", info = "path", 32)
//
// A record is the UTF-8 JSON of the plaintext document, sealed with
// XChaCha20-Poly1305 under the record key with a fresh 24-byte nonce and
// associated data `{owner}|{family}|{name}|{kid}`, where `name` is the
// entry's own path segment, so a ciphertext moved to another owner, family,
// entry or key id does not open. The stored document is the envelope
// `{ enc, kid, nonce, ct }` with base64url (no padding) nonce and ciphertext.
//
// The path hides the family and entry ids from the homeserver:
//
//   /priv/pubky.app/marketplace/v2/s/{b64url(HMAC(path key, "family|" + family))}/{name}
//
// A derived entry (watchlist, receipt) is named
// `b64url(HMAC(path key, "id|" + family + "|" + id))`; a listed entry
// (badge checkpoint) by a random 32-hex name. Because the associated data
// binds the name rather than the id, a reader holding only the keys can
// list a family and open every entry, then check that the record's id
// derives the name it was read from.
//
// Paths always use the owner's FIRST (oldest) key so they stay put when a new
// key becomes current. Nothing here stores, logs or caches a key or
// plaintext; derived subkeys are zeroed after use. A revoked keyring (see
// revokePrivKeyring) is refused by every derivation.
// -----------------------------------------------------------------------------

export const PRIV_ENVELOPE_ENC = 'pubky-priv-aead/v1';
export const PRIV_V2_BASE_PATH = '/priv/pubky.app/marketplace/v2/s/';
/** Logged instead of an opaque v2 path. */
export const PRIV_V2_LOG_PATH = `${PRIV_V2_BASE_PATH}<entry>`;
/** Logged instead of a plaintext v1 path, whose names carry receipt ids and checkpoint times. */
export const PRIV_V1_LOG_PATH = '/priv/pubky.app/marketplace/v1/<entry>';

export const PRIV_DATA_KEY_BYTES = 32;
const NONCE_BYTES = 24;
const KEY_ID = /^[0-9a-f]{32}$/;
const HKDF_SALT = new TextEncoder().encode(PRIV_ENVELOPE_ENC);

/** The logical record families stored under the v2 prefix. */
export type PrivFamily =
  | 'watchlist'
  | 'order_receipt'
  | 'attention_seen/activity'
  | 'attention_seen/orders'
  | 'messaging_mutes';

export type PrivDataKey = {
  keyId: string;
  key: Uint8Array;
};

/**
 * An owner's released data keys. `keys` is oldest first; `currentKeyId`
 * names the key new records are sealed under.
 */
export type PrivKeyring = {
  ownerPubky: string;
  currentKeyId: string;
  keys: PrivDataKey[];
};

export const privEnvelopeSchema = z
  .object({
    enc: z.literal(PRIV_ENVELOPE_ENC),
    kid: z.string().regex(KEY_ID),
    nonce: z.string().min(1),
    ct: z.string().min(1),
  })
  .strict();

export type PrivEnvelope = z.infer<typeof privEnvelopeSchema>;

export type PrivEnvelopeRejection = 'malformed' | 'unknown_key' | 'unauthenticated';

export function privEnvelopeRejected(reason: PrivEnvelopeRejection) {
  return Err.validation(ValidationErrorCode.INVALID_INPUT, 'Encrypted private record rejected.', {
    service: ErrorService.Local,
    operation: 'privEnvelope',
    context: { reason },
  });
}

/** The rejection reason of an error thrown by this module, or null for any other error. */
export function privEnvelopeRejection(error: unknown): PrivEnvelopeRejection | null {
  if (!isAppError(error) || error.operation !== 'privEnvelope') return null;
  const reason = error.context?.reason;
  return reason === 'malformed' || reason === 'unknown_key' || reason === 'unauthenticated' ? reason : null;
}

/**
 * What a log may record about a failed private-record operation: the error's
 * kind, status and rejection reason. Messages and context are dropped, since
 * homeserver errors carry the request path in both.
 */
export function privErrorSummary(error: unknown): Record<string, string | number> {
  if (!isAppError(error)) return { error: error instanceof Error ? error.name : typeof error };
  const summary: Record<string, string | number> = {};
  if (error.category !== undefined) summary.category = error.category;
  if (error.code !== undefined) summary.code = error.code;
  const statusCode = error.context?.statusCode;
  if (typeof statusCode === 'number') summary.statusCode = statusCode;
  const reason = privEnvelopeRejection(error) ?? privKeyringRefusal(error);
  if (reason !== null) summary.reason = reason;
  return summary;
}

/** Why a keyring was refused ({@link assertPrivKeyringLive}), or null for any other error. */
export function privKeyringRefusal(error: unknown): 'revoked' | 'wiped' | null {
  if (!isAppError(error) || error.operation !== 'privKeyring') return null;
  const reason = error.context?.reason;
  return reason === 'revoked' || reason === 'wiped' ? reason : null;
}

/** Whether `error` is the refusal of a revoked, empty or wiped keyring. */
export function isPrivKeyringRevoked(error: unknown): boolean {
  return privKeyringRefusal(error) !== null;
}

export function isPrivKeyId(value: string): boolean {
  return KEY_ID.test(value);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw privEnvelopeRejected('malformed');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function subkey(dataKey: Uint8Array, info: 'record' | 'path'): Uint8Array {
  return hkdf(sha256, dataKey, HKDF_SALT, new TextEncoder().encode(info), PRIV_DATA_KEY_BYTES);
}

const revokedKeyrings = new WeakSet<PrivKeyring>();

/**
 * Revokes a released keyring, then zeroes its key bytes. Operations still
 * holding the object afterwards get an error from every derivation instead
 * of encrypting or deriving paths under the zeroed bytes.
 */
export function revokePrivKeyring(keyring: PrivKeyring): void {
  revokedKeyrings.add(keyring);
  for (const { key } of keyring.keys) key.fill(0);
}

/**
 * Throws unless `keyring` is live: not revoked, holding at least one key,
 * and no key wiped to zero. Every path, encrypt and decrypt derivation runs
 * this, and so must a caller right before deleting a plaintext copy.
 */
export function assertPrivKeyringLive(keyring: PrivKeyring): void {
  const wiped = keyring.keys.length === 0 || keyring.keys.some(({ key }) => key.every((byte) => byte === 0));
  if (revokedKeyrings.has(keyring) || wiped) {
    throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'The private data keys were revoked.', {
      service: ErrorService.Local,
      operation: 'privKeyring',
      context: { reason: revokedKeyrings.has(keyring) ? 'revoked' : 'wiped' },
    });
  }
}

function assertField(value: string): void {
  if (value.length === 0 || value.includes('|')) throw privEnvelopeRejected('malformed');
}

export function privAad(ownerPubky: string, family: PrivFamily, name: string, keyId: string): Uint8Array {
  for (const field of [ownerPubky, family, name, keyId]) assertField(field);
  return new TextEncoder().encode(`${ownerPubky}|${family}|${name}|${keyId}`);
}

/** HMAC of `input` under the keyring's path key (from its FIRST key), base64url. */
function segment(keyring: PrivKeyring, input: string): string {
  assertPrivKeyringLive(keyring);
  const key = subkey(keyring.keys[0].key, 'path');
  try {
    return bytesToBase64Url(hmac(sha256, key, new TextEncoder().encode(input)));
  } finally {
    key.fill(0);
  }
}

/** `/priv/pubky.app/marketplace/v2/s/{family}/` for one family. */
export function privFamilyPath(keyring: PrivKeyring, family: PrivFamily): string {
  return `${PRIV_V2_BASE_PATH}${segment(keyring, `family|${family}`)}/`;
}

/** The opaque name of a derived entry: the HMAC of its family and id under the path key. */
export function privEntryName(keyring: PrivKeyring, family: PrivFamily, id: string): string {
  assertField(id);
  return segment(keyring, `id|${family}|${id}`);
}

/** The opaque path of one derived entry. */
export function privEntryPath(keyring: PrivKeyring, family: PrivFamily, id: string): string {
  return `${privFamilyPath(keyring, family)}${privEntryName(keyring, family, id)}`;
}

/**
 * A listed entry: its name is a random 32-hex id (see {@link newPrivEntryName})
 * rather than an HMAC, because readers find it by listing the family.
 */
export function privListedEntryPath(keyring: PrivKeyring, family: PrivFamily, name: string): string {
  if (!isPrivEntryName(name)) throw privEnvelopeRejected('malformed');
  return `${privFamilyPath(keyring, family)}${name}`;
}

export function privListedEntryUrl(keyring: PrivKeyring, family: PrivFamily, name: string): string {
  return `pubky://${keyring.ownerPubky}${privListedEntryPath(keyring, family, name)}`;
}

const ENTRY_NAME = /^[0-9a-f]{32}$/;

export function isPrivEntryName(value: string): boolean {
  return ENTRY_NAME.test(value);
}

export function newPrivEntryName(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function privEntryUrl(keyring: PrivKeyring, family: PrivFamily, id: string): string {
  return `pubky://${keyring.ownerPubky}${privEntryPath(keyring, family, id)}`;
}

export function privFamilyUrl(keyring: PrivKeyring, family: PrivFamily): string {
  return `pubky://${keyring.ownerPubky}${privFamilyPath(keyring, family)}`;
}

/** Seals `record` for the entry `name` under the keyring's current key. */
export function encryptPrivRecord(input: {
  keyring: PrivKeyring;
  family: PrivFamily;
  name: string;
  record: unknown;
}): PrivEnvelope {
  const { keyring, family, name, record } = input;
  assertPrivKeyringLive(keyring);
  const current = keyring.keys.find((key) => key.keyId === keyring.currentKeyId);
  if (!current) throw privEnvelopeRejected('unknown_key');
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(record));
  const recordKey = subkey(current.key, 'record');
  let ct: Uint8Array;
  try {
    ct = xchacha20poly1305(recordKey, nonce, privAad(keyring.ownerPubky, family, name, current.keyId)).encrypt(
      plaintext,
    );
  } finally {
    recordKey.fill(0);
    plaintext.fill(0);
  }
  return { enc: PRIV_ENVELOPE_ENC, kid: current.keyId, nonce: bytesToBase64Url(nonce), ct: bytesToBase64Url(ct) };
}

/**
 * Opens an envelope read from the entry `name` in `family`. Throws a
 * rejection (see {@link privEnvelopeRejection}) when it is not an envelope,
 * names a key the keyring does not hold, or does not authenticate for this
 * owner, family, entry name and key id.
 */
export function decryptPrivRecord(input: {
  keyring: PrivKeyring;
  family: PrivFamily;
  name: string;
  envelope: unknown;
}): unknown {
  const { keyring, family, name } = input;
  assertPrivKeyringLive(keyring);
  const parsed = privEnvelopeSchema.safeParse(input.envelope);
  if (!parsed.success) throw privEnvelopeRejected('malformed');
  const envelope = parsed.data;
  const key = keyring.keys.find((candidate) => candidate.keyId === envelope.kid);
  if (!key) throw privEnvelopeRejected('unknown_key');
  const nonce = base64UrlToBytes(envelope.nonce);
  if (nonce.length !== NONCE_BYTES) throw privEnvelopeRejected('malformed');
  let plaintext: Uint8Array;
  const recordKey = subkey(key.key, 'record');
  try {
    plaintext = xchacha20poly1305(recordKey, nonce, privAad(keyring.ownerPubky, family, name, envelope.kid)).decrypt(
      base64UrlToBytes(envelope.ct),
    );
  } catch (error) {
    if (privEnvelopeRejection(error) !== null) throw error;
    throw privEnvelopeRejected('unauthenticated');
  } finally {
    recordKey.fill(0);
  }
  try {
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw privEnvelopeRejected('malformed');
  } finally {
    plaintext.fill(0);
  }
}
