import { describe, expect, it } from 'vitest';
import type { MarketplacePublicDrop } from '@/services/marketplace/marketplace';
import {
  deriveDropDisplayState,
  deriveDropReadyCheck,
  deriveDropStockDisplay,
  parseDropAggregateId,
} from './drop-display';

const SELLER = 's'.repeat(52);

function makeProjection(overrides: Partial<MarketplacePublicDrop> = {}): MarketplacePublicDrop {
  return {
    sellerPubky: SELLER,
    dropId: 'drop1',
    aggregateId: `drop:${SELLER}_drop1`,
    state: 'announced',
    format: 'fcfs',
    startsAt: '2026-09-01T17:00:00.000Z',
    endsAt: null,
    stockDisplay: 'exact',
    totalQuantity: 100,
    perBuyerLimit: 2,
    remaining: 100,
    remainingBand: null,
    revision: 1,
    serverTime: '2026-08-23T12:00:00.000Z',
    ...overrides,
  };
}

describe('deriveDropDisplayState', () => {
  it('renders the projection state verbatim — the five service states are the only claims', () => {
    for (const state of ['announced', 'live', 'ended_sold_out', 'ended_closed', 'ended_cancelled'] as const) {
      expect(
        deriveDropDisplayState({ adapterMode: 'transaction-service', projection: makeProjection({ state }) }),
      ).toBe(state);
    }
  });

  it('never claims live from the clock: a projection still announced after startsAt stays announced', () => {
    // startsAt long past relative to any clock — irrelevant on purpose: the
    // derivation must not even look at times.
    const projection = makeProjection({ state: 'announced', startsAt: '2000-01-01T00:00:00.000Z' });
    expect(deriveDropDisplayState({ adapterMode: 'locks-paykit', projection })).toBe('announced');
  });

  it('reports unregistered when the durable service has no projection', () => {
    expect(deriveDropDisplayState({ adapterMode: 'transaction-service', projection: null })).toBe('unregistered');
  });

  it('reports unavailable outside the durable modes — drops are durable-only', () => {
    expect(deriveDropDisplayState({ adapterMode: 'sandbox', projection: null })).toBe('unavailable');
    expect(deriveDropDisplayState({ adapterMode: 'unavailable', projection: null })).toBe('unavailable');
  });
});

describe('deriveDropStockDisplay', () => {
  it('shows the exact number when the projection carries one', () => {
    expect(deriveDropStockDisplay(makeProjection({ remaining: 7 }))).toEqual({ kind: 'exact', remaining: 7 });
  });

  it('shows the band when the projection carries one', () => {
    expect(
      deriveDropStockDisplay(makeProjection({ stockDisplay: 'bands', remaining: null, remainingBand: 'last_few' })),
    ).toEqual({ kind: 'band', band: 'last_few' });
  });

  it('shows nothing when the seller hides stock', () => {
    expect(
      deriveDropStockDisplay(makeProjection({ stockDisplay: 'hidden', remaining: null, remainingBand: null })),
    ).toEqual({ kind: 'hidden' });
  });

  it('never invents a level: an exact policy without a number renders nothing', () => {
    expect(
      deriveDropStockDisplay(makeProjection({ stockDisplay: 'exact', remaining: null, remainingBand: null })),
    ).toEqual({ kind: 'hidden' });
  });
});

describe('deriveDropReadyCheck', () => {
  it('is all green with a session, an address, and a positive allowance', () => {
    const view = deriveDropReadyCheck({
      hasSession: true,
      hasAddress: true,
      readyCheck: { purchased: 0, perBuyerLimit: 2, remainingAllowance: 2 },
    });
    expect(view.allReady).toBe(true);
    expect(view.items.map(({ ready }) => ready)).toEqual([true, true, true]);
    expect(view.items[2].detail).toBe('You can buy 2 in this drop.');
  });

  it('renders the pinned per-buyer-limit copy verbatim at zero allowance', () => {
    const view = deriveDropReadyCheck({
      hasSession: true,
      hasAddress: true,
      readyCheck: { purchased: 2, perBuyerLimit: 2, remainingAllowance: 0 },
    });
    expect(view.allReady).toBe(false);
    expect(view.items[2].ready).toBe(false);
    expect(view.items[2].detail).toBe("You have reached this drop's per-buyer limit.");
  });

  it('is honestly not-ready while the allowance is unavailable', () => {
    const withoutSession = deriveDropReadyCheck({ hasSession: false, hasAddress: false, readyCheck: null });
    expect(withoutSession.allReady).toBe(false);
    expect(withoutSession.items.every(({ ready }) => !ready)).toBe(true);

    const sessionButUnloaded = deriveDropReadyCheck({ hasSession: true, hasAddress: true, readyCheck: null });
    expect(sessionButUnloaded.items[2].ready).toBe(false);
    expect(sessionButUnloaded.allReady).toBe(false);
  });
});

describe('parseDropAggregateId', () => {
  it('parses the drop:{seller}_{dropId} shape', () => {
    expect(parseDropAggregateId(`drop:${SELLER}_abc123`)).toEqual({ sellerPubky: SELLER, dropId: 'abc123' });
  });

  it('rejects other aggregate kinds and malformed ids', () => {
    expect(parseDropAggregateId(`listing:${SELLER}_abc123`)).toBeNull();
    expect(parseDropAggregateId('drop:short_abc')).toBeNull();
    expect(parseDropAggregateId(`drop:${SELLER}x`)).toBeNull();
  });
});
