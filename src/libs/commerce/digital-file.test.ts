import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  AES_GCM_TAG_BYTES,
  digitalDeliverableAad,
  digitalDeliverablePath,
  digitalDeliverableUrl,
  digitalFileContentType,
  digitalFileName,
  encryptDigitalDeliverable,
  isDigitalDeliverableId,
  newDigitalDeliverableId,
  openDigitalDeliverable,
} from './digital-file';

const SELLER = 's'.repeat(52);
const OTHER_SELLER = 'o'.repeat(52);
const PLAINTEXT = new TextEncoder().encode('%PDF-1.7 a printable field guide');

async function sealed(version = 1) {
  const deliverableId = newDigitalDeliverableId();
  const encrypted = await encryptDigitalDeliverable({
    plaintext: PLAINTEXT,
    sellerPubky: SELLER,
    deliverableId,
    version,
  });
  return {
    deliverableId,
    encrypted,
    pinned: {
      ciphertext: encrypted.ciphertext,
      key: encrypted.key,
      iv: encrypted.iv,
      ciphertextBlake3: encrypted.ciphertextBlake3,
      plaintextBlake3: encrypted.plaintextBlake3,
      sizeBytes: encrypted.sizeBytes,
      sellerPubky: SELLER,
      deliverableId,
      version,
    },
  };
}

describe('digital deliverable encryption (§2 "How a file is stored")', () => {
  it('encrypts with a fresh 256-bit key and 96-bit IV and reports the service facts', async () => {
    const { encrypted } = await sealed();

    expect(encrypted.key).toMatch(/^[0-9a-f]{64}$/);
    expect(encrypted.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(encrypted.sizeBytes).toBe(PLAINTEXT.byteLength);
    expect(encrypted.ciphertext.byteLength).toBe(PLAINTEXT.byteLength + AES_GCM_TAG_BYTES);
    expect(encrypted.ciphertextBlake3).toBe(bytesToHex(blake3(encrypted.ciphertext)));
    expect(encrypted.plaintextBlake3).toBe(bytesToHex(blake3(PLAINTEXT)));
    expect(new TextDecoder().decode(encrypted.ciphertext)).not.toContain('field guide');
  });

  it('never reuses a key or IV', async () => {
    const first = await sealed();
    const second = await sealed();
    expect(first.encrypted.key).not.toBe(second.encrypted.key);
    expect(first.encrypted.iv).not.toBe(second.encrypted.iv);
    expect(first.deliverableId).not.toBe(second.deliverableId);
  });

  it('round-trips the plaintext for the pinned seller, deliverable and version', async () => {
    const { pinned } = await sealed(3);
    const opened = await openDigitalDeliverable(pinned);
    expect(opened.ok).toBe(true);
    expect(opened.ok && new TextDecoder().decode(opened.plaintext)).toBe('%PDF-1.7 a printable field guide');
  });

  it('binds the ciphertext to the seller, deliverable and version (associated data)', async () => {
    const { pinned } = await sealed(2);
    for (const moved of [{ sellerPubky: OTHER_SELLER }, { deliverableId: newDigitalDeliverableId() }, { version: 3 }]) {
      await expect(
        openDigitalDeliverable({ ...pinned, ...moved }),
        JSON.stringify(Object.keys(moved)),
      ).resolves.toEqual({
        ok: false,
        reason: 'decrypt_failed',
      });
    }
  });

  it('refuses a ciphertext that does not match the pinned hash or length before decrypting', async () => {
    const { pinned } = await sealed();
    const tampered = new Uint8Array(pinned.ciphertext);
    tampered[0] ^= 0x01;
    await expect(openDigitalDeliverable({ ...pinned, ciphertext: tampered })).resolves.toEqual({
      ok: false,
      reason: 'ciphertext_mismatch',
    });
    await expect(openDigitalDeliverable({ ...pinned, sizeBytes: pinned.sizeBytes + 1 })).resolves.toEqual({
      ok: false,
      reason: 'ciphertext_mismatch',
    });
  });

  it('refuses the wrong key, and a malformed key or IV', async () => {
    const { pinned } = await sealed();
    const other = await sealed();
    for (const bad of [{ key: other.encrypted.key }, { key: 'zz'.repeat(32) }, { iv: 'ab' }]) {
      await expect(openDigitalDeliverable({ ...pinned, ...bad })).resolves.toEqual({
        ok: false,
        reason: 'decrypt_failed',
      });
    }
  });

  it('refuses a decrypted file whose hash is not the pinned plaintext hash', async () => {
    const { pinned } = await sealed();
    await expect(openDigitalDeliverable({ ...pinned, plaintextBlake3: '0'.repeat(64) })).resolves.toEqual({
      ok: false,
      reason: 'plaintext_mismatch',
    });
  });

  it('uses the design associated data and homeserver path', () => {
    expect(new TextDecoder().decode(digitalDeliverableAad(SELLER, 'a'.repeat(32), 4))).toBe(
      `pubky-marketplace-deliverable/v1|${SELLER}|${'a'.repeat(32)}|4`,
    );
    expect(digitalDeliverablePath('a'.repeat(32), 4)).toBe(
      `/pub/pubky.app/marketplace/v1/deliverables/${'a'.repeat(32)}/4`,
    );
    expect(digitalDeliverableUrl(SELLER, 'a'.repeat(32), 4)).toBe(
      `pubky://${SELLER}/pub/pubky.app/marketplace/v1/deliverables/${'a'.repeat(32)}/4`,
    );
  });

  it('mints deliverable ids the service accepts', () => {
    expect(isDigitalDeliverableId(newDigitalDeliverableId())).toBe(true);
    expect(isDigitalDeliverableId('A'.repeat(32))).toBe(false);
    expect(isDigitalDeliverableId('a'.repeat(31))).toBe(false);
  });
});

describe('digital file metadata the service accepts', () => {
  it('keeps a valid browser MIME type and falls back otherwise', () => {
    expect(digitalFileContentType('application/pdf')).toBe('application/pdf');
    expect(digitalFileContentType('Text/Plain; charset=utf-8')).toBe('text/plain');
    expect(digitalFileContentType('')).toBe('application/octet-stream');
    expect(digitalFileContentType('not a type')).toBe('application/octet-stream');
    expect(digitalFileContentType('a/b/c')).toBe('application/octet-stream');
    expect(digitalFileContentType(`application/${'x'.repeat(130)}`)).toBe('application/octet-stream');
    expect(digitalFileContentType('text/<script>')).toBe('application/octet-stream');
  });

  it('keeps the last path segment, strips control characters, trims and caps at 255 characters', () => {
    expect(digitalFileName('Field Guide.pdf')).toBe('Field Guide.pdf');
    expect(digitalFileName('C:\\Users\\seller\\guide.pdf')).toBe('guide.pdf');
    expect(digitalFileName('../../etc/passwd')).toBe('passwd');
    expect(digitalFileName('  guide\u0007.pdf  ')).toBe('guide.pdf');
    expect(Array.from(digitalFileName(`${'é'.repeat(300)}.pdf`))).toHaveLength(255);
    expect(digitalFileName('..')).toBe('download');
    expect(digitalFileName('')).toBe('download');
  });
});
