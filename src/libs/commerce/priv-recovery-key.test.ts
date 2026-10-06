import { createHmac, hkdfSync } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { describe, expect, it, vi } from 'vitest';
import { CommercePrivStoreService } from '@/services/homeserver/commerce/priv-store';
import { installFakeHomeserver } from '@/test-utils/fake-homeserver';
import {
  base64UrlToBytes,
  decryptPrivRecord,
  encryptPrivRecord,
  privFamilyPath,
  type PrivKeyring,
  revokePrivKeyring,
} from './priv-envelope';
import { buildPrivRecoveryKeyFile, PRIV_RECOVERY_KEY_FORMAT } from './priv-recovery-key';

const OWNER = 'k'.repeat(52);
const KEYRING: PrivKeyring = {
  ownerPubky: OWNER,
  currentKeyId: 'b'.repeat(32),
  keys: [
    { keyId: 'a'.repeat(32), key: new Uint8Array(32).fill(1) },
    { keyId: 'b'.repeat(32), key: new Uint8Array(32).fill(2) },
  ],
};

describe('buildPrivRecoveryKeyFile', () => {
  it('refuses to export a revoked keyring', () => {
    const held: PrivKeyring = { ...KEYRING, keys: KEYRING.keys.map(({ keyId, key }) => ({ keyId, key: key.slice() })) };
    revokePrivKeyring(held);
    expect(() => buildPrivRecoveryKeyFile(held)).toThrow('The private data keys were revoked.');
  });

  it('carries every key, oldest first, with the owner and the envelope format', () => {
    const file = buildPrivRecoveryKeyFile(KEYRING);
    const document = JSON.parse(file.contents);

    expect(file.fileName).toBe(`pubky-marketplace-recovery-key-${OWNER.slice(0, 8)}.json`);
    expect(document).toEqual({
      format: PRIV_RECOVERY_KEY_FORMAT,
      enc: 'pubky-priv-aead/v1',
      owner: OWNER,
      currentKeyId: 'b'.repeat(32),
      keys: [
        { keyId: 'a'.repeat(32), key: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
        { keyId: 'b'.repeat(32), key: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI' },
      ],
    });
  });

  it('opens records sealed under any exported key', () => {
    const sealedOld = encryptPrivRecord({
      keyring: { ...KEYRING, currentKeyId: 'a'.repeat(32) },
      family: 'watchlist',
      name: 'watchlist',
      record: { v: 1 },
    });
    const document = JSON.parse(buildPrivRecoveryKeyFile(KEYRING).contents) as {
      owner: string;
      currentKeyId: string;
      keys: { keyId: string; key: string }[];
    };
    const restored: PrivKeyring = {
      ownerPubky: document.owner,
      currentKeyId: document.currentKeyId,
      keys: document.keys.map(({ keyId, key }) => ({ keyId, key: base64UrlToBytes(key) })),
    };
    expect(
      decryptPrivRecord({ keyring: restored, family: 'watchlist', name: 'watchlist', envelope: sealedOld }),
    ).toEqual({
      v: 1,
    });
  });

  it('opens every receipt the Shop sealed from the recovery file and a directory listing alone, without receipt ids', async () => {
    const receiptIds = ['018f47d2-6a27-7c23-a49d-6b21bb770201', '018f47d2-6a27-7c23-a49d-6b21bb770202'];
    const homeserver = installFakeHomeserver();
    // Sealed by the Shop's own store, one under the older key and one under the current key.
    await CommercePrivStoreService.write({ ...KEYRING, currentKeyId: 'a'.repeat(32) }, 'order_receipt', receiptIds[0], {
      recordType: 'order_receipt',
      receiptId: receiptIds[0],
    });
    await CommercePrivStoreService.write(KEYRING, 'order_receipt', receiptIds[1], {
      recordType: 'order_receipt',
      receiptId: receiptIds[1],
    });
    const familyUrl = `pubky://${OWNER}${privFamilyPath(KEYRING, 'order_receipt')}`;
    const listing = [...homeserver.files.keys()].filter((url) => url.startsWith(familyUrl));
    const stored = homeserver.files;
    vi.restoreAllMocks();

    // The documented offline recipe, with node:crypto and @noble/ciphers only.
    const file = JSON.parse(buildPrivRecoveryKeyFile(KEYRING).contents) as {
      owner: string;
      keys: { keyId: string; key: string }[];
    };
    const subkey = (key: string, info: string) =>
      new Uint8Array(hkdfSync('sha256', Buffer.from(key, 'base64url'), 'pubky-priv-aead/v1', info, 32));
    const pathKey = subkey(file.keys[0].key, 'path');
    const segment = (input: string) => createHmac('sha256', pathKey).update(input).digest('base64url');
    const opened = listing.map((url) => {
      const name = url.slice(url.lastIndexOf('/') + 1);
      const envelope = stored.get(url) as { kid: string; nonce: string; ct: string };
      const key = file.keys.find(({ keyId }) => keyId === envelope.kid)!;
      const plaintext = xchacha20poly1305(
        subkey(key.key, 'record'),
        Uint8Array.from(Buffer.from(envelope.nonce, 'base64url')),
        new TextEncoder().encode(`${file.owner}|order_receipt|${name}|${envelope.kid}`),
      ).decrypt(Uint8Array.from(Buffer.from(envelope.ct, 'base64url')));
      const record = JSON.parse(new TextDecoder().decode(plaintext)) as { receiptId: string };
      // The id inside must derive the name the entry was read from.
      expect(segment(`id|order_receipt|${record.receiptId}`)).toBe(name);
      return record.receiptId;
    });
    expect(opened.sort()).toEqual([...receiptIds].sort());
  });
});
