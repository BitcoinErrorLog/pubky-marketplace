import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dropCachedWrappingKeyForTests,
  getOrCreateWrappingKey,
  resetMessagingKeyringForTests,
} from '@/libs/crypto/messaging-keyring';
import { buildWrapAad, unwrapPayload, WRAP_IV_BYTES, WRAP_VERSION_AES_GCM_256 } from '@/libs/crypto/secret-wrapping';
import { isAppError } from '@/libs/error/error';
import {
  CommerceMessagingConversationModel,
  CommerceMessagingLinkModel,
  CommerceMessagingMessageModel,
  CommerceMessagingOutboxModel,
  CommerceMessagingReceiverModel,
} from '@/models/messaging/messaging.models';
import type {
  CommerceMessagingMessageModelSchema,
  CommerceMessagingOutboxModelSchema,
} from '@/models/messaging/messaging.schema';
import { asInvalid } from '@/test-utils/type-assertions';
import { installWebLocks, removeWebLocks } from '@/test-utils/web-locks';
import { LocalMessagingService } from './messaging';

// Every read and write of wrapped messaging state holds the key fence.
beforeEach(installWebLocks);
afterEach(removeWebLocks);

const OWNER = 'a'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);
const CONVERSATION_ID = `conversation:${COUNTERPARTY}_${OWNER}_L1`;

function messageRow(eventSuffix: string, recordedAt: number) {
  return {
    owner_id: OWNER,
    conversation_id: CONVERSATION_ID,
    listing_ref: `listing:${COUNTERPARTY}:L1`,
    counterparty_pubky: COUNTERPARTY,
    direction: 'received' as const,
    body: `message ${eventSuffix}`,
    sent_at: 1_787_306_400_000,
    recorded_at: recordedAt,
  };
}

function outboxRow(overrides: Partial<CommerceMessagingOutboxModelSchema> = {}): CommerceMessagingOutboxModelSchema {
  return {
    id: crypto.randomUUID(),
    owner_pubky: OWNER,
    counterparty_pubky: COUNTERPARTY,
    kind: 'chat',
    conversation_id: CONVERSATION_ID,
    listing_ref: `listing:${COUNTERPARTY}:L1`,
    body: 'queued body',
    queued_at: 100,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    ...overrides,
  };
}

describe('LocalMessagingService', () => {
  beforeEach(async () => {
    await Promise.all([
      CommerceMessagingReceiverModel.clear(),
      CommerceMessagingLinkModel.clear(),
      CommerceMessagingConversationModel.clear(),
      CommerceMessagingMessageModel.clear(),
      CommerceMessagingOutboxModel.clear(),
    ]);
    await resetMessagingKeyringForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores one receiver per account keyed by pubky', async () => {
    await LocalMessagingService.upsertReceiver({
      id: OWNER,
      noise_secret: new Uint8Array(32).fill(7),
      noise_public_key: 'n'.repeat(52),
      receiver_path: 'marketplace/wallet',
      marker_published: true,
      created_at: 1,
      updated_at: 1,
    });
    const receiver = await LocalMessagingService.getReceiver(OWNER);
    // Spread: structured clone returns a different-realm Uint8Array.
    expect([...(receiver?.noise_secret ?? [])]).toEqual([...new Uint8Array(32).fill(7)]);
    await expect(LocalMessagingService.getReceiver(COUNTERPARTY)).resolves.toBeNull();
  });

  it('dedupes replayed messages by event id (idempotent upsert)', async () => {
    const eventId = crypto.randomUUID();
    await LocalMessagingService.upsertMessage(eventId, messageRow('one', 10));
    await LocalMessagingService.upsertMessage(eventId, messageRow('one-replayed', 20));
    const messages = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('message one-replayed');
  });

  it('returns conversation messages in recorded order', async () => {
    await LocalMessagingService.upsertMessage(crypto.randomUUID(), messageRow('late', 30));
    await LocalMessagingService.upsertMessage(crypto.randomUUID(), messageRow('early', 10));
    const messages = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
    expect(messages.map(({ body }) => body)).toEqual(['message early', 'message late']);
  });

  it('normalizes legacy ISO sent_at values when reading persisted messages', async () => {
    const sentAt = '2026-08-21T10:00:00.000Z';
    await CommerceMessagingMessageModel.table.add({
      id: `${OWNER}:legacy`,
      ...messageRow('legacy', 10),
      sent_at: asInvalid<number>(sentAt),
    });

    const messages = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);

    expect(messages[0].sent_at).toBe(Date.parse(sentAt));
    expect(typeof messages[0].sent_at).toBe('number');
  });

  it('touchConversation creates once and only moves timestamps forward', async () => {
    await LocalMessagingService.touchConversation({
      owner_id: OWNER,
      conversation_id: CONVERSATION_ID,
      kind: 'listing',
      listing_ref: `listing:${COUNTERPARTY}:L1`,
      counterparty_pubky: COUNTERPARTY,
      last_message_at: 100,
      updated_at: 100,
    });
    // An older touch (out-of-order replay) must not regress the row.
    await LocalMessagingService.touchConversation({
      owner_id: OWNER,
      conversation_id: CONVERSATION_ID,
      kind: 'listing',
      listing_ref: `listing:${COUNTERPARTY}:L1`,
      counterparty_pubky: COUNTERPARTY,
      last_message_at: 50,
      updated_at: 50,
    });
    const conversations = await LocalMessagingService.getConversationsByOwner(OWNER);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].last_message_at).toBe(100);
    expect(conversations[0].updated_at).toBe(100);
    expect(conversations[0].created_at).toBe(100);
    // New rows start unread: the checkpoint belongs to markConversationRead.
    expect(conversations[0].last_read_at).toBeNull();
  });

  it('stores a dm conversation with no listing ref alongside a listing conversation', async () => {
    await LocalMessagingService.touchConversation({
      owner_id: OWNER,
      conversation_id: `dm:${COUNTERPARTY}`,
      kind: 'dm',
      listing_ref: null,
      counterparty_pubky: COUNTERPARTY,
      last_message_at: 10,
      updated_at: 10,
    });
    await LocalMessagingService.touchConversation({
      owner_id: OWNER,
      conversation_id: CONVERSATION_ID,
      kind: 'listing',
      listing_ref: `listing:${COUNTERPARTY}:L1`,
      counterparty_pubky: COUNTERPARTY,
      last_message_at: 20,
      updated_at: 20,
    });
    const conversations = await LocalMessagingService.getConversationsByOwner(OWNER);
    expect(conversations).toHaveLength(2);
    const dm = conversations.find(({ kind }) => kind === 'dm');
    expect(dm).toMatchObject({ conversation_id: `dm:${COUNTERPARTY}`, listing_ref: null });
  });

  it('markConversationRead moves the checkpoint forward only, and ignores unknown rows', async () => {
    // Unknown conversation: a no-op, never an implicit row.
    await LocalMessagingService.markConversationRead(OWNER, CONVERSATION_ID, 100);
    await expect(LocalMessagingService.getConversation(OWNER, CONVERSATION_ID)).resolves.toBeNull();

    await LocalMessagingService.touchConversation({
      owner_id: OWNER,
      conversation_id: CONVERSATION_ID,
      kind: 'listing',
      listing_ref: `listing:${COUNTERPARTY}:L1`,
      counterparty_pubky: COUNTERPARTY,
      last_message_at: 100,
      updated_at: 100,
    });
    await LocalMessagingService.markConversationRead(OWNER, CONVERSATION_ID, 200);
    // A stale (older) mark must not move the checkpoint backward.
    await LocalMessagingService.markConversationRead(OWNER, CONVERSATION_ID, 150);
    const conversation = await LocalMessagingService.getConversation(OWNER, CONVERSATION_ID);
    expect(conversation?.last_read_at).toBe(200);
  });

  it('counts unread conversations from RECEIVED messages after the checkpoint only', async () => {
    await LocalMessagingService.touchConversation({
      owner_id: OWNER,
      conversation_id: CONVERSATION_ID,
      kind: 'listing',
      listing_ref: `listing:${COUNTERPARTY}:L1`,
      counterparty_pubky: COUNTERPARTY,
      last_message_at: 100,
      updated_at: 100,
    });
    // A conversation with only SENT messages is never unread.
    await LocalMessagingService.upsertMessage(crypto.randomUUID(), {
      ...messageRow('mine', 100),
      direction: 'sent',
    });
    await expect(LocalMessagingService.countUnreadConversations(OWNER)).resolves.toBe(0);

    await LocalMessagingService.upsertMessage(crypto.randomUUID(), messageRow('theirs', 120));
    await expect(LocalMessagingService.countUnreadConversations(OWNER)).resolves.toBe(1);

    await LocalMessagingService.markConversationRead(OWNER, CONVERSATION_ID, 120);
    await expect(LocalMessagingService.countUnreadConversations(OWNER)).resolves.toBe(0);

    // A later received message flips it back to unread.
    await LocalMessagingService.upsertMessage(crypto.randomUUID(), messageRow('newer', 140));
    await expect(LocalMessagingService.countUnreadConversations(OWNER)).resolves.toBe(1);
  });

  it('updateLinkSnapshot refuses to write without an existing row', async () => {
    await expect(
      LocalMessagingService.updateLinkSnapshot(OWNER, COUNTERPARTY, new Uint8Array([1]), 'established', 1),
    ).rejects.toThrow(/No messaging link row/);
  });

  it('returns queued outbox rows toward a counterparty in queue order', async () => {
    await LocalMessagingService.enqueueOutboxMessage(outboxRow({ body: 'second', queued_at: 200 }));
    await LocalMessagingService.enqueueOutboxMessage(outboxRow({ body: 'first', queued_at: 100 }));
    // Another counterparty's row never leaks into this pair's queue.
    await LocalMessagingService.enqueueOutboxMessage(outboxRow({ counterparty_pubky: 'y'.repeat(52), queued_at: 50 }));
    const rows = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
    expect(rows.map(({ body }) => body)).toEqual(['first', 'second']);
  });

  it('scopes queued rows to their owner account', async () => {
    await LocalMessagingService.enqueueOutboxMessage(outboxRow({ body: 'mine' }));
    await LocalMessagingService.enqueueOutboxMessage(outboxRow({ owner_pubky: COUNTERPARTY, body: 'theirs' }));
    const mine = await LocalMessagingService.getQueuedMessagesByOwner(OWNER);
    expect(mine.map(({ body }) => body)).toEqual(['mine']);
  });

  it('records a failed flush attempt without touching the queued body', async () => {
    const row = outboxRow();
    await LocalMessagingService.enqueueOutboxMessage(row);
    await LocalMessagingService.recordOutboxFailure(OWNER, row.id, 'link dropped', 500);
    const [stored] = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
    expect(stored).toMatchObject({
      body: 'queued body',
      attempts: 1,
      last_attempt_at: 500,
      last_error: 'link dropped',
    });
  });

  it('deletes queued rows only for their owner (account isolation)', async () => {
    const row = outboxRow();
    await LocalMessagingService.enqueueOutboxMessage(row);
    // A different account can neither delete nor mutate the row.
    await LocalMessagingService.deleteOutboxMessage(COUNTERPARTY, row.id);
    await LocalMessagingService.recordOutboxFailure(COUNTERPARTY, row.id, 'not yours', 1);
    let rows = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
    expect(rows).toHaveLength(1);
    expect(rows[0].last_error).toBeNull();
    await LocalMessagingService.deleteOutboxMessage(OWNER, row.id);
    rows = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
    expect(rows).toHaveLength(0);
  });

  it('persists and updates link rows keyed by owner and counterparty', async () => {
    await LocalMessagingService.upsertLink({
      owner_id: OWNER,
      counterparty_pubky: COUNTERPARTY,
      role: 'initiator',
      status: 'handshaking',
      local_receiver_path: 'marketplace/wallet',
      remote_receiver_path: 'marketplace/wallet',
      remote_noise_public_key: 'p'.repeat(52),
      snapshot: new Uint8Array([1, 2]),
      created_at: 1,
      updated_at: 1,
    });
    await LocalMessagingService.updateLinkSnapshot(OWNER, COUNTERPARTY, new Uint8Array([3, 4]), 'established', 2);
    const link = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
    expect(link).toMatchObject({ status: 'established', updated_at: 2 });
    expect([...(link?.snapshot ?? [])]).toEqual([3, 4]);
  });

  describe('at-rest wrapping of key material', () => {
    function receiverRow() {
      return {
        id: OWNER,
        noise_secret: new Uint8Array(32).fill(7),
        noise_public_key: 'n'.repeat(52),
        receiver_path: 'marketplace/wallet',
        marker_published: true,
        created_at: 1,
        updated_at: 1,
      };
    }

    function linkRow() {
      return {
        owner_id: OWNER,
        counterparty_pubky: COUNTERPARTY,
        role: 'initiator' as const,
        status: 'handshaking' as const,
        local_receiver_path: 'marketplace/wallet',
        remote_receiver_path: 'marketplace/wallet',
        remote_noise_public_key: 'p'.repeat(52),
        snapshot: new Uint8Array([1, 2]),
        created_at: 1,
        updated_at: 1,
      };
    }

    it('stores receiver secrets wrapped (never plaintext) and unwraps them on read', async () => {
      await LocalMessagingService.upsertReceiver(receiverRow());

      const raw = await CommerceMessagingReceiverModel.findById(OWNER);
      expect(raw?.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
      expect(raw?.noise_secret.byteLength).toBe(WRAP_IV_BYTES + 32 + 16);
      expect([...(raw?.noise_secret ?? [])]).not.toEqual([...new Uint8Array(32).fill(7)]);

      const read = await LocalMessagingService.getReceiver(OWNER);
      expect([...(read?.noise_secret ?? [])]).toEqual([...new Uint8Array(32).fill(7)]);
    });

    it('stores link snapshots wrapped (never plaintext) and unwraps them on read', async () => {
      await LocalMessagingService.upsertLink(linkRow());

      const raw = await CommerceMessagingLinkModel.findById(`${OWNER}:${COUNTERPARTY}`);
      expect(raw?.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
      expect([...(raw?.snapshot ?? [])]).not.toEqual([1, 2]);

      const read = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect([...(read?.snapshot ?? [])]).toEqual([1, 2]);
    });

    it('binds ciphertexts to their row id: a transplanted receiver secret reads as lost, not as the secret', async () => {
      await LocalMessagingService.upsertReceiver(receiverRow());
      const raw = await CommerceMessagingReceiverModel.findById(OWNER);

      // Transplant the wrapped bytes into a DIFFERENT row id (AAD mismatch).
      const other = 'b'.repeat(52);
      await CommerceMessagingReceiverModel.upsert({ ...receiverRow(), ...raw, id: other });

      await expect(LocalMessagingService.getReceiver(other)).resolves.toBeNull();
      // The original row still unwraps fine.
      await expect(LocalMessagingService.getReceiver(OWNER)).resolves.toMatchObject({ marker_published: true });
    });

    it('treats a tampered link snapshot as lost: getLink null, getLinksByOwner skips it', async () => {
      await LocalMessagingService.upsertLink(linkRow());
      const raw = await CommerceMessagingLinkModel.findById(`${OWNER}:${COUNTERPARTY}`);
      const tampered = new Uint8Array(raw!.snapshot);
      tampered[tampered.byteLength - 1] ^= 0xff;
      await CommerceMessagingLinkModel.upsert({ ...raw!, snapshot: tampered });

      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toBeNull();
      await expect(LocalMessagingService.getLinksByOwner(OWNER)).resolves.toHaveLength(0);
    });

    it('still reads legacy plaintext rows (wrap_version absent) until the migration wraps them', async () => {
      // Written directly through the model, as the pre-5 build did.
      await CommerceMessagingReceiverModel.upsert(receiverRow());
      const read = await LocalMessagingService.getReceiver(OWNER);
      expect([...(read?.noise_secret ?? [])]).toEqual([...new Uint8Array(32).fill(7)]);
    });

    it('treats a receiver with an unknown wrap_version as lost, never as plaintext key material', async () => {
      // A corrupted/future wrap_version (e.g. 2) must NOT feed its bytes into
      // the Noise binding as a plaintext secret — the row reads as lost.
      await CommerceMessagingReceiverModel.upsert({ ...receiverRow(), wrap_version: 2 });
      await expect(LocalMessagingService.getReceiver(OWNER)).resolves.toBeNull();
    });

    it('treats a link with an unknown wrap_version as lost: getLink null, getLinksByOwner skips it', async () => {
      await CommerceMessagingLinkModel.upsert({
        ...linkRow(),
        id: `${OWNER}:${COUNTERPARTY}`,
        wrap_version: 2,
      });
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toBeNull();
      await expect(LocalMessagingService.getLinksByOwner(OWNER)).resolves.toHaveLength(0);
    });

    it('fails closed on write when WebCrypto is unavailable — no plaintext row is stored', async () => {
      dropCachedWrappingKeyForTests();
      const { subtle: _subtle, ...rest } = globalThis.crypto;
      vi.stubGlobal('crypto', rest);

      await expect(LocalMessagingService.upsertReceiver(receiverRow())).rejects.toSatisfy((error) => isAppError(error));
      await expect(CommerceMessagingReceiverModel.findById(OWNER)).resolves.toBeNull();
    });

    it('treats the receiver as lost when the wrapping key is gone, and re-provisioning recovers', async () => {
      await LocalMessagingService.upsertReceiver(receiverRow());

      // The wrapping key is lost (profile wiped without the database).
      await resetMessagingKeyringForTests();
      await expect(LocalMessagingService.getReceiver(OWNER)).resolves.toBeNull();

      // The re-enable affordance: provisioning writes a fresh receiver, wrapped
      // under the newly generated key, and reads work again.
      await LocalMessagingService.upsertReceiver({ ...receiverRow(), noise_secret: new Uint8Array(32).fill(9) });
      const read = await LocalMessagingService.getReceiver(OWNER);
      expect([...(read?.noise_secret ?? [])]).toEqual([...new Uint8Array(32).fill(9)]);
    });
  });

  describe('insertReceivedMessage (first write wins)', () => {
    const received = (body: string, overrides: Partial<Omit<CommerceMessagingMessageModelSchema, 'id'>> = {}) => {
      const { direction: _direction, ...row } = { ...messageRow(body, 100), ...overrides };
      return row;
    };

    it('inserts once, treats an identical redelivery as a replay, and rejects any change as a conflict', async () => {
      const eventId = crypto.randomUUID();
      await expect(LocalMessagingService.insertReceivedMessage(eventId, received('one'))).resolves.toEqual({
        status: 'inserted',
      });
      await expect(
        LocalMessagingService.insertReceivedMessage(eventId, received('one', { recorded_at: 999 })),
      ).resolves.toEqual({ status: 'replay', recordedAt: 100 });
      for (const change of [
        received('two'),
        received('one', { sent_at: 1 }),
        received('one', { counterparty_pubky: 'y'.repeat(52) }),
        received('one', { listing_ref: null }),
      ]) {
        await expect(LocalMessagingService.insertReceivedMessage(eventId, change)).resolves.toEqual({
          status: 'conflict',
        });
      }
      await expect(CommerceMessagingMessageModel.table.get(`${OWNER}:${eventId}`)).resolves.toMatchObject({
        body: '',
        wrap_version: WRAP_VERSION_AES_GCM_256,
        recorded_at: 100,
      });
      const [stored] = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
      expect(stored).toMatchObject({ body: 'message one', recorded_at: 100 });
    });

    it('never overwrites a sent message that holds the id', async () => {
      const eventId = crypto.randomUUID();
      await LocalMessagingService.upsertMessage(eventId, { ...messageRow('mine', 100), direction: 'sent' });
      await expect(LocalMessagingService.insertReceivedMessage(eventId, received('mine'))).resolves.toEqual({
        status: 'conflict',
      });
      await expect(CommerceMessagingMessageModel.table.get(`${OWNER}:${eventId}`)).resolves.toMatchObject({
        direction: 'sent',
      });
    });

    it('lets exactly one of two concurrent claims of one id insert', async () => {
      const eventId = crypto.randomUUID();
      const outcomes = await Promise.all([
        LocalMessagingService.insertReceivedMessage(eventId, received('first')),
        LocalMessagingService.insertReceivedMessage(
          eventId,
          received('second', { counterparty_pubky: 'y'.repeat(52) }),
        ),
      ]);
      expect(outcomes.map(({ status }) => status).sort()).toEqual(['conflict', 'inserted']);
    });
  });

  // Rows stored before inbound listing messages were bound to their link: a
  // contact (ATTACKER) could file text under a thread with someone else. The
  // row's counterparty is the link it arrived on, so it is detectable.
  describe('quarantine of rows planted before inbound binding', () => {
    const ATTACKER = 'y'.repeat(52);

    async function seedLegitimateThread() {
      await LocalMessagingService.touchConversation({
        owner_id: OWNER,
        conversation_id: CONVERSATION_ID,
        kind: 'listing',
        listing_ref: `listing:${COUNTERPARTY}_L1`,
        counterparty_pubky: COUNTERPARTY,
        last_message_at: 100,
        updated_at: 100,
      });
      await LocalMessagingService.upsertMessage(crypto.randomUUID(), messageRow('from the real seller', 100));
      await LocalMessagingService.upsertMessage(crypto.randomUUID(), {
        ...messageRow('my reply', 110),
        direction: 'sent',
      });
    }

    it('hides a planted message from the thread it names, keeps it stored, and keeps the real history', async () => {
      await seedLegitimateThread();
      const plantedId = crypto.randomUUID();
      await LocalMessagingService.upsertMessage(plantedId, {
        ...messageRow('planted by another contact', 120),
        counterparty_pubky: ATTACKER,
      });

      const thread = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
      expect(thread.map(({ body }) => body)).toEqual(['message from the real seller', 'message my reply']);
      await expect(CommerceMessagingMessageModel.findById(`${OWNER}:${plantedId}`)).resolves.not.toBeNull();
    });

    it('never counts a planted message as unread', async () => {
      await seedLegitimateThread();
      await LocalMessagingService.markConversationRead(OWNER, CONVERSATION_ID, 110);
      await LocalMessagingService.upsertMessage(crypto.randomUUID(), {
        ...messageRow('planted', 130),
        counterparty_pubky: ATTACKER,
      });
      await expect(LocalMessagingService.countUnreadConversations(OWNER)).resolves.toBe(0);
    });

    it('does not list a planted conversation row filed under someone else’s thread', async () => {
      await seedLegitimateThread();
      const plantedThread = `conversation:${OWNER}_${'b'.repeat(52)}_L2`;
      await LocalMessagingService.touchConversation({
        owner_id: OWNER,
        conversation_id: plantedThread,
        kind: 'listing',
        listing_ref: `listing:${OWNER}_L2`,
        counterparty_pubky: ATTACKER,
        last_message_at: 200,
        updated_at: 200,
      });
      await LocalMessagingService.touchConversation({
        owner_id: OWNER,
        conversation_id: `dm:${COUNTERPARTY}`,
        kind: 'dm',
        listing_ref: null,
        counterparty_pubky: COUNTERPARTY,
        last_message_at: 50,
        updated_at: 50,
      });

      const listed = await LocalMessagingService.getConversationsByOwner(OWNER);
      expect(listed.map(({ conversation_id }) => conversation_id).sort()).toEqual(
        [CONVERSATION_ID, `dm:${COUNTERPARTY}`].sort(),
      );
      await expect(LocalMessagingService.getConversation(OWNER, plantedThread)).resolves.not.toBeNull();
    });
  });

  describe('message bodies encrypted at rest', () => {
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

    it('stores a history body only sealed, bound to its table and row, and opens it on read', async () => {
      const eventId = crypto.randomUUID();
      await LocalMessagingService.upsertMessage(eventId, { ...messageRow('secret', 100), direction: 'sent' });

      const raw = (await CommerceMessagingMessageModel.table.get(`${OWNER}:${eventId}`))!;
      expect(raw.body).toBe('');
      expect(raw.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
      expect(JSON.stringify([...raw.sealed_body!])).not.toContain(
        JSON.stringify([...new TextEncoder().encode('secret')]),
      );
      const key = await getOrCreateWrappingKey();
      const opened = await unwrapPayload(key, buildWrapAad('commerce_messaging_messages', raw.id), raw.sealed_body!);
      expect(decode(opened)).toBe('message secret');
      // Bound to its row: the same ciphertext does not open as another row.
      await expect(
        unwrapPayload(key, buildWrapAad('commerce_messaging_messages', `${OWNER}:other`), raw.sealed_body!),
      ).rejects.toMatchObject({ name: 'OperationError' });

      const [message] = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
      expect(message.body).toBe('message secret');
      expect(message).not.toHaveProperty('sealed_body');
      expect(message).not.toHaveProperty('wrap_version');
    });

    it('stores a received body sealed too', async () => {
      const eventId = crypto.randomUUID();
      const { direction: _direction, ...row } = messageRow('inbound', 100);
      await LocalMessagingService.insertReceivedMessage(eventId, row);

      const raw = (await CommerceMessagingMessageModel.table.get(`${OWNER}:${eventId}`))!;
      expect(raw).toMatchObject({ body: '', wrap_version: WRAP_VERSION_AES_GCM_256 });
      expect(raw.sealed_body!.byteLength).toBe(WRAP_IV_BYTES + new TextEncoder().encode('message inbound').length + 16);
    });

    it('stores a queued body only sealed and opens it for the flush and the thread', async () => {
      const row = outboxRow({ body: 'not sent yet' });
      await LocalMessagingService.enqueueOutboxMessage(row);

      const raw = (await CommerceMessagingOutboxModel.table.get(row.id))!;
      expect(raw).toMatchObject({ body: '', wrap_version: WRAP_VERSION_AES_GCM_256 });
      const key = await getOrCreateWrappingKey();
      expect(
        decode(await unwrapPayload(key, buildWrapAad('commerce_messaging_outbox', row.id), raw.sealed_body!)),
      ).toBe('not sent yet');
      const [queued] = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
      expect(queued).toEqual(row);
      await expect(LocalMessagingService.getQueuedMessagesByOwner(OWNER)).resolves.toEqual([row]);
    });

    it('keeps the sealed body when a failed flush is recorded', async () => {
      const row = outboxRow({ body: 'retry me' });
      await LocalMessagingService.enqueueOutboxMessage(row);
      const sealedBefore = [...(await CommerceMessagingOutboxModel.table.get(row.id))!.sealed_body!];

      await LocalMessagingService.recordOutboxFailure(OWNER, row.id, 'homeserver down', 500);

      const raw = (await CommerceMessagingOutboxModel.table.get(row.id))!;
      expect([...raw.sealed_body!]).toEqual(sealedBefore);
      expect(raw).toMatchObject({ body: '', attempts: 1, last_error: 'homeserver down' });
      const [queued] = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
      expect(queued.body).toBe('retry me');
    });

    it('still reads a legacy plaintext row written before bodies were sealed', async () => {
      await CommerceMessagingMessageModel.table.put({ ...messageRow('legacy', 100), id: `${OWNER}:legacy` });
      await CommerceMessagingOutboxModel.table.put(outboxRow({ id: 'legacy-queued', body: 'legacy queued' }));

      const [message] = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
      expect(message.body).toBe('message legacy');
      const [queued] = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
      expect(queued.body).toBe('legacy queued');
    });

    it('treats a tampered, transplanted or unknown-format row as lost instead of showing it', async () => {
      const kept = crypto.randomUUID();
      const tampered = crypto.randomUUID();
      await LocalMessagingService.upsertMessage(kept, messageRow('kept', 100));
      await LocalMessagingService.upsertMessage(tampered, messageRow('tampered', 200));
      const row = (await CommerceMessagingMessageModel.table.get(`${OWNER}:${tampered}`))!;
      const flipped = new Uint8Array(row.sealed_body!);
      flipped[flipped.length - 1] ^= 0xff;
      await CommerceMessagingMessageModel.table.put({ ...row, sealed_body: flipped });
      // The kept row's ciphertext copied under another id does not open there.
      const keptRow = (await CommerceMessagingMessageModel.table.get(`${OWNER}:${kept}`))!;
      await CommerceMessagingMessageModel.table.put({ ...keptRow, id: `${OWNER}:transplanted`, recorded_at: 300 });
      await CommerceMessagingMessageModel.table.put({
        ...messageRow('future', 400),
        id: `${OWNER}:future`,
        body: 'not plaintext',
        wrap_version: 7,
      });

      const messages = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
      expect(messages.map(({ body }) => body)).toEqual(['message kept']);
      // A stored row that no longer opens is never overwritten by a redelivery.
      const { direction: _direction, ...redelivery } = messageRow('tampered', 200);
      await expect(LocalMessagingService.insertReceivedMessage(tampered, redelivery)).resolves.toEqual({
        status: 'conflict',
      });
    });

    it('treats every sealed body as lost once the wrapping key is gone', async () => {
      await LocalMessagingService.upsertMessage(crypto.randomUUID(), messageRow('one', 100));
      await LocalMessagingService.enqueueOutboxMessage(outboxRow());

      await resetMessagingKeyringForTests();

      await expect(LocalMessagingService.getMessages(OWNER, CONVERSATION_ID)).resolves.toEqual([]);
      await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toEqual([]);
    });

    it('refuses to write a body without the key fence: never a plaintext fallback', async () => {
      removeWebLocks();
      await expect(LocalMessagingService.upsertMessage(crypto.randomUUID(), messageRow('x', 1))).rejects.toThrow(
        /Private messages are paused/,
      );
      await expect(LocalMessagingService.enqueueOutboxMessage(outboxRow())).rejects.toThrow(
        /Private messages are paused/,
      );
      installWebLocks();
      await expect(CommerceMessagingMessageModel.table.count()).resolves.toBe(0);
      await expect(CommerceMessagingOutboxModel.table.count()).resolves.toBe(0);
    });

    it('answers metadata questions without opening bodies', async () => {
      await LocalMessagingService.touchConversation({
        owner_id: OWNER,
        conversation_id: CONVERSATION_ID,
        kind: 'listing',
        listing_ref: `listing:${COUNTERPARTY}:L1`,
        counterparty_pubky: COUNTERPARTY,
        last_message_at: 100,
        updated_at: 100,
      });
      await LocalMessagingService.upsertMessage(crypto.randomUUID(), { ...messageRow('mine', 100), direction: 'sent' });
      await LocalMessagingService.upsertMessage(crypto.randomUUID(), messageRow('theirs', 200));

      await resetMessagingKeyringForTests();

      // The bodies no longer open, but the facts about the rows still hold.
      await expect(LocalMessagingService.hasSentTo(OWNER, COUNTERPARTY)).resolves.toBe(true);
      await expect(LocalMessagingService.countUnreadConversations(OWNER)).resolves.toBe(1);
    });
  });

  describe('counterparty key pin', () => {
    const P_KEY = 'p'.repeat(52);
    const Q_KEY = 'q'.repeat(52);

    async function seedLink(snapshot = new Uint8Array([1, 2, 3])) {
      await LocalMessagingService.upsertLink({
        owner_id: OWNER,
        counterparty_pubky: COUNTERPARTY,
        role: 'initiator',
        status: 'established',
        local_receiver_path: 'marketplace/wallet',
        remote_receiver_path: 'marketplace/wallet',
        remote_noise_public_key: P_KEY,
        snapshot,
        created_at: 1,
        updated_at: 1,
      });
    }

    it('pins the key of the first link and has no pin before it', async () => {
      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toBeNull();
      await seedLink();
      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toEqual({
        pinnedKey: P_KEY,
        observedKey: null,
        changedAt: null,
      });
    });

    it('records a changed key without touching the pin or the snapshot, and clears it', async () => {
      await seedLink();
      const before = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      const revisionBefore = await LocalMessagingService.getLinkRevision(OWNER, COUNTERPARTY);

      await LocalMessagingService.setPeerKeyObserved(OWNER, COUNTERPARTY, Q_KEY, 500);
      await LocalMessagingService.setPeerKeyObserved(OWNER, COUNTERPARTY, 'r'.repeat(52), 900);

      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toEqual({
        pinnedKey: P_KEY,
        observedKey: 'r'.repeat(52),
        changedAt: 500,
      });
      const after = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect([...after!.snapshot]).toEqual([...before!.snapshot]);
      expect(after!.remote_noise_public_key).toBe(P_KEY);
      // Other tabs see the row moved and drop any handle they hold.
      await expect(LocalMessagingService.getLinkRevision(OWNER, COUNTERPARTY)).resolves.not.toBe(revisionBefore);

      await LocalMessagingService.setPeerKeyObserved(OWNER, COUNTERPARTY, null, 1_000);
      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toEqual({
        pinnedKey: P_KEY,
        observedKey: null,
        changedAt: null,
      });
    });

    it('keeps the pin of a row whose snapshot no longer opens', async () => {
      await seedLink();
      await resetMessagingKeyringForTests();

      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toBeNull();
      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        pinnedKey: P_KEY,
      });
    });

    it('a snapshot save keeps a recorded key change', async () => {
      await seedLink();
      await LocalMessagingService.setPeerKeyObserved(OWNER, COUNTERPARTY, Q_KEY, 500);
      await LocalMessagingService.updateLinkSnapshot(OWNER, COUNTERPARTY, new Uint8Array([9]), 'established', 600);
      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        observedKey: Q_KEY,
      });
    });

    it('refuses to record a key change for a counterparty with no link', async () => {
      await expect(LocalMessagingService.setPeerKeyObserved(OWNER, COUNTERPARTY, Q_KEY, 1)).rejects.toThrow(
        /No messaging link row/,
      );
    });
  });
});
