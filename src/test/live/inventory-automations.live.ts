import 'fake-indexeddb/auto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * LIVE STAGING PROOF for Inventory Studio W3: list sessions, add/rotate/delete
 * a public HTTPS webhook, then revoke the inventory session so the next
 * inventory call is rejected while the identity checkout session remains.
 *
 * Env must be assigned before any `@/` import — same ordering as
 * `inventory-studio.live.ts`. Runs last in `vitest.inventory.config.ts`
 * because it revokes the shared seller inventory session.
 *
 *   MARKETPLACE_STAGING_DROP_IDENTITIES_FILE=/path/outside/the/repo.json \
 *   npm run test:marketplace:inventory
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const NEXUS_URL = process.env.MARKETPLACE_NEXUS_URL ?? 'https://nexusd-production-7108.up.railway.app';
const PROOF_DIR = process.env.INVENTORY_AUTOMATIONS_PROOF_DIR ?? '/Volumes/t7/vibes-dev/.evidence/studio-w3/live';
const WEBHOOK_SINK = process.env.INVENTORY_WEBHOOK_SINK_URL ?? 'https://httpbin.org/post';

process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL = NEXUS_URL;
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

const IDENTITIES_FILE = process.env.MARKETPLACE_STAGING_DROP_IDENTITIES_FILE ?? '';

type AppModules = {
  CommerceInventoryAutomationsApplication: typeof import('@/application/commerce/inventory-automations').CommerceInventoryAutomationsApplication;
  WEBHOOK_SECRET_COPY: typeof import('@/application/commerce/inventory-automations').WEBHOOK_SECRET_COPY;
  INVENTORY_GRANT: typeof import('@/services/marketplace/marketplace-inventory-grant').INVENTORY_GRANT;
  MARKETPLACE_SESSION_GRANT: typeof import('@/services/marketplace/marketplace-session-grant').MARKETPLACE_SESSION_GRANT;
  MarketplaceShopClientService: typeof import('@/services/marketplace/marketplace-shop-client').MarketplaceShopClientService;
  DexieWebhookStore: typeof import('@/services/marketplace/marketplace-webhook-store').DexieWebhookStore;
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  MarketplaceInventorySessionService: typeof import('@/services/marketplace/marketplace-inventory-session').MarketplaceInventorySessionService;
  HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;
  useAuthStore: typeof import('@/stores/auth/auth.store').useAuthStore;
  db: typeof import('@/database/franky/franky').db;
  sdk: typeof import('@synonymdev/pubky');
};

let modules: AppModules;
let sellerPubky = '';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function redactedSecret(secret: string): string {
  return `len=${secret.length}`;
}

describe('inventory automations staging proof', () => {
  beforeAll(async () => {
    modules = {
      CommerceInventoryAutomationsApplication: (await import('@/application/commerce/inventory-automations'))
        .CommerceInventoryAutomationsApplication,
      WEBHOOK_SECRET_COPY: (await import('@/application/commerce/inventory-automations')).WEBHOOK_SECRET_COPY,
      INVENTORY_GRANT: (await import('@/services/marketplace/marketplace-inventory-grant')).INVENTORY_GRANT,
      MARKETPLACE_SESSION_GRANT: (await import('@/services/marketplace/marketplace-session-grant'))
        .MARKETPLACE_SESSION_GRANT,
      MarketplaceShopClientService: (await import('@/services/marketplace/marketplace-shop-client'))
        .MarketplaceShopClientService,
      DexieWebhookStore: (await import('@/services/marketplace/marketplace-webhook-store')).DexieWebhookStore,
      MarketplaceSessionService: (await import('@/services/marketplace/marketplace-session')).MarketplaceSessionService,
      MarketplaceInventorySessionService: (await import('@/services/marketplace/marketplace-inventory-session'))
        .MarketplaceInventorySessionService,
      HomeserverService: (await import('@/services/homeserver/homeserver')).HomeserverService,
      useAuthStore: (await import('@/stores/auth/auth.store')).useAuthStore,
      db: (await import('@/database/franky/franky')).db,
      sdk: await import('@synonymdev/pubky'),
    };

    expect(existsSync(IDENTITIES_FILE), 'MARKETPLACE_STAGING_DROP_IDENTITIES_FILE must exist').toBe(true);
    const saved = JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8')) as Record<string, string>;
    const secretHex = saved.seller;
    expect(secretHex, 'identities.json must contain seller').toBeTruthy();

    const {
      HomeserverService,
      MarketplaceSessionService,
      MarketplaceInventorySessionService,
      INVENTORY_GRANT,
      MARKETPLACE_SESSION_GRANT,
      useAuthStore,
      db,
      sdk,
    } = modules;
    const keypair = sdk.Keypair.fromSecret(hexToBytes(secretHex));
    sellerPubky = keypair.publicKey.z32();
    const signedIn = await HomeserverService.signIn({ keypair });
    expect(signedIn?.session, 'homeserver sign-in must return a session').toBeTruthy();
    if (!signedIn?.session) return;
    useAuthStore.setState({ session: signedIn.session, currentUserPubky: sellerPubky });

    if (!MarketplaceSessionService.getActiveSession()) {
      const identityFlow = MarketplaceSessionService.beginSessionFlow();
      expect(new URL(identityFlow.authorizationUrl).searchParams.get('caps')).toBe(MARKETPLACE_SESSION_GRANT);
      await new sdk.Pubky().signer(keypair).approveAuthRequest(identityFlow.authorizationUrl);
      await identityFlow.awaitSession();
    }
    expect(MarketplaceSessionService.getActiveSession()?.pubky).toBe(sellerPubky);

    if (!MarketplaceInventorySessionService.getActiveSession()) {
      const inventoryFlow = MarketplaceInventorySessionService.beginInventorySessionFlow(sellerPubky);
      expect(new URL(inventoryFlow.authorizationUrl).searchParams.get('caps')).toBe(INVENTORY_GRANT);
      await new sdk.Pubky().signer(keypair).approveAuthRequest(inventoryFlow.authorizationUrl);
      const inventoryInfo = await inventoryFlow.awaitSession();
      expect(inventoryInfo.capabilities).toBe(INVENTORY_GRANT);
      expect(inventoryInfo.capabilities).not.toBe('/:rw');
    }

    await db.initialize();
    mkdirSync(PROOF_DIR, { recursive: true });
  }, 180_000);

  it('lists sessions, rotates a public webhook, then revokes inventory only', async () => {
    const {
      CommerceInventoryAutomationsApplication,
      WEBHOOK_SECRET_COPY,
      INVENTORY_GRANT,
      MARKETPLACE_SESSION_GRANT,
      MarketplaceShopClientService,
      DexieWebhookStore,
      MarketplaceSessionService,
      MarketplaceInventorySessionService,
    } = modules;

    const listed = await CommerceInventoryAutomationsApplication.load(sellerPubky);
    expect(listed.status === 'ready' || listed.status === 'empty', `list status ${listed.status}`).toBe(true);
    if (listed.status !== 'ready' && listed.status !== 'empty') return;
    expect(JSON.stringify(listed)).not.toMatch(/bearer/i);
    const kinds = listed.status === 'ready' ? listed.sessions.map((row) => row.kind) : [];
    expect(kinds).toContain('purchase');
    expect(kinds).toContain('inventory');

    const added = await CommerceInventoryAutomationsApplication.addWebhook(sellerPubky, WEBHOOK_SINK);
    expect(added.status, added.status === 'error' ? added.message : added.status).toBe('secret');
    if (added.status !== 'secret') return;
    expect(added.message).toBe(WEBHOOK_SECRET_COPY);
    expect(added.secret.length).toBeGreaterThan(0);
    expect(added.url).toBe(WEBHOOK_SINK);

    const store = new DexieWebhookStore(sellerPubky);
    const afterAdd = await store.list();
    expect(afterAdd.some((row) => row.id === added.id && row.url === added.url)).toBe(true);
    expect(JSON.stringify(afterAdd)).not.toMatch(/secret/i);
    expect(JSON.stringify(afterAdd)).not.toContain(added.secret);

    const rotated = await CommerceInventoryAutomationsApplication.rotateWebhook(sellerPubky, added.id);
    expect(rotated.status, rotated.status === 'error' ? rotated.message : rotated.status).toBe('secret');
    if (rotated.status !== 'secret') return;
    expect(rotated.secret.length).toBeGreaterThan(0);
    expect(rotated.secret).not.toBe(added.secret);
    const afterRotate = await store.list();
    expect(JSON.stringify(afterRotate)).not.toContain(rotated.secret);

    const deleted = await CommerceInventoryAutomationsApplication.deleteWebhook(sellerPubky, added.id);
    expect(deleted).toEqual({ status: 'deleted', id: added.id });
    expect((await store.list()).some((row) => row.id === added.id)).toBe(false);

    const inventory = MarketplaceInventorySessionService.getActiveSession();
    expect(inventory, 'inventory session is required for revoke').toBeTruthy();
    if (!inventory) return;
    const inventoryToken = inventory.token;
    const identityToken = MarketplaceSessionService.getActiveSession()?.token;
    expect(identityToken, 'identity session must remain for checkout').toBeTruthy();
    const inventoryRow =
      listed.status === 'ready' ? listed.sessions.find((row) => row.kind === 'inventory') : undefined;
    const revokeId = inventory.sessionId ?? inventoryRow?.id;
    expect(revokeId, 'inventory session id is required to revoke').toBeTruthy();
    if (!revokeId) return;

    const revoked = await CommerceInventoryAutomationsApplication.revoke(sellerPubky, revokeId, 'inventory');
    expect(revoked).toEqual({ status: 'revoked', id: revokeId });
    expect(MarketplaceInventorySessionService.getActiveSession()).toBeNull();
    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(identityToken);

    const deadClient = MarketplaceShopClientService.createInventoryClient(inventoryToken);
    const deadList = await MarketplaceShopClientService.listSessions(deadClient);
    expect(deadList.ok).toBe(false);
    if (!deadList.ok) {
      expect(MarketplaceShopClientService.isSessionRejected(deadList.error)).toBe(true);
    }

    let purchaseList = 'absent';
    if (identityToken) {
      const identityClient = MarketplaceShopClientService.createInventoryClient(identityToken);
      const identityList = await MarketplaceShopClientService.listSessions(identityClient);
      // The purchase session's marketplace session grant covers inventory reads.
      expect(identityList.ok).toBe(true);
      if (identityList.ok) {
        const body = identityList.value as {
          sessions?: Array<{ capabilities?: string; revoked_at?: string; revokedAt?: string }>;
        };
        const sessions = Array.isArray(body.sessions) ? body.sessions : [];
        const active = sessions.filter((row) => !row.revoked_at && !row.revokedAt);
        expect(active.some((row) => row.capabilities === MARKETPLACE_SESSION_GRANT)).toBe(true);
        purchaseList = 'covers-inventory';
      }
    }

    writeFileSync(
      `${PROOF_DIR}/automations.txt`,
      [
        `service=${SERVICE_URL}`,
        `pubky=${sellerPubky}`,
        `grant=${INVENTORY_GRANT}`,
        `list_status=${listed.status}`,
        `session_kinds=${kinds.join(',')}`,
        `webhook_url=${WEBHOOK_SINK}`,
        `webhook_id=${added.id}`,
        `add_secret=${redactedSecret(added.secret)}`,
        `rotate_secret=${redactedSecret(rotated.secret)}`,
        `deleted=${deleted.status}`,
        `revoke_id=${revokeId}`,
        `inventory_cleared=${MarketplaceInventorySessionService.getActiveSession() === null}`,
        `identity_present=${Boolean(MarketplaceSessionService.getActiveSession())}`,
        `dead_inventory=${deadList.ok ? 'ok' : deadList.error.code}`,
        `purchase_list=${purchaseList}`,
      ].join('\n'),
    );
  }, 180_000);
});
