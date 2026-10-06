import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/database/franky/franky';
import { migrateMessagingHistoryToWrappedStorage } from '@/database/franky/franky.migrations';
import { listingConversationBetween } from '@/libs/commerce/messaging-contracts';
import { withCurrentWrappingKey } from '@/libs/crypto/messaging-keyring';
import {
  buildWrapAad,
  isUnwrapAuthenticationError,
  unwrapPayload,
  WRAP_VERSION_AES_GCM_256,
  wrapPayload,
} from '@/libs/crypto/secret-wrapping';
import { isAppError } from '@/libs/error/error';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import { buildDmConversationId, parseDmConversationId } from '@/libs/messaging/dm-contracts';
import { parsePamSentAt } from '@/libs/messaging/pam-sent-at';
import {
  CommerceMessagingConversationModel,
  CommerceMessagingLinkModel,
  CommerceMessagingMessageModel,
  CommerceMessagingOutboxModel,
  CommerceMessagingReceiverModel,
  CommerceMessagingUnprocessedModel,
} from '@/models/messaging/messaging.models';
import type {
  CommerceMessagingConversationModelSchema,
  CommerceMessagingLinkModelSchema,
  CommerceMessagingMessageModelSchema,
  CommerceMessagingOutboxModelSchema,
  CommerceMessagingReceiverModelSchema,
} from '@/models/messaging/messaging.schema';

const RECEIVERS_TABLE = 'commerce_messaging_receivers';
const LINKS_TABLE = 'commerce_messaging_links';
const UNPROCESSED_TABLE = 'commerce_messaging_unprocessed';
export const MESSAGES_TABLE = 'commerce_messaging_messages';
export const OUTBOX_TABLE = 'commerce_messaging_outbox';

/** The key pinned for one counterparty, and a different key their marker advertised since, if any. */
export type PeerKeyPin = {
  pinnedKey: string;
  observedKey: string | null;
  changedAt: number | null;
};

/**
 * Account-scoped Dexie persistence for encrypted marketplace messaging.
 *
 * Everything here is DEVICE-LOCAL by design. The receiver Noise secret,
 * link snapshots and message bodies (history and the queued outbox) are
 * encrypted AT REST by this service: wrapped with AES-GCM-256 under a
 * non-extractable CryptoKey from the messaging keyring
 * (`@/libs/crypto/messaging-keyring`), AAD-bound to their table + row id
 * (`@/libs/crypto/secret-wrapping`). Reads unwrap on the way out, so nothing
 * outside this service sees the wrapping. None of it syncs anywhere, and
 * none of it may enter logs, telemetry, or projections.
 *
 * Failure posture: writes FAIL CLOSED (no wrapping key → AppError, never a
 * plaintext write); a row whose ciphertext fails authentication (lost key,
 * tampered/transplanted row) is treated as LOST — reads return `null`/skip
 * it, so the existing re-enable and re-handshake affordances take over.
 * `wrap_version` is TRI-STATE on read: 1 unwraps; absent/0 is legacy
 * plaintext from before the 4 → 5 migration (the migration wraps those rows
 * in place on upgrade and reads tolerate them until then); ANY OTHER value
 * (corrupted or future format) is treated as LOST exactly like an
 * authentication failure — feeding unwrappable bytes into the Noise binding
 * as plaintext key material is never an option.
 */
export class LocalMessagingService {
  private constructor() {}

  static async getReceiver(ownerId: string): Promise<CommerceMessagingReceiverModelSchema | null> {
    return await withCurrentWrappingKey(async (key) => {
      const row = await CommerceMessagingReceiverModel.findById(ownerId);
      if (!row) return null;
      if (row.wrap_version === WRAP_VERSION_AES_GCM_256) {
        const secret = await this.unwrapSecretField(key, RECEIVERS_TABLE, row.id, row.noise_secret, 'getReceiver');
        if (!secret) return null;
        return { ...row, noise_secret: secret };
      }
      if (this.isUnknownWrapVersion(row.wrap_version, RECEIVERS_TABLE, 'getReceiver')) return null;
      return row;
    });
  }

  /**
   * Stores a new receiver only if the account has none: `false` when a row
   * already exists (created by another tab, or one this tab cannot open),
   * and nothing is written.
   */
  static async addReceiver(receiver: CommerceMessagingReceiverModelSchema): Promise<boolean> {
    return await withCurrentWrappingKey(async (key) => {
      const wrapped = await this.wrapSecretField(
        key,
        RECEIVERS_TABLE,
        receiver.id,
        receiver.noise_secret,
        'addReceiver',
      );
      try {
        await CommerceMessagingReceiverModel.table.add({
          ...receiver,
          noise_secret: wrapped,
          wrap_version: WRAP_VERSION_AES_GCM_256,
        });
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === 'ConstraintError') return false;
        throw error;
      }
    });
  }

  /**
   * Marks the account's receiver as published, only if its stored public key
   * is still the one that was published: `false`, with nothing written, when
   * the row is gone (signed out) or holds another key.
   */
  static async markReceiverPublished(ownerId: string, noisePublicKey: string, now: number): Promise<boolean> {
    return await withCurrentWrappingKey(
      async () =>
        await db.transaction('rw', CommerceMessagingReceiverModel.table, async () => {
          const row = await CommerceMessagingReceiverModel.table.get(ownerId);
          if (!row || row.noise_public_key !== noisePublicKey) return false;
          await CommerceMessagingReceiverModel.table.put({ ...row, marker_published: true, updated_at: now });
          return true;
        }),
    );
  }

  static async upsertReceiver(receiver: CommerceMessagingReceiverModelSchema): Promise<void> {
    await withCurrentWrappingKey(async (key) => {
      const wrapped = await this.wrapSecretField(
        key,
        RECEIVERS_TABLE,
        receiver.id,
        receiver.noise_secret,
        'upsertReceiver',
      );
      await CommerceMessagingReceiverModel.upsert({
        ...receiver,
        noise_secret: wrapped,
        wrap_version: WRAP_VERSION_AES_GCM_256,
      });
    });
  }

  static async getLink(ownerId: string, counterpartyPubky: string): Promise<CommerceMessagingLinkModelSchema | null> {
    return await withCurrentWrappingKey((key) => this.readLinkWith(key, ownerId, counterpartyPubky, 'getLink'));
  }

  static async getLinksByOwner(ownerId: string): Promise<CommerceMessagingLinkModelSchema[]> {
    return await withCurrentWrappingKey(async (key) => {
      const rows = await CommerceMessagingLinkModel.findByOwner(ownerId);
      const links: CommerceMessagingLinkModelSchema[] = [];
      for (const row of rows) {
        if (row.wrap_version === WRAP_VERSION_AES_GCM_256) {
          // An unrecoverable link is skipped (lost): inbox sync simply never
          // probes that counterparty from local state again.
          const snapshot = await this.unwrapSecretField(key, LINKS_TABLE, row.id, row.snapshot, 'getLinksByOwner');
          if (!snapshot) continue;
          links.push({ ...row, snapshot });
        } else if (this.isUnknownWrapVersion(row.wrap_version, LINKS_TABLE, 'getLinksByOwner')) {
          continue;
        } else {
          links.push(row);
        }
      }
      return links;
    });
  }

  static async upsertLink(link: Omit<CommerceMessagingLinkModelSchema, 'id'>): Promise<void> {
    const id = this.linkId(link.owner_id, link.counterparty_pubky);
    await withCurrentWrappingKey(async (key) => {
      const wrapped = await this.wrapSecretField(key, LINKS_TABLE, id, link.snapshot, 'upsertLink');
      await CommerceMessagingLinkModel.upsert({
        ...link,
        id,
        snapshot: wrapped,
        wrap_version: WRAP_VERSION_AES_GCM_256,
        write_id: crypto.randomUUID(),
      });
    });
  }

  /**
   * Persists a fresh link snapshot for an existing row. Callers MUST persist
   * any received messages BEFORE calling this — the binding's read checkpoint
   * advances past returned messages, so an old snapshot is the only way to
   * re-read them after a crash.
   */
  static async updateLinkSnapshot(
    ownerId: string,
    counterpartyPubky: string,
    snapshot: Uint8Array,
    status: CommerceMessagingLinkModelSchema['status'],
    now: number,
  ): Promise<void> {
    await withCurrentWrappingKey(async (key) => {
      const current = await this.readLinkWith(key, ownerId, counterpartyPubky, 'updateLinkSnapshot');
      if (!current) {
        throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'No messaging link row exists for this counterparty.', {
          service: ErrorService.Local,
          operation: 'updateLinkSnapshot',
        });
      }
      const id = this.linkId(ownerId, counterpartyPubky);
      const wrapped = await this.wrapSecretField(key, LINKS_TABLE, id, snapshot, 'updateLinkSnapshot');
      await CommerceMessagingLinkModel.upsert({
        ...current,
        snapshot: wrapped,
        wrap_version: WRAP_VERSION_AES_GCM_256,
        status,
        send_pending: false,
        write_id: crypto.randomUUID(),
        updated_at: now,
      });
    });
  }

  /**
   * Marks the pair's link as about to send, before the ciphertext leaves.
   * The snapshot saved after the send clears it ({@link updateLinkSnapshot}).
   * Touches only the flag: the stored snapshot bytes stay as they are.
   * Throws when the mark cannot be written, so nothing is sent.
   */
  static async markSendPending(ownerId: string, counterpartyPubky: string): Promise<void> {
    await withCurrentWrappingKey(async () => {
      const row = await CommerceMessagingLinkModel.findById(this.linkId(ownerId, counterpartyPubky));
      if (!row) {
        throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'No messaging link row exists for this counterparty.', {
          service: ErrorService.Local,
          operation: 'markSendPending',
        });
      }
      await CommerceMessagingLinkModel.upsert({ ...row, send_pending: true, write_id: crypto.randomUUID() });
    });
  }

  /**
   * The counterparty key pinned on this pair's link row, read without
   * unwrapping the snapshot, so a row whose snapshot no longer opens still
   * pins its key. `null` when the account has never linked with them.
   */
  static async getPeerKeyPin(ownerId: string, counterpartyPubky: string): Promise<PeerKeyPin | null> {
    const row = await CommerceMessagingLinkModel.findById(this.linkId(ownerId, counterpartyPubky));
    if (!row) return null;
    return {
      pinnedKey: row.remote_noise_public_key,
      observedKey: row.observed_noise_public_key ?? null,
      changedAt: row.key_changed_at ?? null,
    };
  }

  /**
   * Records the different key the counterparty's marker now advertises, or
   * clears the record (`observedKey` `null`) once the marker matches the pin
   * again. Touches only these fields: the pin and the snapshot stay as they
   * are. Keeps the first `key_changed_at` while the same change persists.
   */
  static async setPeerKeyObserved(
    ownerId: string,
    counterpartyPubky: string,
    observedKey: string | null,
    now: number,
  ): Promise<void> {
    await withCurrentWrappingKey(async () => {
      const row = await CommerceMessagingLinkModel.findById(this.linkId(ownerId, counterpartyPubky));
      if (!row) {
        throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'No messaging link row exists for this counterparty.', {
          service: ErrorService.Local,
          operation: 'setPeerKeyObserved',
        });
      }
      const current = row.observed_noise_public_key ?? null;
      if (current === observedKey) return;
      await CommerceMessagingLinkModel.upsert({
        ...row,
        observed_noise_public_key: observedKey,
        key_changed_at: observedKey === null ? null : (row.key_changed_at ?? now),
        write_id: crypto.randomUUID(),
      });
    });
  }

  /**
   * Seals any message body still stored in plaintext, in place: the same
   * idempotent sweep the database runs at boot. A tab of an older build
   * that is still open writes plaintext bodies after this tab booted; this
   * catches them without waiting for the next boot. Rejects when sealing
   * fails, leaving those rows readable as they are.
   */
  static async sealPlaintextHistory(): Promise<void> {
    await migrateMessagingHistoryToWrappedStorage(db);
  }

  /**
   * Identifies the pair's link row as last written, without unwrapping its
   * snapshot; `null` when no row exists. Any write changes it: this build
   * replaces `write_id` on every write, and every snapshot write, from any
   * build, re-wraps the snapshot under a fresh IV.
   */
  static async getLinkRevision(ownerId: string, counterpartyPubky: string): Promise<string | null> {
    const row = await CommerceMessagingLinkModel.findById(this.linkId(ownerId, counterpartyPubky));
    if (!row) return null;
    return `${row.write_id ?? 'legacy'}|${row.status}|${row.send_pending ? 1 : 0}|${bytesToHex(row.snapshot)}`;
  }

  /**
   * Conversation rows whose reference names their own counterparty. Rows
   * written before inbound listing messages were bound to their link (a
   * forged `conversation_id` created a row filed under someone else's
   * thread) stay in storage but are never listed.
   */
  static async getConversationsByOwner(ownerId: string): Promise<CommerceMessagingConversationModelSchema[]> {
    const conversations = await CommerceMessagingConversationModel.findByOwner(ownerId);
    return conversations.filter(isBoundToCounterparty);
  }

  static async getConversation(
    ownerId: string,
    conversationId: string,
  ): Promise<CommerceMessagingConversationModelSchema | null> {
    return await CommerceMessagingConversationModel.findById(`${ownerId}:${conversationId}`);
  }

  /**
   * Creates the conversation row if absent; bumps `last_message_at`/`updated_at`
   * if newer. The read checkpoint (`last_read_at`) is owned by
   * `markConversationRead` and is never touched here. `origin` and
   * `first_contact_at` apply only when the row is created: later writes never
   * move a thread between Requests and the inbox (that is
   * {@link markCounterpartyKnown}).
   */
  static async touchConversation(
    conversation: Omit<CommerceMessagingConversationModelSchema, 'id' | 'created_at' | 'last_read_at'>,
  ): Promise<void> {
    const id = `${conversation.owner_id}:${conversation.conversation_id}`;
    const current = await CommerceMessagingConversationModel.findById(id);
    if (!current) {
      await CommerceMessagingConversationModel.upsert({
        ...conversation,
        id,
        last_read_at: null,
        created_at: conversation.updated_at,
      });
      return;
    }
    await CommerceMessagingConversationModel.upsert({
      ...current,
      last_message_at: latest(current.last_message_at, conversation.last_message_at),
      updated_at: Math.max(current.updated_at, conversation.updated_at),
    });
  }

  /**
   * Moves every conversation with `counterpartyPubky` out of Requests. Used
   * when the account accepts the person, replies to them, or turns out to
   * know them (follows them, or shares an order or offer).
   */
  static async markCounterpartyKnown(ownerId: string, counterpartyPubky: string): Promise<void> {
    const conversations = await this.getConversationsByOwner(ownerId);
    for (const conversation of conversations) {
      if (conversation.counterparty_pubky !== counterpartyPubky || conversation.origin !== 'request') continue;
      await CommerceMessagingConversationModel.upsert({ ...conversation, origin: 'known' });
    }
  }

  /**
   * Claims a first contact with a new person: in one IndexedDB transaction,
   * reads every first contact of the account, refuses (`limited`) when
   * `isAllowed` says the new person would go past the limit, and otherwise
   * dates this conversation's first contact, creating its row if needed. A
   * read-write transaction on the table cannot interleave with another, in
   * this tab or any other, so concurrent sends cannot all pass the limit.
   */
  static async claimFirstContact(
    input: {
      ownerId: string;
      conversationId: string;
      listingRef: string;
      counterpartyPubky: string;
      at: number;
    },
    isAllowed: (
      firstContacts: { counterpartyPubky: string; at: number }[],
      counterpartyPubky: string,
      now: number,
    ) => boolean,
  ): Promise<'claimed' | 'limited'> {
    return await db.transaction('rw', CommerceMessagingConversationModel.table, async () => {
      const rows = (
        await CommerceMessagingConversationModel.table.where('owner_id').equals(input.ownerId).toArray()
      ).filter(isBoundToCounterparty);
      const firstContacts = rows.flatMap((row) =>
        typeof row.first_contact_at === 'number'
          ? [{ counterpartyPubky: row.counterparty_pubky, at: row.first_contact_at }]
          : [],
      );
      if (!isAllowed(firstContacts, input.counterpartyPubky, input.at)) return 'limited';
      const id = `${input.ownerId}:${input.conversationId}`;
      const current = rows.find((row) => row.id === id);
      if (current && typeof current.first_contact_at === 'number') return 'claimed';
      await CommerceMessagingConversationModel.table.put(
        current
          ? { ...current, first_contact_at: input.at }
          : {
              id,
              owner_id: input.ownerId,
              conversation_id: input.conversationId,
              kind: 'listing',
              listing_ref: input.listingRef,
              counterparty_pubky: input.counterpartyPubky,
              last_message_at: null,
              last_read_at: null,
              origin: 'known',
              first_contact_at: input.at,
              created_at: input.at,
              updated_at: input.at,
            },
      );
      return 'claimed';
    });
  }

  /** Every recorded first contact of this account, oldest first. */
  static async getFirstContacts(ownerId: string): Promise<{ counterpartyPubky: string; at: number }[]> {
    const conversations = await this.getConversationsByOwner(ownerId);
    return conversations
      .flatMap((conversation) =>
        typeof conversation.first_contact_at === 'number'
          ? [{ counterpartyPubky: conversation.counterparty_pubky, at: conversation.first_contact_at }]
          : [],
      )
      .sort((left, right) => left.at - right.at);
  }

  /**
   * Whether this account has already exchanged anything with the person:
   * a message either way, a queued message, or an established link.
   */
  static async hasHistoryWith(ownerId: string, counterpartyPubky: string): Promise<boolean> {
    const link = await CommerceMessagingLinkModel.findById(this.linkId(ownerId, counterpartyPubky));
    if (link?.status === 'established') return true;
    if ((await this.getQueuedMessages(ownerId, counterpartyPubky)).length > 0) return true;
    for (const conversation of await this.getConversationsByOwner(ownerId)) {
      if (conversation.counterparty_pubky !== counterpartyPubky) continue;
      if ((await this.getStoredMessageRows(ownerId, conversation.conversation_id)).length > 0) return true;
    }
    return false;
  }

  /** Whether the account has sent this person at least one message. */
  static async hasSentTo(ownerId: string, counterpartyPubky: string): Promise<boolean> {
    for (const conversation of await this.getConversationsByOwner(ownerId)) {
      if (conversation.counterparty_pubky !== counterpartyPubky) continue;
      const messages = await this.getStoredMessageRows(ownerId, conversation.conversation_id);
      if (messages.some((message) => message.direction === 'sent')) return true;
    }
    return false;
  }

  /**
   * Moves the device-local read checkpoint forward (never backward). Called
   * when the conversation surface is actually showing its messages.
   */
  static async markConversationRead(ownerId: string, conversationId: string, now: number): Promise<void> {
    const current = await CommerceMessagingConversationModel.findById(`${ownerId}:${conversationId}`);
    if (!current) return;
    if (current.last_read_at !== null && current.last_read_at >= now) return;
    await CommerceMessagingConversationModel.upsert({ ...current, last_read_at: now });
  }

  /**
   * Honest device-local unread: conversations holding at least one RECEIVED
   * message persisted after the read checkpoint. Counts only messages that
   * already arrived on this device — it can never claim knowledge of
   * undelivered mail sitting on a homeserver. Requests and the
   * `excludedCounterparties` (muted people) never count.
   */
  static async countUnreadConversations(
    ownerId: string,
    excludedCounterparties?: ReadonlySet<string>,
  ): Promise<number> {
    const conversations = await this.getConversationsByOwner(ownerId);
    let unread = 0;
    for (const conversation of conversations) {
      if (conversation.origin === 'request') continue;
      if (excludedCounterparties?.has(conversation.counterparty_pubky)) continue;
      const checkpoint = conversation.last_read_at ?? 0;
      const messages = await this.getStoredMessageRows(ownerId, conversation.conversation_id);
      if (messages.some((message) => message.direction === 'received' && message.recorded_at > checkpoint)) {
        unread += 1;
      }
    }
    return unread;
  }

  /**
   * One conversation's history, limited to rows exchanged with a participant
   * of that conversation. A row whose counterparty is not named by the
   * conversation reference was planted by a contact before inbound binding
   * existed (or was sent into such a planted thread); it stays in storage,
   * quarantined, and is never shown or counted. Bodies are unwrapped; a row
   * whose body no longer opens (lost wrapping key, tampered or transplanted
   * row) is treated as lost and left out.
   */
  static async getMessages(ownerId: string, conversationId: string): Promise<CommerceMessagingMessageModelSchema[]> {
    return await withCurrentWrappingKey(async (key) => {
      const rows = await this.getStoredMessageRows(ownerId, conversationId);
      const messages: CommerceMessagingMessageModelSchema[] = [];
      for (const row of rows) {
        const body = await this.openBody(key, MESSAGES_TABLE, row, 'getMessages');
        if (body !== null) messages.push(withoutSeal({ ...row, body }));
      }
      return messages;
    });
  }

  /** {@link getMessages} without opening bodies, for facts that need only the row metadata. */
  private static async getStoredMessageRows(
    ownerId: string,
    conversationId: string,
  ): Promise<CommerceMessagingMessageModelSchema[]> {
    const messages = await CommerceMessagingMessageModel.findByConversation(ownerId, conversationId);
    return messages.filter(isBoundToCounterparty);
  }

  /**
   * How many inbound events from one person this account stored after
   * `since`: received messages plus events kept unprocessed. Read from
   * IndexedDB, so every tab and every reload sees the same count.
   */
  static async countStoredInbound(ownerId: string, counterpartyPubky: string, since: number): Promise<number> {
    const messages = await CommerceMessagingMessageModel.table
      .where('counterparty_pubky')
      .equals(counterpartyPubky)
      .filter((row) => row.owner_id === ownerId && row.direction === 'received' && row.recorded_at > since)
      .count();
    if (!CommerceMessagingUnprocessedModel.isAvailable()) return messages;
    const unprocessed = await CommerceMessagingUnprocessedModel.table
      .where('[owner_id+counterparty_pubky]')
      .equals([ownerId, counterpartyPubky])
      .filter((row) => row.received_at > since)
      .count();
    return messages + unprocessed;
  }

  /** Whether any message row (sent or received) holds this event id for the owner. */
  static async hasMessage(ownerId: string, eventId: string): Promise<boolean> {
    return (await CommerceMessagingMessageModel.findById(`${ownerId}:${eventId}`)) !== null;
  }

  /**
   * First-write-wins persistence for an inbound message. The row id is
   * `${owner}:${event_id}` and `event_id` is chosen by the sender, so an
   * existing row is never overwritten:
   *
   * - `inserted`: no row held the id; this message is now stored.
   * - `replay`: the stored row is this same received message (counterparty,
   *   conversation, listing ref, body, and `sent_at` all equal) — the
   *   redelivery expected after a snapshot restore. Nothing is written.
   * - `conflict`: the id is held by anything else (another body or time,
   *   another counterparty or conversation, or a sent message). Nothing is
   *   written and the caller drops the message.
   *
   * The claim is atomic, so concurrent drains on different links cannot
   * both insert one id. The body is stored wrapped; a stored row whose body
   * no longer opens is a `conflict`, never overwritten.
   */
  static async insertReceivedMessage(
    eventId: string,
    message: Omit<CommerceMessagingMessageModelSchema, 'id' | 'direction'>,
  ): Promise<{ status: 'inserted' } | { status: 'replay'; recordedAt: number } | { status: 'conflict' }> {
    const row: CommerceMessagingMessageModelSchema = {
      ...message,
      id: `${message.owner_id}:${eventId}`,
      direction: 'received',
    };
    return await withCurrentWrappingKey(async (key) => {
      const sealed = await this.sealBody(key, MESSAGES_TABLE, row, 'insertReceivedMessage');
      const existing = await CommerceMessagingMessageModel.insertIfAbsent(sealed);
      if (!existing) return { status: 'inserted' };
      const existingBody = await this.openBody(key, MESSAGES_TABLE, existing, 'insertReceivedMessage');
      const sameMessage =
        existingBody !== null &&
        existing.owner_id === row.owner_id &&
        existing.direction === 'received' &&
        existing.counterparty_pubky === row.counterparty_pubky &&
        existing.conversation_id === row.conversation_id &&
        existing.listing_ref === row.listing_ref &&
        existingBody === row.body &&
        parsePamSentAt((existing as { sent_at: unknown }).sent_at) === row.sent_at;
      return sameMessage ? { status: 'replay', recordedAt: existing.recorded_at } : { status: 'conflict' };
    });
  }

  /**
   * Idempotent by construction: the row id is `${owner}:${event_id}` (the
   * sender-minted envelope UUID), so a replayed delivery (expected after a
   * snapshot restore) overwrites itself instead of duplicating. The body is
   * stored wrapped.
   */
  static async upsertMessage(eventId: string, message: Omit<CommerceMessagingMessageModelSchema, 'id'>): Promise<void> {
    await withCurrentWrappingKey(async (key) => {
      const row = { ...message, id: `${message.owner_id}:${eventId}` };
      await CommerceMessagingMessageModel.upsert(await this.sealBody(key, MESSAGES_TABLE, row, 'upsertMessage'));
    });
  }

  // --- unprocessed inbound events --------------------------------------------
  // Events of a kind or version this build cannot interpret. They are stored
  // before the link's read position moves past them and offered again later.

  /** The row id of one raw event from one peer; identical bytes share an id. */
  static unprocessedId(ownerId: string, counterpartyPubky: string, rawJson: string): string {
    const digest = bytesToHex(sha256(new TextEncoder().encode(rawJson)));
    return `${ownerId}:${counterpartyPubky}:${digest}`;
  }

  static async hasUnprocessed(id: string): Promise<boolean> {
    if (!CommerceMessagingUnprocessedModel.isAvailable()) return false;
    return (await CommerceMessagingUnprocessedModel.findById(id)) !== null;
  }

  /**
   * Stores one event, wrapped at rest. Throws when it cannot be stored
   * (including on a database without the table), so the caller never
   * advances the link past it.
   */
  static async storeUnprocessed(event: {
    ownerId: string;
    counterpartyPubky: string;
    kind: string;
    version: number | null;
    rawJson: string;
    receivedAt: number;
    position: number;
  }): Promise<'stored' | 'duplicate'> {
    if (!CommerceMessagingUnprocessedModel.isAvailable()) {
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'This device cannot keep messages it cannot read yet.', {
        service: ErrorService.Local,
        operation: 'storeUnprocessed',
        context: { reason: 'unprocessed_table_missing' },
      });
    }
    const id = this.unprocessedId(event.ownerId, event.counterpartyPubky, event.rawJson);
    const sealed = JSON.stringify({ kind: event.kind.slice(0, 128), version: event.version, rawJson: event.rawJson });
    return await withCurrentWrappingKey(async (key) => {
      const payload = await this.wrapSecretField(
        key,
        UNPROCESSED_TABLE,
        id,
        new TextEncoder().encode(sealed),
        'storeUnprocessed',
      );
      const added = await CommerceMessagingUnprocessedModel.addIfAbsent({
        id,
        owner_id: event.ownerId,
        counterparty_pubky: event.counterpartyPubky,
        payload,
        wrap_version: WRAP_VERSION_AES_GCM_256,
        received_at: event.receivedAt,
        position: event.position,
      });
      return added ? 'stored' : 'duplicate';
    });
  }

  /**
   * The stored events from one peer, oldest first, unwrapped. A row whose
   * ciphertext no longer opens (lost wrapping key, tampered row) is left in
   * place and skipped.
   */
  static async getUnprocessed(
    ownerId: string,
    counterpartyPubky: string,
  ): Promise<{ id: string; kind: string; version: number | null; rawJson: string }[]> {
    if (!CommerceMessagingUnprocessedModel.isAvailable()) return [];
    return await withCurrentWrappingKey(async (key) => {
      const rows = await CommerceMessagingUnprocessedModel.findByOwnerAndCounterparty(ownerId, counterpartyPubky);
      const events: { id: string; kind: string; version: number | null; rawJson: string }[] = [];
      for (const row of rows) {
        if (row.wrap_version !== WRAP_VERSION_AES_GCM_256) continue;
        const bytes = await this.unwrapSecretField(key, UNPROCESSED_TABLE, row.id, row.payload, 'getUnprocessed');
        if (!bytes) continue;
        const event = parseSealedUnprocessed(new TextDecoder().decode(bytes));
        if (event) events.push({ id: row.id, ...event });
      }
      return events;
    });
  }

  /** Deletes one stored event once it has been processed; only the owner's own rows. */
  static async deleteUnprocessed(ownerId: string, id: string): Promise<void> {
    if (!CommerceMessagingUnprocessedModel.isAvailable()) return;
    const row = await CommerceMessagingUnprocessedModel.findById(id);
    if (!row || row.owner_id !== ownerId) return;
    await CommerceMessagingUnprocessedModel.deleteById(id);
  }

  // --- queued-message outbox -------------------------------------------------
  // Device-local rows for messages composed while the Encrypted Link was not
  // ready. Bodies are wrapped at rest like history (see the schema file
  // header); cleared with the wrapping key on sign-out (`clearDatabase()`).

  static async enqueueOutboxMessage(row: CommerceMessagingOutboxModelSchema): Promise<void> {
    await withCurrentWrappingKey(async (key) => {
      await CommerceMessagingOutboxModel.upsert(await this.sealBody(key, OUTBOX_TABLE, row, 'enqueueOutboxMessage'));
    });
  }

  /**
   * Queued rows toward one counterparty, oldest first — the flush order.
   * A row whose body no longer opens is treated as lost and left out.
   */
  static async getQueuedMessages(
    ownerPubky: string,
    counterpartyPubky: string,
  ): Promise<CommerceMessagingOutboxModelSchema[]> {
    return await this.openOutboxRows(
      () => CommerceMessagingOutboxModel.findByOwnerAndCounterparty(ownerPubky, counterpartyPubky),
      'getQueuedMessages',
    );
  }

  /** All of one account's queued rows, oldest first. */
  static async getQueuedMessagesByOwner(ownerPubky: string): Promise<CommerceMessagingOutboxModelSchema[]> {
    return await this.openOutboxRows(
      () => CommerceMessagingOutboxModel.findByOwner(ownerPubky),
      'getQueuedMessagesByOwner',
    );
  }

  private static async openOutboxRows(
    read: () => Promise<CommerceMessagingOutboxModelSchema[]>,
    operation: string,
  ): Promise<CommerceMessagingOutboxModelSchema[]> {
    return await withCurrentWrappingKey(async (key) => {
      const opened: CommerceMessagingOutboxModelSchema[] = [];
      for (const row of await read()) {
        const body = await this.openBody(key, OUTBOX_TABLE, row, operation);
        if (body !== null) opened.push(withoutSeal({ ...row, body }));
      }
      return opened;
    });
  }

  /**
   * Deletes one queued row, but only when it belongs to `ownerPubky` —
   * account isolation for cancel and flush alike. A missing row is a no-op
   * (it was already delivered or cancelled).
   */
  static async deleteOutboxMessage(ownerPubky: string, id: string): Promise<void> {
    const row = await CommerceMessagingOutboxModel.findById(id);
    if (!row || row.owner_pubky !== ownerPubky) return;
    await CommerceMessagingOutboxModel.deleteById(id);
  }

  /** Records one failed flush attempt on a queued row (attempts, time, error); the stored body is kept as it is. */
  static async recordOutboxFailure(ownerPubky: string, id: string, error: string, now: number): Promise<void> {
    await withCurrentWrappingKey(async () => {
      const row = await CommerceMessagingOutboxModel.findById(id);
      if (!row || row.owner_pubky !== ownerPubky) return;
      await CommerceMessagingOutboxModel.upsert({
        ...row,
        attempts: row.attempts + 1,
        last_attempt_at: now,
        last_error: error,
      });
    });
  }

  private static linkId(ownerId: string, counterpartyPubky: string): string {
    return `${ownerId}:${counterpartyPubky}`;
  }

  /**
   * Tri-state `wrap_version` guard: `1` is handled by the unwrap path and
   * absent/0 is legacy plaintext — both return false here. ANY OTHER value
   * (a corrupted or future format marker) means the row's bytes are NOT
   * plaintext key material and cannot be unwrapped by this build, so the row
   * is treated as LOST exactly like an authentication failure: never served
   * to the Noise binding. Logs `{operation, table}` only — never row bytes.
   */
  private static isUnknownWrapVersion(wrapVersion: number | undefined, table: string, operation: string): boolean {
    if (wrapVersion === undefined || wrapVersion === 0 || wrapVersion === WRAP_VERSION_AES_GCM_256) return false;
    Logger.warn('A messaging row carries an unknown wrap_version; treating it as lost', { operation, table });
    return true;
  }

  /** `row` as stored: the body wrapped into `sealed_body` and the stored `body` empty. */
  private static async sealBody<T extends { id: string; body: string }>(
    key: CryptoKey,
    table: string,
    row: T,
    operation: string,
  ): Promise<T & { sealed_body: Uint8Array; wrap_version: number }> {
    const sealed = await this.wrapSecretField(key, table, row.id, new TextEncoder().encode(row.body), operation);
    return { ...row, body: '', sealed_body: sealed, wrap_version: WRAP_VERSION_AES_GCM_256 };
  }

  /**
   * The plaintext body of a stored row: unwrapped when `wrap_version` is 1,
   * the stored body of a legacy row, and `null` when the row is lost (its
   * body does not open, or it carries an unknown wrap format).
   */
  private static async openBody(
    key: CryptoKey,
    table: string,
    row: { id: string; body: string; sealed_body?: Uint8Array; wrap_version?: number },
    operation: string,
  ): Promise<string | null> {
    if (row.wrap_version === WRAP_VERSION_AES_GCM_256) {
      if (!row.sealed_body) return null;
      const bytes = await this.unwrapSecretField(key, table, row.id, row.sealed_body, operation);
      return bytes ? new TextDecoder().decode(bytes) : null;
    }
    if (this.isUnknownWrapVersion(row.wrap_version, table, operation)) return null;
    return row.body;
  }

  /** The pair's link row unwrapped with `key`; `null` when absent or lost. */
  private static async readLinkWith(
    key: CryptoKey,
    ownerId: string,
    counterpartyPubky: string,
    operation: string,
  ): Promise<CommerceMessagingLinkModelSchema | null> {
    const row = await CommerceMessagingLinkModel.findById(this.linkId(ownerId, counterpartyPubky));
    if (!row) return null;
    if (row.wrap_version === WRAP_VERSION_AES_GCM_256) {
      const snapshot = await this.unwrapSecretField(key, LINKS_TABLE, row.id, row.snapshot, operation);
      if (!snapshot) return null;
      return { ...row, snapshot };
    }
    if (this.isUnknownWrapVersion(row.wrap_version, LINKS_TABLE, operation)) return null;
    return row;
  }

  /**
   * Wraps a secret field for at-rest storage under a fresh IV, AAD-bound to
   * its table + row id. FAIL CLOSED: with no working wrapping key this
   * throws — a plaintext write is never an option.
   */
  private static async wrapSecretField(
    key: CryptoKey,
    table: string,
    rowId: string,
    plaintext: Uint8Array,
    operation: string,
  ): Promise<Uint8Array> {
    try {
      return await wrapPayload(key, buildWrapAad(table, rowId), plaintext);
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to wrap a messaging secret for at-rest storage.', {
        service: ErrorService.Local,
        operation,
        cause: error,
      });
    }
  }

  /**
   * Unwraps a stored secret field. Returns `null` when the ciphertext fails
   * authentication (lost wrapping key, tampered or transplanted row): the
   * row is unrecoverable and callers treat it as absent so the existing
   * re-enable/re-handshake affordances take over. Environmental failures
   * (WebCrypto/IDB unavailable) THROW — fail closed, never silent data loss.
   */
  private static async unwrapSecretField(
    key: CryptoKey,
    table: string,
    rowId: string,
    wrapped: Uint8Array,
    operation: string,
  ): Promise<Uint8Array | null> {
    try {
      return await unwrapPayload(key, buildWrapAad(table, rowId), wrapped);
    } catch (error) {
      if (isUnwrapAuthenticationError(error)) {
        Logger.warn('A wrapped messaging secret is unrecoverable (lost key or tampered row); treating it as lost', {
          operation,
          table,
        });
        return null;
      }
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, 'Failed to unwrap a messaging secret from at-rest storage.', {
        service: ErrorService.Local,
        operation,
        cause: error,
      });
    }
  }
}

/**
 * A stored row belongs to its conversation when the conversation reference
 * names the row's counterparty: the DM key is the counterparty itself, and a
 * listing conversation's seller and buyer must be the owner and the row's
 * counterparty.
 */
function isBoundToCounterparty(row: {
  owner_id: string;
  conversation_id: string;
  counterparty_pubky: string;
}): boolean {
  if (parseDmConversationId(row.conversation_id)) {
    return row.conversation_id === buildDmConversationId(row.counterparty_pubky);
  }
  return listingConversationBetween(row.conversation_id, row.owner_id, row.counterparty_pubky) !== null;
}

/** An opened row without its at-rest wrapping fields. */
function withoutSeal<T extends { sealed_body?: Uint8Array; wrap_version?: number }>(
  row: T,
): Omit<T, 'sealed_body' | 'wrap_version'> {
  const { sealed_body: _sealed, wrap_version: _version, ...opened } = row;
  return opened;
}

function latest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

/** The sealed `{ kind, version, rawJson }` of an unprocessed row, or `null` when it is not that shape. */
function parseSealedUnprocessed(json: string): { kind: string; version: number | null; rawJson: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { kind, version, rawJson } = value as { kind?: unknown; version?: unknown; rawJson?: unknown };
  if (typeof kind !== 'string' || typeof rawJson !== 'string') return null;
  if (version !== null && typeof version !== 'number') return null;
  return { kind, version, rawJson };
}
