import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Local (browser-side) signer for pubky-core `AuthToken` v0.
 *
 * The `@synonymdev/pubky` WASM SDK signs auth tokens internally for
 * `signer.signinCookie()` / `signer.signupCookie()` but does not expose signing to JS
 * (its `AuthToken` class is verify/fromBytes/toBytes only). Direct HTTPS
 * signup against the staging homeserver (`POST {homeserverUrl}/signup`)
 * needs the signed token as the request body, so this module reimplements
 * `pubky_common::auth::AuthToken::sign` exactly.
 *
 * Canonical postcard byte layout (all offsets fixed for version 0 with a
 * single-capability string < 128 bytes, verified against
 * `pubky-common/src/auth.rs` and its `v0_id_signable` test):
 *
 * | offset    | bytes | field                                            |
 * |-----------|-------|--------------------------------------------------|
 * | 0..64     | 64    | ed25519 signature (raw, no length prefix)        |
 * | 64..74    | 10    | namespace `PUBKY:AUTH`                           |
 * | 74        | 1     | version (0)                                      |
 * | 75..83    | 8     | timestamp, microseconds since epoch, big-endian  |
 * | 83..115   | 32    | signer public key (raw ed25519)                  |
 * | 115..     | 1+n   | capabilities string, varint length + UTF-8       |
 *
 * The signature covers `serialized[65..]` — everything after the signature
 * PLUS skipping the first namespace byte. That off-by-one is what the Rust
 * implementation does (`keypair.sign(&serialized[65..])`), so the homeserver
 * verifies against the same slice; it must be replicated, not "fixed".
 */

const NAMESPACE = new TextEncoder().encode('PUBKY:AUTH');
const VERSION = 0;
const SIGNATURE_LENGTH = 64;
/** Rust signs/verifies `serialized[65..]`, one byte past the signature. */
const SIGNABLE_OFFSET = SIGNATURE_LENGTH + 1;
/** `Capability::root()` — read+write on `/`, what the SDK uses for signup/signin. */
export const ROOT_CAPABILITY = '/:rw';

/**
 * Sign a root-capability `AuthToken` for the given ed25519 secret key.
 *
 * @param secret - The 32-byte ed25519 secret (seed), e.g. `keypair.secret()`.
 * @param timestampMicros - Token timestamp in microseconds since epoch.
 *   Defaults to now; the homeserver accepts a ±45 s window.
 * @returns The canonical postcard-serialized token, ready to POST as the
 *   `/signup` or `/session` request body.
 */
export function signRootAuthToken(
  secret: Uint8Array,
  timestampMicros: bigint = BigInt(Date.now()) * BigInt(1000),
): Uint8Array {
  if (secret.length !== 32) {
    throw new Error(`AuthToken secret must be 32 bytes, got ${secret.length}`);
  }

  const publicKey = ed25519.getPublicKey(secret);
  const capabilities = new TextEncoder().encode(ROOT_CAPABILITY);
  if (capabilities.length > 127) {
    // Postcard varint would need a second length byte; root is 4 bytes, so
    // this only trips if the constant above is ever changed carelessly.
    throw new Error('Capability string too long for single-byte varint length');
  }

  const token = new Uint8Array(
    SIGNATURE_LENGTH + NAMESPACE.length + 1 + 8 + publicKey.length + 1 + capabilities.length,
  );

  let offset = SIGNATURE_LENGTH;
  token.set(NAMESPACE, offset);
  offset += NAMESPACE.length;
  token[offset] = VERSION;
  offset += 1;
  new DataView(token.buffer).setBigUint64(offset, timestampMicros, false);
  offset += 8;
  token.set(publicKey, offset);
  offset += publicKey.length;
  token[offset] = capabilities.length;
  offset += 1;
  token.set(capabilities, offset);

  const signature = ed25519.sign(token.subarray(SIGNABLE_OFFSET), secret);
  token.set(signature, 0);

  return token;
}
