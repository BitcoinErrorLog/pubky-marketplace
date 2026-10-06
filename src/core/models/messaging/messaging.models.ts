import type { Table } from 'dexie';
import { db } from '@/database/franky/franky';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { parsePamSentAt } from '@/libs/messaging/pam-sent-at';
import { RecordModelBase } from '@/models/shared/base/record/baseRecord';
import type {
  CommerceMessagingConversationModelSchema,
  CommerceMessagingLinkModelSchema,
  CommerceMessagingMessageModelSchema,
  CommerceMessagingOutboxModelSchema,
  CommerceMessagingReceiverModelSchema,
  CommerceMessagingUnprocessedModelSchema,
} from './messaging.schema';

export class CommerceMessagingReceiverModel
  extends RecordModelBase<string, CommerceMessagingReceiverModelSchema>
  implements CommerceMessagingReceiverModelSchema
{
  static table: Table<CommerceMessagingReceiverModelSchema> = db.table('commerce_messaging_receivers');

  noise_secret: Uint8Array;
  wrap_version?: number;
  noise_public_key: string;
  receiver_path: string;
  marker_published: boolean;
  created_at: number;
  updated_at: number;

  constructor(receiver: CommerceMessagingReceiverModelSchema) {
    super(receiver);
    this.noise_secret = receiver.noise_secret;
    this.wrap_version = receiver.wrap_version;
    this.noise_public_key = receiver.noise_public_key;
    this.receiver_path = receiver.receiver_path;
    this.marker_published = receiver.marker_published;
    this.created_at = receiver.created_at;
    this.updated_at = receiver.updated_at;
  }
}

export class CommerceMessagingLinkModel
  extends RecordModelBase<string, CommerceMessagingLinkModelSchema>
  implements CommerceMessagingLinkModelSchema
{
  static table: Table<CommerceMessagingLinkModelSchema> = db.table('commerce_messaging_links');

  owner_id: string;
  counterparty_pubky: string;
  role: CommerceMessagingLinkModelSchema['role'];
  status: CommerceMessagingLinkModelSchema['status'];
  local_receiver_path: string;
  remote_receiver_path: string;
  remote_noise_public_key: string;
  observed_noise_public_key?: string | null;
  key_changed_at?: number | null;
  snapshot: Uint8Array;
  wrap_version?: number;
  send_pending?: boolean;
  write_id?: string;
  created_at: number;
  updated_at: number;

  constructor(link: CommerceMessagingLinkModelSchema) {
    super(link);
    this.owner_id = link.owner_id;
    this.counterparty_pubky = link.counterparty_pubky;
    this.role = link.role;
    this.status = link.status;
    this.local_receiver_path = link.local_receiver_path;
    this.remote_receiver_path = link.remote_receiver_path;
    this.remote_noise_public_key = link.remote_noise_public_key;
    this.observed_noise_public_key = link.observed_noise_public_key;
    this.key_changed_at = link.key_changed_at;
    this.snapshot = link.snapshot;
    this.wrap_version = link.wrap_version;
    this.send_pending = link.send_pending;
    this.write_id = link.write_id;
    this.created_at = link.created_at;
    this.updated_at = link.updated_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceMessagingLinkModelSchema[]> {
    try {
      return await this.table.where('owner_id').equals(ownerId).toArray();
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceMessagingConversationModel
  extends RecordModelBase<string, CommerceMessagingConversationModelSchema>
  implements CommerceMessagingConversationModelSchema
{
  static table: Table<CommerceMessagingConversationModelSchema> = db.table('commerce_messaging_conversations');

  owner_id: string;
  conversation_id: string;
  kind: CommerceMessagingConversationModelSchema['kind'];
  listing_ref: string | null;
  counterparty_pubky: string;
  last_message_at: number | null;
  last_read_at: number | null;
  origin?: CommerceMessagingConversationModelSchema['origin'];
  first_contact_at?: number | null;
  created_at: number;
  updated_at: number;

  constructor(conversation: CommerceMessagingConversationModelSchema) {
    super(conversation);
    this.owner_id = conversation.owner_id;
    this.conversation_id = conversation.conversation_id;
    this.kind = conversation.kind;
    this.listing_ref = conversation.listing_ref;
    this.counterparty_pubky = conversation.counterparty_pubky;
    this.last_message_at = conversation.last_message_at;
    this.last_read_at = conversation.last_read_at;
    this.origin = conversation.origin;
    this.first_contact_at = conversation.first_contact_at;
    this.created_at = conversation.created_at;
    this.updated_at = conversation.updated_at;
  }

  static async findByOwner(ownerId: string): Promise<CommerceMessagingConversationModelSchema[]> {
    try {
      const conversations = await this.table.where('owner_id').equals(ownerId).toArray();
      return conversations.sort((left, right) => right.updated_at - left.updated_at);
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceMessagingMessageModel
  extends RecordModelBase<string, CommerceMessagingMessageModelSchema>
  implements CommerceMessagingMessageModelSchema
{
  static table: Table<CommerceMessagingMessageModelSchema> = db.table('commerce_messaging_messages');

  owner_id: string;
  conversation_id: string;
  listing_ref: string | null;
  counterparty_pubky: string;
  direction: CommerceMessagingMessageModelSchema['direction'];
  body: string;
  sealed_body?: Uint8Array;
  wrap_version?: number;
  sent_at: number;
  recorded_at: number;

  constructor(message: CommerceMessagingMessageModelSchema) {
    super(message);
    this.owner_id = message.owner_id;
    this.conversation_id = message.conversation_id;
    this.listing_ref = message.listing_ref;
    this.counterparty_pubky = message.counterparty_pubky;
    this.direction = message.direction;
    this.body = message.body;
    this.sealed_body = message.sealed_body;
    this.wrap_version = message.wrap_version;
    this.sent_at = message.sent_at;
    this.recorded_at = message.recorded_at;
  }

  /**
   * Inserts `message` only if no row holds its id, as one read-write
   * transaction on this table, so two concurrent writers of the same id can
   * never both insert. Returns `null` when inserted, otherwise the row that
   * already holds the id (left untouched).
   */
  static async insertIfAbsent(
    message: CommerceMessagingMessageModelSchema,
  ): Promise<CommerceMessagingMessageModelSchema | null> {
    try {
      return await db.transaction('rw', this.table, async () => {
        const existing = await this.table.get(message.id);
        if (existing) return existing;
        await this.table.add(message);
        return null;
      });
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to insert into ${this.table.name}`, {
        service: ErrorService.Local,
        operation: 'insertIfAbsent',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }

  static async findByConversation(
    ownerId: string,
    conversationId: string,
  ): Promise<CommerceMessagingMessageModelSchema[]> {
    try {
      const messages = await this.table.where({ owner_id: ownerId, conversation_id: conversationId }).toArray();
      return messages
        .map((message) => {
          const sentAt = parsePamSentAt((message as { sent_at: unknown }).sent_at);
          return sentAt === null ? message : { ...message, sent_at: sentAt };
        })
        .sort((left, right) => left.recorded_at - right.recorded_at);
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by conversation`, {
        service: ErrorService.Local,
        operation: 'findByConversation',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceMessagingOutboxModel
  extends RecordModelBase<string, CommerceMessagingOutboxModelSchema>
  implements CommerceMessagingOutboxModelSchema
{
  static table: Table<CommerceMessagingOutboxModelSchema> = db.table('commerce_messaging_outbox');

  owner_pubky: string;
  counterparty_pubky: string;
  kind: CommerceMessagingOutboxModelSchema['kind'];
  conversation_id: string | null;
  listing_ref: string | null;
  body: string;
  sealed_body?: Uint8Array;
  wrap_version?: number;
  queued_at: number;
  attempts: number;
  last_attempt_at: number | null;
  last_error: string | null;

  constructor(row: CommerceMessagingOutboxModelSchema) {
    super(row);
    this.owner_pubky = row.owner_pubky;
    this.counterparty_pubky = row.counterparty_pubky;
    this.kind = row.kind;
    this.conversation_id = row.conversation_id;
    this.listing_ref = row.listing_ref;
    this.body = row.body;
    this.sealed_body = row.sealed_body;
    this.wrap_version = row.wrap_version;
    this.queued_at = row.queued_at;
    this.attempts = row.attempts;
    this.last_attempt_at = row.last_attempt_at;
    this.last_error = row.last_error;
  }

  /** Queued rows toward one counterparty in queue (flush) order. */
  static async findByOwnerAndCounterparty(
    ownerPubky: string,
    counterpartyPubky: string,
  ): Promise<CommerceMessagingOutboxModelSchema[]> {
    try {
      const rows = await this.table.where({ owner_pubky: ownerPubky, counterparty_pubky: counterpartyPubky }).toArray();
      return rows.sort((left, right) => left.queued_at - right.queued_at);
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by counterparty`, {
        service: ErrorService.Local,
        operation: 'findByOwnerAndCounterparty',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }

  static async findByOwner(ownerPubky: string): Promise<CommerceMessagingOutboxModelSchema[]> {
    try {
      const rows = await this.table.where('owner_pubky').equals(ownerPubky).toArray();
      return rows.sort((left, right) => left.queued_at - right.queued_at);
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name} by owner`, {
        service: ErrorService.Local,
        operation: 'findByOwner',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}

export class CommerceMessagingUnprocessedModel
  extends RecordModelBase<string, CommerceMessagingUnprocessedModelSchema>
  implements CommerceMessagingUnprocessedModelSchema
{
  // Looked up on use: the table exists only from DB version 8, and a build
  // deployed with an older NEXT_PUBLIC_DB_VERSION must still load. There,
  // storing an unprocessed event throws, so the link's read position stays
  // where it is instead of moving past the event.
  static get table(): Table<CommerceMessagingUnprocessedModelSchema> {
    return db.table('commerce_messaging_unprocessed');
  }

  owner_id: string;
  counterparty_pubky: string;
  payload: Uint8Array;
  wrap_version: number;
  received_at: number;
  position: number;

  constructor(row: CommerceMessagingUnprocessedModelSchema) {
    super(row);
    this.owner_id = row.owner_id;
    this.counterparty_pubky = row.counterparty_pubky;
    this.payload = row.payload;
    this.wrap_version = row.wrap_version;
    this.received_at = row.received_at;
    this.position = row.position;
  }

  /** Whether this database declares the table (DB version 8 and later). */
  static isAvailable(): boolean {
    return db.tables.some((table) => table.name === 'commerce_messaging_unprocessed');
  }

  /** Adds the row unless its id is taken; resolves whether it was added. */
  static async addIfAbsent(row: CommerceMessagingUnprocessedModelSchema): Promise<boolean> {
    try {
      return await db.transaction('rw', this.table, async () => {
        if (await this.table.get(row.id)) return false;
        await this.table.add(row);
        return true;
      });
    } catch (error) {
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, `Failed to insert into ${this.table.name}`, {
        service: ErrorService.Local,
        operation: 'addIfAbsent',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }

  static async findByOwnerAndCounterparty(
    ownerId: string,
    counterpartyPubky: string,
  ): Promise<CommerceMessagingUnprocessedModelSchema[]> {
    try {
      const rows = await this.table
        .where('[owner_id+counterparty_pubky]')
        .equals([ownerId, counterpartyPubky])
        .toArray();
      return rows.sort((left, right) => left.received_at - right.received_at || left.position - right.position);
    } catch (error) {
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, `Failed to query ${this.table.name}`, {
        service: ErrorService.Local,
        operation: 'findByOwnerAndCounterparty',
        context: { table: this.table.name },
        cause: error,
      });
    }
  }
}
