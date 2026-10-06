import { describe, expect, it } from 'vitest';
import { commerceWatchlistRecordSchema } from '@/libs/commerce/marketplace-records';
import {
  emptyWatchlistState,
  localRowsToWatchlistState,
  mergeWatchlistStates,
  WATCHLIST_DOCUMENT_MAX_ITEMS,
  WATCHLIST_DOCUMENT_MAX_TOMBSTONES,
  watchlistRecordToState,
  type WatchlistState,
  watchlistStatesEqual,
  watchlistStateToRecordBody,
} from './commerce.watchlist';

const OWNER = 'o'.repeat(52);
const SELLER = 's'.repeat(52);
const key = (listingId: string) => `${SELLER}:${listingId}`;

const state = (items: [string, number][] = [], tombstones: [string, number][] = []): WatchlistState => ({
  items: new Map(items),
  tombstones: new Map(tombstones),
});

describe('mergeWatchlistStates (per-key LWW, tie -> tombstone)', () => {
  it('unions keys that exist on only one side', () => {
    const merged = mergeWatchlistStates(state([[key('a'), 100]]), state([[key('b'), 200]]));
    expect(merged.items.get(key('a'))).toBe(100);
    expect(merged.items.get(key('b'))).toBe(200);
    expect(merged.tombstones.size).toBe(0);
  });

  it('a newer watch beats an older tombstone (re-add wins)', () => {
    const merged = mergeWatchlistStates(state([[key('a'), 300]]), state([], [[key('a'), 200]]));
    expect(merged.items.get(key('a'))).toBe(300);
    expect(merged.tombstones.has(key('a'))).toBe(false);
  });

  it('a newer tombstone beats an older watch (delete wins)', () => {
    const merged = mergeWatchlistStates(state([[key('a'), 100]]), state([], [[key('a'), 200]]));
    expect(merged.items.has(key('a'))).toBe(false);
    expect(merged.tombstones.get(key('a'))).toBe(200);
  });

  it('resolves an exact timestamp tie to the tombstone', () => {
    const merged = mergeWatchlistStates(state([[key('a'), 200]]), state([], [[key('a'), 200]]));
    expect(merged.items.has(key('a'))).toBe(false);
    expect(merged.tombstones.get(key('a'))).toBe(200);
  });

  it('keeps the newest timestamp when both sides watched the same item', () => {
    const merged = mergeWatchlistStates(state([[key('a'), 100]]), state([[key('a'), 500]]));
    expect(merged.items.get(key('a'))).toBe(500);
  });

  it('is commutative', () => {
    const left = state(
      [
        [key('a'), 100],
        [key('b'), 900],
      ],
      [[key('c'), 400]],
    );
    const right = state([[key('c'), 500]], [[key('a'), 100]]);
    expect(watchlistStatesEqual(mergeWatchlistStates(left, right), mergeWatchlistStates(right, left))).toBe(true);
  });

  it('is idempotent: merging the merged state with either input changes nothing', () => {
    const left = state([[key('a'), 100]], [[key('b'), 200]]);
    const right = state([[key('b'), 300]], [[key('a'), 50]]);
    const merged = mergeWatchlistStates(left, right);
    expect(watchlistStatesEqual(mergeWatchlistStates(merged, left), merged)).toBe(true);
    expect(watchlistStatesEqual(mergeWatchlistStates(merged, right), merged)).toBe(true);
  });

  it('produces disjoint items and tombstones', () => {
    const merged = mergeWatchlistStates(
      state(
        [
          [key('a'), 100],
          [key('b'), 300],
        ],
        [[key('c'), 100]],
      ),
      state([[key('c'), 200]], [[key('b'), 100]]),
    );
    for (const itemKey of merged.items.keys()) {
      expect(merged.tombstones.has(itemKey)).toBe(false);
    }
  });

  it('prunes tombstones beyond the document cap oldest-first', () => {
    const overCap: [string, number][] = Array.from({ length: WATCHLIST_DOCUMENT_MAX_TOMBSTONES + 10 }, (_, index) => [
      key(`listing_${index}`),
      index + 1,
    ]);
    const merged = mergeWatchlistStates(state([], overCap), emptyWatchlistState());
    expect(merged.tombstones.size).toBe(WATCHLIST_DOCUMENT_MAX_TOMBSTONES);
    // The 10 oldest (timestamps 1..10) are the pruned ones.
    expect(merged.tombstones.has(key('listing_0'))).toBe(false);
    expect(merged.tombstones.has(key('listing_9'))).toBe(false);
    expect(merged.tombstones.has(key('listing_10'))).toBe(true);
  });
});

describe('watchlist record <-> state conversion', () => {
  it('round-trips through the record body and the zod record schema', () => {
    const merged = state([[key('boots_01'), 1_735_689_600_000]], [[key('boots_02'), 1_735_776_000_000]]);
    const body = watchlistStateToRecordBody({
      ownerPubky: OWNER,
      state: merged,
      revision: 3,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
    });

    const record = commerceWatchlistRecordSchema.parse(body);
    expect(record.revision).toBe(3);
    expect(record.recordType).toBe('watchlist');
    expect(watchlistStatesEqual(watchlistRecordToState(record), merged)).toBe(true);
  });

  it('excludes keys that cannot be valid spec record keys (they stay local-only)', () => {
    const merged = state([
      [key('boots_01'), 100],
      ['not-a-pubky:boots_02', 200],
      ['missing-separator', 300],
    ]);
    const body = watchlistStateToRecordBody({
      ownerPubky: OWNER,
      state: merged,
      revision: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    expect(body.items).toEqual([{ listingOwnerPubky: SELLER, listingId: 'boots_01', watchedAtMs: 100 }]);
  });

  it('caps document items newest-first; overflow stays local', () => {
    const overCap: [string, number][] = Array.from({ length: WATCHLIST_DOCUMENT_MAX_ITEMS + 5 }, (_, index) => [
      key(`listing_${index}`),
      index + 1,
    ]);
    const body = watchlistStateToRecordBody({
      ownerPubky: OWNER,
      state: state(overCap),
      revision: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    const items = body.items as { listingId: string; watchedAtMs: number }[];
    expect(items).toHaveLength(WATCHLIST_DOCUMENT_MAX_ITEMS);
    // Newest survive: the 5 oldest timestamps (1..5) are dropped from the doc.
    expect(items.some((item) => item.watchedAtMs <= 5)).toBe(false);
  });
});

describe('localRowsToWatchlistState', () => {
  it('maps favorite created_at and tombstone removed_at into the merge keys', () => {
    const built = localRowsToWatchlistState(
      [{ listing_id: key('a'), created_at: 100 }],
      [{ listing_id: key('b'), removed_at: 200 }],
    );
    expect(built.items.get(key('a'))).toBe(100);
    expect(built.tombstones.get(key('b'))).toBe(200);
  });
});
