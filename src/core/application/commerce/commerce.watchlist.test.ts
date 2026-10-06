import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as commerceConfig from '@/config/commerce';
import { db } from '@/database/franky/franky';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decryptPrivRecord,
  privEntryName,
  privEntryUrl,
  type PrivKeyring,
} from '@/libs/commerce/priv-envelope';
import { HttpMethod } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import {
  CommerceFavoriteModel,
  CommerceSyncJobModel,
  CommerceWatchTombstoneModel,
} from '@/models/commerce/commerce.models';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { CommercePrivStoreService } from '@/services/homeserver/commerce/priv-store';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { capabilitiesGrantWrite } from '@/services/homeserver/homeserver.utils';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { type FakeHomeserver, installFakeHomeserver } from '@/test-utils/fake-homeserver';
import {
  establishMarketplaceSession,
  expectSafeAtEverySessionReplacement,
  releasedKeyring,
} from '@/test-utils/priv-session-replacement';
import { installRefusingWebLocks, installWebLocks, removeWebLocks } from '@/test-utils/web-locks';
import { CommerceApplication } from './commerce';
import { CommercePrivKeyringApplication } from './priv-keyring';

const OWNER = 'o'.repeat(52);
const SELLER = 's'.repeat(52);
const WATCHLIST_URL = `pubky://${OWNER}/priv/pubky.app/marketplace/v1/watchlist.json`;
const KEYRING: PrivKeyring = {
  ownerPubky: OWNER,
  currentKeyId: 'a'.repeat(32),
  keys: [{ keyId: 'a'.repeat(32), key: new Uint8Array(32).fill(3) }],
};
const V2_URL = privEntryUrl(KEYRING, 'watchlist', 'watchlist');

function v1Record(revision: number, items: [string, number][], tombstones: [string, number][] = []) {
  return {
    schemaVersion: 1,
    recordType: 'watchlist',
    ownerPubky: OWNER,
    revision,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    items: items.map(([listingId, watchedAtMs]) => ({ listingOwnerPubky: SELLER, listingId, watchedAtMs })),
    tombstones: tombstones.map(([listingId, removedAtMs]) => ({ listingOwnerPubky: SELLER, listingId, removedAtMs })),
  };
}

describe('capabilitiesGrantWrite (session-fact capability gating)', () => {
  it('grants /priv writes for the widened app grant and for root sessions', () => {
    expect(capabilitiesGrantWrite(['/pub/pubky.app/:rw', '/priv/pubky.app/:rw'], '/priv/pubky.app/')).toBe(true);
    expect(capabilitiesGrantWrite(['/:rw'], '/priv/pubky.app/')).toBe(true);
  });

  it('refuses /priv writes for the legacy public-only grant', () => {
    expect(capabilitiesGrantWrite(['/pub/pubky.app/:rw'], '/priv/pubky.app/')).toBe(false);
    expect(capabilitiesGrantWrite(['/pub/pubky.app/:rw', '/pub/paykit/:rw'], '/priv/pubky.app/')).toBe(false);
  });

  it('refuses read-only scopes and empty capability lists', () => {
    expect(capabilitiesGrantWrite(['/priv/pubky.app/:r'], '/priv/pubky.app/')).toBe(false);
    expect(capabilitiesGrantWrite([], '/priv/pubky.app/')).toBe(false);
  });

  it('does not let a sibling scope leak across directories', () => {
    expect(capabilitiesGrantWrite(['/priv/other.app/:rw'], '/priv/pubky.app/')).toBe(false);
    expect(capabilitiesGrantWrite(['/pub/pubky.app/:rw'], '/pub/pubky.application/')).toBe(false);
  });
});

describe('CommerceApplication.syncWatchlist capability gating', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips without touching the network when no session exists', async () => {
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(false);
    const fetch = vi.spyOn(CommerceHomeserverService, 'fetchJson');

    expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns needs_reauth from session facts alone (no probing) when the grant lacks /priv', async () => {
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(false);
    const fetch = vi.spyOn(CommerceHomeserverService, 'fetchJson');
    const put = vi.spyOn(CommerceHomeserverService, 'putJson');

    expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('needs_reauth');
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  describe('against the homeserver', () => {
    let homeserver: FakeHomeserver;

    beforeEach(() => {
      vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
      vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
      vi.spyOn(HomeserverService, 'isCurrentSessionGrant').mockReturnValue(false);
      vi.spyOn(CommercePrivKeyringApplication, 'get').mockResolvedValue({ kind: 'keys', keyring: KEYRING });
      vi.spyOn(LocalCommerceService, 'getFavorites').mockResolvedValue([]);
      vi.spyOn(LocalCommerceService, 'getWatchTombstones').mockResolvedValue([]);
      vi.spyOn(LocalCommerceService, 'applyWatchlistState').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'getSyncJob').mockResolvedValue({ updated_at: 7 } as never);
      vi.spyOn(LocalCommerceService, 'completeSyncJobIfUnchanged').mockResolvedValue(true);
      homeserver = installFakeHomeserver();
      installWebLocks();
    });

    afterEach(() => {
      removeWebLocks();
    });

    const stored = () =>
      decryptPrivRecord({
        keyring: KEYRING,
        family: 'watchlist',
        name: privEntryName(KEYRING, 'watchlist', 'watchlist'),
        envelope: homeserver.files.get(V2_URL),
      });
    const writes = () => homeserver.log.filter((entry) => !entry.startsWith('GET ') && !entry.startsWith('LIST '));

    it('writes nothing without a key: needs_marketplace_approval or unavailable, outbox pending', async () => {
      homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]]));
      vi.mocked(CommercePrivKeyringApplication.get).mockResolvedValueOnce({ kind: 'needs_reauth' });
      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('needs_marketplace_approval');
      vi.mocked(CommercePrivKeyringApplication.get).mockResolvedValueOnce({ kind: 'unavailable' });
      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('unavailable');
      expect(homeserver.log).toEqual([]);
      expect(homeserver.files.has(WATCHLIST_URL)).toBe(true);
      expect(LocalCommerceService.completeSyncJobIfUnchanged).not.toHaveBeenCalled();
    });

    it('moves a plaintext v1 watchlist into the encrypted entry, verifies it, then deletes v1', async () => {
      homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]], [['boots_00', 50]]));

      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('synced');

      expect(LocalCommerceService.applyWatchlistState).toHaveBeenCalledWith(
        OWNER,
        new Map([[`${SELLER}:boots_01`, 100]]),
        new Map([[`${SELLER}:boots_00`, 50]]),
      );
      expect(JSON.stringify(homeserver.files.get(V2_URL))).not.toContain('boots_0');
      expect(stored()).toMatchObject({
        recordType: 'watchlist',
        revision: 3,
        createdAt: '2025-01-01T00:00:00.000Z',
        items: [{ listingOwnerPubky: SELLER, listingId: 'boots_01', watchedAtMs: 100 }],
        tombstones: [{ listingOwnerPubky: SELLER, listingId: 'boots_00', removedAtMs: 50 }],
      });
      expect(homeserver.files.has(WATCHLIST_URL)).toBe(false);
      const put = homeserver.log.indexOf(`PUT ${V2_URL}`);
      const verify = homeserver.log.lastIndexOf(`GET ${V2_URL}`);
      const remove = homeserver.log.indexOf(`DELETE ${WATCHLIST_URL}`);
      expect(put).toBeGreaterThanOrEqual(0);
      expect(verify).toBeGreaterThan(put);
      expect(remove).toBeGreaterThan(verify);
      expect(LocalCommerceService.completeSyncJobIfUnchanged).toHaveBeenCalledWith(`watchlist|${OWNER}`, 7);
    });

    it('leaves an encrypted entry that already matches untouched', async () => {
      homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]]));
      await CommerceApplication.syncWatchlist(OWNER);
      vi.mocked(LocalCommerceService.getFavorites).mockResolvedValue([
        { id: `${OWNER}|${SELLER}:boots_01`, owner_id: OWNER, listing_id: `${SELLER}:boots_01`, created_at: 100 },
      ]);
      homeserver.log.length = 0;

      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('synced');
      expect(writes()).toEqual([]);
      expect(stored()).toMatchObject({ revision: 3 });
    });

    it('merges a plaintext file an older build wrote after the move, then deletes it again', async () => {
      homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]]));
      await CommerceApplication.syncWatchlist(OWNER);
      homeserver.files.set(WATCHLIST_URL, v1Record(3, [['boots_03', 300]]));

      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('synced');
      expect(stored()).toMatchObject({
        revision: 4,
        items: expect.arrayContaining([
          { listingOwnerPubky: SELLER, listingId: 'boots_01', watchedAtMs: 100 },
          { listingOwnerPubky: SELLER, listingId: 'boots_03', watchedAtMs: 300 },
        ]),
      });
      expect(homeserver.files.has(WATCHLIST_URL)).toBe(false);
    });

    it('seals local changes with a bumped revision and the tombstone carried', async () => {
      homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]]));
      await CommerceApplication.syncWatchlist(OWNER);
      vi.mocked(LocalCommerceService.getFavorites).mockResolvedValue([
        { id: `${OWNER}|${SELLER}:boots_02`, owner_id: OWNER, listing_id: `${SELLER}:boots_02`, created_at: 300 },
      ]);
      vi.mocked(LocalCommerceService.getWatchTombstones).mockResolvedValue([
        { id: `${OWNER}|${SELLER}:boots_01`, owner_id: OWNER, listing_id: `${SELLER}:boots_01`, removed_at: 200 },
      ]);

      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('synced');
      expect(stored()).toMatchObject({
        revision: 4,
        items: [{ listingOwnerPubky: SELLER, listingId: 'boots_02', watchedAtMs: 300 }],
        tombstones: [{ listingOwnerPubky: SELLER, listingId: 'boots_01', removedAtMs: 200 }],
      });
    });

    it('never overwrites an encrypted entry it cannot open, and keeps v1', async () => {
      homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]]));
      await CommerceApplication.syncWatchlist(OWNER);
      const envelope = homeserver.files.get(V2_URL) as { ct: string };
      const ct = base64UrlToBytes(envelope.ct);
      ct[0] ^= 1;
      const tampered = { ...envelope, ct: bytesToBase64Url(ct) };
      homeserver.files.set(V2_URL, tampered);
      homeserver.files.set(WATCHLIST_URL, v1Record(3, [['boots_03', 300]]));
      homeserver.log.length = 0;

      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('error');
      expect(writes()).toEqual([]);
      expect(homeserver.files.get(V2_URL)).toEqual(tampered);
      expect(homeserver.files.has(WATCHLIST_URL)).toBe(true);
    });

    it('keeps v1 when the encrypted write does not read back as written', async () => {
      homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]]));
      homeserver.corruptNextPut(V2_URL, () => ({ enc: 'pubky-priv-aead/v1' }));

      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('error');
      expect(homeserver.files.has(WATCHLIST_URL)).toBe(true);
      expect(LocalCommerceService.completeSyncJobIfUnchanged).not.toHaveBeenCalled();
    });

    it('flips to needs_reauth when the encrypted write is refused, and keeps v1', async () => {
      homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]]));
      homeserver.failNext(HttpMethod.PUT, V2_URL, 403);

      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('needs_reauth');
      expect(homeserver.files.has(WATCHLIST_URL)).toBe(true);
      expect(homeserver.files.has(V2_URL)).toBe(false);
    });

    it('a grant session refused with 403 fails the round instead of asking for a step-up', async () => {
      vi.mocked(HomeserverService.isCurrentSessionGrant).mockReturnValue(true);
      homeserver.failNext(HttpMethod.GET, V2_URL, 403);

      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('error');
      expect(LocalCommerceService.completeSyncJobIfUnchanged).not.toHaveBeenCalled();
    });

    it('publishes nothing when there is no document anywhere and nothing local', async () => {
      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('synced');
      expect(writes()).toEqual([]);
    });

    it('never writes the plaintext v1 path', async () => {
      vi.mocked(LocalCommerceService.getFavorites).mockResolvedValue([
        { id: `${OWNER}|${SELLER}:boots_02`, owner_id: OWNER, listing_id: `${SELLER}:boots_02`, created_at: 300 },
      ]);
      const putJson = vi.spyOn(CommerceHomeserverService, 'putJson');

      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('synced');
      expect(putJson).not.toHaveBeenCalled();
      expect(homeserver.log).not.toContain(`PUT ${WATCHLIST_URL}`);
      expect([...homeserver.files.keys()]).toEqual([V2_URL]);
    });

    it('reports error (outbox stays pending) on a non-auth failure', async () => {
      homeserver.failNext(HttpMethod.GET, WATCHLIST_URL, 500);

      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('error');
      expect(LocalCommerceService.completeSyncJobIfUnchanged).not.toHaveBeenCalled();
    });

    it('logs no private path, listing id or record content when a round fails', async () => {
      homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]]));
      const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      homeserver.failNext(HttpMethod.DELETE, WATCHLIST_URL, 500);
      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('error');
      homeserver.failNext(HttpMethod.GET, V2_URL, 500);
      expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('error');

      expect(warn).toHaveBeenCalledTimes(2);
      const logged = JSON.stringify(warn.mock.calls);
      for (const secret of [
        'watchlist.json',
        '/v1/',
        '/v2/s/',
        V2_URL.split('/').pop() as string,
        'boots_01',
        SELLER,
      ]) {
        expect(logged).not.toContain(secret);
      }
      expect(homeserver.unredacted).toEqual([]);
    });
  });
});

describe('CommerceApplication.syncWatchlist across tabs', () => {
  const JOB_ID = `watchlist|${OWNER}`;
  let homeserver: FakeHomeserver;

  const storedItems = () =>
    (
      decryptPrivRecord({
        keyring: KEYRING,
        family: 'watchlist',
        name: privEntryName(KEYRING, 'watchlist', 'watchlist'),
        envelope: homeserver.files.get(V2_URL),
      }) as { items: { listingId: string }[] }
    ).items
      .map(({ listingId }) => listingId)
      .sort();

  beforeEach(async () => {
    await db.initialize();
    await Promise.all([
      CommerceFavoriteModel.table.clear(),
      CommerceWatchTombstoneModel.table.clear(),
      CommerceSyncJobModel.table.clear(),
    ]);
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'isCurrentSessionGrant').mockReturnValue(false);
    vi.spyOn(CommercePrivKeyringApplication, 'get').mockResolvedValue({ kind: 'keys', keyring: KEYRING });
    homeserver = installFakeHomeserver();
    installWebLocks();
  });

  afterEach(() => {
    removeWebLocks();
    CommerceApplication.resetWatchlistSyncInFlight();
    vi.restoreAllMocks();
  });

  /** Tab B shares Dexie and the Web Locks with tab A, but not A's in-memory round. */
  const inTabB = async <T>(run: () => Promise<T>): Promise<T> => {
    CommerceApplication.resetWatchlistSyncInFlight();
    return await run();
  };

  it('lets a second tab neither overwrite nor be overwritten by a round already in flight', async () => {
    await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_a`);
    const put = homeserver.holdNext(HttpMethod.PUT, V2_URL);
    const tabA = CommerceApplication.syncWatchlist(OWNER);
    await put.reached;

    const tabB = inTabB(async () => {
      await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_b`);
      return await CommerceApplication.syncWatchlist(OWNER);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    put.release();

    await expect(tabA).resolves.toBe('synced');
    await expect(tabB).resolves.toBe('synced');
    expect(storedItems()).toEqual(['boots_a', 'boots_b']);
    expect(await LocalCommerceService.getSyncJob(JOB_ID)).toBeNull();
  });

  it('keeps the outbox job when a change is staged while a round is in flight', async () => {
    await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_a`);
    const put = homeserver.holdNext(HttpMethod.PUT, V2_URL);
    const round = CommerceApplication.syncWatchlist(OWNER);
    await put.reached;
    await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_b`);
    put.release();

    await expect(round).resolves.toBe('synced');
    expect(storedItems()).toEqual(['boots_a']);
    expect(await LocalCommerceService.getSyncJob(JOB_ID)).not.toBeNull();

    await expect(CommerceApplication.syncWatchlist(OWNER)).resolves.toBe('synced');
    expect(storedItems()).toEqual(['boots_a', 'boots_b']);
    expect(await LocalCommerceService.getSyncJob(JOB_ID)).toBeNull();
  });

  it('keeps the outbox job when a tab stops right after its write, so the next round carries it', async () => {
    homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_v1', 100]]));
    await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_a`);
    const put = homeserver.holdNext(HttpMethod.PUT, V2_URL);
    const tabA = CommerceApplication.syncWatchlist(OWNER);
    await put.reached;
    await inTabB(() => CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_b`));
    vi.spyOn(LocalCommerceService, 'completeSyncJobIfUnchanged').mockRejectedValueOnce(new Error('tab closed'));
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    put.release();

    await expect(tabA).resolves.toBe('error');
    expect(await LocalCommerceService.getSyncJob(JOB_ID)).not.toBeNull();
    expect(homeserver.files.has(WATCHLIST_URL)).toBe(false);

    await expect(inTabB(() => CommerceApplication.syncWatchlist(OWNER))).resolves.toBe('synced');
    expect(storedItems()).toEqual(['boots_a', 'boots_b', 'boots_v1']);
    expect(await LocalCommerceService.getSyncJob(JOB_ID)).toBeNull();
  });

  it('does no remote work without the Web Locks API, and keeps the outbox job and v1', async () => {
    removeWebLocks();
    homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_v1', 100]]));
    await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_a`);
    homeserver.log.length = 0;

    // Two tabs, the sequence that loses a change when rounds interleave.
    const tabA = CommerceApplication.syncWatchlist(OWNER);
    const tabB = inTabB(async () => {
      await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_b`);
      return await CommerceApplication.syncWatchlist(OWNER);
    });

    await expect(tabA).resolves.toBe('unsupported');
    await expect(tabB).resolves.toBe('unsupported');
    expect(homeserver.log).toEqual([]);
    expect(CommercePrivKeyringApplication.get).not.toHaveBeenCalled();
    expect(await LocalCommerceService.getSyncJob(JOB_ID)).not.toBeNull();
    expect(homeserver.files.has(WATCHLIST_URL)).toBe(true);
    expect(await LocalCommerceService.getFavorites(OWNER)).toHaveLength(2);
  });

  it('reports error, touches nothing and keeps the outbox job when the lock is refused', async () => {
    installRefusingWebLocks(new DOMException(`denied for ${OWNER}`, 'SecurityError'));
    homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_v1', 100]]));
    await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_a`);
    homeserver.log.length = 0;
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.syncWatchlist(OWNER)).resolves.toBe('error');

    expect(homeserver.log).toEqual([]);
    expect(await LocalCommerceService.getSyncJob(JOB_ID)).not.toBeNull();
    expect(homeserver.files.has(WATCHLIST_URL)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(OWNER);
  });

  it('bumps the staged generation even for two changes in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_a`);
    const first = (await LocalCommerceService.getSyncJob(JOB_ID))?.updated_at;
    await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_b`);
    const second = (await LocalCommerceService.getSyncJob(JOB_ID))?.updated_at;

    expect(first).toBe(1_000);
    expect(second).toBeGreaterThan(first as number);
  });
});

describe('CommerceApplication.syncWatchlist when the marketplace session is replaced mid-round', () => {
  let homeserver: FakeHomeserver;

  beforeEach(() => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'isCurrentSessionGrant').mockReturnValue(false);
    vi.spyOn(LocalCommerceService, 'getFavorites').mockResolvedValue([]);
    vi.spyOn(LocalCommerceService, 'getWatchTombstones').mockResolvedValue([]);
    vi.spyOn(LocalCommerceService, 'applyWatchlistState').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'getSyncJob').mockResolvedValue({ updated_at: 7 } as never);
    vi.spyOn(LocalCommerceService, 'completeSyncJobIfUnchanged').mockResolvedValue(true);
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    homeserver = installFakeHomeserver();
    installWebLocks();
  });

  afterEach(() => {
    removeWebLocks();
    CommerceApplication.resetWatchlistSyncInFlight();
    vi.restoreAllMocks();
  });

  it('never seals, places or deletes anything under revoked keys at any request boundary', async () => {
    const real = releasedKeyring(OWNER);
    const sealedUrl = privEntryUrl(real, 'watchlist', 'watchlist');
    const requests = await expectSafeAtEverySessionReplacement({
      homeserver,
      ownerPubky: OWNER,
      otherPubky: 'q'.repeat(52),
      plant: () => {
        homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]]));
      },
      flow: async () => {
        CommerceApplication.resetWatchlistSyncInFlight();
        return await CommerceApplication.syncWatchlist(OWNER);
      },
      check: () => {
        if (homeserver.files.has(WATCHLIST_URL)) return;
        const sealed = decryptPrivRecord({
          keyring: real,
          family: 'watchlist',
          name: privEntryName(real, 'watchlist', 'watchlist'),
          envelope: homeserver.files.get(sealedUrl),
        });
        expect(sealed).toMatchObject({ items: [{ listingId: 'boots_01' }] });
      },
    });
    expect(requests).toBeGreaterThanOrEqual(4);
  });

  it('keeps v1 when the session is replaced after the sealed write resolves and before v1 is deleted', async () => {
    vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockImplementation(async (owner: string) => ({
      kind: 'keys',
      keyring: releasedKeyring(owner),
    }));
    CommercePrivKeyringApplication.clear();
    establishMarketplaceSession(OWNER);
    homeserver.files.set(WATCHLIST_URL, v1Record(2, [['boots_01', 100]]));
    const write = CommercePrivStoreService.write.bind(CommercePrivStoreService);
    vi.spyOn(CommercePrivStoreService, 'write').mockImplementation(async (...args) => {
      await write(...args);
      establishMarketplaceSession(OWNER);
    });

    await expect(CommerceApplication.syncWatchlist(OWNER)).resolves.toBe('error');

    expect(homeserver.files.has(WATCHLIST_URL)).toBe(true);
    expect(homeserver.log.some((entry) => entry.startsWith('DELETE '))).toBe(false);
    MarketplaceSessionService.clearSession();
    CommercePrivKeyringApplication.clear();
  });
});
