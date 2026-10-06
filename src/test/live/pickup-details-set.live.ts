// The client's core modules persist through Dexie; Node has no IndexedDB,
// so the shim must load before any app module.
import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * LIVE staging capture of `pickup_details.set` against
 * https://staging-api.pubky.app. Staging currently reports
 * `pickup_available: false` (sandbox payments / no sealing key), so the
 * service refuses the command with `pickup_unavailable` before it can
 * reach `pickup_not_published`. That second refusal is the production
 * Shop race (details saved before listing.sync publishes pickup) and is
 * covered by the unit tests on this branch.
 *
 * Run explicitly:
 *   MARKETPLACE_STAGING_PICKUP_IDENTITIES_FILE=... \
 *   npx vitest run --config vitest.pickup.config.ts
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'https://staging-api.pubky.app';
const NEXUS_URL = process.env.MARKETPLACE_NEXUS_URL ?? 'https://nexus.staging.pubky.app';
const IDENTITIES_FILE = process.env.MARKETPLACE_STAGING_PICKUP_IDENTITIES_FILE ?? '';

process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL = NEXUS_URL;
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

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

describe('pickup_details.set staging repro (issue 51)', () => {
  beforeAll(async () => {
    modules = {
      MarketplaceSessionService: (await import('@/services/marketplace/marketplace-session')).MarketplaceSessionService,
      MarketplaceGatewayService: (await import('@/services/marketplace/marketplace')).MarketplaceGatewayService,
      HomeserverService: (await import('@/services/homeserver/homeserver')).HomeserverService,
      sdk: await import('@synonymdev/pubky'),
    };
  });

  it('captures health pickup_available=false and the pickup_unavailable command refusal', async () => {
    expect(existsSync(IDENTITIES_FILE), 'MARKETPLACE_STAGING_PICKUP_IDENTITIES_FILE must exist').toBe(true);
    const saved = JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8')) as { secretHex?: string };
    expect(saved.secretHex, 'a saved identity secret is required').toBeTruthy();

    const { HomeserverService, MarketplaceSessionService, MarketplaceGatewayService, sdk } = modules;
    const keypair = sdk.Keypair.fromSecret(hexToBytes(saved.secretHex as string));
    const pubky = keypair.publicKey.z32();
    const signedIn = await HomeserverService.signIn({ keypair });
    expect(signedIn, 'homeserver sign-in must succeed').not.toBeNull();

    const health = await MarketplaceGatewayService.getPickupAvailability();
    expect(health).toBe(false);

    const flow = MarketplaceSessionService.beginSessionFlow();
    await new sdk.Pubky().signer(keypair).approveAuthRequest(flow.authorizationUrl);
    await flow.awaitSession();

    const listingId = 'issue51_pickup';
    const response = await MarketplaceGatewayService.execute(pubky, {
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: `listing:${pubky}_${listingId}`,
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'pickup_details.set',
      payload: {
        expectedVersion: 0,
        details: {
          kind: 'spot',
          spot: 'Central Station, north entrance',
          instructions: 'Ring the bell twice.',
          availability: { zone: 'Europe/Berlin' },
        },
      },
    });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('INVALID_STATE');
    expect(response.error.message).toBe('Pickup is unavailable on this deployment.');
    console.info(`[pickup-set] health pickup_available=${health} refusal=${response.error.message}`);
  }, 120_000);
});
