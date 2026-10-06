/**
 * One-shot validation of src/libs/identity/auth-token.ts against ground truth:
 * 1. The SDK's own AuthToken.verify (same Rust code the homeserver runs).
 * 2. A live signup POST to the staging homeserver with a fresh invite code
 *    (pass the code as argv[2]); prints the created account.
 *
 * Run: npx tsx scripts/verify-auth-token.mts [INVITE-CODE]
 */
import { AuthToken, Keypair } from '@synonymdev/pubky';
import { signRootAuthToken } from '../src/libs/identity/auth-token';

const keypair = Keypair.random();
const tokenBytes = signRootAuthToken(keypair.secret());
console.log('token length:', tokenBytes.length);

const verified = AuthToken.verify(tokenBytes);
const verifiedPubky = verified.publicKey.z32();
console.log('SDK verify OK, pubky matches:', verifiedPubky === keypair.publicKey.z32());
console.log('capabilities:', verified.capabilities);

const inviteCode = process.argv[2];
if (inviteCode) {
  const url = `https://homeserver.staging.pubky.app/signup?signup_token=${encodeURIComponent(inviteCode)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from(signRootAuthToken(keypair.secret())),
  });
  console.log('live signup status:', response.status);
  if (!response.ok) {
    console.log('body:', await response.text());
    process.exit(1);
  }
  console.log('created account:', keypair.publicKey.z32());
}
