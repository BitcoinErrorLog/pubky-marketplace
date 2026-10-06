import type { ConversationOrigin } from '@/libs/messaging/first-contact';

/**
 * Account-scoped persistence for end-to-end-encrypted marketplace messaging
 * over Paykit Encrypted Links (durable commerce modes).
 *
 * SENSITIVITY — read before touching these tables:
 *
 * - `commerce_messaging_receivers.noise_secret` is the receiver-scoped Noise
 *   SECRET key. It is generated in this browser, never leaves it, and is never
 *   the Pubky identity secret. Whoever holds it (plus link snapshots) can
 *   decrypt this user's conversations.
 * - `commerce_messaging_receivers.noise_secret` and
 *   `commerce_messaging_links.snapshot` are encrypted AT REST: the service
 *   layer wraps them with AES-GCM-256 under a non-extractable CryptoKey held
 *   in a dedicated IndexedDB keyring (`src/libs/crypto/messaging-keyring.ts`),
 *   with AAD binding each ciphertext to its table + row id. Rows carry
 *   `wrap_version` — absent/0 means LEGACY plaintext written before the
 *   4 → 5 migration (wrapped in place on upgrade; reads tolerate it, new
 *   writes never produce it). Losing the wrapping key makes these rows
 *   unrecoverable: they are treated as lost and the user re-enables. The
 *   multi-device backup-key decision stays deliberately unmade — wrapped
 *   rows remain device-local. Do not sync, export, or log them.
 * - Message bodies — history (`commerce_messaging_messages`) and messages
 *   queued until the Encrypted Link is ready (`commerce_messaging_outbox`) —
 *   are encrypted AT REST the same way: the body lives in `sealed_body`
 *   (AES-GCM-256 under the keyring key, AAD-bound to table + row id,
 *   `wrap_version` 1) and the stored `body` is the empty string. Absent/0
 *   `wrap_version` is a legacy plaintext row written before history was
 *   wrapped; the boot sweep wraps those in place (`franky.migrations.ts`) and
 *   reads tolerate them until then. Device-local, never synced, logged, or
 *   projected.
 */

/**
 * One messaging receiver per account: the receiver Noise secret plus the
 * receiver path its public marker is published under. Losing this row breaks
 * every Encrypted Link the account has (a fresh receiver starts with no
 * history and counterparties must re-handshake).
 */
export interface CommerceMessagingReceiverModelSchema {
  /** Owner pubky (one receiver per account). */
  id: string;
  /**
   * 32-byte receiver Noise secret key. SECRET — see file header. Stored
   * WRAPPED (`iv || ciphertext || tag`) whenever `wrap_version` is 1; the
   * service layer unwraps on read. Absent/0 `wrap_version` is legacy
   * plaintext from before the 4 → 5 migration.
   */
  noise_secret: Uint8Array;
  /** At-rest wrap format of `noise_secret`: absent/0 = legacy plaintext, 1 = AES-GCM-256. */
  wrap_version?: number;
  /** z-base-32 Noise public key, as published in the receiver marker. */
  noise_public_key: string;
  /** Paykit receiver path the marker is published under (e.g. `marketplace/wallet`). */
  receiver_path: string;
  /** True once `publishReceiverMarker` succeeded for this key. */
  marker_published: boolean;
  created_at: number;
  updated_at: number;
}

export const commerceMessagingReceiverTableSchema = '&id, updated_at';

export type CommerceMessagingLinkStatus = 'handshaking' | 'established';
export type CommerceMessagingLinkRole = 'initiator' | 'responder';

/**
 * One Encrypted Link (or in-progress handshake) per counterparty. `snapshot`
 * is the binding's serialized state — handshake snapshots restore via
 * `restoreEncryptedLinkHandshake`, established ones via `restoreEncryptedLink`.
 * Contains key material; see file header.
 */
export interface CommerceMessagingLinkModelSchema {
  /** `${owner_id}:${counterparty_pubky}` */
  id: string;
  owner_id: string;
  counterparty_pubky: string;
  role: CommerceMessagingLinkRole;
  status: CommerceMessagingLinkStatus;
  local_receiver_path: string;
  remote_receiver_path: string;
  /**
   * Counterparty receiver Noise public key (z-base-32), from their marker
   * when this link was first created. It is also the key PINNED for this
   * counterparty (trust on first use): every later handshake, restore and
   * completed link is checked against it, and a marker advertising any other
   * key never starts a handshake until the user accepts it.
   */
  remote_noise_public_key: string;
  /**
   * The different key the counterparty's marker advertised when it was last
   * read, while it differs from {@link remote_noise_public_key}; absent or
   * `null` while the marker matches the pin. Set, nothing is sent to this
   * counterparty until the user accepts the new key. Public key material,
   * stored in the clear like the pin. Not indexed.
   */
  observed_noise_public_key?: string | null;
  /** When {@link observed_noise_public_key} was first recorded. Not indexed. */
  key_changed_at?: number | null;
  /**
   * Serialized link/handshake state. SECRET — see file header. Stored
   * WRAPPED (`iv || ciphertext || tag`) whenever `wrap_version` is 1; the
   * service layer unwraps on read. Absent/0 `wrap_version` is legacy
   * plaintext from before the 4 → 5 migration.
   */
  snapshot: Uint8Array;
  /** At-rest wrap format of `snapshot`: absent/0 = legacy plaintext, 1 = AES-GCM-256. */
  wrap_version?: number;
  /**
   * Set before a message is sent on this link and cleared by the snapshot
   * saved after it. Still set on a restore, it means a send may have left
   * after `snapshot` was saved, so this snapshot's send counter may already
   * have been used and the link must not send from it. Not indexed, so it
   * needed no Dexie version.
   */
  send_pending?: boolean;
  /**
   * Random id replaced by every write of this row, from any tab. A tab that
   * finds a different id than its own last write or read knows another tab
   * moved the link on, and drops its in-memory handle or handshake instead
   * of sending or saving from a stale one. Not indexed.
   */
  write_id?: string;
  created_at: number;
  updated_at: number;
}

export const commerceMessagingLinkTableSchema = [
  '&id',
  'owner_id',
  'counterparty_pubky',
  'status',
  'updated_at',
  '[owner_id+status]',
].join(', ');

/**
 * Which surface a conversation belongs to. Both kinds ride the SAME Encrypted
 * Link per counterparty pair — the message kind on the wire decides where an
 * inbound message lands, and this discriminator mirrors that locally.
 */
export type CommerceMessagingConversationKind = 'listing' | 'dm';

/**
 * One conversation this account participates in — either listing-scoped
 * (marketplace, `kind: 'listing'`) or a general direct-message thread keyed
 * by the counterparty (`kind: 'dm'`). Created when the local user opens
 * (initiates) a conversation, or when the first inbound message referencing
 * an unknown conversation arrives over a link.
 */
export interface CommerceMessagingConversationModelSchema {
  /** `${owner_id}:${conversation_id}` */
  id: string;
  owner_id: string;
  /**
   * `conversation:{seller}_{buyer}_{listingId}` for listing conversations
   * (matches the sandbox aggregate id); `dm:{counterpartyPubky}` for direct
   * messages — the counterparty IS the DM conversation identity.
   */
  conversation_id: string;
  kind: CommerceMessagingConversationKind;
  /** `listing:{seller}:{listingId}` for listing conversations; `null` for DMs. */
  listing_ref: string | null;
  counterparty_pubky: string;
  last_message_at: number | null;
  /**
   * Device-local read checkpoint: the newest `recorded_at` this device has
   * shown the user for this conversation, or `null` if never opened. Drives
   * the honest local unread badge — it counts only messages that already
   * arrived on THIS device, never anything unfetched.
   */
  last_read_at: number | null;
  /**
   * `request` while the counterparty is someone this account does not know
   * yet: the thread is listed under Requests and never counts as unread.
   * `known` for everyone else. Absent on rows written before first contact
   * existed, which read as `known`. Not indexed, so adding it needed no
   * Dexie version.
   */
  origin?: ConversationOrigin;
  /**
   * When this account first messaged a new person in this conversation, on
   * this device's clock. Drives the limit on new people per hour; `null` or
   * absent otherwise.
   */
  first_contact_at?: number | null;
  created_at: number;
  updated_at: number;
}

export const commerceMessagingConversationTableSchema = [
  '&id',
  'owner_id',
  'conversation_id',
  'counterparty_pubky',
  'updated_at',
  '[owner_id+updated_at]',
].join(', ');

export type CommerceMessagingDirection = 'sent' | 'received';

/**
 * Device-local message history (bodies encrypted at rest; see file header).
 * Keyed by the sender-minted `event_id` so replayed deliveries (expected
 * after a snapshot restore) upsert idempotently instead of duplicating.
 */
export interface CommerceMessagingMessageModelSchema {
  /** `${owner_id}:${event_id}` */
  id: string;
  owner_id: string;
  conversation_id: string;
  /** `listing:{seller}:{listingId}` for listing conversations; `null` for DMs. */
  listing_ref: string | null;
  counterparty_pubky: string;
  direction: CommerceMessagingDirection;
  /**
   * The plaintext body on rows the service returns. At rest it is the empty
   * string whenever `wrap_version` is 1 (the body is in `sealed_body`), and
   * the plaintext only on a legacy row.
   */
  body: string;
  /** The wrapped body (`iv || ciphertext || tag`) when `wrap_version` is 1. Not indexed. */
  sealed_body?: Uint8Array;
  /** At-rest wrap format of the body: absent/0 = legacy plaintext, 1 = AES-GCM-256. Not indexed. */
  wrap_version?: number;
  /** Sender wall clock from the envelope (Unix milliseconds, display ordering only). */
  sent_at: number;
  /** Local receipt/persist time, the stable sort key on this device. */
  recorded_at: number;
}

export const commerceMessagingMessageTableSchema = [
  '&id',
  'owner_id',
  'conversation_id',
  'counterparty_pubky',
  'recorded_at',
  '[owner_id+conversation_id]',
].join(', ');

/**
 * Which real send method a queued message flushes through: `chat` is a
 * marketplace listing message (`marketplace.chat_message.v0`), `dm` a general
 * direct message (`pubky_app.dm.v0`).
 */
export type CommerceMessagingOutboxKind = 'chat' | 'dm';

/**
 * One message the user composed while the Encrypted Link to the counterparty
 * was NOT ready (handshake pending). It is queued on THIS device only and is
 * delivered automatically — via the same real send path as a live send — the
 * moment the link becomes ready. The UI labels these rows "Queued" and never
 * as sent: a row exists here precisely BECAUSE nothing was sent yet.
 *
 * `id` is a queue-time UUID that becomes the envelope `event_id` when the
 * row is flushed, so a crash between a successful send and the row delete
 * replays idempotently (receivers and local history dedupe by `event_id`)
 * instead of double-delivering.
 *
 * Device-local like all messaging state, with the body encrypted at rest
 * exactly like history (see file header), and cleared with the messaging
 * wrapping key on sign-out/account switch (`clearDatabase()`).
 */
export interface CommerceMessagingOutboxModelSchema {
  /** Queue-time UUID; reused as the envelope `event_id` at flush time. */
  id: string;
  owner_pubky: string;
  counterparty_pubky: string;
  kind: CommerceMessagingOutboxKind;
  /** Listing conversation aggregate id for `chat` rows; `null` for DMs. */
  conversation_id: string | null;
  /** `listing:{seller}:{listingId}` for `chat` rows; `null` for DMs. */
  listing_ref: string | null;
  /**
   * The body, validated against the live-send byte ceiling at queue time.
   * Plaintext on rows the service returns; at rest the empty string whenever
   * `wrap_version` is 1 (the body is in `sealed_body`).
   */
  body: string;
  /** The wrapped body (`iv || ciphertext || tag`) when `wrap_version` is 1. Not indexed. */
  sealed_body?: Uint8Array;
  /** At-rest wrap format of the body: absent/0 = legacy plaintext, 1 = AES-GCM-256. Not indexed. */
  wrap_version?: number;
  /** Queue time — the flush order within one (owner, counterparty) pair. */
  queued_at: number;
  /** Failed flush attempts so far (0 until a flush actually failed). */
  attempts: number;
  last_attempt_at: number | null;
  /** Message of the last failed flush attempt; `null` until a flush failed. */
  last_error: string | null;
}

export const commerceMessagingOutboxTableSchema = [
  '&id',
  'owner_pubky',
  'counterparty_pubky',
  'queued_at',
  '[owner_pubky+counterparty_pubky]',
].join(', ');

/**
 * An authenticated inbound event this build cannot interpret: a kind or
 * version it has no handler for (for example a Paykit payment kind riding
 * the same link, or a newer chat version). It is stored before the link's
 * read position moves past it, left unprocessed, never shown, and offered
 * again to the router on every later receive, so a build that understands
 * it can still process it.
 *
 * `payload` holds the event, encrypted at rest like link snapshots
 * (AES-GCM-256 under the messaging keyring, AAD-bound to this table and
 * row id; `wrap_version` 1). It can carry anything the peer sent, so it is
 * never logged or synced. Cleared on sign-out with every other table.
 */
export interface CommerceMessagingUnprocessedModelSchema {
  /** `${owner_id}:${counterparty_pubky}:${digest}`, where `digest` is the SHA-256 of the raw bytes: an identical redelivery stores nothing new. */
  id: string;
  owner_id: string;
  counterparty_pubky: string;
  /**
   * Wrapped `{ kind, version, rawJson }`: the event's raw JSON and the kind
   * and version the link reported for it. SECRET-class — see above. Nothing
   * about the event, not even its kind, is stored in the clear.
   */
  payload: Uint8Array;
  wrap_version: number;
  /** Local receipt time; events are offered again in this order. */
  received_at: number;
  /** Position within the drain that returned it, so events of one drain keep their stream order. */
  position: number;
}

export const commerceMessagingUnprocessedTableSchema = [
  '&id',
  'owner_id',
  'received_at',
  '[owner_id+counterparty_pubky]',
].join(', ');
