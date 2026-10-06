// Smoke test for the vendored paykit-wasm messaging binding (vendor/paykit-wasm).
//
// Ported from the binding's own `paykit-wasm/scripts/smoke.mjs` at the pinned commit
// recorded in docs/ecommerce/paykit-wasm-provenance.md, retargeted at the vendored
// package. It instantiates the actual compiled WASM in Node and proves with REAL
// crypto (no mocks): the bound messaging API surface, receiver Noise key generation,
// a full Noise XX handshake between two in-memory parties with converging link ids,
// encrypted roundtrips in both directions, AEAD tamper rejection, and the 1000-byte
// message limit. CI runs it ahead of `next build`, so a regression in the vendored
// artifact fails the build job.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname;
const pkgDir = join(root, 'vendor', 'paykit-wasm');
const pkgJsonPath = join(pkgDir, 'package.json');
const dtsPath = join(pkgDir, 'paykit_wasm.d.ts');
const jsPath = join(pkgDir, 'paykit_wasm.js');
const wasmPath = join(pkgDir, 'paykit_wasm_bg.wasm');

for (const path of [pkgJsonPath, dtsPath, jsPath, wasmPath]) {
  if (!existsSync(path)) {
    throw new Error(`missing vendored package artifact: ${path}`);
  }
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
if (pkg.name !== 'paykit-wasm') {
  throw new Error(`unexpected vendored package name: ${pkg.name}`);
}
if (pkg.type !== 'module') {
  throw new Error(`vendored package must be ESM; got type=${pkg.type}`);
}
if (pkg.main !== 'paykit_wasm.js') {
  throw new Error(`unexpected vendored package main: ${pkg.main}`);
}
if (pkg.types !== 'paykit_wasm.d.ts') {
  throw new Error(`unexpected vendored package types: ${pkg.types}`);
}

const dts = readFileSync(dtsPath, 'utf8');
const requiredSnippets = [
  'export class PubkyClient',
  'startAuthFlow(capabilities: string): AuthFlowHandle;',
  'static testnet(): PubkyClient;',
  'export class AuthFlowHandle',
  'authorizationUrl(): string;',
  'awaitApproval(): Promise<any>;',
  'export class SessionHandle',
  'pubky(): string;',
  'exportSession(): string;',
  'restoreSession(exported_session: string): Promise<any>;',
  'resumeSessionFromCookie(pubky: string): Promise<any>;',
  'export class LinkHandshakeHandle',
  'advance(): Promise<any>;',
  'export class EncryptedLinkHandle',
  'sendPrivateApplicationMessageJson(raw_json: string): Promise<any>;',
  'receivePrivateApplicationMessages(): Promise<any>;',
  'snapshot(): Uint8Array;',
  'export class MemoryNoiseSession',
  'export function generateNoiseSecretKey(): Uint8Array;',
  'export function noisePublicKeyFromSecret(secret: Uint8Array): string;',
  'export function publishReceiverMarker(',
  'export function getReceiverMarker(',
  'export function removeReceiverMarker(',
  'export function initiateEncryptedLink(',
  'export function acceptEncryptedLink(',
  'export function restoreEncryptedLink(',
  'export function restoreEncryptedLinkHandshake(',
  'export function clearEncryptedLinkOutbox(',
  'export function maxNoiseMessageLen(): number;',
  'export function noiseTagLen(): number;',
];

for (const snippet of requiredSnippets) {
  if (!dts.includes(snippet)) {
    throw new Error(`vendored TypeScript declarations missing: ${snippet}`);
  }
}

const sdk = await import(pathToFileURL(jsPath));
await sdk.default({ module_or_path: await readFile(wasmPath) });

// Constants match the pubky-noise wire contract.
assert.equal(sdk.maxNoiseMessageLen(), 1000);
assert.equal(sdk.noiseTagLen(), 16);

// Key generation is real entropy; public-key derivation is deterministic.
const aliceNoiseSecret = sdk.generateNoiseSecretKey();
const bobNoiseSecret = sdk.generateNoiseSecretKey();
assert.equal(aliceNoiseSecret.length, 32);
assert.equal(bobNoiseSecret.length, 32);
assert.notDeepEqual([...aliceNoiseSecret], [...bobNoiseSecret]);
assert.equal(sdk.noisePublicKeyFromSecret(aliceNoiseSecret), sdk.noisePublicKeyFromSecret(aliceNoiseSecret));
assert.match(sdk.noisePublicKeyFromSecret(aliceNoiseSecret), /^[a-z0-9]{52}$/);

// Full Noise XX handshake between two in-memory parties using the exact
// crypto stack Paykit Encrypted Links use (caller-shuttled packets).
const aliceIdentity = sdk.noisePublicKeyFromSecret(sdk.generateNoiseSecretKey());
const bobIdentity = sdk.noisePublicKeyFromSecret(sdk.generateNoiseSecretKey());
const alice = new sdk.MemoryNoiseSession(true, aliceNoiseSecret, bobIdentity);
const bob = new sdk.MemoryNoiseSession(false, bobNoiseSecret, aliceIdentity);

bob.readHandshakeMessage(alice.writeHandshakeMessage());
alice.readHandshakeMessage(bob.writeHandshakeMessage());
bob.readHandshakeMessage(alice.writeHandshakeMessage());
assert.equal(alice.isHandshakeComplete(), true);
assert.equal(bob.isHandshakeComplete(), true);
alice.transitionTransport();
bob.transitionTransport();
assert.match(alice.linkIdHex(), /^[0-9a-f]{64}$/);
assert.equal(alice.linkIdHex(), bob.linkIdHex());

// Encrypted roundtrips in both directions.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const outbound = JSON.stringify({
  version: 1,
  kind: 'marketplace.chat_message.v0',
  body: 'Is the item still available?',
});
assert.equal(decoder.decode(bob.decrypt(alice.encrypt(encoder.encode(outbound)))), outbound);
const reply = JSON.stringify({ version: 1, kind: 'marketplace.chat_message.v0', body: 'Yes.' });
assert.equal(decoder.decode(alice.decrypt(bob.encrypt(encoder.encode(reply)))), reply);

// Tampered ciphertext fails AEAD authentication without burning the nonce.
const packet = alice.encrypt(encoder.encode('do not tamper'));
const tampered = Uint8Array.from(packet);
tampered[10] ^= 0xff;
assert.throws(() => bob.decrypt(tampered), /decrypt failed/);
assert.equal(decoder.decode(bob.decrypt(packet)), 'do not tamper');

// The 1000-byte limit is enforced by the compiled crypto.
const exact = new Uint8Array(sdk.maxNoiseMessageLen()).fill(0x61);
assert.deepEqual([...bob.decrypt(alice.encrypt(exact))], [...exact]);
assert.throws(
  () => alice.encrypt(new Uint8Array(sdk.maxNoiseMessageLen() + 1).fill(0x61)),
  /exceeds max Noise message size/,
);

// The production session path constructs a pubkyauth URL for the paykit scope.
// `startAuthFlow` starts the HTTP-relay poller before `awaitApproval()`. Node
// will not exit while those sockets are open: locally ~9s after "passed",
// GitHub-hosted Ubuntu ~43 min (run 35573196241: passed 07:30:22, process
// exit 08:13:41). Drop the flow and client, then exit so CI is not gated on
// the poller.
const client = new sdk.PubkyClient();
const flow = client.startAuthFlow('/pub/paykit/:rw');
const url = flow.authorizationUrl();
assert.match(url, /^pubkyauth:\/\/signin\?/);
assert.ok(url.includes('caps=/pub/paykit/:rw'));
flow.free();
client.free();

alice.close();
bob.close();

console.log('vendored paykit-wasm messaging binding smoke check passed');
process.exit(0);
