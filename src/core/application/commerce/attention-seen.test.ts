import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readOrdersSeenAt } from '@/libs/commerce/marketplace-attention';
import {
  decryptPrivRecord,
  encryptPrivRecord,
  newPrivEntryName,
  type PrivFamily,
  privFamilyUrl,
  type PrivKeyring,
  privListedEntryUrl,
} from '@/libs/commerce/priv-envelope';
import { HttpMethod } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import { CommerceActivityCheckpointModel } from '@/models/commerce/commerce.models';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';
import { type FakeHomeserver, installFakeHomeserver } from '@/test-utils/fake-homeserver';
import { expectSafeAtEverySessionReplacement, releasedKeyring } from '@/test-utils/priv-session-replacement';
import { ATTENTION_SEEN_WRITE_DEBOUNCE_MS, CommerceAttentionSeenApplication } from './attention-seen';
import { CommercePrivKeyringApplication } from './priv-keyring';

const state = vi.hoisted(() => ({ mode: 'transaction-service' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => state.mode };
});

const OWNER = 'o'.repeat(52);
const OTHER = 'p'.repeat(52);
const LEGACY_BASE = `pubky://${OWNER}/priv/pubky.app/marketplace/v1/attention_seen`;
const LEGACY_DIR = { activity: `${LEGACY_BASE}/activity/`, orders: `${LEGACY_BASE}/orders/` } as const;
const T0 = Date.parse('2026-09-24T14:00:00.000Z');
const NOW = Date.parse('2026-09-24T16:00:00.000Z');
const KEYRING: PrivKeyring = {
  ownerPubky: OWNER,
  currentKeyId: 'e'.repeat(32),
  keys: [{ keyId: 'e'.repeat(32), key: new Uint8Array(32).fill(4) }],
};
type Side = keyof typeof LEGACY_DIR;
const FAMILY: Record<Side, PrivFamily> = { activity: 'attention_seen/activity', orders: 'attention_seen/orders' };

let homeserver: FakeHomeserver;

const legacyEntry = (side: Side, at: number) => `${LEGACY_DIR[side]}${String(at).padStart(13, '0')}`;

function seal(side: Side, at: number): string {
  const name = newPrivEntryName();
  const url = privListedEntryUrl(KEYRING, FAMILY[side], name);
  homeserver.files.set(
    url,
    encryptPrivRecord({ keyring: KEYRING, family: FAMILY[side], name, record: { version: 1, seenAt: at } }),
  );
  return url;
}

function sealedEntries(side: Side): { url: string; at: number }[] {
  const directory = privFamilyUrl(KEYRING, FAMILY[side]);
  return [...homeserver.files.entries()]
    .filter(([url]) => url.startsWith(directory))
    .map(([url, envelope]) => {
      const record = decryptPrivRecord({
        keyring: KEYRING,
        family: FAMILY[side],
        name: url.slice(url.lastIndexOf('/') + 1),
        envelope,
      }) as { seenAt: number };
      return { url, at: record.seenAt };
    });
}

const latest = (side: Side) => sealedEntries(side).reduce((max, { at }) => Math.max(max, at), 0);
const puts = () => homeserver.log.filter((entry) => entry.startsWith('PUT '));
const lists = () => homeserver.log.filter((entry) => entry.startsWith('LIST '));

/** A fresh browser for the same account: nothing in Dexie or local storage. */
async function switchToFreshBrowser() {
  await CommerceActivityCheckpointModel.table.clear();
  window.localStorage.clear();
}

/**
 * Activity's local copy is a Dexie write that `markSeen` awaits before it
 * schedules the homeserver write; the clock must not pass the quiet period
 * before that write is scheduled.
 */
async function activityRaised(at: number) {
  await vi.waitUntil(async () => (await LocalCommerceService.getActivityReadCheckpoint(OWNER)) >= at);
}

async function settleDebounce() {
  await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_WRITE_DEBOUNCE_MS + 1);
}

describe('CommerceAttentionSeenApplication (per-account badge checkpoints)', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    state.mode = 'transaction-service';
    useAuthStore.setState({ currentUserPubky: OWNER });
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(CommercePrivKeyringApplication, 'get').mockResolvedValue({ kind: 'keys', keyring: KEYRING });
    homeserver = installFakeHomeserver();
    await switchToFreshBrowser();
  });

  afterEach(() => {
    CommerceAttentionSeenApplication.resetPendingWrites();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears Activity and Orders in a second browser after the first browser opened them', async () => {
    const activity = CommerceAttentionSeenApplication.markSeen(OWNER, 'activity', T0);
    const orders = CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0 + 1_000);
    await activityRaised(T0);
    await settleDebounce();
    await Promise.all([activity, orders]);
    expect(latest('activity')).toBe(T0);
    expect(latest('orders')).toBe(T0 + 1_000);

    await switchToFreshBrowser();
    await CommerceAttentionSeenApplication.pull(OWNER);

    expect(await LocalCommerceService.getActivityReadCheckpoint(OWNER)).toBe(T0);
    expect(readOrdersSeenAt(OWNER, window.localStorage)).toBe(T0 + 1_000);
  });

  it('stores checkpoints encrypted under hidden names, never as timestamped plaintext', async () => {
    const write = CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0);
    await settleDebounce();
    await write;

    const [{ url }] = sealedEntries('orders');
    expect(url).not.toContain('attention');
    expect(url).not.toContain('orders');
    expect(url).not.toContain(String(T0));
    expect(JSON.stringify(homeserver.files.get(url))).not.toContain(String(T0));
    expect(privFamilyUrl(KEYRING, FAMILY.activity)).not.toBe(privFamilyUrl(KEYRING, FAMILY.orders));
    expect([...homeserver.files.keys()].some((key) => key.startsWith(LEGACY_BASE))).toBe(false);
  });

  it('never moves a side backward when two browsers read before either writes', async () => {
    // Both browsers start from activity = orders = T0. Browser A saves Orders
    // at T0+20s, browser B saves Activity at T0+30s. Both read first, then B
    // writes, then A writes: a read-modify-write of one document would put
    // Activity back to T0.
    seal('activity', T0);
    seal('orders', T0);
    homeserver.holdLists();

    const browserA = CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0 + 20_000);
    const browserB = CommerceAttentionSeenApplication.markSeen(OWNER, 'activity', T0 + 30_000);
    await activityRaised(T0 + 30_000);
    await settleDebounce();
    homeserver.releaseLists();
    await Promise.all([browserA, browserB]);

    expect(latest('activity')).toBe(T0 + 30_000);
    expect(latest('orders')).toBe(T0 + 20_000);
  });

  it('keeps the newer checkpoint when a slower tab lands an older one on the same side', async () => {
    seal('orders', T0);
    homeserver.holdLists();

    // This tab read T0 and will write T0+15s. Meanwhile another tab or
    // browser has already written T0+20s.
    const slowTab = CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0 + 15_000);
    await settleDebounce();
    const newer = seal('orders', T0 + 20_000);
    homeserver.releaseLists();
    await slowTab;

    expect(latest('orders')).toBe(T0 + 20_000);
    expect(homeserver.files.has(newer)).toBe(true);
    await switchToFreshBrowser();
    await CommerceAttentionSeenApplication.pull(OWNER);
    expect(readOrdersSeenAt(OWNER, window.localStorage)).toBe(T0 + 20_000);
  });

  it('prunes only entries older than the one it wrote', async () => {
    seal('activity', T0);
    seal('activity', T0 + 1);

    const write = CommerceAttentionSeenApplication.markSeen(OWNER, 'activity', T0 + 5_000);
    await activityRaised(T0 + 5_000);
    await settleDebounce();
    await write;

    expect(sealedEntries('activity').map(({ at }) => at)).toEqual([T0 + 5_000]);
  });

  it('turns a burst of seen moments into one write', async () => {
    const writes = [
      CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0),
      CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0 + 1_000),
      CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0 + 2_000),
    ];
    await vi.advanceTimersByTimeAsync(ATTENTION_SEEN_WRITE_DEBOUNCE_MS - 1);
    expect(puts()).toEqual([]);
    await settleDebounce();
    await Promise.all(writes);

    expect(puts()).toHaveLength(1);
    expect(latest('orders')).toBe(T0 + 2_000);
  });

  it('writes nothing when the homeserver already holds a checkpoint at least as new', async () => {
    seal('activity', T0 + 60_000);
    homeserver.log.length = 0;

    const write = CommerceAttentionSeenApplication.markSeen(OWNER, 'activity', T0);
    await activityRaised(T0);
    await settleDebounce();
    await write;

    expect(homeserver.log.filter((entry) => entry.startsWith('PUT ') || entry.startsWith('DELETE '))).toEqual([]);
  });

  it('caps a checkpoint saved by a device whose clock runs ahead', async () => {
    seal('activity', NOW + 24 * 60 * 60 * 1000);

    await CommerceAttentionSeenApplication.pull(OWNER);

    expect(await LocalCommerceService.getActivityReadCheckpoint(OWNER)).toBe(NOW);
  });

  it('ignores entries that are not checkpoints or do not decrypt, and never deletes them', async () => {
    const directory = privFamilyUrl(KEYRING, FAMILY.orders);
    homeserver.files.set(`${directory}notes.json`, { hello: true });
    const foreign = `${directory}${newPrivEntryName()}`;
    homeserver.files.set(foreign, { enc: 'pubky-priv-aead/v1', kid: 'e'.repeat(32), nonce: 'AAAA', ct: 'AAAA' });
    seal('orders', T0);

    await CommerceAttentionSeenApplication.pull(OWNER);
    expect(readOrdersSeenAt(OWNER, window.localStorage)).toBe(T0);

    const write = CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0 + 1_000);
    await settleDebounce();
    await write;
    expect(homeserver.files.has(foreign)).toBe(true);
    expect(homeserver.files.has(`${directory}notes.json`)).toBe(true);
  });

  it('keeps the checkpoint local when the homeserver refuses the private path', async () => {
    homeserver.failNext(HttpMethod.GET, privFamilyUrl(KEYRING, FAMILY.orders), 403);

    const write = CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0);
    await settleDebounce();
    await write;

    expect(puts()).toEqual([]);
    expect(readOrdersSeenAt(OWNER, window.localStorage)).toBe(T0);
  });

  it('writes nothing when reading an entry is refused, instead of skipping it as undecryptable', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const newest = seal('orders', T0 + 5_000);
    homeserver.failNext(HttpMethod.GET, newest, 403);
    homeserver.log.length = 0;

    const write = CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0 + 1_000);
    await settleDebounce();
    await write;

    expect(puts()).toEqual([]);
    expect(homeserver.files.has(newest)).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('does not decrypt');
  });

  it('logs no side, checkpoint time or private path when a checkpoint read or write fails', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    homeserver.files.set(legacyEntry('orders', T0), { version: 1, seenAt: T0 });
    const sealed = seal('orders', T0 - 1_000);

    homeserver.failNext(HttpMethod.GET, LEGACY_DIR.orders, 500);
    await CommerceAttentionSeenApplication.pull(OWNER);
    homeserver.failNext(HttpMethod.GET, privFamilyUrl(KEYRING, FAMILY.orders), 500);
    await CommerceAttentionSeenApplication.pull(OWNER);
    homeserver.failNext(HttpMethod.GET, sealed, 500);
    await CommerceAttentionSeenApplication.pull(OWNER);
    homeserver.failNext(HttpMethod.PUT, /\/v2\/s\//, 500);
    const write = CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0 + 2_000);
    await settleDebounce();
    await write;

    expect(warn).toHaveBeenCalledTimes(4);
    const logged = JSON.stringify(warn.mock.calls);
    const family = privFamilyUrl(KEYRING, FAMILY.orders).split('/').at(-2) as string;
    for (const secret of [
      'attention_seen',
      'orders',
      String(T0),
      String(T0 - 1_000),
      '/v2/s/',
      family,
      sealed.slice(sealed.lastIndexOf('/') + 1),
    ]) {
      expect(logged).not.toContain(secret);
    }
    expect(homeserver.unredacted).toEqual([]);
  });

  it('keeps the checkpoint in this browser only without a released data key', async () => {
    vi.mocked(CommercePrivKeyringApplication.get).mockResolvedValue({ kind: 'needs_reauth' });
    homeserver.files.set(legacyEntry('activity', T0 - 1_000), { version: 1, seenAt: T0 - 1_000 });

    const write = CommerceAttentionSeenApplication.markSeen(OWNER, 'activity', T0);
    await activityRaised(T0);
    await settleDebounce();
    await write;
    await CommerceAttentionSeenApplication.pull(OWNER);

    expect(homeserver.log).toEqual([]);
    expect(await LocalCommerceService.getActivityReadCheckpoint(OWNER)).toBe(T0);
  });

  it('keeps the checkpoint in this browser only when the session cannot write /priv', async () => {
    vi.mocked(HomeserverService.canCurrentSessionWrite).mockReturnValue(false);

    await CommerceAttentionSeenApplication.markSeen(OWNER, 'activity', T0);
    await CommerceAttentionSeenApplication.pull(OWNER);

    expect(homeserver.log).toEqual([]);
    expect(await LocalCommerceService.getActivityReadCheckpoint(OWNER)).toBe(T0);
  });

  it('drops a scheduled write when the account changes before it runs', async () => {
    const write = CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0);
    useAuthStore.setState({ currentUserPubky: OTHER });
    await settleDebounce();
    await write;

    expect(puts()).toEqual([]);
  });

  it('never reads or writes another account’s checkpoints', async () => {
    useAuthStore.setState({ currentUserPubky: OTHER });

    await CommerceAttentionSeenApplication.markSeen(OWNER, 'activity', T0);
    await CommerceAttentionSeenApplication.pull(OWNER);

    expect(lists()).toEqual([]);
    expect(puts()).toEqual([]);
  });

  it('stays local in the sandbox', async () => {
    state.mode = 'sandbox';

    await CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0);

    expect(homeserver.log).toEqual([]);
  });
});

describe('CommerceAttentionSeenApplication moving plaintext checkpoints', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    state.mode = 'transaction-service';
    useAuthStore.setState({ currentUserPubky: OWNER });
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(CommercePrivKeyringApplication, 'get').mockResolvedValue({ kind: 'keys', keyring: KEYRING });
    homeserver = installFakeHomeserver();
    await switchToFreshBrowser();
  });

  afterEach(() => {
    CommerceAttentionSeenApplication.resetPendingWrites();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('carries the newest plaintext checkpoint into an encrypted entry, then deletes the plaintext', async () => {
    homeserver.files.set(legacyEntry('activity', T0), { version: 1, seenAt: T0 });
    homeserver.files.set(legacyEntry('activity', T0 + 5_000), { version: 1, seenAt: T0 + 5_000 });
    homeserver.files.set(legacyEntry('orders', T0 + 1_000), { version: 1, seenAt: T0 + 1_000 });

    await CommerceAttentionSeenApplication.pull(OWNER);

    expect(await LocalCommerceService.getActivityReadCheckpoint(OWNER)).toBe(T0 + 5_000);
    expect(readOrdersSeenAt(OWNER, window.localStorage)).toBe(T0 + 1_000);
    expect(latest('activity')).toBe(T0 + 5_000);
    expect(latest('orders')).toBe(T0 + 1_000);
    expect([...homeserver.files.keys()].some((key) => key.startsWith(LEGACY_BASE))).toBe(false);
    const put = homeserver.log.findIndex((entry) => entry.startsWith('PUT '));
    const remove = homeserver.log.findIndex((entry) => entry.startsWith(`DELETE ${LEGACY_BASE}`));
    expect(put).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(put);
  });

  it('deletes plaintext checkpoints an encrypted entry already covers, without a new write', async () => {
    seal('orders', T0 + 10_000);
    homeserver.files.set(legacyEntry('orders', T0), { version: 1, seenAt: T0 });
    homeserver.log.length = 0;

    await CommerceAttentionSeenApplication.pull(OWNER);

    expect(puts()).toEqual([]);
    expect(homeserver.files.has(legacyEntry('orders', T0))).toBe(false);
    expect(readOrdersSeenAt(OWNER, window.localStorage)).toBe(T0 + 10_000);
  });

  it('keeps a newer plaintext checkpoint that no encrypted entry covers yet', async () => {
    homeserver.files.set(legacyEntry('orders', T0 + 50_000), { version: 1, seenAt: T0 + 50_000 });

    const write = CommerceAttentionSeenApplication.markSeen(OWNER, 'orders', T0);
    await settleDebounce();
    await write;

    expect(latest('orders')).toBe(T0);
    expect(homeserver.files.has(legacyEntry('orders', T0 + 50_000))).toBe(true);
  });

  it('keeps the plaintext when the encrypted write does not read back', async () => {
    homeserver.files.set(legacyEntry('activity', T0), { version: 1, seenAt: T0 });
    homeserver.corruptNextPut(/\/v2\/s\//, () => ({ enc: 'pubky-priv-aead/v1' }));

    await CommerceAttentionSeenApplication.pull(OWNER);

    expect(homeserver.files.has(legacyEntry('activity', T0))).toBe(true);
  });
});

describe('CommerceAttentionSeenApplication when the marketplace session is replaced mid-pass', () => {
  beforeEach(async () => {
    state.mode = 'transaction-service';
    useAuthStore.setState({ currentUserPubky: OWNER });
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    homeserver = installFakeHomeserver();
    await switchToFreshBrowser();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never seals, places or deletes anything under revoked keys while carrying and pruning checkpoints', async () => {
    const real = releasedKeyring(OWNER);
    const olderName = newPrivEntryName();
    const olderUrl = privListedEntryUrl(real, FAMILY.orders, olderName);
    const realEntries = () => {
      const directory = privFamilyUrl(real, FAMILY.orders);
      return [...homeserver.files.entries()]
        .filter(([url]) => url.startsWith(directory))
        .map(
          ([url, envelope]) =>
            (
              decryptPrivRecord({
                keyring: real,
                family: FAMILY.orders,
                name: url.slice(url.lastIndexOf('/') + 1),
                envelope,
              }) as { seenAt: number }
            ).seenAt,
        );
    };

    const requests = await expectSafeAtEverySessionReplacement({
      homeserver,
      ownerPubky: OWNER,
      otherPubky: OTHER,
      plant: async () => {
        await switchToFreshBrowser();
        homeserver.files.set(
          olderUrl,
          encryptPrivRecord({
            keyring: real,
            family: FAMILY.orders,
            name: olderName,
            record: { version: 1, seenAt: T0 - 1_000 },
          }),
        );
        homeserver.files.set(legacyEntry('orders', T0), { version: 1, seenAt: T0 });
      },
      flow: () => CommerceAttentionSeenApplication.pull(OWNER),
      check: () => {
        const newest = Math.max(0, ...realEntries());
        // The checkpoint never moves backward, and the plaintext goes only once a sealed entry covers it.
        expect(Math.max(newest, homeserver.files.has(legacyEntry('orders', T0)) ? T0 : 0)).toBe(T0);
        if (!homeserver.files.has(legacyEntry('orders', T0))) expect(newest).toBe(T0);
      },
    });
    expect(requests).toBeGreaterThanOrEqual(6);
  });

  it('ignores a checkpoint that is not exactly { version: 1, seenAt: <positive integer> }', async () => {
    vi.spyOn(CommercePrivKeyringApplication, 'get').mockResolvedValue({ kind: 'keys', keyring: KEYRING });
    for (const record of [
      { seenAt: T0 + 9_000 },
      { version: 2, seenAt: T0 + 9_000 },
      { version: 1, seenAt: T0 + 9_000.5 },
    ]) {
      const name = newPrivEntryName();
      homeserver.files.set(
        privListedEntryUrl(KEYRING, FAMILY.orders, name),
        encryptPrivRecord({ keyring: KEYRING, family: FAMILY.orders, name, record }),
      );
    }
    seal('orders', T0);

    await CommerceAttentionSeenApplication.pull(OWNER);

    expect(readOrdersSeenAt(OWNER, window.localStorage)).toBe(T0);
  });
});
