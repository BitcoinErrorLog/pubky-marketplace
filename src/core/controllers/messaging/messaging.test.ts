import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceApplication } from '@/application/commerce/commerce';
import { FIRST_CONTACT_FOLLOW_PAGE_SIZE, FirstContactApplication } from '@/application/messaging/first-contact';
import { MessagingApplication } from '@/application/messaging/messaging';
import { UserStreamApplication } from '@/application/stream/users/users';
import { getCommerceAdapterMode } from '@/config/commerce';
import { MESSAGING_COPY } from '@/libs/commerce/messaging-copy';
import { httpStatusCodeToError } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import { MESSAGING_STATUS_TIMEOUT_MS, MESSAGING_SYNC_PASS_TIMEOUT_MS } from '@/libs/messaging/pass-deadline';
import type { Pubky } from '@/models/models.types';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useMessagingStore } from '@/stores/messaging/messaging.store';
import { MessagingController } from './messaging';

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>()),
  getCommerceAdapterMode: vi.fn(() => 'unavailable'),
}));

const OWNER = 'o'.repeat(52) as Pubky;
const FOLLOWED = 'f'.repeat(52);
const FOLLOWER = 'g'.repeat(52);
const MUTUAL = 'm'.repeat(52);
const SELLER = 's'.repeat(52);

const commerceModeMock = vi.mocked(getCommerceAdapterMode);

function mockAuth(pubky: Pubky | null) {
  vi.spyOn(useAuthStore, 'getState').mockReturnValue({
    ...useAuthStore.getState(),
    currentUserPubky: pubky,
    selectCurrentUserPubky: () => {
      if (!pubky) throw new Error('No current user');
      return pubky;
    },
  });
}

/** Nexus serving each follow list by offset; an Error fails every read of that list. */
function mockFollowGraph(perReach: Record<'following' | 'followers', string[] | Error>) {
  return vi.spyOn(UserStreamApplication, 'fetchStreamIds').mockImplementation(async ({ streamId, skip = 0, limit }) => {
    const reach = String(streamId).endsWith(':following') ? 'following' : 'followers';
    const outcome = perReach[reach];
    if (outcome instanceof Error) throw outcome;
    return outcome.slice(skip, skip + limit) as Pubky[];
  });
}

const manyPubkys = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(3, '0')}`.padEnd(52, prefix));

describe('MessagingController inbox naming set', () => {
  let syncCounterpartiesSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    FirstContactApplication.clear();
    mockAuth(OWNER);
    commerceModeMock.mockReturnValue('unavailable');
    syncCounterpartiesSpy = vi.spyOn(MessagingApplication, 'syncCounterparties').mockResolvedValue();
    vi.spyOn(MessagingApplication, 'getUnreadConversationCount').mockResolvedValue(0);
    vi.spyOn(FirstContactApplication, 'discoverRequests').mockResolvedValue([]);
    vi.spyOn(FirstContactApplication, 'loadMutes').mockResolvedValue({ kind: 'ready', muted: new Set() });
    vi.spyOn(FirstContactApplication, 'promoteKnownRequests').mockResolvedValue();
  });

  it('names follows and followers, deduped, with the owner excluded', async () => {
    mockFollowGraph({ following: [FOLLOWED, MUTUAL, String(OWNER)], followers: [FOLLOWER, MUTUAL] });

    await MessagingController.syncInbox();

    expect(syncCounterpartiesSpy).toHaveBeenCalledOnce();
    const [owner, candidates] = syncCounterpartiesSpy.mock.calls[0];
    expect(owner).toBe(OWNER);
    expect([...(candidates as string[])].sort()).toEqual([FOLLOWED, FOLLOWER, MUTUAL].sort());
  });

  it('skips marketplace sources entirely when no durable commerce mode is configured', async () => {
    const ordersSpy = vi.spyOn(CommerceApplication, 'getMarketplaceOrders');
    const offersSpy = vi.spyOn(CommerceApplication, 'getMarketplaceOffers');
    mockFollowGraph({ following: [FOLLOWED], followers: [] });

    await MessagingController.syncInbox();

    expect(ordersSpy).not.toHaveBeenCalled();
    expect(offersSpy).not.toHaveBeenCalled();
    expect(syncCounterpartiesSpy).toHaveBeenCalledWith(OWNER, [FOLLOWED], expect.anything());
  });

  it('adds marketplace order/offer participants when the durable service is configured', async () => {
    commerceModeMock.mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'getMarketplaceOrders').mockResolvedValue([
      { buyerPubky: OWNER, sellerPubky: SELLER } as Awaited<
        ReturnType<typeof CommerceApplication.getMarketplaceOrders>
      >[number],
    ]);
    vi.spyOn(CommerceApplication, 'getMarketplaceOffers').mockResolvedValue([]);
    mockFollowGraph({ following: [FOLLOWED], followers: [] });

    await MessagingController.syncInbox();

    const [, candidates] = syncCounterpartiesSpy.mock.calls[0];
    expect([...(candidates as string[])].sort()).toEqual([FOLLOWED, SELLER].sort());
  });

  it('degrades to the remaining sources when one follow-graph read fails', async () => {
    mockFollowGraph({ following: new Error('nexus unreachable'), followers: [FOLLOWER] });

    await MessagingController.syncInbox();

    expect(syncCounterpartiesSpy).toHaveBeenCalledWith(OWNER, [FOLLOWER], expect.anything());
  });

  it('reads the next page of followers on each pass and starts over after the last one', async () => {
    const followers = manyPubkys('g', FIRST_CONTACT_FOLLOW_PAGE_SIZE + 5);
    mockFollowGraph({ following: [], followers });
    const discoverSpy = vi.mocked(FirstContactApplication.discoverRequests);

    await MessagingController.syncInbox();
    await MessagingController.syncInbox();
    await MessagingController.syncInbox();

    expect(discoverSpy.mock.calls.map(([, page]) => page)).toEqual([
      followers.slice(0, FIRST_CONTACT_FOLLOW_PAGE_SIZE),
      followers.slice(FIRST_CONTACT_FOLLOW_PAGE_SIZE),
      followers.slice(0, FIRST_CONTACT_FOLLOW_PAGE_SIZE),
    ]);
    expect(syncCounterpartiesSpy.mock.calls[1][1]).toEqual(followers.slice(FIRST_CONTACT_FOLLOW_PAGE_SIZE));
  });

  it('reads Nexus on every pass instead of the stream cache', async () => {
    const cacheSpy = vi.spyOn(UserStreamApplication, 'getOrFetchStreamSlice');
    const nexusSpy = mockFollowGraph({ following: [FOLLOWED], followers: [FOLLOWER] });

    await MessagingController.syncInbox();
    await MessagingController.syncInbox();

    expect(cacheSpy).not.toHaveBeenCalled();
    expect(nexusSpy).toHaveBeenCalledTimes(4);
  });

  it('starts the walk over when Nexus has nothing at the next offset', async () => {
    const followers = manyPubkys('g', FIRST_CONTACT_FOLLOW_PAGE_SIZE);
    vi.spyOn(UserStreamApplication, 'fetchStreamIds').mockImplementation(async ({ streamId, skip = 0, limit }) => {
      if (String(streamId).endsWith(':following')) return [];
      if (skip >= followers.length)
        throw httpStatusCodeToError(404, 'Not Found', ErrorService.Nexus, 'fetchNexus', 'followers');
      return followers.slice(skip, skip + limit) as Pubky[];
    });
    const discoverSpy = vi.mocked(FirstContactApplication.discoverRequests);

    await MessagingController.syncInbox();
    await MessagingController.syncInbox();
    await MessagingController.syncInbox();

    expect(discoverSpy.mock.calls.map(([, page]) => page.length)).toEqual([
      FIRST_CONTACT_FOLLOW_PAGE_SIZE,
      0,
      FIRST_CONTACT_FOLLOW_PAGE_SIZE,
    ]);
  });

  it('reads the same page again after a failed read', async () => {
    const followers = manyPubkys('g', FIRST_CONTACT_FOLLOW_PAGE_SIZE * 2);
    let failNext = false;
    const nexusSpy = vi
      .spyOn(UserStreamApplication, 'fetchStreamIds')
      .mockImplementation(async ({ streamId, skip = 0, limit }) => {
        if (String(streamId).endsWith(':following')) return [];
        if (failNext) {
          failNext = false;
          throw new Error('nexus unreachable');
        }
        return followers.slice(skip, skip + limit) as Pubky[];
      });

    await MessagingController.syncInbox();
    failNext = true;
    await MessagingController.syncInbox();
    await MessagingController.syncInbox();

    const followerSkips = nexusSpy.mock.calls
      .filter(([params]) => String(params.streamId).endsWith(':followers'))
      .map(([params]) => params.skip);
    expect(followerSkips).toEqual([0, FIRST_CONTACT_FOLLOW_PAGE_SIZE, FIRST_CONTACT_FOLLOW_PAGE_SIZE]);
  });

  it('keeps everyone the account follows known across the pages of a walk', async () => {
    const following = manyPubkys('f', FIRST_CONTACT_FOLLOW_PAGE_SIZE + 2);
    mockFollowGraph({ following, followers: [] });
    const knownSpy = vi.spyOn(FirstContactApplication, 'setKnownContacts');

    await MessagingController.syncInbox();
    await MessagingController.syncInbox();
    await MessagingController.syncInbox();

    const knownAfter = knownSpy.mock.calls.map(([, contacts]) => new Set(contacts.following));
    expect(knownAfter[0]).toEqual(new Set(following.slice(0, FIRST_CONTACT_FOLLOW_PAGE_SIZE)));
    expect(knownAfter[1]).toEqual(new Set(following));
    expect(knownAfter[2]).toEqual(new Set(following));
  });

  it('runs one pass for overlapping calls', async () => {
    mockFollowGraph({ following: [FOLLOWED], followers: [] });
    let release: () => void = () => undefined;
    syncCounterpartiesSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const first = MessagingController.syncInbox();
    const second = MessagingController.syncInbox();
    await vi.waitFor(() => expect(syncCounterpartiesSpy).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);

    expect(syncCounterpartiesSpy).toHaveBeenCalledOnce();
    syncCounterpartiesSpy.mockResolvedValue();
    await MessagingController.syncInbox();
    expect(syncCounterpartiesSpy).toHaveBeenCalledTimes(2);
  });

  it('lets a new pass start once a pass ran past its deadline', async () => {
    vi.useFakeTimers();
    try {
      mockFollowGraph({ following: [FOLLOWED], followers: [] });
      syncCounterpartiesSpy.mockImplementationOnce(() => new Promise<void>(() => undefined));

      const stuck = MessagingController.syncInbox();
      const timedOut = expect(stuck).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(MESSAGING_SYNC_PASS_TIMEOUT_MS);
      await timedOut;

      await MessagingController.syncInbox();
      expect(syncCounterpartiesSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the device-local unread fact into the store after the pass', async () => {
    vi.spyOn(MessagingApplication, 'getUnreadConversationCount').mockResolvedValue(3);
    mockFollowGraph({ following: [], followers: [] });

    await MessagingController.syncInbox();

    expect(useMessagingStore.getState().unreadConversations).toBe(3);
  });
});

describe('MessagingController unread and read-state facts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMessagingStore.getState().setUnreadConversations(0);
  });

  it('reports 0 unread and clears the store when signed out', async () => {
    mockAuth(null);
    useMessagingStore.getState().setUnreadConversations(5);
    const countSpy = vi.spyOn(MessagingApplication, 'getUnreadConversationCount');

    await expect(MessagingController.refreshUnreadCount()).resolves.toBe(0);

    expect(countSpy).not.toHaveBeenCalled();
    expect(useMessagingStore.getState().unreadConversations).toBe(0);
  });

  it('marks a conversation read and refreshes the unread fact', async () => {
    mockAuth(OWNER);
    const markSpy = vi.spyOn(MessagingApplication, 'markConversationRead').mockResolvedValue();
    vi.spyOn(MessagingApplication, 'getUnreadConversationCount').mockResolvedValue(1);

    await MessagingController.markConversationRead(`dm:${FOLLOWED}`);

    expect(markSpy).toHaveBeenCalledWith(OWNER, `dm:${FOLLOWED}`);
    expect(useMessagingStore.getState().unreadConversations).toBe(1);
  });

  // Regression: conversation ids contain a colon, which the commerce entityId
  // normalizer rejects — history reads must accept BOTH local id shapes.
  it('accepts both conversation id shapes and rejects anything else', async () => {
    mockAuth(OWNER);
    const getSpy = vi.spyOn(MessagingApplication, 'getConversationMessages').mockResolvedValue([]);
    const marketplaceId = `conversation:${SELLER}_${OWNER}_0033GVVN22HJ0FYQGZZS8R2BFC`;

    await expect(MessagingController.getConversationMessages(marketplaceId)).resolves.toEqual([]);
    await expect(MessagingController.getConversationMessages(`dm:${FOLLOWED}`)).resolves.toEqual([]);
    expect(getSpy).toHaveBeenCalledWith(OWNER, marketplaceId);
    expect(getSpy).toHaveBeenCalledWith(OWNER, `dm:${FOLLOWED}`);

    await expect(MessagingController.getConversationMessages('listing:not-a-conversation')).rejects.toThrow(
      /conversation id/,
    );
    await expect(MessagingController.getConversationMessages('dm:short')).rejects.toThrow(/conversation id/);
  });
});

describe('MessagingController listing conversation ownership', () => {
  const BUYER = 'b'.repeat(52);
  const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth(OWNER);
  });

  it('refuses a thread the signed-in account is not a party to, before anything is sent or queued', async () => {
    const sendSpy = vi.spyOn(MessagingApplication, 'sendOrQueueMessage');
    const openSpy = vi.spyOn(MessagingApplication, 'openConversation');

    await expect(MessagingController.sendOrQueueMessage(SELLER, BUYER, LISTING_ID, 'hello')).rejects.toThrow(
      /does not belong to the signed-in account/,
    );
    await expect(MessagingController.openConversation(SELLER, SELLER, LISTING_ID)).rejects.toThrow(
      /does not belong to the signed-in account/,
    );
    expect(sendSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('resolves the counterparty from the thread when the signed-in account is the buyer', async () => {
    vi.spyOn(FirstContactApplication, 'loadMutes').mockResolvedValue({ kind: 'ready', muted: new Set() });
    vi.spyOn(FirstContactApplication, 'prepareFirstContact').mockResolvedValue({ kind: 'ready', firstMessage: false });
    vi.spyOn(FirstContactApplication, 'accept').mockResolvedValue();
    const sendSpy = vi
      .spyOn(MessagingApplication, 'sendOrQueueMessage')
      .mockResolvedValue({ delivered: false } as Awaited<ReturnType<typeof MessagingApplication.sendOrQueueMessage>>);

    await MessagingController.sendOrQueueMessage(SELLER, OWNER, LISTING_ID, 'hello');

    expect(sendSpy).toHaveBeenCalledWith(
      OWNER,
      SELLER,
      {
        conversationId: `conversation:${SELLER}_${OWNER}_${LISTING_ID}`,
        listingRef: `listing:${SELLER}_${LISTING_ID}`,
        body: 'hello',
      },
      expect.objectContaining({ gate: expect.anything() }),
    );
  });
});

describe('MessagingController retry restarts', () => {
  const BUYER = 'b'.repeat(52);
  let restartSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockAuth(OWNER);
    restartSpy = vi.spyOn(MessagingApplication, 'restartRetries').mockReturnValue();
  });

  it('a listing conversation restarts the pair with the other party, from either side', () => {
    MessagingController.restartConversationRetries(OWNER, BUYER);
    MessagingController.restartConversationRetries(SELLER, OWNER);

    expect(restartSpy.mock.calls).toEqual([
      [OWNER, BUYER],
      [OWNER, SELLER],
    ]);
  });

  it('a listing conversation that is not the account’s, or is malformed, restarts nothing and never throws', () => {
    MessagingController.restartConversationRetries(SELLER, BUYER);
    MessagingController.restartConversationRetries(OWNER, 'not-a-pubky');
    MessagingController.restartConversationRetries(OWNER, OWNER);

    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('a DM restarts its pair; the account itself or a malformed pubky restarts nothing', () => {
    MessagingController.restartDmConversationRetries(BUYER);
    MessagingController.restartDmConversationRetries(OWNER);
    MessagingController.restartDmConversationRetries('not-a-pubky');

    expect(restartSpy.mock.calls).toEqual([[OWNER, BUYER]]);
  });

  it('the inbox restarts every pair of the signed-in account', () => {
    MessagingController.restartInboxRetries();

    expect(restartSpy.mock.calls).toEqual([[OWNER]]);
  });

  it('nothing restarts while signed out', () => {
    mockAuth(null);

    MessagingController.restartInboxRetries();
    MessagingController.restartDmConversationRetries(BUYER);
    MessagingController.restartConversationRetries(OWNER, BUYER);

    expect(restartSpy).not.toHaveBeenCalled();
  });
});

describe('MessagingController status read deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth(OWNER);
  });

  it('rejects with the delay copy once the read runs past its deadline, and the next read is answered', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      const status = vi
        .spyOn(MessagingApplication, 'getStatus')
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({ sessionActive: true, receiverProvisioned: true, ownKeyRepublished: null });

      const stuck = MessagingController.getMessagingStatus();
      let settled = false;
      void stuck.catch(() => undefined).finally(() => (settled = true));
      const timedOut = expect(stuck).rejects.toMatchObject({
        code: 'REQUEST_TIMEOUT',
        message: MESSAGING_COPY.statusTimeout,
      });
      await vi.advanceTimersByTimeAsync(MESSAGING_STATUS_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await timedOut;
      expect(Logger.warn).toHaveBeenCalledWith(expect.any(String), { reason: 'status_timeout' });

      await expect(MessagingController.getMessagingStatus()).resolves.toMatchObject({ sessionActive: true });
      expect(status).toHaveBeenCalledTimes(2);
      expect(status).toHaveBeenCalledWith(OWNER);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the republished-key notice of a read that settled after the deadline, and only then', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      const returned = vi.spyOn(MessagingApplication, 'returnOwnKeyRepublished').mockImplementation(() => {});
      let settleLate: (status: Awaited<ReturnType<typeof MessagingApplication.getStatus>>) => void = () => {};
      vi.spyOn(MessagingApplication, 'getStatus')
        .mockImplementationOnce(() => new Promise((resolve) => (settleLate = resolve)))
        .mockResolvedValueOnce({ sessionActive: true, receiverProvisioned: true, ownKeyRepublished: 'missing' });

      const late = MessagingController.getMessagingStatus();
      const timedOut = expect(late).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(MESSAGING_STATUS_TIMEOUT_MS);
      await timedOut;
      settleLate({ sessionActive: true, receiverProvisioned: true, ownKeyRepublished: 'replaced' });
      await vi.waitFor(() => expect(returned).toHaveBeenCalledWith(OWNER, 'replaced'));

      await expect(MessagingController.getMessagingStatus()).resolves.toMatchObject({ ownKeyRepublished: 'missing' });
      expect(returned).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
