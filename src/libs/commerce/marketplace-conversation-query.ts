import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Logger } from '@/libs/logger/logger';
import { parseDmConversationId } from '@/libs/messaging/dm-contracts';
import { parseConversationAggregateId } from './messaging-contracts';

export const INVALID_CONVERSATION_QUERY_REASON = 'invalid_conversation_query';

export type MarketplaceConversationQueryResult =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'other-account' }
  | { status: 'open'; sellerPubky: string; buyerPubky: string; listingId: string };

/**
 * `/marketplace/messages?conversation=` gate. Listing grammar only. Fail-closed.
 * Never returns the raw query string — callers must not log it.
 */
export function resolveMarketplaceConversationQuery(input: {
  values: readonly string[];
  currentUserPubky: string | null | undefined;
}): MarketplaceConversationQueryResult {
  if (input.values.length === 0) return { status: 'absent' };
  if (input.values.length !== 1) return { status: 'invalid' };

  const value = input.values[0];
  if (!value) return { status: 'invalid' };
  if (parseDmConversationId(value)) return { status: 'invalid' };

  const parsed = parseConversationAggregateId(value);
  if (!parsed) return { status: 'invalid' };

  const current = input.currentUserPubky;
  if (!current || (current !== parsed.sellerPubky && current !== parsed.buyerPubky)) {
    return { status: 'other-account' };
  }

  return { status: 'open', ...parsed };
}

/** Telemetry for a rejected query. Bound reason only — never the raw id. */
export function reportRejectedConversationQuery(): void {
  Logger.warn('Marketplace conversation query rejected', { reason: INVALID_CONVERSATION_QUERY_REASON });
}

export function marketplaceConversationHref(conversationId: string): string {
  return `${MARKETPLACE_ROUTES.MESSAGES}?conversation=${encodeURIComponent(conversationId)}`;
}

export function parseListingAggregateId(value: string): { sellerPubky: string; listingId: string } | null {
  if (!value.startsWith('listing:')) return null;
  const rest = value.slice('listing:'.length);
  const sellerPubky = rest.slice(0, 52);
  const separator = rest[52];
  const listingId = rest.slice(53);
  if (sellerPubky.length !== 52 || (separator !== '_' && separator !== ':') || !listingId) return null;
  return { sellerPubky, listingId };
}

export function listingIdFromOrder(order: {
  sellerPubky: string;
  lines: readonly { listingAggregateId: string }[];
}): string | null {
  const line = order.lines[0];
  if (!line) return null;
  return parseListingAggregateId(line.listingAggregateId)?.listingId ?? null;
}
