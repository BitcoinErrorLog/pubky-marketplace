// REAL-crypto integration tests against the actual vendored WASM artifact
// (vendor/paykit-wasm) — no mocks. The module is initialized from file bytes
// because jsdom cannot fetch the .wasm asset. `MemoryNoiseSession` drives the
// exact `DataLinkContext` crypto stack Paykit Encrypted Links use
// (Noise_XX_25519_ChaChaPoly_SHA256, 1000-byte messages, explicit nonces),
// with this test shuttling the same packets that would otherwise sit in
// homeserver outbox slots.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildChatMessage,
  chatMessageBodyBudget,
  decodeChatMessage,
  PAYKIT_NOISE_MESSAGE_MAX_BYTES,
} from '@/libs/commerce/messaging-contracts';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { buildDmMessage, decodeDmMessage, dmBodyBudget } from '@/libs/messaging/dm-contracts';

type PaykitWasmModule = typeof import('paykit-wasm');

let wasm: PaykitWasmModule;

beforeAll(async () => {
  wasm = await import('paykit-wasm');
  const wasmBytes = await readFile(join(process.cwd(), 'vendor', 'paykit-wasm', 'paykit_wasm_bg.wasm'));
  await wasm.default({ module_or_path: wasmBytes });
});

const SELLER = 's'.repeat(52);
const BUYER = 'b'.repeat(52);
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';
const CONVERSATION_ID = buildMarketplaceConversationAggregateId(SELLER, BUYER, LISTING_ID);
const LISTING_REF = buildMarketplaceListingAggregateId(SELLER, LISTING_ID);

function establishedPair() {
  const aliceSecret = wasm.generateNoiseSecretKey();
  const bobSecret = wasm.generateNoiseSecretKey();
  const aliceIdentity = wasm.noisePublicKeyFromSecret(wasm.generateNoiseSecretKey());
  const bobIdentity = wasm.noisePublicKeyFromSecret(wasm.generateNoiseSecretKey());
  const alice = new wasm.MemoryNoiseSession(true, aliceSecret, bobIdentity);
  const bob = new wasm.MemoryNoiseSession(false, bobSecret, aliceIdentity);
  bob.readHandshakeMessage(alice.writeHandshakeMessage());
  alice.readHandshakeMessage(bob.writeHandshakeMessage());
  bob.readHandshakeMessage(alice.writeHandshakeMessage());
  alice.transitionTransport();
  bob.transitionTransport();
  return { alice, bob };
}

describe('paykit-wasm real crypto (vendored artifact)', () => {
  it('agrees with the client-side constant for the Noise message ceiling', () => {
    expect(wasm.maxNoiseMessageLen()).toBe(PAYKIT_NOISE_MESSAGE_MAX_BYTES);
    expect(wasm.noiseTagLen()).toBe(16);
  });

  it('generates 32-byte receiver keys with deterministic public derivation', () => {
    const secret = wasm.generateNoiseSecretKey();
    expect(secret).toHaveLength(32);
    const pub = wasm.noisePublicKeyFromSecret(secret);
    expect(pub).toMatch(/^[a-z0-9]{52}$/);
    expect(wasm.noisePublicKeyFromSecret(secret)).toBe(pub);
  });

  it('completes a Noise XX handshake with converging link ids', () => {
    const { alice, bob } = establishedPair();
    expect(alice.isTransport()).toBe(true);
    expect(bob.isTransport()).toBe(true);
    expect(alice.linkIdHex()).toMatch(/^[0-9a-f]{64}$/);
    expect(alice.linkIdHex()).toBe(bob.linkIdHex());
    alice.close();
    bob.close();
  });

  it('round-trips a real marketplace chat envelope through the encrypted transport', () => {
    const { alice, bob } = establishedPair();
    const { json, message } = buildChatMessage({
      eventId: crypto.randomUUID(),
      conversationId: CONVERSATION_ID,
      listingRef: LISTING_REF,
      sentAt: Date.now(),
      body: 'Is this still available? Asking over real ChaChaPoly.',
    });
    const packet = alice.encrypt(new TextEncoder().encode(json));
    const plaintext = new TextDecoder().decode(bob.decrypt(packet));
    expect(decodeChatMessage(plaintext)).toEqual(message);
    alice.close();
    bob.close();
  });

  it('round-trips a real pubky_app.dm.v0 envelope through the SAME encrypted transport', () => {
    const { alice, bob } = establishedPair();
    const dm = buildDmMessage({
      eventId: crypto.randomUUID(),
      sentAt: Date.now(),
      body: 'General DMs ride the same Noise link as marketplace chat.',
    });
    const chat = buildChatMessage({
      eventId: crypto.randomUUID(),
      conversationId: CONVERSATION_ID,
      listingRef: LISTING_REF,
      sentAt: Date.now(),
      body: 'And this one belongs to the listing conversation.',
    });
    // One link, two kinds, in one drain order — receivers split them by kind.
    const first = new TextDecoder().decode(bob.decrypt(alice.encrypt(new TextEncoder().encode(dm.json))));
    const second = new TextDecoder().decode(bob.decrypt(alice.encrypt(new TextEncoder().encode(chat.json))));
    expect(decodeDmMessage(first)).toEqual(dm.message);
    expect(decodeChatMessage(first)).toBeNull();
    expect(decodeChatMessage(second)).toEqual(chat.message);
    expect(decodeDmMessage(second)).toBeNull();
    alice.close();
    bob.close();
  });

  it('accepts an exactly-at-budget DM envelope over the real transport', () => {
    const { alice, bob } = establishedPair();
    const { json, byteSize } = buildDmMessage({
      eventId: crypto.randomUUID(),
      sentAt: Date.now(),
      body: 'a'.repeat(dmBodyBudget()),
    });
    expect(byteSize).toBe(PAYKIT_NOISE_MESSAGE_MAX_BYTES);
    const bytes = new TextEncoder().encode(json);
    expect([...bob.decrypt(alice.encrypt(bytes))]).toEqual([...bytes]);
    alice.close();
    bob.close();
  });

  it('accepts an exactly-at-budget envelope and the crypto layer rejects one byte over', () => {
    const { alice, bob } = establishedPair();
    const budget = chatMessageBodyBudget(CONVERSATION_ID, LISTING_REF);
    const { json, byteSize } = buildChatMessage({
      eventId: crypto.randomUUID(),
      conversationId: CONVERSATION_ID,
      listingRef: LISTING_REF,
      // Fixed-width fields keep the byte size exact (asserted below).
      sentAt: Date.now(),
      body: 'a'.repeat(budget),
    });
    expect(byteSize).toBe(PAYKIT_NOISE_MESSAGE_MAX_BYTES);
    const bytes = new TextEncoder().encode(json);
    // Spread both sides: the wasm boundary returns a different-realm Uint8Array.
    expect([...bob.decrypt(alice.encrypt(bytes))]).toEqual([...bytes]);
    const oversize = new Uint8Array(PAYKIT_NOISE_MESSAGE_MAX_BYTES + 1).fill(0x61);
    expect(() => alice.encrypt(oversize)).toThrow(/exceeds max Noise message size/);
    alice.close();
    bob.close();
  });

  it('rejects tampered ciphertext without burning the receiving nonce', () => {
    const { alice, bob } = establishedPair();
    const packet = alice.encrypt(new TextEncoder().encode('do not tamper'));
    const tampered = Uint8Array.from(packet);
    tampered[8] ^= 0xff;
    expect(() => bob.decrypt(tampered)).toThrow(/decrypt failed/);
    expect(new TextDecoder().decode(bob.decrypt(packet))).toBe('do not tamper');
    alice.close();
    bob.close();
  });

  // pubkyauth URL construction (`startAuthFlow('/pub/paykit/:rw')`) is NOT
  // asserted here: the binding's URL builder trips over jsdom's URL
  // environment ("url parse"). It is covered with the same assertions in a
  // plain Node runtime by `scripts/paykit-wasm-smoke.mjs`, which CI runs
  // ahead of the build, and in real browsers by the binding's e2e.
});
