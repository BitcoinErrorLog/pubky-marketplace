import { describe, expect, it } from 'vitest';
import { FollowGraphPager } from './follow-graph-pager';

const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

describe('FollowGraphPager', () => {
  it('starts at the first page and moves one full page per read', () => {
    const pager = new FollowGraphPager(3);
    expect(pager.nextSkip()).toBe(0);
    pager.record(ids('a', 3));
    expect(pager.nextSkip()).toBe(3);
    pager.record(ids('b', 3));
    expect(pager.nextSkip()).toBe(6);
  });

  it('starts over after a short page', () => {
    const pager = new FollowGraphPager(3);
    pager.record(ids('a', 3));
    pager.record(ids('b', 1));
    expect(pager.nextSkip()).toBe(0);
  });

  it('starts over after an empty page past the end of a list that fills its pages exactly', () => {
    const pager = new FollowGraphPager(3);
    pager.record(ids('a', 3));
    pager.record([]);
    expect(pager.nextSkip()).toBe(0);
  });

  it('stays on the first page of a list shorter than a page', () => {
    const pager = new FollowGraphPager(3);
    pager.record(ids('a', 2));
    pager.record(ids('a', 2));
    expect(pager.nextSkip()).toBe(0);
  });

  it('has seen everyone on the pages of the current and the last complete walk', () => {
    const pager = new FollowGraphPager(2);
    pager.record(['a', 'b']);
    pager.record(['c']);
    expect(pager.seen()).toEqual(new Set(['a', 'b', 'c']));
    pager.record(['a', 'd']);
    expect(pager.seen()).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('forgets someone a whole walk did not see', () => {
    const pager = new FollowGraphPager(2);
    pager.record(['a', 'b']);
    pager.record(['c']);
    pager.record(['a', 'b']);
    pager.record([]);
    expect(pager.seen()).toEqual(new Set(['a', 'b']));
  });
});
