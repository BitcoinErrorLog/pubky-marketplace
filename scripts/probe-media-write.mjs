// Ops probe: can a session holding the app's exact Ring capability grant
// ('/pub/pubky.app/:rw') write to the marketplace media path? Reproduces a
// reported 403 "Session does not have write access to path" on shop avatar
// upload. Env: STAGING_ADMIN_PASSWORD required.
import { AuthFlowKind, Keypair, Pubky, PublicKey } from '@synonymdev/pubky';

const HOMESERVER_ADMIN = 'https://admin.homeserver.staging.pubky.app/generate_signup_token';
const ADMIN_PASSWORD = process.env.STAGING_ADMIN_PASSWORD;
const HOMESERVER_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const HTTP_RELAY = 'https://httprelay.staging.pubky.app/inbox';

const tokenResponse = await fetch(HOMESERVER_ADMIN, { headers: { 'X-Admin-Password': ADMIN_PASSWORD } });
const signupToken = (await tokenResponse.text()).trim();

const keypair = Keypair.random();
const signerPubky = new Pubky();
const signer = signerPubky.signer(keypair);
await signer.signupCookie(PublicKey.from(HOMESERVER_PUBKY), signupToken);
const who = keypair.publicKey.z32();
console.log(`identity: ${who}`);

// Fresh client (separate cookie jar role): session via the app's exact grant.
const appPubky = new Pubky();
const flow = appPubky.startCookieAuthFlow('/pub/pubky.app/:rw', AuthFlowKind.signin(), HTTP_RELAY);
const approval = flow.awaitApproval();
await signer.approveAuthRequest(flow.authorizationUrl);
const session = await approval;
console.log(`session capabilities: ${JSON.stringify(session.capabilities ?? session.info?.capabilities ?? 'n/a')}`);

const writes = [
  `pubky://${who}/pub/pubky.app/marketplace/v1/media/probe0123456789abcdef01234567`,
  `pubky://${who}/pub/pubky.app/profile.json`,
];
// Simulate the browser: approve a SECOND session (the messaging grant) in the
// same cookie jar, then retry the pubky.app write with the FIRST session.
const flow2 = appPubky.startCookieAuthFlow('/pub/pubky.app/:rw,/pub/paykit/:rw', AuthFlowKind.signin(), HTTP_RELAY);
const approval2 = flow2.awaitApproval();
await signer.approveAuthRequest(flow2.authorizationUrl);
const messagingSession = await approval2;
console.log(`second session capabilities: ${JSON.stringify(messagingSession.capabilities ?? 'n/a')}`);

for (const url of writes) {
  try {
    if (url.endsWith('profile.json')) {
      await messagingSession.storage.putJson(url.replace(`pubky://${who}`, ''), { name: 'probe' });
    } else {
      await messagingSession.storage.putBytes(url.replace(`pubky://${who}`, ''), new Uint8Array([1, 2, 3, 4]));
    }
    console.log(`PUT ${url} -> OK`);
  } catch (error) {
    console.log(`PUT ${url} -> FAILED: ${error?.message ?? error}`);
  }
}
