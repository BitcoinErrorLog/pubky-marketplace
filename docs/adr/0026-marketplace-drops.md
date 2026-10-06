# ADR 0026: Marketplace Drops

## Status

Accepted — 2026-08-23 (design: [`../ecommerce/drops-design.md`](../ecommerce/drops-design.md))

## Context

A drop is scarcity with a clock: limited quantity, a launch instant, an end
by sell-out or schedule, and per-buyer limits. The genre's incumbents run
on unverifiable claims — terms that can change after hype, allocation
nobody can audit, edition numbers that die with the operator's database.
This stack can enforce the clock and the caps in the transaction service
(server time + constraint-backed one-winner semantics, ADR 0019), publish
the hype artifact as a seller-signed homeserver record (ADR 0020/0021),
and attest editions into the portable receipt the buyer already owns.

## Decision

### Authority split

- The **drop record** (`/pub/pubky.app/marketplace/v1/drops/{drop_id}`,
  specs fork) is the seller's signed announcement: title, teaser media,
  bundled listing ids, format, schedule intent, caps, stock-display
  policy. It is public and Nexus-indexable (unlike `/priv` records, it is
  wired into the URI parser).
- The **drop aggregate** on the transaction service is the enforced
  schedule and the only inventory truth. `drop.sync` registers it from the
  homeserver record exactly as `listing.sync` does for listings —
  convergent, any actor, path ownership as authority. The UI may render a
  countdown from the record; it may not render `live`, remaining stock,
  `sold out`, or an edition until the service says so.
- **Nexus** indexes drop records into a drops stream with state buckets
  computed from indexed times, displayed as estimates only.

### v1 semantics (format: `fcfs` only)

- States: `announced → live → ended(sold_out | closed | cancelled)`.
  `live` begins at server-time `startsAt`; `ended_closed` at `endsAt`
  (when present); `ended_sold_out` when **paid** quantity reaches
  `totalQuantity` (paid never un-pays; external refunds do not restock);
  `ended_cancelled` by the seller's `drop.cancel`. Transitions are applied
  lazily on touch and swept by the worker, both on server time.
- Holds (reservations/checkouts) decrement drop `remaining`; every
  existing release path (expiry, cancellation, auction lapse) credits it
  back. While the window is open, a lapsed hold restocks — "sold out" as a
  _display_ is `remaining == 0`, terminal sell-out is paid-out quantity.
- Per-buyer limits count units, tracked per `(drop, buyer)` in the same
  transaction as checkout, CHECK-constrained.
- A checkout containing a drop-bound line must contain only that drop's
  lines, with quantity 1 per line (v1 constraint, typed refusal). A
  listing may belong to at most one announced/live drop.
- Editions are assigned inside the exactly-once `confirm_order` path — a
  per-drop monotone sequence over paid units; lapsed holds never burn a
  number.

### Portable editions

A second compact JWS, `typ: pubky-drop-edition+v1` (claims
`v, iss, buyer, seller, drop, edition, of, receipt, iat`), issued
deterministically from stored rows via
`GET /v1/receipts/{id}/edition-attestation`, embedded in the portable
order-receipt record as the optional `editionAttestation` field with a
matching optional `drop {dropId, edition, of}` display object. A separate
attestation — never new claims inside `pubky-order-receipt+v1` — so
existing receipt verifiers are untouched.

### Stock-display honesty

The record's `stockDisplay` (`exact | bands | hidden`) is enforced
**server-side** in the public drop projection; exact numbers go only to
the seller. The client never invents stock levels, and the public
projection carries server time so countdowns render skew-corrected.

## Consequences

### Positive ✅

- The service's proven primitives (server-time deadlines, constraint-backed
  caps, exactly-once confirmation) extend to drops with no new trust.
- Pre-commitment (D2), auditable raffles (D3), and gated drops (D4) all
  layer on this aggregate without rework.
- Editions ride the shipped portable-receipt machinery; credible exit
  extends to "what number I got."

### Negative ❌

- Drop-bound checkout is deliberately restricted in v1 (single drop, qty 1
  per line); carts mixing drop and non-drop items are refused with copy.
- Every inventory-release path gains drop bookkeeping — a real invariant
  surface that needs its own concurrency tests at both cap boundaries.

### Neutral ⚠️

- No bot-proofness is claimed for FCFS; per-pubky limits bound
  enthusiasm, not sybils. Fairness beyond FCFS is D3's raffle.
- Sandbox mode gets no drops; server time is the feature.

## Related Decisions

- [ADR 0019: Marketplace Transaction Authority](0019-marketplace-transaction-authority.md)
- [ADR 0020: Marketplace Public Records](0020-marketplace-public-records.md)
- [ADR 0021: Marketplace Record Namespace](0021-marketplace-record-namespace.md)
- [ADR 0024: Portable Reputation](0024-portable-reputation.md)
- [ADR 0025: Marketplace v2 Namespace](0025-marketplace-v2-namespace.md)
