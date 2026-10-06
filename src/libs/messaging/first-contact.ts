import { z } from 'zod';
import { commerceEntityIdSchema, commercePubkySchema } from '@/libs/commerce/transaction-contracts';

/**
 * First contact: how a buyer reaches a seller they have never talked to.
 *
 * The transport cannot list inbound handshakes, so the seller learns about a
 * new buyer from two public facts the buyer writes on their own homeserver:
 * a follow of the seller (which puts the buyer in the seller's followers) and
 * one conversation request per listing:
 *
 *   pubky://{buyer}/pub/pubky.app/marketplace/v1/conversation-requests/{seller}/{listingId}
 *
 * The request carries no message. Only the path is trusted: the homeserver
 * lets nobody but the buyer write under the buyer's `/pub`, so the path names
 * the buyer, the seller and the listing. The JSON fields must repeat exactly
 * those values or the document is ignored.
 *
 * Nothing here knows how messages travel. The same rules hold for any link
 * runtime that authenticates the peer of each message.
 */

export const CONVERSATION_REQUEST_KIND = 'marketplace.conversation_request.v0';
export const CONVERSATION_REQUESTS_PATH = '/pub/pubky.app/marketplace/v1/conversation-requests/';

/** At most this many new people a buyer can message in {@link FIRST_CONTACT_WINDOW_MS}. */
export const FIRST_CONTACT_MAX_NEW_COUNTERPARTIES = 5;
export const FIRST_CONTACT_WINDOW_MS = 60 * 60 * 1000;

/** At most this many inbound messages stored per counterparty in {@link RECEIVE_CAP_WINDOW_MS}. */
export const RECEIVE_CAP_MAX_MESSAGES = 20;
export const RECEIVE_CAP_WINDOW_MS = 60 * 1000;

/**
 * Where a conversation lives on the receiving side. `request`: the other
 * person is someone this account does not know yet, so the thread sits in
 * Requests and never counts as unread. `known`: the inbox. Rows written before
 * first contact existed carry no origin and are treated as `known`.
 */
export type ConversationOrigin = 'request' | 'known';

export const conversationRequestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal(CONVERSATION_REQUEST_KIND),
    seller_pubky: commercePubkySchema,
    buyer_pubky: commercePubkySchema,
    listing_id: commerceEntityIdSchema,
    created_at: z.number().int().nonnegative(),
  })
  .strict();

export type ConversationRequest = z.infer<typeof conversationRequestSchema>;

/** `pubky://{buyer}/pub/pubky.app/marketplace/v1/conversation-requests/{seller}/` */
export function conversationRequestDirectoryUrl(buyerPubky: string, sellerPubky: string): string {
  return `pubky://${commercePubkySchema.parse(buyerPubky)}${CONVERSATION_REQUESTS_PATH}${commercePubkySchema.parse(sellerPubky)}/`;
}

export function conversationRequestUrl(buyerPubky: string, sellerPubky: string, listingId: string): string {
  return `${conversationRequestDirectoryUrl(buyerPubky, sellerPubky)}${commerceEntityIdSchema.parse(listingId)}`;
}

export function buildConversationRequest(input: {
  sellerPubky: string;
  buyerPubky: string;
  listingId: string;
  createdAt: number;
}): ConversationRequest {
  return conversationRequestSchema.parse({
    version: 1,
    kind: CONVERSATION_REQUEST_KIND,
    seller_pubky: input.sellerPubky,
    buyer_pubky: input.buyerPubky,
    listing_id: input.listingId,
    created_at: input.createdAt,
  });
}

/**
 * The listing id a request URL names, or `null` when the URL is not a direct
 * child of `directoryUrl` with a path-safe listing id.
 */
export function listingIdFromRequestUrl(url: string, directoryUrl: string): string | null {
  if (!url.startsWith(directoryUrl)) return null;
  const name = url.slice(directoryUrl.length);
  return commerceEntityIdSchema.safeParse(name).success ? name : null;
}

/**
 * The request document read from `pubky://{documentOwner}/…/{sellerPubky}/{listingId}`,
 * or `null` unless every field repeats what the path says. The buyer is the
 * document owner, never the `buyer_pubky` it claims.
 */
export function parseBoundConversationRequest(
  raw: unknown,
  path: { documentOwner: string; sellerPubky: string; listingId: string },
): ConversationRequest | null {
  if (path.documentOwner === path.sellerPubky) return null;
  const parsed = conversationRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const request = parsed.data;
  if (request.buyer_pubky !== path.documentOwner) return null;
  if (request.seller_pubky !== path.sellerPubky) return null;
  if (request.listing_id !== path.listingId) return null;
  return request;
}

/**
 * Whether messaging `counterpartyPubky` now would pass the buyer's limit of
 * {@link FIRST_CONTACT_MAX_NEW_COUNTERPARTIES} new people per rolling hour.
 * `firstContacts` holds when each earlier new person was first messaged, on
 * this device's clock. Writing to someone already in the window again does
 * not count twice.
 */
export function isFirstContactAllowed(
  firstContacts: readonly { counterpartyPubky: string; at: number }[],
  counterpartyPubky: string,
  now: number,
): boolean {
  const recent = new Set<string>();
  for (const entry of firstContacts) {
    if (entry.at > now - FIRST_CONTACT_WINDOW_MS && entry.at <= now) recent.add(entry.counterpartyPubky);
  }
  if (recent.has(counterpartyPubky)) return true;
  return recent.size < FIRST_CONTACT_MAX_NEW_COUNTERPARTIES;
}
