# Drops: Timed, Limited Product Distribution

Status: D1 shipped; D2+ remain design (2026-08-23). Phase D1 — FCFS drops
with gapless attested editions, the shopper and merchant surfaces, and
Nexus indexing — is BUILT end to end and live-proven on the deployed
staging stack (see the proof-ledger row "FCFS drop two-buyer race
(2026-08-23)" in [`status.md`](status.md)). D2 (sealed pre-commitment),
D3 (auditable raffles), D3.5 (paid entry), D4 (gated drops), and D5
(dutch) remain design/plan. The rest of this document is the strategy and
phased plan for the full "drops" feature set — pre-launched, launched, and
ended releases of limited items — designed around what Pubky, the
transaction service, Nexus, Paykit, and Locks each actually guarantee.

## Why drops fit this stack

A drop is scarcity with a clock: some quantity of some items becomes
purchasable at a moment, under limits, until it sells out or ends. Every
centralized drop platform asks buyers to trust three unverifiable claims:

1. _The seller didn't change the terms after building hype._ (Price and
   supply are whatever the database says today.)
2. _The clock and the queue were fair._ (Nobody can audit who got to buy.)
3. _"1 of 100" means something._ (The edition count lives in the operator's
   database and dies with it.)

This stack can make all three claims verifiable:

1. **Sealed pre-commitment** — the seller's homeserver record commits to a
   hash of the drop's terms before the hype window; the reveal is checkable
   by anyone against the commitment. A seller cannot quietly raise the price
   or the supply after announcing. No other marketplace offers this because
   no other marketplace has seller-signed, user-owned records.
2. **Auditable allocation** — server-time gating and one-winner concurrency
   are already proven properties of the transaction service (100-way
   concurrency tests); raffle-format drops add a commit-reveal draw whose
   transcript every entrant can recompute.
3. **Portable numbered editions** — the portable order receipt
   (`pubky-order-receipt+v1`, shipped) gains a drop-edition attestation:
   "edition 7 of 100" signed by the attestor, living on the buyer's own
   homeserver, verifiable offline forever. The operator's death does not
   delete your edition number.

## Authority split (the non-negotiable part)

Per ADR 0019, each plane keeps its lane:

| Concern                                                    | Authority                                 | Why                                                                  |
| ---------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| Drop announcement, teaser media, terms (or their hash)     | Seller's homeserver record                | User-owned, portable, signed hype artifact                           |
| Discovery: upcoming/live/ended shelves, countdowns         | Nexus index (lossy)                       | Read-optimized; never the source of state                            |
| The clock: when `live` begins and ends                     | Transaction service, server time          | ADR 0019 §3: `issued_at` is diagnostic; deadlines are server-decided |
| Inventory cap, per-buyer limit, sell-out, edition sequence | Transaction service, Postgres constraints | The one-winner problem, again                                        |
| Paid entry, early-access grants, digital delivery          | Locks + Paykit + wallet                   | Pay first, grant second; the service never moves funds               |
| Edition/receipt proofs                                     | Attestor JWS on the buyer's homeserver    | Credible exit                                                        |

The UI may show a countdown; it may not show `live`, `sold out`, `won`, or
an edition number until the service says so. A drop record's `startsAt` is
the seller's _stated intent_; the service's drop aggregate is the _enforced
schedule_ (registered from the record, exactly like `listing.sync`).

## The drop record (specs fork)

`/pub/pubky.app/marketplace/v1/drops/{drop_id}` — closed-world, camelCase,
same base-record shape as listings:

- `title`, `description`, `media` (teaser assets, listing-style bounds)
- `listingRefs`: the listings included (owner + id pairs; a drop may bundle)
- `format`: `fcfs` | `raffle` (Phase D5 may add `dutch`)
- `startsAt`, `endsAt` (ISO-8601; intent, enforced by the service)
- `totalQuantity`, `perBuyerLimit`
- `price` (per listing ref, integer minor units) — or absent when sealed
- `sealedTerms` (optional): BLAKE3 hash of a canonical JSON of the hidden
  fields (`price`, `totalQuantity`, `listingRefs` details) plus a salt
- `revealedTerms` (optional, added at launch): the preimage. Any client can
  hash it and compare to `sealedTerms` published days earlier — the record's
  homeserver history (and the Nexus ingest timestamp) is the evidence the
  commitment predated the reveal
- `transactionService` resolution applies exactly as for shops

Sealed drops are the marketing feature: "price revealed at launch, and you
can verify we never changed it." The spec must define the canonical
serialization for the preimage or the commitment is unverifiable.

## The drop aggregate (transaction service)

New aggregate `drop:{seller}_{drop_id}` with a real state machine:

```
draft → announced → live → ended(sold_out | closed | cancelled)
```

- `drop.sync` mirrors `listing.sync`: the service fetches the seller-signed
  drop record and registers/updates the aggregate — convergent, any actor.
- **Schedule gate**: `checkout.create`/`inventory.reserve` against a
  drop-bound listing before server-time `startsAt` fails with a typed
  `DROP_NOT_LIVE`; after `endsAt` or sell-out, `DROP_ENDED`. The existing
  expiry worker (reservations, offers, auctions) gains drop open/close
  transitions on server time.
- **Caps**: `total_quantity` enforced by the same balance-checked quantity
  ledger; `per_buyer_limit` by a `drop_purchases (drop_id, buyer_pubky,
quantity)` table with a CHECK against the limit, written in the same
  transaction as checkout — the 100-way concurrency test suite extends to
  the cap boundary (100 buyers, 10 units, exactly 10 orders) and to the
  per-buyer boundary (one buyer, N parallel checkouts, exactly `limit`
  succeed).
- **Edition sequence**: assigned inside `confirm_order` (the exactly-once
  payment confirmation path), a per-drop monotonically increasing integer.
  Editions number _paid_ orders, not reservations — a lapsed reservation
  never burns an edition number.
- Sandbox parity: none. Drops are durable-mode only; server time is the
  feature. The sandbox shows the affordances as unavailable, labeled.

## Fairness formats

**FCFS (Phase D1).** Honest first-come-first-served: the gate opens on
server time, the caps hold under concurrency, and that is all that is
claimed. The UI copy must say what FCFS is: a race. Per-pubky limits bound
enthusiasm, not sybils — creating pubkys is free, so _identity-based_
fairness claims are off the table. Sybil resistance where it matters is
economic (see raffle paid entry) or relational (see gated drops).

**Auditable raffle (Phase D3).** The differentiating format:

1. Entry window replaces the race: `drop.enter` during `[startsAt, endsAt)`
   collects entries (one per pubky, enforced by constraint).
2. At window open the service publishes `seedCommit = hash(seed)` in the
   drop projection AND as an attestor-signed statement.
3. At close, the service reveals `seed`, ranks entries by
   `HMAC(seed, entry_pubky)`, and the top `totalQuantity` win.
4. The **draw transcript** — entries (as salted hashes, each entrant holds
   their own salt from the entry result, so anyone can verify their own
   inclusion without a public list of who entered), seed commit, seed
   reveal, algorithm version, winner set — is attestor-signed and published
   to the attestor's homeserver (this lands naturally after the trust
   plan's Phase 3 publisher exists; until then the transcript is served by
   the service and embeddable in winners' receipts).
5. Winners get a **claim window**: a server-time reservation TTL (existing
   machinery) to complete checkout; lapsed claims cascade to the next
   ranked entry.
6. Paid entry (optional, later): the entry requires a Locks-verified
   payment (sats or fiat via the verifier) — a real sybil cost. Entry fees
   are the seller's, disclosed, non-refundable or credited at checkout;
   the service still never touches funds.

The honesty rule that makes this worth building: **every claim in the draw
is recomputable by a loser.** "You lost fairly" is checkable, which no
mainstream drop platform offers.

**Dutch auction (Phase D5, optional).** Descending price on server time
until quantity clears. Adjacent to the existing auction machinery but a new
sale format; deferred until demand exists.

## Seller-configured claim requirements (claim policy)

Directive from the owner (2026-08-24): what a claim requires is the
SELLER's decision, declared per drop. The one-size claim (lock the unit,
hold it for a fixed window) becomes just the default of a `claimPolicy`
object on the drop record. The policy has three independent axes:

**1. The hold — what secures a claimed unit:**

- `none` (default): the claim locks the unit for the drop's claim window
  (server-time, bounded); payment must start within it or the unit
  restocks. This is exactly the model the "only a payment locks an item"
  inventory rework implements for drops.
- `down_payment { amountMinor | percent }`: the claim is secured only once
  a REAL partial payment lands — a genuine payment through the same rails
  (Locks-verified BTC or a seller-direct fiat charge for the deposit
  amount), verified exactly like any payment. The balance is due within
  the payment window; a lapsed balance forfeits or refunds the deposit per
  the seller's declared `depositForfeiture` policy (`kept` | `refunded`),
  shown to the buyer BEFORE claiming. The service still never holds funds:
  the deposit goes seller-direct, and forfeiture/refund are the same
  external-evidence flows as every refund today.
- `full_payment`: claiming IS paying — the claim button starts the full
  payment immediately and the unit locks only when payment starts (the
  ordinary-listing rule applied to drops, for sellers who want zero
  unpaid holds).

**2. Rail restriction:** `paymentMethods` — the subset of the seller's
configured rails valid for this drop (e.g. bitcoin-only drops). Enforced at
the lock point; the drop page shows the restriction before T-0 so the ready
check can stage the right rail.

**3. Eligibility gates** (who may claim at all — evaluated at claim time,
each with its honest disclosure):

- `prior_customer`: buyer presents a purchase attestation from this seller
  (the ADR 0024 JWS they already hold); the service verifies signature +
  its own attestor `iss`. Strong, first-party verifiable.
- `tag_from_key { issuerPubky, label }`: the buyer's profile must carry a
  specific tag from a specific key — e.g. a community operator's key
  tagging members. Verifiable with the same authority doctrine as
  `listing.sync`: tags are public records on the ISSUER's homeserver, so
  the service fetches the tag record from the issuer's own path — only the
  issuer can write there, so the gate cannot be forged by the buyer.
  Disclosure: the issuer can tag anyone at any time; this gates on the
  issuer's say-so, nothing more.
- `follower`: buyer follows the seller now (backdating not provable —
  disclosed, as in the D4 plan).
- `early_access_credential`: a live Locks credential (paid pass) — also
  usable for `presaleStartsAt`.
- `invite_token`: a seller-signed invite delivered over E2EE DM.

Gates compose with AND semantics; the drop record carries the policy in
the sealed-terms commitment when sealed (a seller cannot quietly loosen or
tighten gates after hype). The Studio explains each axis in plain fairness
language and the drop page states requirements before T-0 — a buyer must
never discover a gate by being refused at the moment of the race.

Sequencing: `claimPolicy` lands as a specs bump (closed-world object,
absent = the `none` default, so every existing drop record stays valid);
service enforcement at the claim/lock points; Studio + drop-page surfaces.
`down_payment` is the largest slice (a second partial-payment object per
order) and rides after the payment-window rework settles; `tag_from_key`,
`paymentMethods`, and `full_payment` are small once the policy plumbing
exists. This section supersedes the narrower "Access-gated drops" phase
D4 scope below, which becomes the eligibility-gate slice of the policy.

## Access-gated drops (Locks as the door)

Locks' whole design is "verify a criterion, issue a time-bounded
credential." Three gates fall out:

- **Early-access pass**: pay (BTC or fiat rail) to hold a pre-launch
  credential; the service honors an earlier `startsAt` for credential
  holders (`presaleStartsAt` in the drop record). This is a paid queue
  jump, honestly labeled — not a fairness feature, a monetization one.
- **Prior-customer gate**: eligibility = holding a purchase attestation
  from this seller (the ADR 0024 JWS the buyer already owns). The buyer
  presents it at entry; the service verifies signature + `iss` against its
  own attestor key. First-party verifiable loyalty gating with zero new
  infrastructure.
- **Follower gate** (weakest, disclose it): the service fetches the buyer's
  follow record from their homeserver at entry. It proves the buyer follows
  the seller _now_; it cannot prove since when (the follow record is
  buyer-owned and backdatable). Copy must not claim more than it proves.

Private/allowlist drops: the seller DMs signed invite tokens over the
existing E2EE messaging; the service verifies the seller-signed invite at
entry. Unlisted rather than secret (the drop record itself can be public or
withheld until launch).

## Discovery and hype surfaces (Nexus + client)

- Nexus (fork branch) indexes drop records: `GET /v0/stream/drops` with
  state buckets (upcoming / live / ended) computed from indexed times but
  **displayed as estimates**; the client hydrates the service projection
  for the authoritative state before showing "live".
- Client: a drops shelf on the marketplace home; a drop page with teaser
  media, countdown (server-time-offset corrected via the service's clock in
  projections), sealed-terms badge ("terms committed 2026-09-01, verified
  at reveal"), watch/remind affordances.
- Reminders ride the watchlist pattern exactly: watching a drop is a
  watchlist entry; device-detected "starting soon" alerts use the bounded
  visit/focus checks with per-item baselines; server outbox notifications
  (`drop_started`, `raffle_won`, `claim_expiring`) go to _participants_ the
  service actually knows (entrants, winners), never fabricated for mere
  watchers. Same honest split watchlist alerts already document.
- Edition display: "7 of 100" renders on the order/receipt surfaces from
  the service projection, and "Verified edition" only from the offline
  verification of the edition attestation — the same D5-style honest
  labeling reviews use.

## Portable editions (receipts, extended)

A new optional field on the portable receipt record (specs bump):
`editionAttestation` — a separate compact JWS, `typ:
pubky-drop-edition+v1`, claims `{v, iss, drop, listing, edition, of,
receipt, iat}`. Deliberately a _second_ attestation rather than new claims
inside `pubky-order-receipt+v1`: the receipt claim set is closed-world, and
existing verifiers must keep verifying old receipts unchanged. Additive,
never breaking. The buyer's homeserver ends up holding a self-contained,
operator-independent proof: "I hold receipt R for order O, and it is
edition 7 of 100 of drop D," verifiable by anyone the buyer shows it to.

## The shopper experience

The genre's incumbents train buyers to expect fake queues, spinner
roulette, and bot losses. The product stance here is the opposite, and it
is only possible because every state has one authority:

**Before the drop — anticipation without anxiety.**

- A **drops calendar** and home shelf: upcoming drops from followed shops
  ranked first (the social graph is native — Pubky App _is_ the follow
  graph), each card carrying teaser media, a server-corrected countdown,
  and the sealed-terms badge when the seller pre-committed.
- **One-tap "remind me"**: a watchlist entry plus the existing
  device-detected alert pattern ("starting soon" on visit/focus), a
  calendar export (ICS) for people who live in their calendar, and a
  server `drop_started` notification for entrants/participants the service
  actually knows.
- **Ready check** — the genre-redefining piece of pre-drop UX: before T-0
  the buyer can stage everything that normally loses the race — connect
  the marketplace session, pick the delivery address, choose the payment
  rail, pass the gate (present the prior-purchase attestation, hold the
  early-access credential). The drop page shows a green "you're ready"
  state. At T-0 the only action left is one tap. Nothing is reserved
  early, so it is honest — preparation is the buyer's, allocation is the
  service's.
- Teaser social loop: drop records are taggable, shareable, and postable
  like listings (existing social layer); a drop page shows community tags
  and the seller's own hype posts.

**At T-0 — the moment, without lies.**

- The countdown flips to a **live claim state without a reload**: bounded
  polling of the service projection around T-0 (tight window, then
  backoff), so the transition is theatrical but the state is
  authoritative. The claim button never renders from indexed data.
- **No fake queue, ever.** FCFS answers immediately: reserved or
  `DROP_ENDED`. The UI's promise — printed on the page — is "we will never
  show you a progress bar that isn't real." Losing hurts less when the
  platform demonstrably didn't waste your time.
- Stock display is seller-configurable and always truthful: exact
  remaining, coarse bands ("plenty / low / last few"), or hidden — but
  never invented, and "sold out" only from the service.
- Raffle drops remove the race entirely: enter any time in the window
  (the UI says so — "no speed advantage, take your time"), get an entry
  receipt with your inclusion salt, come back for the draw.

**After — proof, pride, and recourse.**

- The **edition reveal**: payment confirms, and the buyer gets the moment —
  "Edition 7 of 100," verified offline against the edition attestation
  before the badge renders, with a share affordance that publishes a post
  embedding the drop reference (social proof that composes with the feed,
  not a screenshot).
- The portable receipt (with edition) lands on the buyer's homeserver via
  the existing publisher — ownership that outlives the operator, stated in
  the UI in one sentence.
- Raffle losers get the **"verify this draw" button**: the client recomputes
  the HMAC ranking locally from the transcript and the buyer's salt and
  shows the result. A loss with a proof is the genre's first respectful loss.
- The **drop archive**: every ended drop keeps a public page — final terms
  (and commitment verification), sell-out time, editions issued, draw
  transcript. Archives compound into seller credibility (see merchant side).

## The merchant experience (Drop Studio)

Merchants get a first-class composer and mission control, not a settings
form. Everything renders from the same authorities the shopper sees.

**Compose.**

- **Drop Studio** in the sell area: pick existing listings or draft new
  ones inline, set schedule (with explicit timezone rendering and a
  server-time preview), caps (total + per-buyer), and format — each format
  explained in plain fairness language ("FCFS is a race; raffle is a
  drawing every entrant can audit").
- **Sealed-terms toggle**: "commit now, reveal at launch." The studio
  computes the commitment from the canonical preimage, shows the merchant
  exactly what stays hidden and what the public record will say, and
  stores the preimage locally (with an explicit "losing this preimage
  means the reveal cannot be published" warning and a homeserver-private
  backup of the preimage under `/priv`).
- Gate configuration: prior-customer, early-access pass (price it —
  a new revenue line), follower gate (the UI repeats its disclosed
  limits), or DM allowlist (compose invites straight into the existing
  E2EE messaging).
- **Preview-as-shopper**: pixel-accurate rendering of the pre-launch and
  live states before publishing. Publishing writes the record and runs
  `drop.sync`; the studio shows both facts separately (record on your
  homeserver: yes; registered with the service: yes) — the same two-truth
  honesty listings already have.
- **Share kit**: a prefilled post for the feed, a copyable drop link, and
  teaser assets sized for external social.

**Run (mission control).**

- A live dashboard during the window, polled from the service projections
  the merchant is entitled to: units remaining, orders by state
  (pending-payment / paid), rail breakdown (BTC / Stripe / PayPal with the
  seller-attested label where it applies), raffle entry count, and — after
  close — claim-window status with cascade progress.
- A **kill switch** with state-machine honesty: cancel before live is
  clean; abort during live transitions the drop to `ended(cancelled)`,
  refuses new checkouts, leaves paid orders governed by the normal
  cancellation/refund machinery, and posts an operator-visible notice on
  the drop page. No silent disappearing drops.

**Grow (the compounding loop).**

- Post-drop results: sell-out time, conversion (entries → claims → paid),
  edition census, and one-click flows — message winners (within messaging's
  mutual-enable limits), batch packing slips (existing shipping tooling),
  relist remainder.
- **Attested drop history**: the drop archive on the shop page — sell-outs,
  honored commitments, audited draws — becomes the merchant's track record.
  When the trust plan's Phase 3 attestor publisher lands, drop outcomes
  join seller stat attestations: a _verifiable_ "12 drops, 12 honored
  commitments" is a credential no other platform can issue.
- Analytics stay inside ADR 0019 §8: the merchant sees aggregates the
  service legitimately holds about their own drop, never buyer telemetry.

## Genre-redefining pillars (product commitments, testable)

1. **No fake anything.** No fake queues, no fake progress, no invented
   stock levels, no "high demand" theater. Every rendered state is
   authoritative or visibly labeled an estimate.
2. **Provable fairness.** Commitments verify; draws recompute; losses come
   with proofs.
3. **Ownership outlives the platform.** Editions and receipts live on the
   buyer's homeserver and verify offline.
4. **Social-native.** Drops live in the same graph as follows, posts, tags,
   and DMs — hype is composition, not embed widgets.
5. **Preparation beats twitch.** Ready check moves the contest away from
   reaction time for everything that isn't inherently a race, and the
   raffle removes the race entirely.
6. **Credibility compounds.** Merchants accumulate verifiable drop history,
   not platform-owned badges.

## Client engineering notes

- **Clock**: the client computes a server-time offset from projection
  response timestamps (the service already serves server-time fields) and
  renders all countdowns from corrected time; skew beyond a threshold
  shows "syncing clock…" rather than a wrong number.
- **T-0 transition**: bounded polling (existing watch-check discipline: no
  daemons; tight cadence only inside a small window around startsAt while
  the page is visible), optimistic-honest button states
  (`submitting` → authoritative result), and idempotent claim commands so
  a double-tap cannot double-reserve.
- **State machines in the UI**: drop card and page states derive from one
  place (mirroring the vendored state-machine contract pattern) so
  "upcoming/live/ended" can never disagree between shelf and page.
- **Reduced-motion and a11y**: countdowns and reveal moments have
  reduced-motion variants; timers are announced at sensible intervals, not
  every second.
- **VRT + unit coverage** for every drop state including the ugly ones
  (cancelled mid-window, reveal-mismatch violation, claim expired), and a
  live staging proof per phase (two-buyer race for D1; recomputed draw for
  D3).

## What is deliberately NOT claimed

- No bot-proofness. FCFS is a race; per-pubky limits do not stop sybils;
  the raffle's sybil resistance is exactly its entry cost.
- No trustless anything. The service enforces the clock and the draw; the
  seller trusts it the way they trust it for auctions today. What changes
  is _auditability_: commitments, draws, and editions are verifiable after
  the fact by third parties.
- No cross-operator drop coordination. A drop is one authority's schedule
  (the shop's declared `transactionService`); two operators cannot share
  one cap — a seller who declares an authority has chosen their
  serialization point (same doctrine as multi-operator.md).
- No secondary market/transfer of editions. The edition attestation names
  the original buyer; resale provenance is out of scope until there is a
  transfer story worth speccing.

## Phased plan

Each phase ships complete (specs + service + Nexus + client + tests + docs)
and is independently honest. Nothing stubs forward.

**D0 — ADR + spec groundwork (small).**
ADR: drop authority split, formats, sealed-commitment canonicalization,
edition attestation as separate JWS. Specs fork: drop record + validation +
tests (one bump, includes `editionAttestation` on the receipt record).

**D1 — FCFS drops end to end (the MVP, medium-large).** _(shipped — see [`status.md`](status.md))_
Service: drop aggregate, `drop.sync`, schedule gate on checkout/reserve,
total + per-buyer caps with concurrency proofs at both boundaries, edition
sequence in `confirm_order`, `drop_started`/`drop_ended` outbox to
participants, drop projections (including the server-time field the client
corrects countdowns from). Nexus: drop ingest + drops stream. Client,
shopper: drops calendar + home shelf (followed shops ranked first), drop
page with corrected countdown and reload-free T-0 transition, **ready
check** (session + address + rail staged pre-drop), truthful
seller-configurable stock display, remind-me (watchlist + device alerts +
ICS export), edition reveal with offline verification and the share-post
affordance, receipt `editionAttestation` publishing, drop archive page.
Client, merchant: **Drop Studio** (compose from listings, schedule with
timezone clarity, caps, format explainer, preview-as-shopper, publish +
sync two-truth status, share kit), mission-control dashboard (remaining,
order states, rail breakdown), kill switch with honest cancelled-state
messaging, post-drop results with batch fulfillment reuse. Proof bar: a
live staging drop with two buyers racing the last unit — exactly one wins,
the loser sees `DROP_ENDED` with no fake queue ever rendered, the winner's
receipt carries a verified "1 of N".

**D2 — Sealed pre-commitment (small-medium, high marketing value).**
Sealed/revealed terms in the record; Studio commitment flow (canonical
preimage, what-stays-hidden preview, `/priv` preimage backup with the
loss warning); client verification and the "terms pre-committed" badge on
cards, page, and archive; Nexus stores commit-seen-at as evidence. Proof
bar: a reveal that does not match its commitment renders as a labeled
violation, never silently.

**D3 — Auditable raffle (large).**
Entry commands + window, commit-reveal draw, salted-entry transcript,
claim-window cascade on existing reservation TTLs, `raffle_won`/`claim_expiring`
notifications. Client, shopper: no-rush entry UX with entry receipt +
inclusion salt, claim-window flow with countdown, **"verify this draw"**
running the actual HMAC ranking locally for winners and losers alike.
Client, merchant: entry-count dashboard, draw execution + transcript view,
cascade monitoring. Paid entry via Locks deferred to D3.5 — it multiplies
the fiat/BTC surface and needs its own review.

**D4 — Gated drops (medium).**
Prior-customer gate (attestation-presenting entry), early-access pass via
Locks credential + `presaleStartsAt` (Studio prices the pass — a merchant
revenue line), follower gate with disclosed limits, DM invite tokens
composed in the existing E2EE messaging. Each gate ships with its honesty
copy, and the drop archive begins feeding the Phase 3 attestor pipeline so
"12 drops, 12 honored commitments" becomes a verifiable merchant
credential.

**D5 — Dutch format (optional, demand-driven).**

Sequencing rationale: D1 is the product; D2 is cheap credibility on top of
D1's record; D3 is the moat but is the largest and depends on nothing in
D2; D4 reuses D1–D3 plumbing plus existing Locks/attestation machinery.
The independent security review gate applies before any real-funds drop —
raffle draws and paid entries are exactly the kind of surface reviewers
should see before money touches them.
