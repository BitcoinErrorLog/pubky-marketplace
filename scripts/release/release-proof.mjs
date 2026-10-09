#!/usr/bin/env node
// Signed-in Shop release proof in real Chromium against production.
//   1. Ring sign-in with the Ring and Bitkit QRs both live; exactly one session.
//   2. Bitkit grant sign-in (Signer.approveAuthRequest, the binding Bitkit's Paykit calls), reload, sign-out.
//   (Step ids are stable across releases; 3 is unused.)
//   4. Buyer seat checkout on the PayPal fixture listing (PROOF_PAYPAL_LISTING_URL, set by
//      production-paypal-fixture.mjs proof): payment-config loads, PayPal is offered. Pay is never clicked.
//   5. Activity opens an order; the order page shows it (buyer seat when the seller's rows only
//      point at orders its Orders page hides — recorded as a known defect).
//   6. Sign-out of the Ring session through Settings, held across reload.
// Afterwards every marketplace session the seat gained during the run is revoked and the
// revocation is verified. Nothing else is written: the cart is local (Dexie) and is emptied.
// Env: PROOF_EVIDENCE and EXPECTED_DPL (required), seats (see seats.mjs), PROOF_ORIGIN, PROOF_SERVICE,
// PROOF_RELAY, PROOF_PAYPAL_LISTING_URL (fixture listing path for step 4, set by production-paypal-fixture.mjs).
// Runbook: docs/ecommerce/release.md.
// Output: 8-char pubky prefixes only; auth URLs, exports and bearers never print.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evidenceDir,
  loadBuyerSeat,
  loadSellerSeat,
  prefix,
  repoRequire,
  seatSource,
  shopCapabilities,
} from './seats.mjs';

const { chromium } = repoRequire('playwright');
const { AuthFlowKind, Pubky, SigninGrantDeepLink } = repoRequire('@synonymdev/pubky');

const ORIGIN = process.env.PROOF_ORIGIN ?? 'https://shop.pubky.app';
const EVIDENCE = evidenceDir();
const EXPECTED_DPL = process.env.EXPECTED_DPL ?? '';
if (!EXPECTED_DPL) throw new Error('set EXPECTED_DPL to the dpl_… id now aliased to the origin');
const SERVICE = process.env.PROOF_SERVICE ?? 'https://marketplace-service-production-ce23.up.railway.app';
const RELAY = process.env.PROOF_RELAY ?? 'https://httprelay.pubky.app/inbox';
const CAPABILITIES = shopCapabilities();
const CLIENT_ID = 'shop.pubky.app';
const FORBIDDEN_COPY = /hasn't set up a payment method|do not share a payment method/i;
const RUN_START = Date.now();
mkdirSync(EVIDENCE, { recursive: true });
const PROGRESS = join(EVIDENCE, 'proof-log.txt');
writeFileSync(PROGRESS, '');

const redact = (value) =>
  String(value ?? '')
    .replace(/[ybndrfg8ejkmcpqxot1uwisza345h769]{52}/gi, (match) => `${match.slice(0, 8)}…`)
    .replace(/(bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/([?&#](?:secret|s)=)[^&\s]+/gi, '$1[redacted]');
const log = (line) => {
  const text = redact(line);
  appendFileSync(PROGRESS, `${new Date().toISOString()} ${text}\n`);
  console.log(text);
};
const results = [];
function check(step, name, ok, detail = '') {
  results.push({ step, name, ok: Boolean(ok), detail: redact(detail) });
  log(`${ok ? 'PASS' : 'FAIL'} [${step}] ${name}${detail ? ` — ${detail}` : ''}`);
}
// A known defect outside the release under proof: recorded in results.json, never gating.
const notes = [];
function note(step, name, ok, detail = '') {
  notes.push({ step, name, ok: Boolean(ok), detail: redact(detail) });
  log(`${ok ? 'OK  ' : 'KNOWN'} [${step}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const shot = async (page, name) => page.screenshot({ path: join(EVIDENCE, name) });

// Staging runs use staging-homeserver seats: the staging Shop signs out accounts that live on the
// production homeserver.
const seat = loadSellerSeat();
const buyerSeat = loadBuyerSeat();
const pubky = seat.publicKey.z32();
log(
  `seller seat ${prefix(pubky)} (${seatSource()}), buyer seat ${prefix(buyerSeat.publicKey.z32())}, origin ${ORIGIN}`,
);

function instrument(page, net, commands) {
  page.on('response', (response) => {
    const request = response.request();
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    const method = request.method();
    const entry = {
      method,
      status: response.status(),
      host: url.host.slice(0, 48),
      path: redact(url.pathname).slice(0, 120),
      t: Date.now() - RUN_START,
    };
    if (url.pathname === '/session') net.push({ tag: 'homeserver-session', ...entry });
    else if (/\/auth\/grant/.test(url.pathname)) net.push({ tag: 'grant', ...entry });
    else if (url.origin === SERVICE && url.pathname.startsWith('/v1/auth/sessions'))
      net.push({ tag: 'marketplace-session', ...entry });
    else if (url.origin === SERVICE && /\/payment-config$/.test(url.pathname))
      net.push({ tag: 'payment-config', ...entry });
    if (method === 'POST' && /\/v1\/commands/.test(url.pathname)) {
      const kind = ((request.postData() || '').match(/"kind"\s*:\s*"([^"]+)"/) || [])[1] || 'unknown';
      commands.push({ kind, status: response.status() });
      net.push({ tag: 'command', kind, ...entry });
    }
  });
}

async function authState(page) {
  return await page.evaluate(() => {
    const raw = localStorage.getItem('shop-auth-store') ?? localStorage.getItem('auth-store');
    const state = raw ? (JSON.parse(raw).state ?? {}) : {};
    return {
      currentUserPubky: state.currentUserPubky ?? null,
      sessionExport: state.sessionExport ?? null,
      grantSessionRecordId: state.grantSessionRecordId ?? null,
    };
  });
}
const waitForAppReady = async (page, timeout = 180_000) =>
  page.waitForFunction(
    () =>
      !/^\s*Loading\.{0,3}\s*$/.test(document.body?.innerText ?? '') && (document.body?.innerText ?? '').length > 40,
    null,
    { timeout },
  );
const signedInAs = (page, key, timeout = 180_000) =>
  page.waitForFunction(
    ([expected, field]) => {
      const raw = localStorage.getItem('shop-auth-store') ?? localStorage.getItem('auth-store');
      const state = raw ? (JSON.parse(raw).state ?? {}) : {};
      return state.currentUserPubky === expected && typeof state[field] === 'string';
    },
    [pubky, key],
    { timeout },
  );

async function bothQrsLive(page) {
  await page.goto(`${ORIGIN}/sign-in`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await waitForAppReady(page);
  await page
    .getByRole('button', { name: 'Copy authentication link' })
    .first()
    .waitFor({ state: 'visible', timeout: 180_000 });
  await page.waitForFunction(
    () =>
      ['Copy authentication link', 'Copy Bitkit authentication link'].every((label) => {
        const el = document.querySelector(`[aria-label="${label}"]`);
        return Boolean(el && !el.disabled && el.querySelector('[data-testid="qr-auth-url"]'));
      }),
    null,
    { timeout: 180_000 },
  );
  return (
    (await page.getByRole('button', { name: 'Copy authentication link' }).first().isVisible()) &&
    (await page.getByRole('button', { name: 'Copy Bitkit authentication link' }).first().isVisible())
  );
}

async function copyQrUrl(page, label) {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByRole('button', { name: label }).first().click();
  const handle = await page.waitForFunction(
    async () => {
      const text = await navigator.clipboard.readText();
      return text.startsWith('pubkyauth://') ? text : null;
    },
    null,
    { timeout: 10_000 },
  );
  return await handle.jsonValue();
}

async function qrDomLeak(page, authUrl) {
  const secret = new URL(authUrl).searchParams.get('secret');
  return await page.evaluate(
    (value) => ({
      attr: document.querySelector('[data-auth-url]') !== null,
      html: document.documentElement.outerHTML.includes(value),
    }),
    secret,
  );
}

async function signOutThroughSettings(page) {
  await page.goto(`${ORIGIN}/settings/account`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await waitForAppReady(page);
  const button = page.locator('#sign-out-btn');
  const viaSettings = await button
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (viaSettings) await button.click();
  else await page.goto(`${ORIGIN}/logout`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('shop-auth-store') ?? localStorage.getItem('auth-store');
      const state = raw ? (JSON.parse(raw).state ?? {}) : {};
      return !state.currentUserPubky && !state.grantSessionRecordId && !state.sessionExport;
    },
    null,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(2500);
  return viaSettings;
}

async function newContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(redact(message.text()).slice(0, 240));
  });
  return { context, page };
}

async function emptyCart(page) {
  await page.goto(`${ORIGIN}/marketplace/cart`, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  await page.waitForTimeout(1200);
  for (let n = 0; n < 8; n += 1) {
    const remove = page.getByRole('button', { name: /^Remove / }).first();
    if (!(await remove.count())) break;
    await remove.click();
    await page.waitForTimeout(700);
  }
  return await page.getByRole('button', { name: /^Remove / }).count();
}

// Step 4 runs as the buyer seat on the seller-seat fixture listing that
// production-paypal-fixture.mjs publishes (staging: staging-fixture.mjs); a seller cannot buy its own listing.
async function paypalCheckout(page, commands, href) {
  const sellerOf = (value) => {
    const parts = value.split('/');
    const index = parts.indexOf('listing');
    return index >= 0 ? parts[index + 1] || '' : '';
  };
  const sellerConfig = await (await fetch(`${SERVICE}/v0/sellers/${encodeURIComponent(sellerOf(href))}/payment-config`))
    .json()
    .catch(() => null);
  const sellerHasPaypal = sellerConfig?.paypal_available === true;
  log(`fixture seller ${sellerOf(href).slice(0, 8)} public payment-config paypal=${sellerHasPaypal}`);
  await emptyCart(page);
  {
    await page.goto(new URL(href, ORIGIN).toString(), { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    const title = (
      (await page
        .locator('h1')
        .first()
        .innerText()
        .catch(() => '')) || ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    await page
      .waitForFunction(
        () => {
          const button = [...document.querySelectorAll('button')].find((el) =>
            /Add to cart|Approve to buy|Sold out|Held|Unavailable|cannot buy|Checking availability/.test(
              el.textContent || '',
            ),
          );
          return Boolean(button && !/Checking availability/.test(button.textContent || ''));
        },
        null,
        { timeout: 30_000 },
      )
      .catch(() => {});
    const add = page.getByRole('button', { name: 'Add to cart', exact: true }).first();
    if (
      !((await add.count()) && (await add.isVisible().catch(() => false)) && (await add.isEnabled().catch(() => false)))
    ) {
      return { sellerHasPaypal, error: `fixture listing "${title}" has no enabled Add to cart for the buyer` };
    }
    await add.click();
    await page.waitForTimeout(1200);
    await page.goto(`${ORIGIN}/marketplace/cart`, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    const checkout = page.getByTestId('marketplace-cart-checkout');
    await checkout
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => {});
    if (!(await checkout.count())) return { sellerHasPaypal, error: 'no cart checkout control' };
    const configResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        /\/v0\/sellers\/(?!me\/)[^/]+\/payment-config$/.test(new URL(response.url()).pathname),
      { timeout: 30_000 },
    );
    await checkout.first().click();
    await page.waitForURL(/\/marketplace\/checkout/, { timeout: 30_000 });
    await waitForAppReady(page);
    let configStatus = null;
    try {
      const response = await configResponse;
      await response.finished();
      configStatus = response.status();
    } catch (error) {
      log(`payment-config did not arrive: ${String(error?.message ?? error).slice(0, 120)}`);
    }
    await page
      .waitForFunction(() => !document.querySelector('[aria-label="Loading payment methods"]'), null, {
        timeout: 30_000,
      })
      .catch(() => {});
    await page
      .getByTestId('marketplace-checkout-method-paypal')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {});
    const paypal = await page.getByTestId('marketplace-checkout-method-paypal').count();
    const loadingLeft = await page.locator('[aria-label="Loading payment methods"]').count();
    const retry = await page.getByTestId('marketplace-checkout-methods-retry').count();
    const forbidden = FORBIDDEN_COPY.test(await page.locator('body').innerText());
    const payControl = page.getByTestId('marketplace-checkout-pay');
    const payState = (await payControl.count())
      ? { visible: await payControl.first().isVisible(), disabled: await payControl.first().isDisabled() }
      : null;
    await page
      .getByTestId('marketplace-checkout-method-paypal')
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await shot(page, '06-checkout-paypal.png');
    const listingId = (href.split('/').filter(Boolean).slice(-1)[0] || '').slice(0, 12);
    const sellerPrefix = sellerOf(href).slice(0, 8);
    const payCommands = commands.filter((row) =>
      /^(checkout|order|payment|fulfillment|offer|auction|drop|inventory)\./i.test(row.kind),
    );
    log(
      `checkout "${title}" listing=${listingId} seller=${sellerPrefix} config=${configStatus} paypal=${paypal} loadingLeft=${loadingLeft} retry=${retry} forbidden=${forbidden} pay=${JSON.stringify(payState)}`,
    );
    const cartLeft = await emptyCart(page);
    return {
      sellerHasPaypal,
      title,
      listingId,
      sellerPrefix,
      configStatus,
      paypal,
      loadingLeft,
      retry,
      forbidden,
      payState,
      payCommands,
      cartLeft,
    };
  }
}

async function renderedOrderCards(page) {
  await page.goto(`${ORIGIN}/marketplace/orders`, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  await page.locator('[data-surface="marketplace-orders"]').waitFor({ state: 'visible', timeout: 60_000 });
  await page
    .waitForFunction(
      () =>
        !document.querySelector(
          '[data-surface="marketplace-orders"] [data-slot="skeleton"], [data-surface="marketplace-orders"] .animate-pulse',
        ),
      null,
      { timeout: 60_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(2500);
  const all = page.getByRole('button', { name: /^All/ }).first();
  if (await all.count()) {
    await all.click();
    await page.waitForTimeout(800);
  }
  return await page.evaluate(() =>
    [...document.querySelectorAll('[id^="order-"]')].map((el) => el.id.slice('order-'.length)),
  );
}

// Activity rows link to /marketplace/orders#order-<id>; the Orders page renders only a
// card per order that belongs in its history (paid/receipted, or held reservations).
async function activityAndOrder(page, tag) {
  const rendered = new Set(await renderedOrderCards(page));
  await page.goto(`${ORIGIN}/marketplace/notifications`, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  await page
    .locator('a[href*="#order-"]')
    .first()
    .waitFor({ state: 'visible', timeout: 45_000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  const nav = page.locator('[data-surface="marketplace-section-nav"]');
  const navActivity = (await nav.count()) ? await nav.getByRole('link', { name: /Activity/ }).count() : 0;
  const unrecognizedBanner = await page.getByText(/unrecognized marketplace event/i).count();
  const unrecognizedRows = await page.locator('[data-cy="marketplace-unrecognized-notification"]').count();
  const targets = (
    await page
      .locator('a[href*="#order-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('href')).filter(Boolean))
  ).map((href) => decodeURIComponent(href.split('#order-')[1] ?? ''));
  const distinct = [...new Set(targets)];
  const hiddenTargets = distinct.filter((id) => !rendered.has(id)).map((id) => id.slice(0, 8));
  await shot(page, `07-activity-${tag}.png`);
  // Prefer an order the page lists; otherwise the first row, whose order must then render in From Activity.
  const listedIndex = targets.findIndex((id) => rendered.has(id));
  const index = listedIndex >= 0 ? listedIndex : targets.length ? 0 : -1;
  let opened = null;
  if (index >= 0) {
    const target = targets[index];
    await page.locator('a[href*="#order-"]').nth(index).click();
    await page.waitForURL(/\/marketplace\/orders/, { timeout: 30_000 }).catch(() => {});
    await waitForAppReady(page);
    const card = page.locator(`[id="order-${target}"]`);
    await card.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const url = new URL(page.url());
    const label = (
      (await card
        .getByTestId('order-reference-label')
        .first()
        .innerText()
        .catch(() => '')) || ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    const inView = await card
      .evaluate((el) => {
        const box = el.getBoundingClientRect();
        return box.bottom > 0 && box.top < window.innerHeight;
      })
      .catch(() => false);
    opened = {
      path: url.pathname,
      hashIsOrder: url.hash.startsWith('#order-'),
      targetPrefix: target.slice(0, 8),
      label,
      inView,
      labelMatches: label === `Order ${target.slice(0, 8)}`,
    };
    await shot(page, `08-order-page-${tag}.png`);
  }
  log(
    `activity[${tag}] nav=${navActivity} unrecognized=${unrecognizedBanner}/${unrecognizedRows} orderRows=${targets.length} distinctOrders=${distinct.length} rendered=${rendered.size} hidden=${hiddenTargets.length} opened=${JSON.stringify(opened)}`,
  );
  return {
    navActivity,
    unrecognizedBanner,
    unrecognizedRows,
    orderRows: targets.length,
    distinctOrders: distinct.length,
    renderedCards: rendered.size,
    hiddenTargets,
    opened,
  };
}

function checkActivity(act, tag) {
  check('5', `Activity is in the marketplace section nav (${tag})`, act.navActivity >= 1);
  check(
    '5',
    `Activity has no unrecognized events (${tag})`,
    act.unrecognizedBanner === 0 && act.unrecognizedRows === 0,
  );
  check('5', `Activity lists order rows (${tag})`, act.orderRows > 0, `rows=${act.orderRows}`);
  note(
    '5',
    `Activity rows whose order the Orders page does not render (${tag})`,
    act.hiddenTargets.length === 0,
    `${act.hiddenTargets.length}/${act.distinctOrders}`,
  );
}

async function ringSignIn(page, keypair) {
  await bothQrsLive(page);
  await new Pubky().signer(keypair).approveAuthRequest(await copyQrUrl(page, 'Copy authentication link'));
  await page.waitForFunction(
    (expected) => {
      const raw = localStorage.getItem('shop-auth-store') ?? localStorage.getItem('auth-store');
      const state = raw ? (JSON.parse(raw).state ?? {}) : {};
      return state.currentUserPubky === expected && typeof state.sessionExport === 'string';
    },
    keypair.publicKey.z32(),
    { timeout: 180_000 },
  );
  await page.waitForTimeout(3000);
}

async function mintAuditBearer(client, keypair) {
  const flow = client.startCookieAuthFlow(CAPABILITIES, AuthFlowKind.signin(), RELAY);
  const tokenPromise = flow.awaitToken();
  await client.signer(keypair).approveAuthRequest(flow.authorizationUrl);
  const authToken = await tokenPromise;
  const response = await fetch(`${SERVICE}/v1/auth/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: authToken.toBytes(),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 201) throw new Error(`audit mint HTTP ${response.status}`);
  return { bearer: body.token, sessionId: body.session_id };
}
const listSessions = async (bearer) => {
  const response = await fetch(`${SERVICE}/v1/auth/sessions`, { headers: { authorization: `Bearer ${bearer}` } });
  return { status: response.status, sessions: (await response.json().catch(() => ({}))).sessions ?? [] };
};
const revokeSession = async (bearer, id) =>
  (
    await fetch(`${SERVICE}/v1/auth/sessions/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bearer}` },
    })
  ).status;
const createdThisRun = (row) =>
  !row.revoked_at && Date.parse(row.created_at) >= RUN_START - 5000 && Date.parse(row.expires_at) > Date.now();

// The audit's own session is revoked last: once it is gone its bearer cannot revoke anything.
async function revokeRunSessions(keypair) {
  const client = new Pubky();
  const audit = {
    seat: prefix(keypair.publicKey.z32()),
    runStart: new Date(RUN_START).toISOString(),
    revoked: [],
    error: null,
  };
  try {
    const minted = await mintAuditBearer(client, keypair);
    const before = await listSessions(minted.bearer);
    audit.listStatus = before.status;
    audit.activeFromRunBefore = before.sessions
      .filter(createdThisRun)
      .map((row) => ({ id: row.id, created_at: row.created_at, label: row.label ?? null }));
    const ordered = [...audit.activeFromRunBefore].sort(
      (a, b) => Number(a.id === minted.sessionId) - Number(b.id === minted.sessionId),
    );
    for (const row of ordered) {
      audit.revoked.push({
        id: row.id,
        status: await revokeSession(minted.bearer, row.id),
        audit: row.id === minted.sessionId,
      });
    }
    const verifier = await mintAuditBearer(client, keypair);
    const after = await listSessions(verifier.bearer);
    audit.activeFromRunAfter = after.sessions
      .filter((row) => createdThisRun(row) && row.id !== verifier.sessionId)
      .map((row) => row.id);
    audit.verifierRevoke = await revokeSession(verifier.bearer, verifier.sessionId);
  } catch (error) {
    audit.error = String(error?.message ?? error);
  }
  return audit;
}

const consoleErrors = [];
const summary = {};
const browser = await chromium.launch({ headless: true });
try {
  const html = await (await fetch(`${ORIGIN}/marketplace`)).text();
  const dpl = (html.match(/dpl_[A-Za-z0-9]+/) || [])[0] || null;
  summary.dpl = dpl;
  check('0', 'production serves the expected deployment', !EXPECTED_DPL || dpl === EXPECTED_DPL, `${dpl}`);

  // Journey A: Ring (steps 1, 5, 6) on one browser session.
  {
    const net = [];
    const commands = [];
    const { context, page } = await newContext(browser);
    instrument(page, net, commands);
    try {
      check('1', 'Ring and Bitkit QRs are both live on /sign-in', await bothQrsLive(page));
      await shot(page, '01-sign-in-both-qrs.png');
      const ringUrl = await copyQrUrl(page, 'Copy authentication link');
      const parsed = new URL(ringUrl);
      check(
        '1',
        'Ring QR is the cookie sign-in URL for the Shop caps',
        parsed.host === 'signin' &&
          [...parsed.searchParams.keys()].sort().join(',') === 'caps,relay,secret' &&
          parsed.searchParams.get('caps') === CAPABILITIES,
        `host=${parsed.host}`,
      );
      const leak = await qrDomLeak(page, ringUrl);
      check('1', 'the QR slot does not carry the authorization URL in the DOM', !leak.attr && !leak.html);
      await new Pubky().signer(seat).approveAuthRequest(ringUrl);
      log('ring: approved');
      await signedInAs(page, 'sessionExport');
      await page.waitForFunction(() => window.location.pathname !== '/sign-in', null, { timeout: 180_000 });
      await page.waitForTimeout(4000);
      await shot(page, '02-ring-signed-in.png');
      const state = await authState(page);
      check(
        '1',
        'signed in as the seat with a cookie export and no grant record',
        state.currentUserPubky === pubky && !state.grantSessionRecordId,
        prefix(state.currentUserPubky),
      );
      const hsPosts = net.filter((e) => e.tag === 'homeserver-session' && e.method === 'POST');
      const mpPosts = net.filter((e) => e.tag === 'marketplace-session' && e.method === 'POST');
      check(
        '1',
        'one approval → one homeserver POST /session',
        hsPosts.length === 1 && hsPosts[0].status < 300,
        hsPosts.map((e) => e.status).join(','),
      );
      check(
        '1',
        'one approval → one marketplace POST /v1/auth/sessions',
        mpPosts.length === 1 && mpPosts[0].status < 300,
        mpPosts.map((e) => e.status).join(','),
      );
      check(
        '1',
        'no grant session was exchanged for the Ring approval',
        !net.some((e) => e.tag === 'grant' && e.method === 'POST'),
      );
      check(
        '1',
        'both QRs are gone once signed in',
        (await page
          .locator('[aria-label="Copy Bitkit authentication link"],[aria-label="Copy authentication link"]')
          .count()) === 0,
      );

      const act = await activityAndOrder(page, 'seller');
      summary.activity = { seller: act };
      checkActivity(act, 'seller');

      const deletesBefore = net.filter((e) => e.tag === 'homeserver-session' && e.method === 'DELETE').length;
      const viaSettings = await signOutThroughSettings(page);
      await shot(page, '11-signed-out.png');
      const deletes = net.filter((e) => e.tag === 'homeserver-session' && e.method === 'DELETE').slice(deletesBefore);
      check(
        '6',
        'sign-out from Settings → Account clears the Shop state',
        viaSettings,
        viaSettings ? '#sign-out-btn' : 'fell back to /logout',
      );
      check(
        '6',
        'sign-out ends the homeserver session (DELETE /session 2xx)',
        deletes.some((e) => e.status >= 200 && e.status < 300),
        deletes.map((e) => e.status).join(','),
      );
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
      await waitForAppReady(page);
      await page.waitForTimeout(5000);
      check('6', 'signed out holds across a reload', !(await authState(page)).currentUserPubky);
    } catch (error) {
      await shot(page, 'ring-journey-error.png').catch(() => {});
      check('A', 'Ring journey ran to completion', false, String(error?.message ?? error).slice(0, 240));
    } finally {
      summary.ringNetwork = net;
      summary.ringCommands = commands;
      await context.close();
    }
  }

  // Journey B: Bitkit grant (step 2).
  {
    const net = [];
    const commands = [];
    const { context, page } = await newContext(browser);
    instrument(page, net, commands);
    try {
      check('2', 'Bitkit QR is live next to the Ring QR without a click', await bothQrsLive(page));
      const grantUrl = await copyQrUrl(page, 'Copy Bitkit authentication link');
      const parsed = new URL(grantUrl);
      const link = SigninGrantDeepLink.parse(grantUrl);
      check(
        '2',
        'Bitkit QR is a signin_grant for the Shop caps and client id (the checks Paykit applies)',
        parsed.host === 'signin_grant' &&
          ['caps', 'relay', 'secret', 'cid', 'cpk'].every((k) => parsed.searchParams.getAll(k).length === 1) &&
          link.capabilities === CAPABILITIES &&
          parsed.searchParams.get('cid') === CLIENT_ID,
        `host=${parsed.host} cid=${parsed.searchParams.get('cid')}`,
      );
      const leak = await qrDomLeak(page, grantUrl);
      check('2', 'the Bitkit QR slot does not carry the authorization URL in the DOM', !leak.attr && !leak.html);
      await shot(page, '03-bitkit-qr.png');
      await new Pubky().signer(seat).approveAuthRequest(grantUrl);
      log('bitkit grant: approved');
      await signedInAs(page, 'grantSessionRecordId');
      await page.waitForTimeout(4000);
      const state = await authState(page);
      const grantPosts = net.filter((e) => e.tag === 'grant' && e.method === 'POST');
      check(
        '2',
        'grant approval signs in with a grant record and no cookie export',
        state.currentUserPubky === pubky && state.grantSessionRecordId && state.sessionExport === null,
        `grant POST=${grantPosts.map((e) => e.status).join(',')}`,
      );
      await shot(page, '04-bitkit-signed-in.png');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
      await waitForAppReady(page);
      await page.waitForTimeout(5000);
      const reloaded = await authState(page);
      check(
        '2',
        'reload restores the stored grant',
        reloaded.currentUserPubky === pubky &&
          reloaded.grantSessionRecordId === state.grantSessionRecordId &&
          new URL(page.url()).pathname !== '/sign-in',
        new URL(page.url()).pathname,
      );
      const netBefore = net.length;
      const viaSettings = await signOutThroughSettings(page);
      await shot(page, '05-bitkit-signed-out.png');
      const teardown = net.slice(netBefore).filter((e) => e.method === 'DELETE' || e.tag === 'grant');
      check(
        '2',
        'grant sign-out from Settings clears the Shop state',
        viaSettings,
        JSON.stringify(teardown.map((e) => `${e.method} ${e.path} ${e.status}`)),
      );
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
      await waitForAppReady(page);
      await page.waitForTimeout(5000);
      const after = await authState(page);
      check('2', 'grant sign-out holds across a reload', !after.currentUserPubky && !after.grantSessionRecordId);
      summary.grantTeardown = teardown;
    } catch (error) {
      await shot(page, 'bitkit-journey-error.png').catch(() => {});
      check('B', 'Bitkit journey ran to completion', false, String(error?.message ?? error).slice(0, 240));
    } finally {
      summary.bitkitNetwork = net;
      summary.bitkitCommands = commands;
      await context.close();
    }
  }

  // Step 4: buyer seat checkout on the PayPal fixture listing.
  {
    const net = [];
    const commands = [];
    const { context, page } = await newContext(browser);
    instrument(page, net, commands);
    try {
      const fixture = process.env.PROOF_PAYPAL_LISTING_URL;
      check(
        '4',
        'a PayPal fixture listing is provided (run under production-paypal-fixture.mjs proof)',
        Boolean(fixture),
      );
      if (fixture) {
        await ringSignIn(page, buyerSeat);
        log(`buyer ${prefix(buyerSeat.publicKey.z32())} signed in with Ring for checkout`);
        const co = await paypalCheckout(page, commands, fixture);
        summary.checkout = co;
        check('4', 'the fixture seller offers PayPal', co.sellerHasPaypal);
        check(
          '4',
          'the buyer reached checkout on the fixture listing',
          !co.error,
          co.error ?? `"${co.title}" seller=${co.sellerPrefix} listing=${co.listingId}`,
        );
        if (!co.error) {
          check(
            '4',
            'payment-config loaded (GET 200) and the loading state cleared',
            co.configStatus === 200 && co.loadingLeft === 0 && co.retry === 0,
            `status=${co.configStatus}`,
          );
          check('4', 'PayPal is offered at checkout', co.paypal >= 1);
          check('4', 'no "no payment method" copy', !co.forbidden);
          check(
            '4',
            'nothing paid and no order command sent',
            co.payCommands.length === 0,
            JSON.stringify(co.payCommands),
          );
          check('4', 'cart emptied afterwards', co.cartLeft === 0);
        }
        await signOutThroughSettings(page);
        const deletes = net.filter((e) => e.tag === 'homeserver-session' && e.method === 'DELETE');
        check(
          '4',
          'buyer seat signed out after checkout (DELETE /session 2xx)',
          deletes.some((e) => e.status >= 200 && e.status < 300),
          deletes.map((e) => e.status).join(','),
        );
      }
    } catch (error) {
      await shot(page, 'checkout-journey-error.png').catch(() => {});
      check('4', 'buyer checkout journey ran to completion', false, String(error?.message ?? error).slice(0, 240));
    } finally {
      summary.checkoutNetwork = net;
      await context.close();
    }
  }

  // Step 5 order page: the seller's Activity may only point at orders its Orders page hides;
  // then the buyer seat, whose paid orders are rendered, proves the row → order navigation.
  let opened = summary.activity?.seller?.opened ?? null;
  let openedBy = 'seller';
  if (!opened) {
    const net = [];
    const commands = [];
    const { context, page } = await newContext(browser);
    instrument(page, net, commands);
    try {
      await ringSignIn(page, buyerSeat);
      log(`buyer ${prefix(buyerSeat.publicKey.z32())} signed in with Ring`);
      const act = await activityAndOrder(page, 'buyer');
      summary.activity.buyer = act;
      checkActivity(act, 'buyer');
      opened = act.opened;
      openedBy = 'buyer';
      await signOutThroughSettings(page);
      const deletes = net.filter((e) => e.tag === 'homeserver-session' && e.method === 'DELETE');
      check(
        '5',
        'buyer seat signed out (DELETE /session 2xx)',
        deletes.some((e) => e.status >= 200 && e.status < 300),
        deletes.map((e) => e.status).join(','),
      );
      check('5', 'buyer journey sent no order command', commands.length === 0, JSON.stringify(commands));
    } catch (error) {
      await shot(page, 'buyer-journey-error.png').catch(() => {});
      check('C', 'buyer Activity journey ran to completion', false, String(error?.message ?? error).slice(0, 240));
    } finally {
      summary.buyerNetwork = net;
      await context.close();
    }
  }
  check(
    '5',
    'an Activity row opens that order on the Orders page (card rendered, in view, label matches)',
    Boolean(opened?.hashIsOrder && opened?.labelMatches && opened?.inView && opened.path === '/marketplace/orders'),
    `${openedBy} ${JSON.stringify(opened)}`,
  );
} finally {
  await browser.close();
}

summary.sessionAudit = [];
for (const keypair of [seat, buyerSeat]) {
  const audit = await revokeRunSessions(keypair);
  summary.sessionAudit.push(audit);
  check(
    'cleanup',
    `every marketplace session ${audit.seat} gained during the run is revoked`,
    !audit.error &&
      audit.revoked.every((row) => row.status === 204 || row.status === 200) &&
      (audit.activeFromRunAfter ?? []).length === 0 &&
      audit.verifierRevoke < 300,
    audit.error ?? `revoked=${audit.revoked.length} activeAfter=${(audit.activeFromRunAfter ?? []).length}`,
  );
}
summary.consoleErrors = consoleErrors.slice(0, 40);
summary.knownDefects = notes;
summary.results = results;
const steps = {};
for (const row of results) steps[row.step] = (steps[row.step] ?? true) && row.ok;
summary.steps = steps;
writeFileSync(join(EVIDENCE, 'results.json'), `${redact(JSON.stringify(summary, null, 2))}\n`);
const failed = results.filter((row) => !row.ok).length;
log(`STEPS ${JSON.stringify(steps)}`);
log(`RESULT ${failed === 0 ? 'PASS' : 'FAIL'} ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
