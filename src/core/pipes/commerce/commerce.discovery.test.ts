import { describe, expect, it } from 'vitest';
import { selectFollowedSellersToRefresh } from './commerce.discovery';

const SELLER_A = 'a'.repeat(52);
const SELLER_B = 'b'.repeat(52);
const SELLER_C = 'c'.repeat(52);
const SELLER_D = 'd'.repeat(52);

describe('selectFollowedSellersToRefresh', () => {
  it('selects only follows that are locally known sellers, preserving follow order', () => {
    const follows = [SELLER_A, SELLER_B, SELLER_C, SELLER_D];
    const knownSellers = new Set([SELLER_D, SELLER_B]);

    expect(selectFollowedSellersToRefresh(follows, knownSellers, 6)).toEqual([SELLER_B, SELLER_D]);
  });

  it('caps the selection so the shelf never issues more per-seller requests than budgeted', () => {
    const follows = [SELLER_A, SELLER_B, SELLER_C, SELLER_D];
    const knownSellers = new Set(follows);

    expect(selectFollowedSellersToRefresh(follows, knownSellers, 2)).toEqual([SELLER_A, SELLER_B]);
  });

  it('deduplicates repeated follow entries instead of spending the budget twice', () => {
    const follows = [SELLER_A, SELLER_A, SELLER_B];
    const knownSellers = new Set([SELLER_A, SELLER_B]);

    expect(selectFollowedSellersToRefresh(follows, knownSellers, 2)).toEqual([SELLER_A, SELLER_B]);
  });

  it('returns empty when no follow is a known seller or there are no follows', () => {
    expect(selectFollowedSellersToRefresh([SELLER_A], new Set([SELLER_B]), 6)).toEqual([]);
    expect(selectFollowedSellersToRefresh([], new Set([SELLER_A]), 6)).toEqual([]);
  });
});
