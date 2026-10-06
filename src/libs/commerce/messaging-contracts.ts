import { z } from 'zod';
import { RING_COOKIE_CAPABILITIES } from '@/config/app';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { PAM_SENT_AT_UNIX_MS_PLACEHOLDER, pamSentAtEmitSchema, parsePamSentAt } from '@/libs/messaging/pam-sent-at';
import { buildMarketplaceListingAggregateId } from './transaction-commands';
import { commerceEntityIdSchema } from './transaction-contracts';

/**
 * The homeserver capability the encrypted-messaging session asks Pubky Ring to
 * grant. It covers the Paykit tree (`/pub/paykit/…`) where receiver markers,
 * handshake slots, and encrypted message slots live — PLUS the app's own
 * `/pub/pubky.app/` scope. The second scope is load-bearing, not scope creep:
 * the homeserver keeps ONE session cookie per user per origin (the cookie is
 * named after the pubky), so approving this session REPLACES the app session
 * in the browser. A paykit-only grant therefore broke every pubky.app write
 * (posts, uploads, listings) with 403 "Session does not have write access to
 * path" until the user signed in again — reproduced empirically 2026-08-21
 * (see scripts/probe-media-write.mjs). The session that wins the cookie must
 * be able to do everything the app needs, so this stays exactly equal to the
 * Ring cookie sign-in request (`src/config/app.ts` RING_COOKIE_CAPABILITIES)
 * — including the private watchlist scope and pubky.app's scopes — by
 * deriving from it, not duplicating it. Shown verbatim in the approval UI.
 */
export const PAYKIT_MESSAGING_CAPABILITY = RING_COOKIE_CAPABILITIES;

/**
 * The Paykit receiver path this app publishes its messaging receiver marker
 * under, and looks counterparties up at. One receiver per identity per app
 * surface; both parties must use the same value for discovery to converge.
 * The runtime segment is CONSTRAINED by paykit-lib to `wallet` or `server`
 * (verified live: publishing `marketplace/web` is rejected with a validation
 * error); this browser runtime holds the receiver key itself, which is the
 * `wallet` role.
 */
export const PAYKIT_MESSAGING_RECEIVER_PATH = 'marketplace/wallet';

/** Private Application Message kind for a marketplace chat message. */
export const MARKETPLACE_CHAT_MESSAGE_KIND = 'marketplace.chat_message.v0';

/**
 * Maximum size of one Private Application Message — the ENTIRE serialized JSON
 * envelope, not just the body. This mirrors `pubky_noise`'s fixed message
 * buffer; the vendored binding's `maxNoiseMessageLen()` returns the same value
 * and a real-crypto test asserts they agree. Oversize sends are rejected
 * client-side before the crypto layer rejects them anyway.
 */
export const PAYKIT_NOISE_MESSAGE_MAX_BYTES = 1000;

/**
 * `marketplace.chat_message.v0` — one chat message inside a listing-scoped
 * conversation, carried as a Paykit Private Application Message (Encrypted
 * Link, Noise XX). Designed minimally so the 1000-byte envelope ceiling leaves
 * usable body room:
 *
 * - `version`/`kind`: the Paykit envelope contract (`version` u8, `kind`
 *   string; unknown kinds are legal upstream and are skipped by this client).
 * - `event_id`: UUID; messages are Event Messages — every one matters, and
 *   receivers dedupe by this id (crash replay after a restored snapshot is
 *   expected and must be idempotent).
 * - `conversation_id`: the conversation aggregate reference
 *   (`conversation:{seller}_{buyer}_{listingId}`), the same id the sandbox
 *   transport uses, so a conversation is a (listing, participants) pair. The
 *   sender is implicit in the link direction and deliberately NOT a field —
 *   the Noise link already authenticates it, and a spoofable sender field
 *   would be worse than none. For the same reason receivers never trust this
 *   id as written: it must pass {@link isListingConversationBound} against
 *   the link endpoints or the message is dropped.
 * - `listing_ref`: the listing aggregate id (`listing:{seller}_{listingId}`),
 *   so the receiving side can render the listing context without parsing the
 *   conversation id.
 * - `sent_at`: sender's wall clock, Unix-millisecond integer. Display
 *   ordering only — receipt order on each device is the stream order.
 *   Emitters MUST write a JSON number; ISO-8601 is invalid on the send path.
 * - `body`: the message text, trimmed, non-empty.
 */
export const marketplaceChatMessageSchema = z.object({
  version: z.literal(1),
  kind: z.literal(MARKETPLACE_CHAT_MESSAGE_KIND),
  event_id: z.uuid(),
  conversation_id: z.string().min(1).max(256),
  listing_ref: z.string().min(1).max(256),
  sent_at: pamSentAtEmitSchema,
  body: z.string().min(1),
});

export type MarketplaceChatMessage = z.infer<typeof marketplaceChatMessageSchema>;

const utf8 = new TextEncoder();

/** Serialized byte size of a chat message envelope as it would go on the wire. */
export function chatMessageByteSize(message: MarketplaceChatMessage): number {
  return utf8.encode(JSON.stringify(message)).byteLength;
}

/**
 * Builds and validates a sendable chat message envelope, enforcing the
 * 1000-byte Noise ceiling on the SERIALIZED size (JSON escaping and multi-byte
 * UTF-8 count against the budget, so a character limit alone would lie).
 * Throws on oversize instead of truncating — the composer shows the live
 * budget and the send path never silently drops content.
 */
export function buildChatMessage(input: {
  eventId: string;
  conversationId: string;
  listingRef: string;
  sentAt: number;
  body: string;
}): { message: MarketplaceChatMessage; json: string; byteSize: number } {
  const candidate = {
    version: 1 as const,
    kind: MARKETPLACE_CHAT_MESSAGE_KIND,
    event_id: input.eventId,
    conversation_id: input.conversationId,
    listing_ref: input.listingRef,
    sent_at: input.sentAt,
    body: input.body.trim(),
  };
  const parsed = marketplaceChatMessageSchema.safeParse(candidate);
  if (!parsed.success) {
    throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Chat message envelope is invalid.', {
      service: ErrorService.Paykit,
      operation: 'buildChatMessage',
      context: { issues: parsed.error.issues.map(({ path, code }) => `${path.join('.')}:${code}`) },
    });
  }
  const json = JSON.stringify(parsed.data);
  const byteSize = utf8.encode(json).byteLength;
  if (byteSize > PAYKIT_NOISE_MESSAGE_MAX_BYTES) {
    throw Err.validation(
      ValidationErrorCode.INVALID_INPUT,
      `Message is too long: ${byteSize} bytes serialized, limit ${PAYKIT_NOISE_MESSAGE_MAX_BYTES}.`,
      {
        service: ErrorService.Paykit,
        operation: 'buildChatMessage',
        context: { byteSize, limit: PAYKIT_NOISE_MESSAGE_MAX_BYTES },
      },
    );
  }
  return { message: parsed.data, json, byteSize };
}

/**
 * The byte budget available for the body of a message in this conversation:
 * the Noise ceiling minus the serialized envelope with an empty body. UUID
 * and Unix-ms `sent_at` fields are fixed-width (36 chars and 13 digits), so
 * the budget is stable while typing; the composer meters `bodyByteSize`
 * (serialized, escapes included) against it.
 */
export function chatMessageBodyBudget(conversationId: string, listingRef: string): number {
  const envelope: MarketplaceChatMessage = {
    version: 1,
    kind: MARKETPLACE_CHAT_MESSAGE_KIND,
    // Fixed-width placeholders: every UUID is 36 chars, every `sent_at` this
    // client writes is a 13-digit Unix-millisecond integer.
    event_id: '00000000-0000-4000-8000-000000000000',
    conversation_id: conversationId,
    listing_ref: listingRef,
    sent_at: PAM_SENT_AT_UNIX_MS_PLACEHOLDER,
    body: '',
  };
  return PAYKIT_NOISE_MESSAGE_MAX_BYTES - chatMessageByteSize(envelope);
}

/** Serialized byte cost of a body string inside a JSON envelope (escapes included). */
export function bodyByteSize(body: string): number {
  const json = JSON.stringify(body);
  // Strip the surrounding quotes JSON.stringify adds around the string value.
  return utf8.encode(json).byteLength - 2;
}

/**
 * Splits a `conversation:{seller}_{buyer}_{listingId}` aggregate id back into
 * its parts (pubkys are fixed-width 52-char z-base-32). Returns `null` when
 * the id does not have that shape.
 */
export function parseConversationAggregateId(
  conversationId: string,
): { sellerPubky: string; buyerPubky: string; listingId: string } | null {
  if (!conversationId.startsWith('conversation:')) return null;
  const value = conversationId.slice('conversation:'.length);
  const sellerPubky = value.slice(0, 52);
  const buyerPubky = value.slice(53, 105);
  const listingId = value.slice(106);
  if (sellerPubky.length !== 52 || buyerPubky.length !== 52 || !listingId) return null;
  if (value[52] !== '_' || value[105] !== '_') return null;
  return { sellerPubky, buyerPubky, listingId };
}

/**
 * Whether a listing conversation names exactly the two ends of the Encrypted
 * Link it travels on. Only the link endpoints are authenticated (the owner's
 * session and the counterparty the Noise handshake was bound to); the
 * envelope's `conversation_id` and `listing_ref` are written by the sender and
 * prove nothing on their own. A conversation is bound when its seller and
 * buyer are those two pubkys in either role, the listing id is a path-safe
 * commerce id, and `listing_ref` is the seller's listing the conversation
 * names. Anything else could file one contact's text inside a thread with
 * someone else.
 */
export function isListingConversationBound(input: {
  conversationId: string;
  listingRef: string | null;
  ownerPubky: string;
  counterpartyPubky: string;
}): boolean {
  const parsed = listingConversationBetween(input.conversationId, input.ownerPubky, input.counterpartyPubky);
  if (!parsed) return false;
  if (!commerceEntityIdSchema.safeParse(parsed.listingId).success) return false;
  return input.listingRef === buildMarketplaceListingAggregateId(parsed.sellerPubky, parsed.listingId);
}

/**
 * The participant half of {@link isListingConversationBound}: the parsed
 * conversation when its seller and buyer are exactly `ownerPubky` and
 * `counterpartyPubky` (in either role), otherwise `null`. Stored rows are
 * checked with this alone, because thread membership is what decides which
 * history a row appears in.
 */
export function listingConversationBetween(
  conversationId: string,
  ownerPubky: string,
  counterpartyPubky: string,
): { sellerPubky: string; buyerPubky: string; listingId: string } | null {
  if (ownerPubky === counterpartyPubky) return null;
  const parsed = parseConversationAggregateId(conversationId);
  if (!parsed) return null;
  const { sellerPubky, buyerPubky } = parsed;
  const endpointsMatch =
    (sellerPubky === ownerPubky && buyerPubky === counterpartyPubky) ||
    (sellerPubky === counterpartyPubky && buyerPubky === ownerPubky);
  return endpointsMatch ? parsed : null;
}

/**
 * Decodes one received Private Application Message. Returns `null` for
 * payloads that are not a valid `marketplace.chat_message.v0` (unknown kinds
 * are legal on a shared link and are skipped, never treated as an error).
 *
 * Inbound `sent_at` accepts a Unix-ms integer or a legacy ISO-8601 string
 * and always normalizes to a Unix-ms number, matching `decodeDmMessage` on
 * the same Encrypted Link.
 */
export function decodeChatMessage(rawJson: string): MarketplaceChatMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const sentAt = parsePamSentAt((value as { sent_at?: unknown }).sent_at);
  if (sentAt === null) return null;
  const parsed = marketplaceChatMessageSchema.safeParse({ ...value, sent_at: sentAt });
  return parsed.success ? parsed.data : null;
}
