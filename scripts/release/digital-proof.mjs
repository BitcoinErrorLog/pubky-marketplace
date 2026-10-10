// Pure helpers for the paid digital delivery proof (production-digital-fixture.mjs). No I/O and no browser, so
// every rule that protects money or evidence is unit tested (digital-proof.test.ts).
import { createHash, randomBytes } from 'node:crypto';

export const DIGITAL_KINDS = ['file', 'link', 'text', 'email', 'message'];

// Radio labels in the seller's "How buyers receive it" editor (src/hooks/useDigitalDeliveryEditor).
export const KIND_RADIO_LABEL = {
  file: 'A file',
  link: 'A link',
  text: 'Text or a licence key',
  email: "I'll email it",
  message: "I'll send it in messages",
};

// What the editor's "current delivery" line says after a save (digitalDeliveryCurrentSummary in src/libs/commerce).
export function expectedCurrentSummary(kind, fileName, sizeLabel) {
  switch (kind) {
    case 'file':
      return `Buyers download ${fileName} (${sizeLabel}) after payment.`;
    case 'link':
      return 'Buyers get your link after payment.';
    case 'text':
      return 'Buyers see your text after payment.';
    case 'email':
      return 'You email buyers after payment, then mark it emailed.';
    case 'message':
      return 'You send it in the order messages after payment, then mark it delivered.';
    default:
      throw new Error(`unknown delivery kind ${kind}`);
  }
}

// The checkout line under a digital item (digitalCheckoutLineLabel + digitalDeliveryBadgeLabel).
export function expectedCheckoutLine(kind) {
  const how = {
    file: /^Instant download/,
    link: /^Instant access$/,
    text: /^Instant access$/,
    email: /^Emailed by the seller after payment$/,
    message: /^Sent by the seller in messages after payment$/,
  }[kind];
  if (!how) throw new Error(`unknown delivery kind ${kind}`);
  return how;
}

export const isInstantKind = (kind) => ['file', 'link', 'text'].includes(kind);

export function parseKinds(value) {
  const kinds = String(value ?? 'file')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (kinds.length === 0) throw new Error('PROOF_DIGITAL_KINDS names no delivery kind');
  for (const kind of kinds) {
    if (!DIGITAL_KINDS.includes(kind))
      throw new Error(`unknown delivery kind "${kind}"; use ${DIGITAL_KINDS.join(', ')}`);
  }
  if (new Set(kinds).size !== kinds.length) throw new Error('PROOF_DIGITAL_KINDS repeats a delivery kind');
  return kinds;
}

// One paid order is real money. The run refuses unless the environment carries today's go-ahead, which expires
// at the end of the UTC day it names so an old approval cannot start a run.
export function goToken(now = new Date()) {
  return `GO-${now.toISOString().slice(0, 10)}`;
}

export function hasGoAhead(env, now = new Date()) {
  return env.PROOF_DIGITAL_GO === goToken(now);
}

const PRICE = /^\d{1,4}\.\d{2}$/;

export function parsePriceUsd(value) {
  const text = String(value ?? '2.00');
  if (!PRICE.test(text)) throw new Error('PROOF_DIGITAL_PRICE_USD must look like 2.00 (dollars, two decimals)');
  const cents = Math.round(Number(text) * 100);
  if (cents < 100) throw new Error('PROOF_DIGITAL_PRICE_USD must be at least 1.00');
  if (cents > 2500) throw new Error('PROOF_DIGITAL_PRICE_USD is capped at 25.00 for a proof order');
  return { text, cents };
}

// The service refuses a Bitcoin bind under 1,000 sats (payment_methods.rs). The price must clear that with a
// margin so a rate move between quote and payment cannot flip it.
export const SERVICE_MIN_SATS = 1000;

export function minPriceCents(usdPerBtc, margin = 2) {
  if (!Number.isFinite(usdPerBtc) || usdPerBtc <= 0) throw new Error('a positive BTC/USD rate is required');
  return Math.ceil(((SERVICE_MIN_SATS * margin * usdPerBtc) / 1e8) * 100);
}

export function priceClearsMinimum(cents, usdPerBtc, margin = 2) {
  return cents >= minPriceCents(usdPerBtc, margin);
}

// A fixture file that cannot be mistaken for real content: a text header plus random bytes, so a hash match
// proves the bytes survived encrypt, store, pin, fetch and decrypt.
export function makeFixtureFile(runId, bytes = 64 * 1024) {
  if (bytes < 1024) throw new Error('the fixture file must be at least 1 KiB');
  const header = Buffer.from(`pubky digital delivery proof ${runId}. Do not use.\n`, 'utf8');
  const body = Buffer.concat([header, randomBytes(bytes - header.length)]);
  return { name: `digital-proof-${runId}.bin`, bytes: body, sha256: sha256Hex(body) };
}

export const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

export function formatSizeLabel(sizeBytes) {
  const kilobytes = sizeBytes / 1024;
  if (kilobytes < 1024) return `${Math.max(1, Math.round(kilobytes))} KB`;
  const megabytes = kilobytes / 1024;
  return megabytes < 10 ? `${megabytes.toFixed(1)} MB` : `${Math.round(megabytes)} MB`;
}

export const newRunId = () => randomBytes(3).toString('hex');

export const listingTitle = (runId, kind) => `TEST, do not buy ${runId} ${kind}`;

// Reasons the pay wait ended, in the order they are decided.
export function payOutcome({ paid, elapsedMs, timeoutMs }) {
  if (paid) return 'paid';
  return elapsedMs >= timeoutMs ? 'timeout' : 'waiting';
}

// The Bitcoin hold is 30 minutes (BITCOIN_PAYMENT_WINDOW_SECONDS). A wait that could outlast it would leave the
// operator paying an invoice the service already voided.
export const BITCOIN_WINDOW_MINUTES = 30;

export function parsePayTimeoutMinutes(value) {
  const minutes = Number(value ?? 25);
  if (!Number.isInteger(minutes) || minutes < 2 || minutes > BITCOIN_WINDOW_MINUTES - 3) {
    throw new Error(`PROOF_DIGITAL_PAY_TIMEOUT_MIN must be a whole number from 2 to ${BITCOIN_WINDOW_MINUTES - 3}`);
  }
  return minutes;
}

// Deliverable ciphertext paths the run created: those under the deliverables folder now that were not there
// before setup. Only these are ever deleted.
export const DELIVERABLES_PREFIX = '/pub/pubky.app/marketplace/v1/deliverables/';

export function pathFromPubkyUrl(url) {
  const match = String(url).match(/^pubky:\/\/[^/]+(\/.*)$/);
  return match ? match[1] : null;
}

export function newDeliverablePaths(before, after) {
  const known = new Set(before);
  return after.filter((path) => path.startsWith(DELIVERABLES_PREFIX) && !known.has(path));
}

export function redactEmail(text, email) {
  return email ? String(text ?? '').replaceAll(email, '[redacted-email]') : String(text ?? '');
}

// The step list `plan` prints and the evidence folder records; no step here is run by the planner.
export function describePlan({ kinds, priceText, origin, service }) {
  const lines = [
    `origin ${origin}`,
    `service ${service}`,
    `price ${priceText} USD per listing, paid in Bitcoin (service quote, 1,000-sat floor)`,
    `kinds ${kinds.join(', ')}`,
    'setup: one "TEST, do not buy" digital listing per kind from the seller seat, delivery set on its edit page',
  ];
  for (const kind of kinds) {
    lines.push(
      `${kind}: buyer seat checks out, Pay; an operator pays the Bitkit Payment Request; then ${describeSettle(kind)}`,
    );
  }
  lines.push(
    'teardown: delete the listings and their ciphertext, revoke run sessions, verify; paid orders remain as evidence',
  );
  return lines;
}

function describeSettle(kind) {
  switch (kind) {
    case 'file':
      return 'the buyer downloads twice and the SHA-256 matches; the seller sees the access evidence';
    case 'link':
      return 'the buyer shows the link and it equals the one set; the seller sees the access evidence';
    case 'text':
      return 'the buyer reveals the text and it equals the one set; the seller sees the access evidence';
    case 'email':
      return 'the seller shows the email, emails it by hand, marks it emailed; the buyer sees "Emailed to"';
    case 'message':
      return 'the seller sends it in messages by hand, marks it delivered; the buyer sees the delivered line';
    default:
      throw new Error(`unknown delivery kind ${kind}`);
  }
}
