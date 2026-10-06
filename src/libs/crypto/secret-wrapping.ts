/**
 * At-rest secret wrapping for device-local messaging key material
 * (commerce messaging receiver Noise secrets and Encrypted Link snapshots).
 *
 * Pure AEAD helpers: given a wrapping CryptoKey (custody lives in
 * `./messaging-keyring`), `wrapPayload` encrypts arbitrary bytes with
 * AES-GCM-256 under a FRESH 96-bit IV per call, and `unwrapPayload`
 * reverses it. Every payload carries AAD binding the ciphertext to the
 * Dexie table AND row id it is stored under, so a ciphertext transplanted
 * into another row (or table) fails authentication instead of decrypting.
 *
 * Stored payload layout: `iv (12 bytes) || ciphertext || GCM tag (16 bytes)`.
 *
 * This module does NO IO and holds NO state — it never touches IndexedDB,
 * the wrapping-key store, or the network.
 */

/** `wrap_version` value written next to wrapped payloads (schema column). */
export const WRAP_VERSION_AES_GCM_256 = 1;

/** AES-GCM IV length in bytes (96 bits, the recommended GCM nonce size). */
export const WRAP_IV_BYTES = 12;

/**
 * Domain separator + format version for the AAD. Bumping the wrap format
 * means bumping BOTH this prefix and {@link WRAP_VERSION_AES_GCM_256} so old
 * ciphertexts fail closed instead of being misread.
 */
const WRAP_AAD_PREFIX = 'pubky-app.messaging-wrap.v1';

/**
 * Builds the AAD that binds a wrapped payload to exactly one table row:
 * `pubky-app.messaging-wrap.v1|<table>|<rowId>`. Unwrapping with any other
 * table or row id (a transplanted ciphertext) fails GCM authentication.
 */
export function buildWrapAad(table: string, rowId: string): Uint8Array {
  return new TextEncoder().encode(`${WRAP_AAD_PREFIX}|${table}|${rowId}`);
}

/**
 * Encrypts `plaintext` under `key` with a fresh random 96-bit IV and the
 * given AAD. Returns `iv || ciphertext || tag` as one byte array.
 */
export async function wrapPayload(key: CryptoKey, aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(WRAP_IV_BYTES));
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  const wrapped = new Uint8Array(WRAP_IV_BYTES + ciphertext.byteLength);
  wrapped.set(iv, 0);
  wrapped.set(ciphertext, WRAP_IV_BYTES);
  return wrapped;
}

/**
 * Reverses {@link wrapPayload}. Throws (WebCrypto `OperationError`) when the
 * payload is malformed, tampered with, wrapped under a different/lost key,
 * or bound to a different AAD — callers distinguish that authentication
 * failure from environmental errors via {@link isUnwrapAuthenticationError}.
 */
export async function unwrapPayload(key: CryptoKey, aad: Uint8Array, wrapped: Uint8Array): Promise<Uint8Array> {
  if (wrapped.byteLength <= WRAP_IV_BYTES) {
    // Never a valid payload (no room for even the GCM tag) — surface the same
    // name WebCrypto would, so callers treat it as a lost row, not an outage.
    throw new DOMException('Wrapped payload is too short to contain an IV and tag.', 'OperationError');
  }
  const iv = wrapped.subarray(0, WRAP_IV_BYTES);
  const ciphertext = wrapped.subarray(WRAP_IV_BYTES);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}

/**
 * True when an unwrap failure is GCM authentication (wrong key, tampered or
 * transplanted ciphertext, wrong AAD) — i.e. the wrapped row is unrecoverable
 * and must be treated as LOST. False for environmental failures (WebCrypto
 * missing, IDB down), which must fail closed instead of discarding state.
 */
export function isUnwrapAuthenticationError(error: unknown): boolean {
  // Name-based, not instanceof: jsdom's DOMException does not extend Error,
  // and a DOMException crossing realms fails instanceof either way.
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'OperationError';
}
