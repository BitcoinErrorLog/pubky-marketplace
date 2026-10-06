import 'fake-indexeddb/auto';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair, Pubky } from '@synonymdev/pubky';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Issue 42 C-2 live proof: Chromium against this-branch Shop pointed at
 * staging-api, seller seat from the drop identities file. Confirms:
 *   - a missing marketplace session bootstraps (no "Status unavailable")
 *   - restoring the persisted bearer reads real drop status
 *   - header New drop stays above the fold
 *   - the status row is not doubled
 *
 *   npm run test:marketplace:drop-status
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const NEXUS_URL = process.env.MARKETPLACE_NEXUS_URL ?? 'https://nexus.staging.pubky.app';
const DROP_IDENTITIES_FILE =
  process.env.MARKETPLACE_STAGING_DROP_IDENTITIES_FILE ?? '/Users/johncarvalho/work/.staging-drop-identities.json';
const EVIDENCE_DIR = process.env.DROP_STATUS_EVIDENCE_DIR ?? '/Volumes/t7/vibes-dev/.evidence/issue-42';
const LIVE_SEATS_DIR = path.join(EVIDENCE_DIR, 'live-seats');
const SHOT_DIR = path.join(EVIDENCE_DIR, 'chromium-shots');
const PROOF_PATH = path.join(EVIDENCE_DIR, 'chromium-proof.txt');
const SHOP_PORT = Number(process.env.DROP_STATUS_SHOP_PORT ?? 4312);
const SELLER_PREFIX = 'chxiztne';
const RECOVERY_PASSPHRASE = 'drop-status-chromium-restore';
const DROPS_PATH = '/marketplace/sell/drops';

process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL = NEXUS_URL;
process.env.PUBKY_RUNTIME_TESTNET ??= 'false';
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '6';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

type Seat = {
  pubky: string;
  keypair: Keypair;
  pkarrPath: string;
  passphrase: string;
};

type PersistedMarketplaceSession = {
  token: string;
  sessionId?: string;
  pubky: string;
  capabilities: string;
  expiresAt: string;
};

type AppModules = {
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;
  CommerceController: typeof import('@/controllers/commerce/commerce').CommerceController;
  useAuthStore: typeof import('@/stores/auth/auth.store').useAuthStore;
};

type ServiceSession = NonNullable<
  ReturnType<typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService.getActiveSession>
>;

let modules: AppModules;
let shopUrl = (process.env.DROP_STATUS_SHOP_URL ?? '').replace(/\/$/, '');
let shopProcess: ChildProcess | null = null;
let browser: Browser;
let sellerSeat: Seat;
let persistedSession: PersistedMarketplaceSession;
let ownedDropCount = 0;
let ownedDropId = '';
let failingStep = 'boot';

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

function writeProof(lines: Record<string, string | number | boolean>): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    PROOF_PATH,
    Object.entries(lines)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('\n') + '\n',
  );
}

function mintRecoverySeat(keypair: Keypair): Seat {
  mkdirSync(LIVE_SEATS_DIR, { recursive: true });
  const pkarrPath = path.join(LIVE_SEATS_DIR, 'seller.pkarr');
  const passphrasePath = path.join(LIVE_SEATS_DIR, 'seller.passphrase');
  writeFileSync(pkarrPath, Buffer.from(keypair.createRecoveryFile(RECOVERY_PASSPHRASE)));
  writeFileSync(passphrasePath, `${RECOVERY_PASSPHRASE}\n`, { mode: 0o600 });
  chmodSync(pkarrPath, 0o600);
  chmodSync(passphrasePath, 0o600);
  const pubky = keypair.publicKey.z32();
  expect(pubky.length).toBe(52);
  return { pubky, keypair, pkarrPath, passphrase: RECOVERY_PASSPHRASE };
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
  const logPath = path.join(EVIDENCE_DIR, 'drop-status-shop-next.log');
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

async function capturePage(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
  writeFileSync(path.join(SHOT_DIR, `${name}.html`), await page.content());
  writeFileSync(path.join(SHOT_DIR, `${name}.txt`), await page.locator('body').innerText());
}

async function completeOnboardingIfNeeded(page: Page): Promise<void> {
  const form = page.getByTestId('create-profile-form');
  const onOnboarding = page.url().includes('/onboarding/profile') || (await form.count()) > 0;
  if (!onOnboarding) return;
  const nameInput = page.locator('#profile-name-input');
  await nameInput.waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await nameInput.inputValue()).trim()) {
    await nameInput.fill('Drop status proof');
  }
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/onboarding/profile'), { timeout: 90_000 });
  const explore = page.locator('#welcome-explore-pubky-btn');
  const welcomeVisible = await explore
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (welcomeVisible) await explore.click();
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
    await capturePage(page, 'seller-restore');
    throw error;
  }
}

function countCopy(body: string, needle: string): number {
  if (!needle) return 0;
  return body.split(needle).length - 1;
}

async function openDropsHome(
  page: Page,
  session: PersistedMarketplaceSession | null,
  shotPrefix: string,
): Promise<void> {
  if (session) await injectMarketplaceSession(page, session);
  await page.goto(`${shopUrl}${DROPS_PATH}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await completeOnboardingIfNeeded(page);
  if (!page.url().includes(DROPS_PATH)) {
    if (session) await injectMarketplaceSession(page, session);
    await page.goto(`${shopUrl}${DROPS_PATH}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  }
  const home = page.locator('[data-surface="drop-studio-home"]');
  try {
    await home.waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByRole('heading', { name: 'Your drops' }).waitFor({ state: 'visible', timeout: 45_000 });
  } catch (error) {
    await capturePage(page, `${shotPrefix}-boot`);
    throw error;
  }
}

async function waitUntilDropsSettled(page: Page, shotPrefix: string): Promise<string> {
  return await withPatience('drops home settled', 60_000, 1_000, async () => {
    const body = await page.locator('body').innerText();
    const loading = await page.locator('[data-surface="drop-studio-home"] .animate-pulse').count();
    const hasRows = (await page.locator('[data-surface="drop-studio-home"] li').count()) > 0;
    const empty = body.includes('No drops published yet');
    const sessionBanner = (await page.locator('[data-surface="drop-studio-session-bootstrap"]').count()) > 0;
    const done = loading === 0 && (hasRows || empty || sessionBanner);
    return { done, value: body, detail: `loading=${loading} rows=${hasRows} empty=${empty}` };
  }).catch(async (error) => {
    await capturePage(page, `${shotPrefix}-unsettle`);
    throw error;
  });
}

async function assertNewDropAboveFold(page: Page): Promise<void> {
  const link = page.getByRole('link', { name: 'New drop' }).first();
  await link.waitFor({ state: 'visible', timeout: 10_000 });
  const box = await link.boundingBox();
  const viewport = page.viewportSize();
  expect(box, 'New drop link has a box').toBeTruthy();
  expect(viewport, 'viewport is set').toBeTruthy();
  if (!box || !viewport) return;
  expect(box.y + box.height, 'New drop stays above the fold').toBeLessThanOrEqual(viewport.height);
}

async function openSellerContext(viewport: { width: number; height: number }): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await browser.newContext({
    viewport,
    ignoreHTTPSErrors: true,
  });
  await installStagingCorsBypass(context);
  await context.addInitScript(keepDocumentVisible);
  const page = await context.newPage();
  await signInWithEncryptedFile(page, sellerSeat);
  return { context, page };
}

describe('Chromium Shop: seller drop-status studio', () => {
  beforeAll(async () => {
    mkdirSync(SHOT_DIR, { recursive: true });
    expect(existsSync(DROP_IDENTITIES_FILE), 'drop identities file').toBe(true);
    const saved = JSON.parse(readFileSync(DROP_IDENTITIES_FILE, 'utf8')) as { seller?: unknown };
    expect(typeof saved.seller, `drop identities keys=${Object.keys(saved).join(',')}`).toBe('string');
    sellerSeat = mintRecoverySeat(Keypair.fromSecret(hexToBytes(String(saved.seller), 'seller')));
    expect(sellerSeat.pubky.startsWith(SELLER_PREFIX), 'seller prefix').toBe(true);

    modules = {
      MarketplaceSessionService: (await import('@/services/marketplace/marketplace-session')).MarketplaceSessionService,
      HomeserverService: (await import('@/services/homeserver/homeserver')).HomeserverService,
      CommerceController: (await import('@/controllers/commerce/commerce')).CommerceController,
      useAuthStore: (await import('@/stores/auth/auth.store')).useAuthStore,
    };

    failingStep = 'seller_homeserver';
    await signInHomeserver(sellerSeat.keypair, sellerSeat.pubky);
    failingStep = 'list_own_drops';
    let dropIds = await modules.CommerceController.listOwnDropIds();
    if (dropIds.length === 0) {
      // This seat currently has no drops directory. Publish a seller-signed
      // announcement so Your drops has a row; registration is optional —
      // an unregistered projection is Draft, which still proves the
      // protected read is not 401/Status unavailable.
      const nowIso = new Date().toISOString();
      const dropId = `drop_status_${Date.now()}`;
      await modules.CommerceController.publishDrop({
        schemaVersion: 1,
        recordType: 'drop',
        ownerPubky: sellerSeat.pubky,
        revision: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
        dropId,
        title: 'Drop-status Chromium proof',
        description: 'Homeserver drop record so Seller studio can read protected status.',
        media: [],
        format: 'fcfs',
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        listingIds: ['listing_status_proof'],
        totalQuantity: 1,
        perBuyerLimit: 1,
        stockDisplay: 'exact',
      });
      dropIds = await modules.CommerceController.listOwnDropIds();
    }
    ownedDropCount = dropIds.length;
    ownedDropId = dropIds[0] ?? '';
    expect(ownedDropCount, 'seller must own at least one homeserver drop').toBeGreaterThan(0);

    failingStep = 'seller_marketplace_session';
    await connectServiceSession(sellerSeat.keypair, sellerSeat.pubky);
    persistedSession = snapshotMarketplaceSession(sellerSeat.pubky);

    failingStep = 'protected_drop_read';
    const own = await modules.CommerceController.getOwnDrop(ownedDropId);
    // Null is Draft (unregistered). A throw is the 401 bug this proof exists to catch.
    expect(own === null || typeof own === 'object', 'protected drop-status read must not throw').toBe(true);

    failingStep = 'shop';
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
    if (shopProcess?.pid) shopProcess.kill('SIGTERM');
  });

  it('bootstraps a missing session and reads status after restore, with New drop above the fold', async () => {
    try {
      failingStep = 'chromium_no_session';
      const missing = await openSellerContext({ width: 1280, height: 800 });
      try {
        await openDropsHome(missing.page, null, 'no-session');
        const missingBody = await waitUntilDropsSettled(missing.page, 'no-session');
        await capturePage(missing.page, 'no-session-desktop');
        expect(countCopy(missingBody, 'Status unavailable')).toBe(0);
        expect(missingBody).toContain('Connect a marketplace session to read drop status.');
        expect(await missing.page.locator('[data-surface="drop-studio-session-bootstrap"]').count()).toBe(1);
        await assertNewDropAboveFold(missing.page);
      } finally {
        await missing.context.close();
      }

      failingStep = 'chromium_with_session';
      const restored = await openSellerContext({ width: 1280, height: 800 });
      try {
        await openDropsHome(restored.page, persistedSession, 'session');
        const sessionBody = await waitUntilDropsSettled(restored.page, 'session');
        await capturePage(restored.page, 'session-desktop');
        expect(countCopy(sessionBody, 'Status unavailable')).toBe(0);
        expect(sessionBody).not.toContain("Could not read this drop's status.");
        expect(await restored.page.locator('[data-surface="drop-studio-session-bootstrap"]').count()).toBe(0);
        expect(await restored.page.locator('[data-surface="drop-studio-home"] li').count()).toBeGreaterThan(0);
        expect(sessionBody).toMatch(/Draft|Scheduled|Live|Ended/);
        await assertNewDropAboveFold(restored.page);

        failingStep = 'chromium_mobile';
        await restored.page.setViewportSize({ width: 390, height: 844 });
        await restored.page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
        await restored.page.locator('[data-surface="drop-studio-home"]').waitFor({ state: 'visible', timeout: 60_000 });
        const mobileBody = await waitUntilDropsSettled(restored.page, 'session-mobile');
        await capturePage(restored.page, 'session-mobile');
        expect(countCopy(mobileBody, 'Status unavailable')).toBe(0);
        await assertNewDropAboveFold(restored.page);
      } finally {
        await restored.context.close();
      }

      writeProof({
        verdict: 'PASS',
        shop: shopUrl,
        seller_prefix: sellerSeat.pubky.slice(0, 8),
        owned_drop_count: ownedDropCount,
        owned_drop_id: ownedDropId,
        session_expires_at: persistedSession.expiresAt,
        shots: 'no-session-desktop,session-desktop,session-mobile',
        failing_step: 'none',
      });
    } catch (error) {
      writeProof({
        verdict: 'FAIL',
        shop: shopUrl,
        seller_prefix: sellerSeat.pubky.slice(0, 8),
        owned_drop_count: ownedDropCount,
        owned_drop_id: ownedDropId,
        failing_step: failingStep,
        error: commandDetail(error),
      });
      throw error;
    }
  });
});
