// Journeys for first contact, driven through MessagingController the way the
// dialogs and the inbox drive it. Two accounts share one in-memory homeserver
// (follows, conversation requests, the sealed mute list) and one two-party
// link fake, so every step runs the real controller, policy, application,
// transport service, Dexie and /priv envelope code. Switching accounts drops
// every in-memory session and cache, as a second device would.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceApplication } from '@/application/commerce/commerce';
import { CommercePrivKeyringApplication } from '@/application/commerce/priv-keyring';
import { FIRST_CONTACT_FOLLOW_PAGE_SIZE, FirstContactApplication } from '@/application/messaging/first-contact';
import { MessagingApplication } from '@/application/messaging/messaging';
import { UserStreamApplication } from '@/application/stream/users/users';
import { buildChatMessage, MARKETPLACE_CHAT_MESSAGE_KIND } from '@/libs/commerce/messaging-contracts';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import {
  encryptPrivRecord,
  newPrivEntryName,
  PRIV_V2_BASE_PATH,
  privListedEntryUrl,
} from '@/libs/commerce/priv-envelope';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { HttpMethod } from '@/libs/http/http.types';
import {
  CONVERSATION_REQUEST_KIND,
  conversationRequestUrl,
  FIRST_CONTACT_WINDOW_MS,
  RECEIVE_CAP_MAX_MESSAGES,
} from '@/libs/messaging/first-contact';
import { MUTE_CHANGE_KIND } from '@/libs/messaging/mute-list';
import {
  CommerceMessagingConversationModel,
  CommerceMessagingLinkModel,
  CommerceMessagingMessageModel,
  CommerceMessagingOutboxModel,
  CommerceMessagingReceiverModel,
  CommerceMessagingUnprocessedModel,
} from '@/models/messaging/messaging.models';
import type { Pubky } from '@/models/models.types';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { setPaykitWasmModuleForTests } from '@/services/paykit/paykit-messaging';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useMessagingStore } from '@/stores/messaging/messaging.store';
import { type FakeHomeserver, installFakeHomeserver } from '@/test-utils/fake-homeserver';
import { createFakePaykitPair } from '@/test-utils/fake-paykit-pair';
import { establishMarketplaceSession, releasedKeyring } from '@/test-utils/priv-session-replacement';
import { installWebLocks, removeWebLocks } from '@/test-utils/web-locks';
import { MessagingController } from './messaging';

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => 'transaction-service' };
});

vi.mock('@/libs/runtime-config/runtime-config', async () => {
  const actual = await vi.importActual<typeof import('@/libs/runtime-config/runtime-config')>(
    '@/libs/runtime-config/runtime-config',
  );
  return { ...actual, getTestnet: () => true };
});

const SELLER = 'i9cewoshwtswuzh6h7hzrjkqbkmf9d7o7kqqx7qnfp76mi3tbwiy';
const BUYER = 'ep4ej6h5xyb4ouzob63w1kwg4uuxncyj7cphd1tobcik8fg9guno';
const FORGER = 'bieuqr94cew8gk3cuh7x7pfxwwdgktrnz441w9fsmd8r3fwkn3wy';
const OTHER_BUYER = 'rpkwgwckimtzc4wpz35pzbd7gyr9i8ek5toetzccby8owufhguoy';
const LISTING = '0033GVVN22HJ0FYQGZZS8R2BFC';
const SECOND_LISTING = '0033GVVN22HJ0FYQGZZS8R2BFD';
const THREAD = buildMarketplaceConversationAggregateId(SELLER, BUYER, LISTING);

let homeserver: FakeHomeserver;
let pair: ReturnType<typeof createFakePaykitPair>;
let actor: string;
let orders: { buyerPubky: string; sellerPubky: string }[];

const followUrl = (follower: string, followee: string) => `pubky://${follower}/pub/pubky.app/follows/${followee}`;

/** The Nexus follow graph, read from the follow records on the homeserver. */
function followGraph(pubky: string, reach: 'following' | 'followers'): string[] {
  const out: string[] = [];
  for (const url of homeserver.files.keys()) {
    const match = /^pubky:\/\/([^/]+)\/pub\/pubky\.app\/follows\/([^/]+)$/.exec(url);
    if (!match) continue;
    const [, follower, followee] = match;
    if (reach === 'following' && follower === pubky) out.push(followee);
    if (reach === 'followers' && followee === pubky) out.push(follower);
  }
  return out;
}

/** `count` distinct valid pubkys, none of them a party to these journeys. */
function otherFollowers(count: number): string[] {
  const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769';
  return Array.from(
    { length: count },
    (_, index) => `${alphabet[index % 32]}${alphabet[(index >> 5) % 32]}${'x'.repeat(50)}`,
  );
}

/** A sealed mute record written by another device of `owner`. */
function plantMuteRecord(owner: string, counterparty: string, muted: boolean) {
  const keyring = releasedKeyring(owner);
  const name = newPrivEntryName();
  homeserver.files.set(
    privListedEntryUrl(keyring, 'messaging_mutes', name),
    encryptPrivRecord({
      keyring,
      family: 'messaging_mutes',
      name,
      record: {
        version: 1,
        kind: MUTE_CHANGE_KIND,
        owner_pubky: owner,
        counterparty_pubky: counterparty,
        muted,
        changed_at: Date.now() + 1,
      },
    }),
  );
}

/** A record in `owner`'s mute log that does not open. Returns its URL. */
function plantJunkMuteRecord(owner: string): string {
  const url = privListedEntryUrl(releasedKeyring(owner), 'messaging_mutes', newPrivEntryName());
  homeserver.files.set(url, { enc: 'pubky-priv-aead/v1', kid: 'd'.repeat(32), nonce: 'AAAA', ct: 'AAAA' });
  return url;
}

/** Signs in as `pubky` on a fresh device session: nothing in memory survives. */
async function actAs(pubky: string) {
  actor = pubky;
  MessagingApplication.clearMessagingSession();
  FirstContactApplication.clear();
  CommercePrivKeyringApplication.clear();
  establishMarketplaceSession(pubky);
  const status = await MessagingController.getMessagingStatus();
  expect(status.sessionActive).toBe(true);
}

async function rowsOf(owner: string) {
  return (await CommerceMessagingConversationModel.findByOwner(owner)).sort((a, b) =>
    a.conversation_id.localeCompare(b.conversation_id),
  );
}

/** The bodies stored in one thread, sorted (receipt times tie under the frozen clock). */
async function bodiesIn(owner: string, conversationId: string) {
  return (await LocalMessagingService.getMessages(owner, conversationId)).map((row) => row.body).sort();
}

/** The buyer's first message reaches the seller: request, handshake, delivery. */
async function strangerSendsFirstMessage(body = 'Is this still available?') {
  await actAs(SELLER);
  await actAs(BUYER);
  await MessagingController.openConversation(SELLER, BUYER, LISTING);
  const outcome = await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, body);
  await actAs(SELLER);
  await MessagingController.syncInbox();
  await actAs(BUYER);
  await MessagingController.syncInbox();
  await actAs(SELLER);
  await MessagingController.syncInbox();
  return outcome;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_790_000_000_000);
  homeserver = installFakeHomeserver();
  pair = createFakePaykitPair();
  setPaykitWasmModuleForTests(pair.module);
  installWebLocks();
  orders = [];
  actor = SELLER;
  vi.spyOn(useAuthStore, 'getState').mockImplementation(() => ({
    ...useAuthStore.getInitialState(),
    currentUserPubky: actor as Pubky,
    selectCurrentUserPubky: () => actor as Pubky,
  }));
  vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockImplementation(async (owner: string) => ({
    kind: 'keys',
    keyring: releasedKeyring(owner),
  }));
  vi.spyOn(CommerceApplication, 'getMarketplaceOrders').mockImplementation(async (owner: string) =>
    orders
      .filter((order) => order.buyerPubky === owner || order.sellerPubky === owner)
      .map((order) => order as Awaited<ReturnType<typeof CommerceApplication.getMarketplaceOrders>>[number]),
  );
  vi.spyOn(CommerceApplication, 'getMarketplaceOffers').mockResolvedValue([]);
  // Nexus pages a follow list by offset, in its own fixed order.
  vi.spyOn(UserStreamApplication, 'fetchStreamIds').mockImplementation(async ({ streamId, skip = 0, limit }) => {
    const [pubky, reach] = String(streamId).split(':');
    const ids = followGraph(pubky, reach === 'following' ? 'following' : 'followers') as Pubky[];
    return ids.slice(skip, skip + limit);
  });
  await Promise.all([
    CommerceMessagingReceiverModel.clear(),
    CommerceMessagingLinkModel.clear(),
    CommerceMessagingConversationModel.clear(),
    CommerceMessagingMessageModel.clear(),
    CommerceMessagingOutboxModel.clear(),
    CommerceMessagingUnprocessedModel.clear(),
  ]);
});

afterEach(() => {
  MessagingApplication.clearMessagingSession();
  FirstContactApplication.clear();
  CommercePrivKeyringApplication.clear();
  setPaykitWasmModuleForTests(null);
  removeWebLocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('journey: a stranger asks a seller about a listing', () => {
  it('follows the seller, publishes the request, and lands in the seller’s Requests with no unread badge', async () => {
    await actAs(SELLER);
    await actAs(BUYER);
    await MessagingController.openConversation(SELLER, BUYER, LISTING);
    await expect(MessagingController.willFollowOnSend(SELLER, BUYER, LISTING)).resolves.toBe(true);

    const outcome = await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'Is this still available?');

    expect(outcome.delivered).toBe(false);
    expect(outcome.firstContact).toEqual({ followed: 'followed', request: 'written' });
    expect(homeserver.files.has(followUrl(BUYER, SELLER))).toBe(true);
    expect(homeserver.files.get(conversationRequestUrl(BUYER, SELLER, LISTING))).toEqual({
      version: 1,
      kind: CONVERSATION_REQUEST_KIND,
      seller_pubky: SELLER,
      buyer_pubky: BUYER,
      listing_id: LISTING,
      created_at: Date.now(),
    });
    await expect(MessagingController.willFollowOnSend(SELLER, BUYER, LISTING)).resolves.toBe(false);

    // The seller's first sync finds the buyer through the follow and the
    // request, and shows the listing thread before any message arrives.
    await actAs(SELLER);
    await MessagingController.syncInbox();
    const [requestRow] = (await MessagingController.getConversations()).conversations;
    expect(requestRow).toMatchObject({ conversation_id: THREAD, counterparty_pubky: BUYER, origin: 'request' });
    expect(requestRow.lastMessage).toBeNull();

    await actAs(BUYER);
    await MessagingController.syncInbox();
    await actAs(SELLER);
    await MessagingController.syncInbox();

    await expect(bodiesIn(SELLER, THREAD)).resolves.toEqual(['Is this still available?']);
    const [row] = (await MessagingController.getConversations()).conversations;
    expect(row.origin).toBe('request');
    await expect(MessagingController.refreshUnreadCount()).resolves.toBe(0);
    expect(useMessagingStore.getState().unreadConversations).toBe(0);
  });

  it('reaches a seller whose followers fill more than one Nexus page before the buyer', async () => {
    await actAs(SELLER);
    for (const follower of otherFollowers(FIRST_CONTACT_FOLLOW_PAGE_SIZE)) {
      homeserver.files.set(followUrl(follower, SELLER), { uri: `pubky://${SELLER}` });
    }
    await actAs(BUYER);
    await MessagingController.openConversation(SELLER, BUYER, LISTING);
    const outcome = await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'Is this still available?');
    expect(outcome.firstContact).toEqual({ followed: 'followed', request: 'written' });
    expect(followGraph(SELLER, 'followers').indexOf(BUYER)).toBe(FIRST_CONTACT_FOLLOW_PAGE_SIZE);

    await actAs(SELLER);
    await MessagingController.syncInbox();
    await expect(rowsOf(SELLER)).resolves.toEqual([]);
    // The next pass reads the next page, which names the buyer.
    await MessagingController.syncInbox();
    expect((await rowsOf(SELLER)).map((row) => [row.conversation_id, row.origin])).toEqual([[THREAD, 'request']]);

    await actAs(BUYER);
    await MessagingController.syncInbox();
    await expect(CommerceMessagingOutboxModel.findByOwner(BUYER)).resolves.toEqual([]);
    await actAs(SELLER);
    await MessagingController.syncInbox();
    await expect(bodiesIn(SELLER, THREAD)).resolves.toEqual(['Is this still available?']);
  });

  it('finds a buyer who followed after the seller’s first sync on this device', async () => {
    await actAs(SELLER);
    await MessagingController.syncInbox();
    await expect(rowsOf(SELLER)).resolves.toEqual([]);

    await actAs(BUYER);
    await MessagingController.openConversation(SELLER, BUYER, LISTING);
    await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'Is this still available?');

    await actAs(SELLER);
    await MessagingController.syncInbox();
    expect((await rowsOf(SELLER)).map((row) => row.conversation_id)).toEqual([THREAD]);
  });

  it('adds one request thread per listing the buyer asks about', async () => {
    await strangerSendsFirstMessage();
    await actAs(BUYER);
    await MessagingController.openConversation(SELLER, BUYER, SECOND_LISTING);
    const second = await MessagingController.sendOrQueueMessage(SELLER, BUYER, SECOND_LISTING, 'And this one?');
    // Not a new person any more: no second follow, but the listing gets its request.
    expect(second.firstContact).toEqual({ followed: 'already', request: 'written' });

    await actAs(SELLER);
    await MessagingController.syncInbox();
    const rows = await rowsOf(SELLER);
    expect(rows.map((row) => [row.conversation_id, row.origin])).toEqual([
      [THREAD, 'request'],
      [buildMarketplaceConversationAggregateId(SELLER, BUYER, SECOND_LISTING), 'request'],
    ]);
  });

  it('ignores a request whose fields name anyone but the account whose homeserver holds it', async () => {
    await actAs(SELLER);
    // FORGER follows the seller and writes, under its own /pub, a request
    // that claims to come from BUYER.
    homeserver.files.set(followUrl(FORGER, SELLER), { uri: `pubky://${SELLER}` });
    homeserver.files.set(conversationRequestUrl(FORGER, SELLER, LISTING), {
      version: 1,
      kind: CONVERSATION_REQUEST_KIND,
      seller_pubky: SELLER,
      buyer_pubky: BUYER,
      listing_id: LISTING,
      created_at: Date.now(),
    });
    // And one that names a different listing than its path.
    homeserver.files.set(conversationRequestUrl(FORGER, SELLER, SECOND_LISTING), {
      version: 1,
      kind: CONVERSATION_REQUEST_KIND,
      seller_pubky: SELLER,
      buyer_pubky: FORGER,
      listing_id: LISTING,
      created_at: Date.now(),
    });

    await MessagingController.syncInbox();

    await expect(rowsOf(SELLER)).resolves.toEqual([]);
  });

  it('drops a message that files itself under another buyer’s thread', async () => {
    await strangerSendsFirstMessage();
    const otherThread = buildMarketplaceConversationAggregateId(SELLER, OTHER_BUYER, LISTING);
    const { json } = buildChatMessage({
      eventId: crypto.randomUUID(),
      conversationId: otherThread,
      listingRef: buildMarketplaceListingAggregateId(SELLER, LISTING),
      sentAt: Date.now(),
      body: 'planted',
    });
    pair.inject(BUYER, SELLER, json);

    await MessagingController.syncInbox();

    await expect(bodiesIn(SELLER, otherThread)).resolves.toEqual([]);
    expect((await rowsOf(SELLER)).map((row) => row.conversation_id)).toEqual([THREAD]);
  });

  it('keeps counting the receive cap across a reload', async () => {
    await strangerSendsFirstMessage();
    vi.setSystemTime(Date.now() + 61_000);
    const listingRef = buildMarketplaceListingAggregateId(SELLER, LISTING);
    const flood = (count: number, label: string) => {
      for (let index = 0; index < count; index += 1) {
        const { json } = buildChatMessage({
          eventId: crypto.randomUUID(),
          conversationId: THREAD,
          listingRef,
          sentAt: Date.now(),
          body: `${label} ${index}`,
        });
        pair.inject(BUYER, SELLER, json);
      }
    };
    flood(RECEIVE_CAP_MAX_MESSAGES - 5, 'before');
    await MessagingController.syncInbox();
    // The seller reloads within the same minute and more arrive.
    await actAs(SELLER);
    flood(10, 'after');
    const synced = await MessagingController.syncInbox();

    expect(await bodiesIn(SELLER, THREAD)).toHaveLength(1 + RECEIVE_CAP_MAX_MESSAGES);
    expect(synced.rateLimited).toBe(5);
  });

  it('stores at most the receive cap from one person per minute, whatever sent_at claims', async () => {
    await strangerSendsFirstMessage();
    vi.setSystemTime(Date.now() + 61_000);
    const listingRef = buildMarketplaceListingAggregateId(SELLER, LISTING);
    for (let index = 0; index < RECEIVE_CAP_MAX_MESSAGES + 5; index += 1) {
      pair.inject(
        BUYER,
        SELLER,
        JSON.stringify({
          version: 1,
          kind: MARKETPLACE_CHAT_MESSAGE_KIND,
          event_id: crypto.randomUUID(),
          conversation_id: THREAD,
          listing_ref: listingRef,
          // Claims to be spread over hours; the cap uses the receiver's clock.
          sent_at: Date.now() - index * 3_600_000,
          body: `flood ${index}`,
        }),
      );
    }

    const synced = await MessagingController.syncInbox();

    // The first message arrived in an earlier minute, so all 20 slots were free.
    expect(await bodiesIn(SELLER, THREAD)).toHaveLength(1 + RECEIVE_CAP_MAX_MESSAGES);
    expect(synced.rateLimited).toBe(5);
  });
});

describe('journey: the seller accepts a request', () => {
  it('moves the thread into the inbox, where it counts as unread until read', async () => {
    await strangerSendsFirstMessage();

    await MessagingController.acceptRequest(BUYER);

    const [row] = (await MessagingController.getConversations()).conversations;
    expect(row.origin).toBe('known');
    expect(useMessagingStore.getState().unreadConversations).toBe(1);
    await MessagingController.markConversationRead(THREAD);
    expect(useMessagingStore.getState().unreadConversations).toBe(0);
  });

  it('treats a reply as accepting the person', async () => {
    await strangerSendsFirstMessage();

    const reply = await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'Yes, it is.');

    expect(reply.delivered).toBe(true);
    expect(reply.firstContact).toBeNull();
    expect((await rowsOf(SELLER)).map((row) => row.origin)).toEqual(['known']);
  });

  it('puts a buyer the seller shares an order with straight into the inbox', async () => {
    orders = [{ buyerPubky: BUYER, sellerPubky: SELLER }];
    await actAs(SELLER);
    await MessagingController.syncInbox();
    await actAs(BUYER);
    await MessagingController.syncInbox();
    await MessagingController.openConversation(SELLER, BUYER, LISTING);
    const outcome = await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'About my order');
    // Both sides of an order already find each other: no follow, no request.
    expect(outcome.firstContact).toBeNull();
    expect(homeserver.files.has(followUrl(BUYER, SELLER))).toBe(false);
    expect(homeserver.files.has(conversationRequestUrl(BUYER, SELLER, LISTING))).toBe(false);

    await actAs(SELLER);
    await MessagingController.syncInbox();
    await actAs(BUYER);
    await MessagingController.syncInbox();
    await actAs(SELLER);
    await MessagingController.syncInbox();

    const [row] = (await MessagingController.getConversations()).conversations;
    expect(row).toMatchObject({ conversation_id: THREAD, origin: 'known' });
    expect(useMessagingStore.getState().unreadConversations).toBe(1);
  });

  it('moves a request into the inbox once the seller follows the buyer', async () => {
    await strangerSendsFirstMessage();
    homeserver.files.set(followUrl(SELLER, BUYER), { uri: `pubky://${BUYER}` });

    await MessagingController.syncInbox();

    expect((await rowsOf(SELLER)).map((row) => row.origin)).toEqual(['known']);
  });
});

describe('journey: the seller mutes a buyer', () => {
  it('saves the mute sealed in /priv, hides the thread, and stops probing, sending and storing', async () => {
    await strangerSendsFirstMessage();

    const state = await MessagingController.setCounterpartyMuted(BUYER, true);

    expect(state.kind).toBe('ready');
    const sealed = [...homeserver.files.entries()].filter(([url]) => url.includes(PRIV_V2_BASE_PATH));
    expect(sealed).toHaveLength(1);
    const [[url, body]] = sealed;
    expect(url).not.toContain('mute');
    expect(Object.keys(body as object).sort()).toEqual(['ct', 'enc', 'kid', 'nonce']);
    expect(JSON.stringify(body)).not.toContain(BUYER);
    expect(homeserver.unredacted).toEqual([]);
    await expect(MessagingController.getConversations()).resolves.toMatchObject({ conversations: [] });

    await actAs(BUYER);
    await expect(MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'Hello?')).resolves.toMatchObject({
      delivered: true,
    });

    // A new device of the seller reads the mute back from /priv.
    await actAs(SELLER);
    pair.log.length = 0;
    await MessagingController.syncInbox();
    expect(pair.log.filter((entry) => entry.startsWith(`receive ${SELLER.slice(0, 4)}`))).toEqual([]);
    await expect(bodiesIn(SELLER, THREAD)).resolves.toEqual(['Is this still available?']);
    await expect(MessagingController.openConversation(SELLER, BUYER, LISTING)).resolves.toMatchObject({
      state: { status: 'muted' },
    });
    await expect(MessagingController.pollConversation(SELLER, BUYER, LISTING)).resolves.toMatchObject({
      state: { status: 'muted' },
      received: [],
    });
    await expect(MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'reply')).rejects.toThrow(
      MESSAGING_COPY.mutedSendRefused,
    );
    await expect(MessagingController.sendOrQueueDmMessage(BUYER, 'dm')).rejects.toThrow(
      MESSAGING_COPY.mutedSendRefused,
    );
  });

  it('delivers again after an unmute', async () => {
    await strangerSendsFirstMessage();
    await MessagingController.setCounterpartyMuted(BUYER, true);
    await actAs(BUYER);
    await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'Sent while muted');

    await actAs(SELLER);
    await expect(MessagingController.setCounterpartyMuted(BUYER, false)).resolves.toMatchObject({ kind: 'ready' });
    await MessagingController.syncInbox();

    await expect(bodiesIn(SELLER, THREAD)).resolves.toEqual(['Is this still available?', 'Sent while muted'].sort());
    expect((await MessagingController.getConversations()).conversations.map((row) => row.counterparty_pubky)).toEqual([
      BUYER,
    ]);
  });

  it('contacts nobody, stores nothing and shows nothing new while the mute list cannot be read', async () => {
    await strangerSendsFirstMessage();
    await MessagingController.acceptRequest(BUYER);
    await actAs(BUYER);
    await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'While the list is unreadable');

    // Something in the seller's mute log does not open: the list cannot be confirmed.
    await actAs(SELLER);
    const junk = plantJunkMuteRecord(SELLER);
    pair.log.length = 0;
    homeserver.log.length = 0;

    await expect(MessagingController.syncInbox()).resolves.toEqual({ mutes: 'error', rateLimited: 0 });
    await expect(MessagingController.openConversation(SELLER, BUYER, LISTING)).resolves.toMatchObject({
      state: { status: 'paused', reason: 'error' },
    });
    await expect(MessagingController.pollConversation(SELLER, BUYER, LISTING)).resolves.toMatchObject({
      state: { status: 'paused' },
      received: [],
    });
    await expect(MessagingController.openDmConversation(BUYER)).resolves.toMatchObject({
      state: { status: 'paused' },
    });
    await expect(MessagingController.pollDmConversation(BUYER)).resolves.toMatchObject({ state: { status: 'paused' } });
    await expect(MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'reply')).rejects.toThrow(
      MESSAGING_COPY.sendPausedForMutes,
    );
    await expect(MessagingController.sendOrQueueDmMessage(BUYER, 'dm')).rejects.toThrow(
      MESSAGING_COPY.sendPausedForMutes,
    );

    // No handshake step, send or receive with anyone, and no read of anyone else's homeserver.
    expect(pair.log).toEqual([]);
    expect(homeserver.log.filter((entry) => !entry.includes(SELLER))).toEqual([]);
    await expect(bodiesIn(SELLER, THREAD)).resolves.toEqual(['Is this still available?']);
    await expect(MessagingController.getQueuedConversationMessages(THREAD)).resolves.toEqual([]);
    // The thread already held an unread message; while the list is unknown the badge shows nothing new,
    // and no conversation, preview, history or queued row is returned to any surface.
    await expect(MessagingController.refreshUnreadCount()).resolves.toBe(0);
    await expect(MessagingController.getConversations()).resolves.toEqual({ mutes: 'error', conversations: [] });
    await expect(MessagingController.getConversationMessages(THREAD)).resolves.toEqual([]);
    await expect(MessagingController.getQueuedConversationMessages(THREAD)).resolves.toEqual([]);

    // Once the list reads again, the waiting message arrives.
    homeserver.files.delete(junk);
    await expect(MessagingController.syncInbox()).resolves.toMatchObject({ mutes: 'ready' });
    await expect(bodiesIn(SELLER, THREAD)).resolves.toEqual(
      ['Is this still available?', 'While the list is unreadable'].sort(),
    );
    await expect(MessagingController.refreshUnreadCount()).resolves.toBe(1);
    await expect(MessagingController.getConversationMessages(THREAD)).resolves.toHaveLength(2);
  });

  it('shows none of the buyer’s own queued messages while the buyer’s mute list is unreadable', async () => {
    await actAs(SELLER);
    await actAs(BUYER);
    await MessagingController.openConversation(SELLER, BUYER, LISTING);
    await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'Waiting for the seller');
    await expect(MessagingController.getQueuedConversationMessages(THREAD)).resolves.toHaveLength(1);

    const junk = plantJunkMuteRecord(BUYER);
    await expect(MessagingController.getQueuedConversationMessages(THREAD)).resolves.toEqual([]);
    await expect(MessagingController.getConversations()).resolves.toEqual({ mutes: 'error', conversations: [] });

    homeserver.files.delete(junk);
    await expect(MessagingController.getQueuedConversationMessages(THREAD)).resolves.toHaveLength(1);
  });

  it('lists nothing on a first read that fails, and nothing a stale read would have allowed', async () => {
    await strangerSendsFirstMessage();
    await MessagingController.acceptRequest(BUYER);
    // A fresh device whose very first read fails.
    await actAs(SELLER);
    homeserver.failNext(HttpMethod.GET, new RegExp(PRIV_V2_BASE_PATH), 503);
    await expect(MessagingController.getConversations()).resolves.toEqual({ mutes: 'error', conversations: [] });

    // This tab read the list; another device then mutes the buyer; the next read fails.
    await expect(MessagingController.getConversations()).resolves.toMatchObject({ mutes: 'ready' });
    plantMuteRecord(SELLER, BUYER, true);
    homeserver.failNext(HttpMethod.GET, new RegExp(PRIV_V2_BASE_PATH), 503);
    await expect(MessagingController.getConversations()).resolves.toEqual({ mutes: 'error', conversations: [] });
    homeserver.failNext(HttpMethod.GET, new RegExp(PRIV_V2_BASE_PATH), 503);
    await expect(MessagingController.getConversationMessages(THREAD)).resolves.toEqual([]);

    // Once the list reads, the muted thread stays hidden and its history is not shown.
    await expect(MessagingController.getConversations()).resolves.toEqual({ mutes: 'ready', conversations: [] });
    await expect(MessagingController.getConversationMessages(THREAD)).resolves.toEqual([]);
    await expect(MessagingController.refreshUnreadCount()).resolves.toBe(0);
  });

  it('never lets an earlier read authorize messages after another device mutes the sender', async () => {
    await strangerSendsFirstMessage();
    await expect(MessagingController.getMutes()).resolves.toEqual({ kind: 'ready', muted: new Set() });
    // The buyer writes again, and another device of the seller mutes the buyer.
    const { json } = buildChatMessage({
      eventId: crypto.randomUUID(),
      conversationId: THREAD,
      listingRef: buildMarketplaceListingAggregateId(SELLER, LISTING),
      sentAt: Date.now(),
      body: 'After the mute elsewhere',
    });
    pair.inject(BUYER, SELLER, json);
    plantMuteRecord(SELLER, BUYER, true);

    // This tab's next read fails: what it read earlier must not let the message in.
    homeserver.failNext(HttpMethod.GET, new RegExp(PRIV_V2_BASE_PATH), 503);
    await expect(MessagingController.syncInbox()).resolves.toMatchObject({ mutes: 'error' });
    await expect(bodiesIn(SELLER, THREAD)).resolves.toEqual(['Is this still available?']);

    // The next reads see the mute.
    await expect(MessagingController.pollConversation(SELLER, BUYER, LISTING)).resolves.toMatchObject({
      state: { status: 'muted' },
    });
    await expect(MessagingController.syncInbox()).resolves.toMatchObject({ mutes: 'ready' });
    await expect(bodiesIn(SELLER, THREAD)).resolves.toEqual(['Is this still available?']);
    await expect(MessagingController.getConversations()).resolves.toMatchObject({ conversations: [] });
  });

  it.each([
    ['an open conversation', () => MessagingController.pollConversation(SELLER, BUYER, LISTING)],
    ['the inbox sync', () => MessagingController.syncInbox()],
  ])(
    'reads an event again after failing to store it, before any later event moves the link on, through %s',
    async (_path, receive) => {
      await strangerSendsFirstMessage();
      const unknown = JSON.stringify({ version: 1, kind: 'paykit.private_payment_list.v0', endpoints: [] });
      pair.inject(BUYER, SELLER, unknown);
      vi.spyOn(LocalMessagingService, 'storeUnprocessed').mockRejectedValueOnce(new Error('storage failed'));

      await expect(receive()).rejects.toThrow('storage failed');
      await expect(LocalMessagingService.getUnprocessed(SELLER, BUYER)).resolves.toEqual([]);

      // A later event arrives, and the same tab receives again without a reload.
      const { json } = buildChatMessage({
        eventId: crypto.randomUUID(),
        conversationId: THREAD,
        listingRef: buildMarketplaceListingAggregateId(SELLER, LISTING),
        sentAt: Date.now(),
        body: 'later',
      });
      pair.inject(BUYER, SELLER, json);
      await receive();

      const kept = await LocalMessagingService.getUnprocessed(SELLER, BUYER);
      expect(kept.map((event) => event.rawJson)).toEqual([unknown]);
      await expect(bodiesIn(SELLER, THREAD)).resolves.toEqual(['Is this still available?', 'later']);
    },
  );

  it('keeps an event of a kind it cannot read across a restart, without showing it', async () => {
    await strangerSendsFirstMessage();
    const unknown = JSON.stringify({ version: 1, kind: 'paykit.private_payment_list.v0', endpoints: [] });
    pair.inject(BUYER, SELLER, unknown);

    await MessagingController.syncInbox();
    await actAs(SELLER);
    await MessagingController.syncInbox();

    const kept = await LocalMessagingService.getUnprocessed(SELLER, BUYER);
    expect(kept.map((event) => event.rawJson)).toEqual([unknown]);
    await expect(bodiesIn(SELLER, THREAD)).resolves.toEqual(['Is this still available?']);
  });

  it('never replaces a mute list it could not read', async () => {
    await strangerSendsFirstMessage();
    await MessagingController.setCounterpartyMuted(BUYER, true);
    const before = new Map(homeserver.files);

    await actAs(SELLER);
    homeserver.failNext(HttpMethod.GET, new RegExp(PRIV_V2_BASE_PATH), 503);
    await expect(MessagingController.setCounterpartyMuted(OTHER_BUYER, true)).resolves.toEqual({ kind: 'error' });

    expect(homeserver.log.filter((entry) => entry.startsWith('PUT') && entry.includes(PRIV_V2_BASE_PATH))).toHaveLength(
      1,
    );
    expect(homeserver.files).toEqual(before);
    await expect(MessagingController.getMutes()).resolves.toEqual({ kind: 'ready', muted: new Set([BUYER]) });
  });
});

describe('journey: the buyer follows the seller on the first message', () => {
  it('does not follow again when the buyer already follows the seller', async () => {
    await actAs(SELLER);
    await actAs(BUYER);
    homeserver.files.set(followUrl(BUYER, SELLER), { uri: `pubky://${SELLER}` });
    await MessagingController.openConversation(SELLER, BUYER, LISTING);
    await expect(MessagingController.willFollowOnSend(SELLER, BUYER, LISTING)).resolves.toBe(false);

    const outcome = await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'Hi');

    expect(outcome.firstContact).toEqual({ followed: 'already', request: 'written' });
    expect(homeserver.log.filter((entry) => entry === `PUT ${followUrl(BUYER, SELLER)}`)).toEqual([]);
  });

  it('still queues the message and reports the failed follow, never a fake delivery', async () => {
    await actAs(SELLER);
    await actAs(BUYER);
    await MessagingController.openConversation(SELLER, BUYER, LISTING);
    homeserver.failNext(HttpMethod.PUT, followUrl(BUYER, SELLER), 500);

    const outcome = await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'Hi');

    expect(outcome).toMatchObject({ delivered: false, firstContact: { followed: 'failed', request: 'written' } });
    expect(homeserver.files.has(followUrl(BUYER, SELLER))).toBe(false);
    await expect(MessagingController.getQueuedConversationMessages(THREAD)).resolves.toHaveLength(1);
  });

  it('writes no request when the existing one cannot be read', async () => {
    await actAs(SELLER);
    await actAs(BUYER);
    await MessagingController.openConversation(SELLER, BUYER, LISTING);
    homeserver.failNext(HttpMethod.GET, conversationRequestUrl(BUYER, SELLER, LISTING), 503);

    const outcome = await MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'Hi');

    expect(outcome.firstContact).toEqual({ followed: 'followed', request: 'failed' });
    expect(homeserver.log).not.toContain(`PUT ${conversationRequestUrl(BUYER, SELLER, LISTING)}`);
  });

  it('follows nobody and publishes nothing for a first message that cannot be sent', async () => {
    await actAs(SELLER);
    await actAs(BUYER);
    await MessagingController.openConversation(SELLER, BUYER, LISTING);

    await expect(MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING, 'x'.repeat(2_000))).rejects.toThrow(
      /too long/,
    );

    expect(homeserver.log.filter((entry) => entry.startsWith('PUT'))).toEqual([]);
    await expect(MessagingController.willFollowOnSend(SELLER, BUYER, LISTING)).resolves.toBe(true);
  });

  it('lets only one of two concurrent first messages take the last free slot', async () => {
    await actAs(BUYER);
    const sellers = ['c', 'd', 'e', 'f', 'g', 'h'].map((letter) => letter.repeat(52));
    for (const seller of sellers.slice(0, 4)) {
      await MessagingController.sendOrQueueMessage(seller, BUYER, LISTING, 'Hi');
    }

    const outcomes = await Promise.allSettled(
      sellers.slice(4).map((seller) => MessagingController.sendOrQueueMessage(seller, BUYER, LISTING, 'Hi')),
    );

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(String((refused as PromiseRejectedResult).reason)).toContain(MESSAGING_COPY.firstContactLimited);
  });

  it('refuses a sixth new seller within the hour before following, publishing or queueing anything', async () => {
    await actAs(BUYER);
    const sellers = ['c', 'd', 'e', 'f', 'g', 'h'].map((letter) => letter.repeat(52));
    for (const seller of sellers.slice(0, 5)) {
      await MessagingController.sendOrQueueMessage(seller, BUYER, LISTING, 'Hi');
    }
    const sixth = sellers[5];

    await expect(MessagingController.sendOrQueueMessage(sixth, BUYER, LISTING, 'Hi')).rejects.toThrow(
      MESSAGING_COPY.firstContactLimited,
    );
    expect(homeserver.log.some((entry) => entry.includes(sixth))).toBe(false);
    await expect(
      MessagingController.getQueuedConversationMessages(buildMarketplaceConversationAggregateId(sixth, BUYER, LISTING)),
    ).resolves.toEqual([]);

    // Writing again to one of the five is not a new person.
    await expect(MessagingController.sendOrQueueMessage(sellers[0], BUYER, LISTING, 'Again')).resolves.toBeDefined();

    vi.setSystemTime(Date.now() + FIRST_CONTACT_WINDOW_MS);
    await expect(MessagingController.sendOrQueueMessage(sixth, BUYER, LISTING, 'Hi')).resolves.toMatchObject({
      firstContact: { followed: 'followed', request: 'written' },
    });
  });
});
