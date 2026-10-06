import { db } from '@/database/franky/franky';
import {
  type CommerceImportManifestModelSchema,
  type CommerceImportRowModelSchema,
  IMPORT_MANIFEST_RETENTION_MS,
} from '@/models/commerce/commerce.schema';

/** Structural SDK `ImportAction` — this module must not import `@bitcoinerrorlog/pubky-shop`. */
export type HostImportAction = 'create' | 'update' | 'end' | 'unchanged' | 'conflict';

/** Structural SDK `ImportCheckpoint`. */
export type HostImportCheckpoint = 'planned' | 'publishing' | 'published_unsynced' | 'complete' | 'conflict' | 'failed';

/** Structural SDK `PlannedImportRow`. */
export type HostPlannedImportRow = {
  readonly sourceRow: number;
  readonly sourceIdentity: string;
  readonly rowIdentity: string;
  readonly normalizedHash: string;
  readonly listingIdentity: string;
  readonly listingId: string;
  readonly generatedListingId: string | null;
  readonly variantId: string;
  readonly sku: string;
  readonly intendedAction: HostImportAction;
  readonly idempotencyKey: string;
  readonly checkpoint: HostImportCheckpoint;
  readonly failureCode?: string;
};

/** Structural SDK `ImportManifest`. */
export type HostImportManifest = {
  readonly schemaVersion: 2;
  readonly kind: 'pubky-shop-import-manifest';
  readonly manifestId: string;
  readonly manifestVersion: number;
  readonly sourceSha256: string;
  readonly sourceByteLength: string;
  readonly rowCount: number;
  readonly parserVersion: string;
  readonly mappingVersion: string;
  readonly recordSchemaVersion: string;
  readonly createdAt: string;
  readonly rows: readonly HostPlannedImportRow[];
};

export const MANIFEST_CONFLICT = 'manifest_conflict';

export function isManifestConflict(error: unknown): boolean {
  return error instanceof Error && error.message === MANIFEST_CONFLICT;
}

function cloneManifest(manifest: HostImportManifest): HostImportManifest {
  return structuredClone(manifest);
}

function summaryOf(manifest: HostImportManifest): Omit<HostImportManifest, 'rows'> {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    manifestId: manifest.manifestId,
    manifestVersion: manifest.manifestVersion,
    sourceSha256: manifest.sourceSha256,
    sourceByteLength: manifest.sourceByteLength,
    rowCount: manifest.rowCount,
    parserVersion: manifest.parserVersion,
    mappingVersion: manifest.mappingVersion,
    recordSchemaVersion: manifest.recordSchemaVersion,
    createdAt: manifest.createdAt,
  };
}

function createdAtMs(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

type ImportDatabase = Pick<
  typeof db,
  'commerce_import_manifests' | 'commerce_import_rows' | 'commerce_import_mappings' | 'transaction'
>;

/** Host-side ManifestStore plus payload persistence. No SDK types. */
export type InventoryManifestStore = {
  create(manifest: HostImportManifest): Promise<void>;
  load(manifestId: string): Promise<HostImportManifest | null>;
  compareAndSwap(
    manifestId: string,
    expectedVersion: number,
    update: (manifest: HostImportManifest) => HostImportManifest,
  ): Promise<HostImportManifest>;
  persistPayloads(manifestId: string, payloads: ReadonlyMap<string, string>): Promise<void>;
  getPayloadJson(manifestId: string, rowIdentity: string): Promise<string | null>;
  listProgress(manifestId: string): Promise<readonly CommerceImportRowModelSchema[]>;
  pruneExpired(now?: number): Promise<void>;
  getMapping(): Promise<Record<string, string> | null>;
  putMapping(mapping: Record<string, string>): Promise<void>;
};

/**
 * Dexie host for the SDK browser planner. Structural `ManifestStore`:
 * `create` / `load` / `compareAndSwap`. Throws `Error('manifest_conflict')`,
 * never an SDK error type.
 */
export class DexieManifestStore implements InventoryManifestStore {
  constructor(
    private readonly sellerId: string,
    private readonly database: ImportDatabase = db,
  ) {}

  async create(manifest: HostImportManifest): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.commerce_import_manifests,
      this.database.commerce_import_rows,
      async () => {
        const existing = await this.database.commerce_import_manifests.get(manifest.manifestId);
        if (existing) {
          throw new Error(MANIFEST_CONFLICT);
        }
        const now = createdAtMs(manifest.createdAt);
        await this.database.commerce_import_manifests.put({
          id: manifest.manifestId,
          seller_id: this.sellerId,
          version: manifest.manifestVersion,
          created_at: now,
          summary_json: JSON.stringify(summaryOf(manifest)),
        });
        await this.database.commerce_import_rows.bulkPut(
          manifest.rows.map((row) => this.toRowRecord(manifest.manifestId, row, '', now)),
        );
      },
    );
  }

  async load(manifestId: string): Promise<HostImportManifest | null> {
    const header = await this.database.commerce_import_manifests.get(manifestId);
    if (!header || header.seller_id !== this.sellerId) {
      return null;
    }
    const storedRows = await this.database.commerce_import_rows.where('manifestId').equals(manifestId).toArray();
    storedRows.sort((left, right) => {
      const leftRow = JSON.parse(left.planned_json) as HostPlannedImportRow;
      const rightRow = JSON.parse(right.planned_json) as HostPlannedImportRow;
      return leftRow.sourceRow - rightRow.sourceRow;
    });
    const summary = JSON.parse(header.summary_json) as Omit<HostImportManifest, 'rows'>;
    return {
      ...summary,
      manifestVersion: header.version,
      rows: storedRows.map((row) => JSON.parse(row.planned_json) as HostPlannedImportRow),
    };
  }

  async compareAndSwap(
    manifestId: string,
    expectedVersion: number,
    update: (manifest: HostImportManifest) => HostImportManifest,
  ): Promise<HostImportManifest> {
    return await this.database.transaction(
      'rw',
      this.database.commerce_import_manifests,
      this.database.commerce_import_rows,
      async () => {
        const current = await this.loadInTransaction(manifestId);
        if (current === null || current.manifestVersion !== expectedVersion) {
          throw new Error(MANIFEST_CONFLICT);
        }
        const payloads = await this.payloadMap(manifestId);
        const next = update(cloneManifest(current));
        if (next.manifestId !== manifestId) {
          throw new Error('manifest_store_error');
        }
        const now = Date.now();
        await this.database.commerce_import_manifests.put({
          id: manifestId,
          seller_id: this.sellerId,
          version: next.manifestVersion,
          created_at: createdAtMs(next.createdAt),
          summary_json: JSON.stringify(summaryOf(next)),
        });
        await this.database.commerce_import_rows.where('manifestId').equals(manifestId).delete();
        await this.database.commerce_import_rows.bulkPut(
          next.rows.map((row) => this.toRowRecord(manifestId, row, payloads.get(row.rowIdentity) ?? '', now)),
        );
        return cloneManifest(next);
      },
    );
  }

  async persistPayloads(manifestId: string, payloads: ReadonlyMap<string, string>): Promise<void> {
    await this.database.transaction('rw', this.database.commerce_import_rows, async () => {
      const rows = await this.database.commerce_import_rows.where('manifestId').equals(manifestId).toArray();
      const now = Date.now();
      const next: CommerceImportRowModelSchema[] = [];
      for (const row of rows) {
        const payload = payloads.get(row.rowIdentity);
        if (payload === undefined) {
          next.push(row);
          continue;
        }
        next.push({ ...row, payload_json: payload, updated_at: now });
      }
      if (next.length > 0) {
        await this.database.commerce_import_rows.bulkPut(next);
      }
    });
  }

  async getPayloadJson(manifestId: string, rowIdentity: string): Promise<string | null> {
    const row = await this.database.commerce_import_rows.get([manifestId, rowIdentity]);
    if (!row || row.seller_id !== this.sellerId || row.payload_json.length === 0) {
      return null;
    }
    return row.payload_json;
  }

  async listProgress(manifestId: string): Promise<readonly CommerceImportRowModelSchema[]> {
    const rows = await this.database.commerce_import_rows.where('manifestId').equals(manifestId).toArray();
    return rows.filter((row) => row.seller_id === this.sellerId);
  }

  async pruneExpired(now = Date.now()): Promise<void> {
    const cutoff = now - IMPORT_MANIFEST_RETENTION_MS;
    await this.database.transaction(
      'rw',
      this.database.commerce_import_manifests,
      this.database.commerce_import_rows,
      async () => {
        const expired = await this.database.commerce_import_manifests
          .where('seller_id')
          .equals(this.sellerId)
          .filter((row) => row.created_at < cutoff)
          .toArray();
        for (const header of expired) {
          await this.database.commerce_import_rows.where('manifestId').equals(header.id).delete();
          await this.database.commerce_import_manifests.delete(header.id);
        }
      },
    );
  }

  async getMapping(): Promise<Record<string, string> | null> {
    const row = await this.database.commerce_import_mappings.get(this.sellerId);
    if (!row) return null;
    const parsed: unknown = JSON.parse(row.mapping_json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  }

  async putMapping(mapping: Record<string, string>): Promise<void> {
    await this.database.commerce_import_mappings.put({
      seller_id: this.sellerId,
      mapping_json: JSON.stringify(mapping),
      updated_at: Date.now(),
    });
  }

  private async loadInTransaction(manifestId: string): Promise<HostImportManifest | null> {
    const header = await this.database.commerce_import_manifests.get(manifestId);
    if (!header || header.seller_id !== this.sellerId) {
      return null;
    }
    const storedRows = await this.database.commerce_import_rows.where('manifestId').equals(manifestId).toArray();
    storedRows.sort((left, right) => {
      const leftRow = JSON.parse(left.planned_json) as HostPlannedImportRow;
      const rightRow = JSON.parse(right.planned_json) as HostPlannedImportRow;
      return leftRow.sourceRow - rightRow.sourceRow;
    });
    const summary = JSON.parse(header.summary_json) as Omit<HostImportManifest, 'rows'>;
    return {
      ...summary,
      manifestVersion: header.version,
      rows: storedRows.map((row) => JSON.parse(row.planned_json) as HostPlannedImportRow),
    };
  }

  private async payloadMap(manifestId: string): Promise<Map<string, string>> {
    const rows = await this.database.commerce_import_rows.where('manifestId').equals(manifestId).toArray();
    const payloads = new Map<string, string>();
    for (const row of rows) {
      if (row.payload_json.length > 0) {
        payloads.set(row.rowIdentity, row.payload_json);
      }
    }
    return payloads;
  }

  private toRowRecord(
    manifestId: string,
    row: HostPlannedImportRow,
    payloadJson: string,
    now: number,
  ): CommerceImportRowModelSchema {
    return {
      manifestId,
      rowIdentity: row.rowIdentity,
      seller_id: this.sellerId,
      listingId: row.listingId,
      planned_json: JSON.stringify(row),
      payload_json: payloadJson,
      checkpoint: row.checkpoint,
      updated_at: now,
    };
  }
}

export type { CommerceImportManifestModelSchema };
