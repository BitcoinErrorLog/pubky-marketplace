// The client's publish paths persist through Dexie; Node has no IndexedDB,
// so the shim must load before any app module.
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * LIVE end-to-end proof of the trust & reputation loop, with NOTHING mocked
 * and NOTHING simulated on any leg:
 *
 *   real transaction service (real Ed25519 attestor key)
 *     -> real order lifecycle to delivery
 *     -> real `review.create` issuing a real compact-JWS purchase attestation
 *     -> the CLIENT's own publish path writing a real attested
 *        `PubkyAppMarketplaceReview` record to the reviewer's real homeserver
 *     -> a real local Nexus watcher indexing it and VERIFYING the attestation
 *        at ingest
 *     -> real reputation aggregates + paged review reads over real HTTP
 *     -> the subject's real `PubkyAppReviewResponse` record, threaded by Nexus
 *
 * This closes the honest gap Phase 1 left open (no live two-party publication
 * proof) and proves Phase 2's indexing claims against real records rather
 * than fixtures.
 *
 * Requirements — every one a REAL process, no stubs:
 *   1. `pubky-testnet`                (homeserver 6286, admin 6288, relay 15411)
 *   2. the marketplace transaction service on MARKETPLACE_SERVICE_URL with
 *      ATTESTOR_SECRET_KEY + ATTESTOR_ORDER_SALT set (attestations only exist
 *      when the deployment carries an attestor identity)
 *   3. a local Nexus (watcher + API) on NEXUS_URL, watching that testnet
 *      (`[watcher] testnet = true`), with its Redis + Neo4j
 *
 * Run explicitly (excluded from every gate):
 *   npm run test:marketplace:reviews
 *
 * See docs/ecommerce/RUNNING.md for the exact process invocations.
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'http://127.0.0.1:8080';
const NEXUS_URL = process.env.NEXUS_URL ?? 'http://127.0.0.1:8090';
const HOMESERVER_ADMIN_URL = process.env.HOMESERVER_ADMIN_URL ?? 'http://localhost:6288';
const HOMESERVER_ADMIN_PASSWORD = process.env.HOMESERVER_ADMIN_PASSWORD ?? 'admin';
/** The local testnet homeserver's fixed identity. */
const TESTNET_HOMESERVER = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo';

// Runtime config must be set before any app module is imported: the app reads
// it at import time. The client talks to the local testnet and the local
// service; `PUBKY_RUNTIME_NEXUS_URL` points the client's Nexus reads at the
// local index this proof indexes into.
process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_NEXUS_URL = NEXUS_URL;
process.env.PUBKY_RUNTIME_TESTNET = 'true';
process.env.PUBKY_RUNTIME_HOMESERVER = TESTNET_HOMESERVER;
process.env.PUBKY_RUNTIME_HOMESERVER_URL = process.env.HOMESERVER_URL ?? 'http://localhost:6286';
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

type AppModules = {
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  MarketplaceGatewayService: typeof import('@/services/marketplace/marketplace').MarketplaceGatewayService;
  HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;
  CommerceApplication: typeof import('@/application/commerce/commerce').CommerceApplication;
  useAuthStore: typeof import('@/stores/auth/auth.store').useAuthStore;
  sdk: typeof import('@synonymdev/pubky');
};

let modules: AppModules;

async function loadModules(): Promise<AppModules> {
  const [
    { MarketplaceSessionService },
    { MarketplaceGatewayService },
    { HomeserverService },
    { CommerceApplication },
    { useAuthStore },
    sdk,
  ] = await Promise.all([
    import('@/services/marketplace/marketplace-session'),
    import('@/services/marketplace/marketplace'),
    import('@/services/homeserver/homeserver'),
    import('@/application/commerce/commerce'),
    import('@/stores/auth/auth.store'),
    import('@synonymdev/pubky'),
  ]);
  return {
    MarketplaceSessionService,
    MarketplaceGatewayService,
    HomeserverService,
    CommerceApplication,
    useAuthStore,
    sdk,
  };
}

async function preflight(url: string, what: string, hint: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok && response.status !== 404) throw new Error(`status ${response.status}`);
  } catch (error) {
    throw new Error(`${what} is not reachable at ${url}. ${hint} Cause: ${String(error)}`);
  }
}

/** Mints a real signup token from the testnet homeserver's admin endpoint. */
async function mintSignupToken(): Promise<string> {
  const response = await fetch(`${HOMESERVER_ADMIN_URL}/generate_signup_token`, {
    headers: { 'X-Admin-Password': HOMESERVER_ADMIN_PASSWORD },
  });
  if (!response.ok) throw new Error(`Could not mint a signup token (status ${response.status}).`);
  return (await response.text()).trim();
}

/**
 * One real identity: a real homeserver account (real signup token, real
 * PKARR publication) plus a real signer-approved service session — the same
 * two legs a real user has. The client's auth store holds the homeserver
 * session, so the app's own record-write path works unchanged.
 */
async function createIdentity(name: string): Promise<{ pubky: string; keypair: import('@synonymdev/pubky').Keypair }> {
  const { HomeserverService, MarketplaceSessionService, useAuthStore, sdk } = modules;
  const keypair = sdk.Keypair.random();
  const { session } = await HomeserverService.signUp({ keypair, signupToken: await mintSignupToken() });
  const pubky = keypair.publicKey.z32();

  // The app's session state, exactly as a signed-in user has it: the
  // homeserver session backs every record write below.
  useAuthStore.setState({ session, currentUserPubky: pubky });

  // The real profile record every Pubky user has: Nexus only indexes records
  // whose author exists as a user, exactly as in production.
  const { PubkySpecsBuilder } = await import('pubky-app-specs');
  const { CommerceHomeserverService } = await import('@/services/homeserver/commerce/commerce');
  const profile = new PubkySpecsBuilder(pubky).createUser(name, null, null, null, null);
  await CommerceHomeserverService.putJson(profile.meta.url, profile.user.toJson() as Record<string, unknown>);

  // The service session: a genuine Pubky auth flow where this test acts as
  // the signer (what Pubky Ring does interactively).
  const flow = MarketplaceSessionService.beginSessionFlow();
  await new sdk.Pubky().signer(keypair).approveAuthRequest(flow.authorizationUrl);
  const serviceSession = await flow.awaitSession();
  expect(serviceSession.pubky).toBe(pubky);

  return { pubky, keypair };
}

/** Re-establishes the app + service session for an identity (sessions are singletons). */
async function resumeIdentity(keypair: import('@synonymdev/pubky').Keypair): Promise<string> {
  const { HomeserverService, MarketplaceSessionService, useAuthStore, sdk } = modules;
  const pubky = keypair.publicKey.z32();
  const signedIn = await HomeserverService.signIn({ keypair });
  if (signedIn === undefined) throw new Error(`Could not sign ${pubky} back in to the testnet homeserver.`);
  useAuthStore.setState({ session: signedIn.session, currentUserPubky: pubky });
  const flow = MarketplaceSessionService.beginSessionFlow();
  await new sdk.Pubky().signer(keypair).approveAuthRequest(flow.authorizationUrl);
  await flow.awaitSession();
  return pubky;
}

function envelope(aggregateId: string, expectedRevision: number, kind: string, payload: unknown) {
  return {
    version: 1 as const,
    commandId: crypto.randomUUID(),
    aggregateId,
    expectedRevision,
    issuedAt: new Date().toISOString(),
    kind,
    payload,
  } as never;
}

/** Polls a Nexus read until the predicate holds, or fails with the last body. */
async function pollNexus<T>(path: string, accept: (body: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const response = await fetch(`${NEXUS_URL}${path}`);
    lastStatus = response.status;
    if (response.ok) {
      last = await response.json();
      if (accept(last as T)) return last as T;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(
    `Nexus never served ${what} at ${path} within ${timeoutMs}ms (last status ${lastStatus}, last body ${JSON.stringify(last)}).`,
  );
}

type NexusReview = {
  review: {
    review_id: string;
    reviewer_id: string;
    subject_id: string;
    listing_id: string;
    rating_overall: number;
    text: string;
    verified: boolean;
    attestor_id: string | null;
  };
  response: { responder_id: string; text: string } | null;
};

describe('marketplace reviews — live attested publication and Nexus indexing', () => {
  beforeAll(async () => {
    await preflight(
      `${HOMESERVER_ADMIN_URL}/`,
      'The testnet homeserver admin endpoint',
      'Start a local testnet with `pubky-testnet` (homeserver 6286, admin 6288, relay 15411).',
    );
    await preflight(
      `${SERVICE_URL}/health`,
      'The marketplace transaction service',
      'Start it with ATTESTOR_SECRET_KEY and ATTESTOR_ORDER_SALT set — without an attestor identity no attestations are issued at all.',
    );
    await preflight(
      `${NEXUS_URL}/v0/info`,
      'The local Nexus API',
      'Start `nexusd` with `[watcher] testnet = true` against the same testnet, plus its Redis and Neo4j.',
    );
    modules = await loadModules();
  }, 120_000);

  it('publishes a service-attested review that a real Nexus indexes as verified, aggregates, and threads a response under', async () => {
    const { MarketplaceGatewayService, CommerceApplication } = modules;

    // --- Real identities: real homeserver accounts + real service sessions ---
    const seller = await createIdentity('Live Proof Seller');
    const buyer = await createIdentity('Live Proof Buyer');

    // The canonical records Nexus actually indexes live on the SELLER's
    // homeserver (the service holds transaction state, not records). Written
    // with the real specs builders through the app's real homeserver
    // transport; the builder mints the canonical Crockford timestamp id that
    // the service registration and the review binding both reuse.
    await resumeIdentity(seller.keypair);
    const listingId = await publishSellerRecords(seller.pubky);
    const listingAggregateId = `listing:${seller.pubky}_${listingId}`;
    const registered = await MarketplaceGatewayService.execute(
      seller.pubky,
      envelope(listingAggregateId, 0, 'listing.register', {
        sellerPubky: seller.pubky,
        listingId,
        title: 'Live reputation proof listing',
        listingRevision: 1,
        contentHash: 'd'.repeat(64),
        quantity: 3,
        unitPrice: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
        saleFormat: 'fixed_price' as const,
      }),
    );
    expect(registered).toMatchObject({ ok: true, revision: 1 });

    // --- Real order lifecycle: checkout -> payment -> ship -> delivery ---
    const buyerPubky = await resumeIdentity(buyer.keypair);
    const listingView = await MarketplaceGatewayService.getListing(buyerPubky, listingAggregateId);
    const checkoutCommandId = crypto.randomUUID();
    const checkedOut = (await MarketplaceGatewayService.execute(buyerPubky, {
      version: 1 as const,
      commandId: checkoutCommandId,
      aggregateId: `checkout:${checkoutCommandId}`,
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'checkout.create' as const,
      payload: {
        lines: [{ listingAggregateId, expectedRevision: listingView!.serverRevision, quantity: 1 }],
        deliveryAddress: {
          name: 'Live Buyer',
          line1: '1 Attestation Way',
          line2: '',
          city: 'Lisbon',
          region: 'Lisboa',
          postalCode: '1000-001',
          countryCode: 'PT',
        },
        guaranteePolicyVersion: 1 as const,
      },
    })) as unknown as { ok: boolean; result: { orders: { id: string }[]; payments: { id: string }[] } };
    expect(checkedOut.ok).toBe(true);
    const orderId = checkedOut.result.orders[0].id;
    const paymentId = checkedOut.result.payments[0].id;

    // The payment leg uses the service's sandbox payment adapter. The CLIENT
    // deliberately refuses to send `payment.sandbox_advance` against the
    // durable service (it must never simulate money), so this one command is
    // posted directly to the service — the honest boundary of what the client
    // will do. Everything else runs through the client's own code.
    const paidResponse = await fetch(`${SERVICE_URL}/v1/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${currentBearer()}`,
      },
      body: JSON.stringify({
        version: 1,
        command_id: crypto.randomUUID(),
        aggregate_id: `payment:${paymentId}`,
        expected_revision: 1,
        issued_at: new Date().toISOString(),
        kind: 'payment.sandbox_advance',
        payload: { payment_id: paymentId, target: 'confirmed', confirmations: 1 },
      }),
    });
    expect(paidResponse.status, `payment failed: ${await paidResponse.clone().text()}`).toBe(200);

    await resumeIdentity(seller.keypair);
    const shipped = await MarketplaceGatewayService.execute(
      seller.pubky,
      envelope(`order:${orderId}`, 2, 'fulfillment.ship', {
        orderId,
        carrier: 'Sandbox Post',
        trackingNumber: 'LIVE-TRACK-1',
      }),
    );
    expect(shipped).toMatchObject({ ok: true });

    await resumeIdentity(buyer.keypair);
    const delivered = await MarketplaceGatewayService.execute(
      buyerPubky,
      envelope(`order:${orderId}`, 3, 'fulfillment.confirm_delivery', { orderId }),
    );
    expect(delivered).toMatchObject({ ok: true });

    // --- Real `review.create`: the service issues a real purchase attestation ---
    const reviewed = (await MarketplaceGatewayService.execute(
      buyerPubky,
      envelope(`order:${orderId}`, 4, 'review.create', {
        orderId,
        rating: 5,
        text: 'Live proof: shipped fast, exactly as described.',
      }),
    )) as { ok: boolean; result: Record<string, unknown> };
    expect(reviewed.ok).toBe(true);
    const attestation = reviewed.result.attestation as { jws: string; claims: { iss: string } } | undefined;
    expect(attestation?.jws, 'the service issued no attestation — is ATTESTOR_SECRET_KEY set?').toBeTypeOf('string');

    // --- The CLIENT's own publish path writes the attested record ---
    const orders = await MarketplaceGatewayService.getOrders(buyerPubky);
    const order = orders.find(({ id }) => id === orderId)!;
    const published = await CommerceApplication.commitPublishOwnReview({
      actorPubky: buyerPubky,
      order,
      result: reviewed.result,
    });
    expect(published).not.toBeNull();
    // The client verified the attestation itself, offline, before publishing.
    expect(published!.attestation_verified).toBe(true);
    expect(published!.attestation_iss).toBe(attestation!.claims.iss);
    expect(published!.sync_status).toBe('synced');
    const reviewId = published!.review_id;

    // --- Real Nexus: indexed, VERIFIED at ingest, attestor named ---
    const reviews = await pollNexus<NexusReview[]>(
      `/v0/shop/${seller.pubky}/reviews?limit=10`,
      (body) => Array.isArray(body) && body.some((entry) => entry.review.review_id === reviewId),
      'the published review',
    );
    const indexed = reviews.find((entry) => entry.review.review_id === reviewId)!;
    expect(indexed.review).toMatchObject({
      reviewer_id: buyerPubky,
      subject_id: seller.pubky,
      listing_id: listingId,
      rating_overall: 5,
      text: 'Live proof: shipped fast, exactly as described.',
      // Verified because Nexus re-ran the whole recipe at ingest: JWS parse,
      // signature against `iss`, and binding to THIS review's parties.
      verified: true,
      attestor_id: attestation!.claims.iss,
    });

    // --- Real aggregates, over real HTTP ---
    const reputation = await pollNexus<{ count: number; verified_count: number; avg: number }>(
      `/v0/shop/${seller.pubky}/reputation`,
      (body) => body.count >= 1,
      'the seller reputation aggregate',
    );
    expect(reputation).toMatchObject({ count: 1, verified_count: 1, avg: 5 });

    // Card-path parity: the same aggregate rides the listing stream
    // projection, so cards render stars with zero extra requests.
    const stream = await pollNexus<{ reputation: { count: number; verified_count: number } | null }[]>(
      `/v0/stream/listings?seller_id=${seller.pubky}&limit=10`,
      (body) => Array.isArray(body) && body.some((entry) => (entry.reputation?.count ?? 0) >= 1),
      'the stream projection carrying reputation',
    );
    expect(stream.some((entry) => entry.reputation?.verified_count === 1)).toBe(true);

    // --- The subject's real response record, threaded by Nexus (D7) ---
    await resumeIdentity(seller.keypair);
    const response = await CommerceApplication.commitPublishReviewResponse({
      actorPubky: seller.pubky,
      review: {
        reviewId,
        reviewerId: buyerPubky,
        subjectId: seller.pubky,
        listingOwnerId: seller.pubky,
        listingId,
        role: 'buyer_reviewing_seller',
        ratingOverall: 5,
        text: indexed.review.text,
        verified: true,
        attestorId: indexed.review.attestor_id,
        editedLate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        revision: 1,
        response: null,
      },
      text: 'Thanks for the live-proof order!',
    });
    expect(response.sync_status).toBe('synced');

    const withResponse = await pollNexus<NexusReview[]>(
      `/v0/shop/${seller.pubky}/reviews?limit=10`,
      (body) =>
        Array.isArray(body) && body.some((entry) => entry.review.review_id === reviewId && entry.response !== null),
      'the threaded seller response',
    );
    expect(withResponse.find((entry) => entry.review.review_id === reviewId)!.response).toMatchObject({
      responder_id: seller.pubky,
      text: 'Thanks for the live-proof order!',
    });
  }, 600_000);
});

/**
 * Publishes the seller's real shop and listing records with the real specs
 * builders, through the app's real homeserver write path. These are what the
 * Nexus watcher indexes; the reviews below bind to this listing.
 */
async function publishSellerRecords(sellerPubky: string): Promise<string> {
  const { PubkySpecsBuilder } = await import('pubky-app-specs');
  const { CommerceHomeserverService } = await import('@/services/homeserver/commerce/commerce');
  const nowIso = new Date().toISOString();
  const builder = new PubkySpecsBuilder(sellerPubky);

  const shop = builder.createShop({
    schemaVersion: 1,
    recordType: 'shop',
    ownerPubky: sellerPubky,
    revision: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    name: 'Live Reputation Proof Shop',
    bio: 'A real shop record published for the live reputation proof.',
    location: { countryCode: 'PT', region: 'Lisboa' },
    shippingPolicy: 'Ships within 3 business days.',
    returnPolicy: 'Returns accepted within 30 days.',
    vacationMode: false,
  });
  await CommerceHomeserverService.putJson(shop.meta.url, shop.shop.toJson() as Record<string, unknown>);

  const listing = builder.createListing({
    schemaVersion: 1,
    recordType: 'listing',
    ownerPubky: sellerPubky,
    revision: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    listingId: '',
    state: 'active',
    title: 'Live reputation proof listing',
    description: 'A real listing record published for the live reputation proof.',
    taxonomyVersion: 1,
    categoryId: 'fashion-shoes-boots',
    condition: 'good',
    tags: ['live-proof'],
    location: { countryCode: 'PT', region: 'Lisboa' },
    media: [
      {
        id: 'image_01',
        type: 'image',
        url: `pubky://${sellerPubky}/pub/pubky.app/marketplace/v1/media/image_01`,
        contentHash: 'd'.repeat(64),
        mimeType: 'image/jpeg',
        byteSize: 10_000,
        width: 1_200,
        height: 1_600,
        altText: 'Live proof listing image',
      },
    ],
    variants: [{ id: 'variant_01', options: {}, quantity: 3, mediaIds: ['image_01'], enabled: true }],
    sale: {
      format: 'fixed_price',
      unitPrice: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
      acceptsOffers: false,
    },
    fulfillmentMethods: ['pickup'],
    shippingOptions: [],
    returnPolicy: { acceptsReturns: false, buyerPaysReturnShipping: false },
    digitalDelivery: null,
    adultOnly: false,
  } as never);
  await CommerceHomeserverService.putJson(listing.meta.url, listing.listing.toJson() as Record<string, unknown>);
  return listing.meta.id;
}

/**
 * The bearer of the CURRENT service session, for the ONE command the client
 * refuses to send (the sandbox payment advance). The session itself came from
 * the real signer-approved auth flow — only this command's transport is direct.
 */
function currentBearer(): string {
  const session = modules.MarketplaceSessionService.getActiveSession();
  if (session === null) throw new Error('No marketplace service session is active.');
  return session.token;
}
