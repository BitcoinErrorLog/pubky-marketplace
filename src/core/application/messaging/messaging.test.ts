import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceChatMessage } from '@/libs/commerce/messaging-contracts';
import { MARKETPLACE_CHAT_MESSAGE_KIND } from '@/libs/commerce/messaging-contracts';
import { PUBKY_APP_DM_KIND, type PubkyAppDmMessage } from '@/libs/messaging/dm-contracts';
import { MESSAGING_RETRY_POLICY } from '@/libs/messaging/retry-backoff';
import { CommerceMessagingConversationModel, CommerceMessagingOutboxModel } from '@/models/messaging/messaging.models';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import { type MessagingLinkState, PaykitMessagingService } from '@/services/paykit/paykit-messaging';
import { ADMIT_ALL_POLICY, policyMuting } from '@/test-utils/messaging-gate';
import { installWebLocks, removeWebLocks } from '@/test-utils/web-locks';
import {
  MESSAGING_SYNC_MAX_COUNTERPARTIES,
  MESSAGING_SYNC_MAX_RECOVERY_PROBES,
  MESSAGING_SYNC_RESERVED_NEW_PROBES,
  MessagingApplication,
} from './messaging';

// Every read and write of wrapped messaging state holds the key fence.
beforeEach(installWebLocks);
afterEach(removeWebLocks);

const advanceClock = (ms: number) => vi.setSystemTime(Date.now() + ms);

const OWNER = 'a'.repeat(52);
const OTHER_OWNER = 'b'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);
const CONVERSATION_ID = `conversation:${COUNTERPARTY}_${OWNER}_L1`;
const LISTING_REF = `listing:${COUNTERPARTY}_L1`;

const READY: MessagingLinkState = { status: 'ready' };
const HANDSHAKING: MessagingLinkState = { status: 'handshaking', role: 'initiator' };

function chatInput(body: string) {
  return { conversationId: CONVERSATION_ID, listingRef: LISTING_REF, body };
}

function chatMessage(body: string, eventId = crypto.randomUUID()): MarketplaceChatMessage {
  return {
    version: 1,
    kind: MARKETPLACE_CHAT_MESSAGE_KIND,
    event_id: eventId,
    conversation_id: CONVERSATION_ID,
    listing_ref: LISTING_REF,
    sent_at: 1_787_565_600_000,
    body,
  };
}

function dmMessage(body: string, eventId = crypto.randomUUID()): PubkyAppDmMessage {
  return { version: 1, kind: PUBKY_APP_DM_KIND, event_id: eventId, sent_at: 1_787_565_600_000, body };
}

function mockLinkState(state: MessagingLinkState) {
  return vi.spyOn(PaykitMessagingService, 'ensureLink').mockResolvedValue(state);
}

function mockChatSend() {
  return vi
    .spyOn(PaykitMessagingService, 'sendChatMessage')
    .mockImplementation(async (_owner, _counterparty, input) => chatMessage(input.body, input.eventId));
}

function mockDmSend() {
  return vi
    .spyOn(PaykitMessagingService, 'sendDmMessage')
    .mockImplementation(async (_owner, _counterparty, input) => dmMessage(input.body, input.eventId));
}

describe('MessagingApplication queued-message outbox', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    MessagingApplication.clearMessagingSession();
    await Promise.all([CommerceMessagingOutboxModel.clear(), CommerceMessagingConversationModel.clear()]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues the message device-locally while the link is still handshaking (nothing is sent)', async () => {
    mockLinkState(HANDSHAKING);
    const sendSpy = mockChatSend();

    const outcome = await MessagingApplication.sendOrQueueMessage(
      OWNER,
      COUNTERPARTY,
      chatInput('hold this'),
      ADMIT_ALL_POLICY,
    );

    expect(outcome.delivered).toBe(false);
    if (outcome.delivered) throw new Error('unreachable');
    expect(outcome.queued).toMatchObject({
      owner_pubky: OWNER,
      counterparty_pubky: COUNTERPARTY,
      kind: 'chat',
      conversation_id: CONVERSATION_ID,
      listing_ref: LISTING_REF,
      body: 'hold this',
      attempts: 0,
      last_error: null,
    });
    expect(sendSpy).not.toHaveBeenCalled();
    const rows = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
    expect(rows).toHaveLength(1);
  });

  it('rejects an oversized body at queue time with the same error a live send throws', async () => {
    mockLinkState(HANDSHAKING);
    const sendSpy = mockChatSend();

    await expect(
      MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('x'.repeat(2000)), ADMIT_ALL_POLICY),
    ).rejects.toThrow(/Message is too long/);

    expect(sendSpy).not.toHaveBeenCalled();
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('refuses to queue a listing message into a thread that does not name the counterparty', async () => {
    mockLinkState(HANDSHAKING);
    const sendSpy = mockChatSend();

    await expect(
      MessagingApplication.sendOrQueueMessage(
        OWNER,
        OTHER_OWNER,
        chatInput('meant for someone else'),
        ADMIT_ALL_POLICY,
      ),
    ).rejects.toThrow(/not between you and the person you are messaging/);

    expect(sendSpy).not.toHaveBeenCalled();
    await expect(LocalMessagingService.getQueuedMessages(OWNER, OTHER_OWNER)).resolves.toHaveLength(0);
  });

  it('sends directly — no outbox row — when the link is ready', async () => {
    mockLinkState(READY);
    const sendSpy = mockChatSend();

    const outcome = await MessagingApplication.sendOrQueueMessage(
      OWNER,
      COUNTERPARTY,
      chatInput('live send'),
      ADMIT_ALL_POLICY,
    );

    expect(outcome.delivered).toBe(true);
    if (!outcome.delivered) throw new Error('unreachable');
    expect(outcome.message.body).toBe('live send');
    expect(sendSpy).toHaveBeenCalledOnce();
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('queues DM sends while pending and flushes them through the real DM send method', async () => {
    mockLinkState(HANDSHAKING);
    const dmSpy = mockDmSend();

    const outcome = await MessagingApplication.sendOrQueueDmMessage(
      OWNER,
      COUNTERPARTY,
      'dm in waiting',
      ADMIT_ALL_POLICY,
    );
    expect(outcome.delivered).toBe(false);
    if (outcome.delivered) throw new Error('unreachable');
    expect(outcome.queued).toMatchObject({ kind: 'dm', conversation_id: null, listing_ref: null });

    const result = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);
    expect(result).toEqual({ delivered: 1, remaining: 0 });
    expect(dmSpy).toHaveBeenCalledWith(OWNER, COUNTERPARTY, { body: 'dm in waiting', eventId: outcome.queued.id });
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('flushes queued rows in queue order and deletes each only after its send succeeded', async () => {
    mockLinkState(HANDSHAKING);
    const queued: string[] = [];
    for (const body of ['first', 'second', 'third']) {
      const outcome = await MessagingApplication.sendOrQueueMessage(
        OWNER,
        COUNTERPARTY,
        chatInput(body),
        ADMIT_ALL_POLICY,
      );
      if (outcome.delivered) throw new Error('unreachable');
      queued.push(outcome.queued.id);
    }
    const sendSpy = mockChatSend();

    const result = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);

    expect(result).toEqual({ delivered: 3, remaining: 0 });
    expect(sendSpy.mock.calls.map(([, , input]) => input.body)).toEqual(['first', 'second', 'third']);
    // The queue-time UUID rode along as the envelope event id (idempotent replay).
    expect(sendSpy.mock.calls.map(([, , input]) => input.eventId)).toEqual(queued);
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('stops at the first failed send, records the error, and a later flush resumes from that row', async () => {
    mockLinkState(HANDSHAKING);
    for (const body of ['first', 'second', 'third']) {
      await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput(body), ADMIT_ALL_POLICY);
    }
    const sendSpy = vi
      .spyOn(PaykitMessagingService, 'sendChatMessage')
      .mockImplementationOnce(async (_owner, _counterparty, input) => chatMessage(input.body, input.eventId))
      .mockRejectedValueOnce(new Error('homeserver write failed'));

    const firstPass = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);

    expect(firstPass).toEqual({ delivered: 1, remaining: 2 });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    const remaining = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
    expect(remaining.map(({ body }) => body)).toEqual(['second', 'third']);
    expect(remaining[0]).toMatchObject({ attempts: 1, last_error: 'homeserver write failed' });
    expect(remaining[0].last_attempt_at).not.toBeNull();
    // The row behind the failure was never attempted — order is preserved.
    expect(remaining[1]).toMatchObject({ attempts: 0, last_error: null });

    const resendSpy = mockChatSend();
    const callsBefore = resendSpy.mock.calls.length;
    advanceClock(2_000);
    await expect(MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY)).resolves.toEqual({
      delivered: 0,
      remaining: 2,
    });
    expect(resendSpy.mock.calls.length).toBe(callsBefore);

    advanceClock(MESSAGING_RETRY_POLICY.baseMs);
    const secondPass = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);
    expect(secondPass).toEqual({ delivered: 2, remaining: 0 });
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('two concurrent flushes share one pass — every message is sent exactly once', async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('only once'), ADMIT_ALL_POLICY);
    let releaseSend!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendSpy = vi
      .spyOn(PaykitMessagingService, 'sendChatMessage')
      .mockImplementation(async (_owner, _counterparty, input) => {
        await gate;
        return chatMessage(input.body, input.eventId);
      });

    const firstFlush = MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);
    const secondFlush = MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);
    releaseSend();
    const [first, second] = await Promise.all([firstFlush, secondFlush]);

    expect(first).toEqual({ delivered: 1, remaining: 0 });
    expect(second).toEqual({ delivered: 1, remaining: 0 });
    expect(sendSpy).toHaveBeenCalledOnce();
  });

  it('cancelQueuedMessage removes a still-queued row', async () => {
    mockLinkState(HANDSHAKING);
    const outcome = await MessagingApplication.sendOrQueueMessage(
      OWNER,
      COUNTERPARTY,
      chatInput('changed my mind'),
      ADMIT_ALL_POLICY,
    );
    if (outcome.delivered) throw new Error('unreachable');

    await MessagingApplication.cancelQueuedMessage(OWNER, outcome.queued.id);

    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it("one owner's flush never touches another owner's rows toward the same counterparty", async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('owner A message'), ADMIT_ALL_POLICY);
    await MessagingApplication.sendOrQueueDmMessage(OTHER_OWNER, COUNTERPARTY, 'owner B message', ADMIT_ALL_POLICY);
    const chatSpy = mockChatSend();
    const dmSpy = mockDmSend();

    const result = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);

    expect(result).toEqual({ delivered: 1, remaining: 0 });
    expect(chatSpy).toHaveBeenCalledOnce();
    expect(chatSpy).toHaveBeenCalledWith(OWNER, COUNTERPARTY, expect.objectContaining({ body: 'owner A message' }));
    expect(dmSpy).not.toHaveBeenCalled();
    const otherRows = await LocalMessagingService.getQueuedMessages(OTHER_OWNER, COUNTERPARTY);
    expect(otherRows.map(({ body }) => body)).toEqual(['owner B message']);
  });

  it('queues behind older stuck rows even when the link is ready, so thread order never lies', async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('stuck first'), ADMIT_ALL_POLICY);
    mockLinkState(READY);
    vi.spyOn(PaykitMessagingService, 'sendChatMessage').mockRejectedValue(new Error('still failing'));

    const outcome = await MessagingApplication.sendOrQueueMessage(
      OWNER,
      COUNTERPARTY,
      chatInput('composed later'),
      ADMIT_ALL_POLICY,
    );

    expect(outcome.delivered).toBe(false);
    const rows = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
    expect(rows.map(({ body }) => body)).toEqual(['stuck first', 'composed later']);
  });

  it('pollConversation flushes queued rows the moment the link reports ready', async () => {
    mockLinkState(READY);
    vi.spyOn(PaykitMessagingService, 'receiveMessages').mockResolvedValue([]);
    const flushSpy = vi.spyOn(MessagingApplication, 'flushOutbox');
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('poll delivers me'), ADMIT_ALL_POLICY);
    mockLinkState(READY);
    mockChatSend();

    const { state, flushed } = await MessagingApplication.pollConversation(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);

    expect(state).toEqual(READY);
    expect(flushed).toBe(1);
    expect(flushSpy).toHaveBeenCalledWith(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('pollConversation does not flush while the handshake is still pending', async () => {
    mockLinkState(HANDSHAKING);
    const flushSpy = vi.spyOn(MessagingApplication, 'flushOutbox');

    const { flushed } = await MessagingApplication.pollConversation(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);

    expect(flushed).toBe(0);
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('opening a conversation (listing or DM) flushes when it finds the link already ready', async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('open delivers me'), ADMIT_ALL_POLICY);
    mockLinkState(READY);
    mockChatSend();
    await MessagingApplication.openConversation(OWNER, COUNTERPARTY, CONVERSATION_ID, LISTING_REF, ADMIT_ALL_POLICY);
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);

    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'dm open delivers me', ADMIT_ALL_POLICY);
    mockLinkState(READY);
    mockDmSend();
    await MessagingApplication.openDmConversation(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('syncCounterparties flushes per counterparty that reaches ready, before receiving', async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'sync delivers me', ADMIT_ALL_POLICY);
    vi.spyOn(PaykitMessagingService, 'probeCounterparty').mockResolvedValue(READY);
    vi.spyOn(PaykitMessagingService, 'receiveMessages').mockResolvedValue([]);
    mockDmSend();

    await MessagingApplication.syncCounterparties(OWNER, [COUNTERPARTY], { policy: ADMIT_ALL_POLICY });

    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('getConversations exposes the newest queued row so previews can say "Queued"', async () => {
    await LocalMessagingService.touchConversation({
      owner_id: OWNER,
      conversation_id: CONVERSATION_ID,
      kind: 'listing',
      listing_ref: LISTING_REF,
      counterparty_pubky: COUNTERPARTY,
      last_message_at: null,
      updated_at: 100,
    });
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(
      OWNER,
      COUNTERPARTY,
      chatInput('newest and queued'),
      ADMIT_ALL_POLICY,
    );

    const [summary] = await MessagingApplication.getConversations(OWNER);

    expect(summary.lastMessage).toBeNull();
    expect(summary.lastQueued).toMatchObject({ body: 'newest and queued', kind: 'chat' });
  });
});

describe('MessagingApplication retry spacing', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    MessagingApplication.clearMessagingSession();
    await Promise.all([CommerceMessagingOutboxModel.clear(), CommerceMessagingConversationModel.clear()]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a failing queued send on a capped exponential schedule, not on every 2 s poll', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('keeps failing'), ADMIT_ALL_POLICY);
    const sendSpy = vi.spyOn(PaykitMessagingService, 'sendChatMessage').mockRejectedValue(new Error('write failed'));

    for (let elapsed = 0; elapsed <= 30 * 60_000; elapsed += 2_000) {
      await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);
      advanceClock(2_000);
    }

    expect(sendSpy.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(sendSpy.mock.calls.length).toBeLessThanOrEqual(12);
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(1);
  });

  it("a failing pair never delays another pair's flush", async () => {
    const HEALTHY = 'h'.repeat(52);
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'stuck', ADMIT_ALL_POLICY);
    await MessagingApplication.sendOrQueueDmMessage(OWNER, HEALTHY, 'fine', ADMIT_ALL_POLICY);
    vi.spyOn(PaykitMessagingService, 'sendDmMessage').mockImplementation(async (_owner, counterparty, input) => {
      if (counterparty === COUNTERPARTY) throw new Error('write failed');
      return dmMessage(input.body, input.eventId);
    });

    await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);
    await expect(MessagingApplication.flushOutbox(OWNER, HEALTHY, ADMIT_ALL_POLICY)).resolves.toEqual({
      delivered: 1,
      remaining: 0,
    });
  });

  it('keeps retries out of the healthy sync budget and runs at most the capped number of due retries per pass', async () => {
    const healthy = Array.from({ length: MESSAGING_SYNC_MAX_COUNTERPARTIES }, (_, index) =>
      `h${String(index).padStart(2, '0')}`.padEnd(52, 'x'),
    );
    const due = Array.from({ length: 25 }, (_, index) => `d${String(index).padStart(2, '0')}`.padEnd(52, 'x'));
    const waiting = Array.from({ length: 5 }, (_, index) => `w${String(index).padStart(2, '0')}`.padEnd(52, 'x'));
    vi.spyOn(PaykitMessagingService, 'linkRetryStatus').mockImplementation((_owner, counterparty) => {
      if (due.includes(counterparty)) return 'due';
      if (waiting.includes(counterparty)) return 'waiting';
      return 'none';
    });
    const probeSpy = vi.spyOn(PaykitMessagingService, 'probeCounterparty').mockResolvedValue(READY);
    const receiveSpy = vi.spyOn(PaykitMessagingService, 'receiveMessages').mockResolvedValue([]);

    await MessagingApplication.syncCounterparties(OWNER, [...due, ...waiting, ...healthy], {
      policy: ADMIT_ALL_POLICY,
    });

    const probed = probeSpy.mock.calls.map(([, counterparty]) => counterparty);
    expect(probed.slice(0, healthy.length)).toEqual(healthy);
    expect(probed.slice(healthy.length)).toEqual(due.slice(0, MESSAGING_SYNC_MAX_RECOVERY_PROBES));
    expect(probed.some((counterparty) => waiting.includes(counterparty))).toBe(false);
    expect(receiveSpy.mock.calls.map(([, counterparty]) => counterparty).slice(0, healthy.length)).toEqual(healthy);
  });
});

describe('MessagingApplication probe budget', () => {
  const pubkyFor = (prefix: string, index: number) => `${prefix}${String(index).padStart(2, '0')}`.padEnd(52, 'x');

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    MessagingApplication.clearMessagingSession();
    await Promise.all([CommerceMessagingOutboxModel.clear(), CommerceMessagingConversationModel.clear()]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function seedExisting(count: number) {
    const existing = Array.from({ length: count }, (_, index) => pubkyFor('e', index));
    for (const [index, counterparty] of existing.entries()) {
      await LocalMessagingService.touchConversation({
        owner_id: OWNER,
        conversation_id: `dm:${counterparty}`,
        kind: 'dm',
        listing_ref: null,
        counterparty_pubky: counterparty,
        last_message_at: 1_000 + index,
        updated_at: 1_000 + index,
      });
    }
    return existing;
  }

  it('still probes a new follower when 30 existing counterparties would fill the budget', async () => {
    const existing = await seedExisting(30);
    const follower = 'f'.repeat(52);
    const probeSpy = vi.spyOn(PaykitMessagingService, 'probeCounterparty').mockResolvedValue({ status: 'none' });

    await MessagingApplication.syncCounterparties(OWNER, [follower], { policy: ADMIT_ALL_POLICY });

    const probed = probeSpy.mock.calls.map(([, counterparty]) => counterparty);
    expect(probed).toHaveLength(MESSAGING_SYNC_MAX_COUNTERPARTIES);
    expect(probed).toContain(follower);
    // Existing counterparties go most recent first.
    expect(probed.slice(0, 3)).toEqual([existing[29], existing[28], existing[27]]);
  });

  it(`keeps ${MESSAGING_SYNC_RESERVED_NEW_PROBES} slots for new people, request senders first`, async () => {
    await seedExisting(30);
    const followers = Array.from({ length: 20 }, (_, index) => pubkyFor('g', index));
    const requester = 'q'.repeat(52);
    const probeSpy = vi.spyOn(PaykitMessagingService, 'probeCounterparty').mockResolvedValue({ status: 'none' });

    await MessagingApplication.syncCounterparties(OWNER, followers, {
      priorityPubkys: [requester],
      policy: ADMIT_ALL_POLICY,
    });

    const probed = probeSpy.mock.calls.map(([, counterparty]) => counterparty);
    const fresh = probed.filter((counterparty) => !counterparty.startsWith('e'));
    expect(fresh).toHaveLength(MESSAGING_SYNC_RESERVED_NEW_PROBES);
    expect(fresh[0]).toBe(requester);
  });

  it('never probes, flushes toward or receives from a muted person', async () => {
    const [muted, other] = await seedExisting(2);
    const probeSpy = vi.spyOn(PaykitMessagingService, 'probeCounterparty').mockResolvedValue(READY);
    const receiveSpy = vi.spyOn(PaykitMessagingService, 'receiveMessages').mockResolvedValue([]);

    await MessagingApplication.syncCounterparties(OWNER, [muted], { policy: policyMuting(muted) });

    expect(probeSpy.mock.calls.map(([, counterparty]) => counterparty)).toEqual([other]);
    expect(receiveSpy.mock.calls.map(([, counterparty]) => counterparty)).toEqual([other]);
  });

  it('refuses every contact with a muted person on its own, whatever the caller checked', async () => {
    const ensureSpy = mockLinkState(READY);
    const sendSpy = mockChatSend();
    const policy = policyMuting(COUNTERPARTY);

    await expect(
      MessagingApplication.openConversation(OWNER, COUNTERPARTY, CONVERSATION_ID, LISTING_REF, policy),
    ).rejects.toThrow(/muted/);
    await expect(MessagingApplication.openDmConversation(OWNER, COUNTERPARTY, policy)).rejects.toThrow(/muted/);
    await expect(MessagingApplication.pollConversation(OWNER, COUNTERPARTY, policy)).rejects.toThrow(/muted/);
    await expect(MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('x'), policy)).rejects.toThrow(
      /muted/,
    );
    await expect(MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'x', policy)).rejects.toThrow(/muted/);

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('keeps messages queued toward a muted person instead of sending them', async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(
      OWNER,
      COUNTERPARTY,
      chatInput('queued before the mute'),
      ADMIT_ALL_POLICY,
    );
    const sendSpy = mockChatSend();

    await expect(MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, policyMuting(COUNTERPARTY))).resolves.toEqual({
      delivered: 0,
      remaining: 1,
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
