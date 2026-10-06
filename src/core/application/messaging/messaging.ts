import { buildChatMessage, type MarketplaceChatMessage } from '@/libs/commerce/messaging-contracts';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { getErrorMessage } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import {
  buildDmConversationId,
  buildDmMessage,
  parseDmConversationId,
  type PubkyAppDmMessage,
} from '@/libs/messaging/dm-contracts';
import type { MessagingPolicy } from '@/libs/messaging/intake-gate';
import { RetryBackoff } from '@/libs/messaging/retry-backoff';
import type {
  CommerceMessagingConversationModelSchema,
  CommerceMessagingMessageModelSchema,
  CommerceMessagingOutboxModelSchema,
} from '@/models/messaging/messaging.schema';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import {
  assertListingConversationBound,
  type MessagingEnableFlow,
  type MessagingKeys,
  type MessagingLinkState,
  type OwnMarkerRepublished,
  PaykitMessagingService,
  type ReceivedMessage,
} from '@/services/paykit/paykit-messaging';

/**
 * A conversation's state as the Shop shows it: the transport's link state,
 * `muted` when this account muted the other person, or `paused` while the
 * mute list cannot be confirmed. In both of the last two nothing is opened,
 * sent, flushed or received.
 */
export type MessagingThreadState =
  | MessagingLinkState
  | { status: 'muted' }
  | { status: 'paused'; reason: 'needs_approval' | 'needs_reauth' | 'error' };

export type MessagingStatus = {
  /**
   * A `/pub/paykit/:rw` homeserver session is live — resumed from the
   * sign-in cookie with zero approvals for current sign-ins, or from a Ring
   * approval for legacy sessions (restores across tabs/reloads).
   */
  sessionActive: boolean;
  /** A receiver Noise key exists on this device and its marker was published. */
  receiverProvisioned: boolean;
  /**
   * Set once, on the status read after this device found its published
   * marker advertising another key (`replaced`) or none (`missing`) and
   * published its own key again; `null` otherwise.
   */
  ownKeyRepublished: OwnMarkerRepublished | null;
};

export type MessagingConversationSummary = CommerceMessagingConversationModelSchema & {
  lastMessage: CommerceMessagingMessageModelSchema | null;
  /**
   * The newest device-locally QUEUED (not yet sent) message for this
   * conversation, or `null`. Inbox previews use it to say "Queued: …" when
   * the newest item awaits delivery, instead of pretending it was sent.
   */
  lastQueued: CommerceMessagingOutboxModelSchema | null;
};

/**
 * The truthful result of a queue-aware send. `delivered: true` means the
 * binding actually sent the message over the ready link — exactly the old
 * direct-send path. `delivered: false` means NOTHING was sent: the message
 * was validated against the same byte ceiling as a live send and persisted
 * as a device-local outbox row that flushes automatically once the link is
 * ready. The UI must never render a queued row as sent.
 */
export type MessagingSendOutcome<TMessage> =
  | { delivered: true; message: TMessage }
  | { delivered: false; queued: CommerceMessagingOutboxModelSchema };

/** One bounded outbox flush pass: how many rows were actually sent, how many remain queued. */
export type MessagingOutboxFlushResult = {
  delivered: number;
  remaining: number;
};

/**
 * Application layer for end-to-end-encrypted messaging — marketplace listing
 * conversations AND general direct messages, over the same per-counterparty
 * Paykit Encrypted Links. Orchestrates the link service (network, crypto,
 * snapshot persistence) and the device-local history reads the UI renders
 * from. Message bodies never leave this layer toward logs, telemetry, or
 * projections. Deliberately independent of the commerce adapter mode —
 * marketplace-contextual surfaces gate themselves.
 */
export class MessagingApplication {
  private constructor() {}

  /**
   * Starts the interactive "enable encrypted messaging" flow: a Ring approval
   * for the `/pub/paykit/:rw` grant, then receiver provisioning and marker
   * publish. Last resort only: current sign-ins carry the combined grant and
   * resume with ZERO approvals via {@link getStatus} (cookie resume inside
   * `restorePersistedSession`); this flow is reached only by legacy sessions
   * without the paykit scope or cookies the homeserver rejects.
   */
  static async beginEnableFlow(ownerPubky: string): Promise<MessagingEnableFlow> {
    return await PaykitMessagingService.beginEnableFlow(ownerPubky);
  }

  static async getStatus(ownerPubky: string): Promise<MessagingStatus> {
    // Restore-before-report: the session resumes silently — persisted
    // metadata first, then purely from the sign-in cookie (the sign-in
    // grant covers /pub/paykit/:rw), each validated against the homeserver,
    // with receiver provisioning ensured on success — so surfaces never
    // show the enable/reconnect card while a valid session is actually
    // recoverable without a signer.
    const sessionActive = await PaykitMessagingService.restorePersistedSession(ownerPubky);
    await settledOrAfter(this.sealPlaintextHistoryNow(Date.now()), MESSAGING_PLAINTEXT_SWEEP_WAIT_MS, () => {
      Logger.warn('Sealing plaintext message history is slow; it finishes in the background', {
        reason: 'plaintext_sweep_slow',
      });
    });
    return {
      sessionActive,
      receiverProvisioned: await PaykitMessagingService.isReceiverProvisioned(ownerPubky),
      ownKeyRepublished: PaykitMessagingService.takeOwnMarkerRepublished(ownerPubky),
    };
  }

  /** Keeps a republished-key notice from a status read nobody waited for, for the next read to tell. */
  static returnOwnKeyRepublished(ownerPubky: string, notice: OwnMarkerRepublished): void {
    PaykitMessagingService.returnOwnMarkerRepublished(ownerPubky, notice);
  }

  /** The receiver key this device published for the account, or `null`. Local read only. */
  static async publishedReceiverKey(ownerPubky: string): Promise<string | null> {
    return await PaykitMessagingService.publishedReceiverKey(ownerPubky);
  }

  /** Runs `operation` while nothing may create, replace or publish the account's receiver key. */
  static async withoutReceiverProvisioning<T>(ownerPubky: string, operation: () => Promise<T>): Promise<T> {
    return await PaykitMessagingService.withoutReceiverProvisioning(ownerPubky, operation);
  }

  /**
   * Resumes the account's messaging session without the signer. It never
   * touches the receiver key, even when it settles after a caller stopped
   * waiting for it.
   */
  static async resumeSession(ownerPubky: string): Promise<boolean> {
    return await PaykitMessagingService.restorePersistedSession(ownerPubky, { provision: false });
  }

  /** This device's messaging key and the one pinned for the counterparty, for the Verify step. */
  static async getMessagingKeys(ownerPubky: string, counterpartyPubky: string): Promise<MessagingKeys> {
    return await PaykitMessagingService.getMessagingKeys(ownerPubky, counterpartyPubky);
  }

  /**
   * The user accepts the counterparty's changed key, the one they were
   * shown. Messages still waiting on the link with the old key are received
   * first, then the pair moves to the accepted key; once that link is ready,
   * the messages queued meanwhile are sent to it at once, whatever retry
   * schedule an earlier failed flush left.
   */
  static async acceptCounterpartyKey(
    ownerPubky: string,
    counterpartyPubky: string,
    acceptedKey: string,
    policy: MessagingPolicy,
  ): Promise<MessagingLinkState> {
    assertReachable(policy, counterpartyPubky, 'acceptCounterpartyKey');
    await PaykitMessagingService.receiveMessages(ownerPubky, counterpartyPubky, policy.gate);
    const state = await PaykitMessagingService.acceptCounterpartyKey(ownerPubky, counterpartyPubky, acceptedKey);
    if (state.status === 'ready') {
      this.restartRetries(ownerPubky, counterpartyPubky);
      await this.flushOutbox(ownerPubky, counterpartyPubky, policy);
    }
    return state;
  }

  /** Sign-out teardown: drops the in-memory session and all live link handles. */
  static clearMessagingSession(): void {
    PaykitMessagingService.clearSession();
    this.outboxRetry.clear();
    this.plaintextSweepAt = null;
  }

  /** When this tab last swept plaintext bodies, so status reads sweep at most once per {@link MESSAGING_PLAINTEXT_SWEEP_INTERVAL_MS}. */
  private static plaintextSweepAt: number | null = null;

  /**
   * Seals plaintext bodies an older build still open in another tab wrote
   * since boot, at most once per interval. Best effort: a failure is logged
   * and retried at the next interval, and never fails the status read.
   */
  private static async sealPlaintextHistoryNow(now: number): Promise<void> {
    if (this.plaintextSweepAt !== null && now - this.plaintextSweepAt < MESSAGING_PLAINTEXT_SWEEP_INTERVAL_MS) return;
    this.plaintextSweepAt = now;
    try {
      await LocalMessagingService.sealPlaintextHistory();
    } catch (error) {
      Logger.warn('Could not seal plaintext message history; the next status read retries', { error });
    }
  }

  /** Account switch without a sign-out: drops the messaging session of any account but `keepPubky`. */
  static clearMessagingSessionsOfOtherAccounts(keepPubky: string): void {
    PaykitMessagingService.clearOtherAccounts(keepPubky);
    this.outboxRetry.clear();
  }

  /**
   * Restarts the retry schedule of the account's failed link attempts and
   * queued-message flushes — with `counterpartyPubky` only, when given — so
   * the next poll retries them at once. For a surface someone is looking
   * at; memory only, no request.
   */
  static restartRetries(ownerPubky: string, counterpartyPubky?: string): void {
    PaykitMessagingService.restartLinkRetries(ownerPubky, counterpartyPubky);
    const exact = counterpartyPubky === undefined ? null : `${ownerPubky}:${counterpartyPubky}`;
    this.outboxRetry.restart((key) => (exact === null ? key.startsWith(`${ownerPubky}:`) : key === exact));
  }

  /** True when the counterparty has published a messaging receiver marker. */
  static async isCounterpartyEnrolled(counterpartyPubky: string): Promise<boolean> {
    return (await PaykitMessagingService.getCounterpartyMarker(counterpartyPubky)) !== null;
  }

  /**
   * Opens (or resumes) a marketplace listing conversation with a
   * counterparty: records the conversation row so inboxes list it even while
   * the handshake is queued, and drives the Encrypted Link one step forward.
   */
  static async openConversation(
    ownerPubky: string,
    counterpartyPubky: string,
    conversationId: string,
    listingRef: string,
    policy: MessagingPolicy,
  ): Promise<MessagingLinkState> {
    assertReachable(policy, counterpartyPubky, 'openConversation');
    const state = await PaykitMessagingService.ensureLink(ownerPubky, counterpartyPubky);
    if (state.status !== 'not-enrolled') {
      // A thread this account opens itself is never a request; an existing
      // row (for example one in Requests) keeps its place.
      await LocalMessagingService.touchConversation({
        owner_id: ownerPubky,
        conversation_id: conversationId,
        kind: 'listing',
        listing_ref: listingRef,
        counterparty_pubky: counterpartyPubky,
        last_message_at: null,
        updated_at: Date.now(),
        origin: 'known',
      });
    }
    // Opening a conversation can be the first moment the link is READY on
    // this device (e.g. the counterparty answered while it was closed) —
    // deliver anything queued right away.
    if (state.status === 'ready') {
      await this.flushOutbox(ownerPubky, counterpartyPubky, policy);
    }
    return state;
  }

  /**
   * Opens (or resumes) the general DM conversation with a counterparty. Same
   * link machinery as listing conversations; the conversation identity is the
   * counterparty pubky itself.
   */
  static async openDmConversation(
    ownerPubky: string,
    counterpartyPubky: string,
    policy: MessagingPolicy,
  ): Promise<MessagingLinkState> {
    assertReachable(policy, counterpartyPubky, 'openDmConversation');
    const state = await PaykitMessagingService.ensureLink(ownerPubky, counterpartyPubky);
    if (state.status !== 'not-enrolled') {
      await LocalMessagingService.touchConversation({
        owner_id: ownerPubky,
        conversation_id: buildDmConversationId(counterpartyPubky),
        kind: 'dm',
        listing_ref: null,
        counterparty_pubky: counterpartyPubky,
        last_message_at: null,
        updated_at: Date.now(),
        origin: 'known',
      });
    }
    // Same flush-on-open rule as listing conversations — the shared link
    // carries both kinds, so any queued row can deliver the moment it's ready.
    if (state.status === 'ready') {
      await this.flushOutbox(ownerPubky, counterpartyPubky, policy);
    }
    return state;
  }

  /**
   * One bounded poll step for an open conversation with this counterparty:
   * advance the handshake if still queued, and — once the link is ready —
   * flush any device-locally queued messages (this poll is the moment the
   * link can have JUST become ready), then receive pending messages.
   * Kind-agnostic by construction — the shared link drains BOTH message
   * kinds and each is persisted into its own conversation. Callers own
   * scheduling (poll only while the surface is mounted and visible).
   */
  static async pollConversation(
    ownerPubky: string,
    counterpartyPubky: string,
    policy: MessagingPolicy,
  ): Promise<{ state: MessagingLinkState; received: ReceivedMessage[]; flushed: number }> {
    assertReachable(policy, counterpartyPubky, 'pollConversation');
    const state = await PaykitMessagingService.ensureLink(ownerPubky, counterpartyPubky);
    // A pair held for a key change sends nothing, but its link on the pinned
    // key, when there is one, keeps receiving.
    if (state.status === 'key-changed') {
      return {
        state,
        received: await PaykitMessagingService.receiveMessages(ownerPubky, counterpartyPubky, policy.gate),
        flushed: 0,
      };
    }
    if (state.status !== 'ready') return { state, received: [], flushed: 0 };
    const { delivered } = await this.flushOutbox(ownerPubky, counterpartyPubky, policy);
    const received = await PaykitMessagingService.receiveMessages(ownerPubky, counterpartyPubky, policy.gate);
    return { state, received, flushed: delivered };
  }

  /**
   * Throws the same typed error a send would when this listing message could
   * not be sent at all (too long, empty, or a thread that does not name both
   * people), so callers can refuse before doing anything else.
   */
  static assertSendableChat(
    ownerPubky: string,
    counterpartyPubky: string,
    input: { conversationId: string; listingRef: string; body: string },
  ): void {
    assertListingConversationBound(ownerPubky, counterpartyPubky, input, 'assertSendableChat');
    buildChatMessage({
      eventId: crypto.randomUUID(),
      conversationId: input.conversationId,
      listingRef: input.listingRef,
      sentAt: Date.now(),
      body: input.body,
    });
  }

  static async sendMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    input: { conversationId: string; listingRef: string; body: string },
    policy: MessagingPolicy,
  ): Promise<MarketplaceChatMessage> {
    assertReachable(policy, counterpartyPubky, 'sendMessage');
    return await PaykitMessagingService.sendChatMessage(ownerPubky, counterpartyPubky, input);
  }

  static async sendDmMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    body: string,
    policy: MessagingPolicy,
  ): Promise<PubkyAppDmMessage> {
    assertReachable(policy, counterpartyPubky, 'sendDmMessage');
    return await PaykitMessagingService.sendDmMessage(ownerPubky, counterpartyPubky, { body });
  }

  /**
   * Queue-aware send for a listing conversation. If the Encrypted Link is
   * ready, the message is sent directly — exactly like {@link sendMessage} —
   * and the result says `delivered: true`. Otherwise the body is validated
   * against the SAME serialized byte ceiling a live send enforces and
   * persisted as a device-local outbox row (`delivered: false`), which
   * flushes automatically the moment the link becomes ready. A message is
   * never reported sent unless the binding actually sent it.
   */
  static async sendOrQueueMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    input: { conversationId: string; listingRef: string; body: string },
    policy: MessagingPolicy,
  ): Promise<MessagingSendOutcome<MarketplaceChatMessage>> {
    assertReachable(policy, counterpartyPubky, 'sendOrQueueMessage');
    const state = await PaykitMessagingService.ensureLink(ownerPubky, counterpartyPubky);
    if (state.status === 'ready') {
      // Older queued rows must deliver FIRST or the thread order would lie.
      // If the flush stalls on a failure, this message queues behind them.
      const { remaining } = await this.flushOutbox(ownerPubky, counterpartyPubky, policy);
      if (remaining === 0) {
        return { delivered: true, message: await this.sendMessage(ownerPubky, counterpartyPubky, input, policy) };
      }
    }
    return {
      delivered: false,
      queued: await this.enqueueMessage(ownerPubky, counterpartyPubky, { ...input, kind: 'chat' }),
    };
  }

  /** Queue-aware DM send — same contract as {@link sendOrQueueMessage}. */
  static async sendOrQueueDmMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    body: string,
    policy: MessagingPolicy,
  ): Promise<MessagingSendOutcome<PubkyAppDmMessage>> {
    assertReachable(policy, counterpartyPubky, 'sendOrQueueDmMessage');
    const state = await PaykitMessagingService.ensureLink(ownerPubky, counterpartyPubky);
    if (state.status === 'ready') {
      const { remaining } = await this.flushOutbox(ownerPubky, counterpartyPubky, policy);
      if (remaining === 0) {
        return { delivered: true, message: await this.sendDmMessage(ownerPubky, counterpartyPubky, body, policy) };
      }
    }
    return {
      delivered: false,
      queued: await this.enqueueMessage(ownerPubky, counterpartyPubky, {
        kind: 'dm',
        conversationId: null,
        listingRef: null,
        body,
      }),
    };
  }

  /**
   * Validates a message against the live-send byte ceiling and persists it
   * as an outbox row. The queue-time UUID doubles as the flush-time envelope
   * `event_id`, and the envelope's fixed-width fields (UUID, Unix-ms timestamp)
   * make this validation byte-exact for the eventual send — an oversized
   * body is rejected HERE with the same typed error a live send throws.
   */
  private static async enqueueMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    input:
      | { kind: 'chat'; conversationId: string; listingRef: string; body: string }
      | {
          kind: 'dm';
          conversationId: null;
          listingRef: null;
          body: string;
        },
  ): Promise<CommerceMessagingOutboxModelSchema> {
    if (input.kind === 'chat') {
      assertListingConversationBound(ownerPubky, counterpartyPubky, input, 'enqueueMessage');
    }
    const id = crypto.randomUUID();
    const sentAtProbe = Date.now();
    const { message } =
      input.kind === 'chat'
        ? buildChatMessage({
            eventId: id,
            conversationId: input.conversationId,
            listingRef: input.listingRef,
            sentAt: sentAtProbe,
            body: input.body,
          })
        : buildDmMessage({ eventId: id, sentAt: sentAtProbe, body: input.body });
    // `queued_at` IS the flush order, so it must be strictly increasing per
    // (owner, counterparty) — two sends inside one millisecond would
    // otherwise tie and flush in arbitrary order.
    const existing = await LocalMessagingService.getQueuedMessages(ownerPubky, counterpartyPubky);
    const lastQueuedAt = existing.at(-1)?.queued_at ?? 0;
    const row: CommerceMessagingOutboxModelSchema = {
      id,
      owner_pubky: ownerPubky,
      counterparty_pubky: counterpartyPubky,
      kind: input.kind,
      conversation_id: input.conversationId,
      listing_ref: input.listingRef,
      // The trimmed body from the validated envelope — what a flush will send.
      body: message.body,
      queued_at: Math.max(Date.now(), lastQueuedAt + 1),
      attempts: 0,
      last_attempt_at: null,
      last_error: null,
    };
    await LocalMessagingService.enqueueOutboxMessage(row);
    return row;
  }

  /** In-flight flush per `${owner}:${counterparty}`, so overlapping triggers share one pass and never double-send. */
  private static outboxFlushInFlight = new Map<string, Promise<MessagingOutboxFlushResult>>();
  /** A failed flush is retried on the shared messaging backoff, not on every poll. */
  private static outboxRetry = new RetryBackoff<true>();

  /**
   * Delivers this counterparty's queued messages IN QUEUE ORDER over the
   * ready link, through the same real send methods a live send uses. Each
   * row is deleted only AFTER its send succeeded; the first failure records
   * `last_error`/`attempts` on the failing row and STOPS the pass, so order
   * is preserved and the next flush resumes from that row. After a failure
   * the pair's rows stay queued, untouched, until its backoff-spaced retry is
   * due. Bounded (one pass over the rows present at start) and
   * reentrancy-safe (concurrent callers share the in-flight pass).
   */
  static async flushOutbox(
    ownerPubky: string,
    counterpartyPubky: string,
    policy: MessagingPolicy,
  ): Promise<MessagingOutboxFlushResult> {
    // Nothing queued toward a muted person is ever sent; it stays queued.
    if (policy.isMuted(counterpartyPubky)) {
      return {
        delivered: 0,
        remaining: (await LocalMessagingService.getQueuedMessages(ownerPubky, counterpartyPubky)).length,
      };
    }
    const key = `${ownerPubky}:${counterpartyPubky}`;
    const inFlight = this.outboxFlushInFlight.get(key);
    if (inFlight) return await inFlight;
    const run = this.runOutboxFlush(ownerPubky, counterpartyPubky).finally(() => {
      this.outboxFlushInFlight.delete(key);
    });
    this.outboxFlushInFlight.set(key, run);
    return await run;
  }

  private static async runOutboxFlush(
    ownerPubky: string,
    counterpartyPubky: string,
  ): Promise<MessagingOutboxFlushResult> {
    const rows = await LocalMessagingService.getQueuedMessages(ownerPubky, counterpartyPubky);
    const retryKey = `${ownerPubky}:${counterpartyPubky}`;
    if (rows.length === 0) {
      this.outboxRetry.succeed(retryKey);
      return { delivered: 0, remaining: 0 };
    }
    if (this.outboxRetry.status(retryKey) === 'waiting') return { delivered: 0, remaining: rows.length };
    let delivered = 0;
    for (const row of rows) {
      try {
        if (row.kind === 'chat' && row.conversation_id !== null && row.listing_ref !== null) {
          await PaykitMessagingService.sendChatMessage(ownerPubky, counterpartyPubky, {
            conversationId: row.conversation_id,
            listingRef: row.listing_ref,
            body: row.body,
            eventId: row.id,
          });
        } else if (row.kind === 'dm') {
          await PaykitMessagingService.sendDmMessage(ownerPubky, counterpartyPubky, {
            body: row.body,
            eventId: row.id,
          });
        } else {
          // A chat row without its conversation references cannot be sent and
          // enqueueMessage never writes one; treat it as a failed attempt so
          // it stays visible (and cancellable) instead of vanishing silently.
          throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Queued message is missing its conversation.', {
            service: ErrorService.Local,
            operation: 'runOutboxFlush',
          });
        }
        await LocalMessagingService.deleteOutboxMessage(ownerPubky, row.id);
        delivered += 1;
      } catch (error) {
        await LocalMessagingService.recordOutboxFailure(ownerPubky, row.id, getErrorMessage(error), Date.now());
        this.outboxRetry.fail(retryKey, true);
        return { delivered, remaining: rows.length - delivered };
      }
    }
    this.outboxRetry.succeed(retryKey);
    return { delivered, remaining: 0 };
  }

  /**
   * Deletes one queued message — possible only while it is still queued (a
   * row that already flushed no longer exists, so the delete is a no-op and
   * the message stays honestly sent).
   */
  static async cancelQueuedMessage(ownerPubky: string, id: string): Promise<void> {
    await LocalMessagingService.deleteOutboxMessage(ownerPubky, id);
  }

  /**
   * The device-locally queued (not yet sent) messages belonging to one
   * conversation, oldest first — what the conversation hooks merge after the
   * sent/received history.
   */
  static async getQueuedMessagesForConversation(
    ownerPubky: string,
    conversationId: string,
  ): Promise<CommerceMessagingOutboxModelSchema[]> {
    const dm = parseDmConversationId(conversationId);
    if (dm) {
      const rows = await LocalMessagingService.getQueuedMessages(ownerPubky, dm.counterpartyPubky);
      return rows.filter((row) => row.kind === 'dm');
    }
    const rows = await LocalMessagingService.getQueuedMessagesByOwner(ownerPubky);
    return rows.filter((row) => row.kind === 'chat' && row.conversation_id === conversationId);
  }

  /** Moves the device-local read checkpoint of one conversation to now. */
  static async markConversationRead(ownerPubky: string, conversationId: string): Promise<void> {
    await LocalMessagingService.markConversationRead(ownerPubky, conversationId, Date.now());
  }

  /**
   * Honest device-local unread badge input: conversations with at least one
   * received-and-persisted message newer than the read checkpoint. Local
   * reads only — this never claims knowledge of undelivered mail.
   */
  static async getUnreadConversationCount(
    ownerPubky: string,
    excludedCounterparties?: ReadonlySet<string>,
  ): Promise<number> {
    return await LocalMessagingService.countUnreadConversations(ownerPubky, excludedCounterparties);
  }

  static async getConversationMessages(
    ownerPubky: string,
    conversationId: string,
  ): Promise<CommerceMessagingMessageModelSchema[]> {
    return await LocalMessagingService.getMessages(ownerPubky, conversationId);
  }

  static async getConversations(ownerPubky: string): Promise<MessagingConversationSummary[]> {
    const conversations = await LocalMessagingService.getConversationsByOwner(ownerPubky);
    const queued = await LocalMessagingService.getQueuedMessagesByOwner(ownerPubky);
    return await Promise.all(
      conversations.map(async (conversation) => {
        const messages = await LocalMessagingService.getMessages(ownerPubky, conversation.conversation_id);
        const queuedHere = queued.filter((row) =>
          row.kind === 'dm'
            ? buildDmConversationId(row.counterparty_pubky) === conversation.conversation_id
            : row.conversation_id === conversation.conversation_id,
        );
        return { ...conversation, lastMessage: messages.at(-1) ?? null, lastQueued: queuedHere.at(-1) ?? null };
      }),
    );
  }

  /**
   * Inbox sync: advances pending handshakes, answers queued inbound
   * handshakes, and receives messages for a bounded set of counterparties —
   * WITHOUT initiating anything. The binding cannot enumerate unknown inbound
   * initiators (no such API), so discovery is limited to counterparties this
   * account can NAME: existing conversations/links first (they always fit the
   * bound before new candidates), then the caller-supplied naming set —
   * marketplace order/offer participants plus the user's follows and
   * followers. A total stranger outside that set stays invisible until they
   * enter it; the UI discloses this instead of pretending otherwise.
   *
   * Pairs whose last link attempt failed are kept out of that budget: one
   * still waiting on its backoff is skipped with no network. A ready link
   * whose last queued-message flush failed still receives in the healthy
   * pass, but its due flush is a retry too. At most
   * {@link MESSAGING_SYNC_MAX_RECOVERY_PROBES} due retries of either kind run
   * per pass, after every healthy pair, so a retry never delays or displaces
   * healthy delivery.
   *
   * Existing counterparties are probed most recent first, and
   * {@link MESSAGING_SYNC_RESERVED_NEW_PROBES} of the healthy budget are kept
   * for people with no local state yet (`priorityPubkys` first, then the
   * rest of `candidatePubkys`), so a long contact list never locks new people
   * out. Muted people are never probed. Once `shouldContinue` answers false
   * no further pair step starts; one already running finishes, because a
   * handshake or send cut off midway would leave its saved state behind.
   */
  static async syncCounterparties(
    ownerPubky: string,
    candidatePubkys: string[],
    options: { priorityPubkys?: string[]; policy: MessagingPolicy; shouldContinue?: () => boolean },
  ): Promise<void> {
    const { policy } = options;
    const shouldContinue = options.shouldContinue ?? (() => true);
    const existing = await this.existingCounterpartiesByRecency(ownerPubky);
    const existingSet = new Set(existing);
    const fresh = [...new Set([...(options.priorityPubkys ?? []), ...candidatePubkys])].filter(
      (pubky) => !existingSet.has(pubky),
    );
    const retries: string[] = [];
    const split = (pubkys: string[]) => {
      const healthy: string[] = [];
      for (const counterparty of pubkys) {
        if (counterparty === ownerPubky || policy.isMuted(counterparty)) continue;
        const retry = PaykitMessagingService.linkRetryStatus(ownerPubky, counterparty);
        if (retry === 'none') healthy.push(counterparty);
        else if (retry === 'due') retries.push(counterparty);
      }
      return healthy;
    };
    const healthyExisting = split(existing);
    const healthyFresh = split(fresh);
    const freshSlots = Math.min(healthyFresh.length, MESSAGING_SYNC_RESERVED_NEW_PROBES);
    const existingProbes = healthyExisting.slice(0, MESSAGING_SYNC_MAX_COUNTERPARTIES - freshSlots);
    const freshProbes = healthyFresh.slice(0, MESSAGING_SYNC_MAX_COUNTERPARTIES - existingProbes.length);
    // Sequential on purpose: each probe is a couple of homeserver reads, and
    // parallel fan-out against one homeserver session buys nothing but load.
    const flushRetries: string[] = [];
    for (const counterparty of [...existingProbes, ...freshProbes]) {
      if (!shouldContinue()) return;
      const state = await PaykitMessagingService.probeCounterparty(ownerPubky, counterparty);
      if (state.status === 'key-changed') {
        if (!shouldContinue()) return;
        await PaykitMessagingService.receiveMessages(ownerPubky, counterparty, policy.gate);
        continue;
      }
      if (state.status !== 'ready') continue;
      if (this.outboxRetry.status(`${ownerPubky}:${counterparty}`) === 'due') {
        flushRetries.push(counterparty);
      } else {
        if (!shouldContinue()) return;
        // The probe may have JUST completed the handshake — deliver anything
        // queued toward this counterparty before draining inbound messages.
        await this.flushOutbox(ownerPubky, counterparty, policy);
      }
      if (!shouldContinue()) return;
      await PaykitMessagingService.receiveMessages(ownerPubky, counterparty, policy.gate);
    }
    // Due link retries and due flush retries of ready links share one
    // recovery budget, taken in turn so neither kind starves the other.
    const recovery: { kind: 'link' | 'flush'; counterparty: string }[] = [];
    for (let index = 0; index < Math.max(retries.length, flushRetries.length); index += 1) {
      if (index < flushRetries.length) recovery.push({ kind: 'flush', counterparty: flushRetries[index] });
      if (index < retries.length) recovery.push({ kind: 'link', counterparty: retries[index] });
    }
    for (const { kind, counterparty } of recovery.slice(0, MESSAGING_SYNC_MAX_RECOVERY_PROBES)) {
      if (!shouldContinue()) return;
      if (kind === 'flush') {
        await this.flushOutbox(ownerPubky, counterparty, policy);
        continue;
      }
      const state = await PaykitMessagingService.probeCounterparty(ownerPubky, counterparty);
      if (!shouldContinue()) continue;
      if (state.status === 'key-changed') {
        await PaykitMessagingService.receiveMessages(ownerPubky, counterparty, policy.gate);
        continue;
      }
      if (state.status !== 'ready') continue;
      await this.flushOutbox(ownerPubky, counterparty, policy);
      if (!shouldContinue()) return;
      await PaykitMessagingService.receiveMessages(ownerPubky, counterparty, policy.gate);
    }
  }

  /**
   * Everyone this account has local messaging state with, most recent
   * activity first. Established links lead: until a pair's first failure is
   * recorded (for example after a reload) a retry looks healthy, and it must
   * not push a live link out of the budget.
   */
  private static async existingCounterpartiesByRecency(ownerPubky: string): Promise<string[]> {
    const activity = new Map<string, { established: boolean; at: number }>();
    const note = (pubky: string, at: number, established: boolean) => {
      const current = activity.get(pubky);
      activity.set(pubky, {
        established: established || Boolean(current?.established),
        at: Math.max(at, current?.at ?? 0),
      });
    };
    for (const link of await LocalMessagingService.getLinksByOwner(ownerPubky)) {
      note(link.counterparty_pubky, link.updated_at, link.status === 'established');
    }
    for (const conversation of await LocalMessagingService.getConversationsByOwner(ownerPubky)) {
      note(conversation.counterparty_pubky, conversation.last_message_at ?? conversation.created_at, false);
    }
    activity.delete(ownerPubky);
    return [...activity.entries()]
      .sort(([, left], [, right]) => Number(right.established) - Number(left.established) || right.at - left.at)
      .map(([pubky]) => pubky);
  }
}

/** Least time between two plaintext-history sweeps from status reads in one tab. */
export const MESSAGING_PLAINTEXT_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Longest a status read waits for its plaintext-history sweep; a slower sweep finishes after the read returns. */
export const MESSAGING_PLAINTEXT_SWEEP_WAIT_MS = 2_000;

/** Upper bound on healthy counterparties probed per inbox sync pass. */
export const MESSAGING_SYNC_MAX_COUNTERPARTIES = 25;

/** Healthy probes per pass kept for people with no local messaging state yet. */
export const MESSAGING_SYNC_RESERVED_NEW_PROBES = 10;

/** Upper bound on due link retries run per inbox sync pass, on top of the healthy budget. */
export const MESSAGING_SYNC_MAX_RECOVERY_PROBES = 3;

/** Waits for `work` to settle, or for `waitMs` and then calls `onLate`; `work` itself keeps running. */
async function settledOrAfter(work: Promise<void>, waitMs: number, onLate: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onLate();
      resolve();
    }, waitMs);
  });
  try {
    await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refuses any contact with a person the confirmed policy says is muted.
 * Callers already refuse earlier with their own copy; this keeps every
 * application entry point safe on its own.
 */
function assertReachable(policy: MessagingPolicy, counterpartyPubky: string, operation: string): void {
  if (!policy.isMuted(counterpartyPubky)) return;
  throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'This person is muted.', {
    service: ErrorService.Local,
    operation,
    context: { reason: 'muted' },
  });
}
