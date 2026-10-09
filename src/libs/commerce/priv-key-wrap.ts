import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  isPrivKeyId,
  PRIV_DATA_KEY_BYTES,
  type PrivDataKey,
  privEnvelopeRejected,
  type PrivKeyring,
} from './priv-envelope';

// -----------------------------------------------------------------------------
// Wrapped `/priv` data keys (priv-encryption-plan.md, Phase 4).
//
// A signer that approved the `e` action for `/priv/pubky.app/marketplace/`
// delivers scoped encryption keys with the grant. The SDK derives one stable
// 32-byte file key per file path from them. Each of the owner's random data
// keys is stored on the owner's homeserver, wrapped under the file key of its
// own file:
//
//   path        = /priv/pubky.app/marketplace/v2/keys/{key id}.json
//   file key    = EncryptionKeys.deriveForPath(path)                 (SDK)
//   wrapping key = HKDF-SHA256(ikm = file key, salt = "pubky-priv-dek-wrap/v1", info = "wrap", 32)
//
// The file is the envelope `{ enc, kid, nonce, ct }`. `ct` is
// XChaCha20-Poly1305 under the wrapping key with a fresh 24-byte nonce and
// associated data `pubky-priv-dek-wrap/v1|{owner}|{path}|{kid}`, so a file
// moved to another owner, path or key id does not open. The plaintext is the
// UTF-8 JSON `{ version: 1, generation, key }`: `generation` numbers the
// owner's keys from 1 in the order the service released them (the first key
// names every record path), `key` is the data key in base64url.
//
// The data key stays random, so it can still be rotated; the wrapping key is
// derived and never stored. Nothing here logs or caches a key, and every
// derived or decoded secret is zeroed after use.
// -----------------------------------------------------------------------------

export const PRIV_DEK_WRAP_ENC = 'pubky-priv-dek-wrap/v1';
export const PRIV_WRAPPED_KEYS_DIRECTORY = '/priv/pubky.app/marketplace/v2/keys/';
/** Logged instead of a wrapped-key path, which names the key id. */
export const PRIV_WRAPPED_KEYS_LOG_PATH = `${PRIV_WRAPPED_KEYS_DIRECTORY}<key>.json`;

const NONCE_BYTES = 24;
const PLAINTEXT_VERSION = 1;
const HKDF_SALT = new TextEncoder().encode(PRIV_DEK_WRAP_ENC);
const HKDF_INFO = new TextEncoder().encode('wrap');
const WRAPPED_FILE_NAME = /^([0-9a-f]{32})\.json$/;

/** What the SDK's `EncryptionKeys` offers: one 32-byte file key per file path. */
export type PrivFileKeyDeriver = {
  deriveForPath(path: string): Uint8Array;
};

export const privWrappedKeyEnvelopeSchema = z
  .object({
    enc: z.literal(PRIV_DEK_WRAP_ENC),
    kid: z.string().regex(/^[0-9a-f]{32}$/),
    nonce: z.string().min(1),
    ct: z.string().min(1),
  })
  .strict();

export type PrivWrappedKeyEnvelope = z.infer<typeof privWrappedKeyEnvelopeSchema>;

const privWrappedKeyPlaintextSchema = z
  .object({
    version: z.literal(PLAINTEXT_VERSION),
    generation: z.number().int().min(1),
    key: z.string().min(1),
  })
  .strict();

/** A data key and its place in the owner's key order. */
export type PrivWrappedKey = PrivDataKey & { generation: number };

export function privWrappedKeyPath(keyId: string): string {
  if (!isPrivKeyId(keyId)) throw privEnvelopeRejected('malformed');
  return `${PRIV_WRAPPED_KEYS_DIRECTORY}${keyId}.json`;
}

/**
 * Whether delivered key scopes reach every wrapped-key file: a directory
 * scope that contains {@link PRIV_WRAPPED_KEYS_DIRECTORY}. A signer may
 * approve storage and decline `e`, or narrow the scope, and the keys then
 * cannot wrap or open the owner's data keys.
 */
export function privKeyScopesCoverWrappedKeys(scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope.endsWith('/') && PRIV_WRAPPED_KEYS_DIRECTORY.startsWith(scope));
}

export function privWrappedKeyUrl(ownerPubky: string, keyId: string): string {
  return `pubky://${ownerPubky}${privWrappedKeyPath(keyId)}`;
}

export function privWrappedKeysDirectoryUrl(ownerPubky: string): string {
  return `pubky://${ownerPubky}${PRIV_WRAPPED_KEYS_DIRECTORY}`;
}

/** The key id a directory entry URL names, or null for anything that is not a wrapped-key file. */
export function privWrappedKeyIdFromEntryUrl(entryUrl: string): string | null {
  const match = WRAPPED_FILE_NAME.exec(entryUrl.slice(entryUrl.lastIndexOf('/') + 1));
  return match ? match[1] : null;
}

function wrapAad(ownerPubky: string, path: string, keyId: string): Uint8Array {
  for (const field of [ownerPubky, path, keyId]) {
    if (field.length === 0 || field.includes('|')) throw privEnvelopeRejected('malformed');
  }
  return new TextEncoder().encode(`${PRIV_DEK_WRAP_ENC}|${ownerPubky}|${path}|${keyId}`);
}

/** The wrapping key for one wrapped-key file, derived from the SDK file key of that file. */
function wrappingKey(deriver: PrivFileKeyDeriver, path: string): Uint8Array {
  const fileKey = deriver.deriveForPath(path);
  try {
    if (fileKey.length !== PRIV_DATA_KEY_BYTES) throw privEnvelopeRejected('malformed');
    return hkdf(sha256, fileKey, HKDF_SALT, HKDF_INFO, PRIV_DATA_KEY_BYTES);
  } finally {
    fileKey.fill(0);
  }
}

/** Wraps `key` for the owner's wrapped-key file of that key id. */
export function wrapPrivDataKey(input: {
  ownerPubky: string;
  deriver: PrivFileKeyDeriver;
  key: PrivWrappedKey;
}): PrivWrappedKeyEnvelope {
  const { ownerPubky, deriver, key } = input;
  if (key.key.length !== PRIV_DATA_KEY_BYTES || key.key.every((byte) => byte === 0)) {
    throw privEnvelopeRejected('malformed');
  }
  const path = privWrappedKeyPath(key.keyId);
  const aad = wrapAad(ownerPubky, path, key.keyId);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const wrapping = wrappingKey(deriver, path);
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ version: PLAINTEXT_VERSION, generation: key.generation, key: bytesToBase64Url(key.key) }),
  );
  try {
    const ct = xchacha20poly1305(wrapping, nonce, aad).encrypt(plaintext);
    return { enc: PRIV_DEK_WRAP_ENC, kid: key.keyId, nonce: bytesToBase64Url(nonce), ct: bytesToBase64Url(ct) };
  } finally {
    wrapping.fill(0);
    plaintext.fill(0);
  }
}

/**
 * Opens the wrapped-key file of `keyId`. Throws a rejection (see
 * `privEnvelopeRejection`) when it is not an envelope, names another key id
 * than the file does, or does not authenticate for this owner, path and key
 * id: a file written for another owner or path, or by a signer whose keys
 * differ, never opens.
 */
export function unwrapPrivDataKey(input: {
  ownerPubky: string;
  deriver: PrivFileKeyDeriver;
  keyId: string;
  envelope: unknown;
}): PrivWrappedKey {
  const { ownerPubky, deriver, keyId } = input;
  const path = privWrappedKeyPath(keyId);
  const parsed = privWrappedKeyEnvelopeSchema.safeParse(input.envelope);
  if (!parsed.success || parsed.data.kid !== keyId) throw privEnvelopeRejected('malformed');
  const envelope = parsed.data;
  const nonce = base64UrlToBytes(envelope.nonce);
  if (nonce.length !== NONCE_BYTES) throw privEnvelopeRejected('malformed');
  const aad = wrapAad(ownerPubky, path, keyId);
  const wrapping = wrappingKey(deriver, path);
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(wrapping, nonce, aad).decrypt(base64UrlToBytes(envelope.ct));
  } catch {
    throw privEnvelopeRejected('unauthenticated');
  } finally {
    wrapping.fill(0);
  }
  try {
    const document = privWrappedKeyPlaintextSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
    if (!document.success) throw privEnvelopeRejected('malformed');
    const key = base64UrlToBytes(document.data.key);
    if (key.length !== PRIV_DATA_KEY_BYTES) {
      key.fill(0);
      throw privEnvelopeRejected('malformed');
    }
    return { keyId, key, generation: document.data.generation };
  } catch (error) {
    if (error instanceof SyntaxError) throw privEnvelopeRejected('malformed');
    throw error;
  } finally {
    plaintext.fill(0);
  }
}

/**
 * The owner's keyring from unwrapped keys: ordered by generation, which must
 * run 1..n without gaps or repeats, so a missing or duplicated file is
 * refused rather than yielding a keyring whose first key (the one every
 * record path derives from) is wrong. Null when `keys` is empty or the
 * numbering is not contiguous.
 */
export function privKeyringFromWrappedKeys(ownerPubky: string, keys: PrivWrappedKey[]): PrivKeyring | null {
  if (keys.length === 0) return null;
  const ordered = [...keys].sort((left, right) => left.generation - right.generation);
  const seen = new Set<string>();
  for (const [index, entry] of ordered.entries()) {
    if (entry.generation !== index + 1 || seen.has(entry.keyId)) return null;
    seen.add(entry.keyId);
  }
  return {
    ownerPubky,
    currentKeyId: ordered[ordered.length - 1].keyId,
    keys: ordered.map(({ keyId, key }) => ({ keyId, key })),
  };
}
