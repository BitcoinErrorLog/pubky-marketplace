import { describe, expect, it } from 'vitest';
import { RING_COOKIE_CAPABILITIES } from '@/config/app';
import { asInvalid } from '@/test-utils/type-assertions';
import {
  bodyByteSize,
  buildChatMessage,
  chatMessageBodyBudget,
  chatMessageByteSize,
  decodeChatMessage,
  isListingConversationBound,
  listingConversationBetween,
  MARKETPLACE_CHAT_MESSAGE_KIND,
  parseConversationAggregateId,
  PAYKIT_MESSAGING_CAPABILITY,
  PAYKIT_NOISE_MESSAGE_MAX_BYTES,
} from './messaging-contracts';
import { buildMarketplaceConversationAggregateId, buildMarketplaceListingAggregateId } from './transaction-commands';

const SELLER = 's'.repeat(52);
const BUYER = 'b'.repeat(52);
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';
const CONVERSATION_ID = buildMarketplaceConversationAggregateId(SELLER, BUYER, LISTING_ID);
const LISTING_REF = buildMarketplaceListingAggregateId(SELLER, LISTING_ID);
const EVENT_ID = '5b3f9a0e-8f2c-4f4e-9d35-1c2b4a6d8e01';
const SENT_AT = 1_756_742_400_000;
const LEGACY_ISO_SENT_AT = '2026-08-21T10:00:00.000Z';
const LEGACY_ISO_SENT_AT_MS = Date.parse(LEGACY_ISO_SENT_AT);

function build(body: string) {
  return buildChatMessage({
    eventId: EVENT_ID,
    conversationId: CONVERSATION_ID,
    listingRef: LISTING_REF,
    sentAt: SENT_AT,
    body,
  });
}

describe('marketplace chat message contract', () => {
  it('keeps the messaging capability byte-identical to the Ring cookie sign-in request', () => {
    expect(PAYKIT_MESSAGING_CAPABILITY).toBe(RING_COOKIE_CAPABILITIES);
  });

  it('builds a valid envelope and reports its true serialized size', () => {
    const { message, json, byteSize } = build('Is this still available?');
    expect(message.kind).toBe(MARKETPLACE_CHAT_MESSAGE_KIND);
    expect(message.version).toBe(1);
    expect(message.sent_at).toBe(SENT_AT);
    expect(typeof JSON.parse(json).sent_at).toBe('number');
    expect(JSON.parse(json)).toEqual(message);
    expect(byteSize).toBe(new TextEncoder().encode(json).byteLength);
    expect(byteSize).toBeLessThanOrEqual(PAYKIT_NOISE_MESSAGE_MAX_BYTES);
  });

  it('trims the body and rejects whitespace-only messages', () => {
    expect(build('  hello  ').message.body).toBe('hello');
    expect(() => build('   ')).toThrow();
  });

  it('accepts a body exactly at the budget and rejects one byte over', () => {
    const budget = chatMessageBodyBudget(CONVERSATION_ID, LISTING_REF);
    const exact = 'a'.repeat(budget);
    expect(build(exact).byteSize).toBe(PAYKIT_NOISE_MESSAGE_MAX_BYTES);
    expect(() => build(`${exact}a`)).toThrow(/too long/);
  });

  it('counts JSON escaping and multi-byte UTF-8 against the budget, not characters', () => {
    // One quote character serializes as two bytes (\"), one emoji as four.
    expect(bodyByteSize('"')).toBe(2);
    expect(bodyByteSize('\u{1F511}')).toBe(4);
    const budget = chatMessageBodyBudget(CONVERSATION_ID, LISTING_REF);
    const quotes = '"'.repeat(budget); // 2x the bytes of its character count
    expect(() => build(quotes)).toThrow(/too long/);
  });

  it('keeps the budget stable across event ids and timestamps (fixed-width fields)', () => {
    const budget = chatMessageBodyBudget(CONVERSATION_ID, LISTING_REF);
    const withOtherIds = buildChatMessage({
      eventId: crypto.randomUUID(),
      conversationId: CONVERSATION_ID,
      listingRef: LISTING_REF,
      sentAt: Date.now(),
      body: 'x'.repeat(budget),
    });
    expect(withOtherIds.byteSize).toBe(PAYKIT_NOISE_MESSAGE_MAX_BYTES);
  });

  it('rejects ISO-8601 sent_at on the send path', () => {
    expect(() =>
      buildChatMessage({
        eventId: EVENT_ID,
        conversationId: CONVERSATION_ID,
        listingRef: LISTING_REF,
        sentAt: asInvalid<number>(LEGACY_ISO_SENT_AT),
        body: 'no iso on emit',
      }),
    ).toThrow();
  });

  it('round-trips through decode and skips foreign or malformed payloads', () => {
    const { json, message } = build('round trip');
    expect(decodeChatMessage(json)).toEqual(message);
    expect(decodeChatMessage('not json at all')).toBeNull();
    expect(decodeChatMessage(JSON.stringify({ version: 1, kind: 'paykit.payment_request.v0' }))).toBeNull();
    expect(decodeChatMessage(JSON.stringify({ ...message, event_id: 'not-a-uuid' }))).toBeNull();
  });

  it('accepts a Unix-ms sent_at on inbound decode', () => {
    const { message } = build('unix-ms inbound');
    expect(decodeChatMessage(JSON.stringify(message))).toEqual(message);
  });

  it('accepts a legacy ISO-8601 sent_at on inbound decode and normalizes to Unix-ms', () => {
    const { message } = build('legacy iso inbound');
    const decoded = decodeChatMessage(JSON.stringify({ ...message, sent_at: LEGACY_ISO_SENT_AT }));
    expect(decoded).toEqual({ ...message, sent_at: LEGACY_ISO_SENT_AT_MS });
    expect(typeof decoded?.sent_at).toBe('number');
  });

  it('rejects missing or invalid inbound sent_at', () => {
    const { message } = build('invalid sent_at');
    expect(decodeChatMessage(JSON.stringify({ ...message, sent_at: undefined }))).toBeNull();
    expect(decodeChatMessage(JSON.stringify({ ...message, sent_at: '1756742400000' }))).toBeNull();
    expect(decodeChatMessage(JSON.stringify({ ...message, sent_at: null }))).toBeNull();
    expect(decodeChatMessage(JSON.stringify({ ...message, sent_at: 1e30 }))).toBeNull();
    expect(decodeChatMessage(JSON.stringify({ ...message, sent_at: 8.64e15 + 1 }))).toBeNull();
    expect(decodeChatMessage(JSON.stringify({ ...message, sent_at: 2 ** 53 + 1 }))).toBeNull();
  });

  it('parses conversation aggregate ids back into participants and listing', () => {
    expect(parseConversationAggregateId(CONVERSATION_ID)).toEqual({
      sellerPubky: SELLER,
      buyerPubky: BUYER,
      listingId: LISTING_ID,
    });
    expect(parseConversationAggregateId('listing:whatever')).toBeNull();
    expect(parseConversationAggregateId('conversation:short')).toBeNull();
  });

  it('measures envelopes consistently with chatMessageByteSize', () => {
    const { message, byteSize } = build('size check');
    expect(chatMessageByteSize(message)).toBe(byteSize);
  });
});

describe('listing conversation binding', () => {
  const OTHER = 'y'.repeat(52);

  it('binds a conversation to its seller and buyer in either link direction', () => {
    const bound = { conversationId: CONVERSATION_ID, listingRef: LISTING_REF };
    expect(isListingConversationBound({ ...bound, ownerPubky: SELLER, counterpartyPubky: BUYER })).toBe(true);
    expect(isListingConversationBound({ ...bound, ownerPubky: BUYER, counterpartyPubky: SELLER })).toBe(true);
  });

  it('rejects a conversation that names anyone other than the two link endpoints', () => {
    const bound = { conversationId: CONVERSATION_ID, listingRef: LISTING_REF };
    expect(isListingConversationBound({ ...bound, ownerPubky: SELLER, counterpartyPubky: OTHER })).toBe(false);
    expect(isListingConversationBound({ ...bound, ownerPubky: OTHER, counterpartyPubky: BUYER })).toBe(false);
    expect(isListingConversationBound({ ...bound, ownerPubky: SELLER, counterpartyPubky: SELLER })).toBe(false);
  });

  it('rejects a listing_ref that is not the seller listing the conversation names', () => {
    const endpoints = { conversationId: CONVERSATION_ID, ownerPubky: SELLER, counterpartyPubky: BUYER };
    expect(isListingConversationBound({ ...endpoints, listingRef: null })).toBe(false);
    expect(
      isListingConversationBound({ ...endpoints, listingRef: buildMarketplaceListingAggregateId(BUYER, LISTING_ID) }),
    ).toBe(false);
    expect(isListingConversationBound({ ...endpoints, listingRef: `listing:${SELLER}:${LISTING_ID}` })).toBe(false);
  });

  it('rejects malformed ids and listing ids that are not path-safe', () => {
    expect(
      isListingConversationBound({
        conversationId: `dm:${BUYER}`,
        listingRef: LISTING_REF,
        ownerPubky: SELLER,
        counterpartyPubky: BUYER,
      }),
    ).toBe(false);
    expect(
      isListingConversationBound({
        conversationId: buildMarketplaceConversationAggregateId(SELLER, BUYER, 'a/b'),
        listingRef: buildMarketplaceListingAggregateId(SELLER, 'a/b'),
        ownerPubky: SELLER,
        counterpartyPubky: BUYER,
      }),
    ).toBe(false);
  });

  it('listingConversationBetween checks participants only', () => {
    expect(listingConversationBetween(CONVERSATION_ID, BUYER, SELLER)).toEqual({
      sellerPubky: SELLER,
      buyerPubky: BUYER,
      listingId: LISTING_ID,
    });
    expect(listingConversationBetween(CONVERSATION_ID, BUYER, OTHER)).toBeNull();
    expect(listingConversationBetween('conversation:short', BUYER, SELLER)).toBeNull();
  });
});
