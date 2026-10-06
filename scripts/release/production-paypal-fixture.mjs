#!/usr/bin/env node
// Production PayPal checkout fixture for the Shop release proof (docs/ecommerce/release.md).
//
// The seller seat gets a temporary PayPal rail and one "TEST, do not buy <run>" listing;
// the buyer seat checks it out up to the payment-method step (Pay is never clicked);
// teardown deletes the listing, restores the seller's PayPal rail to exactly its value before setup,
// revokes every marketplace session either seat gained during the run, and verifies all of it.
// Without a state file (nothing was set up) teardown and verify change and check nothing.
//
//   node production-paypal-fixture.mjs proof      setup → buyer checkout → teardown → verify (always tears down)
//   node production-paypal-fixture.mjs proof -- <cmd...>   same, but runs <cmd> (release-proof.mjs) instead of the
//                                                 built-in checkout, with PROOF_PAYPAL_LISTING_URL set; its exit status is a check
//   node production-paypal-fixture.mjs setup      publish the fixture; prints PROOF_PAYPAL_LISTING_URL=<path>
//   node production-paypal-fixture.mjs checkout   buyer checkout on the fixture from the state file
//   node production-paypal-fixture.mjs teardown   delete listing, restore PayPal, revoke run sessions, then verify
//   node production-paypal-fixture.mjs verify     verification only
//
// Env: PROOF_EVIDENCE (required; state and results are written there), seats (see seats.mjs),
// PAYPAL_TEST_EMAIL (required for setup and proof, and for a teardown that restores it; never logged or
// written to disk), EXPECTED_DPL (optional,
// checked before checkout), PROOF_ORIGIN, PROOF_SERVICE, PROOF_NEXUS, PROOF_RELAY, PROOF_FIXTURE_PHOTO.
// Exit 0 only when every check passed; teardown and verify exit 1 while anything is left behind.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceDir, loadBuyerSeat, loadSellerSeat, prefix, repoRequire, shopCapabilities } from './seats.mjs';

const { chromium } = repoRequire('playwright');
const { AuthFlowKind, Pubky } = repoRequire('@synonymdev/pubky');

const ORIGIN = process.env.PROOF_ORIGIN ?? 'https://shop.pubky.app';
const SERVICE = process.env.PROOF_SERVICE ?? 'https://marketplace-service-production-ce23.up.railway.app';
const NEXUS = process.env.PROOF_NEXUS ?? 'https://nexusd-production-7108.up.railway.app';
const RELAY = process.env.PROOF_RELAY ?? 'https://httprelay.pubky.app/inbox';
const CAPABILITIES = shopCapabilities();
const PHOTO = process.env.PROOF_FIXTURE_PHOTO ?? join(dirname(fileURLToPath(import.meta.url)), 'fixture-photo.png');
const TITLE_BASE = 'TEST, do not buy';

const OUT = evidenceDir();
const STATE_PATH = join(OUT, 'paypal-fixture-state.json');
const email = process.env.PAYPAL_TEST_EMAIL ?? '';
const mode = process.argv[2] ?? '';
const sep = process.argv.indexOf('--');
const wrapped = sep > 2 ? process.argv.slice(sep + 1) : [];
if (!['proof', 'setup', 'checkout', 'teardown', 'verify'].includes(mode)) {
  throw new Error('usage: production-paypal-fixture.mjs proof|setup|checkout|teardown|verify');
}
if ((mode === 'proof' || mode === 'setup') && !email) {
  throw new Error('set PAYPAL_TEST_EMAIL in the environment (it is never written to disk)');
}
if ((mode === 'proof' || mode === 'setup') && !existsSync(PHOTO)) throw new Error(`fixture photo missing: ${PHOTO}`);

const redact = (text) => {
  let out = String(text ?? '');
  if (email) out = out.replaceAll(email, '[redacted-email]');
  return out.replace(/\b([13-9a-km-uw-z]{8})[13-9a-km-uw-z]{44}\b/g, '$1…');
};
const log = (line) => console.log(redact(line));

const seller = loadSellerSeat();
const buyer = loadBuyerSeat();
const sellerPubky = seller.publicKey.z32();

const readState = () => (existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : null);
const writeState = (state) => {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(STATE_PATH, 0o600);
};
const listingPath = (id) => `/marketplace/listing/${sellerPubky}/${id}`;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: redact(detail) });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(ok);
};

// ---- browser helpers ---------------------------------------------------------------------------

async function openBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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

// The field renders only after the seller's own payment config loaded without error, so its value is the
// stored rail ('' when none is set).
async function openPaypalField(page) {
  await page.goto(`${ORIGIN}/marketplace/settings`, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  await approveMarketplaceSession(page, seller);
  const field = page.locator('#get-paid-paypal');
  await field.waitFor({ state: 'visible', timeout: 120_000 });
  return field;
}

const readPaypal = async (page) => (await openPaypalField(page)).inputValue();

async function savePaypal(page, value) {
  await (await openPaypalField(page)).fill(value);
  await page.getByRole('button', { name: 'Save payment settings' }).first().click();
  await page.waitForTimeout(4000);
}

// The prior rail is restored exactly at teardown. When it equals PAYPAL_TEST_EMAIL only a marker is stored,
// so that address never reaches disk; any other prior value lives in the mode-600 state file until teardown.
const encodePriorPaypal = (value) =>
  value === '' ? { kind: 'empty' } : value === email ? { kind: 'test-email' } : { kind: 'value', value };
const decodePriorPaypal = (prior) =>
  prior.kind === 'empty' ? '' : prior.kind === 'test-email' ? email || null : prior.value;

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

async function fillShippingListing(page, title) {
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
  await page.getByLabel(/^Photo 1 description$/i).fill('Release proof fixture cover photo');
  await page.getByLabel(/^Title$/i).fill(title);
  await page.getByLabel(/^Description$/i).fill('Release proof fixture. Do not purchase.');
  await pickCategoryLeaf(page);
  const country = page.getByLabel(/^Country$/i);
  if (await country.count()) await country.fill('US');
  await page.locator('#listing-section-price').scrollIntoViewIfNeeded();
  const priceField = page
    .getByLabel(/^Price \(USD\)$/i)
    .or(page.getByLabel(/^Price \(₿\)$/i))
    .first();
  await priceField.fill(/₿|BTC/i.test((await priceField.getAttribute('aria-label')) || '') ? '1' : '1.00');
  const qty = page.getByLabel(/^Quantity$/i).first();
  if (await qty.count()) await qty.fill('5');
  await page.locator('#listing-section-shipping').scrollIntoViewIfNeeded();
  const fieldset = page.getByTestId('listing-delivery-options');
  await fieldset.waitFor({ state: 'visible', timeout: 60_000 });
  const ship = fieldset.getByRole('checkbox', { name: 'Ship' });
  if (!(await ship.isChecked())) await ship.click();
  for (const name of ['Digital delivery', 'Local pickup']) {
    const box = fieldset.getByRole('checkbox', { name });
    if (await box.isChecked().catch(() => false)) await box.click();
  }
  await page.getByLabel('Free shipping').click();
  await page.getByLabel(/^Weight \(/i).fill('500');
  await page.getByLabel(/^Length \(/i).fill('25');
  await page.getByLabel(/^Width \(/i).fill('20');
  await page.getByLabel(/^Height \(/i).fill('10');
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

// Revokes every live session the seat gained since runStart, the audit bearer last.
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

// ---- modes -------------------------------------------------------------------------------------

async function setup() {
  const runStart = Date.now();
  const title = `${TITLE_BASE} ${randomBytes(3).toString('hex')}`;
  let base = { runStart, listingTitle: title, listingId: null };
  writeState({ ...base, phase: 'paypal-read' });
  const { browser, page } = await openBrowser();
  try {
    log(`setup seller ${prefix(sellerPubky)} title "${title}"`);
    await ringSignIn(page, seller);
    base = { ...base, priorPaypal: encodePriorPaypal(await readPaypal(page)) };
    writeState({ ...base, phase: 'paypal' });
    log(`setup: prior PayPal rail recorded (${base.priorPaypal.kind})`);
    await savePaypal(page, email);
    await fillShippingListing(page, title);
    writeState({ ...base, phase: 'publishing' });
    await page.getByRole('button', { name: 'Publish listing' }).click();
    await approveMarketplaceSession(page, seller);
    let listingId = null;
    try {
      await page.waitForURL(/\/marketplace\/listing\//, { timeout: 180_000 });
      listingId = new URL(page.url()).pathname.split('/').filter(Boolean).pop();
    } catch {
      for (let i = 0; i < 6 && !listingId; i += 1) {
        await page.waitForTimeout(10_000);
        listingId = (await nexusListingsByTitle(title)).ids[0] ?? null;
      }
    }
    if (!listingId) throw new Error('published listing not found (state file keeps the title for teardown)');
    writeState({ ...base, listingId, phase: 'published' });
    log(`setup ok listing ${listingId.slice(0, 8)}`);
    console.log(`PROOF_PAYPAL_LISTING_URL=${listingPath(listingId)}`);
    return listingPath(listingId);
  } finally {
    await browser.close();
  }
}

async function checkout() {
  const state = readState();
  if (!state?.listingId) throw new Error('no published fixture in the state file; run setup first');
  const { browser, page, commands } = await openBrowser();
  try {
    if (process.env.EXPECTED_DPL) {
      const dpl = ((await (await fetch(`${ORIGIN}/marketplace`)).text()).match(/dpl_[A-Za-z0-9]+/) || [])[0] || null;
      check('checkout: expected deployment is live', dpl === process.env.EXPECTED_DPL, String(dpl));
    }
    await ringSignIn(page, buyer);
    log(`buyer ${prefix(buyer.publicKey.z32())} signed in`);
    await emptyCart(page);
    await page.goto(`${ORIGIN}${listingPath(state.listingId)}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await waitForAppReady(page);
    const add = page.getByRole('button', { name: 'Add to cart', exact: true }).first();
    const addVisible = await add.waitFor({ state: 'visible', timeout: 60_000 }).then(
      () => true,
      () => false,
    );
    if (
      check('checkout: fixture listing has an enabled Add to cart for the buyer', addVisible && (await add.isEnabled()))
    ) {
      await add.click();
      await page.waitForTimeout(1200);
      await page.goto(`${ORIGIN}/marketplace/cart`, { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      const go = page.getByTestId('marketplace-cart-checkout').first();
      await go.waitFor({ state: 'visible', timeout: 30_000 });
      const configResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          /\/v0\/sellers\/(?!me\/)[^/]+\/payment-config$/.test(new URL(response.url()).pathname),
        { timeout: 30_000 },
      );
      await go.click();
      await page.waitForURL(/\/marketplace\/checkout/, { timeout: 30_000 });
      await waitForAppReady(page);
      const response = await configResponse.catch(() => null);
      await page
        .waitForFunction(() => !document.querySelector('[aria-label="Loading payment methods"]'), null, {
          timeout: 30_000,
        })
        .catch(() => {});
      await page
        .getByTestId('marketplace-checkout-method-paypal')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => {});
      const loading = await page.locator('[aria-label="Loading payment methods"]').count();
      const retry = await page.getByTestId('marketplace-checkout-methods-retry').count();
      check(
        'checkout: payment-config loaded and loading cleared',
        response?.status() === 200 && loading === 0 && retry === 0,
        `status=${response?.status() ?? 'none'}`,
      );
      check(
        'checkout: PayPal is offered',
        (await page.getByTestId('marketplace-checkout-method-paypal').count()) === 1,
      );
      await page.screenshot({ path: join(OUT, 'paypal-fixture-checkout.png') });
    }
    check('checkout: no order or payment command was sent', commands.length === 0, `commands=${commands.length}`);
    const left = await emptyCart(page);
    check('checkout: cart is empty after proof', left === 0, `remaining=${left}`);
    check('checkout: buyer signed out', await signOut(page));
  } finally {
    await browser.close();
  }
}

async function teardown() {
  const state = readState();
  if (!state) {
    log('teardown: no state file; nothing was set up, so nothing is changed');
    return;
  }
  const { browser, page } = await openBrowser();
  try {
    await ringSignIn(page, seller);
    let ids = state.listingId ? [state.listingId] : [];
    if (state.listingTitle && ids.length === 0) ids = (await nexusListingsByTitle(state.listingTitle)).ids;
    for (const id of ids) {
      await page.goto(`${ORIGIN}${listingPath(id)}`, { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      await approveMarketplaceSession(page, seller);
      const openDelete = page.getByRole('button', { name: /^Delete$/i }).first();
      if (await openDelete.isVisible().catch(() => false)) {
        await openDelete.click();
        await page.getByRole('button', { name: 'Delete listing', exact: true }).click();
        await page.waitForTimeout(5000);
        log(`teardown: deleted listing ${id.slice(0, 8)}`);
      } else log(`teardown: no Delete control on ${id.slice(0, 8)} (already gone or not owned)`);
    }
    if (!state.priorPaypal) {
      log('teardown: the PayPal rail was never changed');
    } else {
      const prior = decodePriorPaypal(state.priorPaypal);
      if (prior === null) {
        check('teardown: seller PayPal rail restored to its prior value', false, 'set PAYPAL_TEST_EMAIL to restore it');
      } else {
        await savePaypal(page, prior);
        check(
          'teardown: seller PayPal rail restored to its prior value',
          (await readPaypal(page)) === prior,
          `prior=${state.priorPaypal.kind}`,
        );
      }
    }
    await signOut(page).catch(() => false);
    writeState({ ...state, listingIds: ids, phase: 'torn-down' });
  } finally {
    await browser.close();
  }
  if (state.runStart) {
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
}

async function verify() {
  const state = readState();
  if (!state) {
    log('verify: no state file; nothing to verify');
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const ids = state.listingIds ?? (state.listingId ? [state.listingId] : []);
  if (state.listingTitle) {
    const stream = await nexusListingsByTitle(state.listingTitle);
    check(
      'verify: no fixture listing in the seller stream',
      stream.status === 200 && stream.ids.length === 0,
      `status=${stream.status} left=${stream.ids.length}`,
    );
  }
  let bearer = null;
  if (ids.length) bearer = await mintBearer(seller);
  if (ids.length) {
    const { browser, page } = await openBrowser();
    try {
      for (const id of ids) {
        await page.goto(`${ORIGIN}${listingPath(id)}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await page.waitForTimeout(8000);
        const shop = await page.evaluate(
          (title) => ({
            title: [...document.querySelectorAll('h1')].some((node) => node.textContent?.trim() === title),
            addToCart: [...document.querySelectorAll('button')].some(
              (node) => node.textContent?.trim() === 'Add to cart',
            ),
          }),
          state.listingTitle,
        );
        check(
          `verify: Shop page no longer shows ${id.slice(0, 8)}`,
          !shop.title && !shop.addToCart,
          JSON.stringify(shop),
        );
      }
    } finally {
      await browser.close();
    }
  }
  for (const id of ids) {
    const detail = await fetch(`${NEXUS}/v0/listing/${encodeURIComponent(sellerPubky)}/${encodeURIComponent(id)}`);
    check(`verify: nexus detail gone ${id.slice(0, 8)}`, detail.status === 404, `status=${detail.status}`);
    const onHomeserver = await new Pubky().publicStorage
      .exists(`pubky://${sellerPubky}/pub/pubky.app/marketplace/v1/listings/${id}`)
      .catch(() => null);
    check(`verify: homeserver record gone ${id.slice(0, 8)}`, onHomeserver === false, `exists=${onHomeserver}`);
    const projection = await fetch(`${SERVICE}/v1/listings/${encodeURIComponent(`listing:${sellerPubky}_${id}`)}`, {
      headers: { authorization: `Bearer ${bearer.token}` },
    });
    check(
      `verify: service projection gone ${id.slice(0, 8)}`,
      projection.status === 404,
      `status=${projection.status}`,
    );
  }
  if (state.priorPaypal) {
    const config = await fetch(`${SERVICE}/v0/sellers/${encodeURIComponent(sellerPubky)}/payment-config`);
    const body = await config.json().catch(() => ({}));
    const expected = state.priorPaypal.kind !== 'empty';
    check(
      'verify: public PayPal availability matches the prior rail',
      config.status === 200 && (body.paypal_available === true) === expected,
      `status=${config.status} expected=${expected}`,
    );
  }
  if (bearer) check('verify: verifier bearer revoked', (await revokeSession(bearer.token, bearer.sessionId)) < 300);
  if (state.runStart) {
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
  }
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
  await verify();
}

try {
  if (mode === 'proof') {
    try {
      const fixturePath = await setup();
      if (!interrupted && wrapped.length) {
        const run = spawnSync(wrapped[0], wrapped.slice(1), {
          stdio: 'inherit',
          env: { ...process.env, PROOF_PAYPAL_LISTING_URL: fixturePath },
        });
        check(
          `wrapped command exited 0 (${wrapped
            .map((part) => part.split('/').pop())
            .join(' ')
            .slice(0, 60)})`,
          run.status === 0,
          `status=${run.status ?? run.signal}`,
        );
      } else if (!interrupted) await checkout();
    } catch (error) {
      check(
        `${interrupted ? 'interrupted' : 'setup/checkout completed'}`,
        false,
        String(error?.message ?? error).slice(0, 240),
      );
    } finally {
      await tearDownAndVerify();
    }
  } else if (mode === 'setup') await setup();
  else if (mode === 'checkout') await checkout();
  else if (mode === 'teardown') await tearDownAndVerify();
  else await verify();
} catch (error) {
  check(`${mode} completed`, false, String(error?.message ?? error).slice(0, 240));
}

const ok = checks.every((row) => row.ok);
writeFileSync(join(OUT, `paypal-fixture-${mode}.json`), `${JSON.stringify({ mode, ok, checks }, null, 2)}\n`);
if ((mode === 'proof' || mode === 'teardown' || mode === 'verify') && ok && existsSync(STATE_PATH))
  unlinkSync(STATE_PATH);
log(
  `PAYPAL_FIXTURE ${mode} ${ok ? 'OK' : 'FAIL'} checks=${checks.length} failed=${checks.filter((row) => !row.ok).length}`,
);
process.exit(ok ? 0 : 1);
