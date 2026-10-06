/**
 * `GET /v1/me/priv-keys` wire bodies as `crates/service/src/priv_keys.rs`
 * (BitcoinErrorLog/pubky-marketplace-service `bb509068`) writes them. The
 * staging proof (`src/test/live/priv-encryption.live.ts`) asserts that the
 * deployed service's 200 and 403 bodies have exactly these members and
 * member types. Owner, key id and key bytes are placeholders.
 */
export const PRIV_KEYS_WIRE_OWNER = 'y'.repeat(52);
export const PRIV_KEYS_WIRE_KEY_ID = '0123456789abcdef0123456789abcdef';
/** 32 bytes of 0x07, base64url without padding. */
export const PRIV_KEYS_WIRE_KEY_B64 = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';

export const PRIV_KEYS_WIRE_OK = {
  schema_version: 1,
  owner: PRIV_KEYS_WIRE_OWNER,
  current_key_id: PRIV_KEYS_WIRE_KEY_ID,
  keys: [{ key_id: PRIV_KEYS_WIRE_KEY_ID, key: PRIV_KEYS_WIRE_KEY_B64, created_at: '2026-09-27T07:00:00.000Z' }],
} as const;

export const PRIV_KEYS_WIRE_NEEDS_REAUTH = {
  schema_version: 1,
  ok: false,
  error: {
    code: 'needs_reauth',
    message: 'The session grant does not include read and write access to /priv/pubky.app/.',
  },
} as const;

export const PRIV_KEYS_WIRE_UNAVAILABLE = {
  schema_version: 1,
  ok: false,
  error: { code: 'priv_keys_unavailable', message: 'Private data keys are not available on this deployment.' },
} as const;
