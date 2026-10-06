// @vitest-environment node
import 'fake-indexeddb/auto';
import { createHmac, hkdfSync } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PRIV_KEYS_WIRE_NEEDS_REAUTH, PRIV_KEYS_WIRE_OK } from '@/test/fixtures/commerce/priv-keys.wire';
import { installWebLocks, removeWebLocks } from '@/test-utils/web-locks';

/**
 * LIVE STAGING PROOF for encrypted `/priv` (priv-encryption-plan.md Phase 2
 * and 3): the watchlist, order receipts and badge checkpoints on the real
 * staging homeserver, keyed by the data key the DEPLOYED staging
 * marketplace service releases from `GET /v1/me/priv-keys`.
 *
 * One buyer identity holds plaintext v1 records the way a pre-encryption
 * Shop left them: a watchlist, a portable receipt for a real sandbox-paid
 * order (attested by the staging attestor), and badge checkpoints. Then:
 *
 *   1. No key: a marketplace session minted without the `/priv` grant is
 *      refused the key, so watchlist sync and receipt publication report
 *      `needs_marketplace_approval` (the recovery-key export `needs_reauth`);
 *      nothing is written and the plaintext stays.
 *   1b. Homeserver refusal: a homeserver session whose grant cannot write
 *      `/priv/pubky.app/` reports `needs_reauth` without requesting a key,
 *      even beside a purchase session that would get one.
 *   2. Full grant: a session minted from the Shop-grant AuthToken gets the
 *      key; without Web Locks the watchlist sync refuses to run; every plaintext record is sealed, read back, and only then
 *      deleted, in that order on the wire; a second paid order's receipt is
 *      written sealed from its attestation; the released keys match the
 *      pinned wire fixture's shape; the exported recovery key alone opens
 *      every entry, receipts found only by listing their family, with an
 *      independent node:crypto implementation of the documented recipe.
 *   3. Fresh device: an empty IndexedDB and a new session get the same key
 *      and read everything back.
 *   4. Undecryptable: tampered sealed entries are never overwritten and the
 *      plaintext an older build re-creates is kept. A sealed receipt that
 *      opens but is not a valid receipt is neither published nor
 *      overwritten, and its plaintext is kept.
 *   4b. Privacy boundary: another identity's session is refused reading the
 *      sealed watchlist and listing the owner's `/priv` tree.
 *   5. Cleanup: every `/priv` and public record the proof wrote is deleted,
 *      the listing is re-synced to its removed state, and every marketplace
 *      session the proof minted is revoked.
 *
 * Node environment with the real global fetch. Run explicitly (excluded from
 * every gate); it consumes two single-use staging signup tokens, or saved
 * secrets from a previous run:
 *
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_SELLER=XXXX-XXXX-XXXX \
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_BUYER=YYYY-YYYY-YYYY \
 *   MARKETPLACE_STAGING_PRIV_IDENTITIES_FILE=/path/outside/the/repo.json \
 *   npm run test:marketplace:priv
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const PUBLIC_PKARR_RELAY = 'https://pkarr.pubky.app';
const STAGING_HOMESERVER_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const REGISTRATION_DEADLINE_MS = 120_000;

process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function loadModules() {
  const [
    { MarketplaceSessionService },
    { MarketplaceGatewayService },
    { HomeserverService },
    { CommerceHomeserverService },
    { CommercePrivStoreService },
    { CommerceApplication },
    { CommerceAttentionSeenApplication },
    { CommercePrivKeyringApplication },
    { CommerceController },
    { CommerceRecordNormalizer },
    { LocalCommerceService },
    { useAuthStore },
    { useCommerceStore },
    { db },
    { CAPABILITIES },
    envelopeLib,
    sdk,
    specs,
  ] = await Promise.all([
    import('@/services/marketplace/marketplace-session'),
    import('@/services/marketplace/marketplace'),
    import('@/services/homeserver/homeserver'),
    import('@/services/homeserver/commerce/commerce'),
    import('@/services/homeserver/commerce/priv-store'),
    import('@/application/commerce/commerce'),
    import('@/application/commerce/attention-seen'),
    import('@/application/commerce/priv-keyring'),
    import('@/controllers/commerce/commerce'),
    import('@/pipes/commerce/commerce.normalizer'),
    import('@/services/local/commerce/commerce'),
    import('@/stores/auth/auth.store'),
    import('@/stores/commerce/commerce.store'),
    import('@/database/franky/franky'),
    import('@/config/app'),
    import('@/libs/commerce/priv-envelope'),
    import('@synonymdev/pubky'),
    import('pubky-app-specs'),
  ]);
  return {
    MarketplaceSessionService,
    MarketplaceGatewayService,
    HomeserverService,
    CommerceHomeserverService,
    CommercePrivStoreService,
    CommerceApplication,
    CommerceAttentionSeenApplication,
    CommercePrivKeyringApplication,
    CommerceController,
    CommerceRecordNormalizer,
    LocalCommerceService,
    useAuthStore,
    useCommerceStore,
    db,
    CAPABILITIES,
    envelopeLib,
    sdk,
    specs,
  };
}

let m: Awaited<ReturnType<typeof loadModules>>;

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

type Label = 'seller' | 'buyer';
type Identity = {
  label: Label;
  pubky: string;
  secretHex: string;
  keypair: import('@synonymdev/pubky').Keypair;
  session: import('@synonymdev/pubky').Session;
};

const IDENTITIES_FILE = process.env.MARKETPLACE_STAGING_PRIV_IDENTITIES_FILE ?? '';
const TOKEN_ENV: Record<Label, string> = {
  seller: 'MARKETPLACE_STAGING_SIGNUP_TOKEN_SELLER',
  buyer: 'MARKETPLACE_STAGING_SIGNUP_TOKEN_BUYER',
};

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const prefix = (pubky: string) => pubky.slice(0, 8);

async function establishIdentity(label: Label, saved: string | undefined): Promise<Identity> {
  const secret = saved ? unhex(saved) : crypto.getRandomValues(new Uint8Array(32));
  const keypair = m.sdk.Keypair.fromSecret(secret);
  const pubky = keypair.publicKey.z32();
  if (saved) {
    const result = await m.HomeserverService.signIn({ keypair });
    if (!result) throw new Error(`${label}: sign-in asked for a retry after republish; re-run.`);
    console.info(`[priv-live] ${label} ${prefix(pubky)}: signed back in`);
    return { label, pubky, secretHex: hex(secret), keypair, session: result.session };
  }
  const token = process.env[TOKEN_ENV[label]] ?? '';
  if (!token) throw new Error(`Missing ${TOKEN_ENV[label]} or a saved secret in ${IDENTITIES_FILE || '(no file)'}.`);
  const { session } = await m.HomeserverService.signUp({ keypair, signupToken: token });
  console.info(`[priv-live] ${label} ${prefix(pubky)}: signed up`);
  return { label, pubky, secretHex: hex(secret), keypair, session };
}

type SavedState = Partial<Record<Label, string>> & { listingIds?: string[] };

function readSaved(): SavedState {
  return IDENTITIES_FILE && existsSync(IDENTITIES_FILE) ? JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8')) : {};
}

/** Secrets and every listing id the proof created, so a rerun can end and delete them. */
function persist(identities: Identity[], listingIds: string[]): void {
  if (!IDENTITIES_FILE) return;
  const body = { ...Object.fromEntries(identities.map(({ label, secretHex }) => [label, secretHex])), listingIds };
  writeFileSync(IDENTITIES_FILE, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created; an existing file keeps its permissions.
  chmodSync(IDENTITIES_FILE, 0o600);
}

function actAs(identity: Identity): void {
  m.useAuthStore.setState({ session: identity.session, currentUserPubky: identity.pubky });
}

// ---------------------------------------------------------------------------
// Marketplace sessions
// ---------------------------------------------------------------------------

type ServiceSession = NonNullable<ReturnType<typeof m.MarketplaceSessionService.getActiveSession>>;
const mintedSessions: ServiceSession[] = [];

/** The signer-approved AuthToken flow, as Ring runs it, with the given grant. */
async function connect(identity: Identity, capabilities: string): Promise<ServiceSession> {
  m.CommerceController.clearMarketplaceSession();
  type Grant = NonNullable<Parameters<typeof m.HomeserverService.generateAuthTokenFlow>[0]>;
  const flow = m.HomeserverService.generateAuthTokenFlow(capabilities as Grant);
  await new m.sdk.Pubky().signer(identity.keypair).approveAuthRequest(flow.authorizationUrl);
  const token = await flow.awaitToken();
  const info = await m.MarketplaceSessionService.establishWithAuthToken(token.toBytes(), token.publicKey.z32());
  expect(info.pubky).toBe(identity.pubky);
  const session = m.MarketplaceSessionService.getActiveSession();
  if (!session) throw new Error('no marketplace session after the auth flow');
  mintedSessions.push(session);
  console.info(`[priv-live] ${identity.label}: marketplace session, grant "${info.capabilities}"`);
  return session;
}

function activate(session: ServiceSession): void {
  (m.MarketplaceSessionService as unknown as { session: ServiceSession | null }).session = session;
}

async function withPatience<T>(
  what: string,
  deadlineMs: number,
  attempt: () => Promise<{ done: boolean; value: T; detail?: string }>,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const { done, value, detail } = await attempt();
    if (done) return value;
    if (Date.now() - started > deadlineMs) throw new Error(`${what} timed out (last: ${detail ?? ''})`);
    await sleep(2_000);
  }
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

// ---------------------------------------------------------------------------
// Wire log: every homeserver request, in order, from this process
// ---------------------------------------------------------------------------

const wire: string[] = [];

function installWireLog(): void {
  const original = m.HomeserverService.request.bind(m.HomeserverService);
  vi.spyOn(m.HomeserverService, 'request').mockImplementation(async (params) => {
    wire.push(`${params.method} ${params.url}`);
    return await original(params);
  });
}

const writesSince = (mark: number) =>
  wire.slice(mark).filter((entry) => entry.startsWith('PUT ') || entry.startsWith('DELETE '));

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function listingBody(sellerPubky: string, nowIso: string): { record: never } {
  return {
    record: {
      schemaVersion: 1,
      recordType: 'listing',
      ownerPubky: sellerPubky,
      revision: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      listingId: '',
      state: 'active',
      title: 'Priv encryption live proof — do not buy',
      description: 'A staging listing for the encrypted /priv live proof. Deleted when the proof ends.',
      taxonomyVersion: 1,
      categoryId: 'fashion-shoes-boots',
      condition: 'good',
      tags: ['priv-live-proof'],
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
          altText: 'Priv live proof listing image',
        },
      ],
      variants: [{ id: 'variant_01', options: {}, quantity: 3, mediaIds: ['image_01'], enabled: true }],
      sale: {
        format: 'fixed_price',
        unitPrice: { amountMinor: 1_000, currency: 'USD', exponent: 2 },
        acceptsOffers: false,
      },
      fulfillmentMethods: ['physical'],
      package: { weightGrams: 800, lengthMillimeters: 320, widthMillimeters: 220, heightMillimeters: 120 },
      shippingOptions: [
        {
          id: 'ship_01',
          pricing: 'flat',
          label: 'Standard shipping',
          price: { amountMinor: 100, currency: 'USD', exponent: 2 },
          estimatedMinDays: 3,
          estimatedMaxDays: 7,
        },
      ],
      returnPolicy: { acceptsReturns: false, buyerPaysReturnShipping: false },
      digitalDelivery: null,
      adultOnly: false,
    } as never,
  };
}

async function publishSellerRecords(sellerPubky: string): Promise<{ listingId: string }> {
  const nowIso = new Date().toISOString();
  const builder = new m.specs.PubkySpecsBuilder(sellerPubky);
  const shop = builder.createShop({
    schemaVersion: 1,
    recordType: 'shop',
    ownerPubky: sellerPubky,
    revision: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    name: 'Priv Encryption Live Proof',
    bio: 'A staging shop for the encrypted /priv live proof. Deleted when the proof ends.',
    location: { countryCode: 'PT', region: 'Lisboa' },
    shippingPolicy: 'Not for sale.',
    returnPolicy: 'Not for sale.',
    vacationMode: false,
  });
  await m.CommerceHomeserverService.putJson(shop.meta.url, shop.shop.toJson() as Record<string, unknown>);
  const listing = builder.createListing(listingBody(sellerPubky, nowIso).record);
  await m.CommerceHomeserverService.putJson(listing.meta.url, listing.listing.toJson() as Record<string, unknown>);
  return { listingId: listing.meta.id as string };
}

async function paidOrder(buyer: Identity, listingAggregateId: string) {
  const view = await m.MarketplaceGatewayService.getListing(buyer.pubky, listingAggregateId);
  const commandId = crypto.randomUUID();
  const checkout = (await m.MarketplaceGatewayService.execute(buyer.pubky, {
    version: 1 as const,
    commandId,
    aggregateId: `checkout:${commandId}`,
    expectedRevision: 0,
    issuedAt: new Date().toISOString(),
    kind: 'checkout.create' as const,
    payload: {
      lines: [{ listingAggregateId, expectedRevision: view!.serverRevision, quantity: 1 }],
      deliveryAddress: {
        name: 'Priv Live Buyer',
        line1: '1 Ciphertext Way',
        line2: '',
        city: 'Lisbon',
        region: 'Lisboa',
        postalCode: '1000-001',
        countryCode: 'PT',
      },
      guaranteePolicyVersion: 1 as const,
    },
  } as never)) as unknown as { ok: boolean; result: { orders: { id: string }[]; payments: { id: string }[] } };
  expect(checkout.ok, JSON.stringify(checkout)).toBe(true);
  const orderId = checkout.result.orders[0].id;
  const paymentId = checkout.result.payments[0].id;
  const payment = await m.MarketplaceGatewayService.getPayment(buyer.pubky, paymentId);
  const bearer = m.MarketplaceSessionService.getActiveSession()!.token;
  // The client refuses to simulate money against the durable service, so the
  // one sandbox payment command is posted directly (staging runs
  // SANDBOX_PAYMENTS_ENABLED=true for exactly this).
  const paid = await fetch(`${SERVICE_URL}/v1/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
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
  expect(paid.status, await paid.clone().text()).toBe(200);
  return await withPatience('order paid with a receipt id', 60_000, async () => {
    const order = (await m.MarketplaceGatewayService.getOrders(buyer.pubky)).find(({ id }) => id === orderId);
    return order?.state === 'paid' && typeof order.receiptId === 'string'
      ? { done: true, value: order }
      : { done: false, value: order!, detail: String(order?.state) };
  });
}

/** The plaintext v1 receipt the pre-encryption Shop wrote, from the real attestation. */
async function legacyReceiptRecord(ownerPubky: string, receiptId: string): Promise<Record<string, unknown>> {
  const attestation = await m.MarketplaceGatewayService.getReceiptAttestation(ownerPubky, receiptId);
  if (!attestation) throw new Error('staging issued no receipt attestation');
  const { claims } = attestation;
  const body = {
    schemaVersion: 1,
    recordType: 'order_receipt',
    ownerPubky,
    revision: 1,
    createdAt: claims.paidAt,
    updatedAt: claims.paidAt,
    role: claims.buyer === ownerPubky ? 'buyer' : 'seller',
    receiptId: claims.receipt,
    orderId: claims.order,
    buyerPubky: claims.buyer,
    sellerPubky: claims.seller,
    total:
      claims.v === 2
        ? claims.merchandiseTotal
        : { amountMinor: claims.totalMinor, currency: claims.currency, exponent: claims.exponent },
    ...(claims.v === 2 ? { settlementTotal: claims.settlementTotal } : {}),
    paidAt: claims.paidAt,
    receiptAttestation: attestation.jws,
  };
  const built = new m.specs.PubkySpecsBuilder(ownerPubky).createMarketplaceOrderReceipt(body);
  const record = m.CommerceRecordNormalizer.orderReceiptRecord(built.order_receipt.toJson());
  if (claims.v === 2) record.settlementTotal = claims.settlementTotal;
  return { ...record };
}

// ---------------------------------------------------------------------------
// The documented recipe, independently (node:crypto + @noble/ciphers only)
// ---------------------------------------------------------------------------

type RecoveryFile = { owner: string; keys: { keyId: string; key: string }[] };

function recipe(file: RecoveryFile) {
  const subkey = (key: string, info: string) =>
    new Uint8Array(hkdfSync('sha256', Buffer.from(key, 'base64url'), 'pubky-priv-aead/v1', info, 32));
  const pathKey = subkey(file.keys[0].key, 'path');
  const segment = (input: string) => createHmac('sha256', pathKey).update(input).digest('base64url');
  const familyPath = (family: string) => `/priv/pubky.app/marketplace/v2/s/${segment(`family|${family}`)}/`;
  return {
    familyUrl: (family: string) => `pubky://${file.owner}${familyPath(family)}`,
    entryName: (family: string, id: string) => segment(`id|${family}|${id}`),
    entryUrl: (family: string, id: string) =>
      `pubky://${file.owner}${familyPath(family)}${segment(`id|${family}|${id}`)}`,
    /** Opens the envelope read from the entry `name` (its last path segment). */
    open(envelope: { kid: string; nonce: string; ct: string }, family: string, name: string): unknown {
      const entry = file.keys.find(({ keyId }) => keyId === envelope.kid);
      if (!entry) throw new Error('recovery file lacks the envelope key');
      const aad = new TextEncoder().encode(`${file.owner}|${family}|${name}|${envelope.kid}`);
      const plaintext = xchacha20poly1305(
        subkey(entry.key, 'record'),
        Uint8Array.from(Buffer.from(envelope.nonce, 'base64url')),
        aad,
      ).decrypt(Uint8Array.from(Buffer.from(envelope.ct, 'base64url')));
      return JSON.parse(new TextDecoder().decode(plaintext));
    },
  };
}

async function exists(url: string): Promise<boolean> {
  try {
    await m.CommerceHomeserverService.fetchJson(url);
    return true;
  } catch (error) {
    if ((error as { context?: { statusCode?: number } }).context?.statusCode === 404) return false;
    throw error;
  }
}

/**
 * Deletes everything this proof writes for its throwaway identities: the
 * buyer's whole `/priv/pubky.app/marketplace/` tree and the seller's public
 * marketplace records, then re-syncs every deleted listing so the service
 * drops it. Runs before the proof (a rerun starts clean) and after it.
 */
async function cleanUp(
  seller: Identity,
  buyer: Identity,
  sellerSession: ServiceSession,
  listingIds: string[],
): Promise<string[]> {
  const notes: string[] = [];
  actAs(buyer);
  const buyerRoot = `pubky://${buyer.pubky}/priv/pubky.app/marketplace/`;
  const buyerFiles = await m.HomeserverService.list({ baseDirectory: buyerRoot, limit: 1_000 });
  for (const url of buyerFiles) await m.CommerceHomeserverService.delete(url);
  expect(await m.HomeserverService.list({ baseDirectory: buyerRoot, limit: 1_000 })).toEqual([]);
  notes.push(`buyer /priv entries deleted: ${buyerFiles.length}`);

  actAs(seller);
  activate(sellerSession);
  const sellerRoot = `pubky://${seller.pubky}/pub/pubky.app/marketplace/`;
  const onHomeserver = (await m.HomeserverService.list({ baseDirectory: sellerRoot, limit: 1_000 }))
    .filter((url) => url.includes('/marketplace/v1/listings/'))
    .map((url) => url.slice(url.lastIndexOf('/') + 1));
  // End every listing on the service before its record goes: the service
  // keeps the last state it synced, and a sync of a missing record fails.
  for (const listingId of new Set([...listingIds, ...onHomeserver])) {
    const aggregate = `listing:${seller.pubky}_${listingId}`;
    const view = await m.MarketplaceGatewayService.getListing(seller.pubky, aggregate).catch(() => null);
    if (!view) {
      notes.push(`listing ${listingId}: not registered`);
      continue;
    }
    const url = m.CommerceRecordNormalizer.listingUri(seller.pubky, listingId);
    const current = (await m.CommerceHomeserverService.fetchJson(url).catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const base = current ?? (await listingTemplate(seller.pubky));
    const revision = Math.max(Number(base.revision ?? 1), Number(view.recordRevision ?? view.listingRevision ?? 1)) + 1;
    await m.CommerceHomeserverService.putJson(url, {
      ...base,
      listingId,
      state: 'ended',
      revision,
      updatedAt: new Date().toISOString(),
    });
    const response = await m.MarketplaceGatewayService.execute(
      seller.pubky,
      envelope(aggregate, view.serverRevision, 'listing.sync', { sellerPubky: seller.pubky, listingId }),
    ).catch((error: unknown) => ({ ok: false, error: String(error).slice(0, 120) }));
    const after = await m.MarketplaceGatewayService.getListing(seller.pubky, aggregate).catch(() => null);
    notes.push(
      `listing ${listingId}: record ended and synced (${response.ok ? 'ok' : JSON.stringify(response).slice(0, 120)}); service inventory state ${after?.state ?? 'none'} (the service keeps no catalog lifecycle)`,
    );
  }
  const sellerFiles = await m.HomeserverService.list({ baseDirectory: sellerRoot, limit: 1_000 });
  for (const url of sellerFiles) await m.CommerceHomeserverService.delete(url);
  expect(await m.HomeserverService.list({ baseDirectory: sellerRoot, limit: 1_000 })).toEqual([]);
  notes.push(`seller public marketplace records deleted: ${sellerFiles.length}`);
  return notes;
}

/** A valid listing record body to end a listing whose record is already gone. */
async function listingTemplate(sellerPubky: string): Promise<Record<string, unknown>> {
  const { record } = listingBody(sellerPubky, new Date().toISOString());
  return new m.specs.PubkySpecsBuilder(sellerPubky).createListing(record).listing.toJson() as Record<string, unknown>;
}

/** Types in place of values, keys sorted: what a wire fixture must share with the live body. */
function wireShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wireShape);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, member]) => [key, wireShape(member)]),
    );
  }
  return typeof value;
}

function flipFirstByte(envelope: { ct: string }): Record<string, unknown> {
  const ct = Buffer.from(envelope.ct, 'base64url');
  ct[0] ^= 1;
  return { ...envelope, ct: ct.toString('base64url') };
}

// ---------------------------------------------------------------------------

describe('encrypted /priv — LIVE proof on the deployed staging stack', () => {
  beforeAll(async () => {
    const relay = await fetch(`${PUBLIC_PKARR_RELAY}/${STAGING_HOMESERVER_PUBKY}`);
    if (!relay.ok) throw new Error(`pkarr relay did not serve the staging homeserver (${relay.status})`);
    const health = (await (await fetch(`${SERVICE_URL}/health`)).json()) as { priv_keys_available?: boolean };
    if (health.priv_keys_available !== true) throw new Error(`${SERVICE_URL} does not release priv data keys`);
    m = await loadModules();
    installWireLog();
    // Node has no Web Locks; this one process is a single tab.
    installWebLocks();
  }, 120_000);

  it('moves plaintext to sealed entries only with a full grant, reads back everywhere, and never overwrites what it cannot open', async () => {
    const saved = readSaved();
    const seller = await establishIdentity('seller', saved.seller);
    const buyer = await establishIdentity('buyer', saved.buyer);
    const listingIds = [...(saved.listingIds ?? [])];
    persist([seller, buyer], listingIds);

    // ── Seller lists one item; the buyer pays for two units (two orders) ───
    actAs(seller);
    const sellerSession = await connect(seller, m.CAPABILITIES);
    for (const note of await cleanUp(seller, buyer, sellerSession, listingIds)) {
      console.info(`[priv-live] pre-clean: ${note}`);
    }
    actAs(seller);
    activate(sellerSession);
    const { listingId } = await publishSellerRecords(seller.pubky);
    listingIds.push(listingId);
    persist([seller, buyer], listingIds);
    const listingAggregateId = `listing:${seller.pubky}_${listingId}`;
    await withPatience('listing.sync on the deployed service', REGISTRATION_DEADLINE_MS, async () => {
      try {
        const response = await m.MarketplaceGatewayService.execute(
          seller.pubky,
          envelope(listingAggregateId, 0, 'listing.sync', { sellerPubky: seller.pubky, listingId }),
        );
        return { done: response.ok, value: undefined, detail: JSON.stringify(response).slice(0, 120) };
      } catch (error) {
        return { done: false, value: undefined, detail: String(error).slice(0, 120) };
      }
    });
    actAs(buyer);
    const buyerFullGrant = await connect(buyer, m.CAPABILITIES);
    const firstOrder = await paidOrder(buyer, listingAggregateId);
    const secondOrder = await paidOrder(buyer, listingAggregateId);
    const firstReceiptId = firstOrder.receiptId as string;
    const secondReceiptId = secondOrder.receiptId as string;
    console.info(`[priv-live] buyer: two paid orders with staging receipt attestations`);

    // ── The buyer's plaintext v1 records, as a pre-encryption Shop left them
    const legacyWatchlistUrl = m.CommerceRecordNormalizer.watchlistUri(buyer.pubky);
    const legacyReceiptUrl = m.CommerceRecordNormalizer.orderReceiptUri(buyer.pubky, firstReceiptId);
    const legacyActivityUrl = `${m.CommerceRecordNormalizer.attentionSeenDirectoryUri(buyer.pubky, 'activity')}${String(Date.now() - 60_000).padStart(13, '0')}`;
    const legacyOrdersSeenAt = Date.now() - 30_000;
    const legacyOrdersUrl = `${m.CommerceRecordNormalizer.attentionSeenDirectoryUri(buyer.pubky, 'orders')}${String(legacyOrdersSeenAt).padStart(13, '0')}`;
    const legacyActivitySeenAt = Number(legacyActivityUrl.slice(-13));
    const watchedSeller = m.sdk.Keypair.fromSecret(crypto.getRandomValues(new Uint8Array(32))).publicKey.z32();
    const nowIso = new Date().toISOString();
    const legacyWatchlist = new m.specs.PubkySpecsBuilder(buyer.pubky)
      .createWatchlist({
        schemaVersion: 1,
        recordType: 'watchlist',
        ownerPubky: buyer.pubky,
        revision: 4,
        createdAt: nowIso,
        updatedAt: nowIso,
        items: [{ listingOwnerPubky: watchedSeller, listingId: 'priv_live_watch', watchedAtMs: Date.now() - 1_000 }],
        tombstones: [],
      })
      .watchlist.toJson() as Record<string, unknown>;
    const legacyReceipt = await legacyReceiptRecord(buyer.pubky, firstReceiptId);
    await m.CommerceHomeserverService.putJson(legacyWatchlistUrl, legacyWatchlist);
    await m.CommerceHomeserverService.putJson(legacyReceiptUrl, legacyReceipt);
    await m.CommerceHomeserverService.putJson(legacyActivityUrl, { version: 1, seenAt: legacyActivitySeenAt });
    await m.CommerceHomeserverService.putJson(legacyOrdersUrl, { version: 1, seenAt: legacyOrdersSeenAt });
    const legacyUrls = [legacyWatchlistUrl, legacyReceiptUrl, legacyActivityUrl, legacyOrdersUrl];
    console.info('[priv-live] buyer: plaintext v1 watchlist, receipt and two badge checkpoints planted');

    // ── 1. No key: the identity-only grant is refused; nothing is written ──
    await connect(buyer, '');
    const refused = await fetch(`${SERVICE_URL}/v1/me/priv-keys`, {
      headers: { authorization: `Bearer ${m.MarketplaceSessionService.getActiveSession()!.token}` },
    });
    expect(refused.status).toBe(403);
    const refusedBody = (await refused.json()) as { error: { code: string } };
    expect(refusedBody.error.code).toBe('needs_reauth');
    expect(wireShape(refusedBody)).toEqual(wireShape(PRIV_KEYS_WIRE_NEEDS_REAUTH));
    // The marketplace refused the key to this purchase session: the fix is a marketplace approval (#49).
    let mark = wire.length;
    await m.CommerceController.syncWatchlist();
    expect(m.useCommerceStore.getState().watchlistSyncStatus).toBe('needs_marketplace_approval');
    expect(await m.CommerceApplication.publishOrderReceipts(buyer.pubky, [firstOrder, secondOrder])).toBe(
      'needs_marketplace_approval',
    );
    await m.CommerceAttentionSeenApplication.pull(buyer.pubky);
    expect(await m.CommercePrivKeyringApplication.exportRecoveryKey(buyer.pubky)).toEqual({ kind: 'needs_reauth' });
    expect(writesSince(mark)).toEqual([]);
    for (const url of legacyUrls) expect(await exists(url), url).toBe(true);
    expect(
      await m.HomeserverService.list({ baseDirectory: `pubky://${buyer.pubky}/priv/pubky.app/marketplace/v2/` }),
    ).toEqual([]);
    console.info(
      '[priv-live] 1. key refused: needs_marketplace_approval for sync and receipts, zero writes, plaintext untouched, no v2 entries',
    );

    // A homeserver session that cannot write /priv/pubky.app/ is a homeserver refusal: needs_reauth,
    // decided before any key is requested, even beside a purchase session that would get one.
    activate(buyerFullGrant);
    m.CommercePrivKeyringApplication.clear();
    const narrowFlow = new m.sdk.Pubky().startCookieAuthFlow('/pub/pubky.app/:rw', m.sdk.AuthFlowKind.signin());
    await new m.sdk.Pubky().signer(buyer.keypair).approveAuthRequest(narrowFlow.authorizationUrl);
    const narrowSession = await narrowFlow.awaitApproval();
    expect(m.HomeserverService.isGrantSession(narrowSession)).toBe(false);
    actAs({ ...buyer, session: narrowSession });
    expect(m.HomeserverService.canCurrentSessionWrite('/priv/pubky.app/')).toBe(false);
    const keyReads = vi.spyOn(m.MarketplaceGatewayService, 'getPrivKeys');
    mark = wire.length;
    await m.CommerceController.syncWatchlist();
    expect(m.useCommerceStore.getState().watchlistSyncStatus).toBe('needs_reauth');
    expect(await m.CommerceApplication.publishOrderReceipts(buyer.pubky, [firstOrder, secondOrder])).toBe(
      'needs_reauth',
    );
    expect(keyReads).not.toHaveBeenCalled();
    keyReads.mockRestore();
    expect(wire.slice(mark).filter((entry) => entry.includes('/priv/'))).toEqual([]);
    // The narrow sign-in replaced the buyer's homeserver cookie; sign back in with the full session.
    const restored = await m.HomeserverService.signIn({ keypair: buyer.keypair });
    if (!restored) throw new Error('buyer: sign-in asked for a retry after republish; re-run.');
    buyer.session = restored.session;
    actAs(buyer);
    expect(m.HomeserverService.canCurrentSessionWrite('/priv/pubky.app/')).toBe(true);
    for (const url of legacyUrls) expect(await exists(url), url).toBe(true);
    console.info('[priv-live] 1b. homeserver grant without /priv: needs_reauth, no /priv request, plaintext untouched');

    // ── 2. Full grant: seal, read back, then delete ───────────────────────
    activate(buyerFullGrant);
    m.CommercePrivKeyringApplication.clear();
    const rawKeys = await fetch(`${SERVICE_URL}/v1/me/priv-keys`, {
      headers: { authorization: `Bearer ${buyerFullGrant.token}` },
      cache: 'no-store',
    });
    expect(rawKeys.status).toBe(200);
    const rawKeysBody = (await rawKeys.json()) as {
      owner: string;
      current_key_id: string;
      keys: { key_id: string; key: string; created_at: string }[];
    };
    expect(wireShape({ ...rawKeysBody, keys: rawKeysBody.keys.slice(0, 1) })).toEqual(wireShape(PRIV_KEYS_WIRE_OK));
    expect(rawKeysBody.owner).toBe(buyer.pubky);
    for (const key of rawKeysBody.keys) {
      expect(key.key_id).toMatch(/^[0-9a-f]{32}$/);
      expect(Buffer.from(key.key, 'base64url')).toHaveLength(32);
      expect(Number.isNaN(Date.parse(key.created_at))).toBe(false);
    }
    expect(rawKeysBody.keys.some(({ key_id }) => key_id === rawKeysBody.current_key_id)).toBe(true);
    console.info(
      `[priv-live] 2. released keys: ${rawKeysBody.keys.length} key(s); body shape matches the pinned wire fixture`,
    );
    const released = await m.MarketplaceGatewayService.getPrivKeys(buyer.pubky);
    if (released.kind !== 'keys') throw new Error(`full-grant session refused: ${released.kind}`);
    const keyring = released.keyring;
    const keyId = keyring.currentKeyId;
    const watchlistUrl = m.envelopeLib.privEntryUrl(keyring, 'watchlist', 'watchlist');
    const receiptUrl = (id: string) => m.envelopeLib.privEntryUrl(keyring, 'order_receipt', id);

    removeWebLocks();
    mark = wire.length;
    await m.CommerceController.syncWatchlist();
    expect(m.useCommerceStore.getState().watchlistSyncStatus).toBe('unsupported');
    expect(wire.slice(mark)).toEqual([]);
    expect(await exists(legacyWatchlistUrl)).toBe(true);
    installWebLocks();
    console.info('[priv-live] 2. without Web Locks: watchlist sync unsupported, zero requests, plaintext kept');

    mark = wire.length;
    await m.CommerceController.syncWatchlist();
    expect(m.useCommerceStore.getState().watchlistSyncStatus).toBe('synced');
    const sealedWatchlist = await m.CommercePrivStoreService.read(keyring, 'watchlist', 'watchlist');
    expect(sealedWatchlist).toMatchObject({
      revision: 5,
      items: [{ listingOwnerPubky: watchedSeller, listingId: 'priv_live_watch' }],
    });
    const watchlistEnvelope = JSON.stringify(await m.CommerceHomeserverService.fetchJson(watchlistUrl));
    expect(watchlistEnvelope).not.toContain('priv_live_watch');
    expect(watchlistEnvelope).not.toContain(watchedSeller);
    expect(await exists(legacyWatchlistUrl)).toBe(false);
    const watchlistWire = wire.slice(mark);
    const put = watchlistWire.indexOf(`PUT ${watchlistUrl}`);
    expect(put).toBeGreaterThanOrEqual(0);
    const verify = watchlistWire.indexOf(`GET ${watchlistUrl}`, put + 1);
    expect(verify).toBeGreaterThan(put);
    expect(watchlistWire.indexOf(`DELETE ${legacyWatchlistUrl}`)).toBeGreaterThan(verify);
    console.info('[priv-live] 2a. watchlist: sealed (PUT), read back (GET), then v1 deleted; ciphertext has no ids');

    mark = wire.length;
    expect(await m.CommerceApplication.publishOrderReceipts(buyer.pubky, [firstOrder, secondOrder])).toBe('published');
    expect(await m.CommercePrivStoreService.read(keyring, 'order_receipt', firstReceiptId)).toEqual(legacyReceipt);
    expect(await exists(legacyReceiptUrl)).toBe(false);
    const receiptWire = wire.slice(mark);
    const receiptPut = receiptWire.indexOf(`PUT ${receiptUrl(firstReceiptId)}`);
    expect(receiptPut).toBeGreaterThanOrEqual(0);
    const receiptVerify = receiptWire.indexOf(`GET ${receiptUrl(firstReceiptId)}`, receiptPut + 1);
    expect(receiptVerify).toBeGreaterThan(receiptPut);
    expect(receiptWire.indexOf(`DELETE ${legacyReceiptUrl}`)).toBeGreaterThan(receiptVerify);
    const secondRecord = (await m.CommercePrivStoreService.read(keyring, 'order_receipt', secondReceiptId)) as Record<
      string,
      unknown
    >;
    expect(secondRecord.receiptId).toBe(secondReceiptId);
    expect(m.specs.verifyOrderReceiptAttestation({ ...secondRecord })).toBeTruthy();
    expect(await exists(m.CommerceRecordNormalizer.orderReceiptUri(buyer.pubky, secondReceiptId))).toBe(false);
    for (const id of [firstReceiptId, secondReceiptId]) {
      const raw = JSON.stringify(await m.CommerceHomeserverService.fetchJson(receiptUrl(id)));
      expect(raw).not.toContain(id);
      expect(raw).not.toContain(seller.pubky);
    }
    console.info(
      '[priv-live] 2b. receipts: v1 moved (PUT, GET, DELETE); new receipt sealed from its staging attestation and verified offline',
    );

    await m.CommerceAttentionSeenApplication.pull(buyer.pubky);
    expect(await exists(legacyActivityUrl)).toBe(false);
    expect(await exists(legacyOrdersUrl)).toBe(false);
    expect(await m.LocalCommerceService.getActivityReadCheckpoint(buyer.pubky)).toBe(legacyActivitySeenAt);
    const sealedSeenAt = async (side: 'activity' | 'orders') => {
      const family = side === 'activity' ? 'attention_seen/activity' : 'attention_seen/orders';
      const names = await m.CommercePrivStoreService.listNames(keyring, family, 100);
      const values = await Promise.all(
        names.map(
          async (name) =>
            ((await m.CommercePrivStoreService.readListed(keyring, family, name)) as { seenAt: number }).seenAt,
        ),
      );
      return { names, max: Math.max(0, ...values) };
    };
    expect((await sealedSeenAt('activity')).max).toBe(legacyActivitySeenAt);
    expect((await sealedSeenAt('orders')).max).toBe(legacyOrdersSeenAt);
    await m.CommerceAttentionSeenApplication.markSeen(buyer.pubky, 'activity');
    const activityAfterSeen = await sealedSeenAt('activity');
    expect(activityAfterSeen.names).toHaveLength(1);
    expect(activityAfterSeen.max).toBeGreaterThan(legacyActivitySeenAt);
    console.info(
      '[priv-live] 2c. badge checkpoints: v1 carried into sealed entries and deleted; a new seen moment pruned the older entry',
    );

    const exported = await m.CommercePrivKeyringApplication.exportRecoveryKey(buyer.pubky);
    if (exported.kind !== 'file') throw new Error(`export refused: ${exported.kind}`);
    const recovery = recipe(JSON.parse(exported.file.contents) as RecoveryFile);
    expect(recovery.entryUrl('watchlist', 'watchlist')).toBe(watchlistUrl);
    expect(
      recovery.open(
        (await m.CommerceHomeserverService.fetchJson(watchlistUrl)) as never,
        'watchlist',
        recovery.entryName('watchlist', 'watchlist'),
      ),
    ).toEqual(sealedWatchlist);
    // Receipts: no receipt id is known up front. List the family, open each
    // entry by its own name, then check the id inside derives that name.
    const receiptEntries = await m.HomeserverService.list({
      baseDirectory: recovery.familyUrl('order_receipt'),
      limit: 100,
    });
    const recovered = new Map<string, Record<string, unknown>>();
    for (const url of receiptEntries) {
      const name = url.slice(url.lastIndexOf('/') + 1);
      const record = recovery.open(
        (await m.CommerceHomeserverService.fetchJson(url)) as never,
        'order_receipt',
        name,
      ) as Record<string, unknown>;
      expect(recovery.entryName('order_receipt', String(record.receiptId))).toBe(name);
      recovered.set(String(record.receiptId), record);
    }
    expect([...recovered.keys()].sort()).toEqual([firstReceiptId, secondReceiptId].sort());
    expect(recovered.get(firstReceiptId)).toEqual(legacyReceipt);
    expect(recovered.get(secondReceiptId)).toEqual(secondRecord);
    const [activityName] = activityAfterSeen.names;
    expect(
      recovery.open(
        (await m.CommerceHomeserverService.fetchJson(
          `${recovery.familyUrl('attention_seen/activity')}${activityName}`,
        )) as never,
        'attention_seen/activity',
        activityName,
      ),
    ).toMatchObject({ version: 1, seenAt: activityAfterSeen.max });
    console.info(
      '[priv-live] 2d. exported recovery key alone opens the watchlist, both receipts found by listing (no receipt ids), and a checkpoint, with node:crypto',
    );

    // ── 3. Fresh device: empty IndexedDB, new session, same key ────────────
    m.CommerceController.clearMarketplaceSession();
    await m.db.delete();
    await m.db.open();
    m.useCommerceStore.getState().reset();
    const signedBackIn = await m.HomeserverService.signIn({ keypair: buyer.keypair });
    if (!signedBackIn) throw new Error('fresh device sign-in asked for a retry');
    buyer.session = signedBackIn.session;
    actAs(buyer);
    await connect(buyer, m.CAPABILITIES);
    const again = await m.MarketplaceGatewayService.getPrivKeys(buyer.pubky);
    expect(again.kind === 'keys' && again.keyring.currentKeyId).toBe(keyId);
    mark = wire.length;
    await m.CommerceController.syncWatchlist();
    expect(m.useCommerceStore.getState().watchlistSyncStatus).toBe('synced');
    expect(await m.CommerceController.isFavorite(`${watchedSeller}:priv_live_watch`)).toBe(true);
    m.CommerceApplication.resetReceiptPublicationMemo();
    expect(await m.CommerceApplication.publishOrderReceipts(buyer.pubky, [firstOrder, secondOrder])).toBe('published');
    await m.CommerceAttentionSeenApplication.pull(buyer.pubky);
    expect(await m.LocalCommerceService.getActivityReadCheckpoint(buyer.pubky)).toBe(activityAfterSeen.max);
    expect(writesSince(mark)).toEqual([]);
    console.info(
      '[priv-live] 3. fresh device: same key id, watchlist restored, receipts and checkpoints read back, zero writes',
    );

    // ── 4. Undecryptable: never overwritten, plaintext kept ────────────────
    const tamperedWatchlist = flipFirstByte(
      (await m.CommerceHomeserverService.fetchJson(watchlistUrl)) as { ct: string },
    );
    const tamperedReceipt = flipFirstByte(
      (await m.CommerceHomeserverService.fetchJson(receiptUrl(firstReceiptId))) as { ct: string },
    );
    await m.CommerceHomeserverService.putJson(watchlistUrl, tamperedWatchlist);
    await m.CommerceHomeserverService.putJson(receiptUrl(firstReceiptId), tamperedReceipt);
    await m.CommerceHomeserverService.putJson(legacyWatchlistUrl, legacyWatchlist);
    await m.CommerceHomeserverService.putJson(legacyReceiptUrl, legacyReceipt);
    const foreignCheckpoint = `${recovery.familyUrl('attention_seen/orders')}${'f'.repeat(32)}`;
    await m.CommerceHomeserverService.putJson(foreignCheckpoint, flipFirstByte(tamperedReceipt as { ct: string }));
    mark = wire.length;
    await m.CommerceController.syncWatchlist();
    expect(m.useCommerceStore.getState().watchlistSyncStatus).toBe('error');
    m.CommerceApplication.resetReceiptPublicationMemo();
    expect(await m.CommerceApplication.publishOrderReceipts(buyer.pubky, [firstOrder])).toBe('unavailable');
    await m.CommerceAttentionSeenApplication.pull(buyer.pubky);
    expect(writesSince(mark)).toEqual([]);
    expect(await m.CommerceHomeserverService.fetchJson(watchlistUrl)).toEqual(tamperedWatchlist);
    expect(await m.CommerceHomeserverService.fetchJson(receiptUrl(firstReceiptId))).toEqual(tamperedReceipt);
    expect(await exists(legacyWatchlistUrl)).toBe(true);
    expect(await exists(legacyReceiptUrl)).toBe(true);
    expect(await exists(foreignCheckpoint)).toBe(true);
    console.info(
      '[priv-live] 4. undecryptable: tampered entries untouched, plaintext kept, foreign checkpoint ignored, zero writes',
    );

    const invalidReceipt = m.envelopeLib.encryptPrivRecord({
      keyring,
      family: 'order_receipt',
      name: m.envelopeLib.privEntryName(keyring, 'order_receipt', firstReceiptId),
      record: {},
    });
    await m.CommerceHomeserverService.putJson(receiptUrl(firstReceiptId), invalidReceipt);
    mark = wire.length;
    m.CommerceApplication.resetReceiptPublicationMemo();
    expect(await m.CommerceApplication.publishOrderReceipts(buyer.pubky, [firstOrder])).toBe('unavailable');
    expect(writesSince(mark)).toEqual([]);
    expect(await m.CommerceHomeserverService.fetchJson(receiptUrl(firstReceiptId))).toEqual(invalidReceipt);
    expect(await m.CommerceHomeserverService.fetchJson(legacyReceiptUrl)).toEqual(legacyReceipt);
    console.info(
      '[priv-live] 4c. a sealed receipt that opens to an invalid record: not published, not overwritten, plaintext kept, zero writes',
    );

    // ── 4b. Privacy boundary: another identity reads nothing of the buyer's ──
    // Sign the buyer's homeserver session out first: the process-wide cookie
    // jar would otherwise carry the buyer's authentication into the probe.
    await m.HomeserverService.logout({ session: buyer.session });
    actAs(seller);
    const refusal = async (probe: () => Promise<unknown>) =>
      await probe().then(
        () => 'served',
        (error: { category?: string; context?: { statusCode?: number } }) =>
          error.category === 'auth' || [401, 403].includes(error.context?.statusCode ?? 0) ? 'refused' : String(error),
      );
    expect(await refusal(() => m.CommerceHomeserverService.fetchJson(watchlistUrl))).toBe('refused');
    expect(
      await refusal(() =>
        m.HomeserverService.list({ baseDirectory: `pubky://${buyer.pubky}/priv/pubky.app/marketplace/`, limit: 10 }),
      ),
    ).toBe('refused');
    console.info("[priv-live] 4b. privacy: the seller's session is refused the buyer's sealed entry and /priv listing");
    const buyerBack = await m.HomeserverService.signIn({ keypair: buyer.keypair });
    if (!buyerBack) throw new Error('buyer sign-in for cleanup asked for a retry');
    buyer.session = buyerBack.session;

    // ── 5. Cleanup ─────────────────────────────────────────────────────────
    for (const note of await cleanUp(seller, buyer, sellerSession, listingIds)) {
      console.info(`[priv-live] 5. cleanup: ${note}`);
    }
    for (const url of [
      watchlistUrl,
      receiptUrl(firstReceiptId),
      receiptUrl(secondReceiptId),
      foreignCheckpoint,
      ...legacyUrls,
    ]) {
      expect(await exists(url), url).toBe(false);
    }
    const revocations: number[] = [];
    for (const session of mintedSessions) {
      const response = await fetch(`${SERVICE_URL}/v1/auth/sessions/${session.sessionId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.token}` },
      });
      revocations.push(response.status);
    }
    console.info(
      `[priv-live] 5. session revocation statuses ${JSON.stringify(revocations)} (an identity-only session cannot revoke itself: the route needs the marketplace-service grant, so it expires with the session TTL)`,
    );
    console.info(
      `[priv-live] service-side leftovers by design: 2 paid staging orders and one sealed data key for ${prefix(buyer.pubky)}; the listing ${prefix(seller.pubky)}:${listingId}`,
    );
  });
});
