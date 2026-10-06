#!/usr/bin/env node
// Signs stdin bytes with an Ed25519 seed (argv[2], base64url no-pad) and
// prints the base64url no-pad signature. This reproduces the Lock Server's
// X-Paykit-Signature scheme so the verification driver can observe Paykit
// payment status directly through the signed business route. The body must
// already be canonical JCS JSON (sorted keys, no whitespace).
import { createPrivateKey, sign } from 'node:crypto';

const seed = Buffer.from(process.argv[2] ?? '', 'base64url');
if (seed.length !== 32) {
  console.error('usage: sign-body.mjs <base64url-32-byte-seed> < body');
  process.exit(2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const body = Buffer.concat(chunks);

const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
process.stdout.write(sign(null, body, key).toString('base64url'));
