// @vitest-environment node
import { createHmac, hkdfSync } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url, privEnvelopeRejection } from './priv-envelope';
import {
  PRIV_DEK_WRAP_ENC,
  PRIV_WRAPPED_KEYS_DIRECTORY,
  type PrivFileKeyDeriver,
  privKeyringFromWrappedKeys,
  privKeyScopesCoverWrappedKeys,
  type PrivWrappedKey,
  privWrappedKeyEnvelopeSchema,
  privWrappedKeyIdFromEntryUrl,
  privWrappedKeyPath,
  privWrappedKeysDirectoryUrl,
  privWrappedKeyUrl,
  unwrapPrivDataKey,
  wrapPrivDataKey,
} from './priv-key-wrap';

const OWNER = 'o'.repeat(52);
const KEY_A = '0123456789abcdef0123456789abcdef';
const KEY_B = 'fedcba9876543210fedcba9876543210';

/**
 * Stands in for the SDK's `EncryptionKeys`: one stable 32-byte key per file
 * path under the approved directory scope, refused outside it, and a
 * different account root derives different keys. The SDK's own derivation is
 * HKDF-based and covered by its shared vectors; this layer only needs "stable
 * per path, scoped, per account".
 */
function deriverFor(root: string, scope = '/priv/pubky.app/marketplace/'): PrivFileKeyDeriver {
  return {
    deriveForPath(path: string): Uint8Array {
      if (!path.startsWith(scope)) throw new Error('OutsideScope');
      if (path.endsWith('/')) throw new Error('DirectoryPath');
      return new Uint8Array(createHmac('sha256', root).update(path).digest());
    },
  };
}

function dataKey(keyId: string, fill: number, generation: number): PrivWrappedKey {
  return { keyId, key: new Uint8Array(32).fill(fill), generation };
}

function rejectionOf(action: () => unknown): string | null {
  try {
    action();
  } catch (error) {
    return privEnvelopeRejection(error) ?? 'other';
  }
  return 'none';
}

describe('wrapped data-key paths', () => {
  it('puts every key under the Shop private tree, one file per key id', () => {
    expect(PRIV_WRAPPED_KEYS_DIRECTORY).toBe('/priv/pubky.app/marketplace/v2/keys/');
    expect(privWrappedKeyPath(KEY_A)).toBe(`/priv/pubky.app/marketplace/v2/keys/${KEY_A}.json`);
    expect(privWrappedKeyUrl(OWNER, KEY_A)).toBe(`pubky://${OWNER}/priv/pubky.app/marketplace/v2/keys/${KEY_A}.json`);
    expect(privWrappedKeysDirectoryUrl(OWNER)).toBe(`pubky://${OWNER}/priv/pubky.app/marketplace/v2/keys/`);
  });

  it('refuses a key id that is not 32 lowercase hex characters', () => {
    for (const bad of ['', 'A'.repeat(32), 'a'.repeat(31), '../x', `${'a'.repeat(31)}/`]) {
      expect(rejectionOf(() => privWrappedKeyPath(bad))).toBe('malformed');
    }
  });

  it('reads key ids from directory entries and skips everything else', () => {
    const base = privWrappedKeysDirectoryUrl(OWNER);
    expect(privWrappedKeyIdFromEntryUrl(`${base}${KEY_A}.json`)).toBe(KEY_A);
    for (const other of [`${base}notes.txt`, `${base}${KEY_A}`, `${base}${KEY_A}.json.bak`, `${base}ABC.json`, base]) {
      expect(privWrappedKeyIdFromEntryUrl(other)).toBeNull();
    }
  });
});

describe('scope coverage', () => {
  it('accepts directory scopes that contain the key directory', () => {
    for (const scope of ['/priv/pubky.app/marketplace/', '/priv/pubky.app/', '/priv/', '/']) {
      expect(privKeyScopesCoverWrappedKeys([scope])).toBe(true);
    }
  });

  it('refuses scopes that do not reach it: none, a sibling, a file, a deeper directory', () => {
    expect(privKeyScopesCoverWrappedKeys([])).toBe(false);
    for (const scope of [
      '/priv/pubky.app/other/',
      '/pub/pubky.app/marketplace/',
      `/priv/pubky.app/marketplace/v2/keys/${KEY_A}.json`,
      '/priv/pubky.app/marketplace/v2/keys/deeper/',
      '/priv/pubky.app/marketplace',
    ]) {
      expect(privKeyScopesCoverWrappedKeys([scope])).toBe(false);
    }
  });
});

describe('wrapping and unwrapping a data key', () => {
  it('round-trips the key and its generation', () => {
    const deriver = deriverFor('root-1');
    const original = dataKey(KEY_A, 7, 1);
    const envelope = wrapPrivDataKey({ ownerPubky: OWNER, deriver, key: original });
    expect(privWrappedKeyEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({ enc: PRIV_DEK_WRAP_ENC, kid: KEY_A });
    const opened = unwrapPrivDataKey({ ownerPubky: OWNER, deriver, keyId: KEY_A, envelope });
    expect(opened.keyId).toBe(KEY_A);
    expect(opened.generation).toBe(1);
    expect(Array.from(opened.key)).toEqual(Array.from(original.key));
  });

  it('matches an independent derivation: HKDF-SHA256 over the file key with the v1 label, XChaCha20-Poly1305, bound AAD', () => {
    const deriver = deriverFor('root-1');
    const original = dataKey(KEY_A, 9, 3);
    const envelope = wrapPrivDataKey({ ownerPubky: OWNER, deriver, key: original });

    const path = `/priv/pubky.app/marketplace/v2/keys/${KEY_A}.json`;
    const fileKey = deriver.deriveForPath(path);
    const wrappingKey = new Uint8Array(
      hkdfSync('sha256', fileKey, Buffer.from('pubky-priv-dek-wrap/v1'), Buffer.from('wrap'), 32),
    );
    const aad = new TextEncoder().encode(`pubky-priv-dek-wrap/v1|${OWNER}|${path}|${KEY_A}`);
    const plaintext = xchacha20poly1305(wrappingKey, base64UrlToBytes(envelope.nonce), aad).decrypt(
      base64UrlToBytes(envelope.ct),
    );
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      version: 1,
      generation: 3,
      key: bytesToBase64Url(original.key),
    });
  });

  it('uses a fresh nonce every time', () => {
    const deriver = deriverFor('root-1');
    const first = wrapPrivDataKey({ ownerPubky: OWNER, deriver, key: dataKey(KEY_A, 7, 1) });
    const second = wrapPrivDataKey({ ownerPubky: OWNER, deriver, key: dataKey(KEY_A, 7, 1) });
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ct).not.toBe(second.ct);
  });

  it('does not open under another account root, owner, key id or path', () => {
    const deriver = deriverFor('root-1');
    const envelope = wrapPrivDataKey({ ownerPubky: OWNER, deriver, key: dataKey(KEY_A, 7, 1) });
    const open = (overrides: Partial<Parameters<typeof unwrapPrivDataKey>[0]>) =>
      unwrapPrivDataKey({ ownerPubky: OWNER, deriver, keyId: KEY_A, envelope, ...overrides });

    expect(rejectionOf(() => open({ deriver: deriverFor('root-2') }))).toBe('unauthenticated');
    expect(rejectionOf(() => open({ ownerPubky: 'p'.repeat(52) }))).toBe('unauthenticated');
    // The same bytes read as the file of another key id name another kid and another path.
    expect(rejectionOf(() => open({ keyId: KEY_B }))).toBe('malformed');
    expect(rejectionOf(() => open({ keyId: KEY_B, envelope: { ...envelope, kid: KEY_B } }))).toBe('unauthenticated');
    expect(rejectionOf(() => open({}))).toBe('none');
  });

  it('refuses a key scope that does not cover the file instead of wrapping under a guessed key', () => {
    const narrow = deriverFor('root-1', '/priv/pubky.app/elsewhere/');
    expect(() => wrapPrivDataKey({ ownerPubky: OWNER, deriver: narrow, key: dataKey(KEY_A, 7, 1) })).toThrow(
      'OutsideScope',
    );
  });

  it('rejects tampered, truncated and malformed envelopes', () => {
    const deriver = deriverFor('root-1');
    const envelope = wrapPrivDataKey({ ownerPubky: OWNER, deriver, key: dataKey(KEY_A, 7, 1) });
    const ct = base64UrlToBytes(envelope.ct);
    ct[0] ^= 1;
    const open = (candidate: unknown) =>
      unwrapPrivDataKey({ ownerPubky: OWNER, deriver, keyId: KEY_A, envelope: candidate });

    expect(rejectionOf(() => open({ ...envelope, ct: bytesToBase64Url(ct) }))).toBe('unauthenticated');
    expect(rejectionOf(() => open({ ...envelope, nonce: bytesToBase64Url(new Uint8Array(12)) }))).toBe('malformed');
    expect(rejectionOf(() => open({ ...envelope, enc: 'pubky-priv-aead/v1' }))).toBe('malformed');
    expect(rejectionOf(() => open({ ...envelope, extra: true }))).toBe('malformed');
    expect(rejectionOf(() => open(null))).toBe('malformed');
    expect(rejectionOf(() => open('text'))).toBe('malformed');
  });

  it('rejects a document whose plaintext is not a wrapped key', () => {
    const deriver = deriverFor('root-1');
    const path = `/priv/pubky.app/marketplace/v2/keys/${KEY_A}.json`;
    const wrappingKey = new Uint8Array(
      hkdfSync('sha256', deriver.deriveForPath(path), Buffer.from('pubky-priv-dek-wrap/v1'), Buffer.from('wrap'), 32),
    );
    const seal = (plaintext: string) => {
      const nonce = new Uint8Array(24).fill(1);
      const aad = new TextEncoder().encode(`pubky-priv-dek-wrap/v1|${OWNER}|${path}|${KEY_A}`);
      const ct = xchacha20poly1305(wrappingKey, nonce, aad).encrypt(new TextEncoder().encode(plaintext));
      return { enc: PRIV_DEK_WRAP_ENC, kid: KEY_A, nonce: bytesToBase64Url(nonce), ct: bytesToBase64Url(ct) };
    };
    const open = (plaintext: string) =>
      unwrapPrivDataKey({ ownerPubky: OWNER, deriver, keyId: KEY_A, envelope: seal(plaintext) });
    const key = bytesToBase64Url(new Uint8Array(32).fill(4));

    expect(open(JSON.stringify({ version: 1, generation: 1, key })).generation).toBe(1);
    expect(rejectionOf(() => open('not json'))).toBe('malformed');
    expect(rejectionOf(() => open(JSON.stringify({ version: 2, generation: 1, key })))).toBe('malformed');
    expect(rejectionOf(() => open(JSON.stringify({ version: 1, generation: 0, key })))).toBe('malformed');
    expect(
      rejectionOf(() => open(JSON.stringify({ version: 1, generation: 1, key: bytesToBase64Url(new Uint8Array(31)) }))),
    ).toBe('malformed');
    expect(rejectionOf(() => open(JSON.stringify({ version: 1, generation: 1, key, extra: 1 })))).toBe('malformed');
  });

  it('refuses to wrap an empty or wiped key', () => {
    const deriver = deriverFor('root-1');
    expect(rejectionOf(() => wrapPrivDataKey({ ownerPubky: OWNER, deriver, key: dataKey(KEY_A, 0, 1) }))).toBe(
      'malformed',
    );
    const short: PrivWrappedKey = { keyId: KEY_A, key: new Uint8Array(16).fill(1), generation: 1 };
    expect(rejectionOf(() => wrapPrivDataKey({ ownerPubky: OWNER, deriver, key: short }))).toBe('malformed');
  });
});

describe('keyring from wrapped keys', () => {
  it('orders by generation, so the first key (which names every record path) comes first', () => {
    const keyring = privKeyringFromWrappedKeys(OWNER, [dataKey(KEY_B, 2, 2), dataKey(KEY_A, 1, 1)]);
    expect(keyring?.currentKeyId).toBe(KEY_B);
    expect(keyring?.keys.map((entry) => entry.keyId)).toEqual([KEY_A, KEY_B]);
    expect(keyring?.ownerPubky).toBe(OWNER);
  });

  it('refuses an empty set, a gap, a repeat and a set that starts after the first key', () => {
    expect(privKeyringFromWrappedKeys(OWNER, [])).toBeNull();
    expect(privKeyringFromWrappedKeys(OWNER, [dataKey(KEY_B, 2, 2)])).toBeNull();
    expect(privKeyringFromWrappedKeys(OWNER, [dataKey(KEY_A, 1, 1), dataKey(KEY_B, 2, 3)])).toBeNull();
    expect(privKeyringFromWrappedKeys(OWNER, [dataKey(KEY_A, 1, 1), dataKey(KEY_A, 1, 2)])).toBeNull();
    expect(privKeyringFromWrappedKeys(OWNER, [dataKey(KEY_A, 1, 1), dataKey(KEY_B, 2, 1)])).toBeNull();
  });
});
