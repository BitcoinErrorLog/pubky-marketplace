// The client's core modules persist through Dexie; Node has no IndexedDB,
// so the shim must load before any app module.
import 'fake-indexeddb/auto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * LIVE STAGING PROOF for FCFS drops (ADR 0026, phase D1) — the design
 * document's proof bar, run against the fully DEPLOYED stack with nothing
 * mocked and nothing simulated on any leg the client owns:
 *
 *   real staging homeserver (public pkarr relays, single-use signup tokens)
 *     -> the seller's real shop + listing + DROP records through the real
 *        publish paths (`CommerceController.publishDrop`)
 *     -> convergent `drop.sync` registration on the DEPLOYED transaction
 *        service (Railway), which is the only clock and inventory authority
 *     -> two real buyers with real signer-approved service sessions RACING
 *        the last unit with concurrent `checkout.create` commands
 *     -> exactly one winner; the loser gets the service's pinned refusal
 *        copy VERBATIM; the drop terminally sells out
 *     -> the winner's gapless edition (1 of 1) attested as a real
 *        `pubky-drop-edition+v1` JWS, verified OFFLINE via the vendored
 *        specs, and published inside the portable receipt on the winner's
 *        own homeserver (`/priv/pubky.app/marketplace/v1/receipts/{id}`)
 *
 * The ONE deliberate exception to "everything through the client": the
 * client's transport refuses `payment.sandbox_advance` as a matter of policy
 * (simulate buttons are sandbox-only — it must never fake money), so that
 * single command is POSTed raw to `/v1/commands` with the winner's own
 * bearer session. The staging deployment runs with
 * `SANDBOX_PAYMENTS_ENABLED=true` for exactly this: staging handles no real
 * orders, and the buyer-driven sandbox payment path stands in for a real
 * payment rail there only. This mirrors the reviews live proof's honest
 * boundary (`src/test/live/reviews-index.live.ts`).
 *
 * Credentials (never committed, never defaulted):
 *   - fresh run: MARKETPLACE_STAGING_SIGNUP_TOKEN_SELLER / _BUYER_A /
 *     _BUYER_B (single-use staging signup tokens, one per identity)
 *   - re-run: MARKETPLACE_STAGING_DROP_IDENTITIES_FILE points at a JSON file
 *     OUTSIDE the repo holding `{seller, buyerA, buyerB}` secret hexes from
 *     a previous run; saved secrets are preferred so tokens are not burned.
 *     On a first successful signup the harness writes that file itself.
 *
 * Run explicitly (excluded from every gate):
 *   npm run test:marketplace:drops
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const NEXUS_URL = process.env.MARKETPLACE_NEXUS_URL ?? 'https://nexusd-production-7108.up.railway.app';
const PUBLIC_PKARR_RELAY = 'https://pkarr.pubky.app';
const STAGING_HOMESERVER_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';

// Runtime config must be set before any app module is imported (the app
// reads it at import time). Only the deployed marketplace endpoints are
// overridden; every other network value resolves to the canonical staging
// defaults (real staging homeserver, public pkarr relays, staging relay).
process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL = NEXUS_URL;
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

/** How long the drop record's stated intent gives the harness before T-0. */
const DROP_STARTS_IN_MS = 25_000;
/** Bounded patience for service-side homeserver fetches after a fresh signup
 *  (`listing.sync` / `drop.sync` need the seller's pkarr record servable). */
const REGISTRATION_DEADLINE_MS = 120_000;
/** Bounded patience for the DEPLOYED Nexus to ingest the drop record. Nexus
 *  is discovery, not the authority — exceeding this is noted, never fatal. */
const NEXUS_INGEST_DEADLINE_MS = 90_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type AppModules = {
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  MarketplaceGatewayService: typeof import('@/services/marketplace/marketplace').MarketplaceGatewayService;
  HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;
  CommerceHomeserverService: typeof import('@/services/homeserver/commerce/commerce').CommerceHomeserverService;
  CommercePrivStoreService: typeof import('@/services/homeserver/commerce/priv-store').CommercePrivStoreService;
  CommerceApplication: typeof import('@/application/commerce/commerce').CommerceApplication;
  CommerceController: typeof import('@/controllers/commerce/commerce').CommerceController;
  CommerceRecordNormalizer: typeof import('@/pipes/commerce/commerce.normalizer').CommerceRecordNormalizer;
  useAuthStore: typeof import('@/stores/auth/auth.store').useAuthStore;
  commerceConfig: typeof import('@/config/commerce');
  sdk: typeof import('@synonymdev/pubky');
  specs: typeof import('pubky-app-specs');
  CAPABILITIES: typeof import('@/config/app').CAPABILITIES;
  privEntryUrl: typeof import('@/libs/commerce/priv-envelope').privEntryUrl;
};

let modules: AppModules;

async function loadModules(): Promise<AppModules> {
  const [
    { MarketplaceSessionService },
    { MarketplaceGatewayService },
    { HomeserverService },
    { CommerceHomeserverService },
    { CommercePrivStoreService },
    { CommerceApplication },
    { CommerceController },
    { CommerceRecordNormalizer },
    { useAuthStore },
    commerceConfig,
    sdk,
    specs,
    { CAPABILITIES },
    { privEntryUrl },
  ] = await Promise.all([
    import('@/services/marketplace/marketplace-session'),
    import('@/services/marketplace/marketplace'),
    import('@/services/homeserver/homeserver'),
    import('@/services/homeserver/commerce/commerce'),
    import('@/services/homeserver/commerce/priv-store'),
    import('@/application/commerce/commerce'),
    import('@/controllers/commerce/commerce'),
    import('@/pipes/commerce/commerce.normalizer'),
    import('@/stores/auth/auth.store'),
    import('@/config/commerce'),
    import('@synonymdev/pubky'),
    import('pubky-app-specs'),
    import('@/config/app'),
    import('@/libs/commerce/priv-envelope'),
  ]);
  return {
    MarketplaceSessionService,
    MarketplaceGatewayService,
    HomeserverService,
    CommerceHomeserverService,
    CommercePrivStoreService,
    CommerceApplication,
    CommerceController,
    CommerceRecordNormalizer,
    useAuthStore,
    commerceConfig,
    sdk,
    specs,
    CAPABILITIES,
    privEntryUrl,
  };
}

// ---------------------------------------------------------------------------
// Identities: staging homeserver accounts + saved-secret persistence
// ---------------------------------------------------------------------------

type IdentityLabel = 'seller' | 'buyerA' | 'buyerB';

interface StagingIdentity {
  label: IdentityLabel;
  pubky: string;
  secretHex: string;
  keypair: import('@synonymdev/pubky').Keypair;
  /** The homeserver session, installed into the auth store when this identity acts. */
  session: import('@synonymdev/pubky').Session;
}

const TOKEN_ENV_NAMES: Record<IdentityLabel, string> = {
  seller: 'MARKETPLACE_STAGING_SIGNUP_TOKEN_SELLER',
  buyerA: 'MARKETPLACE_STAGING_SIGNUP_TOKEN_BUYER_A',
  buyerB: 'MARKETPLACE_STAGING_SIGNUP_TOKEN_BUYER_B',
};

/** Path OUTSIDE the repo where identity secrets persist across runs; supplied
 *  at run time, never written down in the repo. */
const IDENTITIES_FILE = process.env.MARKETPLACE_STAGING_DROP_IDENTITIES_FILE ?? '';

function loadSavedSecrets(): Partial<Record<IdentityLabel, string>> {
  if (!IDENTITIES_FILE || !existsSync(IDENTITIES_FILE)) return {};
  const parsed = JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8')) as Partial<Record<IdentityLabel, string>>;
  return parsed;
}

function persistSecrets(identities: StagingIdentity[]): void {
  if (!IDENTITIES_FILE) return;
  const body = Object.fromEntries(identities.map(({ label, secretHex }) => [label, secretHex]));
  writeFileSync(IDENTITIES_FILE, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  console.info(`[drops-live] identity secrets persisted for re-runs (outside the repo)`);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * One real staging identity: signs back in with a saved secret when one was
 * persisted by a previous run (tokens are single-use and must not be burned
 * on re-runs), otherwise signs up with the run-time-provided token via the
 * app's own signup path. Mirrors `marketplace-cross-account.live.browser.ts`.
 */
async function establishIdentity(label: IdentityLabel, savedSecretHex: string | undefined): Promise<StagingIdentity> {
  const { HomeserverService, sdk } = modules;
  const secret = savedSecretHex ? hexToBytes(savedSecretHex) : crypto.getRandomValues(new Uint8Array(32));
  const keypair = sdk.Keypair.fromSecret(secret);
  const pubky = keypair.publicKey.z32();
  const secretHex = bytesToHex(secret);

  if (savedSecretHex) {
    const result = await HomeserverService.signIn({ keypair });
    if (!result) throw new Error(`Sign-in for ${label} requested a retry after republish; re-run the suite.`);
    console.info(`[drops-live] ${label}: signed back in as ${pubky}`);
    return { label, pubky, secretHex, keypair, session: result.session };
  }

  const signupToken = process.env[TOKEN_ENV_NAMES[label]] ?? '';
  if (!signupToken) {
    throw new Error(
      `Missing credentials for ${label}: pass ${TOKEN_ENV_NAMES[label]} (single-use signup token) or provide ` +
        `MARKETPLACE_STAGING_DROP_IDENTITIES_FILE with a saved secret from a previous run.`,
    );
  }

  console.info(`[drops-live] ${label}: identity secret (save for re-runs): ${secretHex}`);
  const { session } = await HomeserverService.signUp({ keypair, signupToken });
  console.info(`[drops-live] ${label}: signed up as ${pubky}`);
  return { label, pubky, secretHex, keypair, session };
}

/** Puts an identity's homeserver session into the app's auth store — exactly
 *  where the real app keeps it, so every record write resolves the owned
 *  session the way production code does. */
function actAs(identity: StagingIdentity): void {
  modules.useAuthStore.setState({ session: identity.session, currentUserPubky: identity.pubky });
}

// ---------------------------------------------------------------------------
// Marketplace service sessions (real signer-approved AuthToken flows)
// ---------------------------------------------------------------------------

type ServiceSession = NonNullable<
  ReturnType<typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService.getActiveSession>
>;

/**
 * The genuine Pubky auth flow with this test acting as the signer (what
 * Pubky Ring does interactively): begin the flow, approve the authorization
 * URL with the identity's keypair, exchange the AuthToken for a bearer
 * session on the deployed service. Returns the established session object so
 * multiple identities can hold sessions side by side.
 */
async function connectServiceSession(identity: StagingIdentity): Promise<ServiceSession> {
  const { MarketplaceSessionService, HomeserverService, sdk, CAPABILITIES } = modules;
  // The Shop grant, as a Ring sign-in mints it: the service releases the
  // `/priv` data key that seals receipts only to a session covering
  // `/priv/pubky.app/` with read and write.
  const flow = HomeserverService.generateAuthTokenFlow(CAPABILITIES);
  await new sdk.Pubky().signer(identity.keypair).approveAuthRequest(flow.authorizationUrl);
  const token = await flow.awaitToken();
  const info = await MarketplaceSessionService.establishWithAuthToken(token.toBytes(), token.publicKey.z32());
  expect(info.pubky).toBe(identity.pubky);
  const session = MarketplaceSessionService.getActiveSession();
  if (session === null) throw new Error(`No active marketplace session after ${identity.label}'s auth flow.`);
  console.info(`[drops-live] ${identity.label}: marketplace service session established (expires ${info.expiresAt})`);
  return session;
}

/**
 * Makes one identity's already-established bearer session the active one.
 * In the browser this is what the per-account `localStorage` restore does
 * between tabs; Node has no `window`, so the harness re-installs the real
 * session object directly. The session itself came from the real
 * signer-approved flow above — nothing here is fabricated.
 */
function activateServiceSession(session: ServiceSession): void {
  (modules.MarketplaceSessionService as unknown as { session: ServiceSession | null }).session = session;
}

// ---------------------------------------------------------------------------
// Command + polling helpers
// ---------------------------------------------------------------------------

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

/** One-unit FCFS claim envelope — the exact shape `useMarketplaceDropClaim`
 *  submits (v1 rule: one unit of one listing per drop checkout). */
function buildDropCheckout(listingAggregateId: string, expectedRevision: number, buyerName: string) {
  // The service requires the checkout aggregate to be `checkout:{command_id}`
  // of the SAME command, so the envelope is built explicitly rather than via
  // the id-minting helper above.
  const commandId = crypto.randomUUID();
  return {
    commandId,
    command: {
      version: 1 as const,
      commandId,
      aggregateId: `checkout:${commandId}`,
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'checkout.create',
      payload: {
        lines: [{ listingAggregateId, expectedRevision, quantity: 1 }],
        deliveryAddress: {
          name: buyerName,
          line1: '1 Drop Proof Way',
          line2: '',
          city: 'Lisbon',
          region: 'Lisboa',
          postalCode: '1000-001',
          countryCode: 'PT',
        },
        guaranteePolicyVersion: 1 as const,
      },
    } as never,
  };
}

/** Retries an action until it reports success or the deadline passes. */
async function withPatience<T>(
  what: string,
  deadlineMs: number,
  retryDelayMs: number,
  attempt: () => Promise<{ done: boolean; value: T; detail?: string }>,
): Promise<T> {
  const startedAt = Date.now();
  let lastDetail = '';
  for (;;) {
    const { done, value, detail } = await attempt();
    if (done) return value;
    lastDetail = detail ?? '';
    if (Date.now() - startedAt >= deadlineMs) {
      throw new Error(`${what} did not complete within ${deadlineMs}ms (last: ${lastDetail})`);
    }
    console.info(`[drops-live] ${what}: not there yet, retrying (${lastDetail})`);
    await sleep(retryDelayMs);
  }
}

// ---------------------------------------------------------------------------
// Seller records (real specs builders through the real homeserver transport)
// ---------------------------------------------------------------------------

/**
 * Publishes the seller's real shop + listing records (the simplest valid
 * fixed-price listing the reviews proof publishes). The LISTING carries
 * quantity 2 while the DROP caps at totalQuantity 1: the drop ledger — not
 * the listing's own stock — must be what refuses the loser, so the listing
 * needs spare stock or the winner's reservation empties the listing itself
 * and the loser gets the generic listing-availability refusal instead of
 * the drop's pinned copy (observed live on the first race attempt).
 * Returns the builder-minted listing id.
 */
async function publishSellerRecords(sellerPubky: string): Promise<string> {
  const { CommerceHomeserverService, specs } = modules;
  const nowIso = new Date().toISOString();
  const builder = new specs.PubkySpecsBuilder(sellerPubky);

  // The real profile record every Pubky user has: Nexus only indexes records
  // whose author exists as a user. Idempotent PUT (re-runs overwrite).
  const profile = builder.createUser('Drops Live Proof Seller', null, null, null, null);
  await CommerceHomeserverService.putJson(profile.meta.url, profile.user.toJson() as Record<string, unknown>);

  const shop = builder.createShop({
    schemaVersion: 1,
    recordType: 'shop',
    ownerPubky: sellerPubky,
    revision: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    name: 'Drops Live Proof Shop',
    bio: 'A real shop record published for the live FCFS drop proof (ADR 0026 D1).',
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
    title: 'Drops live proof — the last unit',
    description: 'A real listing record published for the live FCFS drop proof; the drop caps it at 1.',
    taxonomyVersion: 1,
    categoryId: 'fashion-shoes-boots',
    condition: 'good',
    tags: ['drops-live-proof'],
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
        altText: 'Drops live proof listing image',
      },
    ],
    variants: [{ id: 'variant_01', options: {}, quantity: 2, mediaIds: ['image_01'], enabled: true }],
    sale: {
      format: 'fixed_price',
      unitPrice: { amountMinor: 9_900, currency: 'USD', exponent: 2 },
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

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

type CommandSuccess = {
  ok: true;
  revision: number;
  result: { orders: { id: string }[]; payments: { id: string }[] };
};
type CommandFailure = { ok: false; error: { code: string; message: string } };
type RaceResponse = CommandSuccess | CommandFailure;

describe('marketplace drops — LIVE two-buyer race on the deployed staging stack (ADR 0026 D1 proof bar)', () => {
  beforeAll(async () => {
    // Reachability, via the same reads the suite depends on.
    const relay = await fetch(`${PUBLIC_PKARR_RELAY}/${STAGING_HOMESERVER_PUBKY}`);
    if (!relay.ok) {
      throw new Error(
        `The public pkarr relay ${PUBLIC_PKARR_RELAY} did not serve the staging homeserver record ` +
          `(status ${relay.status}). This live proof needs the public staging network to be reachable.`,
      );
    }
    const health = await fetch(`${SERVICE_URL}/health`).catch((error) => {
      throw new Error(`The deployed transaction service is not reachable at ${SERVICE_URL}: ${String(error)}`);
    });
    if (!health.ok && health.status !== 404) {
      throw new Error(`The deployed transaction service answered ${health.status} at ${SERVICE_URL}/health.`);
    }
    modules = await loadModules();
  }, 120_000);

  it('publishes a 1-unit FCFS drop, races two buyers for it, and lands a verified edition 1 of 1 in the winner receipt', async () => {
    const { MarketplaceGatewayService, CommerceApplication, CommerceController, CommerceRecordNormalizer, specs } =
      modules;
    const timings: Record<string, number> = {};
    const t0 = Date.now();

    // ── Three real staging identities ─────────────────────────────────────
    const saved = loadSavedSecrets();
    const seller = await establishIdentity('seller', saved.seller);
    const buyerA = await establishIdentity('buyerA', saved.buyerA);
    const buyerB = await establishIdentity('buyerB', saved.buyerB);
    persistSecrets([seller, buyerA, buyerB]);
    timings.identitiesReadyMs = Date.now() - t0;

    // ── Seller publishes shop + the 1-unit listing, then registers it ─────
    actAs(seller);
    const listingId = await publishSellerRecords(seller.pubky);
    const listingAggregateId = `listing:${seller.pubky}_${listingId}`;
    console.info(`[drops-live] seller: published listing ${seller.pubky}:${listingId}`);

    const sellerSession = await connectServiceSession(seller);

    // Convergent registration via `listing.sync`: the DEPLOYED service
    // fetches the seller-signed record from the seller's homeserver itself.
    // A fresh signup's pkarr record propagates asynchronously, so this leg
    // gets bounded patience — it also warms the service's resolution of this
    // seller before the clock-sensitive drop registration below.
    activateServiceSession(sellerSession);
    await withPatience(
      'listing.sync registration on the deployed service',
      REGISTRATION_DEADLINE_MS,
      3_000,
      async () => {
        try {
          const response = await MarketplaceGatewayService.execute(
            seller.pubky,
            envelope(listingAggregateId, 0, 'listing.sync', { sellerPubky: seller.pubky, listingId }),
          );
          return response.ok
            ? { done: true, value: undefined }
            : { done: false, value: undefined, detail: `${(response as CommandFailure).error.code}` };
        } catch (error) {
          return { done: false, value: undefined, detail: String(error) };
        }
      },
    );
    console.info(`[drops-live] seller: listing registered with the deployed service`);
    timings.listingRegisteredMs = Date.now() - t0;

    // ── The DROP record, through the real publish path ─────────────────────
    const dropId = `drop_proof_${Date.now()}`;
    const dropAggregateId = `drop:${seller.pubky}_${dropId}`;
    const nowIso = new Date().toISOString();
    const startsAtIso = new Date(Date.now() + DROP_STARTS_IN_MS).toISOString();
    await CommerceController.publishDrop({
      schemaVersion: 1,
      recordType: 'drop',
      ownerPubky: seller.pubky,
      revision: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      dropId,
      title: 'Drops live proof — 1 of 1',
      description: 'A real FCFS drop record published for the live staging race proof (ADR 0026 D1).',
      media: [],
      format: 'fcfs',
      startsAt: startsAtIso,
      listingIds: [listingId],
      totalQuantity: 1,
      perBuyerLimit: 1,
      stockDisplay: 'exact',
    });
    console.info(`[drops-live] seller: drop record published (${dropId}, startsAt ${startsAtIso})`);

    await withPatience('drop.sync registration on the deployed service', REGISTRATION_DEADLINE_MS, 2_000, async () => {
      try {
        const response = await CommerceController.syncDropRegistration(seller.pubky, dropId);
        return response.ok
          ? { done: true, value: undefined }
          : { done: false, value: undefined, detail: `${(response as CommandFailure).error.code}` };
      } catch (error) {
        return { done: false, value: undefined, detail: String(error) };
      }
    });
    timings.dropRegisteredMs = Date.now() - t0;

    // ── The PUBLIC projection answers `announced`, remaining 1, serverTime ─
    const announced = await CommerceController.getPublicDrop(seller.pubky, dropId);
    expect(announced, 'the public drop projection must exist after drop.sync').not.toBeNull();
    expect(announced!.state).toBe('announced');
    expect(announced!.remaining).toBe(1);
    expect(announced!.totalQuantity).toBe(1);
    expect(announced!.perBuyerLimit).toBe(1);
    expect(announced!.serverTime).toBeTypeOf('string');
    const serverTimeOffsetMs = Date.parse(announced!.serverTime) - Date.now();
    console.info(
      `[drops-live] public projection: announced, remaining 1, serverTime ${announced!.serverTime} ` +
        `(offset ${serverTimeOffsetMs}ms vs local)`,
    );

    // ── The dedicated Nexus per-drop projection (discovery, never fatal) ───
    let nexusOutcome = '';
    try {
      await withPatience(
        `Nexus drop ingest at /v0/drop/${seller.pubky}/${dropId}`,
        NEXUS_INGEST_DEADLINE_MS,
        3_000,
        async () => {
          const response = await fetch(`${NEXUS_URL}/v0/drop/${seller.pubky}/${dropId}`);
          if (!response.ok) return { done: false, value: undefined, detail: `status ${response.status}` };
          const body = (await response.json()) as Record<string, unknown>;
          return { done: true, value: body };
        },
      );
      nexusOutcome = 'indexed (per-drop projection served)';
      console.info('[drops-live] Nexus: drop record indexed and served');
    } catch (error) {
      // Nexus is discovery, not the authority — the race proof continues.
      nexusOutcome = `NOT ingested within ${NEXUS_INGEST_DEADLINE_MS}ms — noted, not fatal (${String(error).slice(0, 200)})`;
      console.warn(`[drops-live] Nexus: ${nexusOutcome}`);
    }
    timings.nexusCheckedMs = Date.now() - t0;

    // ── Both buyers connect real service sessions and stage their reads ────
    const sessionA = await connectServiceSession(buyerA);
    const sessionB = await connectServiceSession(buyerB);

    activateServiceSession(sessionA);
    const listingViewA = await MarketplaceGatewayService.getListing(buyerA.pubky, listingAggregateId);
    expect(listingViewA).not.toBeNull();
    activateServiceSession(sessionB);
    const listingViewB = await MarketplaceGatewayService.getListing(buyerB.pubky, listingAggregateId);
    expect(listingViewB).not.toBeNull();

    // ── Wait for the SERVICE clock to pass startsAt, then confirm `live` ───
    const startsAtMs = Date.parse(startsAtIso);
    const localWakeMs = startsAtMs - serverTimeOffsetMs + 1_000;
    if (localWakeMs > Date.now()) {
      console.info(`[drops-live] waiting ${localWakeMs - Date.now()}ms for the service clock to pass startsAt`);
      await sleep(localWakeMs - Date.now());
    }
    const live = await withPatience('the service reporting the drop live', 60_000, 1_000, async () => {
      const projection = await CommerceController.getPublicDrop(seller.pubky, dropId);
      return projection?.state === 'live'
        ? { done: true, value: projection }
        : { done: false, value: projection!, detail: `state ${projection?.state}` };
    });
    expect(live.state).toBe('live');
    expect(live.remaining).toBe(1);
    console.info(`[drops-live] the drop is LIVE on the service clock (${live.serverTime})`);
    timings.liveMs = Date.now() - t0;

    // ── THE RACE: two concurrent checkout.create for the last unit ─────────
    // Each buyer's command goes through the real client transport with a
    // fresh expected_revision from that buyer's own listing read. The bearer
    // token is captured synchronously when execute() is invoked, so swapping
    // the active session between the two invocations leaves BOTH requests
    // genuinely in flight concurrently — two buyers, two sessions, one unit.
    const checkoutA = buildDropCheckout(listingAggregateId, listingViewA!.serverRevision, 'Drops Buyer A');
    const checkoutB = buildDropCheckout(listingAggregateId, listingViewB!.serverRevision, 'Drops Buyer B');
    const raceStartedAt = Date.now();
    activateServiceSession(sessionA);
    const inFlightA = MarketplaceGatewayService.execute(buyerA.pubky, checkoutA.command);
    activateServiceSession(sessionB);
    const inFlightB = MarketplaceGatewayService.execute(buyerB.pubky, checkoutB.command);
    const [responseA, responseB] = (await Promise.all([inFlightA, inFlightB])) as [RaceResponse, RaceResponse];
    timings.raceDurationMs = Date.now() - raceStartedAt;

    const outcomes = [
      { buyer: buyerA, session: sessionA, commandId: checkoutA.commandId, response: responseA },
      { buyer: buyerB, session: sessionB, commandId: checkoutB.commandId, response: responseB },
    ];
    for (const { buyer, commandId, response } of outcomes) {
      console.info(
        `[drops-live] RACE response for ${buyer.label} (command ${commandId}): ` +
          (response.ok
            ? `ok, revision ${response.revision}`
            : `refused [${response.error.code}] "${response.error.message}"`),
      );
    }
    const winners = outcomes.filter(({ response }) => response.ok);
    const losers = outcomes.filter(({ response }) => !response.ok);
    expect(winners, 'exactly one buyer must win the last unit').toHaveLength(1);
    expect(losers, 'exactly one buyer must be refused').toHaveLength(1);
    const winner = winners[0];
    const loser = losers[0];

    // The loser's refusal is the service's PINNED copy, verbatim — sold out
    // when it lost the inventory race, ended if it arrived after the
    // sell-out transition. One documented intermediate outcome exists: when
    // the loser's command lands AFTER the winner's commit bumped the listing
    // revision, the service answers REVISION_CONFLICT first — and the client
    // contract for that (RUNNING.md, `useMarketplaceDropClaim`) is
    // refetch-and-retry, which then lands on the pinned drop refusal. The
    // harness mirrors that exact contract; the winner's slot is already
    // taken, so the retry MUST also be refused.
    let loserError = (loser.response as CommandFailure).error;
    let loserSawRevisionConflict = false;
    if (loserError.code === 'REVISION_CONFLICT') {
      loserSawRevisionConflict = true;
      console.info(
        `[drops-live] loser hit REVISION_CONFLICT ("${loserError.message}") — ` +
          'running the client contract: refetch the projection, retry once',
      );
      activateServiceSession(loser.session);
      const freshView = await MarketplaceGatewayService.getListing(loser.buyer.pubky, listingAggregateId);
      const conflictRetry = buildDropCheckout(listingAggregateId, freshView!.serverRevision, 'Drops Loser Refetch');
      const conflictRetryResponse = (await MarketplaceGatewayService.execute(
        loser.buyer.pubky,
        conflictRetry.command,
      )) as RaceResponse;
      expect(conflictRetryResponse.ok, 'the refetch-retry must not win a consumed drop slot').toBe(false);
      loserError = (conflictRetryResponse as CommandFailure).error;
    }
    expect(['The drop is sold out.', 'The drop has ended.']).toContain(loserError.message);
    console.info(
      `[drops-live] RACE: winner ${winner.buyer.label} (command ${winner.commandId}); ` +
        `loser ${loser.buyer.label} (command ${loser.commandId}) refused with ` +
        `[${loserError.code}] "${loserError.message}"`,
    );

    const winnerResult = (winner.response as CommandSuccess).result;
    const orderId = winnerResult.orders[0].id;
    const paymentId = winnerResult.payments[0].id;

    // ── The winner "pays": payment.sandbox_advance, raw POST by design ─────
    // The client transport deliberately refuses this kind against the
    // durable service (it must never simulate money), so the harness stands
    // in for a real payment with ONE raw authenticated command — the exact
    // reason the staging deployment runs SANDBOX_PAYMENTS_ENABLED=true.
    activateServiceSession(winner.session);
    const payment = await MarketplaceGatewayService.getPayment(winner.buyer.pubky, paymentId);
    expect(payment).not.toBeNull();
    expect(payment!.state).toBe('awaiting_entitlement');
    const paidResponse = await fetch(`${SERVICE_URL}/v1/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${winner.session.token}`,
      },
      body: JSON.stringify({
        version: 1,
        command_id: crypto.randomUUID(),
        aggregate_id: `payment:${paymentId}`,
        expected_revision: payment!.revision,
        issued_at: new Date().toISOString(),
        kind: 'payment.sandbox_advance',
        payload: { payment_id: paymentId, target: 'confirmed', confirmations: 1 },
      }),
    });
    expect(paidResponse.status, `sandbox payment advance failed: ${await paidResponse.clone().text()}`).toBe(200);
    console.info(`[drops-live] winner: payment ${paymentId} advanced awaiting_entitlement -> confirmed`);

    // ── The winner's order is paid with the gapless edition 1 ──────────────
    const paidOrder = await withPatience('the winner order reaching paid with edition 1', 60_000, 1_500, async () => {
      const orders = await MarketplaceGatewayService.getOrders(winner.buyer.pubky);
      const order = orders.find(({ id }) => id === orderId);
      return order?.state === 'paid' && order.edition === 1 && typeof order.receiptId === 'string'
        ? { done: true, value: order }
        : { done: false, value: order!, detail: `state ${order?.state}, edition ${order?.edition}` };
    });
    expect(paidOrder.edition).toBe(1);
    expect(paidOrder.dropAggregateId).toBe(dropAggregateId);
    const receiptId = paidOrder.receiptId as string;
    console.info(`[drops-live] winner: order ${orderId} is paid, edition 1, receipt ${receiptId}`);

    // ── The drop is TERMINALLY sold out ────────────────────────────────────
    const soldOut = await withPatience('the public projection reaching ended_sold_out', 60_000, 1_500, async () => {
      const projection = await CommerceController.getPublicDrop(seller.pubky, dropId);
      return projection?.state === 'ended_sold_out'
        ? { done: true, value: projection }
        : { done: false, value: projection!, detail: `state ${projection?.state}` };
    });
    expect(soldOut.state).toBe('ended_sold_out');
    expect(soldOut.remaining).toBe(0);
    console.info('[drops-live] public projection: ended_sold_out, remaining 0');

    // A retry by the LOSER is refused with the pinned ended copy.
    activateServiceSession(loser.session);
    const loserListingView = await MarketplaceGatewayService.getListing(loser.buyer.pubky, listingAggregateId);
    const retry = buildDropCheckout(listingAggregateId, loserListingView!.serverRevision, 'Drops Loser Retry');
    const retryResponse = (await MarketplaceGatewayService.execute(loser.buyer.pubky, retry.command)) as RaceResponse;
    expect(retryResponse.ok).toBe(false);
    expect((retryResponse as CommandFailure).error.message).toBe('The drop has ended.');
    console.info(
      `[drops-live] loser retry refused verbatim: [${(retryResponse as CommandFailure).error.code}] ` +
        `"${(retryResponse as CommandFailure).error.message}"`,
    );
    timings.terminalStateMs = Date.now() - t0;

    // ── The portable receipt: attested, verified OFFLINE, on the winner's
    //    own homeserver ──────────────────────────────────────────────────────
    activateServiceSession(winner.session);
    const receiptAttestation = await MarketplaceGatewayService.getReceiptAttestation(winner.buyer.pubky, receiptId);
    expect(receiptAttestation, 'the service issued no receipt attestation — attestor key missing?').not.toBeNull();
    const editionAttestation = await MarketplaceGatewayService.getEditionAttestation(winner.buyer.pubky, receiptId);
    expect(editionAttestation, 'the service issued no edition attestation for a drop order').not.toBeNull();
    expect(editionAttestation!.claims).toMatchObject({ drop: dropId, edition: 1, of: 1 });

    // The client's REAL publisher: verifies both attestations offline before
    // the PUT, writes to /priv on the winner's own homeserver.
    actAs(winner.buyer);
    await CommerceApplication.publishOrderReceipts(winner.buyer.pubky, [paidOrder]);

    // Re-read the sealed record from the winner's homeserver, decrypt it with
    // the released data key, and re-run the whole offline verification recipe
    // through the vendored specs — the "credible exit" claim, checked against
    // the wire, not the local copy. The plaintext v1 path stays empty.
    const keys = await MarketplaceGatewayService.getPrivKeys(winner.buyer.pubky);
    if (keys.kind !== 'keys') throw new Error(`The service did not release the winner's data key: ${keys.kind}`);
    const receiptUrl = modules.privEntryUrl(keys.keyring, 'order_receipt', receiptId);
    const rawEnvelope = JSON.stringify(await modules.CommerceHomeserverService.fetchJson(receiptUrl));
    expect(rawEnvelope).not.toContain(receiptId);
    expect(rawEnvelope).not.toContain(orderId);
    await expect(
      modules.CommerceHomeserverService.fetchJson(
        CommerceRecordNormalizer.orderReceiptUri(winner.buyer.pubky, receiptId),
      ),
    ).rejects.toMatchObject({ context: { statusCode: 404 } });
    const rawReceipt = await modules.CommercePrivStoreService.read(keys.keyring, 'order_receipt', receiptId);
    const receiptRecord = CommerceRecordNormalizer.orderReceiptRecord(rawReceipt);
    expect(receiptRecord.drop).toEqual({ dropId, edition: 1, of: 1 });
    expect(receiptRecord.orderId).toBe(orderId);
    const receiptClaims = specs.verifyOrderReceiptAttestation({ ...receiptRecord }) as { iss: string };
    expect(receiptClaims.iss).toBe(receiptAttestation!.claims.iss);
    const editionClaims = specs.verifyDropEditionAttestation({ ...receiptRecord }) as {
      iss: string;
      drop: string;
      edition: number;
      of: number;
    };
    expect(editionClaims).toMatchObject({ drop: dropId, edition: 1, of: 1 });
    expect(editionClaims.iss).toBe(editionAttestation!.claims.iss);
    console.info(`[drops-live] winner: portable receipt live at ${receiptUrl}, both attestations verified offline`);
    timings.totalMs = Date.now() - t0;

    // ── Proof summary ───────────────────────────────────────────────────────
    console.info(
      [
        '',
        '================= DROPS LIVE PROOF SUMMARY (ADR 0026 D1) =================',
        `drop:              ${dropId} (aggregate ${dropAggregateId})`,
        `seller:            ${seller.pubky}`,
        `race winner:       ${winner.buyer.label} (${winner.buyer.pubky}) command ${winner.commandId}`,
        `race loser:        ${loser.buyer.label} (${loser.buyer.pubky}) command ${loser.commandId}`,
        `loser refusal:     [${loserError.code}] "${loserError.message}"` +
          (loserSawRevisionConflict ? ' (after an initial REVISION_CONFLICT and the contract refetch-retry)' : ''),
        `loser retry:       [${(retryResponse as CommandFailure).error.code}] "${(retryResponse as CommandFailure).error.message}"`,
        `terminal state:    ended_sold_out, remaining 0`,
        `edition:           ${editionClaims.edition} of ${editionClaims.of} (attested by ${editionClaims.iss})`,
        `winner order:      ${orderId} (paid), receipt ${receiptId}`,
        `portable receipt:  ${receiptUrl}`,
        `nexus (/v0/drop):  ${nexusOutcome}`,
        `timings (ms):      identities ${timings.identitiesReadyMs}, listing registered ${timings.listingRegisteredMs}, ` +
          `drop registered ${timings.dropRegisteredMs}, live ${timings.liveMs}, race ${timings.raceDurationMs}, ` +
          `terminal ${timings.terminalStateMs}, total ${timings.totalMs}`,
        '===========================================================================',
      ].join('\n'),
    );
  }, 900_000);
});
