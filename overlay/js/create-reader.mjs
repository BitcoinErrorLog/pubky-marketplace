#!/usr/bin/env node
// Creates (or reuses) a reader Pubky identity, signs it up on the local
// testnet homeserver, and prints JSON: { pubky, secret }.
// The reader plays Bitkit's protocol role; its secret feeds paykit-reader-demo.
// Run inside the creator-demo container (workspace mounted at /workspace).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { readDemoConfig, withInternalServiceUrls } from '/workspace/examples/js-sdk/scripts/lib/config.mjs';
import {
  Keypair,
  homeserverPublicKey,
  pubkyForConfig,
  signupBestEffort,
} from '/workspace/examples/js-sdk/scripts/lib/pubky.mjs';

const readerDir = '/workspace/.local/paykit-reader';
const secretPath = `${readerDir}/secret.b64url`;

const config = withInternalServiceUrls(await readDemoConfig());

let keypair;
if (existsSync(secretPath)) {
  const stored = (await readFile(secretPath, 'utf8')).trim();
  keypair = Keypair.fromSecret(new Uint8Array(Buffer.from(stored, 'base64url')));
} else {
  keypair = Keypair.random();
  await mkdir(readerDir, { recursive: true, mode: 0o700 });
  await writeFile(secretPath, Buffer.from(keypair.secret()).toString('base64url'), { mode: 0o600 });
}

const pubky = pubkyForConfig(config);
const signer = pubky.signer(keypair);
await signupBestEffort(signer, homeserverPublicKey(config));

console.log(
  JSON.stringify({
    pubky: signer.publicKey.toString(),
    secret: Buffer.from(keypair.secret()).toString('base64url'),
  }),
);
