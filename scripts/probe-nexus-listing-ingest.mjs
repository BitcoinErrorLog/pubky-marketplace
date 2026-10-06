// Ops probe: publish a fresh minimal listing record from a throwaway staging
// identity, then poll the deployed Nexus for it. Isolates whether the Nexus
// watcher indexes marketplace listing PUTs at all.
import { AuthFlowKind, Keypair, Pubky, PublicKey } from '@synonymdev/pubky';

const HOMESERVER_ADMIN = 'https://admin.homeserver.staging.pubky.app/generate_signup_token';
const ADMIN_PASSWORD = process.env.STAGING_ADMIN_PASSWORD;
const HOMESERVER_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const HTTP_RELAY = 'https://httprelay.staging.pubky.app/inbox';
const NEXUS = 'https://nexusd-production-7108.up.railway.app';
const SOURCE_SELLER = 'fado4r5k3hwfqe6qjunreykp9gad3kfwdc7epd7y8nztgis5gmhy';
const SOURCE_LISTING = 'a7fc7d5d0b2a4083b27847193f8fe536';

const tokenResponse = await fetch(HOMESERVER_ADMIN, { headers: { 'X-Admin-Password': ADMIN_PASSWORD } });
const signupToken = (await tokenResponse.text()).trim();

const keypair = Keypair.random();
const pubky = new Pubky();
const signer = pubky.signer(keypair);
await signer.signupCookie(PublicKey.from(HOMESERVER_PUBKY), signupToken);
const who = keypair.publicKey.z32();
console.log(`identity: ${who}`);

const flow = pubky.startCookieAuthFlow('/pub/pubky.app/:rw', AuthFlowKind.signin(), HTTP_RELAY);
const approval = flow.awaitApproval();
await signer.approveAuthRequest(flow.authorizationUrl);
const session = await approval;

// Profile first so the listing's seller dependency exists.
await session.storage.putJson('/pub/pubky.app/profile.json', {
  name: 'Nexus ingest probe',
  bio: '',
  image: '',
  links: [],
  status: '',
});

// Clone the known-good canonical record, re-owned.
const source = await fetch(
  `https://homeserver.staging.pubky.app/pub/pubky.app/marketplace/v1/listings/${SOURCE_LISTING}`,
  {
    headers: { 'pubky-host': SOURCE_SELLER },
  },
);
const record = await source.json();
const newId = crypto.randomUUID().replaceAll('-', '');
record.listingId = newId;
record.ownerPubky = who;
record.title = 'Nexus ingest probe listing';
record.media = [];
record.createdAt = new Date().toISOString();
record.updatedAt = record.createdAt;

await session.storage.putJson(`/pub/pubky.app/marketplace/v1/listings/${newId}`, record);
console.log(`published listing ${who}/${newId}`);

for (let attempt = 0; attempt < 12; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const response = await fetch(`${NEXUS}/v0/listing/${who}/${newId}`);
  console.log(`poll ${attempt + 1}: HTTP ${response.status}`);
  if (response.ok) {
    console.log((await response.text()).slice(0, 200));
    process.exit(0);
  }
}
console.log('NOT indexed after 2 minutes');
process.exit(1);
