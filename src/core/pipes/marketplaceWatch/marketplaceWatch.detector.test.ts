import { describe, expect, it } from 'vitest';
import type { CommerceWatchSnapshotModelSchema } from '@/models/commerce/commerce.schema';
import {
  detectWatchAlerts,
  type WatchIndexObservation,
  type WatchObservation,
  type WatchProjectionObservation,
} from './marketplaceWatch.detector';

const OWNER = 'o'.repeat(52);
const OTHER_BIDDER = 'b'.repeat(52);
const SELLER = 's'.repeat(52);
const LISTING = `${SELLER}:boots_01`;

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
const HOUR = 60 * 60 * 1_000;
const THRESHOLD = { endingSoonThresholdMs: 24 * HOUR };

function indexObservation(overrides: Partial<WatchIndexObservation> = {}): WatchIndexObservation {
  return {
    revision: 3,
    state: 'active',
    priceMinor: 120_00,
    currency: 'USD',
    exponent: 2,
    auctionEndsAt: null,
    title: 'Vintage boots',
    ...overrides,
  };
}

function projectionObservation(overrides: Partial<WatchProjectionObservation> = {}): WatchProjectionObservation {
  return {
    serverRevision: 7,
    state: 'available',
    auction: {
      endsAt: new Date(NOW + 48 * HOUR).toISOString(),
      currentPriceMinor: 150_00,
      currency: 'USD',
      exponent: 2,
      bidCount: 2,
      leaderPubky: OTHER_BIDDER,
      ...(overrides.auction ?? {}),
    },
    ...overrides,
  };
}

function observation(overrides: Partial<WatchObservation> = {}): WatchObservation {
  return {
    ownerId: OWNER,
    listingId: LISTING,
    sellerId: SELLER,
    observedAt: NOW,
    index: null,
    projection: null,
    ...overrides,
  };
}

function baseline(overrides: Partial<CommerceWatchSnapshotModelSchema> = {}): CommerceWatchSnapshotModelSchema {
  return {
    id: `${OWNER}|${LISTING}`,
    owner_id: OWNER,
    listing_id: LISTING,
    title: 'Vintage boots',
    index_revision: 3,
    index_state: 'active',
    price_minor: 120_00,
    price_currency: 'USD',
    price_exponent: 2,
    auction_ends_at: null,
    server_revision: 7,
    projection_state: 'available',
    bid_count: 2,
    bid_amount_minor: 150_00,
    leader_pubky: OTHER_BIDDER,
    ending_soon_alerted_ends_at: null,
    checked_at: NOW - HOUR,
    ...overrides,
  };
}

describe('detectWatchAlerts', () => {
  describe('first observation (no baseline)', () => {
    it('produces no delta alerts and records the baseline', () => {
      const { alerts, snapshot } = detectWatchAlerts(
        null,
        observation({ index: indexObservation(), projection: projectionObservation() }),
        THRESHOLD,
      );

      expect(alerts).toEqual([]);
      expect(snapshot.index_revision).toBe(3);
      expect(snapshot.price_minor).toBe(120_00);
      expect(snapshot.bid_count).toBe(2);
      expect(snapshot.leader_pubky).toBe(OTHER_BIDDER);
      expect(snapshot.checked_at).toBe(NOW);
    });

    it('still reports ending-soon — a deadline claim, not a delta claim', () => {
      const endsAt = new Date(NOW + 3 * HOUR).toISOString();
      const { alerts, snapshot } = detectWatchAlerts(
        null,
        observation({ index: indexObservation({ auctionEndsAt: endsAt }) }),
        THRESHOLD,
      );

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: 'ending_soon', ends_at: endsAt, source: 'index' });
      expect(snapshot.ending_soon_alerted_ends_at).toBe(endsAt);
    });
  });

  describe('ending soon', () => {
    it('does not fire for deadlines beyond the threshold or already past', () => {
      const tooFar = detectWatchAlerts(
        null,
        observation({ index: indexObservation({ auctionEndsAt: new Date(NOW + 30 * HOUR).toISOString() }) }),
        THRESHOLD,
      );
      const past = detectWatchAlerts(
        null,
        observation({ index: indexObservation({ auctionEndsAt: new Date(NOW - HOUR).toISOString() }) }),
        THRESHOLD,
      );

      expect(tooFar.alerts).toEqual([]);
      expect(past.alerts).toEqual([]);
    });

    it('fires once per distinct deadline and again when anti-sniping moves it', () => {
      const endsAt = new Date(NOW + 3 * HOUR).toISOString();
      const first = detectWatchAlerts(
        baseline({ auction_ends_at: endsAt }),
        observation({ index: indexObservation({ auctionEndsAt: endsAt }) }),
        THRESHOLD,
      );
      expect(first.alerts.filter(({ kind }) => kind === 'ending_soon')).toHaveLength(1);

      const repeat = detectWatchAlerts(
        first.snapshot,
        observation({ index: indexObservation({ auctionEndsAt: endsAt }) }),
        THRESHOLD,
      );
      expect(repeat.alerts).toEqual([]);

      const extendedEndsAt = new Date(NOW + 4 * HOUR).toISOString();
      const extended = detectWatchAlerts(
        repeat.snapshot,
        observation({ index: indexObservation({ auctionEndsAt: extendedEndsAt }) }),
        THRESHOLD,
      );
      expect(extended.alerts.filter(({ kind }) => kind === 'ending_soon')).toHaveLength(1);
      expect(extended.alerts[0].ends_at).toBe(extendedEndsAt);
    });

    it('does not fire for listings that are no longer running', () => {
      const endsAt = new Date(NOW + 3 * HOUR).toISOString();
      const { alerts } = detectWatchAlerts(
        null,
        observation({ index: indexObservation({ auctionEndsAt: endsAt, state: 'ended' }) }),
        THRESHOLD,
      );

      expect(alerts).toEqual([]);
    });
  });

  describe('new bid vs outbid', () => {
    it('reports "new bid" when the bid rose and the user was never observed leading', () => {
      const { alerts } = detectWatchAlerts(
        baseline({ bid_count: 2, bid_amount_minor: 150_00, leader_pubky: OTHER_BIDDER }),
        observation({
          projection: projectionObservation({
            auction: {
              endsAt: new Date(NOW + 48 * HOUR).toISOString(),
              currentPriceMinor: 175_00,
              currency: 'USD',
              exponent: 2,
              bidCount: 3,
              leaderPubky: OTHER_BIDDER,
            },
          }),
        }),
        THRESHOLD,
      );

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        kind: 'new_bid',
        previous_amount_minor: 150_00,
        current_amount_minor: 175_00,
        bid_count: 3,
        source: 'projection',
      });
    });

    it('claims "outbid" only when this device observed the user leading before', () => {
      const { alerts } = detectWatchAlerts(
        baseline({ leader_pubky: OWNER }),
        observation({
          projection: projectionObservation({
            auction: {
              endsAt: new Date(NOW + 48 * HOUR).toISOString(),
              currentPriceMinor: 175_00,
              currency: 'USD',
              exponent: 2,
              bidCount: 3,
              leaderPubky: OTHER_BIDDER,
            },
          }),
        }),
        THRESHOLD,
      );

      expect(alerts).toHaveLength(1);
      expect(alerts[0].kind).toBe('outbid');
    });

    it('stays silent when the fresh leader is the user (their own bid)', () => {
      const { alerts } = detectWatchAlerts(
        baseline({ leader_pubky: OTHER_BIDDER }),
        observation({
          projection: projectionObservation({
            auction: {
              endsAt: new Date(NOW + 48 * HOUR).toISOString(),
              currentPriceMinor: 175_00,
              currency: 'USD',
              exponent: 2,
              bidCount: 3,
              leaderPubky: OWNER,
            },
          }),
        }),
        THRESHOLD,
      );

      expect(alerts).toEqual([]);
    });

    it('records a baseline without alerting on the first projection read', () => {
      const { alerts, snapshot } = detectWatchAlerts(
        baseline({ bid_count: null, bid_amount_minor: null, leader_pubky: null, server_revision: null }),
        observation({ projection: projectionObservation() }),
        THRESHOLD,
      );

      expect(alerts).toEqual([]);
      expect(snapshot.bid_count).toBe(2);
    });
  });

  describe('price change', () => {
    it('reports a price change only with a newer index revision and a different price', () => {
      const changed = detectWatchAlerts(
        baseline(),
        observation({ index: indexObservation({ revision: 4, priceMinor: 90_00 }) }),
        THRESHOLD,
      );
      expect(changed.alerts).toHaveLength(1);
      expect(changed.alerts[0]).toMatchObject({
        kind: 'price_change',
        previous_amount_minor: 120_00,
        current_amount_minor: 90_00,
        observed_revision: 4,
      });

      const revisionOnly = detectWatchAlerts(
        baseline(),
        observation({ index: indexObservation({ revision: 4 }) }),
        THRESHOLD,
      );
      expect(revisionOnly.alerts).toEqual([]);

      const noBaseline = detectWatchAlerts(
        baseline({ index_revision: null, price_minor: null }),
        observation({ index: indexObservation({ revision: 4, priceMinor: 90_00 }) }),
        THRESHOLD,
      );
      expect(noBaseline.alerts).toEqual([]);
    });
  });

  describe('state change', () => {
    it('reports index transitions including relisting', () => {
      const ended = detectWatchAlerts(
        baseline(),
        observation({ index: indexObservation({ state: 'ended', revision: 4 }) }),
        THRESHOLD,
      );
      expect(ended.alerts).toHaveLength(1);
      expect(ended.alerts[0]).toMatchObject({ kind: 'state_change', previous_state: 'active', next_state: 'ended' });

      const relisted = detectWatchAlerts(
        ended.snapshot,
        observation({ index: indexObservation({ state: 'active', revision: 5 }) }),
        THRESHOLD,
      );
      expect(relisted.alerts).toHaveLength(1);
      expect(relisted.alerts[0]).toMatchObject({ kind: 'state_change', previous_state: 'ended', next_state: 'active' });
    });

    it('reports the projection transition only when the index did not move in the same pass', () => {
      const soldViaProjection = detectWatchAlerts(
        baseline(),
        observation({ projection: projectionObservation({ state: 'sold', auction: null }) }),
        THRESHOLD,
      );
      expect(soldViaProjection.alerts).toHaveLength(1);
      expect(soldViaProjection.alerts[0]).toMatchObject({
        kind: 'state_change',
        previous_state: 'available',
        next_state: 'sold',
        source: 'projection',
      });

      const bothMoved = detectWatchAlerts(
        baseline(),
        observation({
          index: indexObservation({ state: 'ended', revision: 4 }),
          projection: projectionObservation({ state: 'sold', auction: null }),
        }),
        THRESHOLD,
      );
      const stateAlerts = bothMoved.alerts.filter(({ kind }) => kind === 'state_change');
      expect(stateAlerts).toHaveLength(1);
      expect(stateAlerts[0].source).toBe('index');
    });
  });

  describe('snapshot advancement', () => {
    it('keeps unobserved sources at their prior baseline', () => {
      const { snapshot } = detectWatchAlerts(
        baseline({ bid_count: 5, bid_amount_minor: 200_00, leader_pubky: OWNER, server_revision: 9 }),
        observation({ index: indexObservation({ revision: 4 }) }),
        THRESHOLD,
      );

      expect(snapshot.index_revision).toBe(4);
      expect(snapshot.bid_count).toBe(5);
      expect(snapshot.bid_amount_minor).toBe(200_00);
      expect(snapshot.leader_pubky).toBe(OWNER);
      expect(snapshot.server_revision).toBe(9);
    });

    it('produces deterministic alert ids so re-detection is idempotent', () => {
      const run = () =>
        detectWatchAlerts(
          baseline(),
          observation({ index: indexObservation({ revision: 4, priceMinor: 90_00 }) }),
          THRESHOLD,
        );

      expect(run().alerts[0].id).toBe(run().alerts[0].id);
      expect(run().alerts[0].id).toBe(`${OWNER}|${LISTING}|price_change|4`);
    });
  });
});
