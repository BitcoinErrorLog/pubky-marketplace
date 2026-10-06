import { beforeEach, describe, expect, it } from 'vitest';
import { forgetOwnDrop, readOwnDropIndex, rememberOwnDrop } from './drop-index';

const ACCOUNT_A = 'y'.repeat(52);
const ACCOUNT_B = '8'.repeat(52);

describe('drop-index', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts empty and round-trips remembered ids newest first', () => {
    expect(readOwnDropIndex(ACCOUNT_A)).toEqual([]);

    rememberOwnDrop(ACCOUNT_A, 'drop1');
    rememberOwnDrop(ACCOUNT_A, 'drop2');

    expect(readOwnDropIndex(ACCOUNT_A)).toEqual(['drop2', 'drop1']);
  });

  it('is idempotent: re-remembering an id moves it to the front without duplicating', () => {
    rememberOwnDrop(ACCOUNT_A, 'drop1');
    rememberOwnDrop(ACCOUNT_A, 'drop2');
    rememberOwnDrop(ACCOUNT_A, 'drop1');

    expect(readOwnDropIndex(ACCOUNT_A)).toEqual(['drop1', 'drop2']);
  });

  it('keys the index per account — one seller never sees another device user\u2019s drops', () => {
    rememberOwnDrop(ACCOUNT_A, 'dropA');
    rememberOwnDrop(ACCOUNT_B, 'dropB');

    expect(readOwnDropIndex(ACCOUNT_A)).toEqual(['dropA']);
    expect(readOwnDropIndex(ACCOUNT_B)).toEqual(['dropB']);
  });

  it('forgets ids and clears the storage key when the last one goes', () => {
    rememberOwnDrop(ACCOUNT_A, 'drop1');
    rememberOwnDrop(ACCOUNT_A, 'drop2');

    forgetOwnDrop(ACCOUNT_A, 'drop2');
    expect(readOwnDropIndex(ACCOUNT_A)).toEqual(['drop1']);

    forgetOwnDrop(ACCOUNT_A, 'drop1');
    expect(readOwnDropIndex(ACCOUNT_A)).toEqual([]);
    expect(window.localStorage.getItem(`marketplace:own-drops:${ACCOUNT_A}`)).toBeNull();
  });

  it('treats corrupted storage as an empty index instead of throwing', () => {
    window.localStorage.setItem(`marketplace:own-drops:${ACCOUNT_A}`, 'not-json{');
    expect(readOwnDropIndex(ACCOUNT_A)).toEqual([]);

    window.localStorage.setItem(`marketplace:own-drops:${ACCOUNT_A}`, JSON.stringify({ nope: true }));
    expect(readOwnDropIndex(ACCOUNT_A)).toEqual([]);

    window.localStorage.setItem(`marketplace:own-drops:${ACCOUNT_A}`, JSON.stringify(['ok', 7, '', 'also-ok']));
    expect(readOwnDropIndex(ACCOUNT_A)).toEqual(['ok', 'also-ok']);
  });
});
