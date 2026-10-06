export type AuctionPhase = 'upcoming' | 'live' | 'ended';

export function getAuctionPhase(
  startsAt: string,
  endsAt: string,
  nowMs: number = Date.now(),
  status?: string,
): AuctionPhase {
  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  if (status === 'ended' || status === 'closed') return 'ended';
  if (Number.isFinite(endMs) && nowMs >= endMs) return 'ended';
  if (Number.isFinite(startMs) && nowMs < startMs) return 'upcoming';
  return 'live';
}

export function isAuctionSaleEnded(
  sale: { format: string; startsAt?: string; endsAt?: string },
  nowMs: number = Date.now(),
  status?: string,
): boolean {
  if (sale.format !== 'auction') return false;
  return getAuctionPhase(sale.startsAt ?? '', sale.endsAt ?? '', nowMs, status) === 'ended';
}

/**
 * The lifecycle state a reader sees at `nowMs`. A seller's record keeps
 * `active` after an auction closes until the seller edits it, and cached
 * index rows keep it too, so an `active` auction whose end time has been
 * reached reads as `ended`. This is the same rule the Nexus index applies
 * when it serves `state`: the end time itself already counts as ended.
 * `paused`, `removed` and `ended` are never changed, and a listing without an
 * end time never expires.
 */
export function effectiveListingState<S extends string>(
  state: S,
  auctionEndsAt: string | null | undefined,
  nowMs: number = Date.now(),
): S | 'ended' {
  if (state !== 'active' || !auctionEndsAt) return state;
  const endMs = Date.parse(auctionEndsAt);
  return Number.isFinite(endMs) && nowMs >= endMs ? 'ended' : state;
}

export function listingDisplayState<S extends string>(
  state: S,
  sale: { format: string; startsAt?: string; endsAt?: string },
  nowMs: number = Date.now(),
): S | 'ended' {
  if (state === 'active' && isAuctionSaleEnded(sale, nowMs)) return 'ended';
  return state;
}
