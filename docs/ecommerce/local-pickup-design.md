# Local Pickup — Design: Wave 7 (safe subset) and Wave 7b (deferred)

Status: built — Part A shipped, 2026-09-08. Read
[`shipping.md`](shipping.md) (address privacy boundary) and ADR-0019 §8 first;
this document extends both.

The review round cap was reached, and Wave 7 was demoted to the SAFE SUBSET;
the rest is deferred to Wave 7b. The document is therefore in two parts:

- **PART A — Wave 7 (build now).** Pickup without scheduling, without pickup
  returns, and without location grouping: `fulfillmentMethods` on the public
  record; seller pickup details sealed in the service; a pinned per-line
  snapshot taken at payment; the reveal of that snapshot to the paying
  buyer; the handover flow with its exits and reputation handling; and the
  checkout split per (seller, fulfillment).
- **PART B — Wave 7b (deferred, not built now).** The `pickup_schedule`
  aggregate and all scheduling, pickup returns and the return-address reveal
  route, and `location_key` grouping. The design is kept in full —
  corrected by the round-3 findings — so 7b starts from a corrected design,
  but nothing in Part B ships in Wave 7.

## Policy this design must satisfy

A physical address is shared only when its owner chooses to, for a reason
shown to them, with the one person who needs it. Buyer → seller: only the
delivery address, only for shipped items, only once the order exists (the
existing `checkout.create` path, withheld from all read projections).
Seller → buyer: nothing by default beyond a tracking number — except local
pickup, where the seller deliberately publishes a meeting point per listing,
revealed only to the paying buyer, and the meeting point may be a public
pickup spot instead of a home. No third party, including the operator, reads
an address in the clear beyond what the transaction service needs to deliver
it to the entitled peer.

## Prior art and what this design fixes

The prior art is PR 22 on `BitcoinErrorLog/pubky-app` (the
`services/marketplace` prototype engine plus its client). It stored
`pickupDetails` on the **service-side listing aggregate**, written by
`listing.register`, and revealed them by copying the first order line's
listing details onto the order projection when the payment confirmed. The
naming defect: **the details rode `listing.register`, which `listing.sync`
converges** — a sync replays the owner-signed record (which carries no
details) over the listing aggregate, so any sync from a device without the
details nulls them. A second defect: the reveal copied the address onto the
cached, shape-logged order projection. Known issues, and how this design
answers each:

| Prior-art issue                                                 | Fix here                                                                                                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed carts silently fall back to shipping (`?? 'shipping'`)    | One order per (seller, fulfillment) in Wave 7 — extended to per pickup location via a deterministic `location_key` in Wave 7b (§B1); the buyer's choice is never overridden (§A2) |
| Reveal reads only the first line                                | Reveal is per order line, every line of the order (§A3)                                                                                                                           |
| Details ride `listing.register`, which `listing.sync` converges | Details are a separate service aggregate written only by `pickup_details.set`/`pickup_details.clear`; sync carries no details and cannot null them (§A1, §A4)                     |
| Reveal copies details onto the cached order projection          | Dedicated reveal read; the projection never carries details (§A3)                                                                                                                 |
| No DB version bump                                              | Postgres migration is in the plan (§A8); the client needs no Dexie bump — pickup details are memory-only (§A1)                                                                    |
| No durable-service counterpart                                  | Full service design: commands, state machines, sealed storage, reveal entitlement (§A1, §A6, §A7)                                                                                 |

# PART A — Wave 7 (build now)

## A1. Data model

| Data                                                                                | Lives                                                                                                                                                                                                                                 | Who can read it                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing `fulfillmentMethods` (`shipping` \| `pickup` \| both)                       | Owner-signed listing record; echoed to the service at `listing.register`/`listing.sync`                                                                                                                                               | Public, like the rest of the listing                                                                                                                                                   |
| Optional coarse pickup area (city/neighborhood, free text, capped at 80 characters) | Owner-signed listing record                                                                                                                                                                                                           | Public — the seller's own choice to publish an **approximate** area; never the meeting point. The editor warns that this text is public, signed, and indexable **forever** (slice 7.2) |
| Seller pickup details (address **or** spot, instructions, availability)             | Transaction service, `listing_pickup_details` table, **sealed** (below)                                                                                                                                                               | The seller (owner read) and the paying buyer (reveal read, §A3). Nobody else                                                                                                           |
| Buyer delivery address (shipped orders)                                             | Transaction service `orders.delivery_address` — unchanged                                                                                                                                                                             | Nobody through reads, per ADR-0019 §8                                                                                                                                                  |
| Device copies of any of the above                                                   | **Memory only — never persisted to Dexie or any storage.** The buyer's revealed address is fetched from the reveal read on each view; the seller's own details are fetched from the owner read when the editor opens (§A4, slice 7.2) | This browser session only; never a source of truth                                                                                                                                     |

The public listing record carries `fulfillmentMethods` and optionally the
coarse area — and nothing else about pickup. Details are never placed on the
record and stripped later; they are authored in a separate surface and sent
only to the service.

**Encrypted at rest? Yes — sealed service-side, like Locks bundle ids.** The
service already seals `bundle_id` with XChaCha20-Poly1305 under an
operator-held env key (`locks.rs`), with a fresh random nonce per seal and no
serialization path for the plaintext. Pickup details reuse that pattern:
`details_ciphertext` (address-or-spot, instructions, availability windows as
one JSON blob), AAD-bound to the listing aggregate id and details version,
under a new `PICKUP_DETAILS_ENCRYPTION_KEY` that must be distinct from the
Locks key (the existing distinctness check is the template). Wave 7 seals
**two families** under this pattern: the details versions here, and the
per-line pinned snapshots written at payment (§A3).

**Key rotation is supported, not deferred.** The env config accepts an
optional previous key (`PICKUP_DETAILS_ENCRYPTION_KEY_PREVIOUS`): opens try
the current key, then the previous one (a dual-key read window), and a
re-seal job walks rows still sealed under the previous key and re-seals them
under the current one, in batches, on server time. The job covers **both
sealed families Wave 7 introduces** — the details versions **and** the
pinned payment snapshots — and its completion criterion is over both:
rotation is complete only when zero rows in either family remain sealed
under the previous key. Rotation is therefore: deploy with both keys, run
the re-seal job to completion (observable by count over both families),
remove the previous key. A row's key vintage needs no marker column — the
open simply tries current-then-previous. Deleted-version ciphertext also
lives in DB backups and replicas until those rotate (§A3 retention); sealing
bounds, but does not erase, that lifetime.

Why sealed rather than plaintext-in-service (the buyer-address precedent):
ADR-0019 §8 says private data is encrypted at rest, and the sealing module
now exists, so the marginal cost is small. A database dump, backup, or
replica snapshot then yields no meeting points, and ad-hoc operator SQL reads
ciphertext. The honest limit: the operator holds the key, so the operator
_can_ decrypt — sealing does not remove the operator from the trust boundary,
it removes casual and bulk exposure. The policy's operator clause is met
because the service legitimately needs the plaintext at reveal time, and the
only two read paths that ever decrypt are the seller's own read and the
paying buyer's reveal read; support/moderation projections stay redacted.
The decrypted plaintext must never reach logs, traces, or Sentry: the
details types get a redacted `Debug` impl (the `locks.rs` pattern), the two
entitled responses are excluded from request/response-body logging, and a
redaction-scanning test mirrors the one in `locks.rs` (slice 7.1).

Why not end-to-end encrypted to the buyer: the buyer is unknown when the
seller authors the details. E2E would require the seller to be online after
every payment to encrypt to that buyer — which is exactly the device-local
failure mode the prior art hit (no cross-device recovery, no durable reveal).
The service must be able to reveal to the entitled peer on payment without
seller involvement.

Pickup details may be a full address **or** a pickup spot (free-text meeting
point such as "Central Station, north entrance" plus optional instructions).
The UI presents the spot option first and says why: the seller never has to
publish their home. Availability windows are authored with the details and
pinned at payment, but Wave 7 has **no propose path**: the buyer sees the
pinned windows read-only (§A3). Scheduling arrives in Wave 7b (§B2).

## A2. Checkout

Each cart seller group gets one `fulfillmentChoice`: `shipping` or `pickup`,
defaulting to `shipping`, selectable only among the methods the group's
listings actually publish. The choice rides `checkout.create` as an optional
`fulfillment` field per line (snake_case on the wire, camelCase client-side
via the wire-casing layer, as with variants); the service validates that all
lines of one seller group share one choice and that every line's listing
allows it.

**Mixed carts: one order per (seller, fulfillment).** The service already
splits a checkout into one order per seller (`handlers/checkout.rs` groups
lines by seller). The split key becomes `(seller, fulfillment)`. Wave 7 has
**no `location_key`**: several pickup lines from one seller share one pickup
order even when their listings publish different meeting points, and the
reveal is therefore **per order line** (§A3) — one Wave 7 pickup order may
carry several lines and several meeting points, each revealed against its
own pinned snapshot. Grouping lines by identical meeting point — the
deterministic `location_key` HMAC — is deferred to Wave 7b (§B1), where one
order again maps to exactly one meeting point. A cart with seller A shipping

- pickup at two different spots and seller B shipping produces **three**
  orders in Wave 7 (the two spots share one pickup order); 7b restores the
  four-order split. There is no silent fallback: a group whose chosen
  fulfillment is not published by every one of its lines is refused with a
  typed error — the buyer's choice is never rewritten to shipping (the prior
  art's `?? 'shipping'`). Justification over blocking the whole cart: blocking
  forces cart surgery for a common case (one heavy item the buyer wants to
  collect, the rest posted). Splitting keeps every order single-fulfillment,
  so reveal, shipping charge, and packing slip logic stay uniform per order.
  The checkout UI states the split plainly before submit ("This places 3
  orders").

**Pickup charges no shipping.** The seller-signed flat rate applies only to
shipped orders; a pickup order's `shipping_minor` is 0 and its totals reflect
that. The client must show the shipping line drop to 0 when the buyer picks
pickup — never charge shipping and refund it later.

`delivery_address` in the checkout payload becomes optional: required when
any group ships (and it is then stored only on the shipped orders), absent
when every group is pickup. Pickup-only checkouts therefore send **no** buyer
address at all — the strictest reading of the policy, and less data held.
Omission is not enough: a pickup-only checkout that **presents** a
`delivery_address` is rejected with `INVALID_COMMAND` (the PR 22 behavior),
so a buggy or malicious client cannot smuggle an address into storage the
policy says should not exist.

**Axis reconciliation: item type vs fulfillment.** The listing form's
existing `physical` | `digital` axis is the item type; PR 22's
`Array<'physical' | 'digital' | 'pickup'>` conflated that axis with
fulfillment. This design keeps them separate: item type stays
`physical` | `digital`; `fulfillmentMethods` (`shipping` | `pickup` | both)
is a distinct field, meaningful only for physical items. Digital listings
have no fulfillment choice: they are excluded from the
`(seller, fulfillment)` split key (their orders keep today's behavior) and
from the migration backfill (§A8).

v1 scope: pickup applies to fixed-price checkout. Auction listings are
shipping-only (auction orders carry no address and no checkout step; pickup
auctions are future work). Offers on a listing whose `fulfillmentMethods` is
not `shipping` are refused with a typed error rather than silently converted
to shipping.

## A3. Reveal

The meeting point is revealed **exactly on payment confirmation** — the
service's exactly-once `confirm_order` path (`payment_confirmation` /
`payment.sandbox_advance`) — **to the buyer only, per order line**:

- Reveal is a dedicated read, `GET /v1/orders/{id}/pickup-details`, not a
  field on the order projection. The standard projection (which clients
  cache, log shapes of, and render in lists) never carries details, so a
  replayed or cached projection cannot leak them.
- Authorization: the actor must be the order's buyer **and** the order must
  carry a durable payment fact — not merely sit in a state set. `cancelled`
  is reachable from `pending_payment`, so a "reached `paid`" state-membership
  check would reveal the meeting point to a buyer who never paid. The gate is
  the order's `receipt_id IS NOT NULL` — the durable paid fact recorded by
  the exactly-once confirmation path. Orders without it get a typed refusal.
  Sellers never call this endpoint; they read their own details through their
  seller-scoped read (§A4).
- The response is `Cache-Control: no-store` and the route is excluded from
  the service worker's cache (threat model WEB-03): the entitlement is
  re-evaluated against the durable fact on every read, and no intermediary or
  browser cache may serve the address.
- Per order line: the response serves the **pinned snapshot** recorded at
  payment (below) — kind, address-or-spot, instructions, **availability
  windows and their IANA zone, shown READ-ONLY** (Wave 7 has no propose
  path; the windows are informational, "when the seller is usually around" —
  scheduling arrives in §B2) — plus `version` and `updated_at`. After a
  `pickup_details.clear`, the pinned snapshot is served flagged
  withdrawn-by-seller. The reveal **never serves the listing's current
  details**: a paid buyer is entitled to the terms they paid against, not
  to whatever the seller publishes later. Every line is served, fixing
  the prior art's first-line-only read.
- **The entitlement ends.** The reveal read stops once the order is
  terminal: a buyer of a long-terminal order has no remaining need, and
  holding the entitlement open forever would leak every future version.
  **A paid order that is later cancelled is terminal at the cancel
  event** — on any cancel path, including the unilateral terms-change
  cancel and the bounded withdrawal below — so its entitlement ends
  there, not at some later deadline: the exact end condition is the
  order's transition into `cancelled`. From that transition on, the read
  is a typed refusal; the pinned snapshot is retained only as dispute
  evidence, until the seller's refund evidence is recorded
  (`refund.record_external`, ADR-0019) or, when no evidence ever lands,
  until the ordinary retention purge for terminal orders runs — and is
  then hard-deleted with the retained versions (retention below). Wave
  7b extends the cutoff to "terminal **and** its return window closed",
  because a pickup-method return still needs the hand-back meeting
  point (§B3).
- **Pinning happens inside `confirm_order`, in the receipt transaction.**
  The exactly-once confirmation function (`handlers/payment.rs`
  `confirm_order`, shared by `payment.sandbox_advance` and the
  verification worker) records, per pickup line, the details version
  (`version_at_payment`) **and a sealed snapshot of the details as shown
  at payment** — kind, address-or-spot, instructions, availability windows
  with their IANA zone — in the same transaction as the receipt insert.
  Each snapshot is sealed with **AAD = order id ‖ line index ‖ version**,
  so a snapshot cannot be transplanted across orders, lines, or versions.
  Because both confirmation paths call this one function, sandbox
  confirmations pin exactly like worker-confirmed payments — no worker-side
  afterthought that a sandbox advance would skip (slice 7.1). The pin also
  records **which adapter confirmed the payment** (`payment.sandbox_advance`
  or the verification worker's rail), and the reveal read refuses when the
  pinned adapter was `payment.sandbox_advance`, checked against the pin on
  every read and independent of the deployment's current sandbox flag — a
  flag toggle window (off→on→off) can never make a fake-money order's past
  reveal free (§A8). The pin drives the version-change flag, the buyer's
  unilateral-cancel unlock and bounded withdrawal (§A6), and later dispute
  reading. An absent `version_at_payment` JSON key on a line reads as "no
  terms version pinned" (pre-migration rows).

**Seller edits after payment.** `pickup_details.set` always bumps the
version (append-only history; retention below). Versions are **monotonic
per listing and never restart**: the per-listing version counter lives in
its own `listing_pickup_version_counters` row — **not** on the details row,
which `pickup_details.clear` hard-deletes — so it survives clear, and after
a clear the next `pickup_details.set` compare-and-swaps against the counter
row (post-clear CAS), continuing the sequence. No version number is ever
reused — terms-change detection (`current version > version_at_payment`)
therefore cannot be fooled by a delete-and-recreate. For every paid,
non-terminal pickup order on that listing, the outbox carries a
`pickup_details_updated` notification to the buyer, and the order view
flags "meeting point updated since you ordered" when current version >
`version_at_payment` (the reveal itself keeps serving the pinned
snapshot). Editing is always allowed — a seller who moves house cannot be
blocked — but it is never silent, and it is never free: a seller-actor
`fulfillment.confirm_pickup` is refused while the change is unresolved
(§A6), and the edit unlocks the buyer's unilateral cancel —
`order.cancel_request` moves the order straight to `cancelled`, no seller
approval, while the pickup terms changed after payment (current version >
`version_at_payment`, or the details were cleared). The seller is notified;
the refund remains seller-recorded external evidence per ADR-0019. (In
Wave 7b the edit additionally resets any live schedule on those orders,
§B2.)

**Buyer withdrawal after the first reveal.** Independently of any seller
edit, the buyer holds a **bounded withdrawal right**. The first successful
reveal read stamps a durable `first_revealed_at` on the order; from that
moment, `order.cancel_request` moves the order straight to `cancelled` —
no seller approval — from `paid` **or** `ready_for_pickup`, until either
party confirms the handover (`fulfillment.confirm_pickup`). The window
closes on the handover confirm only: `fulfillment.mark_ready` does **not**
close it — marking ready is seller-controlled and instant, so a window
that closed on it would let the seller delete the buyer's exit at will.
The exit therefore never depends on the seller editing or approving
anything: a buyer who reveals the meeting point and finds it
unusable-as-revealed (even with `current version == version_at_payment`)
can leave. Both unilateral exits emit a distinct event kind,
`order.cancelled_terms_change`, **not** `order.cancelled`, and the
reputation worker's `terminated_badly` aggregation — today
`BOOL_OR(order.cancelled) OR BOOL_OR(refund.recorded_external)` per order
(`workers.rs`) — excludes the **whole order** when its terminal cancel is
`order.cancelled_terms_change`, including any `refund.recorded_external`
leg on that same order (§A8, slice 7.1): a buyer can never ding the
seller's completion rate by exercising a buyer-protection exit, even when
a refund was recorded. Cancelling moves no money — the client copy says so
(slice 7.2); the refund stays seller-recorded external evidence
(`refund.record_external`, ADR-0019).

**Seller deletes the details.** `pickup_details.clear` removes the seller's
pickup details entirely (§A7). Retention keeps only the versions referenced
as `version_at_payment` by a paid, non-terminal order (Wave 7b extends this
to orders with an open return window, §B3); every other version is
hard-deleted. The per-listing version counter is **not** deleted (above —
versions never restart). The read path for a buyer whose order references a
retained version: the reveal endpoint keeps working and serves the pinned
snapshot, flagged as withdrawn-by-seller, in place of the current details
(there are none). Once every referencing order is terminal, the retained
versions and snapshots are purged — hard-deleted; their ciphertext persists
only inside DB backups and replicas until those rotate (§A1). One exception
to "terminal purges": a **cancelled-after-payment** order's pinned snapshot
outlives the cancel only until the seller's refund evidence is recorded
(`refund.record_external`, ADR-0019) — the snapshot is the dispute exhibit —
after which it is purged with the rest; if no evidence is ever recorded,
the ordinary terminal-order purge takes it. Clearing notifies the paid
buyers (`pickup_details_cleared`) and unlocks the same unilateral cancel.
The seller's owner read after a clear returns "no details" **alongside the
surviving version counter**, so the client's next `pickup_details.set` can
compare-and-swap against the counter (the post-clear CAS above) without a
hidden second read.

Cancellation **ends** the reveal. A paid order that is later cancelled is
terminal at the cancel event, on any cancel path — the ordinary approved
cancel, the unilateral terms-change cancel, and the bounded withdrawal
alike — and its reveal entitlement ends there (the cutoff above). The
pinned snapshot is retained only as dispute evidence: until the seller's
refund evidence is recorded (`refund.record_external`, ADR-0019) or,
failing that, until the retention purge for terminal orders runs. What the
buyer already saw while the order was live stays seen — that cannot be
un-happened — but no new read is served after the cancel. The entitlement
check is the durable payment fact plus this cutoff: it stays true through
`cancel_requested`, returns, and refunds that passed through payment, and
was never established for an order cancelled from `pending_payment`, which
never revealed anything.

## A4. Cross-device recovery (seller)

The service is the source of truth for pickup details, and the client holds
the seller's own details **in memory only** — the same rule as the buyer's
revealed copy (§A1), deliberately stricter than an earlier draft of this
section that planned an account-scoped Dexie read-through cache. A seller on
a new device opens the sell studio, the client issues the seller-scoped
details read, gets the sealed row opened for its owner, and the editor is
populated. Nothing was ever on the homeserver, and nothing is in Dexie, so
there is nothing to lose with a browser profile — and no local copy to
purge on account switch or to mark stale.

The self-heal rule that must hold: **no sync path may null service-side
details.** `listing.sync` converges only the public record's
`fulfillmentMethods`; it carries no details and therefore cannot overwrite
them. The only writes to details are the explicit seller commands
`pickup_details.set` (which requires the full payload — details are replaced
whole, version + 1, `expected_version` compare-and-swap against lost-update)
and `pickup_details.clear` (§A3, §A7). A client that issues a sync heals the
listing aggregate, not the details. The "unread row" save guard is satisfied
without any cache: the editor must load the current version through the
owner read before save is enabled, and the `expected_version` CAS on the
surviving counter (§A3) is the enforcement — a save against a version the
seller never read cannot be issued, and a save against a superseded version
conflicts.

## A5. Packing slip

The packing slip is suppressed for pickup orders: there is nothing to pack
and post, and printing the buyer's withheld-address notice for an order that
never had an address would confuse. The seller's order row for a pickup
order shows instead: line items and variant snapshots, and the seller's own
meeting-point details (owner read, already theirs). The print affordance is
hidden, not disabled-with-explanation — nothing about a pickup order needs
paper.

## A6. State machines

Additions to `contracts/state-machines.json`. Existing transitions are
untouched; shipped orders behave exactly as today. (The order machine
legitimately carries two pre-existing server triggers, `delivery_assume`
and `order_auto_complete` — Wave 6 housekeeping that predates this
document's "untouched" wording; they are not Part B scheduling, and Part A
adds no server triggers of its own.)

### Order aggregate (pickup path)

| From               | To                 | Trigger                                                                                                         | Actor             |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------- |
| `paid`             | `ready_for_pickup` | command `fulfillment.mark_ready`                                                                                | seller            |
| `paid`             | `delivered`        | command `fulfillment.confirm_pickup`                                                                            | buyer or seller   |
| `ready_for_pickup` | `delivered`        | command `fulfillment.confirm_pickup`                                                                            | buyer or seller   |
| `ready_for_pickup` | `cancel_requested` | command `order.cancel_request`                                                                                  | buyer             |
| `paid`             | `cancelled`        | command `order.cancel_request` (terms changed after payment, §A3)                                               | buyer, unilateral |
| `ready_for_pickup` | `cancelled`        | command `order.cancel_request` (terms changed after payment, §A3)                                               | buyer, unilateral |
| `paid`             | `cancelled`        | command `order.cancel_request` (bounded post-reveal withdrawal, §A3 — from first reveal until handover confirm) | buyer, unilateral |
| `ready_for_pickup` | `cancelled`        | command `order.cancel_request` (bounded post-reveal withdrawal, §A3 — from first reveal until handover confirm) | buyer, unilateral |

`fulfillment.ship` is refused for pickup orders and `mark_ready`/`confirm_pickup`
for shipped ones (`InvalidState`, typed). `confirm_pickup` is allowed for
**either party** — the buyer or the seller, whoever is standing there with
the item taps confirm — from `paid` as well as `ready_for_pickup`, so a
seller who never taps `mark_ready` cannot strand a paid order. One
asymmetry is binding: a **seller-actor** `fulfillment.confirm_pickup` is
refused (`InvalidState`, typed) while an unresolved post-payment terms
change exists on the order (current version > `version_at_payment`, or the
details were cleared, §A3); a buyer-actor confirm stays allowed. Without
this, a seller could edit the meeting point and immediately self-confirm
the handover, deleting the buyer's unilateral-cancel exit before the buyer
ever saw the change. There is no proof either way; the he-said/she-said
limitation is stated in the threat model.

**`confirm_pickup` writes a handover record.** The record carries who
confirmed and the **server instant** of the confirmation, and the order
event kind stays `fulfillment.delivered` — the same kind a shipped order's
`fulfillment.confirm_delivery` emits — so reputation and feed consumers see
one delivery fact. `pickup_handovers` has its **primary key on
`(order_id)`** — one handover per order; a duplicate or replayed confirm
cannot write a second row. The auto-complete sweep
(`complete_due_delivered_orders_batch`, which today reads
`shipment->>'delivered_at'` and would warn-and-skip a pickup order
forever) **coalesces the two sources**: the handover record's server
instant for pickup orders, the shipment `delivered_at` for shipped ones —
and its join locks **`FOR UPDATE OF orders`**, so the coalescing read
cannot deadlock against concurrent order writers. Auto-complete therefore
applies to pickup orders exactly as to shipped ones: a delivered pickup
order with no return completes on the same deadline, and
`fulfillment.delivered`-based reputation counts it — **with one
confirming-actor rule**: a handover confirmed by the seller alone is a
**seller-attested** handover, and reputation counts a pickup completion
only when the **buyer** confirmed, or when the order **auto-completed with
no buyer cancel or return in the window**. A seller's own confirm is never
reputation-positive on its own: the seller is paid at payment time, so a
self-confirm that also minted completion reputation would pay a fraudulent
seller twice — funds plus standing — for a handover nobody else witnessed
(§A8, threat model).

`order.cancel_request` stays buyer-only (`cancellation.rs` rejects any
non-buyer actor), and its allowed-from list gains `ready_for_pickup`
(slice 7.1). The unilateral rows fire only while a post-payment
pickup-terms change exists (version bump or clear, §A3) or while the
bounded withdrawal window is open (`first_revealed_at` stamped, no handover
confirm yet, §A3); outside those conditions — including a `cancel_request`
that races `fulfillment.mark_ready` before the first reveal — the same
command from `paid`/`ready_for_pickup` yields `cancel_requested` awaiting
the seller, as today, and the client renders that degraded response
honestly (§A8, slice 7.2).

`next_actor()` keeps its `Option<&'static str>` shape and its
`'buyer' | 'seller'` value set — no `'either'`: clients and tests assert on
those two literals. For a pickup order in `paid` the rule returns
`'seller'` (mark ready, or confirm the handover); in `ready_for_pickup`,
`'buyer'` (confirm the handover on receipt). Shipped orders keep today's
mapping unchanged. From `delivered` the existing transitions (return,
complete) apply as-is. Wave 7b replaces this rule with the proposal-aware
one (§B2).

**Contract shape.** The order aggregate's `states` gains
`ready_for_pickup` and its `transitions` gain the rows above. The order
gains **no other states**: the aggregate count stays at 8 —
`pickup_schedule` is a Wave 7b aggregate — so the
`contract_document_is_stable_json` test is untouched. The listing machine's
`sold → available` edge gains `order.cancel_request` in its `via` list
(the unilateral exits release inventory through approve's path, §A8), and
`listing_machine_enforces_inventory_flow` is extended to assert it (slice
7.1). The Actor column in these tables is documentation only: the contract
format has no actor field; actors are enforced in the handlers (slice 7.1).

## A7. Commands and roles

All commands use the existing versioned envelope with `command_id`
idempotency and `expected_revision`/`expected_version` CAS. Authorization is
object-level, as today.

| Command                      | Role                                                                                                                                           | Effect                                                                                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pickup_details.set`         | Seller, own listing only                                                                                                                       | Sealed upsert of details + availability; version + 1 (monotonic per listing via the counter row, §A3); notifies paid buyers on change; refused when pickup is off (no key, or sandbox payments enabled on the deployment, slice 7.1) |
| `pickup_details.clear`       | Seller, own listing only                                                                                                                       | Deletes the details; retains only versions referenced by a paid, non-terminal order; everything else hard-deleted; the counter row survives; notifies paid buyers (§A3)                                                              |
| `checkout.create` (extended) | Buyer                                                                                                                                          | Per-line `fulfillment`; splits per (seller, fulfillment); optional `delivery_address`                                                                                                                                                |
| `fulfillment.mark_ready`     | Seller, own order, state `paid`                                                                                                                | Order → `ready_for_pickup`; notifies buyer                                                                                                                                                                                           |
| `fulfillment.confirm_pickup` | Buyer **or** seller, own order, state `paid` or `ready_for_pickup`; seller-actor refused while a post-payment terms change is unresolved (§A6) | Order → `delivered`; writes the handover record (server instant); a seller-only confirm is **seller-attested** — reputation counts the completion only on a buyer confirm or a dispute-free auto-complete (§A6)                      |

Reads (not commands):

- `GET /v1/orders/{id}/pickup-details` — buyer only; keyed by **order id**
  (`Path<Uuid>`), matching the existing `GET /v1/orders/{id}` route keying.
  The order must carry the durable payment fact (reveal, §A3), and the read
  serves the **pinned snapshot** (`version_at_payment`), never the
  listing's current details — pinned-version precedence applies on every
  read, non-terminal or not; once the order is terminal the read is a typed
  refusal (§A3). The first successful read stamps `first_revealed_at` on
  the order (§A3). Refused outright on deployments with sandbox payments
  enabled (slice 7.1).
- `GET /v1/listings/{aggregate_id}/pickup-details` — seller only (owner
  read, §A4); keyed by **listing aggregate id**, matching the existing
  `/v1/listings/{aggregate_id}` route keying.

The version prefix stays `/v1` deliberately: these are new,
additive routes on the existing versioned API, and a `/v2` prefix exists to
signal breaking changes to routes clients already call — introducing one
here would split the API surface over no incompatibility. The service's
public config/health surface reports a `pickup_available` capability flag —
on iff `PICKUP_DETAILS_ENCRYPTION_KEY` is configured **and** sandbox
payments are disabled on the deployment (`config.sandbox_payments_enabled`,
slice 7.1). The client hides the pickup option everywhere when the flag is
off (slice 7.2). Wave 7b folds the return-address routes into the same flag
and probe (§B3).

No role outside the two participants can call any of these. Operator and
support projections contain no pickup-details read path — ciphertext only.

## A8. Migration plan and implementation sketch

The work ships in three explicit slices, each with its own test list and
gate — no slice merges until its gate is green:

- **Slice 7.0** — the TypeScript prototype engine
  (`services/marketplace/src/transaction-service.ts`, which ADR-0022
  designates the executable specification — see the `state_machines.rs`
  module header) plus its contract tests. Gate: the prototype's extended
  contract tests pass, and the prototype emits a machine document matching
  a checked-in expected document (below).
- **Slice 7.1** — the Rust service (schema, commands, handlers, workers,
  sealing, reveal reads). Gate: the full service test list below passes,
  including the redaction scan and the contract stability tests.
- **Slice 7.2** — the client (sell studio, checkout, orders,
  re-vendored contract artifacts; pickup details are memory-only, so no
  Dexie work). Gate: the client test list below passes,
  including the contract test against the re-vendored artifact, plus
  regenerated VRT baselines.

### Migration

1. **Prototype engine first** — slice 7.0, below. The prototype gains the
   new semantics before the Rust service, so the executable specification
   exists to diff against.
2. **Service Postgres migration** (new version, applied before code that
   uses it): `listing_pickup_details` (aggregate id, seller, version,
   `details_ciphertext`, append-only versions with the retention rule of
   §A3 — on `pickup_details.clear`, hard-delete every version not
   referenced as `version_at_payment` by a paid, non-terminal order, and
   purge retained versions once their referencing orders go terminal);
   `listing_pickup_version_counters` (the per-listing monotonic version
   counter in its **own row**, surviving `pickup_details.clear`, with
   post-clear CAS on the counter, §A3); per-order-line sealed pinned
   snapshots written at payment (AAD = order id ‖ line index ‖ version,
   §A3); `pickup_handovers` (primary key on `(order_id)`, confirming actor,
   server instant) written by `fulfillment.confirm_pickup` (§A6); order
   lines gain `fulfillment` and `version_at_payment` (nullable — an absent
   `version_at_payment` JSON key on a line reads as "no terms version
   pinned"); orders gain a **required** `fulfillment` column — not optional,
   not merely derivable: every order is exactly one fulfillment kind, and
   queries should not have to derive it — and a nullable `first_revealed_at`
   (the withdrawal-window stamp, §A3). No `location_key` column in Wave 7 —
   it lands with 7b (§B4). The reveal gate needs no new column: it is the
   existing `orders.receipt_id IS NOT NULL` (§A3). Backfill: all existing
   **physical** rows `fulfillment = 'shipping'`; digital listings are
   excluded from the backfill (§A2 — they carry no fulfillment choice).
3. **Contract version**: new commands and the extended `checkout.create` are
   additive; old clients default to shipping and are unaffected.
   `state-machines.json` gains §A6 with `contract_version` **staying 1** —
   the change is additive, and no client pins the version (verified: the
   client contract test, `src/libs/commerce/state-machines.contract.test.ts`
   in the app repo, covers aggregate names, states, and transitions against
   the artifact but never reads `contract_version`). The service's
   `contract_document_is_stable_json` test asserts exactly 8 aggregates and
   **stays at 8** — `pickup_schedule` is deferred to 7b (§B4) — while the
   listing machine's `sold → available` edge gains `order.cancel_request`
   in its `via` list (slice 7.1).
4. **Client persistence: none.** Pickup details are memory-only in the
   client (§A1): the buyer's revealed address is never persisted, and the
   seller's own details are likewise held in memory only — the owner read
   (§A4) populates the editor on open. No Dexie table, no schema bump.
5. Rollout: service first (accepts new commands, defaults keep old behavior),
   client second. Deployments with sandbox payments enabled never store or
   reveal pickup details — `pickup_details.set` and the reveal read are
   refused whenever `config.sandbox_payments_enabled` is on (slice 7.1),
   so no real meeting point can be stored against fake money. Staging runs
   durable mode against **test rails** — testnet BTC, Stripe test, PayPal
   sandbox — which exercise the real confirmation flow without real money,
   so fake meeting spots on staging are fine; local dev does the same.

### Slice 7.0 — prototype engine and contract tests

The prototype (`services/marketplace/src/transaction-service.ts`) gains the
new semantics first, as the executable specification. Its contract tests
are extended to cover:

- pickup details withheld until payment confirms, then revealed per line
  from the pinned snapshot;
- a pickup checkout presenting a `deliveryAddress` → `INVALID_COMMAND`
  (and a shipped checkout missing one → `INVALID_COMMAND`, the PR 22 pair);
- mixed-cart split per `(seller, fulfillment)` — several pickup lines from
  one seller share one order — with shipping zeroed on pickup orders;
- `version_at_payment` pinned per line inside confirmation (snapshot AAD =
  order id ‖ line index ‖ version); unilateral buyer cancel after a
  post-payment terms change, and the bounded post-reveal withdrawal from
  first reveal until handover confirm — `mark_ready` does **not** close the
  window;
- seller-actor `confirm_pickup` refused while a terms change is
  unresolved; auto-complete of a delivered pickup order from the handover
  instant;
- monotonic per-listing versions across clear via the separate counters
  row: clear-then-set continues the sequence.

Gate: the extended prototype contract tests pass, and the prototype's
emitted machine document matches a **checked-in expected document**
committed alongside the prototype in this slice; once the service vendors
the artifact in 7.1, the same emitted document is additionally diffed
against the vendored `state-machines.json`. Slice 7.0 therefore never gates
against an artifact that only lands in a later slice.

### Slice 7.1 — service sketch

- `crates/domain/src/commands.rs`: `SetPickupDetailsPayload` (listing
  aggregate, `expected_version`, details: kind address|spot, fields,
  instructions, availability windows | arrange-after-payment, IANA zone),
  `ClearPickupDetailsPayload`, `MarkReadyForPickupPayload`,
  `ConfirmPickupPayload`; `fulfillment` on `CheckoutLine`;
  `delivery_address` optional on `CreateCheckoutPayload` (required iff any
  shipped group). Validation mirrors the address-field limits already used
  for `DeliveryAddress`.
- New `crates/service/src/handlers/pickup.rs`: details set (seller-only,
  seal, monotonic version bump via the counters row with post-clear CAS,
  paid-buyer notifications), details clear (retention rule of §A3:
  hard-delete unreferenced versions, keep and later purge the pinned ones;
  the per-listing version counter row survives), and both reveal reads with
  their entitlement checks (`receipt_id IS NOT NULL` plus the terminal
  cutoff for the buyer read, §A3; pinned snapshot served, never current
  details; first successful buyer read stamps `first_revealed_at`).
- `handlers/payment.rs`: `confirm_order` — the one exactly-once writer,
  shared by `payment.sandbox_advance` and the verification worker — gains
  the pickup pinning **in the receipt transaction**: per pickup line,
  record `version_at_payment`, the sealed pinned snapshot (kind,
  address-or-spot, instructions, availability windows with IANA zone; AAD =
  order id ‖ line index ‖ version), **and the confirming payment adapter**
  (`payment.sandbox_advance` or the worker's rail). Sandbox confirmations
  therefore pin exactly like worker-confirmed payments (§A3), and the
  reveal read refuses a snapshot whose pinned adapter was
  `payment.sandbox_advance` regardless of the deployment's current sandbox
  flag — a flag toggle window cannot free a past fake-money reveal (§A3).
- `handlers/fulfillment.rs` (all `fulfillment.*` commands stay here):
  `fulfillment.ship` (allowed from `paid`/`processing` today) and
  `fulfillment.confirm_delivery` gain the fulfillment guard — refused for
  pickup orders, `InvalidState`; `fulfillment.mark_ready` and
  `fulfillment.confirm_pickup` are added here, guarded the other way for
  shipped orders. `confirm_pickup` enforces the seller-actor refusal while
  an unresolved post-payment terms change exists (§A6), writes the
  handover record (confirming actor + server instant, one row per order —
  PK on `(order_id)`), and emits event kind `fulfillment.delivered`.
- `handlers/checkout.rs`: group physical lines by `(seller, fulfillment)`
  — no `location_key` in Wave 7, so all pickup lines of one seller share
  one order and the reveal is per line (digital lines stay outside the
  split key, §A2); refuse disallowed choices with typed errors — never fall
  back to shipping; reject a pickup-only checkout that presents a
  `delivery_address` with `INVALID_COMMAND`; zero shipping on pickup
  orders; store address only on shipped orders.
- `handlers/cancellation.rs`: `order.cancel_request` stays buyer-only (the
  existing actor check); the allowed-from list (today
  `pending_payment` | `paid` | `processing`) gains `ready_for_pickup`. New
  unilateral path: from `paid` or `ready_for_pickup`, when a post-payment
  pickup-terms change exists (any line's current details version >
  `version_at_payment`, or the details were cleared) — or while the bounded
  withdrawal window is open (`first_revealed_at` stamped, no handover
  confirm yet, §A3) — the request transitions the order straight to
  `cancelled`, no seller approval, and **reuses `approve`'s release path
  verbatim**: `credit_order_drop` plus `release_lines(HeldQuantity::Sold)`,
  so held-then-sold inventory returns to the listing exactly as an approved
  cancel does today. The event kind is the distinct
  `order.cancelled_terms_change` (not `order.cancelled`). Otherwise the
  command yields `cancel_requested` as today. The refund remains
  seller-recorded external evidence (`refund.record_external`, ADR-0019)
  either way.
- `workers.rs`: the retention purge of pinned versions and snapshots once
  referencing orders go terminal — with the cancelled-order exception of
  §A3 (a cancelled-after-payment snapshot lives until refund evidence is
  recorded, then purges); the key-rotation re-seal job covering
  **both sealed families** (details versions and pinned snapshots) with its
  completion criterion over both (§A1) — all server-time, deduplicated
  through the existing outbox. The auto-complete sweep
  (`complete_due_delivered_orders_batch`) coalesces the delivery instant
  from the handover record (pickup) or `shipment->>'delivered_at'`
  (shipped), locking its join **`FOR UPDATE OF orders`**, so pickup orders
  auto-complete on the same deadline instead of warn-and-skipping every
  sweep (§A6). The reputation worker's `terminated_badly` aggregation
  excludes the **whole order** — both the `order.cancelled` leg and any
  `refund.recorded_external` leg on the same order — when its terminal
  cancel is `order.cancelled_terms_change`. The same worker's completion
  counting gains the confirming-actor rule (§A6): a pickup completion
  counts only when the **buyer** confirmed the handover, or when the order
  **auto-completed with no buyer cancel or return in the window**; a
  seller-unilateral confirm counts only after that dispute-free
  auto-complete, never at confirm time. There are no reminder or
  proposal sweeps in Wave 7 (§B2). The version pin is **not** here — it
  lives in `confirm_order` (above), the only writer both confirmation paths
  share.
- Boot-time probe: a named `assert_pickup_sealing_coherent` check runs at
  startup **after migrations** (schema must exist first) and refuses to
  start if sealed pickup rows exist without `PICKUP_DETAILS_ENCRYPTION_KEY`
  configured — the pickup counterpart of the Locks env all-or-none check,
  explicit rather than a lazy first-read failure. The probe attempts **one
  real open, current key then previous key, across both sealed families**
  (a details version and a pinned snapshot) — openability, not mere row
  existence — so a wrong or half-rotated key fails the boot, not the first
  buyer's reveal.
- `model.rs`: `PickupDetailsRow` (no plaintext serialization path — only
  the two entitled reads open the seal), `PickupHandoverRow`, order line
  extension (`fulfillment`, `version_at_payment`). `next_actor()` implements
  the pickup rule of §A6 (`'seller'` in `paid`, `'buyer'` in
  `ready_for_pickup`; `'buyer' | 'seller'` only).
- Encryption: extract the seal/open helpers from `locks.rs` into a shared
  module; add `PICKUP_DETAILS_ENCRYPTION_KEY` (plus the optional
  `PICKUP_DETAILS_ENCRYPTION_KEY_PREVIOUS` dual-key read window and the
  two-family re-seal job, §A1) with the same key-distinctness check.
  All-or-none config gating, binding: pickup is OFF unless
  `PICKUP_DETAILS_ENCRYPTION_KEY` is configured — the service refuses
  `pickup_details.set` without it and refuses to start via the boot probe
  above; details are never stored plaintext. Independently, both
  `pickup_details.set` **and the buyer reveal read** are refused whenever
  `config.sandbox_payments_enabled` is on — the deployment boundary
  (executor.rs), not the per-order adapter column, which reads `sandbox`
  for every order at checkout until a rail is chosen. The adapter pinned
  **at confirmation** is accurate, though, and the reveal checks it
  independently: the deployment flag gates storing and new reveals, the
  pinned adapter gates past ones (§A3, `handlers/payment.rs` above).
  Staging uses test rails (§A8 rollout). The public config/health surface reports
  `pickup_available` (key configured AND sandbox payments disabled) so
  clients can hide the pickup option (§A7, slice 7.2).
- Redaction: the details types get a redacted `Debug` impl and the two
  entitled responses are excluded from request/response-body logging and
  tracing (the `locks.rs` pattern), so the decrypted reveal cannot reach
  logs, traces, or Sentry (§A1).
- Notifications: new types `pickup_details_updated`,
  `pickup_details_cleared`, `pickup_ready`.

Service tests (slice 7.1 gate — all must pass):

- unpaid buyer reveal → typed refusal; paid buyer → the pinned snapshot per
  line (never current details, even after later edits);
  buyer reveal on an order cancelled from `pending_payment` → typed refusal
  (`receipt_id` is null — no durable payment fact was ever recorded);
  cancelled-after-payment buyer reveal → typed refusal **from the cancel
  event on**, on every cancel path — the ordinary approved cancel, the
  unilateral terms-change cancel, and the bounded withdrawal — while the
  pinned snapshot is retained until the seller's refund evidence is
  recorded and purged once it is (or with the terminal-order purge when no
  evidence lands); any other terminal order → typed refusal (the
  entitlement ends, §A3);
- seller reveal read → own details; other seller → unauthorized;
- projection replay contains no details fields (shape assertion);
- redaction scan, mirroring the `locks.rs` test: no serialization surface
  (command results, projections, notifications, logs) contains plaintext
  details, and the redacted `Debug` impls hold;
- mixed cart splits per (seller, fulfillment) with digital lines outside
  the split key and the backfill; several pickup lines from one seller
  share one pickup order; shipping charged only on shipped orders;
  pickup-only checkout sends and stores no address; pickup-only checkout
  presenting a `delivery_address` → `INVALID_COMMAND`;
- pinning: both confirmation paths (`payment.sandbox_advance` and the
  verification worker) pin `version_at_payment` + snapshot **+ confirming
  adapter** in the receipt transaction; the snapshot survives later edits
  and clears; the snapshot opens only under AAD = order id ‖ line index ‖
  version — a wrong order id, line index, or version fails the open; a
  snapshot pinned under `payment.sandbox_advance` is refused by the reveal
  **even after the deployment sandbox flag flips back off** — the pinned
  adapter, not the current flag, decides;
- versions are monotonic per listing across clear: the counter lives in its
  own `listing_pickup_version_counters` row and survives
  `pickup_details.clear`; the post-clear `set` CAS on the counter continues
  the sequence, and terms-change detection still fires against a pre-clear
  `version_at_payment`;
- details edit after payment bumps version and notifies exactly the paid
  buyers;
- unilateral cancel: with a post-payment version bump (or a clear),
  `order.cancel_request` from `paid`/`ready_for_pickup` → `cancelled`
  immediately, seller notified, event kind `order.cancelled_terms_change`,
  and inventory released via the same path as an approved cancel (drop
  credited, sold lines released, listing back to `available`); bounded
  withdrawal after the first reveal → `cancelled` the same way from `paid`
  **and** from `ready_for_pickup` (`mark_ready` does not close the window),
  and → `InvalidState` once a handover confirm has happened; with neither
  condition (no terms change, no first reveal yet) the same command →
  `cancel_requested`; a non-buyer actor is rejected in every case;
- `order.cancelled_terms_change` is excluded from the reputation worker's
  `terminated_badly` window as a **whole order**: the exclusion holds when
  the same order also carries a `refund.recorded_external` leg; ordinary
  `order.cancelled` still counts;
- the listing machine contract declares `sold → available` via
  `order.cancel_request` as well as `order.cancel_approve`
  (`listing_machine_enforces_inventory_flow` extended);
- `pickup_details.clear`: unreferenced versions hard-deleted; versions
  pinned by paid, non-terminal orders retained and served
  pinned-and-flagged-withdrawn on the buyer reveal; retained versions
  purged once the referencing orders go terminal — with a
  cancelled-after-payment order's snapshot living until refund evidence is
  recorded, then purging; owner read returns no details **with the
  surviving version counter**, and the next `set` CASes against it;
- `confirm_pickup` by buyer and by seller, from `paid` and from
  `ready_for_pickup`, all succeed; seller-actor `confirm_pickup` with an
  unresolved terms change → typed refusal while buyer-actor succeeds; the
  handover record carries the actor and a server instant; a duplicate or
  replayed confirm cannot write a second handover row (PK on `(order_id)`);
- auto-complete: a delivered pickup order completes from the handover
  instant on the same deadline as a shipped order from
  `shipment->>'delivered_at'`; the sweep locks `FOR UPDATE OF orders` and
  emits no per-order warnings for pickup rows;
  `fulfillment.delivered`-based reputation counts pickup completions
  **under the confirming-actor rule**: a buyer-confirmed handover counts at
  once; a seller-unilateral confirm counts only once the order
  auto-completes with no buyer cancel or return in the window, and never
  counts when the buyer cancelled or returned in that window;
- `fulfillment.ship` and `fulfillment.confirm_delivery` refused on pickup
  orders; `mark_ready`/`confirm_pickup` refused on shipped orders;
- `next_actor` for pickup orders: `'seller'` in `paid`, `'buyer'` in
  `ready_for_pickup` — never any other value;
- `cancel_request` racing `mark_ready` before any first reveal resolves to
  the ordinary `cancel_requested` (no unilateral exit without a stamped
  `first_revealed_at`), and command replay is idempotent;
- `listing.sync` never alters details; `pickup_details.set` with stale
  `expected_version` conflicts;
- sealed round-trip with wrong key / wrong AAD fails; distinct-key check
  enforced; key absent → `pickup_details.set` refused, the
  `assert_pickup_sealing_coherent` boot probe (run after migrations)
  refuses startup when sealed rows exist — and when its trial open under
  current-then-previous key fails in either family — and `pickup_available`
  reports off; the dual-key read window opens rows sealed under the
  previous key in both families, and the re-seal job re-seals both families
  under the current key and reports completion only when zero rows in
  either family remain under the previous key;
- sandbox payments enabled (`config.sandbox_payments_enabled`) →
  `pickup_details.set` refused, the buyer reveal read refused, and
  `pickup_available` reports off.

### Slice 7.2 — client sketch

- Contract artifacts: re-vendor `src/libs/commerce/contracts/state-machines.json`
  from the service artifact; add `ready_for_pickup` to the order state enum
  and to the machine's transitions map (every new state needs a key
  there). The aggregate set is unchanged (still 8 — no `pickup_schedule`
  in Wave 7). The existing contract test then covers the new shape
  unchanged.
- Command registry and wire types: the new commands (`pickup_details.set`,
  `pickup_details.clear`, `fulfillment.mark_ready`,
  `fulfillment.confirm_pickup`) and the extended `checkout.create` are
  registered in the client's command registry with their wire types,
  through the existing wire-casing layer; the order timeline renders
  `order.cancelled_terms_change` as its own event — distinct from
  `order.cancelled` — with copy that names the buyer-protection exit.
- Capability: when the service's config/health surface reports
  `pickup_available` off, the pickup option is hidden everywhere — sell
  studio, listing form, checkout selector (§A7). The sell studio copy says
  why when a seller asks: pickup details cannot be saved while the service
  runs without pickup encryption configured or on a sandbox-payments
  deployment ("Pickup is unavailable in this environment").
- Sell studio: pickup section per listing — method toggle
  (`fulfillmentMethods`), spot-first details form, availability editor
  (windows are read-only information for the buyer in Wave 7), optional
  coarse area with the 80-character cap and the warning that the text is
  public, signed, and indexable **forever** (§A1), and a delete
  affordance (`pickup_details.clear`) that warns what paid buyers keep
  (§A3). `react-hook-form` + `zod` with a sibling `*.types.ts`, per the
  forms convention; submission wrapped in a hook (`usePickupDetailsForm`)
  calling the controller.
- Checkout: per-seller-group fulfillment selector with the shipping line
  dropping to 0 on pickup; address form hidden when every group is pickup;
  explicit "places N orders" copy for mixed carts.
- Orders: buyer pickup panel (per-line details after payment, the pinned
  availability windows rendered **read-only**, version-change and
  withdrawn-by-seller notices, unilateral-cancel affordance shown only when
  the service flags a post-payment terms change or the bounded withdrawal
  window is open), seller ready/hand-off actions — both parties get the
  confirm-hand-off action — notifications rendering for the new types.
  Packing-slip affordance suppressed on pickup orders. The confirm-hand-off
  action carries the review-hook copy "Only confirm once the item is in
  your hands". A seller-confirmed handover the buyer disputes gets **no**
  dispute/report affordance (owner decision, threat model): this p2p
  marketplace has no operator and no arbiter, so the buyer's recourse is
  the review plus the §A6 reputation asymmetry — a seller-attested handover
  counts toward reputation only once the buyer confirms or the window
  passes dispute-free. `next_actor` renders
  only `'buyer' | 'seller'` per the §A6 rule.
- Degraded response on a lost race: when `order.cancel_request` is sent on
  the strength of a stale view and the service answers with the ordinary
  `cancel_requested` (e.g. the request raced `fulfillment.mark_ready`
  before the first reveal, or the withdrawal window was never open), the
  client renders that outcome honestly — "Instant cancellation was not
  available; your cancellation request now awaits the seller." — instead of
  the unilateral-exit copy.
- Cancelling moves no money — required buyer-facing copy: both unilateral
  exits (terms-change and bounded withdrawal) state plainly in the confirm
  dialog that cancelling moves no money and any refund stays between the
  peers as seller-recorded external evidence (`refund.record_external`,
  ADR-0019), e.g. "Cancelling does not move any money. If you already
  paid, the refund is arranged with the seller and recorded as external
  evidence."
- Telemetry masking (binding): every surface that renders pickup details —
  the buyer reveal panel, the seller owner-read editor — carries
  `data-sentry-mask`; Sentry Replay keeps `maskAllText`/`maskAllInputs` on
  these surfaces (the shipping.md precedent); the decrypted payload is
  never logged, sent to analytics, or included in error reports.
- Client-side caching: none. The revealed address is held in memory only —
  never persisted to Dexie or any storage (§A1) — and fetched from the
  reveal read on each view. The seller's own details are likewise
  memory-only: the owner read populates the editor on open, save stays
  disabled until that read succeeds, and the CAS version counter enforces
  against lost-update (§A4); sync paths never write details.
- VRT: order detail and sell-studio surfaces change; regenerate the
  affected baselines and add coverage for the pickup panel.

Client tests (slice 7.2 gate — all must pass, VRT baselines regenerated):

- contract test passes against the re-vendored `state-machines.json`:
  `ready_for_pickup` in the order enum with its transitions-map key, and
  the aggregate count unchanged at 8;
- the new commands are present in the command registry with their wire
  types, and the timeline renders `order.cancelled_terms_change` distinctly
  from `order.cancelled`;
- capability off → pickup hidden in sell studio, listing form, and checkout;
  sandbox/unavailable copy renders in the sell studio;
- checkout groups get independent choices; mixed cart submits one command
  and surfaces the N-orders copy; pickup zeroes the shipping line;
- pickup-only checkout renders no address form and sends no address;
- reveal panel renders only when the reveal read succeeds (the service
  gates on the durable payment fact, not the projection state); pinned
  windows render read-only; version notice and withdrawn notice appear when
  the service reports them; unilateral-cancel affordance appears on a
  flagged terms change and during the bounded withdrawal window, and its
  dialog carries the "cancelling moves no money" copy;
- a `cancel_request` that the service answers with `cancel_requested` (the
  lost-race degraded response) renders the degraded copy, not the
  unilateral-exit copy;
- telemetry: reveal panel and owner-read editor carry `data-sentry-mask`,
  and the revealed payload appears in no log or analytics call;
- pickup details are written to no Dexie table — the buyer's revealed
  address and the seller's own details alike (memory-only assertion);
- sell studio recovers details on a fresh profile (mocked owner read);
  save stays disabled until the owner read succeeds and submits the read's
  version as the CAS; delete affordance issues
  `pickup_details.clear`; coarse-area editor enforces the cap and renders
  the public-forever warning;
- packing slip hidden on pickup orders, unchanged on shipped ones;

# PART B — Wave 7b (deferred, not built now)

Nothing in this part ships in Wave 7. The text below is the deferred
design, kept in full and corrected by the round-3 findings (N-1, N-2, N-5,
N-6; the locking discipline applied to the auto-complete sweep in §A6
extends to the 7b sweeps). When 7b ships, it layers onto Part A: nothing in
Part A is redesigned, only extended.

## B1. Pickup-location grouping (`location_key`)

Wave 7's split key `(seller, fulfillment)` means one pickup order can span
several meeting points (§A2). Wave 7b restores one meeting point per order:
the split key becomes `(seller, fulfillment, location_key)`, where
`location_key` is a **deterministic, non-secret lookup token** for the
line's listing pickup details: HMAC-SHA256 over **seller id ‖ 0x0A ‖ the
canonical location plaintext** (normalized kind + address-or-spot fields) —
the seller prefix scopes equality to one seller, so the token is never a
global equality oracle over meeting points — keyed by a server-held lookup
key, the same lookup-HMAC pattern `locks.rs` uses for bundle-id lookups
(which keys creator‖bundle). The token keeps the **full 32 bytes** of the
HMAC — no truncation. Sealed ciphertext can never be compared for equality
(fresh nonce per seal), so the HMAC token is what lets the service group
lines: two lines whose listings, **from the same seller**, publish the
identical spot share one `location_key` and one order; two different spots
split. The token is stored on the order line, is not the plaintext, reveals
nothing about it, and is **withheld from every non-participant read** —
projections that carry the line to anyone but the two participants omit it,
and a projection shape test asserts that. All shipped lines share one null
location. One order therefore has exactly one meeting point and exactly one
agreed slot (§B2): a schedule, a reveal, and a reminder set never span two
places. The §A2 example cart (seller A shipping + pickup at two spots,
seller B shipping) then produces four orders, and the checkout copy counts
separate pickup locations as separate orders.

The lookup key is named **`PICKUP_LOCATION_LOOKUP_KEY`**, declared in env
config, and folded into the same **all-or-none gate and boot probe** as the
sealing key (§A8): the service refuses to start with grouping rows but no
lookup key, and `pickup_available` requires it. The key is
**non-rotatable** — rotating it would orphan every stored token, so no
rotation path is provided; a compromised key means a migration, not a
roll.

## B2. Scheduling

Scheduling is optional per listing. The seller sets, alongside the pickup
details, either **availability windows** (recurring weekly windows, e.g.
Saturdays 10:00–14:00) or **arrange after payment** (no windows; the buyer
proposes any sensible time and the seller responds).

Flow, per pickup order:

1. Payment confirms → the service creates a `pickup_schedule` aggregate for
   the order in `awaiting_proposal` and notifies the buyer (inside
   `confirm_order`'s receipt transaction, alongside the Part A pinning).
2. The buyer proposes a slot (`pickup_schedule.propose`). With windows, the
   slot must fall inside one; the service validates this server-side
   **against the PINNED windows** (`version_at_payment`, §A3) — never the
   listing's current details, so a post-payment edit cannot silently move
   the goalposts mid-negotiation. With arrange-after-payment, any valid
   future instant goes.
3. The seller confirms (`pickup_schedule.confirm`) or proposes a change
   (`pickup_schedule.propose` again from the other party — a counter; the
   **seller counters** exactly as the buyer does). The buyer can likewise
   counter a counter. Only the party that did **not** make the current
   proposal may confirm it, and **`confirm` re-validates** the slot against
   the pinned windows at confirm time, so a proposal made under pre-edit
   windows cannot be confirmed after they change. Proposals are capped at 6
   per order; a seventh `propose` is refused with a typed error naming the
   cap, so a hostile peer cannot counter forever, and
   `pickup_schedule.propose` on an order with no schedule (any shipped
   order) is refused with a typed error.
4. On confirm, the agreed slot (start/end UTC instants) is written onto the
   order's participant-visible projection, so both peers see the same fact.
   The schedule rides the ordinary order projection — slots are participant
   facts, not addresses.
5. Reminders: an outbox worker emits `pickup_reminder` notifications to both
   peers at slot−24 h and slot−1 h, deduplicated by (order, slot, kind).
   Reminders are **in-app pull only** — no push — so a lock screen never
   announces a meeting. The UI says so plainly: "Reminders appear here when
   you open the app; there are no push notifications."
6. No-show: no new states and no automatic assumption. The order holds in
   `ready_for_pickup` (§A6); the peers re-propose a new slot or use the
   existing cancel/return flows. If the buyer doesn't show, the seller keeps
   the funds; if the seller doesn't show, the buyer requests cancellation
   and the external-refund path applies.

**All timestamps are server-authoritative** (ADR-0019 §3): slot validity,
lead time (proposal must be at least 1 h ahead of server time), horizon
(≤ 60 days), reminder times, and the proposal TTL (an unconfirmed proposal
expires after 72 h) are all computed on the service clock. `issued_at` is
diagnostic only. The 7b sweeps (reminder, proposal expiry, details-changed
propagation) follow the same locking discipline as the Wave 7 auto-complete
sweep (§A6): lock orders `FOR UPDATE OF orders` before joining.

**Timezones.** Availability windows are authored in the pickup location's
IANA timezone, stored with the details as `{ day, start, end, zone }` local
wall-clock entries. The service expands windows to UTC instants with a tz
database (DST-correct) when validating proposals and when scheduling
reminders. Everything stored and served is UTC RFC 3339 with milliseconds,
the existing `format_timestamp` convention; clients render the slot twice —
pickup-location local time (labeled with the zone) and the viewer's local
time — so neither peer does mental arithmetic.

**Unattended slots: hold, never assume.** There is no automatic delivery
assumption from an elapsed slot — no `delivery_assume`-style server
transition and no assumption flag of any kind. When an agreed slot passes
with no confirmation, the order simply holds in `ready_for_pickup`; the
peers re-propose or use cancel/return. The UI may prompt either party to
confirm or report a no-show, but the service records nothing on its own.

### New aggregate: `pickup_schedule` (one per pickup order, and one per pickup-method return)

`awaiting_proposal` is the machine's `initial` state: the server creates the
aggregate in that state on payment confirmation. The contract format has no
creation transitions — every row must name a literal declared from-state
(`transitions_reference_declared_states` in `state_machines.rs` rejects
from-states that are not declared states, so "any non-terminal" is not
expressible) — and the cancellation propagation is therefore enumerated row
by row below.

| From                | To                  | Trigger                                                           | Actor            |
| ------------------- | ------------------- | ----------------------------------------------------------------- | ---------------- |
| `awaiting_proposal` | `proposed`          | command `pickup_schedule.propose`                                 | buyer            |
| `proposed`          | `proposed`          | command `pickup_schedule.propose`                                 | the non-proposer |
| `proposed`          | `confirmed`         | command `pickup_schedule.confirm`                                 | the non-proposer |
| `proposed`          | `expired`           | server `proposal_expiry` (72 h)                                   | server           |
| `expired`           | `proposed`          | command `pickup_schedule.propose`                                 | either           |
| `confirmed`         | `completed`         | command `fulfillment.confirm_pickup`                              | buyer or seller  |
| `awaiting_proposal` | `completed`         | command `fulfillment.confirm_pickup`                              | buyer or seller  |
| `proposed`          | `completed`         | command `fulfillment.confirm_pickup`                              | buyer or seller  |
| `expired`           | `completed`         | command `fulfillment.confirm_pickup`                              | buyer or seller  |
| `confirmed`         | `awaiting_proposal` | server `pickup_details_changed` (post-payment edit or clear, §A3) | server           |
| `proposed`          | `awaiting_proposal` | server `pickup_details_changed` (post-payment edit or clear, §A3) | server           |
| `awaiting_proposal` | `cancelled`         | server `order_cancelled` (propagation)                            | server           |
| `proposed`          | `cancelled`         | server `order_cancelled` (propagation)                            | server           |
| `expired`           | `cancelled`         | server `order_cancelled` (propagation)                            | server           |
| `confirmed`         | `cancelled`         | server `order_cancelled` (propagation)                            | server           |

`completed` and `cancelled` are terminal. Only `confirm_pickup` completes a
schedule; nothing auto-completes, and an elapsed slot changes nothing. The
handover confirm completes the schedule from **any** non-terminal
schedule state — including `awaiting_proposal`, `proposed`, and `expired` —
because the peers may have arranged the slot offline and simply met; the
order machine's `paid`/`ready_for_pickup` → `delivered` edge cannot be
allowed to strand its schedule aggregate in a non-terminal state. A
post-payment details edit or clear on the order's listing propagates a
reset: a `confirmed` **or `proposed`** schedule returns to
`awaiting_proposal` and the buyer is notified — a live proposal under
pre-edit terms is as stale as a confirmed slot. The schedule never drives
money: it informs reminders and displays; funds stay governed by the order
machine.

With 7b, `next_actor()`'s pickup rule becomes proposal-aware: for a pickup
order in `paid` or `ready_for_pickup`, `'buyer'` when a schedule proposal
is awaited from the buyer (the schedule sits in `awaiting_proposal`, or the
current proposal is the seller's and only the buyer may confirm it),
otherwise `'seller'` (the seller's move: propose, mark ready, or confirm
the buyer's proposal). Shipped orders keep today's mapping unchanged.

**Contract shape.** `pickup_schedule` is declared as a new aggregate with
its command transitions (`pickup_schedule.propose`,
`pickup_schedule.confirm`, `fulfillment.confirm_pickup`) and
`unreachable_states: []` — the
`unreachable_states_are_exactly_the_untargeted_non_initial_states` rule
requires every non-initial state to be targeted, and the table above
targets all of them. The aggregate count goes from 8 to 9, and
`contract_document_is_stable_json` is updated then — in 7b, not before.

## B3. Returns on a pickup order

The existing return states (`return_requested` → `return_approved` →
`return_received` → `refunded_external`) apply to a pickup order unchanged —
but the return method is chosen anew: receiving by pickup does not imply
returning by pickup, and the buyer holds no postal address for the seller.
`return.request` carries a requested `return_method: pickup | shipping`,
which the seller sees when approving. **The seller decides at
`return.approve`, and must supply the means there** — there is no
stalemate state: the seller either accepts the buyer's requested method or
counters with the other one, and the approve command is refused
(`INVALID_COMMAND`, typed) unless it carries that method's means — a
label, an address, or a hand-back schedule — so an approved return always
has a next step and never sits in `return_approved` with nothing to do:

- **Pickup hand-back.** On `return.approve` with method `pickup`, the
  service creates a second `pickup_schedule` aggregate for the return (one
  per return, keyed to it) in `awaiting_proposal`, and the same
  propose/confirm flow (§B2) runs for the hand-back. `return.receive` then
  marks the item back with the seller, as today. The hand-back location is
  the order's **pinned snapshot** (§A3) unless the seller supplies a fresh
  return address at approve time (sealed, single-return, same reveal rules
  as below). `return_method: pickup` is **refused with a typed error when
  no details exist** — no pinned snapshot on the order (a shipped order,
  or a pre-migration row) and no fresh address supplied at approve — so a
  pickup hand-back can never be agreed against a nonexistent place.
- **Shipping.** Two variants, by agreement at approve time:
  - The seller supplies a shipping label — an upload or a URL today, a
    Shippo purchase later — via `return.provide_label`, when both agree;
    the buyer posts the item with it. A label **URL** is rendered
    client-side behind the threat model's unsafe-link warning (MSG-03)
    and validated server-side against a carrier-domain allowlist, so a
    "label" cannot be an arbitrary phishing link or an identity-leaking
    tracking page on an unknown domain.
  - Otherwise the buyer ships at their own cost to an address the seller
    provides for that return only, via `return.provide_address`. The
    address is sealed like pickup details (§A1), seller-chosen, scoped to
    that one return, and revealed buyer-only through a dedicated read with
    the same rules as the pickup reveal (§A3: entitlement re-checked on
    every read, `Cache-Control: no-store`, service-worker exclusion,
    redacted from logs). It is not the listing's pickup details and is
    never reused. `return.provide_address` may be **re-issued** while the
    return is open: the new address supersedes the old (the old sealed row
    is hard-deleted), and the buyer is re-notified — a seller who gave a
    stale address is not locked into it. Once the return reaches **any**
    return-terminal state — withdrawn, rejected, expired, or refunded, not
    only `refunded_external` — the read is a typed refusal and the sealed
    address is purged.

**Sandbox gating and capability, exactly as for pickup details.**
`return.provide_address` **and** the return-address reveal read
(`GET /v1/returns/{id}/address` — buyer only, keyed by return id, serving
the sealed single-return address while the return is open) are both refused
whenever `config.sandbox_payments_enabled` is on — the same deployment
boundary as `pickup_details.set` and the pickup reveal (§A8) — and both are
folded into the `pickup_available` capability flag and into the boot
probe's coverage. The sealed return addresses become a **third sealed
family**: the re-seal job and the probe's trial open (§A8) extend to them
when 7b lands, and the job then enumerates **all sealed rows** — details
versions, pinned snapshots, and single-return addresses alike; no sealed
row sits outside its walk.

With pickup returns, two Part A rules widen as noted there: the reveal
entitlement ends only once the order is terminal **and** its return window
is closed (a pickup-method return still needs the hand-back meeting point),
and `pickup_details.clear` retention keeps versions referenced by an order
with an open return window alongside the paid, non-terminal ones (§A3).

7b command additions, same envelope and CAS rules as §A7:

| Command                     | Role                                                                                 | Effect                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pickup_schedule.propose`   | Order participant (buyer first, then either, never twice in a row by the same party) | Proposes/counters a slot; validated server-side against the **pinned** windows; capped at 6 per order (§B2); refused on orders with no schedule                                         |
| `pickup_schedule.confirm`   | Order participant, non-proposer only                                                 | Fixes the agreed slot onto the order; re-validates against the pinned windows at confirm time (§B2)                                                                                     |
| `return.request` (extended) | Buyer, own order                                                                     | Carries a requested `return_method: pickup \| shipping`; `pickup` refused when no details exist                                                                                         |
| `return.approve` (extended) | Seller, own return                                                                   | Accepts or counters the return method and must supply its means — label, address, or hand-back schedule                                                                                 |
| `return.provide_label`      | Seller, own return                                                                   | Attaches a shipping label (upload or URL today; Shippo later) for a shipping return; URLs validated against a carrier-domain allowlist                                                  |
| `return.provide_address`    | Seller, own return                                                                   | Sealed, single-return address for a shipping return; revealed buyer-only; re-issuable while the return is open, superseding and re-notifying; refused when sandbox payments are enabled |

## B4. 7b migration and test additions

- **Postgres**: `pickup_schedules` (order id or return id, state, proposals,
  agreed slot, revision); order lines gain `location_key` (full 32 bytes,
  §B1); return rows gain `return_method`, an optional label (upload
  reference or URL), and an optional sealed single-return address; env
  config gains the non-rotatable `PICKUP_LOCATION_LOOKUP_KEY` (§B1), folded
  into the all-or-none gate and boot probe.
- **Contract**: `pickup_schedule` declared as the ninth aggregate with
  `unreachable_states: []` (§B2); `contract_document_is_stable_json` is
  updated from 8 to 9 in this wave, not before.
- **Client**: scheduling UI (propose/confirm/counter, slot shown in
  pickup-zone and viewer-local time) with the reminders copy "Reminders
  appear here when you open the app; there are no push notifications"; the
  return method chooser and the approve screen that cannot submit without
  the method's means; the seller's label URL behind the MSG-03 unsafe-link
  warning; the return-address reveal panel (buyer-only,
  `data-sentry-mask`ed like the pickup reveal, memory-only like the pickup
  address); `pickup_schedule` added to `commerceAggregateMachines` and to
  the contract test's `stateEnumsByAggregate`; the checkout N-orders copy
  counts separate pickup locations as separate orders.
- **Tests**: two listings of one seller publishing the identical spot share
  one order, two different spots split, and the same spot under two
  different sellers never groups (the seller prefix, §B1); `location_key`
  absent from every non-participant projection (shape test);
  `PICKUP_LOCATION_LOOKUP_KEY` absent → boot probe refuses,
  `pickup_available` off; propose outside the pinned windows refused,
  inside accepted; only the non-proposer confirms; the seventh proposal
  refused naming the cap; propose on an order with no schedule refused;
  72 h proposal expiry; reminders deduplicated; a post-payment edit resets
  `proposed` as well as `confirmed` schedules to `awaiting_proposal`;
  `confirm` re-validates against the pinned windows; the schedule completes
  from `awaiting_proposal`, `proposed`, and `expired` as well as
  `confirmed`; an elapsed slot changes nothing; `return.approve` without
  the method's means → typed refusal; seller counter of the requested
  method at approve works; a pickup-method return spawns the hand-back
  schedule with the pinned snapshot as its location; `return_method:
pickup` with no details → typed refusal; a label URL outside the carrier
  allowlist → typed refusal; `return.provide_address` is sealed, revealed
  buyer-only with `Cache-Control: no-store`, re-issue supersedes and
  re-notifies, the read refuses **and the sealed row is purged on every
  return-terminal state** (withdrawn, rejected, expired, refunded — not
  only `refunded_external`), and both the command and the read are refused
  when `config.sandbox_payments_enabled` is on.

## Threat model — self-attack table

Extends [`threat-model.md`](threat-model.md); assets: seller meeting point
(restricted personal data), buyer delivery address (unchanged), agreed slots
(participant facts, Wave 7b).

### Wave 7 rows (Part A)

| Attack                                          | Precondition                                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unpaid buyer reads the meeting point            | Controls a buyer account, order never paid (including one cancelled from `pending_payment`) | Refused: reveal read requires the durable payment fact, not state membership; projection never carries details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Fact-gated entitlement at the service, not the client; typed refusal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Replay of a paid order projection               | Stale/cached projection from any source                                                     | Useless: details are not on the projection at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Dedicated reveal endpoint; caches hold no address material                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Seller swaps the address after payment          | Seller edits details on a paid order                                                        | Buyer is notified (`pickup_details_updated`), the buyer may cancel unilaterally while the terms changed after payment, and `version_at_payment` pins what was shown at payment; in Wave 7b any live schedule also resets (§B2)                                                                                                                                                                                                                                                                                                                                                                                                                                        | Versioning + notification + unilateral cancel; editing is allowed but never silent or free                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Seller deletes the details after payment        | Seller issues `pickup_details.clear` on a paid order                                        | Paid, non-terminal orders keep their pinned `version_at_payment` copy; the buyer's reveal read still serves what they were shown, flagged withdrawn; buyers are notified and may cancel unilaterally                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Retention of referenced versions only; everything else hard-deleted; purge once referencing orders go terminal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Handover dispute (he-said/she-said)             | Either party marks `fulfillment.confirm_pickup`; the other claims otherwise                 | The service cannot tell who is lying — the handover record carries who confirmed and the server instant, nothing more. There is no escrow and no arbiter: a false confirm by the buyer strands the buyer's own funds, and a false confirm by the seller keeps funds **and** item — but it does **not** mint completion reputation: reputation counts the completion only on a buyer confirm or a dispute-free auto-complete (§A6)                                                                                                                                                                                                                                     | None at protocol level for the funds — stated plainly as a limitation. There is deliberately **no dispute/report affordance**: this marketplace has no operator and no arbiter to receive one, so a report button would promise a recourse that does not exist. The buyer's recourse is the review and the reputation asymmetry already implemented — a seller-attested handover is not a reputation completion until the buyer confirms or the window passes dispute-free (§A6). The review-hook copy names the risk before confirm ("Only confirm once the item is in your hands"), and the external-refund evidence trail (ADR-0019) stays on the record |
| Buyer induces a terms change to ding the seller | Buyer cancels via a buyer-protection exit (terms-change or bounded withdrawal, §A3)         | The exit emits `order.cancelled_terms_change`, a distinct event kind; the reputation worker's `terminated_badly` window excludes the **whole order**, including any `refund.recorded_external` leg on it — the seller's completion rate is untouched                                                                                                                                                                                                                                                                                                                                                                                                                  | Distinct event kind, whole-order exclusion at the reputation aggregation (slice 7.1); ordinary `order.cancelled` keeps its existing reputation meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Real meeting points on a sandbox deployment     | Operator runs a deployment with sandbox payments enabled                                    | Refused at the **deployment boundary**: `pickup_details.set` **and** the buyer reveal read are both rejected whenever `config.sandbox_payments_enabled` is on (the executor.rs gate), so no real address can ever be stored against — or revealed under — fake money. The per-order payment `adapter` column is `"sandbox"` for every order at checkout until a rail is chosen, so it cannot be the gate at checkout; but the adapter **pinned at confirmation** is accurate, and the reveal refuses any snapshot pinned under `payment.sandbox_advance` regardless of the current flag — a flag toggle window (off→on→off) cannot make a past fake-money reveal free | Refusal at the command handler and the reveal read, the pinned-adapter check on every reveal (§A3), plus the `pickup_available` capability flag (§A7). Staging runs durable mode against **test rails** (testnet BTC, Stripe test, PayPal sandbox) — real flow, never real money — so fake meeting spots on staging are fine (§A8)                                                                                                                                                                                                                                                                                                                          |
| Buyer shares the address onward                 | Buyer is entitled and malicious                                                             | Unpreventable — the buyer must know where to go; same as telling a friend where you're meeting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Reveal only after payment (the seller is paid before the address exists for the buyer); spot-first UX keeps most listings off home addresses; reviews give the seller recourse                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Operator DB read                                | Operator runs SQL or exfiltrates a backup                                                   | Ciphertext only: XChaCha20-Poly1305, AAD-bound, fresh nonce per seal; key is an env secret distinct from the Locks key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Sealing (§A1); operator with env access can still decrypt — acknowledged, bounded by policy's "what the service needs" clause; no operator/support read path exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Second-device seller                            | Seller signs in elsewhere                                                                   | Owner read returns their details; recovery works                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Service is truth (§A4); no sync path can null details; save requires a successful read (CAS version)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Cancelled after reveal                          | Order paid, then cancelled (any path, including the unilateral exits)                       | The entitlement ends at the cancel event; no new read is served. The pinned snapshot survives only as dispute evidence, until the seller's refund evidence is recorded or the terminal-order purge runs                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Terminal-cutoff at cancellation; retention bound to refund evidence; what the buyer saw while the order was live cannot be un-seen and is not pretended secret again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Wave 7b rows (Part B)

| Attack                              | Precondition                                           | Result                                                                                                                                                                                                                             | Mitigation                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Equality oracle over meeting points | Attacker compares `location_key` tokens across sellers | Useless: the HMAC is keyed over **seller id ‖ 0x0A ‖ canonical plaintext**, so equality holds only within one seller; the token keeps the full 32 bytes and is withheld from every non-participant read                            | Seller-prefixed HMAC under the named, non-rotatable `PICKUP_LOCATION_LOOKUP_KEY`; projection shape test (§B1)                              |
| Return-address reuse or leak        | Seller provides an address for one return              | Scoped: sealed, single-return, buyer-only reveal read with the same no-store/redaction rules as the pickup reveal; never the listing's pickup details, never reused; command and read both refused on sandbox-payments deployments | Dedicated reveal per return; sandbox gate plus `pickup_available`/probe coverage (§B3); support/operator projections carry ciphertext only |
| Slot proposed outside availability  | Malicious buyer client                                 | Refused server-side                                                                                                                                                                                                                | Window validation against the **pinned** windows on the service clock, never client-side; `confirm` re-validates (§B2)                     |
| Reminder/notification spoof         | Forged outbox intent                                   | Consumers deduplicate by event id; notifications carry no address material                                                                                                                                                         | Existing outbox invariants (ADR-0019 §4)                                                                                                   |

Two exit guarantees close the loop on post-payment terms changes (§A3,
§A6):

1. **The seller cannot self-confirm away the buyer's exit.** A
   seller-actor `fulfillment.confirm_pickup` is refused while an
   unresolved post-payment terms change exists, so editing the meeting
   point and immediately self-confirming the handover cannot delete the
   buyer's unilateral-cancel window before the buyer has seen the change.
   The buyer's own confirm stays allowed — the buyer may accept the new
   terms by showing up.
2. **The buyer's exit does not depend on the seller editing.** The
   bounded post-reveal withdrawal (from the first reveal until the
   handover confirm — `mark_ready` does not close it) covers the
   unusable-as-revealed spot where `current version == version_at_payment`
   and no terms-change flag could ever fire. Both exits move no money and
   are reputation-neutral for the seller (the `order.cancelled_terms_change`
   row above).

## Deliberately not built (v1)

- Pickup for auctions and offers (shipping-only; typed refusals, no silent
  fallback).
- Public display of availability windows before payment.
- Operator/support tooling that reads pickup details (no read path exists;
  incidents are handled with the participants, not by reading the address).
- Deposit/no-show penalties — funds semantics stay exactly as today.

(Part B is deferred, not refused: it is designed above and scheduled for
Wave 7b.)
