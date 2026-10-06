import { expect, vi } from 'vitest';
import { CommercePrivKeyringApplication } from '@/application/commerce/priv-keyring';
import { decryptPrivRecord, type PrivFamily, privFamilyUrl, type PrivKeyring } from '@/libs/commerce/priv-envelope';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { MARKETPLACE_SESSION_GRANT } from '@/services/marketplace/marketplace-session-grant';
import type { FakeHomeserver } from '@/test-utils/fake-homeserver';

const FAMILIES: PrivFamily[] = [
  'watchlist',
  'order_receipt',
  'attention_seen/activity',
  'attention_seen/orders',
  'messaging_mutes',
];

/** A fresh copy of the owner's keyring: the application revokes and zeroes the copy it holds. */
export function releasedKeyring(ownerPubky: string): PrivKeyring {
  return {
    ownerPubky,
    currentKeyId: 'd'.repeat(32),
    keys: [{ keyId: 'd'.repeat(32), key: new Uint8Array(32).fill(ownerPubky.charCodeAt(0)) }],
  };
}

/** Installs a marketplace session for `pubky`, replacing any live one. */
export function establishMarketplaceSession(pubky: string): void {
  MarketplaceSessionService.establishClaimedGrantSession(
    {
      token: 'A'.repeat(43),
      pubky,
      capabilities: MARKETPLACE_SESSION_GRANT,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    pubky,
  );
}

type Point = { index: number; phase: 'before' | 'after'; replacement: 'same owner' | 'another owner' };

/**
 * Runs `flow` once cleanly to count its homeserver requests, then once per
 * request, before and after it takes effect, replacing the live marketplace
 * session there (same owner, then another owner). The real keyring holder
 * serves keys from `getPrivKeys`, so a replacement revokes the keyring the
 * flow is holding. After every run:
 *
 * - every `/v2/s/` entry opens with the owner's real key under its own name,
 *   so nothing was sealed or placed under wiped key bytes;
 * - no PUT or DELETE reached the homeserver after the replacement;
 * - `check` holds (the flow's own no-data-loss rule).
 */
export async function expectSafeAtEverySessionReplacement(input: {
  homeserver: FakeHomeserver;
  ownerPubky: string;
  otherPubky: string;
  plant: () => void | Promise<void>;
  flow: () => Promise<unknown>;
  check: (point: Point | null) => void | Promise<void>;
}): Promise<number> {
  const { homeserver, ownerPubky, otherPubky } = input;
  vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockImplementation(async (owner: string) => ({
    kind: 'keys',
    keyring: releasedKeyring(owner),
  }));

  const reset = async () => {
    homeserver.onRequest = null;
    homeserver.files.clear();
    homeserver.log.length = 0;
    MarketplaceSessionService.clearSession();
    CommercePrivKeyringApplication.clear();
    establishMarketplaceSession(ownerPubky);
    await input.plant();
  };

  const verify = async (point: Point | null, writesAfter: string[]) => {
    const real = releasedKeyring(ownerPubky);
    for (const [url, envelope] of homeserver.files) {
      if (!url.includes('/marketplace/v2/s/')) continue;
      const family = FAMILIES.find((candidate) => url.startsWith(privFamilyUrl(real, candidate)));
      expect(family, `${JSON.stringify(point)}: ${url} is not under the owner's real family paths`).toBeDefined();
      const name = url.slice(url.lastIndexOf('/') + 1);
      expect(() => decryptPrivRecord({ keyring: real, family: family!, name, envelope })).not.toThrow();
    }
    expect(writesAfter, `${JSON.stringify(point)}: writes after the replacement`).toEqual([]);
    await input.check(point);
  };

  await reset();
  await input.flow();
  const requests = homeserver.log.length;
  expect(requests).toBeGreaterThan(0);
  await verify(null, []);

  for (let index = 0; index < requests; index += 1) {
    for (const phase of ['before', 'after'] as const) {
      for (const replacement of ['same owner', 'another owner'] as const) {
        await reset();
        let seen = 0;
        let replacedAt: number | null = null;
        homeserver.onRequest = (event) => {
          if (replacedAt !== null) return;
          if (event.phase === 'before' && phase === 'before' && seen === index) {
            establishMarketplaceSession(replacement === 'same owner' ? ownerPubky : otherPubky);
            replacedAt = homeserver.log.length;
          }
          if (event.phase === 'after') {
            if (phase === 'after' && seen === index) {
              establishMarketplaceSession(replacement === 'same owner' ? ownerPubky : otherPubky);
              replacedAt = homeserver.log.length;
            }
            seen += 1;
          }
        };
        await input.flow();
        homeserver.onRequest = null;
        // A request already on the wire when the session was replaced may land.
        const after = replacedAt === null ? [] : homeserver.log.slice(replacedAt + (phase === 'before' ? 1 : 0));
        const writesAfter = after.filter((entry) => entry.startsWith('PUT ') || entry.startsWith('DELETE '));
        await verify({ index, phase, replacement }, writesAfter);
      }
    }
  }
  MarketplaceSessionService.clearSession();
  CommercePrivKeyringApplication.clear();
  return requests;
}
