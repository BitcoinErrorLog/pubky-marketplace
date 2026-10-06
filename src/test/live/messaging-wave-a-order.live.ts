import 'fake-indexeddb/auto';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair, Pubky } from '@synonymdev/pubky';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MarketplaceCommandResponse } from '@/libs/commerce/transaction-commands';

/**
 * Wave A live proof: create a bound-but-unpaid staging shipping order, then
 * Chromium against this-branch Shop pointed at staging-api. Buyer sends in
 * the thread UI; seller sees the body. Production `data-surface` + screenshots.
 * The order is cancelled (restocked) at the end. No money moves.
 *
 *   WAVE_A_SHOP_URL=http://127.0.0.1:4311 npm run test:marketplace:messaging:wave-a
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const NEXUS_URL = process.env.MARKETPLACE_NEXUS_URL ?? 'https://nexus.staging.pubky.app';
const TRAIN_SEAT_DIR =
  process.env.WAVE_A_TRAIN_SEAT_DIR ?? '/Volumes/t7/vibes-dev/.evidence/train-2026-09-22-am/part-c/staging-seat';
const DROP_IDENTITIES_FILE =
  process.env.WAVE_A_DROP_IDENTITIES_FILE ?? '/Users/johncarvalho/work/.staging-drop-identities.json';
const EVIDENCE_DIR = process.env.MESSAGING_WAVE_A_EVIDENCE_DIR ?? '/Volumes/t7/vibes-dev/.evidence/messaging-wave-a';
const LIVE_SEATS_DIR = path.join(EVIDENCE_DIR, 'live-seats');
const PROOF_PATH = process.env.MESSAGING_WAVE_A_PROOF_PATH ?? path.join(EVIDENCE_DIR, 'shop-send-see-proof.txt');
const SHOT_DIR = path.join(EVIDENCE_DIR, 'chromium-shop-shots');
const SHOP_PORT = Number(process.env.WAVE_A_SHOP_PORT ?? 4311);
const TRAIN_SELLER_PREFIX = '4mj79unr';
const DROP_BUYER_A_PREFIX = 'bgortufi';
const REGISTRATION_DEADLINE_MS = 120_000;
const RECOVERY_PASSPHRASE = 'wave-a-chromium-restore';

process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL = NEXUS_URL;
process.env.PUBKY_RUNTIME_TESTNET ??= 'false';
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '6';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

type Seat = {
  role: 'seller' | 'buyer';
  pubky: string;
  keypair: Keypair;
  pkarrPath: string;
  passphrase: string;
};

type AppModules = {
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  MarketplaceGatewayService: typeof import('@/services/marketplace/marketplace').MarketplaceGatewayService;
  HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;
  CommerceHomeserverService: typeof import('@/services/homeserver/commerce/commerce').CommerceHomeserverService;
  useAuthStore: typeof import('@/stores/auth/auth.store').useAuthStore;
  specs: typeof import('pubky-app-specs');
};

type ServiceSession = NonNullable<
  ReturnType<typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService.getActiveSession>
>;

let modules: AppModules;
let shopUrl = (process.env.WAVE_A_SHOP_URL ?? '').replace(/\/$/, '');
let shopProcess: ChildProcess | null = null;
let browser: Browser;
let createdOrderId: string | null = null;
let createdListingTitle = '';
let createdListingId = '';
let failingStep = 'boot';
let sellerSeat: Seat;
let buyerSeat: Seat;
let sellerPersistedSession: PersistedMarketplaceSession;
let buyerPersistedSession: PersistedMarketplaceSession;

type PersistedMarketplaceSession = {
  token: string;
  sessionId?: string;
  pubky: string;
  capabilities: string;
  expiresAt: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexToBytes(hex: string, label: string): Uint8Array {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${label} is not a 64-char hex secret`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function commandDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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

function writeProof(lines: Record<string, string | number | boolean>): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    PROOF_PATH,
    Object.entries(lines)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('\n') + '\n',
  );
}

function mintRecoverySeat(role: 'seller' | 'buyer', keypair: Keypair): Seat {
  mkdirSync(LIVE_SEATS_DIR, { recursive: true });
  const pkarrPath = path.join(LIVE_SEATS_DIR, `${role}.pkarr`);
  const passphrasePath = path.join(LIVE_SEATS_DIR, `${role}.passphrase`);
  const recovery = keypair.createRecoveryFile(RECOVERY_PASSPHRASE);
  writeFileSync(pkarrPath, Buffer.from(recovery));
  writeFileSync(passphrasePath, `${RECOVERY_PASSPHRASE}\n`, { mode: 0o600 });
  chmodSync(pkarrPath, 0o600);
  chmodSync(passphrasePath, 0o600);
  const pubky = keypair.publicKey.z32();
  expect(pubky.length).toBe(52);
  return { role, pubky, keypair, pkarrPath, passphrase: RECOVERY_PASSPHRASE };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'not-tried';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      last = String(response.status);
      if (response.status < 500) return;
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch-failed';
    }
    await sleep(1_000);
  }
  throw new Error(`Shop did not become ready at ${url} (${last})`);
}

async function ensureShopPage(): Promise<string> {
  if (shopUrl) {
    await waitForHttp(shopUrl, 30_000);
    return shopUrl;
  }
  shopUrl = `http://127.0.0.1:${SHOP_PORT}`;
  const nextBin = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
  shopProcess = spawn(process.execPath, [nextBin, 'dev', '--webpack', '-H', '127.0.0.1', '-p', String(SHOP_PORT)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COPYFILE_DISABLE: '1',
      PORT: String(SHOP_PORT),
      PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE: 'transaction-service',
      PUBKY_RUNTIME_MARKETPLACE_URL: SERVICE_URL,
      PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL: NEXUS_URL,
      PUBKY_RUNTIME_TESTNET: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logPath = path.join(EVIDENCE_DIR, 'wave-a-shop-next.log');
  const chunks: Buffer[] = [];
  shopProcess.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  shopProcess.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
  try {
    await waitForHttp(shopUrl, 240_000);
  } finally {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(logPath, Buffer.concat(chunks));
  }
  return shopUrl;
}

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
    await sleep(retryDelayMs);
  }
}

async function signInHomeserver(keypair: Keypair, pubky: string): Promise<void> {
  const signedIn = await modules.HomeserverService.signIn({ keypair });
  expect(signedIn, `homeserver sign-in for ${pubky.slice(0, 8)}`).not.toBeNull();
  if (!signedIn) throw new Error(`homeserver sign-in failed for ${pubky.slice(0, 8)}`);
  modules.useAuthStore.setState({ session: signedIn.session, currentUserPubky: pubky });
}

async function connectServiceSession(keypair: Keypair, pubky: string): Promise<ServiceSession> {
  return await withPatience(`marketplace session for ${pubky.slice(0, 8)}`, 90_000, 4_000, async () => {
    try {
      const flow = modules.MarketplaceSessionService.beginSessionFlow();
      await new Pubky().signer(keypair).approveAuthRequest(flow.authorizationUrl);
      const info = await flow.awaitSession();
      if (info.pubky !== pubky) {
        return { done: false, value: null as never, detail: `session pubky ${info.pubky.slice(0, 8)}` };
      }
      const session = modules.MarketplaceSessionService.getActiveSession();
      if (session === null) return { done: false, value: null as never, detail: 'no session' };
      return { done: true, value: session };
    } catch (error) {
      return { done: false, value: null as never, detail: commandDetail(error) };
    }
  });
}

function snapshotMarketplaceSession(expectedPubky: string): PersistedMarketplaceSession {
  const session = modules.MarketplaceSessionService.getActiveSession();
  if (!session || session.pubky !== expectedPubky) {
    throw new Error(`expected marketplace session for ${expectedPubky.slice(0, 8)}`);
  }
  return {
    token: session.token,
    sessionId: session.sessionId,
    pubky: session.pubky,
    capabilities: session.capabilities,
    expiresAt: session.expiresAt,
  };
}

function activateServiceSession(session: ServiceSession): void {
  (modules.MarketplaceSessionService as unknown as { session: ServiceSession | null }).session = session;
}

function keepDocumentVisible(): void {
  const hidden = () => false;
  const visibilityState = () => 'visible';
  const apply = () => {
    for (const target of [Document.prototype, document]) {
      try {
        Object.defineProperty(target, 'hidden', { configurable: true, enumerable: true, get: hidden });
        Object.defineProperty(target, 'visibilityState', {
          configurable: true,
          enumerable: true,
          get: visibilityState,
        });
      } catch {
        // Chromium may pin a non-configurable instance accessor; the interval retries.
      }
    }
  };
  apply();
  setInterval(apply, 400);
  document.addEventListener('visibilitychange', apply, true);
}

async function forcePageVisible(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const hidden = () => false;
      const visibilityState = () => 'visible';
      try {
        Object.defineProperty(document, 'hidden', { configurable: true, get: hidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: visibilityState });
      } catch {
        // ignore
      }
      document.dispatchEvent(new Event('visibilitychange'));
    })
    .catch(() => undefined);
}

function handshakeCopy(page: Page) {
  const surface = page.locator('[data-surface="marketplace-encrypted-conversation"]');
  return {
    initiator: surface.getByText('Not delivered yet: their device has not answered'),
    responder: surface.getByText('Waiting for them to open the Shop again to finish connecting'),
    composer: surface.locator('#encrypted-message-body'),
  };
}

async function handshakeRole(page: Page): Promise<'initiator' | 'responder' | 'ready' | 'other'> {
  const copy = handshakeCopy(page);
  if ((await copy.initiator.count()) > 0) return 'initiator';
  if ((await copy.responder.count()) > 0) return 'responder';
  if ((await copy.composer.count()) > 0) return 'ready';
  return 'other';
}

async function closeOrderThread(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: 'Close' });
  if ((await close.count()) === 0) return;
  await close
    .first()
    .click()
    .catch(() => undefined);
  await page
    .locator('[data-surface="marketplace-encrypted-conversation"]')
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => undefined);
}

async function reopenOrderThread(
  page: Page,
  keypair: Keypair,
  listingTitle: string,
  shotPrefix: string,
  options?: { allowNotEnrolled?: boolean },
): Promise<void> {
  await closeOrderThread(page);
  await sleep(1_000);
  await openOrderThread(page, keypair, listingTitle, shotPrefix, options);
}

function lastNetworkHit(lines: string[], predicate: (line: string) => boolean): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index])) return lines[index];
  }
  return undefined;
}

async function waitForNetworkLine(
  lines: string[],
  what: string,
  deadlineMs: number,
  predicate: (line: string) => boolean,
): Promise<string> {
  return await withPatience(what, deadlineMs, 400, async () => {
    const hit = lastNetworkHit(lines, predicate);
    return { done: Boolean(hit), value: hit ?? '', detail: `n=${lines.length}` };
  });
}

async function waitForReceiverPut(lines: string[], role: string, pubkyPrefix: string): Promise<string> {
  return await waitForNetworkLine(
    lines,
    `${role} receiver.json PUT`,
    90_000,
    (line) =>
      line.startsWith(`${role} PUT `) &&
      line.includes('/receiver.json') &&
      / (201|200) /.test(line) &&
      line.includes(`host=${pubkyPrefix}`),
  );
}

async function waitForHandshakeOfferPut(lines: string[], role: string, pubkyPrefix: string): Promise<string> {
  return await waitForNetworkLine(
    lines,
    `${role} handshake offer PUT`,
    90_000,
    (line) =>
      line.startsWith(`${role} PUT `) &&
      /\/messages\/[0-9a-f]{16,}[^/]*\/0 201/.test(line) &&
      line.includes(`host=${pubkyPrefix}`),
  );
}

async function waitUntilHandshakeReady(
  buyerPage: Page,
  sellerPage: Page,
  buyerKeypair: Keypair,
  sellerKeypair: Keypair,
  listingTitle: string,
  networkLog: string[],
): Promise<void> {
  const deadline = Date.now() + 180_000;
  let lastBuyerReopen = Date.now();
  let lastSellerReopen = Date.now();
  while (Date.now() < deadline) {
    await buyerPage.bringToFront();
    await forcePageVisible(buyerPage);
    await sellerPage.bringToFront();
    await forcePageVisible(sellerPage);
    const buyerRole = await handshakeRole(buyerPage);
    const sellerRole = await handshakeRole(sellerPage);
    if (buyerRole === 'ready' && sellerRole === 'ready') return;
    if (buyerRole === 'initiator' && sellerRole === 'initiator' && Date.now() - lastBuyerReopen > 12_000) {
      await buyerPage.bringToFront();
      await reopenOrderThread(buyerPage, buyerKeypair, listingTitle, 'buyer-reopen');
      lastBuyerReopen = Date.now();
    }
    if (buyerRole === 'initiator' && sellerRole === 'other' && Date.now() - lastSellerReopen > 8_000) {
      await sellerPage.bringToFront();
      await reopenOrderThread(sellerPage, sellerKeypair, listingTitle, 'seller-reopen', { allowNotEnrolled: true });
      lastSellerReopen = Date.now();
    }
    await sleep(1_500);
  }
  writeFileSync(path.join(EVIDENCE_DIR, 'handshake-network.log'), `${networkLog.join('\n')}\n`);
  await capturePage(buyerPage, 'buyer-handshake-stuck');
  await capturePage(sellerPage, 'seller-handshake-stuck');
  throw new Error(
    `encrypted link never reached ready (buyer=${await handshakeRole(buyerPage)} seller=${await handshakeRole(sellerPage)})`,
  );
}

function attachNetworkLog(context: BrowserContext, role: string, lines: string[]): void {
  context.on('response', (response) => {
    const request = response.request();
    if (request.resourceType() !== 'xhr' && request.resourceType() !== 'fetch') return;
    let hostname = '';
    let pathname = '';
    try {
      const url = new URL(request.url());
      hostname = url.hostname;
      pathname = url.pathname;
    } catch {
      return;
    }
    if (!/pubky|homeserver|pkarr|staging-api/.test(`${hostname}${pathname}`)) return;
    const pubkyHost = request.headers()['pubky-host'] ?? '';
    const hostTag = pubkyHost ? ` host=${pubkyHost.slice(0, 8)}` : '';
    lines.push(`${role} ${request.method()} ${hostname}${pathname} ${response.status()}${hostTag}`);
  });
}

async function installStagingCorsBypass(context: BrowserContext): Promise<void> {
  const shopOrigin = () => shopUrl || `http://127.0.0.1:${SHOP_PORT}`;
  const corsAllowHeaders =
    'authorization,content-type,pubky-host,if-match,if-none-match,accept,cookie,range,cache-control';
  await context.route(
    (url) => url.protocol === 'https:' && url.origin !== new URL(shopOrigin()).origin,
    async (route) => {
      const request = route.request();
      const accept = request.headers()['accept'] ?? '';
      const type = request.resourceType();
      if (type === 'websocket' || type === 'eventsource' || accept.includes('text/event-stream')) {
        await route.continue();
        return;
      }
      if (type === 'image' || type === 'font' || type === 'stylesheet' || type === 'media') {
        await route.continue();
        return;
      }
      const origin = shopOrigin();
      const requested = request.headers()['access-control-request-headers'] ?? '';
      const allowHeaders = Array.from(
        new Set([...corsAllowHeaders.split(','), ...requested.split(',')].map((value) => value.trim()).filter(Boolean)),
      ).join(',');
      if (request.method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
            'access-control-allow-headers': allowHeaders,
            'access-control-max-age': '0',
          },
        });
        return;
      }
      try {
        const inboundHeaders = { ...request.headers() };
        const response = await route.fetch({ headers: inboundHeaders });
        const headers = { ...response.headers() };
        delete headers['content-encoding'];
        delete headers['content-length'];
        await route.fulfill({
          status: response.status(),
          headers: {
            ...headers,
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            'access-control-expose-headers': '*',
            'access-control-allow-headers': allowHeaders,
          },
          body: await response.body(),
        });
      } catch {
        await route.continue().catch(() => undefined);
      }
    },
  );
}

async function injectMarketplaceSession(page: Page, session: PersistedMarketplaceSession): Promise<void> {
  await page.evaluate(
    ({ key, blob }) => {
      window.localStorage.setItem(key, blob);
    },
    {
      key: 'pubky.marketplace.session.v1',
      blob: JSON.stringify({
        token: session.token,
        sessionId: session.sessionId,
        pubky: session.pubky,
        capabilities: session.capabilities,
        expiresAt: session.expiresAt,
      }),
    },
  );
}

async function publishAppProfile(pubky: string, name: string): Promise<void> {
  const builder = new modules.specs.PubkySpecsBuilder(pubky);
  const profile = builder.createUser(name, null, null, null, null);
  await modules.CommerceHomeserverService.putJson(profile.meta.url, profile.user.toJson() as Record<string, unknown>);
}

async function publishShippingListing(sellerPubky: string, title: string): Promise<string> {
  const nowIso = new Date().toISOString();
  await publishAppProfile(sellerPubky, 'Wave A train seller');
  const builder = new modules.specs.PubkySpecsBuilder(sellerPubky);
  const shop = builder.createShop({
    schemaVersion: 1,
    recordType: 'shop',
    ownerPubky: sellerPubky,
    revision: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    name: 'Wave A train shop',
    bio: 'Shipping listing for the Wave A Chromium messaging proof.',
    location: { countryCode: 'PT', region: 'Lisboa' },
    shippingPolicy: 'Ships within 3 business days.',
    returnPolicy: 'Returns accepted within 30 days.',
    vacationMode: false,
  });
  await modules.CommerceHomeserverService.putJson(shop.meta.url, shop.shop.toJson() as Record<string, unknown>);
  const listing = builder.createListing({
    schemaVersion: 1,
    recordType: 'listing',
    ownerPubky: sellerPubky,
    revision: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    listingId: '',
    state: 'active',
    title,
    description: 'Shipping listing created for the Wave A Chromium send-see proof. Cancelled after the run.',
    taxonomyVersion: 1,
    categoryId: 'fashion-shoes-boots',
    condition: 'good',
    tags: ['wave-a-messaging'],
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
        altText: 'Wave A shipping listing',
      },
    ],
    variants: [{ id: 'variant_01', options: {}, quantity: 1, mediaIds: ['image_01'], enabled: true }],
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
        price: { amountMinor: 0, currency: 'USD', exponent: 2 },
        estimatedMinDays: 3,
        estimatedMaxDays: 7,
      },
    ],
    returnPolicy: { acceptsReturns: false, buyerPaysReturnShipping: false },
    digitalDelivery: null,
    adultOnly: false,
  } as never);
  await modules.CommerceHomeserverService.putJson(
    listing.meta.url,
    listing.listing.toJson() as Record<string, unknown>,
  );
  return listing.meta.id;
}

async function registerOrSyncListing(sellerPubky: string, listingId: string, title: string): Promise<void> {
  const listingAggregateId = `listing:${sellerPubky}_${listingId}`;
  try {
    const registered = await modules.MarketplaceGatewayService.execute(
      sellerPubky,
      envelope(listingAggregateId, 0, 'listing.register', {
        sellerPubky,
        listingId,
        title,
        listingRevision: 1,
        contentHash: 'd'.repeat(64),
        quantity: 1,
        unitPrice: { amountMinor: 1_000, currency: 'USD', exponent: 2 },
        shippingMinor: 0,
        saleFormat: 'fixed_price' as const,
        fulfillmentMethods: ['shipping'] as ('shipping' | 'pickup')[],
      }),
    );
    if (registered.ok) return;
  } catch {
    // Deployed staging may refuse listing.register and require listing.sync.
  }

  await withPatience('listing.sync after register refusal', REGISTRATION_DEADLINE_MS, 3_000, async () => {
    try {
      const response = await modules.MarketplaceGatewayService.execute(
        sellerPubky,
        envelope(listingAggregateId, 0, 'listing.sync', { sellerPubky, listingId }),
      );
      return response.ok
        ? { done: true, value: undefined }
        : { done: false, value: undefined, detail: response.error.code };
    } catch (error) {
      return { done: false, value: undefined, detail: commandDetail(error) };
    }
  });
}

async function createDurableOrder(): Promise<{
  orderId: string;
  listingId: string;
  title: string;
  bound: boolean;
  state: string;
}> {
  failingStep = 'load_identities';
  expect(existsSync(path.join(TRAIN_SEAT_DIR, 'identities.json')), 'train identities.json').toBe(true);
  expect(existsSync(DROP_IDENTITIES_FILE), 'drop identities file').toBe(true);
  const train = JSON.parse(readFileSync(path.join(TRAIN_SEAT_DIR, 'identities.json'), 'utf8')) as {
    seller?: unknown;
  };
  const drop = JSON.parse(readFileSync(DROP_IDENTITIES_FILE, 'utf8')) as { buyerA?: unknown; buyerB?: unknown };
  expect(typeof train.seller, `train identities keys=${Object.keys(train).join(',')}`).toBe('string');
  expect(typeof drop.buyerA, `drop identities keys=${Object.keys(drop).join(',')}`).toBe('string');
  const sellerKeypair = Keypair.fromSecret(hexToBytes(String(train.seller), 'train.seller'));
  const buyerKeypair = Keypair.fromSecret(hexToBytes(String(drop.buyerA), 'drop.buyerA'));
  sellerSeat = mintRecoverySeat('seller', sellerKeypair);
  buyerSeat = mintRecoverySeat('buyer', buyerKeypair);
  expect(sellerSeat.pubky.startsWith(TRAIN_SELLER_PREFIX), 'train seller prefix').toBe(true);
  expect(buyerSeat.pubky.startsWith(DROP_BUYER_A_PREFIX), 'drop buyerA prefix').toBe(true);

  const title = `Wave A ship ${Date.now()}`;
  createdListingTitle = title;

  failingStep = 'seller_homeserver';
  await signInHomeserver(sellerSeat.keypair, sellerSeat.pubky);
  failingStep = 'publish_listing';
  const listingId = await publishShippingListing(sellerSeat.pubky, title);
  createdListingId = listingId;
  const listingAggregateId = `listing:${sellerSeat.pubky}_${listingId}`;

  failingStep = 'seller_marketplace_session';
  const sellerSession = await connectServiceSession(sellerSeat.keypair, sellerSeat.pubky);
  activateServiceSession(sellerSession);
  sellerPersistedSession = snapshotMarketplaceSession(sellerSeat.pubky);
  failingStep = 'listing_register';
  await registerOrSyncListing(sellerSeat.pubky, listingId, title);

  failingStep = 'buyer_homeserver';
  await signInHomeserver(buyerSeat.keypair, buyerSeat.pubky);
  await publishAppProfile(buyerSeat.pubky, 'Wave A drop buyer');
  failingStep = 'buyer_marketplace_session';
  const buyerSession = await connectServiceSession(buyerSeat.keypair, buyerSeat.pubky);
  activateServiceSession(buyerSession);
  buyerPersistedSession = snapshotMarketplaceSession(buyerSeat.pubky);

  failingStep = 'checkout_create';
  const listingView = await modules.MarketplaceGatewayService.getListing(buyerSeat.pubky, listingAggregateId);
  expect(listingView, 'registered listing must be readable').toBeTruthy();
  const checkoutCommandId = crypto.randomUUID();
  const checkedOut = (await modules.MarketplaceGatewayService.execute(buyerSeat.pubky, {
    version: 1 as const,
    commandId: checkoutCommandId,
    aggregateId: `checkout:${checkoutCommandId}`,
    expectedRevision: 0,
    issuedAt: new Date().toISOString(),
    kind: 'checkout.create' as const,
    payload: {
      lines: [
        {
          listingAggregateId,
          expectedRevision: listingView!.serverRevision,
          quantity: 1,
          fulfillment: 'shipping' as const,
        },
      ],
      deliveryAddress: {
        name: 'Wave A Buyer',
        line1: 'Rua Augusta 1',
        line2: '',
        city: 'Lisboa',
        region: '',
        postalCode: '1100-053',
        countryCode: 'PT',
      },
      guaranteePolicyVersion: 1 as const,
    },
  })) as MarketplaceCommandResponse;
  expect(checkedOut.ok, `checkout.create failed: ${JSON.stringify(checkedOut)}`).toBe(true);

  const orders = await modules.MarketplaceGatewayService.getOrders(buyerSeat.pubky);
  const order = orders.find((row) => row.lines.some((line) => line.listingAggregateId === listingAggregateId));
  expect(order, 'checkout must produce a durable order').toBeTruthy();
  createdOrderId = order!.id;

  failingStep = 'bind_payment_method';
  let bound = false;
  try {
    const boundOrder = await modules.MarketplaceGatewayService.bindPaymentMethod(buyerSeat.pubky, order!.id, 'paypal');
    bound = Boolean(boundOrder.paymentMethod);
  } catch (error) {
    writeFileSync(path.join(EVIDENCE_DIR, 'bind-paypal-error.txt'), commandDetail(error));
  }

  const afterBind = await modules.MarketplaceGatewayService.getOrder(buyerSeat.pubky, order!.id);
  return {
    orderId: order!.id,
    listingId,
    title,
    bound,
    state: afterBind?.state ?? order!.state,
  };
}

async function cancelAndRestock(orderId: string, buyer: Seat): Promise<string> {
  failingStep = 'cancel_restock';
  await signInHomeserver(buyer.keypair, buyer.pubky);
  await connectServiceSession(buyer.keypair, buyer.pubky);
  const current = await modules.MarketplaceGatewayService.getOrder(buyer.pubky, orderId);
  if (!current) return 'missing';
  if (current.state === 'cancelled') return 'already_cancelled';
  const cancelled = await modules.MarketplaceGatewayService.execute(
    buyer.pubky,
    envelope(`order:${orderId}`, current.revision, 'order.cancel_request', {
      orderId,
      reason: 'Wave A Chromium proof restock',
    }),
  );
  if (!cancelled.ok) {
    throw new Error(`order.cancel_request failed: ${JSON.stringify(cancelled)}`);
  }
  const after = await modules.MarketplaceGatewayService.getOrder(buyer.pubky, orderId);
  return after?.state ?? 'unknown';
}

async function capturePage(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
  writeFileSync(path.join(SHOT_DIR, `${name}.html`), await page.content());
  writeFileSync(path.join(SHOT_DIR, `${name}.txt`), await page.locator('body').innerText());
}

async function installAuthUrlCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const world = window as unknown as { __waveACopied?: string };
    const clipboard = navigator.clipboard as Clipboard & { __waveAPatched?: boolean };
    if (!clipboard || clipboard.__waveAPatched) return;
    const original = clipboard.writeText.bind(clipboard);
    clipboard.writeText = async (text: string) => {
      world.__waveACopied = text;
      try {
        await original(text);
      } catch {
        // Headless Chromium often rejects writeText; the captured value is the proof URL.
      }
    };
    clipboard.__waveAPatched = true;
  });
}

async function approveSignerUrl(page: Page, keypair: Keypair): Promise<void> {
  await page.bringToFront();
  await installAuthUrlCapture(page);
  const waiting = page.getByText('Waiting for approval on your signer…');
  const copy = page.getByRole('button', { name: 'Copy link' });
  await Promise.race([
    waiting.waitFor({ state: 'visible', timeout: 60_000 }),
    copy.waitFor({ state: 'visible', timeout: 60_000 }),
  ]);
  await copy.waitFor({ state: 'visible', timeout: 30_000 });
  await withPatience('Copy link enabled', 30_000, 250, async () => ({
    done: await copy.isEnabled(),
    value: true,
  }));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.evaluate(() => {
      (window as unknown as { __waveACopied?: string }).__waveACopied = '';
    });
    await copy.click();
    const authorizationUrl = await withPatience('authorization URL capture', 15_000, 250, async () => {
      const value = await page.evaluate(() => (window as unknown as { __waveACopied?: string }).__waveACopied ?? '');
      return { done: value.startsWith('pubkyauth://'), value, detail: `len=${value.length}` };
    });
    expect(authorizationUrl.startsWith('pubkyauth://'), 'copied URL must be a pubkyauth deeplink').toBe(true);
    await new Pubky().signer(keypair).approveAuthRequest(authorizationUrl);
    const settled = await waiting
      .waitFor({ state: 'hidden', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (settled) return;
  }
  throw new Error('signer approval did not hide Waiting for approval on your signer…');
}

async function completeOnboardingIfNeeded(page: Page): Promise<void> {
  const form = page.getByTestId('create-profile-form');
  const onOnboarding = page.url().includes('/onboarding/profile') || (await form.count()) > 0;
  if (!onOnboarding) return;
  const nameInput = page.locator('#profile-name-input');
  await nameInput.waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await nameInput.inputValue()).trim()) {
    await nameInput.fill('Wave A proof');
  }
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/onboarding/profile'), { timeout: 90_000 });
  const explore = page.locator('#welcome-explore-pubky-btn');
  const welcomeVisible = await explore
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (welcomeVisible) {
    await explore.click();
  }
}

async function signInWithEncryptedFile(page: Page, seat: Seat): Promise<void> {
  await page.goto(`${shopUrl}/sign-in`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  try {
    await page.locator('#restore-encrypted-file-btn').click();
    const dialogTitle = page.getByText('Restore with encrypted file').first();
    const opened = await dialogTitle
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) {
      await page.locator('#restore-encrypted-file-btn').click({ force: true });
      await dialogTitle.waitFor({ state: 'visible', timeout: 15_000 });
    }
    await page.locator('#encrypted-file-input').setInputFiles(seat.pkarrPath);
    const password = page.locator('#restore-password');
    await password.waitFor({ state: 'visible', timeout: 15_000 });
    await password.fill(seat.passphrase);
    const restore = page.locator('#encrypted-file-restore-btn');
    await withPatience('encrypted restore enabled', 20_000, 250, async () => ({
      done: await restore.isEnabled(),
      value: true,
    }));
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes('/sign-in'), { timeout: 180_000 }),
      restore.click({ force: true }),
    ]);
    await completeOnboardingIfNeeded(page);
  } catch (error) {
    await capturePage(page, `${seat.role}-restore`);
    throw error;
  }
}

async function waitForListingOnOrders(
  page: Page,
  persisted: PersistedMarketplaceSession,
  listingTitle: string,
  shotPrefix: string,
): Promise<void> {
  const listing = page.getByText(`${listingTitle} × 1`);
  const allTab = page.getByRole('tab', { name: /^All / });
  const approve = page.getByRole('button', { name: 'Approve in Pubky Ring' });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await listing.count()) > 0) return;
    if ((await allTab.count()) > 0) {
      await allTab.click();
      if ((await listing.count()) > 0) return;
    }
    if (attempt > 0 && (await approve.count()) > 0 && (await allTab.count()) === 0) {
      await injectMarketplaceSession(page, persisted);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
      continue;
    }
    if (attempt < 7) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
      await sleep(2_000);
    }
  }
  await capturePage(page, `${shotPrefix}-orders-missing`);
  throw new Error(`Orders page never showed listing title after session (${shotPrefix})`);
}

async function connectMarketplaceSession(
  page: Page,
  persisted: PersistedMarketplaceSession,
  listingTitle: string,
  shotPrefix: string,
): Promise<void> {
  await injectMarketplaceSession(page, persisted);
  await page.goto(`${shopUrl}/marketplace/orders`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await completeOnboardingIfNeeded(page);
  if (!page.url().includes('/marketplace/orders')) {
    await injectMarketplaceSession(page, persisted);
    await page.goto(`${shopUrl}/marketplace/orders`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  }
  const approve = page.getByRole('button', { name: 'Approve in Pubky Ring' });
  const listing = page.getByText(`${listingTitle} × 1`);
  const allTab = page.getByRole('tab', { name: /^All / });
  const empty = page.getByRole('heading', { name: 'No orders yet' });
  const unavailable = page.getByRole('alert').filter({ hasText: 'Marketplace orders are unavailable' });
  try {
    await Promise.race([
      listing.waitFor({ state: 'visible', timeout: 45_000 }),
      allTab.waitFor({ state: 'visible', timeout: 45_000 }),
      empty.waitFor({ state: 'visible', timeout: 45_000 }),
      approve.waitFor({ state: 'visible', timeout: 45_000 }),
      unavailable.waitFor({ state: 'visible', timeout: 45_000 }),
    ]);
  } catch {
    await capturePage(page, `${shotPrefix}-orders-boot`);
    throw new Error(`${shotPrefix}: orders page showed neither session card, empty state, nor the listing`);
  }
  if ((await unavailable.count()) > 0) {
    await capturePage(page, `${shotPrefix}-orders-unavailable`);
    throw new Error(`${shotPrefix}: orders fetch failed (Marketplace orders are unavailable)`);
  }
  if ((await listing.count()) > 0) return;
  if ((await approve.count()) > 0 && (await allTab.count()) === 0 && (await empty.count()) === 0) {
    await injectMarketplaceSession(page, persisted);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
  }
  await waitForListingOnOrders(page, persisted, listingTitle, shotPrefix);
}

async function openOrderThread(
  page: Page,
  keypair: Keypair,
  listingTitle: string,
  shotPrefix: string,
  options?: { allowNotEnrolled?: boolean },
): Promise<void> {
  const card = page
    .locator('div')
    .filter({ hasText: `${listingTitle} × 1` })
    .filter({ has: page.locator('[data-surface="marketplace-order-message-cta"]') })
    .last();
  await card
    .locator('[data-surface="marketplace-order-message-cta"]')
    .getByRole('button', { name: 'Message about this order' })
    .click();
  const surface = page.locator('[data-surface="marketplace-encrypted-conversation"]');
  await surface.waitFor({ state: 'visible', timeout: 30_000 });
  const composer = page.locator('#encrypted-message-body');
  const waiting = page.getByText('Waiting for approval on your signer…');
  const copyLink = page.getByRole('button', { name: 'Copy link' });
  const enableCopy = page.getByText(
    'Approve in your Pubky signer so this device can send and receive private messages.',
  );
  const notEnrolled = page.getByText(/has not turned on private messages yet/);
  const tryAgain = page.getByRole('button', { name: 'Try again' });
  try {
    await Promise.race([
      composer.waitFor({ state: 'visible', timeout: 90_000 }),
      waiting.waitFor({ state: 'visible', timeout: 90_000 }),
      copyLink.waitFor({ state: 'visible', timeout: 90_000 }),
      enableCopy.waitFor({ state: 'visible', timeout: 90_000 }),
      notEnrolled.waitFor({ state: 'visible', timeout: 90_000 }),
      tryAgain.waitFor({ state: 'visible', timeout: 90_000 }),
    ]);
  } catch (error) {
    await capturePage(page, `${shotPrefix}-thread-open`);
    throw error;
  }
  if ((await composer.count()) > 0) return;
  if ((await notEnrolled.count()) > 0) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.getByRole('button', { name: 'Close' }).click();
      await sleep(2_000);
      await card
        .locator('[data-surface="marketplace-order-message-cta"]')
        .getByRole('button', { name: 'Message about this order' })
        .click();
      await surface.waitFor({ state: 'visible', timeout: 30_000 });
      if ((await composer.count()) > 0) return;
      if ((await waiting.count()) > 0 || (await copyLink.count()) > 0 || (await enableCopy.count()) > 0) break;
      if ((await notEnrolled.count()) === 0) break;
    }
    if ((await composer.count()) > 0) return;
    if ((await notEnrolled.count()) > 0) {
      if (options?.allowNotEnrolled) return;
      await capturePage(page, `${shotPrefix}-thread-not-enrolled`);
      throw new Error(`${shotPrefix}: counterparty is not enrolled for encrypted messaging`);
    }
  }
  if ((await tryAgain.count()) > 0 && (await composer.count()) === 0) {
    await capturePage(page, `${shotPrefix}-thread-enable-error`);
    const alertText = await page
      .getByRole('alert')
      .innerText()
      .catch(() => '');
    throw new Error(`${shotPrefix}: messaging enable error ${alertText}`.trim());
  }
  try {
    await approveSignerUrl(page, keypair);
    await Promise.race([
      composer.waitFor({ state: 'visible', timeout: 90_000 }),
      notEnrolled.waitFor({ state: 'visible', timeout: 90_000 }),
      handshakeCopy(page).initiator.waitFor({ state: 'visible', timeout: 90_000 }),
      handshakeCopy(page).responder.waitFor({ state: 'visible', timeout: 90_000 }),
    ]);
    if ((await composer.count()) > 0) return;
    if ((await handshakeCopy(page).initiator.count()) > 0) return;
    if ((await handshakeCopy(page).responder.count()) > 0) return;
    if ((await notEnrolled.count()) > 0) {
      if (options?.allowNotEnrolled) return;
      await capturePage(page, `${shotPrefix}-thread-not-enrolled`);
      throw new Error(`${shotPrefix}: counterparty is not enrolled after enable`);
    }
  } catch (error) {
    await capturePage(page, `${shotPrefix}-thread-enable`);
    throw error;
  }
}

describe('Wave A Chromium Shop: buyer send, seller see', () => {
  beforeAll(async () => {
    mkdirSync(SHOT_DIR, { recursive: true });
    modules = {
      MarketplaceSessionService: (await import('@/services/marketplace/marketplace-session')).MarketplaceSessionService,
      MarketplaceGatewayService: (await import('@/services/marketplace/marketplace')).MarketplaceGatewayService,
      HomeserverService: (await import('@/services/homeserver/homeserver')).HomeserverService,
      CommerceHomeserverService: (await import('@/services/homeserver/commerce/commerce')).CommerceHomeserverService,
      useAuthStore: (await import('@/stores/auth/auth.store')).useAuthStore,
      specs: await import('pubky-app-specs'),
    };
    await ensureShopPage();
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
        '--disable-site-isolation-trials',
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    if (shopProcess?.pid) {
      shopProcess.kill('SIGTERM');
    }
  });

  it('creates a bound-but-unpaid staging order, sends from buyer Shop, seller sees it, then restocks', async () => {
    let created: Awaited<ReturnType<typeof createDurableOrder>> | undefined;
    try {
      created = await createDurableOrder();
      expect(created.state === 'pending_payment' || created.state === 'paid').toBe(true);

      failingStep = 'chromium_restore';
      const body = `wave-a-shop-${Date.now()}`;
      const sellerContext: BrowserContext = await browser.newContext({
        permissions: ['clipboard-read', 'clipboard-write'],
        ignoreHTTPSErrors: true,
      });
      const buyerContext: BrowserContext = await browser.newContext({
        permissions: ['clipboard-read', 'clipboard-write'],
        ignoreHTTPSErrors: true,
      });
      await installStagingCorsBypass(sellerContext);
      await installStagingCorsBypass(buyerContext);
      await sellerContext.addInitScript(keepDocumentVisible);
      await buyerContext.addInitScript(keepDocumentVisible);
      const networkLog: string[] = [];
      attachNetworkLog(sellerContext, 'seller', networkLog);
      attachNetworkLog(buyerContext, 'buyer', networkLog);
      await sellerContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: shopUrl });
      await buyerContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: shopUrl });
      const sellerPage = await sellerContext.newPage();
      const buyerPage = await buyerContext.newPage();

      try {
        await signInWithEncryptedFile(sellerPage, sellerSeat);
        await signInWithEncryptedFile(buyerPage, buyerSeat);
        failingStep = 'marketplace_session';
        await connectMarketplaceSession(sellerPage, sellerPersistedSession, created.title, 'seller');
        await connectMarketplaceSession(buyerPage, buyerPersistedSession, created.title, 'buyer');

        failingStep = 'open_threads';
        // Publish the seller's this-device receiver before the buyer DHs.
        // Opening the buyer first made the buyer lock onto the previous
        // restore's marker; seller then rotated and both seats stayed initiator.
        await sellerPage.bringToFront();
        await forcePageVisible(sellerPage);
        await openOrderThread(sellerPage, sellerSeat.keypair, created.title, 'seller', { allowNotEnrolled: true });
        await waitForReceiverPut(networkLog, 'seller', TRAIN_SELLER_PREFIX);
        await closeOrderThread(sellerPage);

        await buyerPage.bringToFront();
        await forcePageVisible(buyerPage);
        await openOrderThread(buyerPage, buyerSeat.keypair, created.title, 'buyer');
        await waitForReceiverPut(networkLog, 'buyer', DROP_BUYER_A_PREFIX);
        await waitForHandshakeOfferPut(networkLog, 'buyer', DROP_BUYER_A_PREFIX);

        await sellerPage.bringToFront();
        await forcePageVisible(sellerPage);
        await openOrderThread(sellerPage, sellerSeat.keypair, created.title, 'seller');
        failingStep = 'handshake_ready';
        await waitUntilHandshakeReady(
          buyerPage,
          sellerPage,
          buyerSeat.keypair,
          sellerSeat.keypair,
          created.title,
          networkLog,
        );

        failingStep = 'buyer_send';
        await buyerPage.bringToFront();
        await forcePageVisible(buyerPage);
        await buyerPage.locator('#encrypted-message-body').fill(body);
        await buyerPage.getByRole('button', { name: /^Send/ }).click();
        await buyerPage
          .locator('[data-surface="marketplace-encrypted-conversation"]')
          .getByText(body)
          .waitFor({ state: 'visible', timeout: 30_000 });
        await capturePage(buyerPage, 'buyer-send');

        failingStep = 'seller_see';
        const seen = sellerPage
          .locator('[data-surface="marketplace-encrypted-conversation"]')
          .filter({ hasText: body });
        const seeDeadline = Date.now() + 90_000;
        while (Date.now() < seeDeadline && (await seen.count()) === 0) {
          await sellerPage.bringToFront();
          await forcePageVisible(sellerPage);
          await sleep(1_000);
          await buyerPage.bringToFront();
          await forcePageVisible(buyerPage);
          await sleep(500);
        }
        if ((await seen.count()) === 0) {
          writeFileSync(path.join(EVIDENCE_DIR, 'handshake-network.log'), `${networkLog.join('\n')}\n`);
          await capturePage(sellerPage, 'seller-see-missing');
          throw new Error('seller never saw the buyer message');
        }
        await sellerPage.bringToFront();
        await capturePage(sellerPage, 'seller-see');
        writeFileSync(path.join(EVIDENCE_DIR, 'handshake-network.log'), `${networkLog.join('\n')}\n`);

        const buyerSurface = await buyerPage
          .locator('[data-surface="marketplace-encrypted-conversation"]')
          .getAttribute('data-surface');
        const sellerSurface = await sellerPage
          .locator('[data-surface="marketplace-encrypted-conversation"]')
          .getAttribute('data-surface');
        const orderSurface = await buyerPage
          .locator('[data-surface="marketplace-order-message-cta"]')
          .first()
          .getAttribute('data-surface');

        failingStep = 'done';
        writeProof({
          shop: shopUrl,
          service: SERVICE_URL,
          browser: 'chromium',
          seller_prefix: sellerSeat.pubky.slice(0, 8),
          buyer_prefix: buyerSeat.pubky.slice(0, 8),
          listing_id_len: created.listingId.length,
          listing_title: created.title,
          order_id_len: created.orderId.length,
          order_state: created.state,
          bound: created.bound,
          data_surface_order: orderSurface ?? '',
          data_surface_buyer: buyerSurface ?? '',
          data_surface_seller: sellerSurface ?? '',
          buyer_send: true,
          seller_see: true,
          shots: SHOT_DIR,
          failing_step: 'none',
        });
      } finally {
        await sellerContext.close();
        await buyerContext.close();
      }
    } catch (error) {
      writeProof({
        shop: shopUrl,
        service: SERVICE_URL,
        browser: 'chromium',
        listing_title: createdListingTitle,
        listing_id_len: createdListingId.length,
        order_id_len: createdOrderId?.length ?? 0,
        failing_step: failingStep,
        error: commandDetail(error),
        buyer_send: failingStep === 'seller_see' || failingStep === 'done',
        seller_see: false,
        shots: SHOT_DIR,
      });
      throw error;
    } finally {
      if (createdOrderId && buyerSeat) {
        try {
          const cancelState = await cancelAndRestock(createdOrderId, buyerSeat);
          const existing = existsSync(PROOF_PATH) ? readFileSync(PROOF_PATH, 'utf8') : '';
          writeFileSync(PROOF_PATH, `${existing}cancel_state=${cancelState}\n`);
        } catch (error) {
          const existing = existsSync(PROOF_PATH) ? readFileSync(PROOF_PATH, 'utf8') : '';
          writeFileSync(PROOF_PATH, `${existing}cancel_error=${commandDetail(error)}\n`);
        }
      }
    }
  }, 900_000);
});
