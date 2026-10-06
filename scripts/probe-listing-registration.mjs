// One-shot ops probe: is a given listing registered with the deployed
// transaction service? Creates a throwaway staging identity, opens a real
// marketplace session (AuthToken exchange, same wire as the app), and reads
// the listing projection exactly the way a buyer's checkout does.
//   STAGING_ADMIN_PASSWORD=... node scripts/probe-listing-registration.mjs <sellerPubky> <listingId>
import { AuthFlowKind, Keypair, Pubky, PublicKey } from '@synonymdev/pubky';

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const HOMESERVER_ADMIN = 'https://admin.homeserver.staging.pubky.app/generate_signup_token';
const ADMIN_PASSWORD = process.env.STAGING_ADMIN_PASSWORD;
const HOMESERVER_PUBKY = process.env.STAGING_HOMESERVER_PUBKY ?? '5eh8kjqfx4o7comfbtnqqxxi6oz3axeqfotpi7oiepwmoym1i16o';
// Standalone node probe script: the app's runtime-config getters don't apply here.
// eslint-disable-next-line no-restricted-syntax
const HTTP_RELAY = process.env.PUBKY_RUNTIME_DEFAULT_HTTP_RELAY ?? 'https://n.staging.pubky.app/inbox';

const [sellerPubky, listingId] = process.argv.slice(2);
if (!sellerPubky || !listingId) {
  console.error('usage: probe-listing-registration.mjs <sellerPubky> <listingId>');
  process.exit(2);
}
if (!ADMIN_PASSWORD) {
  console.error('STAGING_ADMIN_PASSWORD is required');
  process.exit(2);
}

const tokenResponse = await fetch(HOMESERVER_ADMIN, { headers: { 'X-Admin-Password': ADMIN_PASSWORD } });
if (!tokenResponse.ok) throw new Error(`signup token: HTTP ${tokenResponse.status}`);
const signupToken = (await tokenResponse.text()).trim();

const keypair = Keypair.random();
const pubky = new Pubky();
const signer = pubky.signer(keypair);
// Signup is best-effort: the staging homeserver's own PKARR record resolves
// no HTTPS endpoint for the SDK's bare-key signup URL (the app bypasses this
// via getHomeserverUrl — see HomeserverService.signUpViaHomeserverUrl), and
// this probe never touches the probe identity's homeserver anyway — the
// marketplace session AuthToken travels over the HTTP relay.
try {
  await signer.signupCookie(PublicKey.from(HOMESERVER_PUBKY), signupToken);
} catch (error) {
  console.warn(
    `signup skipped (${error?.message?.split('\n')[0] ?? error}); continuing with a homeserver-less identity`,
  );
}
console.log(`probe identity: ${keypair.publicKey.z32()}`);

// Same shape as HomeserverService.generateAuthTokenFlow + signer approval.
const flow = pubky.startCookieAuthFlow('', AuthFlowKind.signin(), HTTP_RELAY);
const approval = flow.awaitToken();
await signer.approveAuthRequest(flow.authorizationUrl);
const authToken = await approval;

const sessionResponse = await fetch(`${SERVICE_URL}/v1/auth/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: authToken.toBytes(),
});
console.log(`session exchange: HTTP ${sessionResponse.status}`);
if (!sessionResponse.ok) {
  console.error(await sessionResponse.text());
  process.exit(1);
}
const session = await sessionResponse.json();

const aggregateId = `listing:${sellerPubky}_${listingId}`;
const readProjection = async () => {
  const response = await fetch(`${SERVICE_URL}/v1/listings/${encodeURIComponent(aggregateId)}`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  return { status: response.status, body: await response.text() };
};

const first = await readProjection();
console.log(`projection read (${aggregateId}): HTTP ${first.status}`);
console.log(first.body);
if (first.status !== 404) process.exit(first.status === 200 ? 0 : 1);

// Unregistered: issue `listing.sync` as this (buyer) identity — the service
// fetches the canonical seller-signed record from the homeserver itself, so
// the actor does not need to be the seller. Snake_case wire per ADR-0019 §3
// (the app converts its camelCase contracts at the transport boundary).
const syncResponse = await fetch(`${SERVICE_URL}/v1/commands`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${session.token}`,
  },
  body: JSON.stringify({
    version: 1,
    command_id: crypto.randomUUID(),
    aggregate_id: aggregateId,
    expected_revision: 0,
    issued_at: new Date().toISOString(),
    kind: 'listing.sync',
    payload: { seller_pubky: sellerPubky, listing_id: listingId },
  }),
});
console.log(`listing.sync command: HTTP ${syncResponse.status}`);
console.log(await syncResponse.text());

const second = await readProjection();
console.log(`projection re-read (${aggregateId}): HTTP ${second.status}`);
console.log(second.body);
process.exit(second.status === 200 ? 0 : 1);
