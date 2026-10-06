import { describe, expect, it } from 'vitest';
import {
  buildMuteChange,
  foldMuteChanges,
  MUTE_CHANGE_KIND,
  type MuteChange,
  mutedPubkys,
  parseMuteChange,
} from './mute-list';

const OWNER = 'o'.repeat(52);
const A = 'a'.repeat(52);
const B = 'b'.repeat(52);

const change = (counterparty: string, muted: boolean, changedAt: number): MuteChange => ({
  version: 1,
  kind: MUTE_CHANGE_KIND,
  owner_pubky: OWNER,
  counterparty_pubky: counterparty,
  muted,
  changed_at: changedAt,
});

describe('mute log', () => {
  it('folds to the latest change per person, whatever order the records are read in', () => {
    const records = [change(A, true, 10), change(A, false, 12), change(B, true, 11)];
    for (const order of [records, [...records].reverse()]) {
      const state = foldMuteChanges(order);
      expect([...mutedPubkys(state)]).toEqual([B]);
      expect(state.get(A)).toEqual({ muted: false, changed_at: 12 });
    }
  });

  it('lets a mute win a tie, so two devices changing the same person at once never lose the mute', () => {
    expect([...mutedPubkys(foldMuteChanges([change(A, false, 20), change(A, true, 20)]))]).toEqual([A]);
    expect([...mutedPubkys(foldMuteChanges([change(A, true, 20), change(A, false, 20)]))]).toEqual([A]);
  });

  it('dates a new change after the latest one for the same person even when the clock runs behind', () => {
    const state = foldMuteChanges([change(A, true, 1_000)]);
    const next = buildMuteChange({ ownerPubky: OWNER, counterpartyPubky: A, muted: false, now: 5, state });
    expect(next.changed_at).toBe(1_001);
    expect(mutedPubkys(foldMuteChanges([change(A, true, 1_000), next])).size).toBe(0);
  });

  it('refuses a record of another account, about the owner, or that does not validate', () => {
    expect(parseMuteChange(change(A, true, 1), OWNER)).toEqual(change(A, true, 1));
    expect(parseMuteChange(change(A, true, 1), B)).toBeNull();
    expect(parseMuteChange(change(OWNER, true, 1), OWNER)).toBeNull();
    expect(parseMuteChange({ ...change(A, true, 1), extra: true }, OWNER)).toBeNull();
    expect(parseMuteChange({ ...change(A, true, 1), counterparty_pubky: 'not-a-pubky' }, OWNER)).toBeNull();
  });
});
