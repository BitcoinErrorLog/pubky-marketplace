import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommercePrivKeyringApplication } from '@/application/commerce/priv-keyring';
import {
  decryptPrivRecord,
  encryptPrivRecord,
  newPrivEntryName,
  privEntryName,
  privEntryUrl,
  privFamilyUrl,
  privListedEntryUrl,
} from '@/libs/commerce/priv-envelope';
import { HttpMethod } from '@/libs/http/http.types';
import { conversationRequestUrl } from '@/libs/messaging/first-contact';
import {
  foldMuteChanges,
  MUTE_CHANGE_KIND,
  type MuteChange,
  MUTED_PEOPLE_MAX,
  mutedPubkys,
  parseMuteChange,
} from '@/libs/messaging/mute-list';
import { CommerceMessagingConversationModel, CommerceMessagingMessageModel } from '@/models/messaging/messaging.models';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { type FakeHomeserver, installFakeHomeserver } from '@/test-utils/fake-homeserver';
import {
  establishMarketplaceSession,
  expectSafeAtEverySessionReplacement,
  releasedKeyring,
} from '@/test-utils/priv-session-replacement';
import { FirstContactApplication } from './first-contact';

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => 'transaction-service' };
});

const OWNER = 'o'.repeat(52);
const OTHER_OWNER = 'p'.repeat(52);
const A = 'a'.repeat(52);
const B = 'b'.repeat(52);
const Z = 'z'.repeat(52);
const LISTING = '0033GVVN22HJ0FYQGZZS8R2BFC';

const familyUrl = () => privFamilyUrl(releasedKeyring(OWNER), 'messaging_mutes');

const change = (counterparty: string, muted: boolean, changedAt: number): MuteChange => ({
  version: 1,
  kind: MUTE_CHANGE_KIND,
  owner_pubky: OWNER,
  counterparty_pubky: counterparty,
  muted,
  changed_at: changedAt,
});

/** Writes one sealed record the way another device or tab would. */
function plantMuteChange(homeserver: FakeHomeserver, record: unknown, name = newPrivEntryName()) {
  const keyring = releasedKeyring(OWNER);
  homeserver.files.set(
    privListedEntryUrl(keyring, 'messaging_mutes', name),
    encryptPrivRecord({ keyring, family: 'messaging_mutes', name, record }),
  );
  return name;
}

/** Everyone the stored log says is muted, read with the owner's real keys. */
function storedMutes(homeserver: FakeHomeserver): Set<string> {
  const keyring = releasedKeyring(OWNER);
  const records: MuteChange[] = [];
  for (const [url, envelope] of homeserver.files) {
    if (!url.startsWith(familyUrl())) continue;
    const name = url.slice(url.lastIndexOf('/') + 1);
    const record = parseMuteChange(decryptPrivRecord({ keyring, family: 'messaging_mutes', name, envelope }), OWNER);
    if (record) records.push(record);
  }
  return mutedPubkys(foldMuteChanges(records));
}

const muteRecordCount = (homeserver: FakeHomeserver) =>
  [...homeserver.files.keys()].filter((url) => url.startsWith(familyUrl())).length;

/** A new device or a reload: nothing this tab knew survives. */
function freshDevice() {
  FirstContactApplication.clear();
  CommercePrivKeyringApplication.clear();
  establishMarketplaceSession(OWNER);
}

let homeserver: FakeHomeserver;

beforeEach(async () => {
  homeserver = installFakeHomeserver();
  FirstContactApplication.clear();
  CommercePrivKeyringApplication.clear();
  establishMarketplaceSession(OWNER);
  vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockImplementation(async (owner: string) => ({
    kind: 'keys',
    keyring: releasedKeyring(owner),
  }));
  await Promise.all([CommerceMessagingConversationModel.clear(), CommerceMessagingMessageModel.clear()]);
});

afterEach(() => {
  FirstContactApplication.clear();
  CommercePrivKeyringApplication.clear();
  vi.restoreAllMocks();
});

describe('FirstContactApplication mutes', () => {
  it('adds one sealed record per change and never rewrites an earlier one', async () => {
    const earlier = plantMuteChange(homeserver, change(A, true, 10));
    const earlierBytes = structuredClone(
      homeserver.files.get(privListedEntryUrl(releasedKeyring(OWNER), 'messaging_mutes', earlier)),
    );

    await expect(FirstContactApplication.setMuted(OWNER, B, true)).resolves.toEqual({
      kind: 'ready',
      muted: new Set([A, B]),
    });

    expect(muteRecordCount(homeserver)).toBe(2);
    expect(homeserver.files.get(privListedEntryUrl(releasedKeyring(OWNER), 'messaging_mutes', earlier))).toEqual(
      earlierBytes,
    );
    expect(homeserver.log.filter((entry) => entry.startsWith('PUT'))).toHaveLength(1);
    expect(homeserver.log.filter((entry) => entry.startsWith('DELETE'))).toEqual([]);
    expect(storedMutes(homeserver)).toEqual(new Set([A, B]));
  });

  it('keeps every acknowledged mute across two devices when the first is gone before they reconcile', async () => {
    // Device A mutes Z and is then closed for good.
    await expect(FirstContactApplication.setMuted(OWNER, Z, true)).resolves.toMatchObject({ kind: 'ready' });
    freshDevice();
    // Device B had read the list before A's change and now mutes B.
    await expect(FirstContactApplication.setMuted(OWNER, B, true)).resolves.toMatchObject({ kind: 'ready' });
    freshDevice();

    // A third device, knowing nothing, reads both.
    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'ready', muted: new Set([Z, B]) });
  });

  it('keeps both changes when two tabs write at the same time', async () => {
    const parked = homeserver.holdNext(HttpMethod.PUT, new RegExp(familyUrl()));
    const tabOne = FirstContactApplication.setMuted(OWNER, A, true);
    await parked.reached;
    // The other tab adds its own record while this tab's write is in flight.
    plantMuteChange(homeserver, change(B, true, Date.now()));
    parked.release();
    await expect(tabOne).resolves.toMatchObject({ kind: 'ready' });

    freshDevice();
    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'ready', muted: new Set([A, B]) });
  });

  it('never loses or half-writes a mute when the page reloads in the middle of the change', async () => {
    const parked = homeserver.holdNext(HttpMethod.PUT, new RegExp(familyUrl()));
    const muting = FirstContactApplication.setMuted(OWNER, A, true);
    await parked.reached;
    freshDevice();
    parked.release();
    // The record landed but could not be read back under the revoked keys, so the change is not acknowledged here.
    await expect(muting).resolves.toEqual({ kind: 'error' });

    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'ready', muted: new Set([A]) });

    homeserver.failNext(HttpMethod.PUT, new RegExp(familyUrl()), 503);
    await expect(FirstContactApplication.setMuted(OWNER, B, true)).resolves.toEqual({ kind: 'error' });
    freshDevice();
    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'ready', muted: new Set([A]) });
  });

  it('never reports an earlier read as current when the latest read fails', async () => {
    plantMuteChange(homeserver, change(A, true, 10));
    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'ready', muted: new Set([A]) });
    // Another device mutes B, and this tab's next read fails.
    plantMuteChange(homeserver, change(B, true, 11));
    homeserver.failNext(HttpMethod.GET, new RegExp(familyUrl()), 503);

    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'error' });
  });

  it('cannot confirm the list, and writes nothing, while any record in it does not open', async () => {
    plantMuteChange(homeserver, change(A, true, 10));
    plantMuteChange(homeserver, { version: 2, surprise: true });

    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'error' });
    await expect(FirstContactApplication.setMuted(OWNER, B, true)).resolves.toEqual({ kind: 'error' });
    expect(homeserver.log.filter((entry) => entry.startsWith('PUT'))).toEqual([]);
  });

  it('reads every record past one page of the list', async () => {
    for (let index = 0; index < 504; index += 1) plantMuteChange(homeserver, change(A, false, index));
    // The only mute sorts after every other name, so it is on the second page.
    plantMuteChange(homeserver, change(B, true, 1), 'f'.repeat(32));

    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'ready', muted: new Set([B]) });
  });

  it('writes nothing for a change already in effect', async () => {
    plantMuteChange(homeserver, change(A, true, 10));

    await expect(FirstContactApplication.setMuted(OWNER, A, true)).resolves.toMatchObject({ kind: 'ready' });
    await expect(FirstContactApplication.setMuted(OWNER, B, false)).resolves.toMatchObject({ kind: 'ready' });

    expect(homeserver.log.filter((entry) => entry.startsWith('PUT'))).toEqual([]);
  });

  it('refuses a new mute past the limit without writing, and still unmutes', async () => {
    const z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
    const pubkyFor = (n: number) =>
      [3, 2, 1, 0]
        .map((power) => z32[Math.floor(n / 32 ** power) % 32])
        .join('')
        .padStart(52, 'y');
    for (let index = 0; index < MUTED_PEOPLE_MAX; index += 1)
      plantMuteChange(homeserver, change(pubkyFor(index), true, 1));

    await expect(FirstContactApplication.setMuted(OWNER, A, true)).resolves.toEqual({ kind: 'full' });
    expect(homeserver.log.filter((entry) => entry.startsWith('PUT'))).toEqual([]);

    await expect(FirstContactApplication.setMuted(OWNER, pubkyFor(0), false)).resolves.toMatchObject({ kind: 'ready' });
    await expect(FirstContactApplication.setMuted(OWNER, A, true)).resolves.toMatchObject({ kind: 'ready' });
    expect(storedMutes(homeserver).size).toBe(MUTED_PEOPLE_MAX);
  });

  it('folds in a list saved in the earlier single-document format, so none of its mutes is lost', async () => {
    const keyring = releasedKeyring(OWNER);
    const name = privEntryName(keyring, 'messaging_mutes', 'mutes');
    homeserver.files.set(
      privEntryUrl(keyring, 'messaging_mutes', 'mutes'),
      encryptPrivRecord({
        keyring,
        family: 'messaging_mutes',
        name,
        record: {
          version: 1,
          kind: 'pubky_app.messaging_mutes.v0',
          owner_pubky: OWNER,
          entries: { [A]: { muted: true, changed_at: 10 }, [B]: { muted: false, changed_at: 11 } },
        },
      }),
    );

    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'ready', muted: new Set([A]) });
    await expect(FirstContactApplication.setMuted(OWNER, Z, true)).resolves.toEqual({
      kind: 'ready',
      muted: new Set([A, Z]),
    });
    // A later unmute record overrides the earlier document.
    await expect(FirstContactApplication.setMuted(OWNER, A, false)).resolves.toEqual({
      kind: 'ready',
      muted: new Set([Z]),
    });
    freshDevice();
    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'ready', muted: new Set([Z]) });
  });

  it('cannot confirm the list while an earlier-format document does not validate', async () => {
    const keyring = releasedKeyring(OWNER);
    homeserver.files.set(
      privEntryUrl(keyring, 'messaging_mutes', 'mutes'),
      encryptPrivRecord({
        keyring,
        family: 'messaging_mutes',
        name: privEntryName(keyring, 'messaging_mutes', 'mutes'),
        record: { version: 9 },
      }),
    );

    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'error' });
    await expect(FirstContactApplication.setMuted(OWNER, B, true)).resolves.toEqual({ kind: 'error' });
    expect(homeserver.log.filter((entry) => entry.startsWith('PUT'))).toEqual([]);
  });

  it('asks for approval when the marketplace session is not this owner’s', async () => {
    establishMarketplaceSession(OTHER_OWNER);

    await expect(FirstContactApplication.loadMutes(OWNER)).resolves.toEqual({ kind: 'needs_approval' });
    await expect(FirstContactApplication.setMuted(OWNER, B, true)).resolves.toEqual({ kind: 'needs_approval' });
    expect(homeserver.log).toEqual([]);
  });

  it('never seals a mute under revoked keys or loses one when the session is replaced mid-write', async () => {
    let planted = '';
    const requests = await expectSafeAtEverySessionReplacement({
      homeserver,
      ownerPubky: OWNER,
      otherPubky: OTHER_OWNER,
      plant: () => {
        FirstContactApplication.clear();
        planted = plantMuteChange(homeserver, change(A, true, 10));
      },
      flow: () => FirstContactApplication.setMuted(OWNER, B, true),
      check: () => {
        expect(storedMutes(homeserver).has(A)).toBe(true);
        expect(homeserver.files.has(privListedEntryUrl(releasedKeyring(OWNER), 'messaging_mutes', planted))).toBe(true);
      },
    });
    expect(requests).toBe(5);
  });
});

describe('FirstContactApplication policy', () => {
  it('gives no policy unless the mute list was just confirmed', () => {
    expect(FirstContactApplication.policyFor(OWNER, { kind: 'error' })).toBeNull();
    expect(FirstContactApplication.policyFor(OWNER, { kind: 'needs_approval' })).toBeNull();
    expect(FirstContactApplication.policyFor(OWNER, { kind: 'needs_reauth' })).toBeNull();
    expect(FirstContactApplication.policyFor(OWNER, { kind: 'unavailable' })).not.toBeNull();
  });

  it('refuses muted people and files strangers under Requests, known people in the inbox', async () => {
    const policy = FirstContactApplication.policyFor(OWNER, { kind: 'ready', muted: new Set([A]) });
    FirstContactApplication.setKnownContacts(OWNER, { following: [], orderCounterparties: [B] });

    expect(policy?.isMuted(A)).toBe(true);
    await expect(policy?.gate.admit({ counterpartyPubky: A, kind: 'dm', conversationId: `dm:${A}` })).resolves.toEqual({
      store: false,
      reason: 'muted',
    });
    await expect(policy?.gate.admit({ counterpartyPubky: B, kind: 'dm', conversationId: `dm:${B}` })).resolves.toEqual({
      store: true,
      origin: 'known',
    });
    await expect(policy?.gate.admit({ counterpartyPubky: Z, kind: 'dm', conversationId: `dm:${Z}` })).resolves.toEqual({
      store: true,
      origin: 'request',
    });
    await expect(policy?.gate.admit({ counterpartyPubky: A, kind: 'unknown', conversationId: null })).resolves.toEqual({
      store: false,
      reason: 'muted',
    });
  });
});

describe('FirstContactApplication conversation requests', () => {
  it('writes the request only when there is none, and keeps a valid one', async () => {
    await expect(FirstContactApplication.writeConversationRequest(B, OWNER, LISTING)).resolves.toBe('written');
    const first = homeserver.files.get(conversationRequestUrl(B, OWNER, LISTING));
    await expect(FirstContactApplication.writeConversationRequest(B, OWNER, LISTING)).resolves.toBe('kept');
    expect(homeserver.files.get(conversationRequestUrl(B, OWNER, LISTING))).toEqual(first);
    expect(homeserver.log.filter((entry) => entry.startsWith('PUT'))).toHaveLength(1);
  });

  it('replaces an invalid document at its own path', async () => {
    homeserver.files.set(conversationRequestUrl(B, OWNER, LISTING), { junk: true });
    await expect(FirstContactApplication.writeConversationRequest(B, OWNER, LISTING)).resolves.toBe('written');
  });

  it('lists nothing for muted followers and treats a missing directory as empty', async () => {
    await FirstContactApplication.writeConversationRequest(A, OWNER, LISTING);
    homeserver.log.length = 0;

    await expect(FirstContactApplication.discoverRequests(OWNER, [A, B], new Set([A]))).resolves.toEqual([]);

    expect(homeserver.log.filter((entry) => entry.includes(A))).toEqual([]);
    await expect(CommerceMessagingConversationModel.findByOwner(OWNER)).resolves.toEqual([]);
  });
});
