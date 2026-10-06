import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildWrapAad,
  isUnwrapAuthenticationError,
  unwrapPayload,
  WRAP_IV_BYTES,
  wrapPayload,
} from './secret-wrapping';

const TABLE = 'commerce_messaging_receivers';
const ROW_ID = 'a'.repeat(52);

let key: CryptoKey;

beforeAll(async () => {
  key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
});

describe('buildWrapAad', () => {
  it('binds the table and row id with the format-version prefix', () => {
    const aad = new TextDecoder().decode(buildWrapAad(TABLE, ROW_ID));
    expect(aad).toBe(`pubky-app.messaging-wrap.v1|${TABLE}|${ROW_ID}`);
  });

  it('differs across tables and row ids', () => {
    const base = buildWrapAad(TABLE, ROW_ID);
    expect(buildWrapAad('commerce_messaging_links', ROW_ID)).not.toEqual(base);
    expect(buildWrapAad(TABLE, 'b'.repeat(52))).not.toEqual(base);
  });
});

describe('wrapPayload/unwrapPayload', () => {
  it('round-trips arbitrary bytes', async () => {
    const plaintext = crypto.getRandomValues(new Uint8Array(64));
    const wrapped = await wrapPayload(key, buildWrapAad(TABLE, ROW_ID), plaintext);
    const unwrapped = await unwrapPayload(key, buildWrapAad(TABLE, ROW_ID), wrapped);
    expect([...unwrapped]).toEqual([...plaintext]);
  });

  it('stores iv || ciphertext+tag (12-byte IV prefix, 16-byte GCM tag suffix)', async () => {
    const plaintext = new Uint8Array(32).fill(7);
    const wrapped = await wrapPayload(key, buildWrapAad(TABLE, ROW_ID), plaintext);
    expect(wrapped.byteLength).toBe(WRAP_IV_BYTES + plaintext.byteLength + 16);
    // The plaintext must not appear verbatim anywhere in the stored payload.
    expect([...wrapped.subarray(WRAP_IV_BYTES, WRAP_IV_BYTES + 4)]).not.toEqual([7, 7, 7, 7]);
  });

  it('uses a fresh IV per wrap: same plaintext wraps to different ciphertexts', async () => {
    const plaintext = new Uint8Array(32).fill(1);
    const aad = buildWrapAad(TABLE, ROW_ID);
    const first = await wrapPayload(key, aad, plaintext);
    const second = await wrapPayload(key, aad, plaintext);
    expect([...first]).not.toEqual([...second]);
    // IV uniqueness specifically (first 12 bytes).
    expect([...first.subarray(0, WRAP_IV_BYTES)]).not.toEqual([...second.subarray(0, WRAP_IV_BYTES)]);
  });

  it('fails authentication when unwrapped under a different row id (transplanted ciphertext)', async () => {
    const wrapped = await wrapPayload(key, buildWrapAad(TABLE, ROW_ID), new Uint8Array(32).fill(3));
    await expect(unwrapPayload(key, buildWrapAad(TABLE, 'b'.repeat(52)), wrapped)).rejects.toSatisfy(
      isUnwrapAuthenticationError,
    );
  });

  it('fails authentication when unwrapped under a different table', async () => {
    const wrapped = await wrapPayload(key, buildWrapAad(TABLE, ROW_ID), new Uint8Array(32).fill(3));
    await expect(unwrapPayload(key, buildWrapAad('commerce_messaging_links', ROW_ID), wrapped)).rejects.toSatisfy(
      isUnwrapAuthenticationError,
    );
  });

  it('fails authentication under a different wrapping key (lost/rotated key)', async () => {
    const otherKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const wrapped = await wrapPayload(key, buildWrapAad(TABLE, ROW_ID), new Uint8Array(32).fill(3));
    await expect(unwrapPayload(otherKey, buildWrapAad(TABLE, ROW_ID), wrapped)).rejects.toSatisfy(
      isUnwrapAuthenticationError,
    );
  });

  it('fails authentication on a tampered ciphertext', async () => {
    const wrapped = await wrapPayload(key, buildWrapAad(TABLE, ROW_ID), new Uint8Array(32).fill(3));
    const tampered = new Uint8Array(wrapped);
    tampered[tampered.byteLength - 1] ^= 0xff;
    await expect(unwrapPayload(key, buildWrapAad(TABLE, ROW_ID), tampered)).rejects.toSatisfy(
      isUnwrapAuthenticationError,
    );
  });

  it('rejects a payload too short to hold an IV and tag as an authentication failure', async () => {
    await expect(unwrapPayload(key, buildWrapAad(TABLE, ROW_ID), new Uint8Array(5))).rejects.toSatisfy(
      isUnwrapAuthenticationError,
    );
  });
});

describe('isUnwrapAuthenticationError', () => {
  it('classifies OperationError as authentication failure and everything else as environmental', () => {
    expect(isUnwrapAuthenticationError(new DOMException('bad tag', 'OperationError'))).toBe(true);
    expect(isUnwrapAuthenticationError(new Error('OperationError-free message'))).toBe(false);
    expect(isUnwrapAuthenticationError(new DOMException('idb gone', 'UnknownError'))).toBe(false);
    expect(isUnwrapAuthenticationError('not an error')).toBe(false);
  });
});
