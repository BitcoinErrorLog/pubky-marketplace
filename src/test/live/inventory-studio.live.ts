import 'fake-indexeddb/auto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * LIVE STAGING PROOF for Inventory Studio W1: identity session on the
 * marketplace session grant, then the seller step-up whose `caps` query
 * parameter is the inventory grant (percent-encoded in the URL string,
 * never `/:rw`), then one `inventory.adjust` through the Wave 3a client.
 *
 * Env is assigned before any `@/` import so validation sees these defaults.
 *
 *   MARKETPLACE_STAGING_DROP_IDENTITIES_FILE=/path/outside/the/repo.json \
 *   npm run test:marketplace:inventory
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const NEXUS_URL = process.env.MARKETPLACE_NEXUS_URL ?? 'https://nexusd-production-7108.up.railway.app';
const PROOF_PATH =
  process.env.INVENTORY_STUDIO_PROOF_PATH ??
  '/Volumes/t7/vibes-dev/.evidence/phase6/wave4/impl/staging-inventory-studio.txt';

process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL = NEXUS_URL;
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

const IDENTITIES_FILE = process.env.MARKETPLACE_STAGING_DROP_IDENTITIES_FILE ?? '';
const LISTING_ID = process.env.INVENTORY_LIVE_LISTING_ID ?? '';

type AppModules = {
  INVENTORY_GRANT: typeof import('@/services/marketplace/marketplace-inventory-grant').INVENTORY_GRANT;
  MARKETPLACE_SESSION_GRANT: typeof import('@/services/marketplace/marketplace-session-grant').MARKETPLACE_SESSION_GRANT;
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  MarketplaceInventorySessionService: typeof import('@/services/marketplace/marketplace-inventory-session').MarketplaceInventorySessionService;
  CommerceInventoryApplication: typeof import('@/application/commerce/inventory').CommerceInventoryApplication;
  HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;
  sdk: typeof import('@synonymdev/pubky');
};

let modules: AppModules;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

describe('inventory studio staging proof', () => {
  beforeAll(async () => {
    modules = {
      INVENTORY_GRANT: (await import('@/services/marketplace/marketplace-inventory-grant')).INVENTORY_GRANT,
      MARKETPLACE_SESSION_GRANT: (await import('@/services/marketplace/marketplace-session-grant'))
        .MARKETPLACE_SESSION_GRANT,
      MarketplaceSessionService: (await import('@/services/marketplace/marketplace-session')).MarketplaceSessionService,
      MarketplaceInventorySessionService: (await import('@/services/marketplace/marketplace-inventory-session'))
        .MarketplaceInventorySessionService,
      CommerceInventoryApplication: (await import('@/application/commerce/inventory')).CommerceInventoryApplication,
      HomeserverService: (await import('@/services/homeserver/homeserver')).HomeserverService,
      sdk: await import('@synonymdev/pubky'),
    };
  });

  it('steps up the inventory grant and edits one listing', async () => {
    expect(existsSync(IDENTITIES_FILE), 'MARKETPLACE_STAGING_DROP_IDENTITIES_FILE must exist').toBe(true);

    const saved = JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8')) as Record<string, string>;
    const secretHex = saved.seller ?? saved.buyerA ?? Object.values(saved)[0];
    expect(secretHex, 'a saved identity secret is required').toBeTruthy();

    const {
      HomeserverService,
      MarketplaceSessionService,
      MarketplaceInventorySessionService,
      CommerceInventoryApplication,
      INVENTORY_GRANT,
      MARKETPLACE_SESSION_GRANT,
      sdk,
    } = modules;
    const keypair = sdk.Keypair.fromSecret(hexToBytes(secretHex));
    const pubky = keypair.publicKey.z32();
    const signedIn = await HomeserverService.signIn({ keypair });
    expect(signedIn, 'homeserver sign-in must succeed').not.toBeNull();

    const identityFlow = MarketplaceSessionService.beginSessionFlow();
    expect(new URL(identityFlow.authorizationUrl).searchParams.get('caps')).toBe(MARKETPLACE_SESSION_GRANT);
    await new sdk.Pubky().signer(keypair).approveAuthRequest(identityFlow.authorizationUrl);
    await identityFlow.awaitSession();
    expect(MarketplaceSessionService.getActiveSession()?.pubky).toBe(pubky);

    const inventoryFlow = MarketplaceInventorySessionService.beginInventorySessionFlow(pubky);
    expect(new URL(inventoryFlow.authorizationUrl).searchParams.get('caps')).toBe(INVENTORY_GRANT);
    await new sdk.Pubky().signer(keypair).approveAuthRequest(inventoryFlow.authorizationUrl);
    const inventoryInfo = await inventoryFlow.awaitSession();
    expect(inventoryInfo.capabilities).toBe(INVENTORY_GRANT);
    expect(inventoryInfo.capabilities).not.toBe('/:rw');

    const board = await CommerceInventoryApplication.loadBoard(pubky);
    expect(board.status === 'ready' || board.status === 'empty', `board status ${board.status}`).toBe(true);
    if (board.status === 'empty') {
      mkdirSync(dirname(PROOF_PATH), { recursive: true });
      writeFileSync(
        PROOF_PATH,
        [`pubky=${pubky}`, `grant=${INVENTORY_GRANT}`, 'board=empty', 'stock_edit=skipped_no_listings'].join('\n'),
      );
      expect(board.status).toBe('empty');
      return;
    }

    const rows = board.status === 'ready' ? board.rows : [];
    const target = LISTING_ID ? rows.find((entry) => entry.listingId === LISTING_ID) : rows[0];
    expect(target, 'a seller listing is required for the stock edit').toBeTruthy();
    if (!target) return;

    const nextAvailable = target.available + 1;
    const result = await CommerceInventoryApplication.setAvailable({
      sellerPubky: pubky,
      row: target,
      targetAvailable: nextAvailable,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.status).toBe('updated');
    if (result.status !== 'updated') return;
    expect(result.row.available).toBe(nextAvailable);

    mkdirSync('/Volumes/t7/vibes-dev/.evidence/phase6/wave4/impl', { recursive: true });
    writeFileSync(
      PROOF_PATH,
      [
        `pubky=${pubky}`,
        `grant=${INVENTORY_GRANT}`,
        `listing_id=${target.listingId}`,
        `revision_before=${target.serverRevision}`,
        `available_before=${target.available}`,
        `available_after=${result.row.available}`,
        `revision_after=${result.row.serverRevision}`,
        `status=${result.status}`,
      ].join('\n'),
    );
  }, 180_000);
});
