#!/usr/bin/env node
// Paid digital delivery proof (design decision DD4): one real Bitcoin purchase per delivery kind, with the
// release-proof test seats. THIS SPENDS REAL MONEY ON PRODUCTION. It refuses to start without today's go-ahead
// token from the product owner (PROOF_DIGITAL_GO=GO-<UTC date>). Run `plan` first: it touches nothing.
//
// What it automates: publishing one "TEST, do not buy" digital listing per kind from the seller seat and setting
// its delivery; checkout, Bitcoin and Pay as the buyer seat; waiting for the order to be paid; then the delivery
// checks on both sides; then teardown and verification.
// What it cannot automate, by design: paying the Bitkit Payment Request (a real wallet holds the buyer's funds),
// emailing the tester mailbox, and sending a message in chat. Those are the operator's, and the script waits for
// each and prints exactly what to do.
//
//   node production-digital-fixture.mjs plan                 print the plan and check the environment; no network
//   node production-digital-fixture.mjs proof               setup, then per kind buy + settle, then teardown + verify
//   node production-digital-fixture.mjs setup               publish the listings and set their delivery
//   node production-digital-fixture.mjs buy <kind>          buyer checkout, Pay, wait for the operator's payment
//   node production-digital-fixture.mjs settle <kind>       delivery checks for a paid order
//   node production-digital-fixture.mjs teardown            delete listings and ciphertext, revoke run sessions, verify
//   node production-digital-fixture.mjs verify              verification only
//
// Env: PROOF_EVIDENCE (state and results; outside the repository), seats and both PROOF_*_PREFIX values (see
// seats.mjs), EXPECTED_DPL, PROOF_DIGITAL_GO, PROOF_DIGITAL_KINDS (default file), PROOF_DIGITAL_PRICE_USD (default
// 2.00), PROOF_DIGITAL_PAY_TIMEOUT_MIN (default 25), PROOF_DIGITAL_BUYER_EMAIL (required for the email kind: a
// mailbox the tester controls; never logged or written), PROOF_ORIGIN, PROOF_SERVICE, PROOF_NEXUS, PROOF_RELAY,
// PROOF_FIXTURE_PHOTO.
// Exit 0 only when every check passed. Paid orders cannot be deleted; they stay as the proof's evidence.
// Runbook: docs/ecommerce/release.md, "Paid digital delivery proof".
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  DELIVERABLES_PREFIX,
  describePlan,
  DIGITAL_KINDS,
  expectedCheckoutLine,
  expectedCurrentSummary,
  formatSizeLabel,
  hasGoAhead,
  isInstantKind,
  KIND_RADIO_LABEL,
  listingTitle,
  makeFixtureFile,
  newDeliverablePaths,
  newRunId,
  parseKinds,
  parsePayTimeoutMinutes,
  parsePriceUsd,
  pathFromPubkyUrl,
  payOutcome,
  priceClearsMinimum,
  redactEmail,
  sha256Hex,
} from './digital-proof.mjs';
import { evidenceDir, loadBuyerSeat, loadSellerSeat, prefix, repoRequire, shopCapabilities } from './seats.mjs';

const { chromium } = repoRequire('playwright');
const { AuthFlowKind, Pubky } = repoRequire('@synonymdev/pubky');

const ORIGIN = process.env.PROOF_ORIGIN ?? 'https://shop.pubky.app';
const SERVICE = process.env.PROOF_SERVICE ?? 'https://marketplace-service-production-ce23.up.railway.app';
const NEXUS = process.env.PROOF_NEXUS ?? 'https://nexusd-production-7108.up.railway.app';
const RELAY = process.env.PROOF_RELAY ?? 'https://httprelay.pubky.app/inbox';
const FX_FEED = process.env.PROOF_FX_FEED ?? 'https://api1.blocktank.to/api/fx/rates/btc';
const PHOTO = process.env.PROOF_FIXTURE_PHOTO ?? join(dirname(fileURLToPath(import.meta.url)), 'fixture-photo.png');
const CLIENT_ID = 'release-proof-digital';

const mode = process.argv[2] ?? '';
const kindArg = process.argv[3] ?? '';
const MODES = ['plan', 'proof', 'setup', 'buy', 'settle', 'teardown', 'verify'];
if (!MODES.includes(mode)) throw new Error(`usage: production-digital-fixture.mjs ${MODES.join('|')} [kind]`);
if ((mode === 'buy' || mode === 'settle') && !DIGITAL_KINDS.includes(kindArg)) {
  throw new Error(`usage: production-digital-fixture.mjs ${mode} <${DIGITAL_KINDS.join('|')}>`);
}

const kinds = parseKinds(process.env.PROOF_DIGITAL_KINDS);
const price = parsePriceUsd(process.env.PROOF_DIGITAL_PRICE_USD);
const payTimeoutMs = parsePayTimeoutMinutes(process.env.PROOF_DIGITAL_PAY_TIMEOUT_MIN) * 60_000;
const buyerEmail = process.env.PROOF_DIGITAL_BUYER_EMAIL ?? '';
const spends = ['proof', 'setup', 'buy', 'settle'].includes(mode);

if (mode === 'plan') {
  console.log(describePlan({ kinds, priceText: price.text, origin: ORIGIN, service: SERVICE }).join('\n'));
  console.log(
    "go-ahead needed to run: PROOF_DIGITAL_GO=GO-<today, UTC, YYYY-MM-DD>, set only on the product owner's instruction; it expires at the end of that UTC day",
  );
  if (!process.env.EXPECTED_DPL) console.log('NOTE: EXPECTED_DPL is not set; a run needs it');
  if (kinds.includes('email') && !buyerEmail)
    console.log('NOTE: PROOF_DIGITAL_BUYER_EMAIL is not set; the email kind needs it');
  process.exit(0);
}
if (spends && !hasGoAhead(process.env)) {
  throw new Error(
    "refusing to start: this run spends real money. PROOF_DIGITAL_GO must be GO-<today's UTC date>, and is set only on the product owner's go-ahead",
  );
}
if (spends && !process.env.EXPECTED_DPL) throw new Error('set EXPECTED_DPL to the dpl_… id now aliased to the origin');
if (spends && (!process.env.PROOF_SELLER_PREFIX || !process.env.PROOF_BUYER_PREFIX)) {
  throw new Error('set PROOF_SELLER_PREFIX and PROOF_BUYER_PREFIX: a paid run must not start on a swapped seat');
}
if (spends && (kinds.includes('email') || kindArg === 'email') && !buyerEmail) {
  throw new Error('set PROOF_DIGITAL_BUYER_EMAIL to the tester mailbox for the email kind');
}
if (spends && !existsSync(PHOTO)) throw new Error(`fixture photo missing: ${PHOTO}`);

const CAPABILITIES = shopCapabilities();
const OUT = evidenceDir();
const STATE_PATH = join(OUT, 'digital-fixture-state.json');
const FILE_PATH = join(OUT, 'digital-fixture-file.bin');

const redact = (text) =>
  redactEmail(String(text ?? ''), buyerEmail).replace(/\b([13-9a-km-uw-z]{8})[13-9a-km-uw-z]{44}\b/g, '$1…');
const log = (line) => console.log(redact(line));

const seller = loadSellerSeat();
const buyer = loadBuyerSeat();
const sellerPubky = seller.publicKey.z32();
const buyerPubky = buyer.publicKey.z32();
if (sellerPubky === buyerPubky) throw new Error('the seller and buyer seats are the same identity');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: redact(detail) });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(ok);
};
const notes = [];
const note = (name, detail) => {
  notes.push({ name, detail: redact(detail) });
  log(`NOTE ${name} — ${detail}`);
};

const readState = () => (existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : null);
const writeState = (state) => {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(STATE_PATH, 0o600);
};
const listingPath = (id) => `/marketplace/listing/${sellerPubky}/${id}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function operator(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error(`an operator step is needed and there is no terminal to answer it: ${prompt}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    log(`\n>>> OPERATOR: ${prompt}`);
    await rl.question('>>> press Enter when done, or Ctrl-C to stop (teardown still runs on the next teardown): ');
  } finally {
    rl.close();
  }
}

// ---- browser helpers ---------------------------------------------------------------------------

async function openBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await context.newPage();
  const commands = [];
  page.on('response', (response) => {
    const request = response.request();
    if (request.method() !== 'POST' || !/\/v1\/commands/.test(new URL(request.url()).pathname)) return;
    const kind = ((request.postData() || '').match(/"kind"\s*:\s*"([^"]+)"/) || [])[1] || 'unknown';
    commands.push({ kind, status: response.status() });
  });
  return { browser, page, commands };
}

async function waitForAppReady(page) {
  await page.waitForFunction(
    () =>
      !/^\s*Loading\.{0,3}\s*$/.test(document.body?.innerText ?? '') && (document.body?.innerText ?? '').length > 40,
    null,
    { timeout: 180_000 },
  );
}

async function copyAuthUrl(page, label) {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByRole('button', { name: label }).first().click();
  const handle = await page.waitForFunction(
    async () => {
      const text = await navigator.clipboard.readText();
      return text.startsWith('pubkyauth://') ? text : null;
    },
    null,
    { timeout: 20_000 },
  );
  return handle.jsonValue();
}

async function ringSignIn(page, seat) {
  await page.goto(`${ORIGIN}/sign-in`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await waitForAppReady(page);
  await new Pubky().signer(seat).approveAuthRequest(await copyAuthUrl(page, 'Copy authentication link'));
  await page.waitForFunction(
    (expected) => {
      const raw = localStorage.getItem('auth-store');
      const state = raw ? (JSON.parse(raw).state ?? {}) : {};
      return state.currentUserPubky === expected && typeof state.sessionExport === 'string';
    },
    seat.publicKey.z32(),
    { timeout: 180_000 },
  );
  await page.waitForTimeout(2500);
}

async function approveMarketplaceSession(page, seat) {
  for (let i = 0; i < 4; i += 1) {
    if (
      !(await page
        .getByRole('dialog')
        .isVisible()
        .catch(() => false))
    )
      break;
    const copy = page.getByRole('button', { name: /Copy (authentication|authorization) link/i }).first();
    if (!(await copy.isVisible().catch(() => false))) break;
    const label = ((await copy.innerText()).match(/Copy (?:authentication|authorization) link/i) || [
      'Copy authorization link',
    ])[0];
    await new Pubky().signer(seat).approveAuthRequest(await copyAuthUrl(page, label));
    await page.waitForTimeout(5000);
  }
}

async function signOut(page) {
  await page.goto(`${ORIGIN}/settings/account`, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  const button = page.locator('#sign-out-btn');
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  await button.click();
  await page.waitForURL(/\/sign-in/, { timeout: 60_000 }).catch(() => {});
  const raw = await page.evaluate(() => localStorage.getItem('auth-store'));
  return raw === null || !JSON.parse(raw)?.state?.currentUserPubky;
}

async function pickCategoryLeaf(page) {
  const trigger = page.locator('#marketplace-category-level-0');
  await trigger.waitFor({ state: 'visible', timeout: 60_000 });
  await trigger.click();
  const everything = page.getByRole('option', { name: 'Everything else' });
  if (await everything.count()) await everything.click();
  else await page.getByRole('option').first().click();
  await page.waitForTimeout(400);
  for (let depth = 1; depth < 6; depth += 1) {
    const next = page.locator(`#marketplace-category-level-${depth}`);
    if (!(await next.count()) || !(await next.isVisible().catch(() => false))) break;
    await next.click();
    const opts = page.getByRole('option');
    if ((await opts.count()) === 0) break;
    await opts.first().click();
    await page.waitForTimeout(400);
  }
}

async function emptyCart(page) {
  await page.goto(`${ORIGIN}/marketplace/cart`, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  for (let n = 0; n < 8; n += 1) {
    const remove = page.getByRole('button', { name: /^Remove / }).first();
    if (!(await remove.count())) break;
    await remove.click();
    await page.waitForTimeout(700);
  }
  return page.getByRole('button', { name: /^Remove / }).count();
}

// ---- service helpers ---------------------------------------------------------------------------

async function nexusListingsByTitle(title) {
  const res = await fetch(`${NEXUS}/v0/stream/listings?seller_id=${encodeURIComponent(sellerPubky)}&limit=50`);
  const rows = res.ok ? await res.json().catch(() => []) : [];
  return {
    status: res.status,
    ids: (Array.isArray(rows) ? rows : []).filter((row) => row?.title === title).map((row) => row.id),
  };
}

async function mintBearer(seat) {
  const client = new Pubky();
  const flow = client.startCookieAuthFlow(CAPABILITIES, AuthFlowKind.signin(), RELAY);
  const tokenPromise = flow.awaitToken();
  await client.signer(seat).approveAuthRequest(flow.authorizationUrl);
  const token = await tokenPromise;
  const response = await fetch(`${SERVICE}/v1/auth/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: token.toBytes(),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 201) throw new Error(`bearer mint HTTP ${response.status}`);
  return { token: body.token, sessionId: body.session_id };
}

const revokeSession = async (bearer, id) =>
  (
    await fetch(`${SERVICE}/v1/auth/sessions/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bearer}` },
    })
  ).status;

async function listSessions(bearer) {
  const res = await fetch(`${SERVICE}/v1/auth/sessions`, { headers: { authorization: `Bearer ${bearer}` } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, sessions: body.sessions ?? [] };
}

async function revokeRunSessions(seat, runStart) {
  const fromRun = (row) =>
    !row.revoked_at && Date.parse(row.created_at) >= runStart - 5000 && Date.parse(row.expires_at) > Date.now();
  const audit = await mintBearer(seat);
  const before = await listSessions(audit.token);
  const rows = before.sessions
    .filter(fromRun)
    .sort((a, b) => Number(a.id === audit.sessionId) - Number(b.id === audit.sessionId));
  const statuses = [];
  for (const row of rows) statuses.push(await revokeSession(audit.token, row.id));
  return { listStatus: before.status, statuses };
}

// The ciphertext the seller's homeserver holds under the deliverables folder, as absolute paths.
async function listDeliverables() {
  const session = await new Pubky().signer(seller).signinBlocking(CLIENT_ID);
  try {
    const urls = await session.storage.list(DELIVERABLES_PREFIX, null, false, 1000, false);
    return urls.map(pathFromPubkyUrl).filter(Boolean);
  } finally {
    await session.signout().catch(() => {});
  }
}

async function deleteDeliverables(paths) {
  if (paths.length === 0) return 0;
  const session = await new Pubky().signer(seller).signinBlocking(CLIENT_ID);
  let deleted = 0;
  try {
    for (const path of paths) {
      if (!path.startsWith(DELIVERABLES_PREFIX)) throw new Error('refusing to delete outside the deliverables folder');
      await session.storage.delete(path);
      deleted += 1;
    }
  } finally {
    await session.signout().catch(() => {});
  }
  return deleted;
}

async function serviceCapability() {
  const response = await fetch(`${SERVICE}/health`);
  const body = await response.json().catch(() => ({}));
  return {
    status: response.status,
    available: body.digital_delivery_available === true,
    max: body.digital_delivery_max_bytes,
  };
}

async function btcUsd() {
  try {
    const response = await fetch(FX_FEED);
    const body = await response.json();
    const rate = Number(body?.USD ?? body?.usd ?? body?.rates?.USD ?? body?.rate);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

// ---- seller: listing and delivery --------------------------------------------------------------

async function fillDigitalListing(page, title) {
  await page.goto(`${ORIGIN}/marketplace/sell`, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  const discard = page.getByRole('button', { name: 'Discard draft and start fresh' });
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.waitForTimeout(1500);
  }
  await approveMarketplaceSession(page, seller);
  await page.locator('[data-surface="seller-studio"] input[type="file"]').first().setInputFiles(PHOTO);
  await page.getByRole('button', { name: /Add photos \(1\/8\)/ }).waitFor({ state: 'visible', timeout: 120_000 });
  await page.getByLabel(/^Photo 1 description$/i).fill('Digital delivery proof fixture cover photo');
  await page.getByLabel(/^Title$/i).fill(title);
  await page.getByLabel(/^Description$/i).fill('Paid delivery proof fixture. Do not purchase.');
  await pickCategoryLeaf(page);
  await page.locator('#listing-section-price').scrollIntoViewIfNeeded();
  const priceField = page.getByLabel(/^Price \(USD\)$/i).first();
  await priceField.fill(price.text);
  await page.locator('#listing-section-shipping').scrollIntoViewIfNeeded();
  const fieldset = page.getByTestId('listing-delivery-options');
  await fieldset.waitFor({ state: 'visible', timeout: 60_000 });
  const digital = fieldset.getByRole('checkbox', { name: 'Digital delivery' });
  if (!(await digital.isChecked())) await digital.click();
  for (const name of ['Ship', 'Local pickup']) {
    const box = fieldset.getByRole('checkbox', { name });
    if (await box.isChecked().catch(() => false)) await box.click();
  }
  const unlimited = page.getByLabel('Unlimited').first();
  await unlimited.waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await unlimited.isChecked())) await unlimited.click();
  await page
    .getByRole('link', { name: /Review & publish/i })
    .first()
    .click();
  await page.waitForTimeout(800);
  await page.waitForFunction(
    () => {
      const button = [...document.querySelectorAll('button')].find(
        (el) => el.textContent?.trim() === 'Publish listing',
      );
      return Boolean(button && !button.disabled);
    },
    null,
    { timeout: 180_000 },
  );
}

async function setDelivery(page, kind, fixture) {
  const editor = page.locator('[data-surface="digital-delivery-editor"]');
  await editor.waitFor({ state: 'visible', timeout: 120_000 });
  await editor.getByRole('radio', { name: KIND_RADIO_LABEL[kind] }).waitFor({ state: 'visible', timeout: 120_000 });
  await editor.getByRole('radio', { name: KIND_RADIO_LABEL[kind] }).click();
  const detail = {};
  if (kind === 'file') {
    await editor.getByTestId('digital-delivery-file-input').setInputFiles({
      name: fixture.name,
      mimeType: 'application/octet-stream',
      buffer: fixture.bytes,
    });
    await editor.getByTestId('digital-delivery-chosen-file').waitFor({ state: 'visible', timeout: 30_000 });
  } else if (kind === 'link') {
    detail.url = `https://example.com/digital-proof/${randomBytes(6).toString('hex')}`;
    await editor.getByLabel('Link', { exact: true }).fill(detail.url);
  } else if (kind === 'text') {
    detail.text = `PROOF-${randomBytes(9).toString('hex')}`;
    await editor.getByLabel('Text every buyer receives').fill(detail.text);
  }
  await editor.getByRole('button', { name: 'Save delivery' }).click();
  const expected = expectedCurrentSummary(kind, fixture.name, formatSizeLabel(fixture.bytes.length));
  const saved = await page
    .getByTestId('digital-delivery-current')
    .getByText(expected, { exact: true })
    .waitFor({ state: 'visible', timeout: 180_000 })
    .then(
      () => true,
      () => false,
    );
  const error = await editor
    .getByTestId('digital-delivery-error')
    .innerText()
    .catch(() => '');
  return { saved, error, ...detail };
}

async function setup() {
  if (readState()) throw new Error('a digital fixture state file exists; run teardown before setting up again');
  const runId = newRunId();
  const runStart = Date.now();
  const fixture = makeFixtureFile(runId);
  writeFileSync(FILE_PATH, fixture.bytes, { mode: 0o600 });
  const capability = await serviceCapability();
  check(
    'setup: service reports digital delivery available',
    capability.status === 200 && capability.available,
    `status=${capability.status} max=${capability.max}`,
  );
  if (!(capability.status === 200 && capability.available))
    throw new Error('digital delivery is not available on the service');
  const rate = await btcUsd();
  if (rate === null) note('price floor', 'the BTC/USD rate could not be read; the 1,000-sat floor was not pre-checked');
  else {
    check(
      'setup: the price clears the service floor of 1,000 sats with a 2x margin',
      priceClearsMinimum(price.cents, rate),
      `price=${price.text} rate=${Math.round(rate)}`,
    );
    if (!priceClearsMinimum(price.cents, rate)) throw new Error('raise PROOF_DIGITAL_PRICE_USD');
  }
  const deliverablesBefore = await listDeliverables();
  let state = {
    runId,
    runStart,
    price: price.text,
    fixture: { name: fixture.name, sha256: fixture.sha256, size: fixture.bytes.length },
    kinds,
    deliverablesBefore,
    listings: {},
    orders: {},
    phase: 'started',
  };
  writeState(state);
  const { browser, page } = await openBrowser();
  try {
    await ringSignIn(page, seller);
    log(`setup: seller ${prefix(sellerPubky)} run ${runId}`);
    for (const kind of kinds) {
      const title = listingTitle(runId, kind);
      state.listings[kind] = { title, id: null, delivery: null };
      writeState(state);
      await fillDigitalListing(page, title);
      await page.getByRole('button', { name: 'Publish listing' }).click();
      await approveMarketplaceSession(page, seller);
      let listingId = null;
      try {
        await page.waitForURL(/\/marketplace\/listing\/[^/]+\/[^/]+\/edit/, { timeout: 180_000 });
        listingId = new URL(page.url()).pathname.split('/').filter(Boolean).slice(-2)[0];
      } catch {
        for (let i = 0; i < 6 && !listingId; i += 1) {
          await sleep(10_000);
          listingId = (await nexusListingsByTitle(title)).ids[0] ?? null;
        }
      }
      if (!listingId)
        throw new Error(`published ${kind} listing not found (the state file keeps the title for teardown)`);
      state.listings[kind].id = listingId;
      writeState(state);
      if (!/\/edit/.test(page.url())) {
        await page.goto(`${ORIGIN}${listingPath(listingId)}/edit`, { waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
      }
      await approveMarketplaceSession(page, seller);
      const result = await setDelivery(page, kind, fixture);
      check(
        `setup ${kind}: delivery saved on the edit page`,
        result.saved && !result.error,
        result.error || listingId.slice(0, 8),
      );
      if (!result.saved) throw new Error(`delivery for ${kind} did not save`);
      state.listings[kind].delivery = { url: result.url ?? null, text: result.text ?? null };
      writeState(state);
      await page.screenshot({ path: join(OUT, `digital-setup-${kind}.png`) });
      log(`setup ${kind}: listing ${listingId.slice(0, 8)}`);
    }
    state = {
      ...state,
      phase: 'ready',
      deliverablePaths: newDeliverablePaths(deliverablesBefore, await listDeliverables()),
    };
    writeState(state);
    if (kinds.includes('file')) {
      check(
        'setup: the file ciphertext is on the seller homeserver',
        state.deliverablePaths.length >= 1,
        `new=${state.deliverablePaths.length}`,
      );
    }
    await signOut(page).catch(() => false);
  } finally {
    await browser.close();
  }
}

// ---- buyer: checkout, payment wait -------------------------------------------------------------

async function ordersCard(page, title) {
  await page.goto(`${ORIGIN}/marketplace/orders`, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  await page.locator('[data-surface="marketplace-orders"]').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(2500);
  const all = page.getByRole('button', { name: /^All/ }).first();
  if (await all.count()) {
    await all.click();
    await page.waitForTimeout(800);
  }
  return page.locator('[id^="order-"]').filter({ hasText: title }).first();
}

async function buy(kind) {
  const state = readState();
  const listing = state?.listings?.[kind];
  if (!listing?.id) throw new Error(`no published ${kind} listing in the state file; run setup first`);
  const dpl = ((await (await fetch(`${ORIGIN}/marketplace`)).text()).match(/dpl_[A-Za-z0-9]+/) || [])[0] || null;
  check(`buy ${kind}: the expected deployment is live`, dpl === process.env.EXPECTED_DPL, String(dpl));
  if (dpl !== process.env.EXPECTED_DPL) throw new Error('production is not serving EXPECTED_DPL');
  const { browser, page, commands } = await openBrowser();
  try {
    await ringSignIn(page, buyer);
    log(`buy ${kind}: buyer ${prefix(buyerPubky)} signed in`);
    await emptyCart(page);
    await page.goto(`${ORIGIN}${listingPath(listing.id)}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await waitForAppReady(page);
    const add = page.getByRole('button', { name: 'Add to cart', exact: true }).first();
    const addOk = await add.waitFor({ state: 'visible', timeout: 60_000 }).then(
      () => true,
      () => false,
    );
    if (!check(`buy ${kind}: Add to cart is enabled for the buyer`, addOk && (await add.isEnabled()))) {
      throw new Error('the buyer cannot add the listing');
    }
    await add.click();
    await page.waitForTimeout(1200);
    await page.goto(`${ORIGIN}/marketplace/cart`, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    const go = page.getByTestId('marketplace-cart-checkout').first();
    await go.waitFor({ state: 'visible', timeout: 30_000 });
    await go.click();
    await page.waitForURL(/\/marketplace\/checkout/, { timeout: 30_000 });
    await waitForAppReady(page);
    await approveMarketplaceSession(page, buyer);

    const line = page.getByTestId('checkout-digital-line').first();
    await line.waitFor({ state: 'visible', timeout: 60_000 });
    const lineText = (await line.innerText()).replace(/^Digital delivery\s*·\s*/, '').trim();
    check(`buy ${kind}: checkout names how it arrives`, expectedCheckoutLine(kind).test(lineText), lineText);
    check(
      `buy ${kind}: no shipping address is asked for`,
      (await page.getByText('No shipping for digital items.').count()) >= 1 &&
        (await page.getByText(/shipping address/i).count()) === 0,
    );
    const emailSection = page.locator('[data-surface="checkout-delivery-email"]');
    if (kind === 'email') {
      await emailSection.waitFor({ state: 'visible', timeout: 30_000 });
      await emailSection.getByLabel('Email', { exact: true }).fill(buyerEmail);
    } else {
      check(`buy ${kind}: no delivery email is asked for`, (await emailSection.count()) === 0);
    }
    check(
      `buy ${kind}: the consent line matches the kind`,
      (await page.getByTestId(isInstantKind(kind) ? 'checkout-consent-instant' : 'checkout-consent-manual').count()) ===
        1,
    );
    await page
      .waitForFunction(() => !document.querySelector('[aria-label="Loading payment methods"]'), null, {
        timeout: 60_000,
      })
      .catch(() => {});
    const bitcoin = page.getByTestId('marketplace-checkout-method-bitcoin').first();
    const bitcoinOk = await bitcoin.waitFor({ state: 'visible', timeout: 60_000 }).then(
      () => true,
      () => false,
    );
    if (!check(`buy ${kind}: Bitcoin is offered`, bitcoinOk)) throw new Error('Bitcoin is not offered at checkout');
    await bitcoin.click();
    check(`buy ${kind}: Bitcoin is selected`, (await bitcoin.getAttribute('aria-pressed')) === 'true');
    const summary = await page.getByTestId('marketplace-checkout-summary').innerText();
    check(
      `buy ${kind}: the order total is the proof price`,
      summary.includes(`$${state.price}`),
      `expected $${state.price}`,
    );
    await page.screenshot({ path: join(OUT, `digital-checkout-${kind}.png`) });
    const pay = page.getByTestId('marketplace-checkout-pay');
    check(`buy ${kind}: Pay is enabled`, await pay.isEnabled());
    if (!(await pay.isEnabled())) throw new Error('Pay is disabled');

    const before = commands.length;
    await pay.click();
    await approveMarketplaceSession(page, buyer);
    await page.getByTestId('marketplace-checkout-paying').waitFor({ state: 'visible', timeout: 180_000 });
    const payCommands = commands.slice(before).map((row) => `${row.kind}:${row.status}`);
    log(`buy ${kind}: Pay sent ${JSON.stringify(payCommands)}`);
    await page.waitForTimeout(8000);
    await page.screenshot({ path: join(OUT, `digital-paying-${kind}.png`) });
    const paying = (await page.getByTestId('marketplace-checkout-paying').innerText())
      .replace(/\s+/g, ' ')
      .slice(0, 700);
    log(
      `\n>>> OPERATOR: pay the Bitkit Payment Request for "${listing.title}" from the buyer wallet (seller must be a Bitkit contact). Checkout shows: ${paying}`,
    );

    const started = Date.now();
    let outcome = 'waiting';
    let cardId = null;
    while (outcome === 'waiting') {
      await sleep(20_000);
      const card = await ordersCard(page, listing.title);
      const paid = (await card.count()) > 0 && (await card.getByTestId('order-receipt-details').count()) > 0;
      if ((await card.count()) > 0) cardId = (await card.getAttribute('id'))?.replace(/^order-/, '') ?? cardId;
      outcome = payOutcome({ paid, elapsedMs: Date.now() - started, timeoutMs: payTimeoutMs });
      log(`buy ${kind}: waiting for payment, ${Math.round((Date.now() - started) / 1000)}s, ${outcome}`);
    }
    state.orders[kind] = { id: cardId, outcome, paidAfterSeconds: Math.round((Date.now() - started) / 1000) };
    writeState(state);
    check(
      `buy ${kind}: the order was paid before the timeout`,
      outcome === 'paid',
      `order=${(cardId ?? '').slice(0, 8)} ${state.orders[kind].paidAfterSeconds}s`,
    );
    if (outcome !== 'paid') {
      note(
        `buy ${kind}`,
        'not paid in time; the order expires on its own. If money moved late it takes the late-payment path (manual review or refund): check the order before teardown',
      );
      throw new Error('payment timeout');
    }
    await page.screenshot({ path: join(OUT, `digital-paid-${kind}.png`) });
    await emptyCart(page);
    await signOut(page).catch(() => false);
  } finally {
    await browser.close();
  }
}

// ---- both sides: delivery checks ---------------------------------------------------------------

async function buyerPanel(page, title) {
  const card = await ordersCard(page, title);
  await card.waitFor({ state: 'visible', timeout: 60_000 });
  const panel = card.locator('[data-surface="order-digital-panel"]');
  await panel.waitFor({ state: 'visible', timeout: 60_000 });
  return { panel };
}

async function sellerCard(page, title) {
  const card = await ordersCard(page, title);
  await card.waitFor({ state: 'visible', timeout: 60_000 });
  return card;
}

async function settle(kind) {
  const state = readState();
  const listing = state?.listings?.[kind];
  if (!listing?.id || state.orders?.[kind]?.outcome !== 'paid')
    throw new Error(`no paid ${kind} order in the state file`);
  const buyerSession = await openBrowser();
  try {
    const { page } = buyerSession;
    await ringSignIn(page, buyer);
    let { panel } = await buyerPanel(page, listing.title);
    await page.screenshot({ path: join(OUT, `digital-order-${kind}-before.png`) });
    if (kind === 'file') {
      const hashes = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 180_000 }),
          panel.getByRole('button', { name: 'Download' }).click(),
        ]);
        const path = await download.path();
        hashes.push({ name: download.suggestedFilename(), sha256: sha256Hex(readFileSync(path)) });
        await page.waitForTimeout(2000);
        ({ panel } = await buyerPanel(page, listing.title));
      }
      check(
        'settle file: the downloaded bytes match the fixture SHA-256, twice',
        hashes.every((h) => h.sha256 === state.fixture.sha256),
        hashes.map((h) => h.sha256.slice(0, 12)).join(','),
      );
      check(
        'settle file: the download keeps the file name',
        hashes.every((h) => h.name === state.fixture.name),
        hashes[0]?.name ?? '',
      );
    } else if (kind === 'link') {
      await panel.getByRole('button', { name: 'Show link' }).click();
      const href = await panel.getByRole('link', { name: /Open link/ }).getAttribute('href');
      check('settle link: the revealed link equals the one the seller set', href === listing.delivery.url);
    } else if (kind === 'text') {
      await panel.getByRole('button', { name: 'Reveal text' }).click();
      const text = await panel.getByTestId('order-digital-text').innerText();
      check('settle text: the revealed text equals the one the seller set', text.trim() === listing.delivery.text);
    } else if (kind === 'email') {
      const line = await panel.innerText();
      check(
        'settle email: the buyer sees the address the seller will email',
        line.includes(`The seller will email this to ${buyerEmail}`),
      );
    } else {
      const line = await panel.innerText();
      check(
        'settle message: the buyer is told the seller will send it in messages',
        line.includes('The seller will send this in your messages.'),
      );
    }
    await signOut(page).catch(() => false);
  } finally {
    await buyerSession.browser.close();
  }

  const sellerSession = await openBrowser();
  try {
    const { page } = sellerSession;
    await ringSignIn(page, seller);
    const card = await sellerCard(page, listing.title);
    const sellerPanel = card.locator('[data-surface="order-seller-digital-panel"]');
    await sellerPanel.waitFor({ state: 'visible', timeout: 60_000 });
    if (isInstantKind(kind)) {
      const evidence = await sellerPanel.getByTestId('seller-digital-evidence').count();
      check(
        `settle ${kind}: the seller sees delivery evidence of the buyer's access`,
        evidence >= 1,
        `lines=${evidence}`,
      );
    } else if (kind === 'email') {
      await sellerPanel.getByRole('button', { name: 'Show email' }).click();
      const shown = await sellerPanel.getByTestId('seller-delivery-email').innerText();
      check('settle email: the seller sees the buyer address after payment', shown.trim() === buyerEmail);
      await operator(
        `email something from the seller's mailbox to the tester mailbox now, quoting order ${(state.orders.email.id ?? '').slice(0, 8)}; the tester confirms it arrived`,
      );
      await sellerPanel.getByRole('button', { name: 'Mark emailed' }).click();
      const marked = await sellerPanel
        .getByText('Marked emailed.', { exact: false })
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(
          () => true,
          () => false,
        );
      check('settle email: Mark emailed is accepted', marked);
    } else {
      await operator(
        `send the buyer a message in chat from the seller account (Ring) for order ${(state.orders.message.id ?? '').slice(0, 8)}; the tester confirms it arrived`,
      );
      await sellerPanel.getByRole('button', { name: 'Mark delivered' }).click();
      const marked = await sellerPanel
        .getByText('Marked delivered.', { exact: false })
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(
          () => true,
          () => false,
        );
      check('settle message: Mark delivered is accepted', marked);
    }
    await page.screenshot({ path: join(OUT, `digital-seller-${kind}.png`) });
    await signOut(page).catch(() => false);
  } finally {
    await sellerSession.browser.close();
  }

  if (!isInstantKind(kind)) {
    const again = await openBrowser();
    try {
      await ringSignIn(again.page, buyer);
      const { panel } = await buyerPanel(again.page, listing.title);
      const text = await panel.innerText();
      if (kind === 'email')
        check('settle email: the buyer sees "Emailed to" with the date', /Emailed to .* on /.test(text));
      else
        check(
          'settle message: the buyer sees the delivered line',
          text.includes('The seller marked this delivered. Check your messages.'),
        );
      await again.page.screenshot({ path: join(OUT, `digital-order-${kind}-after.png`) });
      await signOut(again.page).catch(() => false);
    } finally {
      await again.browser.close();
    }
  }
  state.orders[kind] = { ...state.orders[kind], settled: true };
  writeState(state);
}

// ---- teardown and verification -----------------------------------------------------------------

async function teardown() {
  const state = readState();
  if (!state) {
    log('teardown: no state file; nothing was set up, so nothing is changed');
    return;
  }
  const { browser, page } = await openBrowser();
  try {
    await ringSignIn(page, seller);
    const entries = Object.entries(state.listings ?? {});
    for (const [kind, listing] of entries) {
      let ids = listing.id ? [listing.id] : [];
      if (listing.title && ids.length === 0) ids = (await nexusListingsByTitle(listing.title)).ids;
      for (const id of ids) {
        await page.goto(`${ORIGIN}${listingPath(id)}`, { waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await approveMarketplaceSession(page, seller);
        const openDelete = page.getByRole('button', { name: /^Delete$/i }).first();
        if (await openDelete.isVisible().catch(() => false)) {
          await openDelete.click();
          await page.getByRole('button', { name: 'Delete listing', exact: true }).click();
          await page.waitForTimeout(5000);
          log(`teardown ${kind}: deleted listing ${id.slice(0, 8)}`);
        } else log(`teardown ${kind}: no Delete control on ${id.slice(0, 8)} (already gone or not owned)`);
      }
      listing.ids = ids;
    }
    await signOut(page).catch(() => false);
  } finally {
    await browser.close();
  }
  const current = state.deliverablesBefore
    ? newDeliverablePaths(state.deliverablesBefore, await listDeliverables())
    : [];
  const unsettled = Object.entries(state.orders ?? {}).filter(
    ([, order]) => order.outcome === 'paid' && !order.settled,
  );
  if (unsettled.length > 0) {
    note(
      'teardown',
      `paid orders not yet settled (${unsettled.map(([kind]) => kind).join(', ')}): their ciphertext is deleted now, so a buyer download after this fails`,
    );
  }
  const removed = await deleteDeliverables(current);
  check('teardown: ciphertext created by the run deleted', removed === current.length, `deleted=${removed}`);
  writeState({ ...state, phase: 'torn-down', deliverablePaths: current });
  for (const [name, seat] of [
    ['seller', seller],
    ['buyer', buyer],
  ]) {
    try {
      const { listStatus, statuses } = await revokeRunSessions(seat, state.runStart);
      check(
        `teardown: ${name} run sessions revoked`,
        listStatus === 200 && statuses.every((s) => s === 200 || s === 204),
        `revoked=${statuses.length}`,
      );
    } catch (error) {
      check(`teardown: ${name} run sessions revoked`, false, String(error?.message ?? error).slice(0, 160));
    }
  }
}

async function verify() {
  const state = readState();
  if (!state) {
    log('verify: no state file; nothing to verify');
    return;
  }
  await sleep(10_000);
  const bearer = await mintBearer(seller);
  const { browser, page } = await openBrowser();
  try {
    for (const [kind, listing] of Object.entries(state.listings ?? {})) {
      const stream = await nexusListingsByTitle(listing.title);
      check(
        `verify ${kind}: no fixture listing in the seller stream`,
        stream.status === 200 && stream.ids.length === 0,
        `status=${stream.status} left=${stream.ids.length}`,
      );
      for (const id of listing.ids ?? (listing.id ? [listing.id] : [])) {
        const detail = await fetch(`${NEXUS}/v0/listing/${encodeURIComponent(sellerPubky)}/${encodeURIComponent(id)}`);
        check(`verify ${kind}: nexus detail gone ${id.slice(0, 8)}`, detail.status === 404, `status=${detail.status}`);
        const onHomeserver = await new Pubky().publicStorage
          .exists(`pubky://${sellerPubky}/pub/pubky.app/marketplace/v1/listings/${id}`)
          .catch(() => null);
        check(
          `verify ${kind}: homeserver record gone ${id.slice(0, 8)}`,
          onHomeserver === false,
          `exists=${onHomeserver}`,
        );
        const projection = await fetch(`${SERVICE}/v1/listings/${encodeURIComponent(`listing:${sellerPubky}_${id}`)}`, {
          headers: { authorization: `Bearer ${bearer.token}` },
        });
        check(
          `verify ${kind}: service listing tombstoned ${id.slice(0, 8)}`,
          projection.status === 404,
          `status=${projection.status}`,
        );
        await page.goto(`${ORIGIN}${listingPath(id)}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await page.waitForTimeout(8000);
        const shop = await page.evaluate(
          (title) => ({
            title: [...document.querySelectorAll('h1')].some((node) => node.textContent?.trim() === title),
            addToCart: [...document.querySelectorAll('button')].some(
              (node) => node.textContent?.trim() === 'Add to cart',
            ),
          }),
          listing.title,
        );
        check(
          `verify ${kind}: Shop page no longer sells ${id.slice(0, 8)}`,
          !shop.title && !shop.addToCart,
          JSON.stringify(shop),
        );
      }
    }
  } finally {
    await browser.close();
  }
  for (const path of state.deliverablePaths ?? []) {
    const exists = await new Pubky().publicStorage.exists(`pubky://${sellerPubky}${path}`).catch(() => null);
    check('verify: ciphertext gone from the seller homeserver', exists === false, `exists=${exists}`);
  }
  check('verify: verifier bearer revoked', (await revokeSession(bearer.token, bearer.sessionId)) < 300);
  for (const [name, seat] of [
    ['seller', seller],
    ['buyer', buyer],
  ]) {
    const probe = await mintBearer(seat);
    const { status, sessions } = await listSessions(probe.token);
    const residual = sessions.filter(
      (row) =>
        !row.revoked_at &&
        row.id !== probe.sessionId &&
        Date.parse(row.created_at) >= state.runStart - 5000 &&
        Date.parse(row.expires_at) > Date.now(),
    ).length;
    await revokeSession(probe.token, probe.sessionId);
    check(
      `verify: no ${name} session from the run is active`,
      status === 200 && residual === 0,
      `residual=${residual}`,
    );
  }
  const paid = Object.entries(state.orders ?? {}).filter(([, order]) => order.outcome === 'paid');
  note(
    'paid orders left as evidence',
    paid.map(([kind, order]) => `${kind}=${(order.id ?? '').slice(0, 8)}`).join(' ') || 'none',
  );
}

// ---- entry -------------------------------------------------------------------------------------

let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log(`${signal}: finishing with teardown and verification`);
  });
}

async function tearDownAndVerify() {
  try {
    await teardown();
  } catch (error) {
    check('teardown completed', false, String(error?.message ?? error).slice(0, 240));
  }
  try {
    await verify();
  } catch (error) {
    check('verify completed', false, String(error?.message ?? error).slice(0, 240));
  }
}

try {
  if (mode === 'proof') {
    try {
      await setup();
      for (const kind of kinds) {
        if (interrupted) break;
        try {
          await buy(kind);
        } catch (error) {
          check(`buy ${kind} completed`, false, String(error?.message ?? error).slice(0, 240));
          break;
        }
        try {
          await settle(kind);
        } catch (error) {
          check(`settle ${kind} completed`, false, String(error?.message ?? error).slice(0, 240));
        }
      }
    } catch (error) {
      check(interrupted ? 'interrupted' : 'setup completed', false, String(error?.message ?? error).slice(0, 240));
    } finally {
      await tearDownAndVerify();
    }
  } else if (mode === 'setup') await setup();
  else if (mode === 'buy') await buy(kindArg);
  else if (mode === 'settle') await settle(kindArg);
  else if (mode === 'teardown') await tearDownAndVerify();
  else await verify();
} catch (error) {
  check(`${mode} completed`, false, String(error?.message ?? error).slice(0, 240));
}

const ok = checks.every((row) => row.ok);
writeFileSync(join(OUT, `digital-fixture-${mode}.json`), `${JSON.stringify({ mode, ok, checks, notes }, null, 2)}\n`);
const finalState = readState();
if ((mode === 'proof' || mode === 'teardown' || mode === 'verify') && ok && finalState?.phase === 'torn-down') {
  unlinkSync(STATE_PATH);
  if (existsSync(FILE_PATH)) unlinkSync(FILE_PATH);
}
log(
  `DIGITAL_FIXTURE ${mode} ${ok ? 'OK' : 'FAIL'} checks=${checks.length} failed=${checks.filter((row) => !row.ok).length}`,
);
process.exit(ok ? 0 : 1);
