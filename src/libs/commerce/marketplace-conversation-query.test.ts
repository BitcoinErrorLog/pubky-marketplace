import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@/libs/logger/logger';
import { buildDmConversationId } from '@/libs/messaging/dm-contracts';
import {
  INVALID_CONVERSATION_QUERY_REASON,
  listingIdFromOrder,
  marketplaceConversationHref,
  parseListingAggregateId,
  reportRejectedConversationQuery,
  resolveMarketplaceConversationQuery,
} from './marketplace-conversation-query';
import { MESSAGING_COPY } from './messaging-copy';
import { buildMarketplaceConversationAggregateId } from './transaction-commands';

const SELLER = 's'.repeat(52);
const BUYER = 'b'.repeat(52);
const OTHER = 'o'.repeat(52);
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';
const CONVERSATION_ID = buildMarketplaceConversationAggregateId(SELLER, BUYER, LISTING_ID);

describe('resolveMarketplaceConversationQuery', () => {
  it('returns absent when the query key is missing', () => {
    expect(resolveMarketplaceConversationQuery({ values: [], currentUserPubky: BUYER })).toEqual({ status: 'absent' });
  });

  it('fail-closes malformed, empty, array, and dm: values without opening a thread', () => {
    expect(resolveMarketplaceConversationQuery({ values: [''], currentUserPubky: BUYER })).toEqual({
      status: 'invalid',
    });
    expect(resolveMarketplaceConversationQuery({ values: ['not-a-conversation'], currentUserPubky: BUYER })).toEqual({
      status: 'invalid',
    });
    expect(resolveMarketplaceConversationQuery({ values: ['conversation:short'], currentUserPubky: BUYER })).toEqual({
      status: 'invalid',
    });
    expect(
      resolveMarketplaceConversationQuery({ values: [CONVERSATION_ID, CONVERSATION_ID], currentUserPubky: BUYER }),
    ).toEqual({ status: 'invalid' });
    expect(
      resolveMarketplaceConversationQuery({
        values: [buildDmConversationId(SELLER)],
        currentUserPubky: BUYER,
      }),
    ).toEqual({ status: 'invalid' });
  });

  it('fail-closes when the signed-in pubky is not a participant', () => {
    expect(resolveMarketplaceConversationQuery({ values: [CONVERSATION_ID], currentUserPubky: OTHER })).toEqual({
      status: 'other-account',
    });
    expect(resolveMarketplaceConversationQuery({ values: [CONVERSATION_ID], currentUserPubky: null })).toEqual({
      status: 'other-account',
    });
  });

  it('opens only for the seller or buyer named in the listing conversation id', () => {
    expect(resolveMarketplaceConversationQuery({ values: [CONVERSATION_ID], currentUserPubky: BUYER })).toEqual({
      status: 'open',
      sellerPubky: SELLER,
      buyerPubky: BUYER,
      listingId: LISTING_ID,
    });
    expect(resolveMarketplaceConversationQuery({ values: [CONVERSATION_ID], currentUserPubky: SELLER })).toEqual({
      status: 'open',
      sellerPubky: SELLER,
      buyerPubky: BUYER,
      listingId: LISTING_ID,
    });
  });
});

describe('reportRejectedConversationQuery', () => {
  it('logs a bound reason and never the raw conversation id', () => {
    const warn = vi.spyOn(Logger, 'warn');
    reportRejectedConversationQuery();
    expect(warn).toHaveBeenCalledWith('Marketplace conversation query rejected', {
      reason: INVALID_CONVERSATION_QUERY_REASON,
    });
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain(CONVERSATION_ID);
    expect(serialized).not.toContain(SELLER);
    expect(serialized).not.toContain(BUYER);
    expect(serialized).not.toContain(LISTING_ID);
    warn.mockRestore();
  });
});

describe('listing aggregate helpers', () => {
  it('parses underscore listing aggregates and extracts the listing id without requiring a seller match', () => {
    const aggregateId = `listing:${SELLER}_${LISTING_ID}`;
    expect(parseListingAggregateId(aggregateId)).toEqual({ sellerPubky: SELLER, listingId: LISTING_ID });
    expect(listingIdFromOrder({ sellerPubky: SELLER, lines: [{ listingAggregateId: aggregateId }] })).toBe(LISTING_ID);
    expect(listingIdFromOrder({ sellerPubky: BUYER, lines: [{ listingAggregateId: aggregateId }] })).toBe(LISTING_ID);
  });

  it('builds an inbox href that the marketplace route can parse', () => {
    const href = marketplaceConversationHref(CONVERSATION_ID);
    expect(href.startsWith('/marketplace/messages?conversation=')).toBe(true);
    const value = new URL(href, 'https://shop.pubky.app').searchParams.getAll('conversation');
    expect(resolveMarketplaceConversationQuery({ values: value, currentUserPubky: BUYER }).status).toBe('open');
  });
});

describe('MESSAGING_COPY', () => {
  it('explains the follow on the first message in one plain line', () => {
    expect(MESSAGING_COPY.followOnSend).toBe('Sending also follows this shop so they can see your message.');
  });
});
