#!/usr/bin/env node
/**
 * Local HTTP stub for the required launch-e2e gate.
 *
 * Serves a committed catalog/listing/drop JSON set so Next SSR and the
 * Chromium runner never read live nexusd 7108. Nightly Cypress may still
 * hit staging; this process is only for the required PR check.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'src/test/e2e/fixtures/nexus');
const HOST = process.env.LAUNCH_E2E_NEXUS_STUB_HOST ?? '127.0.0.1';
const PORT = Number(process.env.LAUNCH_E2E_NEXUS_STUB_PORT ?? '7109');

const SELLER = 'nkcct8tzquo8n4z5ysz9t963ye9kq1w7gb55aad1z4tmsgjjhmto';
const LISTING_ID = '2b81df4f390b40e5b0aedabb89e76fa0';

const fixtures = {
  streamListings: JSON.parse(await readFile(path.join(FIXTURE_DIR, 'stream-listings.json'), 'utf8')),
  listing: JSON.parse(await readFile(path.join(FIXTURE_DIR, 'listing.json'), 'utf8')),
  drops: JSON.parse(await readFile(path.join(FIXTURE_DIR, 'drops.json'), 'utf8')),
  canonicalListing: JSON.parse(await readFile(path.join(FIXTURE_DIR, 'canonical-listing.json'), 'utf8')),
  shop: JSON.parse(await readFile(path.join(FIXTURE_DIR, 'shop.json'), 'utf8')),
};

function send(response, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'accept,content-type',
    'cache-control': 'no-store',
  });
  response.end(payload);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
  if (request.method === 'OPTIONS') {
    send(response, 204, '');
    return;
  }
  if (request.method !== 'GET') {
    send(response, 405, { error: 'method_not_allowed' });
    return;
  }
  if (url.pathname === '/health') {
    send(response, 200, { ok: true, fixture: 'launch-e2e' });
    return;
  }
  if (url.pathname === '/v0/stream/listings') {
    send(response, 200, fixtures.streamListings);
    return;
  }
  if (url.pathname === '/v0/stream/drops') {
    send(response, 200, fixtures.drops);
    return;
  }
  if (url.pathname === `/v0/listing/${SELLER}/${LISTING_ID}`) {
    send(response, 200, fixtures.listing);
    return;
  }
  if (url.pathname === `/v0/shop/${SELLER}`) {
    send(response, 200, fixtures.shop);
    return;
  }
  if (url.pathname === `/pub/pubky.app/marketplace/v1/listings/${LISTING_ID}`) {
    send(response, 200, fixtures.canonicalListing);
    return;
  }
  if (url.pathname === `/pub/pubky.app/marketplace/v1/shop.json`) {
    send(response, 200, fixtures.shop);
    return;
  }
  send(response, 404, { error: 'not_found', path: url.pathname });
});

server.listen(PORT, HOST, () => {
  console.log(`launch-e2e nexus stub http://${HOST}:${PORT}`);
});
