/**
 * Pure selection logic for the social-discovery marketplace surfaces (the
 * home-feed "From sellers you follow" shelf). No IO — the application layer
 * supplies what is locally known and applies the result.
 */

/**
 * Selects which followed accounts get a per-seller listing-stream refresh.
 *
 * The Nexus listing stream accepts one `seller_id` per request, so refreshing
 * every follow would cost one request per followed account. Instead only
 * follows that are KNOWN sellers — accounts with a locally cached shop record
 * or at least one locally cached index entry — are refreshed, capped at
 * `cap`, preserving the order of `followedPubkys` (the follow stream is
 * most-recent-first, so the most recent follows win the budget). Follows the
 * client has never seen sell anything are discovered by the cheap shared
 * global stream page instead, never by speculative per-seller requests.
 */
export function selectFollowedSellersToRefresh(
  followedPubkys: readonly string[],
  knownSellerIds: ReadonlySet<string>,
  cap: number,
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const pubky of followedPubkys) {
    if (selected.length >= cap) break;
    if (seen.has(pubky) || !knownSellerIds.has(pubky)) continue;
    seen.add(pubky);
    selected.push(pubky);
  }
  return selected;
}
