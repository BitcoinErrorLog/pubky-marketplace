#!/usr/bin/env node
// Prints the content-creator demo identity as JSON: { pubky, secret }.
// The secret is the raw 32-byte Pubky/Ed25519 seed, base64url without padding,
// exactly the creator_secret format paykit-companion-auth consumes on stdin.
// Run inside the creator-demo container (workspace mounted at /workspace).
import { loadRoleKeypair } from '/workspace/examples/js-sdk/scripts/lib/pubky.mjs';

const keypair = await loadRoleKeypair('content-creator');
const secret = Buffer.from(keypair.secret()).toString('base64url');
console.log(JSON.stringify({ pubky: keypair.publicKey.toString(), secret }));
