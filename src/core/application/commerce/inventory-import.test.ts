import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommerceInventoryImportApplication,
  CONFLICT_CONFIRMED,
  CONFLICT_DISCARDED,
  IMPORT_PARSE_FAIL_COPY,
} from '@/application/commerce/inventory-import';
import { listingToCanonicalRows } from '@/application/commerce/inventory-listing-map';
import { COMMERCE_LISTING_MAX_QUANTITY } from '@/config/commerce';
import { UNLIMITED_STOCK_RESERVED_MESSAGE } from '@/libs/commerce/unlimited-stock';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import type { HostImportManifest, InventoryManifestStore } from '@/services/marketplace/marketplace-import-store';
import {
  type CanonicalCsvRow,
  DEFAULT_JSON_LIMITS,
  MarketplaceShopClientService,
  type ShopBrowserFile,
  SYNC_MANY_LIMIT,
  type SyncManyEnvelope,
} from '@/services/marketplace/marketplace-shop-client';
import { createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import { asOpaque } from '@/test-utils/type-assertions';

const PUBKY = 'y'.repeat(52);

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => 'transaction-service',
    getMarketplaceUrl: () => 'https://staging-api.pubky.app',
    isDurableCommerceMode: () => true,
  };
});

vi.mock('@/services/marketplace/marketplace-session', () => ({
  MarketplaceSessionService: {
    getActiveSession: () => ({ token: 'identity', pubky: PUBKY, capabilities: '', expiresAt: Date.now() + 60_000 }),
  },
}));

vi.mock('@/services/marketplace/marketplace-inventory-session', () => ({
  MarketplaceInventorySessionService: {
    getCoveringBearer: (sellerPubky: string) =>
      sellerPubky === PUBKY ? { token: 'inventory', source: 'inventory' } : null,
  },
}));

class MemoryImportStore implements InventoryManifestStore {
  manifests = new Map<string, HostImportManifest>();
  payloads = new Map<string, string>();

  async create(manifest: HostImportManifest): Promise<void> {
    if (this.manifests.has(manifest.manifestId)) throw new Error('manifest_conflict');
    this.manifests.set(manifest.manifestId, structuredClone(manifest));
  }

  async load(manifestId: string): Promise<HostImportManifest | null> {
    const current = this.manifests.get(manifestId);
    return current ? structuredClone(current) : null;
  }

  async compareAndSwap(
    manifestId: string,
    expectedVersion: number,
    update: (manifest: HostImportManifest) => HostImportManifest,
  ): Promise<HostImportManifest> {
    const current = this.manifests.get(manifestId);
    if (!current || current.manifestVersion !== expectedVersion) throw new Error('manifest_conflict');
    const next = update(structuredClone(current));
    this.manifests.set(manifestId, next);
    return structuredClone(next);
  }

  async persistPayloads(manifestId: string, payloads: ReadonlyMap<string, string>): Promise<void> {
    for (const [key, value] of payloads) this.payloads.set(`${manifestId}:${key}`, value);
  }

  async getPayloadJson(manifestId: string, rowIdentity: string): Promise<string | null> {
    return this.payloads.get(`${manifestId}:${rowIdentity}`) ?? null;
  }

  async listProgress(_manifestId: string) {
    return [];
  }

  async pruneExpired(): Promise<void> {}

  async getMapping(): Promise<Record<string, string> | null> {
    return null;
  }

  async putMapping(_mapping: Record<string, string>): Promise<void> {}
}

class BytesFile implements ShopBrowserFile {
  arrayBufferCalls = 0;

  constructor(
    private readonly bytes: Uint8Array,
    readonly name: string,
    readonly type = '',
    readonly reportedSize = bytes.byteLength,
  ) {}

  get size(): number {
    return this.reportedSize;
  }

  stream(): ReadableStream<Uint8Array> {
    const bytes = this.bytes instanceof Uint8Array ? this.bytes : new Uint8Array(this.bytes);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    Object.defineProperty(stream, Symbol.asyncIterator, {
      configurable: true,
      value: async function* () {
        yield bytes;
      },
    });
    return stream;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.arrayBufferCalls += 1;
    return this.bytes.slice().buffer;
  }

  slice(start = 0, end = this.bytes.byteLength): { arrayBuffer: () => Promise<ArrayBuffer> } {
    const part = this.bytes.slice(start, end);
    return {
      arrayBuffer: async () => part.slice().buffer,
    };
  }
}

function canonicalRow(listingId: string, overrides: Partial<CanonicalCsvRow> = {}): CanonicalCsvRow {
  const record = createCommerceListingFixture({ listingId });
  const [row] = listingToCanonicalRows(record);
  return { ...row, ...overrides };
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function syncOk(results: Array<{ listing_id: string; status: number }>): {
  readonly ok: true;
  readonly value: SyncManyEnvelope;
} {
  return {
    ok: true,
    value: asOpaque<SyncManyEnvelope>({
      schema_version: BigInt(1),
      kind: 'listing.sync_many',
      results,
    }),
  };
}

describe('MarketplaceShopClientService import helpers', () => {
  it('chunks sync-many at 100', () => {
    const listings = Array.from({ length: 101 }, (_, index) => ({
      seller_pubky: PUBKY,
      listing_id: `id_${index}`,
    }));
    const chunks = MarketplaceShopClientService.chunkSyncMany(listings);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(SYNC_MANY_LIMIT);
    expect(chunks[1]).toHaveLength(1);
  });

  it('classifies 207 item success and failure separately', () => {
    const ok = MarketplaceShopClientService.classifySyncItem({ listing_id: 'boots_01', status: 200 });
    const missing = MarketplaceShopClientService.classifySyncItem({
      listing_id: 'boots_02',
      status: 404,
      message: 'missing',
    });
    expect(ok).toMatchObject({ listingId: 'boots_01', ok: true });
    expect(missing).toMatchObject({ listingId: 'boots_02', ok: false });
  });

  it('does not call arrayBuffer for an oversize JSON file', async () => {
    const store = new MemoryImportStore();
    const file = new BytesFile(
      utf8('{"rows":[]}'),
      'listings.json',
      'application/json',
      DEFAULT_JSON_LIMITS.maxBytes + 1,
    );
    const planned = await MarketplaceShopClientService.planBrowserFile(file, store);
    expect(planned.ok).toBe(false);
    expect(file.arrayBufferCalls).toBe(0);
    if (!planned.ok) {
      expect(MarketplaceShopClientService.formatPlanFailure(planned.error)).toMatch(/^This file exceeds /);
    }
  });

  it('quotes formula prefixes in persisted JSON payloads', async () => {
    const store = new MemoryImportStore();
    const row = canonicalRow('boots_01', { title: '=HYPERLINK("http://x")' });
    const file = new BytesFile(utf8(JSON.stringify([row])), 'listings.json', 'application/json');
    const planned = await MarketplaceShopClientService.planBrowserFile(file, store);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const manifest = await store.load(planned.value.manifestId);
    expect(manifest?.rows).toHaveLength(1);
    const payload = await store.getPayloadJson(planned.value.manifestId, manifest!.rows[0]!.rowIdentity);
    expect(payload).toContain("'=HYPERLINK");
    expect(payload).not.toMatch(/"title":"=HYPERLINK/);
  });

  it('plans JSON rows and persists payloads without publishing', async () => {
    const store = new MemoryImportStore();
    const row = canonicalRow('boots_01');
    const file = new BytesFile(utf8(JSON.stringify([row])), 'listings.json', 'application/json');
    const planned = await MarketplaceShopClientService.planBrowserFile(file, store);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const manifest = await store.load(planned.value.manifestId);
    expect(manifest?.rows).toHaveLength(1);
    expect(manifest?.rows[0]?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const payload = await store.getPayloadJson(planned.value.manifestId, manifest!.rows[0]!.rowIdentity);
    expect(payload).toContain('boots_01');
  });
});

describe('CommerceInventoryImportApplication', () => {
  let store: MemoryImportStore;
  let puts: string[];
  let syncCalls: { seller_pubky: string; listing_id: string }[][];

  beforeEach(() => {
    store = new MemoryImportStore();
    puts = [];
    syncCalls = [];
  });

  function app(syncResults: Array<{ listing_id: string; status: number }>[] = []) {
    let syncIndex = 0;
    return CommerceInventoryImportApplication.forSeller(PUBKY, {
      store,
      currentItems: async () => ({}),
      putListing: async (record) => {
        puts.push(record.listingId);
      },
      listingExists: async () => false,
      syncMany: async (listings) => {
        syncCalls.push([...listings]);
        const items =
          syncResults[syncIndex] ?? listings.map((listing) => ({ listing_id: listing.listing_id, status: 200 }));
        syncIndex += 1;
        return syncOk(items);
      },
    });
  }

  it('parse failure publishes zero rows', async () => {
    const result = await app().planFile(new BytesFile(utf8('not-csv-or-json'), 'bad.txt'));
    expect(result).toMatchObject({ status: 'parse-failed', puts: 0, message: IMPORT_PARSE_FAIL_COPY });
    expect(puts).toEqual([]);
    expect(store.manifests.size).toBe(0);
  });

  it('plans a current Shopify product CSV without using inventory quantity as stock', async () => {
    const bytes = new Uint8Array(
      readFileSync(resolve(__dirname, '../../../test/fixtures/shopify/product-current.csv')),
    );
    const result = await app().planFile(new BytesFile(bytes, 'product-current.csv', 'text/csv'));
    expect(result).toMatchObject({ status: 'planned', rowCount: 2 });
    const payloads = [...store.payloads.values()].map(
      (value) => JSON.parse(value) as { listingId: string; sku: string; variantQuantity: number; amountMinor: number },
    );
    expect(payloads).toHaveLength(2);
    expect(payloads.every((row) => row.listingId === 'night-boots')).toBe(true);
    expect(payloads.map((row) => row.sku).sort()).toEqual(['BOOT-L', 'BOOT-M']);
    expect(payloads.map((row) => row.variantQuantity)).toEqual([0, 0]);
    expect(payloads.every((row) => row.amountMinor === 12_500)).toBe(true);
    expect(JSON.stringify(payloads)).not.toContain('draft-hat');
    expect(puts).toEqual([]);
  });

  it('rejects a formula_payload CSV and never PUTs', async () => {
    const header =
      'record_uri,seller_pubky,listing_id,source_listing_key,record_revision,variant_id,sku,state,title,description,taxonomy_json,category,condition,tags_json,amount_minor,currency,exponent,variant_quantity,variant_enabled,options_json,media_json,shipping_options_json,return_policy_json,sale_json,external_refs_json';
    const row = `,${PUBKY},boots_01,,1,variant_01,,active,=HYPERLINK("http://x"),desc,{},fashion,good,[],1,USD,2,1,true,{},[],[],{},{},{}`;
    const result = await app().planFile(new BytesFile(utf8(`${header}\n${row}\n`), 'listings.csv', 'text/csv'));
    expect(result.status).toBe('parse-failed');
    expect(puts).toEqual([]);
  });

  it('publishes then classifies mixed 207 without a second PUT on resume', async () => {
    const importer = app([
      [{ listing_id: 'boots_01', status: 200 }],
      [{ listing_id: 'hat_01', status: 500 }],
      [{ listing_id: 'hat_01', status: 200 }],
    ]);
    const planned = await importer.planFile(
      new BytesFile(
        utf8(JSON.stringify([canonicalRow('boots_01'), canonicalRow('hat_01')])),
        'two.json',
        'application/json',
      ),
    );
    expect(planned.status).toBe('planned');
    if (planned.status !== 'planned') return;

    const first = await importer.publish(planned.manifestId);
    expect(puts).toEqual(['boots_01', 'hat_01']);
    expect(first.status).toBe('complete');
    if (first.status === 'complete') expect(first.mixed).toBe(true);

    const resumed = await importer.resume(planned.manifestId);
    expect(puts).toEqual(['boots_01', 'hat_01']);
    expect(syncCalls.at(-1)).toEqual([{ seller_pubky: PUBKY, listing_id: 'hat_01' }]);
    expect(resumed.status).toBe('complete');
  });

  // Sol round 3: Inventory Studio publishes through its own path, so the
  // shared stock rule must refuse the unlimited cap there too.
  it.each(['record_json', 'fielded'] as const)(
    'refuses a physical listing at the unlimited cap before any PUT or sync (%s row)',
    async (shape) => {
      const record = createCommerceListingFixture({ listingId: 'boots_01' });
      record.variants = record.variants.map((variant) => ({ ...variant, quantity: COMMERCE_LISTING_MAX_QUANTITY }));
      const rows = listingToCanonicalRows(record).map((row) =>
        shape === 'record_json' ? row : { ...row, extraFields: { country_code: row.extraFields.country_code } },
      );
      const importer = app();
      const planned = await importer.planFile(
        new BytesFile(utf8(JSON.stringify(rows)), 'cap.json', 'application/json'),
      );
      expect(planned.status).toBe('planned');
      if (planned.status !== 'planned') return;

      const published = await importer.publish(planned.manifestId);

      expect(published).toEqual({ status: 'error', message: UNLIMITED_STOCK_RESERVED_MESSAGE });
      expect(puts).toEqual([]);
      expect(syncCalls).toEqual([]);
    },
  );

  it('publishes a digital-only listing at the cap, which is how Unlimited is stored', async () => {
    const record = createCommerceListingFixture({
      listingId: 'guide_01',
      fulfillmentMethods: ['digital'],
      package: undefined,
      shippingOptions: [],
    });
    record.variants = record.variants.map((variant) => ({ ...variant, quantity: COMMERCE_LISTING_MAX_QUANTITY }));
    const importer = app();
    const planned = await importer.planFile(
      new BytesFile(utf8(JSON.stringify(listingToCanonicalRows(record))), 'guide.json', 'application/json'),
    );
    if (planned.status !== 'planned') throw new Error(`not planned: ${planned.status}`);

    await importer.publish(planned.manifestId);

    expect(puts).toEqual(['guide_01']);
  });

  it('checkpoints conflict on CAS 409 and does not overwrite', async () => {
    const importer = CommerceInventoryImportApplication.forSeller(PUBKY, {
      store,
      currentItems: async () => ({}),
      putListing: async () => {
        throw Err.client(ClientErrorCode.CONFLICT, 'The published listing changed.', {
          service: ErrorService.Homeserver,
          operation: 'putVerifiedPublicListing',
        });
      },
      listingExists: async () => false,
      syncMany: async () => syncOk([]),
    });
    const planned = await importer.planFile(
      new BytesFile(utf8(JSON.stringify([canonicalRow('boots_01')])), 'one.json', 'application/json'),
    );
    expect(planned.status).toBe('planned');
    if (planned.status !== 'planned') return;
    const published = await importer.publish(planned.manifestId);
    expect(published.status).toBe('conflict');
  });

  it('confirm on a CAS 409 skips overwrite and publishes remaining rows', async () => {
    const importer = CommerceInventoryImportApplication.forSeller(PUBKY, {
      store,
      currentItems: async () => ({}),
      putListing: async (record) => {
        if (record.listingId === 'boots_01') {
          throw Err.client(ClientErrorCode.CONFLICT, 'The published listing changed.', {
            service: ErrorService.Homeserver,
            operation: 'putVerifiedPublicListing',
          });
        }
        puts.push(record.listingId);
      },
      listingExists: async () => false,
      syncMany: async (listings) => {
        syncCalls.push([...listings]);
        return syncOk(listings.map((listing) => ({ listing_id: listing.listing_id, status: 200 })));
      },
    });
    const planned = await importer.planFile(
      new BytesFile(
        utf8(JSON.stringify([canonicalRow('boots_01'), canonicalRow('hat_01')])),
        'two.json',
        'application/json',
      ),
    );
    expect(planned.status).toBe('planned');
    if (planned.status !== 'planned') return;
    const published = await importer.publish(planned.manifestId);
    expect(published.status).toBe('conflict');
    if (published.status !== 'conflict') return;
    const confirmed = await importer.confirmConflict(planned.manifestId, published.listingId);
    expect(puts).toEqual(['hat_01']);
    expect(confirmed.status).toBe('complete');
    const manifest = await store.load(planned.manifestId);
    const boots = manifest?.rows.find((row) => row.listingId === 'boots_01');
    expect(boots?.checkpoint).toBe('conflict');
    expect(boots?.failureCode).toBe(CONFLICT_CONFIRMED);
    expect(puts).toEqual(['hat_01']);
  });

  it('discard on a CAS 409 does not PUT that listing again', async () => {
    const importer = CommerceInventoryImportApplication.forSeller(PUBKY, {
      store,
      currentItems: async () => ({}),
      putListing: async () => {
        throw Err.client(ClientErrorCode.CONFLICT, 'The published listing changed.', {
          service: ErrorService.Homeserver,
          operation: 'putVerifiedPublicListing',
        });
      },
      listingExists: async () => false,
      syncMany: async () => syncOk([]),
    });
    const planned = await importer.planFile(
      new BytesFile(utf8(JSON.stringify([canonicalRow('boots_01')])), 'one.json', 'application/json'),
    );
    expect(planned.status).toBe('planned');
    if (planned.status !== 'planned') return;
    const published = await importer.publish(planned.manifestId);
    expect(published.status).toBe('conflict');
    const discarded = await importer.discardConflict(planned.manifestId, '');
    expect(discarded.status).toBe('complete');
    const manifest = await store.load(planned.manifestId);
    expect(manifest?.rows[0]?.failureCode).toBe(CONFLICT_DISCARDED);
    expect(puts).toEqual([]);
  });

  it('quotes formula prefixes in the result CSV download', async () => {
    const planned = await app().planFile(
      new BytesFile(utf8(JSON.stringify([canonicalRow('boots_01')])), 'one.json', 'application/json'),
    );
    expect(planned.status).toBe('planned');
    if (planned.status !== 'planned') return;
    const manifest = await store.load(planned.manifestId);
    expect(manifest).not.toBeNull();
    if (!manifest) return;
    const [row] = manifest.rows;
    expect(row).toBeDefined();
    if (!row) return;
    store.manifests.set(planned.manifestId, {
      ...manifest,
      rows: [
        {
          ...row,
          listingId: '=CMD',
          rowIdentity: '+id',
          checkpoint: 'failed',
          failureCode: '@SUM(1)',
        },
      ],
    });
    const csv = await app().resultCsv(planned.manifestId);
    expect(csv).toContain('"\'=CMD"');
    expect(csv).toContain('"\'+id"');
    expect(csv).toContain('"\'@SUM(1)"');
    for (const line of csv.trim().split('\n').slice(1)) {
      expect(line).not.toMatch(/(?:^|,)[=+\-@]/);
    }
  });

  it('plans 250 JSON rows', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => canonicalRow(`item_${index}`));
    const planned = await app().planFile(new BytesFile(utf8(JSON.stringify(rows)), 'bulk.json', 'application/json'));
    expect(planned.status).toBe('planned');
    if (planned.status === 'planned') expect(planned.rowCount).toBe(250);
  });

  it('re-plans exported canonical CSV without duplicate headers', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => canonicalRow(`csv_${index}`));
    const csv = MarketplaceShopClientService.exportListingsCsv(rows);
    const header = new TextDecoder().decode(csv).split(/\r?\n/, 1)[0] ?? '';
    const cells = header.split(',').map((cell) => cell.replaceAll('"', ''));
    expect(new Set(cells).size).toBe(cells.length);
    const file = new BytesFile(csv, 'listings.csv', 'text/csv');
    const raw = await MarketplaceShopClientService.planBrowserFile(file, store);
    expect(raw.ok, raw.ok ? 'ok' : `${raw.error.code}: ${raw.error.message} ${JSON.stringify(raw.error.details)}`).toBe(
      true,
    );
    const planned = await app().planFile(file);
    expect(planned.status).toBe('planned');
    if (planned.status === 'planned') expect(planned.rowCount).toBe(3);
  });
});
