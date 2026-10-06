import 'fake-indexeddb/auto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * LIVE STAGING PROOF for Inventory Studio W4 (does not revoke):
 * board matches GET projection, available +1 then −1 with revision bumps,
 * stale revision → 409, 3-row canonical CSV with a `result` column.
 *
 * Env must be assigned before any `@/` import — same ordering as
 * `inventory-studio.live.ts`. Runs after W1 and before W2/W3 so W3 can still
 * revoke the shared seller inventory session last.
 *
 *   MARKETPLACE_STAGING_DROP_IDENTITIES_FILE=/path/outside/the/repo.json \
 *   npm run test:marketplace:inventory
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const NEXUS_URL = process.env.MARKETPLACE_NEXUS_URL ?? 'https://nexusd-production-7108.up.railway.app';
const PROOF_DIR = process.env.INVENTORY_W4_PROOF_DIR ?? '/Volumes/t7/vibes-dev/.evidence/studio-w4/live';

process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL = NEXUS_URL;
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

const IDENTITIES_FILE = process.env.MARKETPLACE_STAGING_DROP_IDENTITIES_FILE ?? '';
const LISTING_ID = process.env.INVENTORY_LIVE_LISTING_ID ?? '';
const STAMP = `w4i_${Date.now().toString(36)}`;

type AppModules = {
  CommerceApplication: typeof import('@/application/commerce/commerce').CommerceApplication;
  CommerceInventoryApplication: typeof import('@/application/commerce/inventory').CommerceInventoryApplication;
  CommerceInventoryImportApplication: typeof import('@/application/commerce/inventory-import').CommerceInventoryImportApplication;
  listingToCanonicalRows: typeof import('@/application/commerce/inventory-listing-map').listingToCanonicalRows;
  DexieManifestStore: typeof import('@/services/marketplace/marketplace-import-store').DexieManifestStore;
  INVENTORY_GRANT: typeof import('@/services/marketplace/marketplace-inventory-grant').INVENTORY_GRANT;
  MARKETPLACE_SESSION_GRANT: typeof import('@/services/marketplace/marketplace-session-grant').MARKETPLACE_SESSION_GRANT;
  MarketplaceShopClientService: typeof import('@/services/marketplace/marketplace-shop-client').MarketplaceShopClientService;
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  MarketplaceInventorySessionService: typeof import('@/services/marketplace/marketplace-inventory-session').MarketplaceInventorySessionService;
  HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;
  CommerceHomeserverService: typeof import('@/services/homeserver/commerce/commerce').CommerceHomeserverService;
  CommerceRecordNormalizer: typeof import('@/pipes/commerce/commerce.normalizer').CommerceRecordNormalizer;
  isAppError: typeof import('@/libs/error/error.utils').isAppError;
  isNotFound: typeof import('@/libs/error/error.utils').isNotFound;
  useAuthStore: typeof import('@/stores/auth/auth.store').useAuthStore;
  createCommerceListingFixture: typeof import('@/test/fixtures/commerce/commerce').createCommerceListingFixture;
  sdk: typeof import('@synonymdev/pubky');
};

type ShopBrowserFile = {
  readonly size: number;
  readonly name?: string;
  readonly type?: string;
  stream(): ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, contentType?: string): { arrayBuffer(): Promise<ArrayBuffer> };
};

let modules: AppModules;
let sellerPubky = '';

class BytesFile implements ShopBrowserFile {
  constructor(
    private readonly bytes: Uint8Array,
    readonly name: string,
    readonly type = '',
  ) {}

  get size(): number {
    return this.bytes.byteLength;
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
    return this.bytes.slice().buffer;
  }

  slice(start = 0, end = this.bytes.byteLength): { arrayBuffer: () => Promise<ArrayBuffer> } {
    const part = this.bytes.slice(start, end);
    return {
      arrayBuffer: async () => part.slice().buffer,
    };
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length / 2; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function liveListing(listingId: string, ownerPubky: string) {
  const mediaId = `img_${listingId}`;
  return modules.createCommerceListingFixture({
    ownerPubky,
    listingId,
    title: `W4 import ${listingId}`,
    media: [
      {
        id: mediaId,
        type: 'image',
        url: `pubky://${ownerPubky}/pub/pubky.app/marketplace/v1/media/${mediaId}`,
        contentHash: 'a'.repeat(64),
        mimeType: 'image/jpeg',
        byteSize: 10_000,
        width: 1_200,
        height: 1_600,
        altText: listingId,
      },
    ],
    variants: [
      {
        id: `var_${listingId}`,
        options: { option: 'default' },
        quantity: 1,
        mediaIds: [mediaId],
        enabled: true,
      },
    ],
  });
}

function csvFile(records: Array<ReturnType<typeof liveListing>>, name: string): BytesFile {
  const rows = records.flatMap((record) => modules.listingToCanonicalRows(record));
  return new BytesFile(modules.MarketplaceShopClientService.exportListingsCsv(rows), name, 'text/csv');
}

async function deleteImportedListings(listingIds: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const listingId of listingIds) {
    const url = modules.CommerceRecordNormalizer.listingUri(sellerPubky, listingId);
    const existed = await modules.CommerceHomeserverService.exists(url);
    try {
      await modules.CommerceApplication.commitDeleteListing(sellerPubky, listingId);
      const after = await modules.CommerceHomeserverService.exists(url);
      const result = !existed ? 'already_absent' : after ? 'delete_left_residue' : 'deleted';
      lines.push(`${listingId}\texisted=${String(existed)}\tresult=${result}\tafter=${String(after)}`);
    } catch (error) {
      const notFound = modules.isAppError(error) && modules.isNotFound(error);
      const code = modules.isAppError(error) ? error.code : error instanceof Error ? error.name : 'unknown';
      lines.push(
        `${listingId}\texisted=${String(existed)}\tresult=${notFound ? 'not_found' : `error:${code}`}\tafter=unknown`,
      );
    }
  }
  return lines;
}

describe('inventory studio W4 staging proof', () => {
  beforeAll(async () => {
    modules = {
      CommerceApplication: (await import('@/application/commerce/commerce')).CommerceApplication,
      CommerceInventoryApplication: (await import('@/application/commerce/inventory')).CommerceInventoryApplication,
      CommerceInventoryImportApplication: (await import('@/application/commerce/inventory-import'))
        .CommerceInventoryImportApplication,
      listingToCanonicalRows: (await import('@/application/commerce/inventory-listing-map')).listingToCanonicalRows,
      DexieManifestStore: (await import('@/services/marketplace/marketplace-import-store')).DexieManifestStore,
      INVENTORY_GRANT: (await import('@/services/marketplace/marketplace-inventory-grant')).INVENTORY_GRANT,
      MARKETPLACE_SESSION_GRANT: (await import('@/services/marketplace/marketplace-session-grant'))
        .MARKETPLACE_SESSION_GRANT,
      MarketplaceShopClientService: (await import('@/services/marketplace/marketplace-shop-client'))
        .MarketplaceShopClientService,
      MarketplaceSessionService: (await import('@/services/marketplace/marketplace-session')).MarketplaceSessionService,
      MarketplaceInventorySessionService: (await import('@/services/marketplace/marketplace-inventory-session'))
        .MarketplaceInventorySessionService,
      HomeserverService: (await import('@/services/homeserver/homeserver')).HomeserverService,
      CommerceHomeserverService: (await import('@/services/homeserver/commerce/commerce')).CommerceHomeserverService,
      CommerceRecordNormalizer: (await import('@/pipes/commerce/commerce.normalizer')).CommerceRecordNormalizer,
      isAppError: (await import('@/libs/error/error.utils')).isAppError,
      isNotFound: (await import('@/libs/error/error.utils')).isNotFound,
      useAuthStore: (await import('@/stores/auth/auth.store')).useAuthStore,
      createCommerceListingFixture: (await import('@/test/fixtures/commerce/commerce')).createCommerceListingFixture,
      sdk: await import('@synonymdev/pubky'),
    };

    expect(existsSync(IDENTITIES_FILE), 'MARKETPLACE_STAGING_DROP_IDENTITIES_FILE must exist').toBe(true);
    const saved = JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8')) as Record<string, string>;
    const secretHex = saved.seller ?? saved.buyerA ?? Object.values(saved)[0];
    expect(secretHex, 'a saved identity secret is required').toBeTruthy();

    const {
      HomeserverService,
      MarketplaceSessionService,
      MarketplaceInventorySessionService,
      INVENTORY_GRANT,
      MARKETPLACE_SESSION_GRANT,
      useAuthStore,
      sdk,
    } = modules;
    const keypair = sdk.Keypair.fromSecret(hexToBytes(secretHex));
    sellerPubky = keypair.publicKey.z32();
    const signedIn = await HomeserverService.signIn({ keypair });
    expect(signedIn?.session, 'homeserver sign-in must return a session').toBeTruthy();
    if (!signedIn?.session) return;
    useAuthStore.setState({ session: signedIn.session, currentUserPubky: sellerPubky });
    expect(useAuthStore.getState().selectSession()?.info?.publicKey?.z32()).toBe(sellerPubky);

    const identityFlow = MarketplaceSessionService.beginSessionFlow();
    expect(new URL(identityFlow.authorizationUrl).searchParams.get('caps')).toBe(MARKETPLACE_SESSION_GRANT);
    await new sdk.Pubky().signer(keypair).approveAuthRequest(identityFlow.authorizationUrl);
    await identityFlow.awaitSession();
    expect(MarketplaceSessionService.getActiveSession()?.pubky).toBe(sellerPubky);

    const inventoryFlow = MarketplaceInventorySessionService.beginInventorySessionFlow(sellerPubky);
    expect(new URL(inventoryFlow.authorizationUrl).searchParams.get('caps')).toBe(INVENTORY_GRANT);
    await new sdk.Pubky().signer(keypair).approveAuthRequest(inventoryFlow.authorizationUrl);
    const inventoryInfo = await inventoryFlow.awaitSession();
    expect(inventoryInfo.capabilities).toBe(INVENTORY_GRANT);
    expect(inventoryInfo.capabilities).not.toBe('/:rw');

    mkdirSync(PROOF_DIR, { recursive: true });
  }, 180_000);

  it('matches GET projection, bumps +1 then −1, and refuses a stale revision', async () => {
    const {
      CommerceInventoryApplication,
      MarketplaceInventorySessionService,
      MarketplaceShopClientService,
      INVENTORY_GRANT,
    } = modules;

    const board = await CommerceInventoryApplication.loadBoard(sellerPubky);
    expect(board.status === 'ready' || board.status === 'empty', `board status ${board.status}`).toBe(true);
    if (board.status === 'empty') {
      writeFileSync(
        `${PROOF_DIR}/board.txt`,
        [`service=${SERVICE_URL}`, `pubky=${sellerPubky}`, `grant=${INVENTORY_GRANT}`, 'board=empty'].join('\n'),
      );
      expect(board.status).toBe('empty');
      return;
    }

    const rows = board.status === 'ready' ? board.rows : [];
    const target = LISTING_ID ? rows.find((entry) => entry.listingId === LISTING_ID) : rows[0];
    expect(target, 'a seller listing is required for the stock edit').toBeTruthy();
    if (!target) return;

    const inventory = MarketplaceInventorySessionService.getActiveSession();
    expect(inventory, 'inventory session is required for GET projection').toBeTruthy();
    if (!inventory) return;
    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    const projection = await MarketplaceShopClientService.getInventoryProjection(client, target.aggregateId);
    expect(projection.ok, 'GET inventory projection must succeed').toBe(true);
    if (!projection.ok) return;
    expect(Number(projection.value.stock.available)).toBe(target.available);
    expect(Number(projection.value.stock.reserved)).toBe(target.reserved);
    expect(Number(projection.value.stock.sold)).toBe(target.sold);
    expect(Number(projection.value.stock.total)).toBe(target.total);
    expect(Number(projection.value.server_revision)).toBe(target.serverRevision);

    const plus = await CommerceInventoryApplication.setAvailable({
      sellerPubky,
      row: target,
      targetAvailable: target.available + 1,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(plus.status).toBe('updated');
    if (plus.status !== 'updated') return;
    expect(plus.row.available).toBe(target.available + 1);
    expect(plus.row.serverRevision).toBeGreaterThan(target.serverRevision);

    const conflict = await CommerceInventoryApplication.setAvailable({
      sellerPubky,
      row: target,
      targetAvailable: target.available + 2,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(conflict.status).toBe('revision_conflict');

    const minus = await CommerceInventoryApplication.setAvailable({
      sellerPubky,
      row: plus.row,
      targetAvailable: target.available,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(minus.status).toBe('updated');
    if (minus.status !== 'updated') return;
    expect(minus.row.available).toBe(target.available);
    expect(minus.row.serverRevision).toBeGreaterThan(plus.row.serverRevision);

    writeFileSync(
      `${PROOF_DIR}/board.txt`,
      [
        `service=${SERVICE_URL}`,
        `pubky=${sellerPubky}`,
        `grant=${INVENTORY_GRANT}`,
        `listing_id=${target.listingId}`,
        `available_start=${target.available}`,
        `revision_start=${target.serverRevision}`,
        `available_plus=${plus.row.available}`,
        `revision_plus=${plus.row.serverRevision}`,
        `conflict=${conflict.status}`,
        `available_minus=${minus.row.available}`,
        `revision_minus=${minus.row.serverRevision}`,
        `projection_available=${Number(projection.value.stock.available)}`,
        `projection_reserved=${Number(projection.value.stock.reserved)}`,
        `projection_sold=${Number(projection.value.stock.sold)}`,
        `projection_total=${Number(projection.value.stock.total)}`,
        `projection_revision=${Number(projection.value.server_revision)}`,
      ].join('\n'),
    );
  }, 180_000);

  it('imports a 3-row canonical CSV and writes a result column', async () => {
    const ids = [`${STAMP}_a`, `${STAMP}_b`, `${STAMP}_c`];
    try {
      const store = new modules.DexieManifestStore(sellerPubky);
      const importer = modules.CommerceInventoryImportApplication.forSeller(sellerPubky, { store });
      const planned = await importer.planFile(
        csvFile(
          ids.map((listingId) => liveListing(listingId, sellerPubky)),
          'w4-3.csv',
        ),
      );
      expect(planned.status, planned.status === 'parse-failed' ? planned.message : planned.status).toBe('planned');
      if (planned.status !== 'planned') return;
      expect(planned.rowCount).toBe(3);

      const published = await importer.publish(planned.manifestId);
      expect(published.status, 'message' in published ? published.message : published.status).toBe('complete');
      if (published.status !== 'complete') return;

      const csv = await importer.resultCsv(planned.manifestId);
      const lines = csv.trim().split('\n');
      expect(lines[0]).toBe('listing_id,row_identity,checkpoint,result');
      expect(lines).toHaveLength(4);
      expect(lines.slice(1).every((line) => line.split(',').length >= 4)).toBe(true);
      expect(csv.split('\n')[0]?.split(',').includes('result')).toBe(true);
      for (const listingId of ids) {
        expect(csv).toContain(listingId);
      }

      writeFileSync(`${PROOF_DIR}/import-3.csv`, csv);
      writeFileSync(
        `${PROOF_DIR}/import-3.txt`,
        [
          `service=${SERVICE_URL}`,
          `pubky=${sellerPubky}`,
          `grant=${modules.INVENTORY_GRANT}`,
          `stamp=${STAMP}`,
          `manifest_id=${planned.manifestId}`,
          `row_count=${planned.rowCount}`,
          `publish_status=${published.status}`,
          `published=${published.published}`,
          `synced=${published.synced}`,
          `mixed=${String(published.mixed)}`,
          `result_header=${lines[0]}`,
          `result_rows=${lines.length - 1}`,
        ].join('\n'),
      );
    } finally {
      const cleanup = await deleteImportedListings(ids);
      writeFileSync(
        `${PROOF_DIR}/import-3-cleanup.txt`,
        [`service=${SERVICE_URL}`, `pubky=${sellerPubky}`, `stamp=${STAMP}`, ...cleanup].join('\n'),
      );
    }
  }, 180_000);
});
