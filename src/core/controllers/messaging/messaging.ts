import { z } from 'zod';
import { CommerceApplication } from '@/application/commerce/commerce';
import {
  FIRST_CONTACT_FOLLOW_PAGE_SIZE,
  FirstContactApplication,
  type MessagingMutesState,
  type MuteChangeResult,
} from '@/application/messaging/first-contact';
import { MessagingApplication, type MessagingThreadState } from '@/application/messaging/messaging';
import { UserStreamApplication } from '@/application/stream/users/users';
import { UserApplication } from '@/application/user/user';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { parseConversationAggregateId } from '@/libs/commerce/messaging-contracts';
import { MESSAGING_COPY, messagingReportText } from '@/libs/commerce/messaging-copy';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { commercePubkySchema } from '@/libs/commerce/transaction-contracts';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { hasHttpStatus } from '@/libs/error/error.utils';
import { HttpMethod, HttpStatusCode } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import { buildDmConversationId, parseDmConversationId } from '@/libs/messaging/dm-contracts';
import type { MessagingPolicy } from '@/libs/messaging/intake-gate';
import {
  MESSAGING_STATUS_TIMEOUT_MS,
  MESSAGING_SYNC_PASS_TIMEOUT_MS,
  MESSAGING_SYNC_RESUME_TIMEOUT_MS,
  withPassDeadline,
} from '@/libs/messaging/pass-deadline';
import type { Pubky } from '@/models/models.types';
import { buildUserCompositeId } from '@/models/stream/user/userStream.helper';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { FollowNormalizer } from '@/pipes/follow/follow.normalizer';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useMessagingStore } from '@/stores/messaging/messaging.store';

/**
 * Controller for end-to-end-encrypted messaging: marketplace listing
 * conversations AND general direct messages over the same per-counterparty
 * Encrypted Links (the marketplace sandbox's plaintext transport stays on
 * `CommerceController`). Manages the messaging store — the application layer
 * never touches stores.
 */
export class MessagingController {
  private constructor() {}

  /**
   * Starts the "enable encrypted messaging" Ring flow. On approval the public
   * fact (the enabled pubky, never the session handle) mirrors into the
   * messaging store so dependent surfaces refetch. Flows are single-use;
   * retries must call this again.
   */
  static async beginMessagingEnable() {
    const ownerPubky = this.getCurrentUserPubky();
    const flow = await MessagingApplication.beginEnableFlow(ownerPubky);
    return {
      authorizationUrl: flow.authorizationUrl,
      awaitEnabled: async () => {
        const enabled = await flow.awaitEnabled();
        useMessagingStore.getState().setMessagingEnabled(enabled.pubky);
        return enabled;
      },
      cancel: flow.cancel,
    };
  }

  /**
   * The messaging status of the signed-in account. A read that does not
   * settle within {@link MESSAGING_STATUS_TIMEOUT_MS} rejects with a timeout
   * so the surface can show the delay; the session resume and receiver
   * check it started keep going, and the next status read joins them. A
   * republished-key notice that read takes after the timeout is kept for
   * the next read, which a surface does show.
   */
  static async getMessagingStatus() {
    const ownerPubky = this.getCurrentUserPubky();
    let expired = false;
    const read = MessagingApplication.getStatus(ownerPubky);
    read.then(
      (status) => {
        if (expired && status.ownKeyRepublished) {
          MessagingApplication.returnOwnKeyRepublished(ownerPubky, status.ownKeyRepublished);
        }
      },
      () => undefined,
    );
    return await withPassDeadline(read, {
      timeoutMs: MESSAGING_STATUS_TIMEOUT_MS,
      operation: 'getMessagingStatus',
      message: MESSAGING_COPY.statusTimeout,
      onExpire: () => {
        expired = true;
        Logger.warn('The messaging status read did not settle; the surface retries', { reason: 'status_timeout' });
      },
    });
  }

  /** Sign-out teardown: drops the session, link handles, and the store fact. */
  static clearMessagingSession(): void {
    MessagingApplication.clearMessagingSession();
    useMessagingStore.getState().clearMessagingEnabled();
  }

  /**
   * The background sync pass for `ownerPubky` (`MessagingSyncCoordinator`).
   * It acts only where this browser already holds that exact account's
   * receiver key with its marker published, and it never creates, replaces
   * or publishes a key: the session resume and the whole pass run inside
   * {@link MessagingApplication.withoutReceiverProvisioning}. It stops at
   * the next step once `shouldContinue` answers false, once `ownerPubky` is
   * no longer the signed-in account, or once the receiver key differs from
   * the one it started with (another tab replaced it). A session resume that
   * does not settle within {@link MESSAGING_SYNC_RESUME_TIMEOUT_MS} ends the
   * pass and its hold; when it settles later it still touches no key.
   */
  static async syncInboxInBackground(ownerPubky: string, shouldContinue: () => boolean): Promise<'synced' | 'skipped'> {
    const isCurrent = () => shouldContinue() && useAuthStore.getState().currentUserPubky === ownerPubky;
    if (!isCurrent()) return 'skipped';
    const receiverKey = await MessagingApplication.publishedReceiverKey(ownerPubky);
    if (receiverKey === null || !isCurrent()) return 'skipped';
    return await MessagingApplication.withoutReceiverProvisioning(ownerPubky, async () => {
      const resumed = await withPassDeadline(MessagingApplication.resumeSession(ownerPubky), {
        timeoutMs: MESSAGING_SYNC_RESUME_TIMEOUT_MS,
        operation: 'backgroundMessagingResume',
        onExpire: () => {
          Logger.warn('The messaging session resume of a background sync did not settle; the pass stopped', {
            reason: 'background_resume_timeout',
          });
        },
      });
      if (!resumed || !isCurrent()) return 'skipped';
      if ((await MessagingApplication.publishedReceiverKey(ownerPubky)) !== receiverKey) {
        Logger.warn('The messaging key changed during a background sync; the pass stopped', {
          reason: 'receiver_replaced',
        });
        return 'skipped';
      }
      if (!isCurrent()) return 'skipped';
      await this.syncInbox({ ownerPubky, shouldContinue });
      return 'synced';
    });
  }

  static async isCounterpartyEnrolled(counterpartyPubky: unknown): Promise<boolean> {
    return await MessagingApplication.isCounterpartyEnrolled(CommerceRecordNormalizer.pubky(counterpartyPubky));
  }

  /**
   * Opens the encrypted conversation for a listing between the signed-in user
   * and a counterparty. The conversation id is the same aggregate reference
   * the sandbox transport uses (`conversation:{seller}_{buyer}_{listingId}`).
   * Nothing is opened with someone this account muted, and nothing at all
   * while the mute list cannot be confirmed (`paused`).
   */
  static async openConversation(
    sellerPubky: unknown,
    buyerPubky: unknown,
    listingId: unknown,
  ): Promise<{ state: MessagingThreadState; conversationId: string; counterpartyPubky: string }> {
    const { ownerPubky, counterpartyPubky, conversationId, listingRef } = this.resolveConversation(
      sellerPubky,
      buyerPubky,
      listingId,
    );
    const confirmed = await this.confirmPolicy(ownerPubky, counterpartyPubky);
    if (!confirmed.policy) return { state: confirmed.state, conversationId, counterpartyPubky };
    const state = await MessagingApplication.openConversation(
      ownerPubky,
      counterpartyPubky,
      conversationId,
      listingRef,
      confirmed.policy,
    );
    return { state, conversationId, counterpartyPubky };
  }

  /**
   * A listing conversation was opened, became visible again, or was retried:
   * the failed link and queued-send attempts with the other party run on
   * the next poll instead of waiting out their backoff. Memory only, and
   * never throws: a conversation that is not the signed-in account's
   * restarts nothing (its open reports why).
   */
  static restartConversationRetries(sellerPubky: unknown, buyerPubky: unknown): void {
    const ownerPubky = useAuthStore.getState().currentUserPubky;
    const seller = commercePubkySchema.safeParse(sellerPubky);
    const buyer = commercePubkySchema.safeParse(buyerPubky);
    if (!ownerPubky || !seller.success || !buyer.success || seller.data === buyer.data) return;
    if (ownerPubky === seller.data) MessagingApplication.restartRetries(ownerPubky, buyer.data);
    else if (ownerPubky === buyer.data) MessagingApplication.restartRetries(ownerPubky, seller.data);
  }

  /** {@link restartConversationRetries} for the direct-message conversation with `counterpartyPubky`. */
  static restartDmConversationRetries(counterpartyPubky: unknown): void {
    const ownerPubky = useAuthStore.getState().currentUserPubky;
    const counterparty = commercePubkySchema.safeParse(counterpartyPubky);
    if (!ownerPubky || !counterparty.success || counterparty.data === ownerPubky) return;
    MessagingApplication.restartRetries(ownerPubky, counterparty.data);
  }

  /** The inbox was opened, became visible again, or was retried: every conversation's failed attempts run soon. */
  static restartInboxRetries(): void {
    const ownerPubky = useAuthStore.getState().currentUserPubky;
    if (ownerPubky) MessagingApplication.restartRetries(ownerPubky);
  }

  static async pollConversation(sellerPubky: unknown, buyerPubky: unknown, listingId: unknown) {
    const { ownerPubky, counterpartyPubky } = this.resolveConversation(sellerPubky, buyerPubky, listingId);
    return await this.pollCounterparty(ownerPubky, counterpartyPubky);
  }

  /**
   * Queue-aware listing-chat send: delivers directly when the link is ready,
   * otherwise queues the message device-locally (validated against the same
   * byte ceiling) for automatic delivery. The result distinguishes the two —
   * the UI never labels a queued message sent.
   *
   * A buyer's first message in a listing thread first does the first-contact
   * work the seller needs to find them: it follows the seller and publishes
   * a conversation request for the listing. The first message to a new
   * person is refused, before anything is followed or written, once the
   * buyer reached the limit of new people per hour. `firstContact` reports
   * what happened so the dialog can tell the buyer when the seller may not
   * see the message yet. Writing to someone accepts them.
   */
  static async sendOrQueueMessage(sellerPubky: unknown, buyerPubky: unknown, listingId: unknown, body: string) {
    const resolved = this.resolveConversation(sellerPubky, buyerPubky, listingId);
    const { ownerPubky, counterpartyPubky, conversationId, listingRef } = resolved;
    const policy = await this.requirePolicy(ownerPubky, counterpartyPubky, 'sendOrQueueMessage');
    // A message that cannot be sent must not follow anyone or publish anything.
    MessagingApplication.assertSendableChat(ownerPubky, counterpartyPubky, { conversationId, listingRef, body });
    const firstContact =
      ownerPubky === resolved.buyerPubky
        ? await this.runFirstContact(ownerPubky, counterpartyPubky, resolved.listingId)
        : null;
    const outcome = await MessagingApplication.sendOrQueueMessage(
      ownerPubky,
      counterpartyPubky,
      { conversationId, listingRef, body },
      policy,
    );
    await FirstContactApplication.accept(ownerPubky, counterpartyPubky);
    return { ...outcome, firstContact };
  }

  /**
   * Whether the buyer's next send in this listing thread will follow the
   * seller, so the dialog can say so before Send. `false` when the answer is
   * unknown: the send still follows, and reports it.
   */
  static async willFollowOnSend(sellerPubky: unknown, buyerPubky: unknown, listingId: unknown): Promise<boolean> {
    const resolved = this.resolveConversation(sellerPubky, buyerPubky, listingId);
    if (resolved.ownerPubky !== resolved.buyerPubky) return false;
    if (FirstContactApplication.isOrderCounterparty(resolved.ownerPubky, resolved.counterpartyPubky)) return false;
    const preparation = await FirstContactApplication.prepareFirstContact(
      resolved.ownerPubky,
      resolved.counterpartyPubky,
      resolved.listingId,
    );
    if (preparation.kind !== 'ready' || !preparation.firstMessage) return false;
    try {
      return !(await FirstContactApplication.isFollowing(resolved.ownerPubky, resolved.counterpartyPubky));
    } catch {
      return false;
    }
  }

  private static async runFirstContact(buyerPubky: string, sellerPubky: string, listingId: string) {
    const preparation = await FirstContactApplication.prepareFirstContact(buyerPubky, sellerPubky, listingId);
    if (preparation.kind === 'limited') {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, MESSAGING_COPY.firstContactLimited, {
        service: ErrorService.Local,
        operation: 'sendOrQueueMessage',
        context: { reason: 'first_contact_limited' },
      });
    }
    if (!preparation.firstMessage) return null;
    if (FirstContactApplication.isOrderCounterparty(buyerPubky, sellerPubky)) return null;
    if (
      preparation.newCounterparty &&
      (await FirstContactApplication.claimFirstContact(buyerPubky, sellerPubky, listingId)) === 'limited'
    ) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, MESSAGING_COPY.firstContactLimited, {
        service: ErrorService.Local,
        operation: 'sendOrQueueMessage',
        context: { reason: 'first_contact_limited' },
      });
    }
    const followed = await this.followForFirstContact(buyerPubky, sellerPubky);
    const request = await FirstContactApplication.writeConversationRequest(buyerPubky, sellerPubky, listingId);
    return { followed, request };
  }

  /** Follows the seller unless the buyer already does. Never throws. */
  private static async followForFirstContact(
    buyerPubky: string,
    sellerPubky: string,
  ): Promise<'already' | 'followed' | 'failed'> {
    try {
      if (await FirstContactApplication.isFollowing(buyerPubky, sellerPubky)) return 'already';
      const { meta, follow } = FollowNormalizer.to({ follower: buyerPubky as Pubky, followee: sellerPubky as Pubky });
      await UserApplication.commitFollow({
        eventType: HttpMethod.PUT,
        followUrl: meta.url,
        followJson: follow.toJson(),
        follower: buyerPubky as Pubky,
        followee: sellerPubky as Pubky,
        activeStreamId: null,
      });
      return 'followed';
    } catch {
      Logger.warn('Could not follow the seller for a first message', { reason: 'first_contact_follow_failed' });
      return 'failed';
    }
  }

  /** Opens (or resumes) the general DM conversation with a counterparty. */
  static async openDmConversation(
    counterpartyPubky: unknown,
  ): Promise<{ state: MessagingThreadState; counterpartyPubky: string }> {
    const ownerPubky = this.getCurrentUserPubky();
    const counterparty = CommerceRecordNormalizer.pubky(counterpartyPubky);
    const confirmed = await this.confirmPolicy(ownerPubky, counterparty);
    if (!confirmed.policy) return { state: confirmed.state, counterpartyPubky: counterparty };
    const state = await MessagingApplication.openDmConversation(ownerPubky, counterparty, confirmed.policy);
    return { state, counterpartyPubky: counterparty };
  }

  /** One poll step for the DM surface: advance handshake + receive on the shared link. */
  static async pollDmConversation(counterpartyPubky: unknown) {
    const ownerPubky = this.getCurrentUserPubky();
    return await this.pollCounterparty(ownerPubky, CommerceRecordNormalizer.pubky(counterpartyPubky));
  }

  /** Queue-aware DM send — same contract as {@link sendOrQueueMessage}, without first-contact work. */
  static async sendOrQueueDmMessage(counterpartyPubky: unknown, body: string) {
    const ownerPubky = this.getCurrentUserPubky();
    const counterparty = CommerceRecordNormalizer.pubky(counterpartyPubky);
    const policy = await this.requirePolicy(ownerPubky, counterparty, 'sendOrQueueDmMessage');
    const outcome = await MessagingApplication.sendOrQueueDmMessage(ownerPubky, counterparty, body, policy);
    await FirstContactApplication.accept(ownerPubky, counterparty);
    return outcome;
  }

  /**
   * One poll step with one counterparty, on a fresh read of the mute list.
   * A muted person is not contacted at all, and while the list cannot be
   * confirmed nobody is: no handshake step, queued send or receive runs.
   */
  private static async pollCounterparty(
    ownerPubky: string,
    counterpartyPubky: string,
  ): Promise<{
    state: MessagingThreadState;
    received: Awaited<ReturnType<typeof MessagingApplication.pollConversation>>['received'];
    flushed: number;
    rateLimited: number;
  }> {
    const confirmed = await this.confirmPolicy(ownerPubky, counterpartyPubky);
    if (!confirmed.policy) return { state: confirmed.state, received: [], flushed: 0, rateLimited: 0 };
    const result = await MessagingApplication.pollConversation(ownerPubky, counterpartyPubky, confirmed.policy);
    return { ...result, rateLimited: FirstContactApplication.takeRateLimitedCount(ownerPubky) };
  }

  // --- key changes ----------------------------------------------------------

  /**
   * Accepts a counterparty's changed messaging key — exactly the key the
   * conversation showed (`acceptedKey`) — on a fresh read of the mute list.
   * Returns the conversation's new state.
   */
  static async acceptCounterpartyKey(counterpartyPubky: unknown, acceptedKey: unknown): Promise<MessagingThreadState> {
    const ownerPubky = this.getCurrentUserPubky();
    const counterparty = CommerceRecordNormalizer.pubky(counterpartyPubky);
    const key = CommerceRecordNormalizer.pubky(acceptedKey);
    const confirmed = await this.confirmPolicy(ownerPubky, counterparty);
    if (!confirmed.policy) return confirmed.state;
    return await MessagingApplication.acceptCounterpartyKey(ownerPubky, counterparty, key, confirmed.policy);
  }

  /** This device's messaging key and the one pinned for the counterparty, for the Verify step. */
  static async getMessagingKeys(counterpartyPubky: unknown) {
    return await MessagingApplication.getMessagingKeys(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.pubky(counterpartyPubky),
    );
  }

  // --- mutes, requests, report -------------------------------------------

  /** The signed-in account's mute list, read from private storage. */
  static async getMutes(): Promise<MessagingMutesState> {
    return await FirstContactApplication.loadMutes(this.getCurrentUserPubky());
  }

  /** Mutes or unmutes a person, then refreshes the unread fact. */
  static async setCounterpartyMuted(counterpartyPubky: unknown, muted: boolean): Promise<MuteChangeResult> {
    const ownerPubky = this.getCurrentUserPubky();
    const state = await FirstContactApplication.setMuted(
      ownerPubky,
      CommerceRecordNormalizer.pubky(counterpartyPubky),
      muted,
    );
    await this.refreshUnreadCount();
    return state;
  }

  /** Moves a person's Requests into the inbox. */
  static async acceptRequest(counterpartyPubky: unknown): Promise<void> {
    await FirstContactApplication.accept(this.getCurrentUserPubky(), CommerceRecordNormalizer.pubky(counterpartyPubky));
    await this.refreshUnreadCount();
  }

  /**
   * The text "Report" copies for one of the account's conversations: the
   * conversation id and the other account. Only ever given to the clipboard.
   */
  static async getReportDetails(conversationId: unknown): Promise<string> {
    const ownerPubky = this.getCurrentUserPubky();
    const id = this.normalizeConversationId(conversationId);
    const dm = parseDmConversationId(id);
    const counterpartyPubky = this.counterpartyOf(ownerPubky, id);
    if (!counterpartyPubky || counterpartyPubky === ownerPubky) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'This conversation is not on this account.', {
        service: ErrorService.Local,
        operation: 'getReportDetails',
      });
    }
    return messagingReportText({
      conversationId: dm ? buildDmConversationId(counterpartyPubky) : id,
      counterpartyPubky,
    });
  }

  /**
   * The confirmed policy for one operation with one person, from a fresh
   * read of the mute list, or the state to show instead: `paused` while the
   * list cannot be confirmed, `muted` for a muted person.
   */
  private static async confirmPolicy(
    ownerPubky: string,
    counterpartyPubky: string,
  ): Promise<{ policy: MessagingPolicy; state: null } | { policy: null; state: MessagingThreadState }> {
    const mutes = await FirstContactApplication.loadMutes(ownerPubky);
    const policy = FirstContactApplication.policyFor(ownerPubky, mutes);
    if (!policy) {
      const reason = mutes.kind === 'needs_approval' || mutes.kind === 'needs_reauth' ? mutes.kind : 'error';
      return { policy: null, state: { status: 'paused', reason } };
    }
    if (policy.isMuted(counterpartyPubky)) return { policy: null, state: { status: 'muted' } };
    return { policy, state: null };
  }

  /** {@link confirmPolicy} for a send: refuses with the reason instead of returning a state. */
  private static async requirePolicy(
    ownerPubky: string,
    counterpartyPubky: string,
    operation: string,
  ): Promise<MessagingPolicy> {
    const confirmed = await this.confirmPolicy(ownerPubky, counterpartyPubky);
    if (confirmed.policy) return confirmed.policy;
    const muted = confirmed.state.status === 'muted';
    throw Err.validation(
      ValidationErrorCode.INVALID_INPUT,
      muted ? MESSAGING_COPY.mutedSendRefused : MESSAGING_COPY.sendPausedForMutes,
      { service: ErrorService.Local, operation, context: { reason: muted ? 'muted' : 'mutes_unconfirmed' } },
    );
  }

  /**
   * The muted people from a fresh read of the mute list, for surfaces that
   * show message content, or `null` while the list cannot be confirmed: then
   * no row, preview, thread or count is shown at all.
   */
  private static async displayMutes(ownerPubky: string): Promise<ReadonlySet<string> | null> {
    const mutes = await FirstContactApplication.loadMutes(ownerPubky);
    if (mutes.kind === 'ready') return mutes.muted;
    return mutes.kind === 'unavailable' ? new Set<string>() : null;
  }

  /** The history of one conversation; empty while the mute list is unconfirmed or the other person is muted. */
  static async getConversationMessages(conversationId: unknown) {
    const ownerPubky = this.getCurrentUserPubky();
    const id = this.normalizeConversationId(conversationId);
    if (!(await this.mayShowConversation(ownerPubky, id))) return [];
    return await MessagingApplication.getConversationMessages(ownerPubky, id);
  }

  /** Device-locally queued (not yet sent) messages of one conversation, oldest first, gated like its history. */
  static async getQueuedConversationMessages(conversationId: unknown) {
    const ownerPubky = this.getCurrentUserPubky();
    const id = this.normalizeConversationId(conversationId);
    if (!(await this.mayShowConversation(ownerPubky, id))) return [];
    return await MessagingApplication.getQueuedMessagesForConversation(ownerPubky, id);
  }

  private static async mayShowConversation(ownerPubky: string, conversationId: string): Promise<boolean> {
    const muted = await this.displayMutes(ownerPubky);
    const counterpartyPubky = this.counterpartyOf(ownerPubky, conversationId);
    return muted !== null && counterpartyPubky !== null && !muted.has(counterpartyPubky);
  }

  /** The other person of one of the account's conversations, or `null` when it is not the account's. */
  private static counterpartyOf(ownerPubky: string, conversationId: string): string | null {
    const dm = parseDmConversationId(conversationId);
    if (dm) return dm.counterpartyPubky === ownerPubky ? null : dm.counterpartyPubky;
    const listing = parseConversationAggregateId(conversationId);
    if (!listing) return null;
    if (listing.sellerPubky === ownerPubky) return listing.buyerPubky === ownerPubky ? null : listing.buyerPubky;
    return listing.buyerPubky === ownerPubky ? listing.sellerPubky : null;
  }

  /** Deletes one of the signed-in user's queued messages while it is still queued. */
  static async cancelQueuedMessage(id: unknown): Promise<void> {
    await MessagingApplication.cancelQueuedMessage(this.getCurrentUserPubky(), this.normalizeOutboxId(id));
  }

  /**
   * The account's conversations after a fresh read of the mute list, and
   * that read's outcome. Threads with muted people are left out; while the
   * list cannot be confirmed no conversation is returned at all, so no row,
   * preview or sender is shown anywhere.
   */
  static async getConversations(): Promise<{
    mutes: MessagingMutesState['kind'];
    conversations: Awaited<ReturnType<typeof MessagingApplication.getConversations>>;
  }> {
    const ownerPubky = this.getCurrentUserPubky();
    const mutes = await FirstContactApplication.loadMutes(ownerPubky);
    if (mutes.kind !== 'ready' && mutes.kind !== 'unavailable') return { mutes: mutes.kind, conversations: [] };
    const muted = mutes.kind === 'ready' ? mutes.muted : new Set<string>();
    const conversations = await MessagingApplication.getConversations(ownerPubky);
    return {
      mutes: mutes.kind,
      conversations: conversations.filter((conversation) => !muted.has(conversation.counterparty_pubky)),
    };
  }

  /**
   * Moves a conversation's device-local read checkpoint to now and refreshes
   * the unread fact in the store. Called by conversation surfaces while they
   * are actually showing messages.
   */
  static async markConversationRead(conversationId: unknown): Promise<void> {
    const ownerPubky = this.getCurrentUserPubky();
    await MessagingApplication.markConversationRead(ownerPubky, this.normalizeConversationId(conversationId));
    await this.refreshUnreadCount();
  }

  /**
   * Recomputes the device-local unread conversation count and mirrors it into
   * the messaging store (the header/footer badges subscribe there). Honest by
   * construction: only messages already persisted on this device count.
   * Requests and muted people never count, and nothing counts while the
   * mute list cannot be confirmed.
   */
  static async refreshUnreadCount(): Promise<number> {
    const ownerPubky = useAuthStore.getState().currentUserPubky;
    if (!ownerPubky) {
      useMessagingStore.getState().setUnreadConversations(0);
      return 0;
    }
    const muted = await this.displayMutes(ownerPubky);
    const count = muted === null ? 0 : await MessagingApplication.getUnreadConversationCount(ownerPubky, muted);
    useMessagingStore.getState().setUnreadConversations(count);
    return count;
  }

  /**
   * The running sync pass per account, and whether it is a background pass
   * (one stopped by its caller's `shouldContinue`). A background pass joins
   * any running pass; a foreground call joins only a foreground one.
   */
  private static syncInFlight = new Map<
    string,
    { pass: Promise<{ mutes: MessagingMutesState['kind']; rateLimited: number }>; background: boolean }
  >();

  /**
   * One bounded inbox sync pass. The responder can only answer handshakes
   * from counterparties it can NAME (the binding cannot enumerate inbound
   * handshakes from strangers), so the naming set is assembled here:
   *
   * 1. Everyone with existing local messaging state (added inside the
   *    application layer, most recent first).
   * 2. Marketplace order/offer participants — only when a durable commerce
   *    mode is configured; general DMs never depend on the commerce adapter.
   * 3. One page each of the user's follows and followers, read from Nexus
   *    on every pass and advanced to the next page each pass, so every
   *    follower is named within one walk of the list. A buyer on the page
   *    who follows this seller and published a conversation request is
   *    probed first, and the request adds the listing thread right away.
   *
   * People this account does not follow and shares no order or offer with
   * land in Requests. Muted people are never probed. When the mute list
   * cannot be confirmed, nobody is contacted at all (no request discovery,
   * probe, handshake step, queued send or receive), and `mutes` says why.
   *
   * Any source failing to read degrades to the remaining sources instead of
   * failing the sync. Ends by refreshing the device-local unread fact. A
   * call while this account's pass is running joins that pass.
   *
   * The pass belongs to the account signed in when it started (or
   * `ownerPubky`). When that account signs out or another signs in, or
   * `shouldContinue` answers false, it starts nothing more: no follow-graph
   * walk, contact set, request thread, pair step or unread count is written
   * for the account that left. One pair step already running finishes. A
   * pass still running after {@link MESSAGING_SYNC_PASS_TIMEOUT_MS} is told
   * to stop the same way and rejects, so later calls start a new pass.
   *
   * A call without `shouldContinue` (the inbox on screen) never joins a
   * background pass, so it is never stopped or timed out by the background
   * caller's limits: it starts its own pass, which later calls join.
   */
  static async syncInbox(options?: {
    ownerPubky?: string;
    shouldContinue?: () => boolean;
  }): Promise<{ mutes: MessagingMutesState['kind']; rateLimited: number }> {
    const ownerPubky = options?.ownerPubky ?? this.getCurrentUserPubky();
    const background = options?.shouldContinue !== undefined;
    const running = this.syncInFlight.get(ownerPubky);
    if (running && (background || !running.background)) return await running.pass;
    let expired = false;
    const isCurrent = () =>
      !expired && useAuthStore.getState().currentUserPubky === ownerPubky && (options?.shouldContinue?.() ?? true);
    const pass = withPassDeadline(this.runInboxSync(ownerPubky, isCurrent), {
      timeoutMs: MESSAGING_SYNC_PASS_TIMEOUT_MS,
      operation: 'syncInbox',
      onExpire: () => {
        expired = true;
      },
    }).finally(() => {
      if (this.syncInFlight.get(ownerPubky)?.pass === pass) this.syncInFlight.delete(ownerPubky);
    });
    this.syncInFlight.set(ownerPubky, { pass, background });
    return await pass;
  }

  private static async runInboxSync(
    ownerPubky: string,
    isCurrent: () => boolean,
  ): Promise<{ mutes: MessagingMutesState['kind']; rateLimited: number }> {
    const mutes = await FirstContactApplication.loadMutes(ownerPubky);
    const stopped = { mutes: mutes.kind, rateLimited: 0 };
    if (!isCurrent()) return stopped;
    const policy = FirstContactApplication.policyFor(ownerPubky, mutes);
    if (!policy) {
      await this.refreshUnreadCount();
      return stopped;
    }
    const muted = mutes.kind === 'ready' ? mutes.muted : new Set<string>();
    const orderCounterparties = isDurableCommerceMode(getCommerceAdapterMode())
      ? await this.getMarketplaceCounterpartyCandidates(ownerPubky)
      : [];
    const { following, followers, knownFollowing } = await this.getFollowGraphCandidates(ownerPubky, isCurrent);
    if (!isCurrent()) return stopped;
    FirstContactApplication.setKnownContacts(ownerPubky, {
      following: knownFollowing,
      orderCounterparties: orderCounterparties.filter((pubky) => pubky !== ownerPubky),
    });
    const requesters = await FirstContactApplication.discoverRequests(ownerPubky, followers, muted, isCurrent);
    if (!isCurrent()) return stopped;
    const candidates = new Set([...orderCounterparties, ...following, ...followers]);
    candidates.delete(ownerPubky);
    await MessagingApplication.syncCounterparties(ownerPubky, [...candidates], {
      priorityPubkys: requesters,
      policy,
      shouldContinue: isCurrent,
    });
    if (!isCurrent()) return stopped;
    await FirstContactApplication.promoteKnownRequests(ownerPubky);
    if (!isCurrent()) return stopped;
    await this.refreshUnreadCount();
    return { mutes: mutes.kind, rateLimited: FirstContactApplication.takeRateLimitedCount(ownerPubky) };
  }

  /** Buyer/seller pubkys from the user's durable orders and offers; failures degrade to empty. */
  private static async getMarketplaceCounterpartyCandidates(ownerPubky: string): Promise<string[]> {
    const candidates = new Set<string>();
    const [orders, offers] = await Promise.allSettled([
      CommerceApplication.getMarketplaceOrders(ownerPubky),
      CommerceApplication.getMarketplaceOffers(ownerPubky),
    ]);
    if (orders.status === 'fulfilled') {
      for (const order of orders.value) {
        candidates.add(order.buyerPubky);
        candidates.add(order.sellerPubky);
      }
    } else {
      Logger.warn('Inbox sync could not read marketplace orders for counterparty candidates', {
        error: orders.reason,
      });
    }
    if (offers.status === 'fulfilled') {
      for (const offer of offers.value) {
        candidates.add(offer.buyerPubky);
        candidates.add(offer.sellerPubky);
      }
    } else {
      Logger.warn('Inbox sync could not read marketplace offers for counterparty candidates', {
        error: offers.reason,
      });
    }
    return [...candidates];
  }

  /**
   * This pass's page of the user's follows and of their followers, read from
   * Nexus (never the stream cache, which would hide anyone who followed
   * after it was filled), each one page further along its list than the
   * last pass ({@link FollowGraphPager}). `knownFollowing` is everyone on
   * the follows pages of the current and last walk, so a followed person
   * counts as known on every pass, not only on the pass that reads their
   * page. Failures degrade to empty and leave that list's walk where it was,
   * and so does every read once `isCurrent` answers false.
   */
  private static async getFollowGraphCandidates(
    ownerPubky: string,
    isCurrent: () => boolean,
  ): Promise<{ following: string[]; followers: string[]; knownFollowing: string[] }> {
    const reaches = ['following', 'followers'] as const;
    // Reading a pager creates it: an account that left must not get one back.
    if (!isCurrent()) return { following: [], followers: [], knownFollowing: [] };
    const pagers = {
      following: FirstContactApplication.followGraphPager(ownerPubky, 'following'),
      followers: FirstContactApplication.followGraphPager(ownerPubky, 'followers'),
    };
    const pages = await Promise.allSettled(
      reaches.map((reach) =>
        UserStreamApplication.fetchStreamIds({
          streamId: buildUserCompositeId({ userId: ownerPubky as Pubky, reach }),
          skip: pagers[reach].nextSkip(),
          limit: FIRST_CONTACT_FOLLOW_PAGE_SIZE,
          viewerId: ownerPubky as Pubky,
        }),
      ),
    );
    const graph = { following: [] as string[], followers: [] as string[] };
    if (!isCurrent()) return { ...graph, knownFollowing: [] };
    pages.forEach((page, index) => {
      const reach = reaches[index];
      if (page.status === 'fulfilled') {
        pagers[reach].record(page.value);
        graph[reach] = [...new Set(page.value)].filter((pubky) => pubky !== ownerPubky);
      } else if (hasHttpStatus(page.reason, HttpStatusCode.NOT_FOUND)) {
        // Nexus answers 404 for a list with nothing at this offset.
        pagers[reach].record([]);
      } else {
        Logger.warn('Inbox sync could not read the follow graph for counterparty candidates', {
          error: page.reason,
          context: { reach },
        });
      }
    });
    const knownFollowing = [...pagers.following.seen()].filter((pubky) => pubky !== ownerPubky);
    return { ...graph, knownFollowing };
  }

  /**
   * A conversation id is a LOCAL Dexie key, not a path-safe commerce entity
   * id (both shapes contain a colon): the marketplace aggregate
   * `conversation:{seller}_{buyer}_{listingId}` or the DM key
   * `dm:{counterpartyPubky}`. Anything else is rejected.
   */
  private static normalizeConversationId(input: unknown): string {
    if (typeof input === 'string' && (parseConversationAggregateId(input) || parseDmConversationId(input))) {
      return input;
    }
    throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Invalid messaging conversation id.', {
      service: ErrorService.Local,
      operation: 'normalizeConversationId',
    });
  }

  /** Outbox row ids are queue-time UUIDs (see the outbox schema). */
  private static normalizeOutboxId(input: unknown): string {
    if (typeof input === 'string' && z.uuid().safeParse(input).success) return input;
    throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Invalid queued message id.', {
      service: ErrorService.Local,
      operation: 'normalizeOutboxId',
    });
  }

  private static resolveConversation(sellerPubky: unknown, buyerPubky: unknown, listingId: unknown) {
    const seller = CommerceRecordNormalizer.pubky(sellerPubky);
    const buyer = CommerceRecordNormalizer.pubky(buyerPubky);
    const listing = CommerceRecordNormalizer.entityId(listingId);
    const ownerPubky = this.getCurrentUserPubky();
    if (seller === buyer || (ownerPubky !== seller && ownerPubky !== buyer)) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        'This conversation does not belong to the signed-in account.',
        {
          service: ErrorService.Local,
          operation: 'resolveConversation',
        },
      );
    }
    const counterpartyPubky = ownerPubky === seller ? buyer : seller;
    return {
      ownerPubky,
      counterpartyPubky,
      buyerPubky: buyer,
      listingId: listing,
      conversationId: buildMarketplaceConversationAggregateId(seller, buyer, listing),
      listingRef: buildMarketplaceListingAggregateId(seller, listing),
    };
  }

  private static getCurrentUserPubky(): string {
    return useAuthStore.getState().selectCurrentUserPubky();
  }
}
