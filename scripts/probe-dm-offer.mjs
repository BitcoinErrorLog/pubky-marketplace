// Phase 1 of the live "stranger PMs you" proof: creates a fresh staging
// identity with a profile, opens a transaction-service session, and makes a
// REAL offer on the target listing — which makes the new identity an offer
// participant the seller's inbox sync will probe, so the phase-2 encrypted
// handshake can complete. Prints the identity secret hex for phase 2.
//   STAGING_ADMIN_PASSWORD=... node scripts/probe-dm-offer.mjs <sellerPubky> <listingId>
import { AuthFlowKind, Keypair, Pubky, PublicKey } from '@synonymdev/pubky';

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const HOMESERVER_ADMIN = 'https://admin.homeserver.staging.pubky.app/generate_signup_token';
const ADMIN_PASSWORD = process.env.STAGING_ADMIN_PASSWORD;
const HOMESERVER_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const HTTP_RELAY = 'https://httprelay.staging.pubky.app/inbox';

const [sellerPubky, listingId] = process.argv.slice(2);
if (!sellerPubky || !listingId || !ADMIN_PASSWORD) {
  console.error('usage: STAGING_ADMIN_PASSWORD=... probe-dm-offer.mjs <sellerPubky> <listingId>');
  process.exit(2);
}

const tokenResponse = await fetch(HOMESERVER_ADMIN, { headers: { 'X-Admin-Password': ADMIN_PASSWORD } });
const signupToken = (await tokenResponse.text()).trim();

const keypair = Keypair.random();
const secretHex = Buffer.from(keypair.secret()).toString('hex');
const pubky = new Pubky();
const signer = pubky.signer(keypair);
await signer.signupCookie(PublicKey.from(HOMESERVER_PUBKY), signupToken);
const who = keypair.publicKey.z32();
console.log(`identity: ${who}`);
console.log(`secret_hex: ${secretHex}`);

const flow = pubky.startCookieAuthFlow('/pub/pubky.app/:rw,/pub/paykit/:rw', AuthFlowKind.signin(), HTTP_RELAY);
const approval = flow.awaitApproval();
await signer.approveAuthRequest(flow.authorizationUrl);
const session = await approval;
// Minimal VALID profile: empty-string image/links/status fail spec validation
// and make Nexus silently skip the user (observed live 2026-08-22).
await session.storage.putJson('/pub/pubky.app/profile.json', {
  name: 'Fable (test buyer)',
  bio: 'Encrypted-messaging live proof identity.',
});
console.log('profile published');

// Transaction-service session (single-use AuthToken, empty caps — identity proof).
const tokenFlow = pubky.startCookieAuthFlow('', AuthFlowKind.signin(), HTTP_RELAY);
const tokenPromise = tokenFlow.awaitToken();
await signer.approveAuthRequest(tokenFlow.authorizationUrl);
const authToken = await tokenPromise;
const sessionResponse = await fetch(`${SERVICE_URL}/v1/auth/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: authToken.toBytes(),
});
const serviceSession = await sessionResponse.json();
console.log(`service session: HTTP ${sessionResponse.status}`);

const aggregateId = `listing:${sellerPubky}_${listingId}`;
const projectionResponse = await fetch(`${SERVICE_URL}/v1/listings/${encodeURIComponent(aggregateId)}`, {
  headers: { authorization: `Bearer ${serviceSession.token}` },
});
const projection = await projectionResponse.json();
console.log(`projection: HTTP ${projectionResponse.status}, revision ${projection.server_revision}`);

const offerResponse = await fetch(`${SERVICE_URL}/v1/commands`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceSession.token}` },
  body: JSON.stringify({
    version: 1,
    command_id: crypto.randomUUID(),
    aggregate_id: aggregateId,
    expected_revision: projection.server_revision,
    issued_at: new Date().toISOString(),
    kind: 'offer.create',
    payload: {
      amount: { amount_minor: 4900, currency: 'USD', exponent: 2 },
      quantity: 1,
      expires_in_seconds: 24 * 60 * 60,
      message: 'Live-proof offer from a fresh identity — an encrypted PM follows.',
    },
  }),
});
console.log(`offer.create: HTTP ${offerResponse.status}`);
console.log((await offerResponse.text()).slice(0, 300));
