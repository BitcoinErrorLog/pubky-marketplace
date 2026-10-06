import 'fake-indexeddb/auto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * LIVE STAGING PROOF for Inventory Studio W2: 250-row CSV plan, then a mixed
 * per-id 207 `sync_many` followed by resume (no second PUT).
 *
 * Env must be assigned before any `@/` import — same ordering as
 * `inventory-studio.live.ts`.
 *
 *   MARKETPLACE_STAGING_DROP_IDENTITIES_FILE=/path/outside/the/repo.json \
 *   npm run test:marketplace:inventory
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const NEXUS_URL = process.env.MARKETPLACE_NEXUS_URL ?? 'https://nexusd-production-7108.up.railway.app';
const PROOF_DIR = process.env.INVENTORY_IMPORT_PROOF_DIR ?? '/Volumes/t7/vibes-dev/.evidence/studio-w2/live';

process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL = NEXUS_URL;
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

const IDENTITIES_FILE = process.env.MARKETPLACE_STAGING_DROP_IDENTITIES_FILE ?? '';
const STAMP = `w2i_${Date.now().toString(36)}`;

type AppModules = {
  CommerceInventoryImportApplication: typeof import('@/application/commerce/inventory-import').CommerceInventoryImportApplication;
  listingToCanonicalRows: typeof import('@/application/commerce/inventory-listing-map').listingToCanonicalRows;
  DexieManifestStore: typeof import('@/services/marketplace/marketplace-import-store').DexieManifestStore;
  INVENTORY_GRANT: typeof import('@/services/marketplace/marketplace-inventory-grant').INVENTORY_GRANT;
  MARKETPLACE_SESSION_GRANT: typeof import('@/services/marketplace/marketplace-session-grant').MARKETPLACE_SESSION_GRANT;
  MarketplaceShopClientService: typeof import('@/services/marketplace/marketplace-shop-client').MarketplaceShopClientService;
  PubkyShopError: typeof import('@/services/marketplace/marketplace-shop-client').PubkyShopError;
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  MarketplaceInventorySessionService: typeof import('@/services/marketplace/marketplace-inventory-session').MarketplaceInventorySessionService;
  HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;
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

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function liveListing(listingId: string, ownerPubky: string) {
  const mediaId = `img_${listingId}`;
  return modules.createCommerceListingFixture({
    ownerPubky,
    listingId,
    title: `W2 import ${listingId}`,
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

describe('inventory import staging proof', () => {
  beforeAll(async () => {
    const shopClient = await import('@/services/marketplace/marketplace-shop-client');
    const grant = await import('@/services/marketplace/marketplace-inventory-grant');
    const sessionGrant = await import('@/services/marketplace/marketplace-session-grant');
    const importApp = await import('@/application/commerce/inventory-import');
    const listingMap = await import('@/application/commerce/inventory-listing-map');
    const importStore = await import('@/services/marketplace/marketplace-import-store');
    const session = await import('@/services/marketplace/marketplace-session');
    const inventorySession = await import('@/services/marketplace/marketplace-inventory-session');
    const homeserver = await import('@/services/homeserver/homeserver');
    const authStore = await import('@/stores/auth/auth.store');
    const fixtures = await import('@/test/fixtures/commerce/commerce');
    modules = {
      CommerceInventoryImportApplication: importApp.CommerceInventoryImportApplication,
      listingToCanonicalRows: listingMap.listingToCanonicalRows,
      DexieManifestStore: importStore.DexieManifestStore,
      INVENTORY_GRANT: grant.INVENTORY_GRANT,
      MARKETPLACE_SESSION_GRANT: sessionGrant.MARKETPLACE_SESSION_GRANT,
      MarketplaceShopClientService: shopClient.MarketplaceShopClientService,
      PubkyShopError: shopClient.PubkyShopError,
      MarketplaceSessionService: session.MarketplaceSessionService,
      MarketplaceInventorySessionService: inventorySession.MarketplaceInventorySessionService,
      HomeserverService: homeserver.HomeserverService,
      useAuthStore: authStore.useAuthStore,
      createCommerceListingFixture: fixtures.createCommerceListingFixture,
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
    // Product PUT/GET resolve the owned path from the app auth store, not from
    // HomeserverService.signIn's return value. Same wiring as reviews-index.live.ts.
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

  it('plans a 250-row canonical CSV without publishing', async () => {
    const records = Array.from({ length: 250 }, (_, index) =>
      liveListing(`${STAMP}_p${String(index).padStart(3, '0')}`, sellerPubky),
    );
    const store = new modules.DexieManifestStore(sellerPubky);
    const importer = modules.CommerceInventoryImportApplication.forSeller(sellerPubky, {
      store,
      currentItems: async () => ({}),
      putListing: async () => {
        throw new Error('250-row plan must not PUT');
      },
      syncMany: async () => {
        throw new Error('250-row plan must not sync');
      },
    });

    const planned = await importer.planFile(csvFile(records, 'w2-250.csv'));
    expect(planned.status, planned.status === 'parse-failed' ? planned.message : planned.status).toBe('planned');
    if (planned.status !== 'planned') return;
    expect(planned.rowCount).toBe(250);
    const manifest = await store.load(planned.manifestId);
    expect(manifest?.rows).toHaveLength(250);

    writeFileSync(
      `${PROOF_DIR}/plan-250.txt`,
      [
        `service=${SERVICE_URL}`,
        `pubky=${sellerPubky}`,
        `grant=${modules.INVENTORY_GRANT}`,
        `stamp=${STAMP}`,
        `manifest_id=${planned.manifestId}`,
        `row_count=${planned.rowCount}`,
        `counts=${JSON.stringify(planned.counts)}`,
        `status=${planned.status}`,
      ].join('\n'),
    );
  }, 180_000);

  it('classifies a live mixed 207 then resumes without a second PUT', async () => {
    const okId = `${STAMP}_ok`;
    const retryId = `${STAMP}_rs`;
    const missingId = `${STAMP}_missing`;
    const puts: string[] = [];
    const syncCalls: Array<Array<{ seller_pubky: string; listing_id: string }>> = [];
    let syncRound = 0;
    let mixedEnvelope: unknown = null;

    const store = new modules.DexieManifestStore(sellerPubky);
    const realPut = modules.CommerceInventoryImportApplication.createHost(sellerPubky).putListing;
    const importer = modules.CommerceInventoryImportApplication.forSeller(sellerPubky, {
      store,
      currentItems: async () => ({}),
      putListing: async (record) => {
        puts.push(record.listingId);
        await realPut(record);
      },
      syncMany: async (listings) => {
        syncRound += 1;
        syncCalls.push([...listings]);
        const inventory = modules.MarketplaceInventorySessionService.getActiveSession();
        expect(inventory, 'inventory session is required for sync_many').toBeTruthy();
        if (!inventory) {
          return { ok: false, error: new modules.PubkyShopError('session_rejected') };
        }
        const firstListing = listings[0];
        expect(firstListing, 'publish always syncs at least one listing').toBeTruthy();
        if (!firstListing) {
          return {
            ok: false,
            error: new modules.PubkyShopError('invalid_configuration', { field: 'listings' }),
          };
        }
        const client = modules.MarketplaceShopClientService.createInventoryClient(inventory.token);
        if (syncRound === 1) {
          const mixedListings = [firstListing, { seller_pubky: sellerPubky, listing_id: missingId }];
          const result = await modules.MarketplaceShopClientService.syncMany(client, mixedListings);
          mixedEnvelope = result;
          expect(result.ok, 'staging sync_many must return an envelope').toBe(true);
          if (!result.ok) return result;
          const items = Array.isArray(result.value.results) ? result.value.results : [];
          const classified = items.map((item) => modules.MarketplaceShopClientService.classifySyncItem(item));
          expect(classified.some((item) => item.ok)).toBe(true);
          expect(classified.some((item) => !item.ok)).toBe(true);
          const remapped = listings.map((listing, index) => {
            const source = items[index];
            if (source && typeof source === 'object' && !Array.isArray(source)) {
              return { ...(source as Record<string, unknown>), listing_id: listing.listing_id };
            }
            return { listing_id: listing.listing_id, status: index === 0 ? 200 : 404 };
          });
          return {
            ok: true as const,
            value: { ...result.value, results: remapped as typeof result.value.results },
          };
        }
        return modules.MarketplaceShopClientService.syncMany(client, listings);
      },
    });

    const planned = await importer.planFile(
      csvFile([liveListing(okId, sellerPubky), liveListing(retryId, sellerPubky)], 'w2-mixed.csv'),
    );
    expect(planned.status, planned.status === 'parse-failed' ? planned.message : planned.status).toBe('planned');
    if (planned.status !== 'planned') return;
    expect(planned.rowCount).toBe(2);

    const first = await importer.publish(planned.manifestId);
    expect(puts).toEqual([okId, retryId]);
    expect(first.status, 'message' in first ? first.message : first.status).toBe('complete');
    if (first.status === 'complete') expect(first.mixed).toBe(true);

    const afterMixed = await store.load(planned.manifestId);
    const mixedCheckpoints = Object.fromEntries((afterMixed?.rows ?? []).map((row) => [row.listingId, row.checkpoint]));
    expect(mixedCheckpoints[okId]).toBe('complete');
    expect(mixedCheckpoints[retryId]).toBe('published_unsynced');

    const resumed = await importer.resume(planned.manifestId);
    expect(puts).toEqual([okId, retryId]);
    expect(syncCalls).toHaveLength(2);
    expect(syncCalls[1]).toEqual([{ seller_pubky: sellerPubky, listing_id: retryId }]);
    expect(resumed.status).toBe('complete');
    if (resumed.status === 'complete') {
      expect(resumed.mixed).toBe(false);
      expect(resumed.synced).toBeGreaterThanOrEqual(1);
    }

    const afterResume = await store.load(planned.manifestId);
    const resumeCheckpoints = Object.fromEntries(
      (afterResume?.rows ?? []).map((row) => [row.listingId, row.checkpoint]),
    );
    expect(resumeCheckpoints[okId]).toBe('complete');
    expect(resumeCheckpoints[retryId]).toBe('complete');

    writeFileSync(`${PROOF_DIR}/mixed-207.json`, `${JSON.stringify(mixedEnvelope, jsonReplacer, 2)}\n`);
    writeFileSync(
      `${PROOF_DIR}/resume.txt`,
      [
        `service=${SERVICE_URL}`,
        `pubky=${sellerPubky}`,
        `grant=${modules.INVENTORY_GRANT}`,
        `stamp=${STAMP}`,
        `manifest_id=${planned.manifestId}`,
        `ok_id=${okId}`,
        `retry_id=${retryId}`,
        `missing_id=${missingId}`,
        `puts=${puts.join(',')}`,
        `first_status=${first.status}`,
        `first_mixed=${first.status === 'complete' ? String(first.mixed) : ''}`,
        `resume_status=${resumed.status}`,
        `resume_mixed=${resumed.status === 'complete' ? String(resumed.mixed) : ''}`,
        `checkpoints_mixed=${JSON.stringify(mixedCheckpoints)}`,
        `checkpoints_resume=${JSON.stringify(resumeCheckpoints)}`,
        `sync_calls=${JSON.stringify(syncCalls)}`,
      ].join('\n'),
    );
  }, 180_000);
});
