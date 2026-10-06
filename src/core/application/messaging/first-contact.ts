import { followUriBuilder } from 'pubky-app-specs';
import { CommercePrivKeyringApplication } from '@/application/commerce/priv-keyring';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { NEXUS_USER_IDS_MAX_LIMIT } from '@/config/nexus';
import { newPrivEntryName, privErrorSummary, type PrivKeyring } from '@/libs/commerce/priv-envelope';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { hasHttpStatus, isAppError, isNotFound } from '@/libs/error/error.utils';
import { HttpMethod, HttpStatusCode } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import {
  buildConversationRequest,
  type ConversationOrigin,
  conversationRequestDirectoryUrl,
  conversationRequestUrl,
  isFirstContactAllowed,
  listingIdFromRequestUrl,
  parseBoundConversationRequest,
  RECEIVE_CAP_MAX_MESSAGES,
  RECEIVE_CAP_WINDOW_MS,
} from '@/libs/messaging/first-contact';
import { FollowGraphPager } from '@/libs/messaging/follow-graph-pager';
import type { MessagingPolicy } from '@/libs/messaging/intake-gate';
import {
  buildMuteChange,
  foldMuteChanges,
  LEGACY_MUTE_LIST_ENTRY_ID,
  MUTE_CHANGE_KIND,
  type MuteChange,
  MUTED_PEOPLE_MAX,
  mutedPubkys,
  type MuteState,
  parseLegacyMuteList,
  parseMuteChange,
} from '@/libs/messaging/mute-list';
import { CommercePrivStoreService } from '@/services/homeserver/commerce/priv-store';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { LocalMessagingService } from '@/services/local/messaging/messaging';

const MUTES_FAMILY = 'messaging_mutes';

/** Followers whose request directories one sync lists. */
export const FIRST_CONTACT_MAX_REQUEST_SOURCES = 20;
/**
 * Ids per follow-graph page one sync reads. The Nexus user-ids stream
 * rejects a larger `limit` with a 400, and one page is exactly the request
 * directories a sync lists.
 */
export const FIRST_CONTACT_FOLLOW_PAGE_SIZE = Math.min(NEXUS_USER_IDS_MAX_LIMIT, FIRST_CONTACT_MAX_REQUEST_SOURCES);
/** Request documents read from one buyer per sync. */
export const FIRST_CONTACT_MAX_REQUESTS_PER_BUYER = 10;

/**
 * The account's mute list as far as this device can tell.
 *
 * - `ready`: the list was read (or confirmed absent).
 * - `unavailable`: this Shop has no private storage, so muting is not
 *   offered and nobody is muted.
 * - `needs_approval` / `needs_reauth`: the list cannot be read until the user
 *   approves again (the private keys, or the homeserver session).
 * - `error`: the read failed or the stored list could not be opened.
 *
 * Only a fresh `ready` or `unavailable` lets anything contact a counterparty:
 * in every other state the policy cannot tell who is muted, so nothing is
 * opened, sent, flushed or received.
 */
export type MessagingMutesState =
  | { kind: 'ready'; muted: ReadonlySet<string> }
  | { kind: 'unavailable' }
  | { kind: 'needs_approval' }
  | { kind: 'needs_reauth' }
  | { kind: 'error' };

/** The outcome of a mute or unmute: the new state, or `full` when nothing was changed because the list is at its limit. */
export type MuteChangeResult = MessagingMutesState | { kind: 'full' };

/** Why the first message to a seller was not allowed, or what it did. */
export type FirstContactPreparation =
  | { kind: 'limited' }
  | { kind: 'ready'; firstMessage: false }
  | { kind: 'ready'; firstMessage: true; newCounterparty: boolean };

export type ConversationRequestWrite = 'written' | 'kept' | 'failed';

/**
 * Shop policy for first contact, above the message transport: who lands in
 * Requests, who is muted, the buyer's public conversation request, and the
 * limits on new people and inbound volume. It never sends, receives or
 * decrypts. The transport sees it only through the intake gate of a {@link MessagingPolicy}.
 *
 * All caches are in memory, per owner, and dropped by {@link clear} at
 * sign-out.
 */
export class FirstContactApplication {
  private constructor() {}

  /** Decrypted mute records by entry name. Records are never rewritten, so a name always holds the same change. */
  private static muteRecords = new Map<string, Map<string, MuteChange>>();
  private static muteQueue = new Map<string, Promise<unknown>>();
  private static knownContacts = new Map<string, ReadonlySet<string>>();
  private static orderCounterparties = new Map<string, ReadonlySet<string>>();
  private static seenRequests = new Set<string>();
  private static rateLimitedCounts = new Map<string, number>();
  private static followGraphPagers = new Map<string, FollowGraphPager>();

  // --- mutes --------------------------------------------------------------

  /**
   * Reads the mute log from `/priv` now. Only a read that lists the log and
   * opens every record in it is `ready`; any failure is reported as such,
   * even when an earlier read of this session succeeded, because a mute
   * added on another device since then would be missing.
   */
  static async loadMutes(ownerPubky: string): Promise<MessagingMutesState> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return { kind: 'unavailable' };
    return await this.inMuteQueue(ownerPubky, () => this.readMutes(ownerPubky));
  }

  private static async readMutes(ownerPubky: string): Promise<MessagingMutesState> {
    const keys = await CommercePrivKeyringApplication.get(ownerPubky);
    const read =
      keys.kind === 'keys'
        ? await this.readMuteLog(ownerPubky, keys.keyring)
        : ({ kind: keys.kind === 'needs_reauth' ? 'needs_approval' : 'error' } as const);
    if (read.kind !== 'log') {
      return { kind: read.kind };
    }
    return { kind: 'ready', muted: mutedPubkys(read.state) };
  }

  /**
   * Lists the log and opens every record in it. A record that does not open
   * or is not a valid change of this owner makes the whole read fail: the
   * list cannot be confirmed while any mute in it is unreadable.
   */
  private static async readMuteLog(
    ownerPubky: string,
    keyring: PrivKeyring,
  ): Promise<{ kind: 'log'; state: MuteState } | { kind: 'needs_reauth' | 'error' }> {
    try {
      const legacyPayload = await CommercePrivStoreService.read(keyring, MUTES_FAMILY, LEGACY_MUTE_LIST_ENTRY_ID);
      const legacy = legacyPayload === null ? [] : parseLegacyMuteList(legacyPayload, ownerPubky);
      if (!legacy) {
        Logger.warn('The earlier mute list is not valid; the mute list cannot be confirmed');
        return { kind: 'error' };
      }
      const names = await CommercePrivStoreService.listAllNames(keyring, MUTES_FAMILY);
      const known = this.muteRecords.get(ownerPubky) ?? new Map<string, MuteChange>();
      const records = new Map<string, MuteChange>();
      for (const name of names) {
        let change = known.get(name);
        if (!change) {
          const payload = await CommercePrivStoreService.readListed(keyring, MUTES_FAMILY, name);
          if (payload === null) {
            Logger.warn('A listed mute record is missing; the mute list cannot be confirmed');
            return { kind: 'error' };
          }
          const parsed = parseMuteChange(payload, ownerPubky);
          if (!parsed) {
            Logger.warn('A mute record is not valid; the mute list cannot be confirmed');
            return { kind: 'error' };
          }
          change = parsed;
        }
        records.set(name, change);
      }
      this.muteRecords.set(ownerPubky, records);
      return { kind: 'log', state: foldMuteChanges([...legacy, ...records.values()]) };
    } catch (error) {
      if (this.isPrivateAccessDenied(error)) return { kind: 'needs_reauth' };
      Logger.warn('Could not read the mute list', privErrorSummary(error));
      return { kind: 'error' };
    }
  }

  /** Runs one owner's mute reads and changes one after another in this tab. */
  private static async inMuteQueue<T>(ownerPubky: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.muteQueue.get(ownerPubky) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    this.muteQueue.set(
      ownerPubky,
      run.catch(() => undefined),
    );
    return await run;
  }

  /**
   * Mutes or unmutes one person by adding one sealed record to the log,
   * after reading the whole log: a log that cannot be read is not written
   * to, a change that is already in effect adds nothing, and a new mute past
   * {@link MUTED_PEOPLE_MAX} is refused (`full`). The change counts only
   * once the record reads back. Records are never rewritten, so a change
   * made on another device or tab at the same time is never lost.
   */
  static async setMuted(ownerPubky: string, counterpartyPubky: string, muted: boolean): Promise<MuteChangeResult> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return { kind: 'unavailable' };
    if (ownerPubky === counterpartyPubky) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'You cannot mute yourself.', {
        service: ErrorService.Local,
        operation: 'setMuted',
      });
    }
    return await this.inMuteQueue(ownerPubky, () => this.addMuteChange(ownerPubky, counterpartyPubky, muted));
  }

  private static async addMuteChange(
    ownerPubky: string,
    counterpartyPubky: string,
    muted: boolean,
  ): Promise<MuteChangeResult> {
    const keys = await CommercePrivKeyringApplication.get(ownerPubky);
    if (keys.kind !== 'keys') {
      return { kind: keys.kind === 'needs_reauth' ? 'needs_approval' : 'error' };
    }
    const read = await this.readMuteLog(ownerPubky, keys.keyring);
    if (read.kind !== 'log') {
      return { kind: read.kind };
    }
    const current = mutedPubkys(read.state);
    if ((read.state.get(counterpartyPubky)?.muted ?? false) === muted) {
      return { kind: 'ready', muted: current };
    }
    if (muted && current.size >= MUTED_PEOPLE_MAX) {
      Logger.warn('The mute list is full; nothing was changed', { reason: 'mute_list_full' });
      return { kind: 'full' };
    }
    const change = buildMuteChange({ ownerPubky, counterpartyPubky, muted, now: Date.now(), state: read.state });
    const name = newPrivEntryName();
    try {
      await CommercePrivStoreService.writeListed(keys.keyring, MUTES_FAMILY, name, change);
    } catch (error) {
      if (this.isPrivateAccessDenied(error)) return { kind: 'needs_reauth' };
      Logger.warn('Could not save the mute change', privErrorSummary(error));
      return { kind: 'error' };
    }
    const records = new Map(this.muteRecords.get(ownerPubky) ?? []);
    records.set(name, change);
    this.muteRecords.set(ownerPubky, records);
    const state = foldMuteChanges([
      ...[...read.state].map(([counterparty, entry]) =>
        buildFoldedChange(ownerPubky, counterparty, entry.muted, entry.changed_at),
      ),
      change,
    ]);
    return { kind: 'ready', muted: mutedPubkys(state) };
  }

  /**
   * 403 or 401 on `/priv` for a session a new approval can widen. A grant
   * session already holds the full Shop grant, so a refusal there is not
   * something the user can fix by approving again.
   */
  private static isPrivateAccessDenied(error: unknown): boolean {
    const denied = hasHttpStatus(error, HttpStatusCode.FORBIDDEN) || hasHttpStatus(error, HttpStatusCode.UNAUTHORIZED);
    return denied && !HomeserverService.isCurrentSessionGrant();
  }

  // --- intake -------------------------------------------------------------

  /**
   * The confirmed policy for one operation, or `null` when `mutes` is not a
   * fresh successful read (nothing may contact anyone then). Its gate refuses
   * muted people, caps each person at the receive cap per minute on this
   * device's clock (counted from what is stored, so a reload or another tab
   * does not reset it), and files a message that starts a thread with someone
   * this account does not know under Requests.
   */
  static policyFor(ownerPubky: string, mutes: MessagingMutesState): MessagingPolicy | null {
    if (mutes.kind !== 'ready' && mutes.kind !== 'unavailable') return null;
    const muted = mutes.kind === 'ready' ? new Set(mutes.muted) : new Set<string>();
    return {
      isMuted: (counterpartyPubky) => muted.has(counterpartyPubky),
      gate: {
        admit: async ({ counterpartyPubky }) => {
          if (muted.has(counterpartyPubky)) return { store: false, reason: 'muted' };
          const stored = await LocalMessagingService.countStoredInbound(
            ownerPubky,
            counterpartyPubky,
            Date.now() - RECEIVE_CAP_WINDOW_MS,
          );
          if (stored >= RECEIVE_CAP_MAX_MESSAGES) {
            this.rateLimitedCounts.set(ownerPubky, (this.rateLimitedCounts.get(ownerPubky) ?? 0) + 1);
            return { store: false, reason: 'rate_limited' };
          }
          return { store: true, origin: await this.originFor(ownerPubky, counterpartyPubky) };
        },
      },
    };
  }

  /** How many messages the receive cap refused since the last call, then resets. */
  static takeRateLimitedCount(ownerPubky: string): number {
    const count = this.rateLimitedCounts.get(ownerPubky) ?? 0;
    this.rateLimitedCounts.delete(ownerPubky);
    return count;
  }

  // --- Requests -----------------------------------------------------------

  /**
   * The people this account knows without having talked to them: the people
   * it follows and its order and offer counterparties. Replaced on every
   * inbox sync.
   */
  static setKnownContacts(
    ownerPubky: string,
    contacts: { following: Iterable<string>; orderCounterparties: Iterable<string> },
  ): void {
    const orderCounterparties = new Set(contacts.orderCounterparties);
    this.orderCounterparties.set(ownerPubky, orderCounterparties);
    this.knownContacts.set(ownerPubky, new Set([...contacts.following, ...orderCounterparties]));
  }

  /** Where the account's inbox sync is in its walk through one of its follow lists. */
  static followGraphPager(ownerPubky: string, reach: 'following' | 'followers'): FollowGraphPager {
    const key = `${ownerPubky}:${reach}`;
    let pager = this.followGraphPagers.get(key);
    if (!pager) {
      pager = new FollowGraphPager(FIRST_CONTACT_FOLLOW_PAGE_SIZE);
      this.followGraphPagers.set(key, pager);
    }
    return pager;
  }

  /**
   * Whether the person shares an order or offer with this account. Both
   * sides of an order already find each other, so a first message about it
   * needs no follow or request.
   */
  static isOrderCounterparty(ownerPubky: string, counterpartyPubky: string): boolean {
    return this.orderCounterparties.get(ownerPubky)?.has(counterpartyPubky) ?? false;
  }

  /**
   * `known` when the account follows the person, shares an order or offer
   * with them, has an inbox thread with them already, or has written to
   * them; otherwise `request`.
   */
  static async originFor(ownerPubky: string, counterpartyPubky: string): Promise<ConversationOrigin> {
    if (this.knownContacts.get(ownerPubky)?.has(counterpartyPubky)) return 'known';
    const conversations = await LocalMessagingService.getConversationsByOwner(ownerPubky);
    if (
      conversations.some(
        (conversation) => conversation.counterparty_pubky === counterpartyPubky && conversation.origin !== 'request',
      )
    ) {
      return 'known';
    }
    return (await LocalMessagingService.hasSentTo(ownerPubky, counterpartyPubky)) ? 'known' : 'request';
  }

  /** Moves Requests from people who have since become known into the inbox. */
  static async promoteKnownRequests(ownerPubky: string): Promise<void> {
    const known = this.knownContacts.get(ownerPubky) ?? new Set<string>();
    const promoted = new Set<string>();
    for (const conversation of await LocalMessagingService.getConversationsByOwner(ownerPubky)) {
      if (conversation.origin !== 'request' || promoted.has(conversation.counterparty_pubky)) continue;
      const pubky = conversation.counterparty_pubky;
      if (known.has(pubky) || (await LocalMessagingService.hasSentTo(ownerPubky, pubky))) {
        promoted.add(pubky);
        await LocalMessagingService.markCounterpartyKnown(ownerPubky, pubky);
      }
    }
  }

  /** Accepts a person: every thread with them moves from Requests to the inbox. */
  static async accept(ownerPubky: string, counterpartyPubky: string): Promise<void> {
    await LocalMessagingService.markCounterpartyKnown(ownerPubky, counterpartyPubky);
  }

  /**
   * Seller side: lists the conversation requests each follower wrote for
   * this seller and adds one listing thread per valid request. Only the
   * request's path is trusted (the buyer's own `/pub`), and every JSON field
   * must repeat it. Returns the buyers with at least one valid request, so
   * the sync probes them first. A buyer whose directory cannot be read is
   * skipped until the next pass. Once `shouldContinue` answers false nothing
   * more is remembered or stored.
   */
  static async discoverRequests(
    sellerPubky: string,
    followerPubkys: readonly string[],
    muted: ReadonlySet<string>,
    shouldContinue: () => boolean = () => true,
  ): Promise<string[]> {
    const requesters: string[] = [];
    for (const buyerPubky of followerPubkys.slice(0, FIRST_CONTACT_MAX_REQUEST_SOURCES)) {
      if (!shouldContinue()) return requesters;
      if (buyerPubky === sellerPubky || muted.has(buyerPubky)) continue;
      let urls: string[];
      const directoryUrl = conversationRequestDirectoryUrl(buyerPubky, sellerPubky);
      try {
        urls = await HomeserverService.list({
          baseDirectory: directoryUrl,
          limit: FIRST_CONTACT_MAX_REQUESTS_PER_BUYER,
        });
      } catch (error) {
        if (!(isAppError(error) && isNotFound(error))) {
          Logger.warn('Could not list a follower’s conversation requests', { reason: 'request_list_failed' });
        }
        continue;
      }
      let found = false;
      for (const url of urls) {
        const listingId = listingIdFromRequestUrl(url, directoryUrl);
        if (!listingId) continue;
        if (await this.addRequestThread(sellerPubky, buyerPubky, listingId, shouldContinue)) found = true;
      }
      if (found) requesters.push(buyerPubky);
    }
    return requesters;
  }

  private static async addRequestThread(
    sellerPubky: string,
    buyerPubky: string,
    listingId: string,
    shouldContinue: () => boolean,
  ): Promise<boolean> {
    const seenKey = `${sellerPubky}:${buyerPubky}:${listingId}`;
    if (!this.seenRequests.has(seenKey)) {
      let raw: unknown;
      try {
        raw = await HomeserverService.request<unknown>({
          method: HttpMethod.GET,
          url: conversationRequestUrl(buyerPubky, sellerPubky, listingId),
        });
      } catch {
        return false;
      }
      if (!parseBoundConversationRequest(raw, { documentOwner: buyerPubky, sellerPubky, listingId })) return false;
      if (!shouldContinue()) return false;
      this.seenRequests.add(seenKey);
    }
    const conversationId = buildMarketplaceConversationAggregateId(sellerPubky, buyerPubky, listingId);
    if (await LocalMessagingService.getConversation(sellerPubky, conversationId)) return true;
    const origin = await this.originFor(sellerPubky, buyerPubky);
    if (!shouldContinue()) return false;
    await LocalMessagingService.touchConversation({
      owner_id: sellerPubky,
      conversation_id: conversationId,
      kind: 'listing',
      listing_ref: buildMarketplaceListingAggregateId(sellerPubky, listingId),
      counterparty_pubky: buyerPubky,
      last_message_at: null,
      updated_at: Date.now(),
      origin,
    });
    return true;
  }

  // --- the buyer's first message ------------------------------------------

  /**
   * Decides whether the buyer may send in this listing thread now. Only the
   * first message of a thread does first-contact work; the first message to
   * a new person also counts against the limit of new people per hour,
   * which refuses before anything is followed, written or sent.
   */
  static async prepareFirstContact(
    buyerPubky: string,
    sellerPubky: string,
    listingId: string,
  ): Promise<FirstContactPreparation> {
    const conversationId = buildMarketplaceConversationAggregateId(sellerPubky, buyerPubky, listingId);
    const history = await LocalMessagingService.getMessages(buyerPubky, conversationId);
    const queued = await LocalMessagingService.getQueuedMessages(buyerPubky, sellerPubky);
    if (
      history.some((message) => message.direction === 'sent') ||
      queued.some((row) => row.conversation_id === conversationId)
    ) {
      return { kind: 'ready', firstMessage: false };
    }
    const newCounterparty = !(await LocalMessagingService.hasHistoryWith(buyerPubky, sellerPubky));
    if (newCounterparty) {
      const firstContacts = await LocalMessagingService.getFirstContacts(buyerPubky);
      if (!isFirstContactAllowed(firstContacts, sellerPubky, Date.now())) return { kind: 'limited' };
    }
    return { kind: 'ready', firstMessage: true, newCounterparty };
  }

  /**
   * Claims the first message to a new person against the limit on new
   * people per hour, atomically with every other claim in any tab. Called
   * before anything is followed, written or sent.
   */
  static async claimFirstContact(
    buyerPubky: string,
    sellerPubky: string,
    listingId: string,
  ): Promise<'claimed' | 'limited'> {
    return await LocalMessagingService.claimFirstContact(
      {
        ownerId: buyerPubky,
        conversationId: buildMarketplaceConversationAggregateId(sellerPubky, buyerPubky, listingId),
        listingRef: buildMarketplaceListingAggregateId(sellerPubky, listingId),
        counterpartyPubky: sellerPubky,
        at: Date.now(),
      },
      isFirstContactAllowed,
    );
  }

  /**
   * Whether the buyer's follow of the seller is on the buyer's homeserver.
   * Throws when the answer is unknown.
   */
  static async isFollowing(followerPubky: string, followeePubky: string): Promise<boolean> {
    try {
      await HomeserverService.request({ method: HttpMethod.GET, url: followUriBuilder(followerPubky, followeePubky) });
      return true;
    } catch (error) {
      if (isAppError(error) && isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Publishes the buyer's conversation request for one listing. Reads it
   * first: a valid request is kept as it is, a missing or invalid one is
   * written, and a failed read writes nothing.
   */
  static async writeConversationRequest(
    buyerPubky: string,
    sellerPubky: string,
    listingId: string,
  ): Promise<ConversationRequestWrite> {
    const url = conversationRequestUrl(buyerPubky, sellerPubky, listingId);
    try {
      const existing = await HomeserverService.request<unknown>({ method: HttpMethod.GET, url });
      if (parseBoundConversationRequest(existing, { documentOwner: buyerPubky, sellerPubky, listingId })) {
        return 'kept';
      }
    } catch (error) {
      if (!(isAppError(error) && isNotFound(error))) {
        Logger.warn('Could not read the conversation request; nothing was written', { reason: 'request_read_failed' });
        return 'failed';
      }
    }
    try {
      await HomeserverService.request({
        method: HttpMethod.PUT,
        url,
        bodyJson: buildConversationRequest({ sellerPubky, buyerPubky, listingId, createdAt: Date.now() }),
      });
      return 'written';
    } catch {
      Logger.warn('Could not publish the conversation request', { reason: 'request_write_failed' });
      return 'failed';
    }
  }

  /**
   * Account switch without a sign-out: forgets the walk positions, contact
   * sets, seen requests, mute records and counters of every account but
   * `keepPubky`.
   */
  static clearOtherAccounts(keepPubky: string): void {
    const ownedBy = (key: string) => key === keepPubky || key.startsWith(`${keepPubky}:`);
    for (const map of [
      this.muteRecords,
      this.muteQueue,
      this.knownContacts,
      this.orderCounterparties,
      this.rateLimitedCounts,
    ]) {
      for (const key of [...map.keys()]) if (!ownedBy(key)) map.delete(key);
    }
    for (const key of [...this.followGraphPagers.keys()]) if (!ownedBy(key)) this.followGraphPagers.delete(key);
    for (const key of [...this.seenRequests]) if (!ownedBy(key)) this.seenRequests.delete(key);
  }

  /** Sign-out teardown: forgets every cached list, contact set and counter. */
  static clear(): void {
    this.muteQueue.clear();
    this.muteRecords.clear();
    this.knownContacts.clear();
    this.orderCounterparties.clear();
    this.seenRequests.clear();
    this.rateLimitedCounts.clear();
    this.followGraphPagers.clear();
  }
}

/** One entry of a folded state, as the change record it stands for. */
function buildFoldedChange(
  ownerPubky: string,
  counterpartyPubky: string,
  muted: boolean,
  changedAt: number,
): MuteChange {
  return {
    version: 1,
    kind: MUTE_CHANGE_KIND,
    owner_pubky: ownerPubky,
    counterparty_pubky: counterpartyPubky,
    muted,
    changed_at: changedAt,
  };
}
