import type {
  CommerceListingProjectionState,
  CommerceWatchAlertKind,
  CommerceWatchAlertModelSchema,
  CommerceWatchAlertSource,
  CommerceWatchSnapshotModelSchema,
} from '@/models/commerce/commerce.schema';

/**
 * What one fresh read of the Nexus listing index (or, in sandbox mode, the
 * locally seeded catalog) said about a watched listing.
 */
export interface WatchIndexObservation {
  revision: number;
  state: 'active' | 'paused' | 'ended' | 'removed';
  priceMinor: number;
  currency: string;
  exponent: number;
  auctionEndsAt: string | null;
  title: string;
}

/**
 * What one fresh read of the transaction service's public listing projection
 * said about a watched listing.
 */
export interface WatchProjectionObservation {
  serverRevision: number;
  state: CommerceListingProjectionState;
  auction: {
    endsAt: string;
    currentPriceMinor: number;
    currency: string;
    exponent: number;
    bidCount: number;
    leaderPubky: string | null;
  } | null;
}

/** One detection pass's input for a single watched listing. */
export interface WatchObservation {
  ownerId: string;
  /** Composite `seller:listingId`. */
  listingId: string;
  sellerId: string;
  observedAt: number;
  /** Null when this pass could not read the index for this listing. */
  index: WatchIndexObservation | null;
  /** Null when this pass could not (or had no reason to) read the service projection. */
  projection: WatchProjectionObservation | null;
}

export interface WatchDetectionResult {
  alerts: CommerceWatchAlertModelSchema[];
  snapshot: CommerceWatchSnapshotModelSchema;
}

/**
 * Compares one watched listing's fresh observation against the persisted
 * snapshot baseline and derives the alerts that observation actually
 * supports. Pure — no IO, no clock reads (the caller supplies `observedAt`).
 *
 * Honesty rules encoded here:
 *
 * - No baseline, no delta claim: bid, price, and state alerts require the
 *   corresponding snapshot field to be non-null (a prior real observation).
 *   The first pass over a freshly watched item only records the baseline.
 * - "Ending soon" is not a delta — it follows from an observed `ends_at` and
 *   the caller's clock — but it fires at most once per distinct `ends_at`
 *   (anti-sniping extensions produce a new deadline and may alert again).
 * - "Outbid" is claimed only when this device's own projection reads prove
 *   participation: the snapshot recorded the owner as auction leader and the
 *   fresh read shows someone else leading. Anything else that raises the bid
 *   is reported as "new bid".
 * - A bid increase where the fresh leader IS the owner is the owner's own
 *   action and produces no alert.
 * - Index-vocabulary and projection-vocabulary state changes describe the
 *   same event (e.g. `active→ended` and `available→sold`), so when both move
 *   in one pass only the index transition is reported.
 *
 * Alert ids are deterministic (`owner|listing|kind|dedupeKey`), which makes
 * re-detection idempotent at the persistence layer.
 */
export function detectWatchAlerts(
  snapshot: CommerceWatchSnapshotModelSchema | null,
  observation: WatchObservation,
  options: { endingSoonThresholdMs: number },
): WatchDetectionResult {
  const { ownerId, listingId, sellerId, observedAt, index, projection } = observation;
  const alerts: CommerceWatchAlertModelSchema[] = [];
  const title = index?.title ?? snapshot?.title ?? listingId;

  const baseAlert = (
    kind: CommerceWatchAlertKind,
    dedupeKey: string,
    source: CommerceWatchAlertSource,
    observedRevision: number,
  ): CommerceWatchAlertModelSchema => ({
    id: `${ownerId}|${listingId}|${kind}|${dedupeKey}`,
    owner_id: ownerId,
    listing_id: listingId,
    seller_id: sellerId,
    kind,
    title,
    source,
    observed_revision: observedRevision,
    ends_at: null,
    previous_amount_minor: null,
    current_amount_minor: null,
    currency: null,
    exponent: null,
    bid_count: null,
    previous_state: null,
    next_state: null,
    created_at: observedAt,
    seen_at: null,
  });

  // Ending soon — from a currently observed deadline, active listings only.
  const observedEndsAt = projection?.auction?.endsAt ?? index?.auctionEndsAt ?? null;
  const isRunning = projection ? projection.state === 'available' : index?.state === 'active';
  let endingSoonAlertedEndsAt = snapshot?.ending_soon_alerted_ends_at ?? null;
  if (observedEndsAt !== null && isRunning) {
    const endsAtMs = Date.parse(observedEndsAt);
    const withinThreshold = endsAtMs > observedAt && endsAtMs - observedAt <= options.endingSoonThresholdMs;
    if (withinThreshold && endingSoonAlertedEndsAt !== observedEndsAt) {
      const source: CommerceWatchAlertSource = projection?.auction ? 'projection' : 'index';
      alerts.push({
        ...baseAlert(
          'ending_soon',
          observedEndsAt,
          source,
          source === 'projection' ? projection!.serverRevision : index!.revision,
        ),
        ends_at: observedEndsAt,
      });
      endingSoonAlertedEndsAt = observedEndsAt;
    }
  }

  // New bid / outbid — only against a projection baseline this device recorded.
  if (projection?.auction && snapshot && snapshot.bid_count !== null) {
    const { bidCount, currentPriceMinor, currency, exponent, leaderPubky } = projection.auction;
    const bidRose = bidCount > snapshot.bid_count;
    if (bidRose && leaderPubky !== ownerId) {
      const kind: CommerceWatchAlertKind =
        snapshot.leader_pubky === ownerId && leaderPubky !== null ? 'outbid' : 'new_bid';
      alerts.push({
        ...baseAlert(kind, String(bidCount), 'projection', projection.serverRevision),
        previous_amount_minor: snapshot.bid_amount_minor,
        current_amount_minor: currentPriceMinor,
        currency,
        exponent,
        bid_count: bidCount,
      });
    }
  }

  // Price change — the index saw a newer revision with a different price.
  if (
    index &&
    snapshot &&
    snapshot.index_revision !== null &&
    snapshot.price_minor !== null &&
    index.revision > snapshot.index_revision &&
    index.priceMinor !== snapshot.price_minor
  ) {
    alerts.push({
      ...baseAlert('price_change', String(index.revision), 'index', index.revision),
      previous_amount_minor: snapshot.price_minor,
      current_amount_minor: index.priceMinor,
      currency: index.currency,
      exponent: index.exponent,
    });
  }

  // State change — index vocabulary first; the projection's transition is
  // reported only when the index did not move in the same pass.
  const indexStateChanged = Boolean(index && snapshot?.index_state && index.state !== snapshot.index_state);
  if (index && snapshot?.index_state && indexStateChanged) {
    alerts.push({
      ...baseAlert('state_change', `${index.state}:${index.revision}`, 'index', index.revision),
      previous_state: snapshot.index_state,
      next_state: index.state,
    });
  } else if (projection && snapshot?.projection_state && projection.state !== snapshot.projection_state) {
    alerts.push({
      ...baseAlert(
        'state_change',
        `${projection.state}:${projection.serverRevision}`,
        'projection',
        projection.serverRevision,
      ),
      previous_state: snapshot.projection_state,
      next_state: projection.state,
    });
  }

  // Advance the baseline only for sources actually observed this pass.
  const nextSnapshot: CommerceWatchSnapshotModelSchema = {
    id: `${ownerId}|${listingId}`,
    owner_id: ownerId,
    listing_id: listingId,
    title,
    index_revision: index?.revision ?? snapshot?.index_revision ?? null,
    index_state: index?.state ?? snapshot?.index_state ?? null,
    price_minor: index?.priceMinor ?? snapshot?.price_minor ?? null,
    price_currency: index?.currency ?? snapshot?.price_currency ?? null,
    price_exponent: index?.exponent ?? snapshot?.price_exponent ?? null,
    auction_ends_at: observedEndsAt ?? snapshot?.auction_ends_at ?? null,
    server_revision: projection?.serverRevision ?? snapshot?.server_revision ?? null,
    projection_state: projection?.state ?? snapshot?.projection_state ?? null,
    bid_count: projection?.auction ? projection.auction.bidCount : (snapshot?.bid_count ?? null),
    bid_amount_minor: projection?.auction ? projection.auction.currentPriceMinor : (snapshot?.bid_amount_minor ?? null),
    leader_pubky: projection?.auction ? projection.auction.leaderPubky : (snapshot?.leader_pubky ?? null),
    ending_soon_alerted_ends_at: endingSoonAlertedEndsAt,
    checked_at: observedAt,
  };

  return { alerts, snapshot: nextSnapshot };
}
