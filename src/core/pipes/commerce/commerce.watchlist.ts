import type {
  CommerceWatchlistRecord,
  CommerceWatchlistRecordItem,
  CommerceWatchlistRecordTombstone,
} from '@/libs/commerce/marketplace-records';
import type { CommerceFavoriteModelSchema, CommerceWatchTombstoneModelSchema } from '@/models/commerce/commerce.schema';

/**
 * Pure merge logic for the PRIVATE cross-device watchlist document
 * (`/priv/pubky.app/marketplace/v1/watchlist.json`, pubky-app-specs
 * 0.6.2-marketplace.6). No IO — state in, state out.
 *
 * THE MERGE RULE (documented here, enforced by `mergeWatchlistStates`, and
 * normative in the spec): per listing key (`seller:listingId`), the entry
 * with the greater millisecond timestamp wins — a watch asserted at T beats
 * a removal at T-1 and vice versa. A TIE resolves to the tombstone: deletion
 * wins, because resurrecting an item the user removed is the worse failure.
 * The merged state is disjoint — each key is either watched or tombstoned,
 * never both — which is exactly the shape the spec record validates.
 */

/** Mirrors the spec's document caps (`MAX_WATCHLIST_ITEMS` / `MAX_WATCHLIST_TOMBSTONES`). */
export const WATCHLIST_DOCUMENT_MAX_ITEMS = 500;
export const WATCHLIST_DOCUMENT_MAX_TOMBSTONES = 500;

/** Composite `seller:listingId` key -> epoch-milliseconds timestamp. */
export interface WatchlistState {
  items: Map<string, number>;
  tombstones: Map<string, number>;
}

/** A composite key the spec record can carry: 52-char z-base-32 seller, path-safe listing id. */
const RECORD_KEY_PATTERN = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}:[A-Za-z0-9_-]{1,128}$/;

export const emptyWatchlistState = (): WatchlistState => ({ items: new Map(), tombstones: new Map() });

/**
 * Merges two watchlist states with per-key last-write-wins (tie -> tombstone).
 * Tombstones beyond the document cap are pruned oldest-first; pruned
 * tombstones stop protecting against re-adds older than themselves, which is
 * acceptable because both are, by construction, the oldest signals in play.
 */
export const mergeWatchlistStates = (left: WatchlistState, right: WatchlistState): WatchlistState => {
  const keys = new Set([
    ...left.items.keys(),
    ...left.tombstones.keys(),
    ...right.items.keys(),
    ...right.tombstones.keys(),
  ]);

  const merged = emptyWatchlistState();
  for (const key of keys) {
    const watchedAt = Math.max(left.items.get(key) ?? 0, right.items.get(key) ?? 0);
    const removedAt = Math.max(left.tombstones.get(key) ?? 0, right.tombstones.get(key) ?? 0);
    if (watchedAt > removedAt) {
      merged.items.set(key, watchedAt);
    } else if (removedAt > 0) {
      merged.tombstones.set(key, removedAt);
    }
  }

  if (merged.tombstones.size > WATCHLIST_DOCUMENT_MAX_TOMBSTONES) {
    const keptNewest = [...merged.tombstones.entries()]
      .sort(([, leftAt], [, rightAt]) => rightAt - leftAt)
      .slice(0, WATCHLIST_DOCUMENT_MAX_TOMBSTONES);
    merged.tombstones = new Map(keptNewest);
  }

  return merged;
};

export const watchlistStatesEqual = (left: WatchlistState, right: WatchlistState): boolean => {
  if (left.items.size !== right.items.size || left.tombstones.size !== right.tombstones.size) return false;
  for (const [key, at] of left.items) {
    if (right.items.get(key) !== at) return false;
  }
  for (const [key, at] of left.tombstones) {
    if (right.tombstones.get(key) !== at) return false;
  }
  return true;
};

export const localRowsToWatchlistState = (
  favorites: readonly Pick<CommerceFavoriteModelSchema, 'listing_id' | 'created_at'>[],
  tombstones: readonly Pick<CommerceWatchTombstoneModelSchema, 'listing_id' | 'removed_at'>[],
): WatchlistState => ({
  items: new Map(favorites.map((favorite) => [favorite.listing_id, favorite.created_at])),
  tombstones: new Map(tombstones.map((tombstone) => [tombstone.listing_id, tombstone.removed_at])),
});

export const watchlistRecordToState = (record: CommerceWatchlistRecord): WatchlistState => ({
  items: new Map(record.items.map((item) => [`${item.listingOwnerPubky}:${item.listingId}`, item.watchedAtMs])),
  tombstones: new Map(
    record.tombstones.map((tombstone) => [
      `${tombstone.listingOwnerPubky}:${tombstone.listingId}`,
      tombstone.removedAtMs,
    ]),
  ),
});

const splitRecordKey = (key: string): { listingOwnerPubky: string; listingId: string } | null => {
  if (!RECORD_KEY_PATTERN.test(key)) return null;
  const separator = key.indexOf(':');
  return { listingOwnerPubky: key.slice(0, separator), listingId: key.slice(separator + 1) };
};

/**
 * Builds the plain JSON body of the next watchlist document from a merged
 * state. Entries whose composite key cannot be a valid spec record key
 * (e.g. sandbox-seeded listings with non-pubky sellers) are left out of the
 * DOCUMENT — they stay watched locally, they just cannot travel. Items beyond
 * the document cap sync newest-first; the overflow also stays local-only.
 */
export const watchlistStateToRecordBody = ({
  ownerPubky,
  state,
  revision,
  createdAt,
  updatedAt,
}: {
  ownerPubky: string;
  state: WatchlistState;
  revision: number;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> => {
  const items: CommerceWatchlistRecordItem[] = [...state.items.entries()]
    .map(([key, watchedAtMs]) => ({ key: splitRecordKey(key), watchedAtMs }))
    .filter((entry): entry is { key: NonNullable<ReturnType<typeof splitRecordKey>>; watchedAtMs: number } =>
      Boolean(entry.key),
    )
    .sort((left, right) => right.watchedAtMs - left.watchedAtMs)
    .slice(0, WATCHLIST_DOCUMENT_MAX_ITEMS)
    .map(({ key, watchedAtMs }) => ({ ...key, watchedAtMs }));

  const tombstones: CommerceWatchlistRecordTombstone[] = [...state.tombstones.entries()]
    .map(([key, removedAtMs]) => ({ key: splitRecordKey(key), removedAtMs }))
    .filter((entry): entry is { key: NonNullable<ReturnType<typeof splitRecordKey>>; removedAtMs: number } =>
      Boolean(entry.key),
    )
    .sort((left, right) => right.removedAtMs - left.removedAtMs)
    .slice(0, WATCHLIST_DOCUMENT_MAX_TOMBSTONES)
    .map(({ key, removedAtMs }) => ({ ...key, removedAtMs }));

  return {
    schemaVersion: 1,
    recordType: 'watchlist',
    ownerPubky,
    revision,
    createdAt,
    updatedAt,
    items,
    tombstones,
  };
};
