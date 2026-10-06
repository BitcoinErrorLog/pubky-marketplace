#!/usr/bin/env node
/**
 * Launch-critical Chromium suite against a running Next server.
 *
 * Node fetch cannot catch Window.fetch "Illegal invocation". Every journey
 * here drives real Chromium against `next start`. The required gate reads a
 * committed Nexus fixture (via LAUNCH_E2E_NEXUS_URL), never live 7108.
 *
 * Inventory: signed-in seller board is the required Chromium canary
 * (LAUNCH_E2E_REQUIRE_SELLER_BOARD defaults on). Guest Join remains the
 * fallback when that flag is explicitly 0.
 *
 * The page origin is 127.0.0.1. staging-api.pubky.app does not send CORS
 * headers for that origin, so the session mint retries for 60s and the board
 * never mounts. The gate forwards that one host through Node after the page
 * calls fetch. An unbound Window.fetch still throws in the page, before any
 * request exists to forward. The Nexus fixture stub is not forwarded.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PATH = path.join(ROOT, 'src/test/e2e/fixtures/launch-critical.json');
const CANONICAL_LISTING_PATH = path.join(ROOT, 'src/test/e2e/fixtures/nexus/canonical-listing.json');
const SHOP_FIXTURE_PATH = path.join(ROOT, 'src/test/e2e/fixtures/nexus/shop.json');
const DEFAULT_IDENTITIES_FILE = '/Users/johncarvalho/work/.staging-drop-identities.json';

const BASE_URL = (process.env.LAUNCH_E2E_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const SERVICE_URL = process.env.LAUNCH_E2E_SERVICE_URL ?? 'https://staging-api.pubky.app';
const NEXUS_URL = (process.env.LAUNCH_E2E_NEXUS_URL ?? '').replace(/\/$/, '');
const ALLOW_LIVE_NEXUS = process.env.LAUNCH_E2E_ALLOW_LIVE_NEXUS === '1';
const REQUIRE_SELLER_BOARD = process.env.LAUNCH_E2E_REQUIRE_SELLER_BOARD !== '0';
const STUB_LISTING_ID = '2b81df4f390b40e5b0aedabb89e76fa0';

const failures = [];
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

function assert(name, condition, detail) {
  record(name, Boolean(condition), condition ? detail : detail || 'assertion failed');
}

function assertNotLiveNexus(url) {
  if (ALLOW_LIVE_NEXUS) return;
  if (!url) {
    throw new Error('LAUNCH_E2E_NEXUS_URL is required; the required gate must point at the fixture stub');
  }
  if (/railway\.app|:7108\b|7108\.up\.railway/.test(url)) {
    throw new Error(`required gate must not read live nexusd (${url})`);
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function loadSellerSecretHex() {
  const fromEnv = process.env.LAUNCH_E2E_SELLER_SECRET_HEX?.trim() ?? '';
  if (/^[0-9a-fA-F]{64}$/.test(fromEnv)) return fromEnv;
  const identitiesFile = process.env.MARKETPLACE_STAGING_DROP_IDENTITIES_FILE || DEFAULT_IDENTITIES_FILE;
  if (!existsSync(identitiesFile)) return null;
  const saved = JSON.parse(await readFile(identitiesFile, 'utf8'));
  const secret = saved.seller ?? saved.buyerA ?? null;
  return typeof secret === 'string' && /^[0-9a-fA-F]{64}$/.test(secret) ? secret : null;
}

async function expectVisible(page, locator, name, timeout = 20_000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    record(name, true, await locator.first().evaluate((el) => el.tagName.toLowerCase()));
    return true;
  } catch (error) {
    record(name, false, String(error).slice(0, 240));
    return false;
  }
}

async function closeJoinDialog(page) {
  await page.keyboard.press('Escape').catch(() => undefined);
  const close = page.locator('[data-testid="dialog-close"]');
  if (await close.count()) {
    await close
      .first()
      .click({ timeout: 5_000, force: true })
      .catch(() => undefined);
  }
  await page
    .locator('[role="dialog"]:visible')
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .catch(() => undefined);
}

async function gotoAndSettle(page, pathname) {
  const response = await page.goto(`${BASE_URL}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return response;
}

async function waitForJoinPubky(page) {
  const heading = page.getByRole('heading', { name: 'Join Pubky' });
  return expectVisible(page, heading, 'join-pubky-dialog', 20_000);
}

async function runAxe(page, pageId) {
  await page.addScriptTag({ path: path.join(ROOT, 'node_modules/axe-core/axe.min.js') });
  const dialogVisible = (await page.locator('[role="dialog"]:visible').count()) > 0;
  const report = await page.evaluate(async (scanDialog) => {
    const axe = window.axe;
    const dialog = document.querySelector('[role="dialog"]');
    const context = scanDialog && dialog ? dialog : document;
    const result = await axe.run(context, { resultTypes: ['violations'] });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      description: violation.description,
      nodes: violation.nodes.map((node) => {
        const data = [...(node.any ?? []), ...(node.all ?? [])]
          .map((check) => check.data)
          .find((entry) => entry && (entry.contrastRatio != null || entry.fgColor));
        return {
          target: node.target,
          html: String(node.html ?? '').slice(0, 240),
          failureSummary: String(node.failureSummary ?? '').slice(0, 240),
          fgColor: data?.fgColor ?? null,
          bgColor: data?.bgColor ?? null,
          contrastRatio: data?.contrastRatio ?? null,
          expectedContrastRatio: data?.expectedContrastRatio ?? null,
          fontSize: data?.fontSize ?? null,
          fontWeight: data?.fontWeight ?? null,
        };
      }),
    }));
  }, dialogVisible);

  const blocking = report.filter((item) => item.impact === 'critical' || item.impact === 'serious');
  if (blocking.length > 0) {
    record(
      `a11y:${pageId}`,
      false,
      blocking
        .map((item) => {
          const nodes = item.nodes
            .slice(0, 24)
            .map((node) => {
              const pair =
                node.fgColor && node.bgColor
                  ? `${node.fgColor} on ${node.bgColor} ${node.contrastRatio ?? '?'}:${node.expectedContrastRatio ?? ''}`
                  : '';
              return `${node.target.join(' ')} :: ${node.html}${pair ? ` :: ${pair}` : ''}`;
            })
            .join(' | ');
          return `${item.impact}:${item.id}×${item.nodes.length}${nodes ? ` ${nodes}` : ''}`;
        })
        .join('; '),
    );
    return;
  }
  record(
    `a11y:${pageId}`,
    true,
    report.length === 0 ? 'no violations' : `non-blocking ${report.map((item) => item.id).join(',')}`,
  );
}

async function waitForListingReady(page) {
  await page
    .locator('[data-testid="marketplace-listing-skeleton"]')
    .waitFor({ state: 'hidden', timeout: 20_000 })
    .catch(() => undefined);
}

async function exerciseListingCheckout(page) {
  await waitForListingReady(page);
  const buy = page.getByRole('button', { name: 'Sign in to buy' });
  const add = page.getByRole('button', { name: 'Add to cart' });
  if (await buy.count()) {
    await buy.first().click();
    await waitForJoinPubky(page);
    record('checkout:payment-step', true, 'Sign in to buy → Join Pubky');
    await closeJoinDialog(page);
  } else if (await add.count()) {
    await add.first().click();
    await waitForJoinPubky(page);
    record('checkout:payment-step', true, 'Add to cart → Join Pubky');
    await closeJoinDialog(page);
  } else {
    const unavailable = await page.getByRole('heading', { name: 'Listing unavailable' }).count();
    record(
      'checkout:payment-step',
      false,
      unavailable ? 'listing unavailable after Chromium navigation' : 'no Sign in to buy / Add to cart on listing',
    );
  }
  await runAxe(page, 'listing');
}

/**
 * Ring cookie QR only. `qr-auth-url` stays the slot id. The URL is not read
 * from the DOM: the copy button is what a person uses, and the slot must not
 * carry the relay secret in an attribute. Side-by-side sign-in puts the
 * Bitkit QR in the same card, so this prefers `sign-in-ring-option` and
 * rejects `pubkyauth://signin_grant`. Inventory grants are copied from the
 * open dialog, not from this locator.
 */
async function ringSignInAuthSlot(page, timeout) {
  const qr = '[data-testid="qr-auth-url"]';
  // Side-by-side sign-in keeps both QRs inside sign-in-qr-card. A card-wide
  // .first() copies Bitkit when that QR attaches first. Wait for the Ring
  // option, or for the Ring-only card that has no Bitkit option.
  const slot = page.locator(
    `[data-testid="sign-in-ring-option"] ${qr}, [data-testid="sign-in-qr-card"]:not(:has([data-testid="sign-in-bitkit-option"])) ${qr}`,
  );
  await slot.first().waitFor({ state: 'attached', timeout });
  return slot.first();
}

async function readCopiedAuthUrl(page, slot) {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await slot.locator('xpath=ancestor::button[1]').click();
  const copied = await page.waitForFunction(
    async () => {
      const text = await navigator.clipboard.readText();
      return text.startsWith('pubkyauth://') ? text : null;
    },
    null,
    { timeout: 5_000 },
  );
  const url = await copied.jsonValue();
  if (typeof url !== 'string' || !url.startsWith('pubkyauth://')) {
    throw new Error('missing pubkyauth URL from the QR copy button');
  }
  return url;
}

async function waitForAuthUrl(page, timeout = 25_000) {
  const slot = await ringSignInAuthSlot(page, timeout);
  const url = await readCopiedAuthUrl(page, slot);
  if (!url.startsWith('pubkyauth://signin') || url.startsWith('pubkyauth://signin_grant')) {
    throw new Error('missing Ring cookie pubkyauth URL from the QR copy button');
  }
  return url;
}

async function waitForStableAuthUrl(page) {
  let last = await waitForAuthUrl(page);
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const next = await waitForAuthUrl(page);
    if (next === last) return next;
    last = next;
  }
  return last;
}

async function approveAuthRequest(secretHex, authorizationUrl) {
  const sdk = await import('@synonymdev/pubky');
  const keypair = sdk.Keypair.fromSecret(hexToBytes(secretHex));
  await new sdk.Pubky().signer(keypair).approveAuthRequest(authorizationUrl);
}

async function waitForAuthStore(page, timeout = 90_000) {
  await page.waitForFunction(
    () => {
      try {
        const raw = localStorage.getItem('auth-store');
        if (!raw) return false;
        const state = JSON.parse(raw)?.state ?? {};
        // A reload without sessionExport is unauthenticated and the inventory
        // route redirects to the catalog. hasProfile must be true or the
        // guard sends the seller to profile creation instead of the board.
        return Boolean(
          state.currentUserPubky &&
          typeof state.sessionExport === 'string' &&
          state.sessionExport.length > 0 &&
          state.hasProfile === true,
        );
      } catch {
        return false;
      }
    },
    undefined,
    { timeout },
  );
}

/**
 * /sign-in is a public route, so a finished session stays on that URL.
 * The persisted session export is the signed-in predicate. "Verifying account"
 * appears before that export is written, so it is not enough.
 */
async function signInSeller(page, secretHex) {
  try {
    await closeJoinDialog(page);
    await gotoAndSettle(page, '/sign-in');
    const authorizationUrl = await waitForStableAuthUrl(page);
    try {
      await approveAuthRequest(secretHex, authorizationUrl);
    } catch (error) {
      record('inventory:seller-signin', false, `approveAuthRequest: ${String(error).slice(0, 200)}`);
      return false;
    }
    try {
      await waitForAuthStore(page, 30_000);
    } catch {
      const retryUrl = await waitForAuthUrl(page).catch(() => null);
      if (!retryUrl || retryUrl === authorizationUrl) throw new Error('auth-store was not set after approve');
      await approveAuthRequest(secretHex, retryUrl);
      await waitForAuthStore(page, 45_000);
    }
    record('inventory:seller-signin', true, `headless approve /sign-in, auth-store set (${page.url()})`);
    return true;
  } catch (error) {
    const snippet = (
      (await page
        .locator('body')
        .innerText()
        .catch(() => '')) ?? ''
    )
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    record('inventory:seller-signin', false, `${String(error).slice(0, 180)} :: ${snippet}`);
    return false;
  }
}

async function installStagingServiceProxy(page) {
  const service = new URL(SERVICE_URL);
  if (service.host !== 'staging-api.pubky.app') {
    throw new Error(`launch-e2e only forwards staging-api.pubky.app (got ${service.host})`);
  }
  if (/railway\.app|:7108\b/.test(SERVICE_URL)) {
    throw new Error(`launch-e2e must not forward live nexusd (${SERVICE_URL})`);
  }
  await page.route(`${service.origin}/**`, async (route) => {
    const request = route.request();
    const origin = request.headers()['origin'] ?? new URL(BASE_URL).origin;
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers':
        request.headers()['access-control-request-headers'] ?? 'content-type,authorization',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors, body: '' });
      return;
    }
    const headers = { ...request.headers() };
    delete headers.host;
    delete headers['content-length'];
    const response = await fetch(request.url(), {
      method: request.method(),
      headers,
      body: request.method() === 'GET' || request.method() === 'HEAD' ? undefined : request.postDataBuffer(),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const responseHeaders = { ...cors };
    response.headers.forEach((value, key) => {
      if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return;
      responseHeaders[key] = value;
    });
    await route.fulfill({ status: response.status, headers: responseHeaders, body });
  });
}

async function waitForBoardStatus(page, accepted, timeout = 45_000) {
  await page
    .waitForFunction(
      (wanted) => {
        const el = document.querySelector('[data-testid="inventory-studio"]');
        const next = el?.getAttribute('data-load-status') ?? '';
        return wanted.includes(next);
      },
      accepted,
      { timeout },
    )
    .catch(() => undefined);
  return (await page.locator('[data-testid="inventory-studio"]').getAttribute('data-load-status')) ?? '';
}

async function closeTopDialog(page) {
  const content = page.getByTestId('dialog-content');
  if (!(await content.count())) return;
  const close = content.getByRole('button', { name: 'Close' }).first();
  if (!(await close.count())) return;
  await close.click();
  await content
    .first()
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .catch(() => undefined);
}

async function openNamedDialog(page, trigger, dialog) {
  await trigger.waitFor({ state: 'visible', timeout: 20_000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await dialog.isVisible().catch(() => false)) return true;
    await trigger.click();
    const clicked = await dialog
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (clicked && (await dialog.isVisible().catch(() => false))) return true;
    // The overlay's click handler closes a dialog that opens on pointerdown,
    // so the same gesture can leave no QR. Enter does not land on the overlay.
    await trigger.focus();
    await page.keyboard.press('Enter');
    const keyed = await dialog
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (keyed && (await dialog.isVisible().catch(() => false))) return true;
  }
  return false;
}

async function readDialogAuthUrl(page, dialog) {
  const deadline = Date.now() + 40_000;
  let lastSnap = '';
  while (Date.now() < deadline) {
    if (!(await dialog.isVisible().catch(() => false))) return { url: '', snap: 'dialog closed' };
    const refusal = dialog.getByTestId('grant-session-refusal');
    if (await refusal.count()) {
      const text = ((await refusal.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 180);
      return { url: '', snap: `refusal: ${text}` };
    }
    const slot = dialog.locator('[data-testid="qr-auth-url"]');
    if (await slot.count()) {
      try {
        const url = await readCopiedAuthUrl(page, slot.first());
        if (url.startsWith('pubkyauth://signin_grant')) {
          return { url: '', snap: 'inventory dialog copied a Bitkit grant URL' };
        }
        return { url, snap: '' };
      } catch (error) {
        return { url: '', snap: String(error).slice(0, 180) };
      }
    }
    lastSnap = ((await dialog.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 220);
    if (/not approved|Approve purchases first|Sign in first|rejected the inventory/i.test(lastSnap)) {
      return { url: '', snap: lastSnap };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { url: '', snap: lastSnap || 'no pubkyauth url' };
}

async function approveVisibleGrant(page, secretHex, label) {
  const grantTrigger = page
    .getByTestId('inventory-grant-banner')
    .getByRole('button', { name: /Approve in your Pubky signer/i });
  // data-load-status flips to grant-needed while the skeleton still replaces the banner.
  await grantTrigger.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  const sessionTrigger = page.getByRole('button', { name: /Approve in Pubky Ring/i }).first();
  const useGrant = (await grantTrigger.count()) > 0;
  const trigger = useGrant ? grantTrigger : sessionTrigger;
  if (!(await trigger.count())) return { opened: false, ok: false, detail: 'no approve button' };

  if (useGrant) {
    await page
      .waitForFunction(() => Boolean(localStorage.getItem('pubky.marketplace.session.v1')), undefined, {
        timeout: 20_000,
      })
      .catch(() => undefined);
  }

  await closeTopDialog(page);
  const dialog = useGrant
    ? page.getByRole('dialog', { name: /Approve inventory access/ })
    : page.getByRole('dialog', { name: /Approve purchases/ });
  const opened = await openNamedDialog(page, trigger, dialog);
  if (!opened) return { opened: true, ok: false, detail: `${label} dialog did not stay open` };

  const { url, snap } = await readDialogAuthUrl(page, dialog);
  if (!url) {
    await closeTopDialog(page);
    return { opened: true, ok: false, detail: `${label} qr missing :: ${snap}` };
  }

  try {
    await approveAuthRequest(secretHex, url);
  } catch (error) {
    await closeTopDialog(page);
    return { opened: true, ok: false, detail: `${label} approveAuthRequest: ${String(error).slice(0, 180)}` };
  }

  const storageKey = useGrant ? 'pubky.marketplace.inventory-session.v1' : 'pubky.marketplace.session.v1';
  try {
    await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey, { timeout: 90_000 });
  } catch (error) {
    const body = ((await dialog.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 180);
    await closeTopDialog(page);
    return {
      opened: true,
      ok: false,
      detail: `${label} ${storageKey} missing :: ${body || String(error).slice(0, 120)}`,
    };
  }

  const after = await waitForBoardStatus(page, ['ready', 'empty', 'error'], 45_000);
  const ok = after === 'ready' || after === 'empty';
  return {
    opened: true,
    ok,
    detail: ok ? `${label} approved, status ${after}` : `${label} approved but status ${after || 'missing'}`,
  };
}

function boardThrowDetail({ illegal, transport, status, bodyText, pageErrors }) {
  const parts = [`status=${status || 'missing'}`, `illegal=${illegal.join(' | ') || 'none'}`, `transport=${transport}`];
  if (pageErrors.length) parts.push(`pageerror=${pageErrors.slice(0, 2).join(' | ')}`);
  if (bodyText) parts.push(bodyText.slice(0, 180));
  return parts.join(' ');
}

async function collectBoardSignals(page, pageErrors, errorOffset) {
  const studio = page.locator('[data-testid="inventory-studio"]');
  await Promise.race([
    studio.waitFor({ state: 'attached', timeout: 15_000 }),
    page.getByRole('heading', { name: 'Join Pubky' }).waitFor({ state: 'visible', timeout: 15_000 }),
    page.locator('nextjs-portal, [data-nextjs-dialog]').waitFor({ state: 'attached', timeout: 15_000 }),
  ]).catch(() => undefined);

  const slice = pageErrors.slice(errorOffset);
  const illegal = slice.filter((message) => /illegal invocation/i.test(message));
  const bodyText = (
    (await page
      .locator('body')
      .innerText()
      .catch(() => '')) ?? ''
  )
    .replace(/\s+/g, ' ')
    .slice(0, 400);
  const status = (await studio.getAttribute('data-load-status').catch(() => null)) ?? '';
  const transport = /illegal invocation|transport_error|transport error/i.test(bodyText);
  const nextCrash = (await page.locator('nextjs-portal, [data-nextjs-dialog]').count()) > 0;
  const applicationError = /application error|this page could not be rendered/i.test(bodyText);
  return {
    studio,
    illegal,
    bodyText,
    status,
    transport,
    nextCrash,
    applicationError,
    slice,
    redirectedHome: new URL(page.url()).pathname === '/marketplace',
    onInventory: new URL(page.url()).pathname === '/marketplace/dashboard/inventory',
    joinVisible: await page
      .getByRole('heading', { name: 'Join Pubky' })
      .isVisible()
      .catch(() => false),
    boardMounted: (await studio.count()) > 0,
  };
}

function boardThrew(signals) {
  return (
    signals.illegal.length > 0 ||
    signals.transport ||
    signals.status === 'error' ||
    signals.nextCrash ||
    signals.applicationError
  );
}

async function probeInventoryGuest(page, pageErrors) {
  const errorOffset = pageErrors.length;
  const inventoryResponse = await gotoAndSettle(page, '/marketplace/dashboard/inventory');
  assert(
    'inventory:next-served',
    inventoryResponse !== null && inventoryResponse.status() < 500,
    `status ${inventoryResponse?.status()}`,
  );

  const signals = await collectBoardSignals(page, pageErrors, errorOffset);
  if (boardThrew(signals) || inventoryResponse === null || inventoryResponse.status() >= 500) {
    record(
      'inventory:board-route',
      false,
      boardThrowDetail({
        illegal: signals.illegal,
        transport: signals.transport,
        status: signals.status,
        bodyText: signals.bodyText,
        pageErrors: signals.slice,
      }),
    );
    return;
  }

  const guestGate = signals.redirectedHome && signals.joinVisible && !signals.boardMounted;
  const guestBoard = signals.boardMounted && (signals.status === 'unauthenticated' || signals.status === '');
  if (guestGate || guestBoard) {
    record(
      'inventory:board-route',
      true,
      guestGate
        ? 'guest Join Pubky gate (board is auth-only; no throw)'
        : `guest board status=${signals.status || 'missing'} (no throw)`,
    );
    await closeJoinDialog(page);
    return;
  }

  record(
    'inventory:board-route',
    false,
    `unexpected inventory state path=${page.url()} status=${signals.status || 'missing'} board=${signals.boardMounted} join=${signals.joinVisible}`,
  );
}

async function mountInventoryBoard(page, secretHex, pageErrors) {
  const errorOffset = pageErrors.length;
  const inventoryResponse = await gotoAndSettle(page, '/marketplace/dashboard/inventory');
  assert(
    'inventory:next-served',
    inventoryResponse !== null && inventoryResponse.status() < 500,
    `status ${inventoryResponse?.status()}`,
  );

  let signals = await collectBoardSignals(page, pageErrors, errorOffset);
  if (boardThrew(signals)) {
    record(
      'inventory:board-route',
      false,
      boardThrowDetail({
        illegal: signals.illegal,
        transport: signals.transport,
        status: signals.status,
        bodyText: signals.bodyText,
        pageErrors: signals.slice,
      }),
    );
    return;
  }

  if (signals.redirectedHome || signals.status === 'unauthenticated') {
    if (!(await signInSeller(page, secretHex))) return;
    await gotoAndSettle(page, '/marketplace/dashboard/inventory');
    signals = await collectBoardSignals(page, pageErrors, pageErrors.length);
    if (boardThrew(signals)) {
      record(
        'inventory:board-route',
        false,
        boardThrowDetail({
          illegal: signals.illegal,
          transport: signals.transport,
          status: signals.status,
          bodyText: signals.bodyText,
          pageErrors: signals.slice,
        }),
      );
      return;
    }
  }

  if (!signals.onInventory && new URL(page.url()).pathname !== '/marketplace/dashboard/inventory') {
    record('inventory:board-route', false, `expected inventory path, got ${page.url()}`);
    return;
  }

  const studio = page.locator('[data-testid="inventory-studio"]');
  const mounted = await studio
    .waitFor({ state: 'attached', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!mounted) {
    record('inventory:board-route', false, 'inventory-studio did not mount');
    return;
  }

  const pending = ['unauthenticated', 'session-required', 'grant-needed', 'ready', 'empty', 'error'];
  const settled = ['ready', 'empty', 'error'];
  let approveDetail = '';
  for (const label of ['session', 'grant']) {
    const statusNow = await waitForBoardStatus(page, pending, 20_000);
    if (settled.includes(statusNow)) break;
    if (statusNow === 'unauthenticated') {
      if (!(await signInSeller(page, secretHex))) return;
      await gotoAndSettle(page, '/marketplace/dashboard/inventory');
      continue;
    }
    const result = await approveVisibleGrant(page, secretHex, label);
    if (!result.opened) continue;
    approveDetail = result.detail;
    if (result.ok) {
      record(`inventory:${label}-approve`, true, result.detail);
      break;
    }
  }

  const status = await waitForBoardStatus(page, settled);
  const bodyText = ((await studio.textContent()) ?? '').slice(0, 400);
  const transport = /illegal invocation|transport_error|transport error/i.test(bodyText);
  const rows = await studio.locator('table tbody tr').count();
  const empty = await page.getByRole('heading', { name: 'No inventory on the service yet' }).count();
  const illegal = pageErrors.filter((message) => /illegal invocation/i.test(message));
  const boardOk =
    (status === 'ready' || status === 'empty') && !transport && illegal.length === 0 && (rows > 0 || empty > 0);

  record(
    'inventory:board-route',
    boardOk,
    `status=${status || 'missing'} rows=${rows} empty=${empty > 0} transport=${transport}${approveDetail ? ` :: ${approveDetail}` : ''}`,
  );
  assert(
    'inventory:no-transport-error',
    !transport && status !== 'error' && illegal.length === 0,
    bodyText || `status=${status}`,
  );
  assert(
    'inventory:list-seller-listings-ran',
    boardOk,
    boardOk ? `listSellerListings settled status=${status}` : `board did not reach ready/empty (status=${status})`,
  );
  await calibrateBindRevert(page);
  await runAxe(page, 'inventory');
}

async function calibrateBindRevert(page) {
  const result = await page.evaluate(async (serviceUrl) => {
    const original = window.fetch;
    const clientShaped = { fetch: original };
    let unboundThrew = false;
    try {
      await clientShaped.fetch(`${serviceUrl}/health`);
    } catch (error) {
      unboundThrew = /illegal invocation/i.test(String(error));
    }
    let boundOk = false;
    try {
      const bound = original.bind(window);
      const response = await bound(`${serviceUrl}/health`);
      boundOk = typeof response.status === 'number';
    } catch (error) {
      boundOk = !/illegal invocation/i.test(String(error));
    }
    return {
      unboundThrew,
      boundOk,
      boardMounted: Boolean(document.querySelector('[data-testid="inventory-studio"]')),
    };
  }, SERVICE_URL);
  assert(
    'inventory:bind-revert-board-mounted',
    result.boardMounted,
    result.boardMounted ? 'calibration after inventory-studio mounted' : 'board was not mounted — calibration invalid',
  );
  assert(
    'inventory:bind-revert-unbound-throws',
    result.unboundThrew,
    result.unboundThrew
      ? 'PubkyShopClient-shaped unbound Window.fetch throws Illegal invocation'
      : 'unbound Window.fetch did not throw — calibration invalid',
  );
  assert(
    'inventory:bind-revert-bound-ok',
    result.boundOk,
    result.boundOk
      ? 'bound Window.fetch is callable against the service origin'
      : 'bound Window.fetch threw Illegal invocation',
  );
}

function listingCacheRow(canonicalListing) {
  const price = canonicalListing.sale.unitPrice;
  return {
    id: `${canonicalListing.ownerPubky}:${canonicalListing.listingId}`,
    seller_id: canonicalListing.ownerPubky,
    listing_id: canonicalListing.listingId,
    record: canonicalListing,
    revision: canonicalListing.revision,
    state: canonicalListing.state,
    category_id: canonicalListing.categoryId,
    format: canonicalListing.sale.format,
    currency: price.currency,
    price_minor: price.amountMinor,
    sync_status: 'synced',
    updated_at: Date.parse(canonicalListing.updatedAt),
  };
}

function shopCacheRow(shop) {
  return {
    id: shop.ownerPubky,
    owner_id: shop.ownerPubky,
    record: shop,
    revision: shop.revision,
    sync_status: 'synced',
    updated_at: Date.parse(shop.updatedAt),
  };
}

async function seedCanonicalListingCache(page, canonicalListing, shop) {
  await page.waitForFunction(
    () => indexedDB.databases().then((dbs) => dbs.some((entry) => entry.name === 'franky')),
    undefined,
    {
      timeout: 15_000,
    },
  );
  const seeded = await page.evaluate(
    async ({ listing, shopRecord }) => {
      const put = (storeName, value) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('franky');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            if (![...db.objectStoreNames].includes(storeName)) {
              db.close();
              reject(new Error(`missing store ${storeName}`));
              return;
            }
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).put(value);
            tx.oncomplete = () => {
              db.close();
              resolve(true);
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      await put('commerce_listings', listing);
      await put('commerce_shops', shopRecord);
      return true;
    },
    { listing: listingCacheRow(canonicalListing), shopRecord: shopCacheRow(shop) },
  );
  assert('listing:fixture-cache', seeded === true, 'canonical listing+shop in Dexie franky');
}

async function main() {
  assertNotLiveNexus(NEXUS_URL);

  const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  const canonicalListing = JSON.parse(await readFile(CANONICAL_LISTING_PATH, 'utf8'));
  const shop = JSON.parse(await readFile(SHOP_FIXTURE_PATH, 'utf8'));
  const listingPath = fixture.listingPath ?? fixture.pages[1].path;
  if (!listingPath.includes(STUB_LISTING_ID) || !canonicalListing.listingId.includes(STUB_LISTING_ID)) {
    throw new Error(`required gate listingPath must be stub ${STUB_LISTING_ID}, got ${listingPath}`);
  }
  const pageErrors = [];

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  context.setDefaultTimeout(90_000);
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    pageErrors.push(String(error));
    console.error('pageerror', error);
  });
  await installStagingServiceProxy(page);

  try {
    const catalog = await gotoAndSettle(page, fixture.pages[0].path);
    assert('catalog:http', catalog !== null && catalog.ok(), `status ${catalog?.status()}`);
    await expectVisible(page, page.getByText(fixture.catalogHeading, { exact: false }), 'catalog:heading');
    try {
      await seedCanonicalListingCache(page, canonicalListing, shop);
    } catch (error) {
      record('listing:fixture-cache', false, String(error).slice(0, 240));
    }
    const sandbox = await page.getByText(fixture.forbiddenSandboxCopy).count();
    assert('catalog:not-sandbox', sandbox === 0, sandbox === 0 ? 'staging adapter' : 'sandbox copy present');

    const joinButton = page.getByTestId('header-explore-join-button');
    if (await expectVisible(page, joinButton, 'sign-in:header-join')) {
      await joinButton.click();
      await waitForJoinPubky(page);
      await closeJoinDialog(page);
    }

    await expectVisible(page, page.getByText(fixture.listingTitle, { exact: false }), 'catalog:fixture-title');
    await runAxe(page, 'catalog');

    await gotoAndSettle(page, '/marketplace/drops');
    const dropsHeading = page.getByRole('heading', { level: 1, name: 'Drops' });
    const dropsVisible = await expectVisible(page, dropsHeading, 'drops:heading');
    const dropsPath = new URL(page.url()).pathname;
    assert(
      'drops:guest-stays',
      dropsVisible && dropsPath === '/marketplace/drops',
      dropsPath === '/marketplace/drops' ? 'guest drops index' : page.url(),
    );

    await gotoAndSettle(page, listingPath);
    const onListing = page.url().includes(STUB_LISTING_ID);
    record(
      'listing:open',
      onListing,
      onListing ? page.url() : `expected stub listing ${STUB_LISTING_ID}, got ${page.url()}`,
    );
    if (onListing) {
      await exerciseListingCheckout(page);
    }

    await gotoAndSettle(page, fixture.pages[2].path);
    await page.waitForURL((url) => url.pathname === '/marketplace', { timeout: 20_000 }).catch(() => undefined);
    assert('cart:guest-redirect', new URL(page.url()).pathname === '/marketplace', page.url());
    await waitForJoinPubky(page);
    const placeOrder = await page.getByRole('button', { name: /Place .* order/i }).count();
    assert('cart:no-sandbox-checkout', placeOrder === 0, 'guest cannot place an order');
    await closeJoinDialog(page);

    await gotoAndSettle(page, fixture.pages[3].path);
    await page.waitForURL((url) => url.pathname === '/marketplace', { timeout: 20_000 }).catch(() => undefined);
    assert('compose:guest-redirect', new URL(page.url()).pathname === '/marketplace', page.url());
    await waitForJoinPubky(page);
    const studio = await page.locator('[data-surface="seller-studio"]').count();
    assert('compose:no-seller-studio', studio === 0, 'composer stays behind Join Pubky');
    await closeJoinDialog(page);

    if (REQUIRE_SELLER_BOARD) {
      const secretHex = await loadSellerSecretHex();
      if (!secretHex) {
        record(
          'inventory:board-route',
          false,
          'LAUNCH_E2E_SELLER_SECRET_HEX or staging identities file required to mount the board',
        );
      } else {
        try {
          await mountInventoryBoard(page, secretHex, pageErrors);
        } catch (error) {
          record('inventory:board-route', false, String(error).slice(0, 240));
        }
      }
    } else {
      try {
        await probeInventoryGuest(page, pageErrors);
      } catch (error) {
        record('inventory:board-route', false, String(error).slice(0, 240));
      }
    }

    const illegal = pageErrors.filter((message) => /illegal invocation/i.test(message));
    assert('inventory:no-uncaught-illegal-invocation', illegal.length === 0, illegal.join(' | ') || 'none');
    const swMime = pageErrors.filter((message) => /sw\.js/.test(message) && /unsupported MIME type/i.test(message));
    assert('launch:service-worker', swMime.length === 0, swMime[0] ?? 'sw.js did not fail registration');
  } finally {
    const summary = {
      baseUrl: BASE_URL,
      serviceUrl: SERVICE_URL,
      nexusUrl: NEXUS_URL,
      fixture: path.relative(ROOT, FIXTURE_PATH),
      listingPath,
      sellerBoardRequired: REQUIRE_SELLER_BOARD,
      results,
      pageErrors,
      failed: failures.length,
    };
    console.log(JSON.stringify(summary, null, 2));
    const resultsPath = process.env.LAUNCH_E2E_RESULTS ?? path.join(ROOT, 'launch-e2e-results.json');
    await writeFile(resultsPath, `${JSON.stringify(summary, null, 2)}\n`);
    await context.close();
    await browser.close();
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

await main();
