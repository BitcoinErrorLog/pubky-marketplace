// The client's core modules persist through Dexie; Node has no IndexedDB,
// so the shim must load before any app module.
import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * LIVE one-off: issue a convergent `listing.sync` for a deployed listing so
 * the transaction authority re-reads the seller-signed record — used to heal
 * listings registered before the service parsed `shippingOptions` — then
 * read the listing back and print its authoritative pricing terms.
 *
 * Any authenticated actor may sync (provenance is the service's own
 * homeserver fetch), so this runs with a saved staging identity from the
 * drops proof.
 *
 * Run explicitly:
 *   MARKETPLACE_STAGING_DROP_IDENTITIES_FILE=... \
 *   SYNC_SELLER_PUBKY=... SYNC_LISTING_ID=... \
 *   npx vitest run src/test/live/listing-sync-probe.live.ts --config vitest.live.config.ts
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const NEXUS_URL = process.env.MARKETPLACE_NEXUS_URL ?? 'https://nexusd-production-7108.up.railway.app';

process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL = NEXUS_URL;
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

const SELLER_PUBKY = process.env.SYNC_SELLER_PUBKY ?? '';
const LISTING_ID = process.env.SYNC_LISTING_ID ?? '';
const IDENTITIES_FILE = process.env.MARKETPLACE_STAGING_DROP_IDENTITIES_FILE ?? '';

type AppModules = {
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  MarketplaceGatewayService: typeof import('@/services/marketplace/marketplace').MarketplaceGatewayService;
  HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;
  sdk: typeof import('@synonymdev/pubky');
};

let modules: AppModules;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

describe('listing.sync probe (deployed service)', () => {
  beforeAll(async () => {
    modules = {
      MarketplaceSessionService: (await import('@/services/marketplace/marketplace-session')).MarketplaceSessionService,
      MarketplaceGatewayService: (await import('@/services/marketplace/marketplace')).MarketplaceGatewayService,
      HomeserverService: (await import('@/services/homeserver/homeserver')).HomeserverService,
      sdk: await import('@synonymdev/pubky'),
    };
  });

  it('syncs the listing and reports its authoritative pricing terms', async () => {
    expect(SELLER_PUBKY, 'SYNC_SELLER_PUBKY is required').not.toBe('');
    expect(LISTING_ID, 'SYNC_LISTING_ID is required').not.toBe('');
    expect(existsSync(IDENTITIES_FILE), 'MARKETPLACE_STAGING_DROP_IDENTITIES_FILE must exist').toBe(true);

    const saved = JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8')) as Record<string, string>;
    const secretHex = saved.buyerA ?? Object.values(saved)[0];
    expect(secretHex, 'a saved identity secret is required').toBeTruthy();

    const { HomeserverService, MarketplaceSessionService, MarketplaceGatewayService, sdk } = modules;
    const keypair = sdk.Keypair.fromSecret(hexToBytes(secretHex));
    const pubky = keypair.publicKey.z32();
    const signedIn = await HomeserverService.signIn({ keypair });
    expect(signedIn, 'homeserver sign-in must succeed').not.toBeNull();
    console.info(`[sync-probe] signed in as ${pubky}`);

    const flow = MarketplaceSessionService.beginSessionFlow();
    await new sdk.Pubky().signer(keypair).approveAuthRequest(flow.authorizationUrl);
    await flow.awaitSession();
    console.info(`[sync-probe] service session established`);

    const aggregateId = `listing:${SELLER_PUBKY}_${LISTING_ID}`;
    const response = await MarketplaceGatewayService.execute(pubky, {
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId,
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'listing.sync',
      payload: { sellerPubky: SELLER_PUBKY, listingId: LISTING_ID },
    });
    console.info(`[sync-probe] sync response: ${JSON.stringify(response).slice(0, 400)}`);
    expect(response.ok).toBe(true);

    const listing = await MarketplaceGatewayService.getListing(pubky, aggregateId);
    expect(listing).not.toBeNull();
    console.info(
      `[sync-probe] listing terms: state=${listing?.state} unit_price=${JSON.stringify(listing?.unitPrice)} ` +
        `shipping=${JSON.stringify((listing as unknown as Record<string, unknown>)?.shipping)} ` +
        `available=${listing?.availableQuantity}`,
    );
  }, 120_000);
});
