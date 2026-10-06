import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { ROOT_CAPABILITY, signRootAuthToken } from './auth-token';

const SECRET = new Uint8Array(32).fill(7);
const TIMESTAMP_MICROS = BigInt(1_755_000_000_000) * BigInt(1000);

describe('signRootAuthToken', () => {
  it('produces the canonical 120-byte v0 layout for the root capability', () => {
    const token = signRootAuthToken(SECRET, TIMESTAMP_MICROS);

    expect(token.length).toBe(120);
    // namespace at 64..74
    expect(new TextDecoder().decode(token.subarray(64, 74))).toBe('PUBKY:AUTH');
    // version byte
    expect(token[74]).toBe(0);
    // timestamp, big-endian u64 microseconds at 75..83
    expect(new DataView(token.buffer).getBigUint64(75, false)).toBe(TIMESTAMP_MICROS);
    // signer public key at 83..115
    expect(token.subarray(83, 115)).toEqual(ed25519.getPublicKey(SECRET));
    // capabilities: varint length + string
    expect(token[115]).toBe(ROOT_CAPABILITY.length);
    expect(new TextDecoder().decode(token.subarray(116))).toBe(ROOT_CAPABILITY);
  });

  it('signs serialized[65..] exactly as pubky-common does (skipping the first namespace byte)', () => {
    const token = signRootAuthToken(SECRET, TIMESTAMP_MICROS);

    const signature = token.subarray(0, 64);
    const signable = token.subarray(65);
    expect(ed25519.verify(signature, signable, ed25519.getPublicKey(SECRET))).toBe(true);
    // Sanity: the signature does NOT cover the full post-signature slice.
    expect(ed25519.verify(signature, token.subarray(64), ed25519.getPublicKey(SECRET))).toBe(false);
  });

  it('is deterministic for a fixed secret and timestamp', () => {
    expect(signRootAuthToken(SECRET, TIMESTAMP_MICROS)).toEqual(signRootAuthToken(SECRET, TIMESTAMP_MICROS));
  });

  it('defaults the timestamp to now (within the homeserver ±45s window)', () => {
    const token = signRootAuthToken(SECRET);
    const timestampMicros = new DataView(token.buffer).getBigUint64(75, false);
    const nowMicros = BigInt(Date.now()) * BigInt(1000);
    const driftMicros = timestampMicros > nowMicros ? timestampMicros - nowMicros : nowMicros - timestampMicros;
    expect(driftMicros < BigInt(5_000_000)).toBe(true);
  });

  it('rejects secrets that are not 32 bytes', () => {
    expect(() => signRootAuthToken(new Uint8Array(31))).toThrow('32 bytes');
  });
});
