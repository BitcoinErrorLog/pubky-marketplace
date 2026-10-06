import { describe, expect, it } from 'vitest';
import {
  buildConversationRequest,
  CONVERSATION_REQUEST_KIND,
  conversationRequestDirectoryUrl,
  conversationRequestUrl,
  FIRST_CONTACT_MAX_NEW_COUNTERPARTIES,
  FIRST_CONTACT_WINDOW_MS,
  isFirstContactAllowed,
  listingIdFromRequestUrl,
  parseBoundConversationRequest,
} from './first-contact';

const SELLER = 's'.repeat(52);
const BUYER = 'b'.repeat(52);
const OTHER = 'o'.repeat(52);
const LISTING = '0033GVVN22HJ0FYQGZZS8R2BFC';
const NOW = 1_790_000_000_000;

describe('conversation request paths', () => {
  it('puts the request under the buyer’s own /pub, in a directory named after the seller', () => {
    expect(conversationRequestDirectoryUrl(BUYER, SELLER)).toBe(
      `pubky://${BUYER}/pub/pubky.app/marketplace/v1/conversation-requests/${SELLER}/`,
    );
    expect(conversationRequestUrl(BUYER, SELLER, LISTING)).toBe(
      `pubky://${BUYER}/pub/pubky.app/marketplace/v1/conversation-requests/${SELLER}/${LISTING}`,
    );
  });

  it('refuses pubkys and listing ids that could escape the path', () => {
    expect(() => conversationRequestDirectoryUrl('../x', SELLER)).toThrow();
    expect(() => conversationRequestUrl(BUYER, SELLER, '../../follows/x')).toThrow();
  });

  it('reads the listing id only from a direct child of the directory', () => {
    const directory = conversationRequestDirectoryUrl(BUYER, SELLER);
    expect(listingIdFromRequestUrl(`${directory}${LISTING}`, directory)).toBe(LISTING);
    expect(listingIdFromRequestUrl(`${directory}a/b`, directory)).toBeNull();
    expect(listingIdFromRequestUrl(`${conversationRequestDirectoryUrl(BUYER, OTHER)}${LISTING}`, directory)).toBeNull();
  });
});

describe('parseBoundConversationRequest', () => {
  const path = { documentOwner: BUYER, sellerPubky: SELLER, listingId: LISTING };
  const valid = buildConversationRequest({
    sellerPubky: SELLER,
    buyerPubky: BUYER,
    listingId: LISTING,
    createdAt: NOW,
  });

  it('accepts a request whose fields repeat its path', () => {
    expect(valid.kind).toBe(CONVERSATION_REQUEST_KIND);
    expect(parseBoundConversationRequest(valid, path)).toEqual(valid);
  });

  it.each([
    ['another buyer', { ...valid, buyer_pubky: OTHER }],
    ['another seller', { ...valid, seller_pubky: OTHER }],
    ['another listing', { ...valid, listing_id: 'OTHER' }],
    ['an extra field', { ...valid, body: 'hello' }],
    ['another kind', { ...valid, kind: 'marketplace.chat_message.v0' }],
  ])('ignores a request that names %s', (_label, raw) => {
    expect(parseBoundConversationRequest(raw, path)).toBeNull();
  });

  it('ignores a request from the seller to itself', () => {
    const self = { ...valid, buyer_pubky: SELLER };
    expect(parseBoundConversationRequest(self, { ...path, documentOwner: SELLER })).toBeNull();
  });
});

describe('isFirstContactAllowed', () => {
  const recent = (count: number, at = NOW - 1_000) =>
    Array.from({ length: count }, (_, index) => ({ counterpartyPubky: String(index).padStart(52, 'c'), at }));

  it(`allows ${FIRST_CONTACT_MAX_NEW_COUNTERPARTIES} new people in the window and refuses the next`, () => {
    expect(isFirstContactAllowed(recent(FIRST_CONTACT_MAX_NEW_COUNTERPARTIES - 1), SELLER, NOW)).toBe(true);
    expect(isFirstContactAllowed(recent(FIRST_CONTACT_MAX_NEW_COUNTERPARTIES), SELLER, NOW)).toBe(false);
  });

  it('does not count someone already in the window twice', () => {
    const contacts = recent(FIRST_CONTACT_MAX_NEW_COUNTERPARTIES);
    expect(isFirstContactAllowed(contacts, contacts[0].counterpartyPubky, NOW)).toBe(true);
  });

  it('forgets contacts older than the window and ignores future-dated ones', () => {
    expect(
      isFirstContactAllowed(recent(FIRST_CONTACT_MAX_NEW_COUNTERPARTIES, NOW - FIRST_CONTACT_WINDOW_MS), SELLER, NOW),
    ).toBe(true);
    expect(isFirstContactAllowed(recent(FIRST_CONTACT_MAX_NEW_COUNTERPARTIES, NOW + 60_000), SELLER, NOW)).toBe(true);
  });
});
