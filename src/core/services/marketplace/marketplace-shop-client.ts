import {
  browserFileSource,
  type CanonicalCsvRow,
  canonicalCsvRowIdentity,
  type CheckpointImportResult,
  checkpointImportRow,
  chunkSyncManyListings,
  classifySyncManyItem,
  type CurrentImportItem,
  DEFAULT_CSV_LIMITS,
  DEFAULT_JSON_LIMITS,
  type DryRunCounts,
  dryRunCounts,
  exportCanonicalCsv,
  type ImportCheckpoint,
  type ImportManifest,
  type InventoryAdjustmentEnvelope,
  type InventoryAdjustRequest,
  type InventoryProjection,
  listingIdentity,
  type LosslessJsonObject,
  type ManifestStore,
  normalizedCsvRowHash,
  parseBoundedJson,
  parseCanonicalCsvStream,
  planImport,
  planImportStream,
  type PlannedImportRow,
  PubkyShopClient,
  PubkyShopError,
  type ResumeTask,
  resumeTasks,
  type SdkResult,
  streamResumeTasks,
  SYNC_MANY_LIMIT,
  type SyncManyClassification,
  type SyncManyEnvelope,
  type SyncManyListing,
} from '@bitcoinerrorlog/pubky-shop';
import {
  canonicalRowsFor,
  mapShopifyProductCsv,
  SHOPIFY_PRODUCT_CSV_HEADERS,
} from '@bitcoinerrorlog/pubky-shop/connectors/shopify/map';
import { getMarketplaceUrl } from '@/config/commerce';
import type { InventoryManifestStore } from '@/services/marketplace/marketplace-import-store';

/**
 * The only Shop module that imports `@bitcoinerrorlog/pubky-shop`. Components
 * and hooks go through controllers. The `.` export is the inventory client.
 * Shopify CSV detection uses the browser-safe `connectors/shopify/map` entry
 * so the bridge's node modules stay out of this graph.
 */

/** Shopify product CSV prices are major units on the listing form's USD scale. */
export const SHOPIFY_CSV_PRICE = { currency: 'USD', exponent: 2 } as const;

export type ShopifyCsvImportConfig = {
  readonly sellerPubky: string;
  readonly currency: string;
  readonly exponent: number;
};
export type ShopBrowserFile = {
  readonly size: number;
  readonly name?: string;
  readonly type?: string;
  stream(): ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, contentType?: string): { arrayBuffer(): Promise<ArrayBuffer> };
};

export type PlannedBrowserFile = {
  readonly manifestId: string;
  readonly rowCount: number;
};

const SHOPIFY_HEADER_SET = new Set<string>(SHOPIFY_PRODUCT_CSV_HEADERS);

function csvHeaderCells(bytes: Uint8Array): readonly string[] | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const line = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  if (!line.includes(',')) return undefined;
  return line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
}

function isShopifyProductCsv(cells: readonly string[]): boolean {
  if (cells.includes('record_uri')) return false;
  const hits = cells.filter((cell) => SHOPIFY_HEADER_SET.has(cell));
  return hits.includes('URL handle') || hits.includes('Handle');
}

async function planShopifyProductCsv(
  file: ShopBrowserFile,
  manifestStore: ManifestStore,
  store: InventoryManifestStore,
  currentItems: Readonly<Record<string, CurrentImportItem>>,
  config: ShopifyCsvImportConfig | undefined,
): Promise<SdkResult<PlannedBrowserFile>> {
  if (!config) {
    return { ok: false, error: new PubkyShopError('invalid_configuration', { field: 'sellerPubky' }) };
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    return { ok: false, error: new PubkyShopError('invalid_configuration', { field: 'file.size' }) };
  }
  if (file.size > DEFAULT_CSV_LIMITS.maxBytes) {
    return {
      ok: false,
      error: new PubkyShopError('limit_exceeded', {
        field: 'csv_bytes',
        limit: DEFAULT_CSV_LIMITS.maxBytes,
        observed: Math.min(file.size, DEFAULT_CSV_LIMITS.maxBytes + 1),
      }),
    };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > DEFAULT_CSV_LIMITS.maxBytes) {
    return {
      ok: false,
      error: new PubkyShopError('limit_exceeded', {
        field: 'csv_bytes',
        limit: DEFAULT_CSV_LIMITS.maxBytes,
        observed: Math.min(bytes.byteLength, DEFAULT_CSV_LIMITS.maxBytes + 1),
      }),
    };
  }
  const mapped = mapShopifyProductCsv(bytes, config);
  const rows = mapped.products.flatMap((product) => canonicalRowsFor(product, [], { includeZeroQuantity: true }));
  // Plan the mapped rows as JSON. The CSV stream parser rejects Uint8Array
  // chunks from another realm, which this app's bundler produces.
  const json = new TextEncoder().encode(JSON.stringify(rows));
  if (json.byteLength > DEFAULT_JSON_LIMITS.maxBytes) {
    return {
      ok: false,
      error: new PubkyShopError('limit_exceeded', {
        field: 'json_bytes',
        limit: DEFAULT_JSON_LIMITS.maxBytes,
        observed: Math.min(json.byteLength, DEFAULT_JSON_LIMITS.maxBytes + 1),
      }),
    };
  }
  const planned = await planImport(json, {
    store: manifestStore,
    currentItems,
    limits: { maxBytes: DEFAULT_JSON_LIMITS.maxBytes },
  });
  if (!planned.ok) return planned;
  const payloads = jsonPayloads(parseBoundedJson(json, { maxBytes: DEFAULT_JSON_LIMITS.maxBytes }));
  await store.persistPayloads(planned.value.manifestId, payloads);
  return {
    ok: true,
    value: { manifestId: planned.value.manifestId, rowCount: planned.value.rowCount },
  };
}

const JSON_LEAD = new Set([0x7b, 0x5b]);

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstNonWs(bytes: Uint8Array): number | undefined {
  for (const byte of bytes) {
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return byte;
  }
  return undefined;
}

function namedJson(file: ShopBrowserFile): boolean {
  const name = file.name?.toLowerCase() ?? '';
  const type = file.type?.toLowerCase() ?? '';
  return name.endsWith('.json') || type.includes('json');
}

async function peekLooksLikeJson(file: ShopBrowserFile): Promise<boolean> {
  if (namedJson(file)) return true;
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return false;
  const peek = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const lead = firstNonWs(peek);
  return lead !== undefined && JSON_LEAD.has(lead);
}

/** Same prefix as SDK `exportCanonicalCsv` / `formulaProtected`. */
const FORMULA_PREFIX = /^[=+\-@]/;
const FORMULA_IDENTITY_KEYS = new Set([
  'listingId',
  'listing_id',
  'sellerPubky',
  'seller_pubky',
  'recordUri',
  'record_uri',
  'variantId',
  'variant_id',
  'rowIdentity',
]);

function formulaProtected(value: string): string {
  if (value.startsWith("'") || FORMULA_PREFIX.test(value)) {
    return `'${value}`;
  }
  return value;
}

function quoteFormulaStrings(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    return key !== undefined && FORMULA_IDENTITY_KEYS.has(key) ? value : formulaProtected(value);
  }
  if (Array.isArray(value)) return value.map((entry) => quoteFormulaStrings(entry));
  const object = asObject(value);
  if (!object) return value;
  const next: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(object)) {
    next[field] = quoteFormulaStrings(entry, field);
  }
  return next;
}

function jsonPayloads(value: unknown): Map<string, string> {
  const items = Array.isArray(value)
    ? value
    : asObject(value) && Array.isArray(asObject(value)?.rows)
      ? (asObject(value)?.rows as unknown[])
      : [];
  const payloads = new Map<string, string>();
  for (const item of items) {
    const object = asObject(item);
    if (!object) continue;
    const row = object as unknown as CanonicalCsvRow;
    payloads.set(canonicalCsvRowIdentity(row), JSON.stringify(quoteFormulaStrings(object)));
  }
  return payloads;
}

export class MarketplaceShopClientService {
  private constructor() {}

  static serviceOrigin(): string {
    return new URL(getMarketplaceUrl()).origin;
  }

  static createInventoryClient(session: string): PubkyShopClient {
    return new PubkyShopClient({
      session,
      serviceUrl: this.serviceOrigin(),
      // Chromium throws "Illegal invocation" when Window.fetch runs with `this`
      // bound to PubkyShopClient. Node fetch does not, which hid the board crash.
      fetch: globalThis.fetch.bind(globalThis),
    });
  }

  static isCapabilityRequired(error: PubkyShopError): boolean {
    return error.code === 'service_error' && error.details.serviceCode === 'capability_required';
  }

  static isRevisionConflict(error: PubkyShopError): boolean {
    return error.code === 'service_error' && error.details.serviceCode === 'revision_conflict';
  }

  static isSessionRejected(error: PubkyShopError): boolean {
    return error.code === 'session_rejected';
  }

  static isRateLimited(error: PubkyShopError): boolean {
    return (
      error.details.status === 429 || (error.code === 'service_error' && error.details.serviceCode === 'rate_limited')
    );
  }

  static formatPlanFailure(error: PubkyShopError): string {
    if (error.code === 'limit_exceeded') {
      const limit = error.details.limit ?? 0;
      const observed = error.details.observed ?? 0;
      return `This file exceeds ${limit} (${observed}).`;
    }
    return 'This file could not be planned. Nothing was published.';
  }

  static formatRateLimitCopy(error: PubkyShopError): string {
    const retryAfter = (error.details as { retryAfter?: number }).retryAfter;
    const wait = typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? String(retryAfter) : 'a few';
    return `Too many inventory requests. Wait ${wait} seconds.`;
  }

  static async listSellerListings(
    client: PubkyShopClient,
    pubky: string,
    query: { cursor?: string; limit?: number } = {},
  ): Promise<SdkResult<LosslessJsonObject>> {
    return client.listings(pubky, query);
  }

  static async listSellerOrders(
    client: PubkyShopClient,
    pubky: string,
    query: { cursor?: string; limit?: number } = {},
  ): Promise<SdkResult<LosslessJsonObject>> {
    return client.orders(pubky, query);
  }

  static async listSessions(client: PubkyShopClient): Promise<SdkResult<LosslessJsonObject>> {
    return client.listSessions();
  }

  static async revokeSession(client: PubkyShopClient, id: string): Promise<SdkResult<null>> {
    return client.revokeSession(id);
  }

  static async addWebhook(client: PubkyShopClient, url: string): Promise<SdkResult<LosslessJsonObject>> {
    return client.addWebhook(url);
  }

  static async rotateWebhook(client: PubkyShopClient, id: string): Promise<SdkResult<LosslessJsonObject>> {
    return client.rotateWebhook(id);
  }

  static async deleteWebhook(client: PubkyShopClient, id: string): Promise<SdkResult<null>> {
    return client.deleteWebhook(id);
  }

  static async getInventoryProjection(
    client: PubkyShopClient,
    aggregateId: string,
  ): Promise<SdkResult<InventoryProjection>> {
    return client.getInventoryProjection(aggregateId);
  }

  static async adjustInventory(
    client: PubkyShopClient,
    request: InventoryAdjustRequest,
  ): Promise<SdkResult<InventoryAdjustmentEnvelope>> {
    return client.adjustInventory(request);
  }

  static async syncMany(
    client: PubkyShopClient,
    listings: readonly SyncManyListing[],
  ): Promise<SdkResult<SyncManyEnvelope>> {
    return client.syncMany(listings);
  }

  static chunkSyncMany(listings: readonly SyncManyListing[]): SyncManyListing[][] {
    return chunkSyncManyListings(listings, SYNC_MANY_LIMIT);
  }

  static classifySyncItem(item: unknown): SyncManyClassification {
    return classifySyncManyItem(item);
  }

  static dryRunCounts(manifest: ImportManifest): DryRunCounts {
    return dryRunCounts(manifest);
  }

  static resumeTasks(manifest: ImportManifest): readonly ResumeTask[] {
    return resumeTasks(manifest);
  }

  static streamResumeTasks(store: ManifestStore, manifestId: string): AsyncGenerator<ResumeTask> {
    return streamResumeTasks(store, manifestId);
  }

  static listingIdentity(row: CanonicalCsvRow): string {
    return listingIdentity(row);
  }

  static rowIdentity(row: CanonicalCsvRow): string {
    return canonicalCsvRowIdentity(row);
  }

  static rowHash(row: CanonicalCsvRow): string {
    return normalizedCsvRowHash(row);
  }

  static currentItemsFromRows(rows: readonly CanonicalCsvRow[]): Record<string, CurrentImportItem> {
    const items: Record<string, CurrentImportItem> = {};
    for (const row of rows) {
      items[canonicalCsvRowIdentity(row)] = {
        normalizedHash: normalizedCsvRowHash(row),
        recordRevision: row.recordRevision && row.recordRevision > 0 ? row.recordRevision : 1,
      };
    }
    return items;
  }

  static exportListingsCsv(rows: readonly CanonicalCsvRow[]): Uint8Array {
    return exportCanonicalCsv(rows);
  }

  static async checkpointRow(
    store: InventoryManifestStore,
    manifestId: string,
    expectedManifestVersion: number,
    rowIdentity: string,
    checkpoint: ImportCheckpoint,
    failureCode?: PlannedImportRow['failureCode'],
  ): Promise<SdkResult<CheckpointImportResult>> {
    return checkpointImportRow(
      store as unknown as ManifestStore,
      manifestId,
      expectedManifestVersion,
      rowIdentity,
      checkpoint,
      failureCode,
    );
  }

  /**
   * Browser planner. JSON is size-checked then bounded `arrayBuffer` (16 MiB).
   * A Shopify product CSV is mapped to canonical rows and planned as that JSON.
   * Other CSV streams via `browserFileSource` (64 MiB) and never calls unbounded
   * `File.arrayBuffer()`. D6.19: parse failure never reaches `store.create`.
   */
  static async planBrowserFile(
    file: ShopBrowserFile,
    store: InventoryManifestStore,
    currentItems: Readonly<Record<string, CurrentImportItem>> = {},
    shopify: ShopifyCsvImportConfig | undefined = undefined,
  ): Promise<SdkResult<PlannedBrowserFile>> {
    const manifestStore = store as unknown as ManifestStore;
    try {
      if (await peekLooksLikeJson(file)) {
        if (!Number.isSafeInteger(file.size) || file.size < 0) {
          return {
            ok: false,
            error: new PubkyShopError('invalid_configuration', { field: 'file.size' }),
          };
        }
        if (file.size > DEFAULT_JSON_LIMITS.maxBytes) {
          return {
            ok: false,
            error: new PubkyShopError('limit_exceeded', {
              field: 'json_bytes',
              limit: DEFAULT_JSON_LIMITS.maxBytes,
              observed: Math.min(file.size, DEFAULT_JSON_LIMITS.maxBytes + 1),
            }),
          };
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength > DEFAULT_JSON_LIMITS.maxBytes) {
          return {
            ok: false,
            error: new PubkyShopError('limit_exceeded', {
              field: 'json_bytes',
              limit: DEFAULT_JSON_LIMITS.maxBytes,
              observed: Math.min(bytes.byteLength, DEFAULT_JSON_LIMITS.maxBytes + 1),
            }),
          };
        }
        const planned = await planImport(bytes, {
          store: manifestStore,
          currentItems,
          limits: { maxBytes: DEFAULT_JSON_LIMITS.maxBytes },
        });
        if (!planned.ok) return planned;
        const payloads = jsonPayloads(parseBoundedJson(bytes, { maxBytes: DEFAULT_JSON_LIMITS.maxBytes }));
        await store.persistPayloads(planned.value.manifestId, payloads);
        return { ok: true, value: { manifestId: planned.value.manifestId, rowCount: planned.value.rowCount } };
      }

      const headerEnd = Number.isSafeInteger(file.size) && file.size > 0 ? Math.min(file.size, 8192) : 0;
      if (headerEnd > 0) {
        const headerBytes = new Uint8Array(await file.slice(0, headerEnd).arrayBuffer());
        const header = csvHeaderCells(headerBytes);
        if (header && isShopifyProductCsv(header)) {
          return await planShopifyProductCsv(file, manifestStore, store, currentItems, shopify);
        }
      }

      const source = browserFileSource(file, DEFAULT_CSV_LIMITS.maxBytes);
      const planned = await planImportStream(source, { store: manifestStore, currentItems });
      if (!planned.ok) return planned;
      const payloads = new Map<string, string>();
      await parseCanonicalCsvStream(browserFileSource(file, DEFAULT_CSV_LIMITS.maxBytes), (row) => {
        payloads.set(canonicalCsvRowIdentity(row), JSON.stringify(row));
      });
      await store.persistPayloads(planned.value.manifest.manifestId, payloads);
      return {
        ok: true,
        value: { manifestId: planned.value.manifest.manifestId, rowCount: planned.value.resourceUsage.rowCount },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof PubkyShopError ? error : new PubkyShopError('malformed_csv'),
      };
    }
  }
}

export { DEFAULT_CSV_LIMITS, DEFAULT_JSON_LIMITS, PubkyShopError, SYNC_MANY_LIMIT };
export type {
  CanonicalCsvRow,
  CurrentImportItem,
  DryRunCounts,
  ImportCheckpoint,
  ImportManifest,
  InventoryAdjustRequest,
  InventoryProjection,
  LosslessJsonObject,
  PlannedImportRow,
  ResumeTask,
  SdkResult,
  SyncManyClassification,
  SyncManyEnvelope,
  SyncManyListing,
};
