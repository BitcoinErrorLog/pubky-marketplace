# Trust & Reputation: Portable Seller Reputation Design

Status: **Design — no code**. This document, [ADR 0024](../adr/0024-portable-reputation.md) (Proposed), and the [implementation plan](trust-reputation-plan.md) are the deliverable. Nothing described here is built unless [status.md](status.md) says so.

Last updated: 2026-08-21.

## 1. Goal and non-goals

eBay's durable advantage was never a feature — it was the feedback score: an aggregate record of counterparty behavior that buyers trusted and sellers could not afford to abandon. That aggregate was also eBay's cage: a seller's decade of standing was hostage to one database.

The goal here is the same aggregate with the cage removed:

1. **Aggregate seller reputation** — stars, counts, verified-purchase counts, fulfillment stats — rendered cheaply on cards, listings, and shops.
2. **Buyer-side history** — the same machinery pointed at buyers (the review spec already models both directions).
3. **Portable reputation** — review records anchored to Pubky identities on user homeservers, verifiable and re-aggregatable by any third party, with the sybil problem answered by signed purchase attestations rather than by trusting our database.

Non-goals for v1:

- No numeric "trust score" synthesized from heterogeneous signals. We render facts (averages, counts, attested stats) and let clients weight them.
- No cross-marketplace reputation _exchange protocol_. We define the record and attestation formats so a second attestor can appear; we do not build federation machinery.
- No on-chain anchoring, zero-knowledge proofs, or web-of-trust scoring. Considered and deferred (§12).

## 2. What already exists (constraints found in code)

Everything below was verified in the actual repos on 2026-08-21. The design is shaped by these facts, not by aspiration.

### 2.1 The review record is already specified — on the reviewer's homeserver

`pubky-app-specs` fork, `src/models/marketplace_review.rs`:

- `PubkyAppMarketplaceReview` lives at `/pub/pubky.app/marketplace/v1/reviews/{review_id}` **on the reviewer's homeserver** (`owner_pubky` is the reviewer). The reviewer owns their words; the seller cannot delete them.
- `review_id = Crockford-base32(Blake3("{listing_uri}:{subject_pubky}:{role}")[:half])` — deterministic per (listing, subject, role). **The order is not part of the ID**: a repeat buyer has one living review per listing per role, revised via `revision`, not one review per order (§6.1 takes a position on this).
- Fields: `subjectPubky`, `listingOwnerPubky`, `listingId`, `role` (`buyer_reviewing_seller` | `seller_reviewing_buyer`), `ratings` (`overall` required, `itemAccuracy`/`shipping`/`communication` optional, all integers 1–5), `text` (1–5,000 chars), and — critically — **`eligibilityAttestation`: an opaque string, 32–4,096 chars, charset `[A-Za-z0-9._~-]`**. The field is reserved and validated but nothing issues or verifies its content today. The charset admits base64url plus `.`, so a compact JWS fits exactly.
- The specs URI parser (`src/uri/resource.rs`) already routes `Resource::MarketplaceReview(id)` — Nexus can dispatch review PUT/DEL events without parser work.

### 2.2 The transaction service holds the ground truth but issues no attestations

`marketplace-service` (Rust, ADR 0019/0022):

- `review.create` (ported from the prototype engine): one review per participant per order, enforced by the `reviews_one_per_order_role` DB constraint; eligible states `delivered`/`completed`/`closed`; creating a buyer review transitions `delivered → completed`. `review.update` allows edits within `REVIEW_EDIT_WINDOW_SECONDS = 24h`.
- The service's `ReviewRow` has a **single integer rating**; the homeserver record has multi-dimensional ratings. §6.4 reconciles this.
- Order timestamps: the service's `events` table is append-only with one row per state transition, so **paid→shipped→delivered durations are derivable** (`fulfillment.ship` also writes `shipped_at` into the order's shipment JSON). Returns and external-refund evidence are on the order row.
- **No attestation code exists** (`rg attestation` over the service returns nothing). ADR 0020 §5 _specifies_ a short-lived, single-use review eligibility attestation, but it was never implemented — and §5's short-lived/consumed-once framing is the wrong shape for _portable_ verification (§5.2 revises it).
- The service authenticates users via Pubky AuthTokens but **has no signing identity of its own**. Issuing attestations adds one (§5.4) — a new operational key-management responsibility.

### 2.3 Nexus indexes listings, shops, and tags — not reviews

`pubky-nexus`, branch `feat/marketplace-indexing`:

- Listing/shop details in a graph (Neo4j) plus Redis sorted-set stream indexes; `GET /v0/stream/listings` serves the full card projection (the auction-terms episode in status.md established the rule: **anything a card renders must be in the stream projection** — per-card hydration is a bug, not a pattern).
- Community tag aggregation exists for listings and shops (`TagListing`, `TagShop`; endpoints `v0/listing/{seller}/{listing}/tags`, `v0/shop/{seller}/tags`) using the same tagger-graph model as posts.
- **No review event handler exists.** The watcher's missing-dependency retry and one-shot migration patterns (auction-terms backfill) are the established templates for the review pipeline and its backfill.

### 2.4 The client validates review records but never publishes them

`pubky-app` (this repo, marketplace branches):

- `src/libs/commerce/marketplace-records.ts` has the full Zod review-record schema including `eligibilityAttestation` with the exact spec constraints; the commerce normalizer parses review records. **No code publishes a review record to a homeserver** — today's review UI writes only to the service via `review.create`/`review.update`.
- Reviews therefore currently exist _only_ in the service's Postgres: exactly the "hostage" state this design removes.

## 3. Design overview

```text
                     BUYER'S HOMESERVER                        SELLER'S HOMESERVER
              /pub/pubky.app/marketplace/v1/               /pub/pubky.app/marketplace/v1/
                reviews/{review_id}                          review_responses/{review_id}
                  │  contains embedded                          │
                  │  purchase attestation (JWS) ◄─── issued by ─┼──────────┐
                  ▼                                             ▼          │
        ┌──────────────────────────────────────────────────────────┐      │
        │  ANY INDEXER (Nexus marketplace index, or a third party) │      │
        │  - validates records against pubky-app-specs             │      │
        │  - verifies attestation signatures (self-certifying keys)│      │
        │  - aggregates per-seller reputation                      │      │
        └──────────────────────────────────────────────────────────┘      │
                  ▲                                                        │
                  │ signed seller stat attestations                        │
                  │ + refund annotations                           │
        ATTESTOR'S OWN HOMESERVER  ◄───── published by ────  TRANSACTION SERVICE
        /pub/pubky.app/marketplace/v1/attestor/…             (holds the order ground truth,
                                                              holds the attestor secret key)
```

Three primitives, in order of trust weight:

1. **Attested reviews** — reviewer-owned records carrying a durable, publicly verifiable purchase attestation. The quantitative backbone.
2. **Signed seller stat attestations** — service-computed fulfillment stats (time-to-ship and completion rate) signed by the attestor and published on the _attestor's_ homeserver. Verifiable as to origin; not independently recomputable (§7 is explicit about this limit).
3. **Community tags** — the existing social primitive as a qualitative overlay, annotated (not gated) by verified-purchase status. Never an input to the star math (§8).

## 4. Threat model for reputation specifically

| Threat                                             | Answer                                                                                                                               | Residual risk                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sybil reviews from fresh keys                      | Reviews without an attestation from a trusted attestor are visibly unverified and excluded from "verified" aggregates                | Unverified reviews still exist as records; clients must render the distinction honestly                                                                          |
| Wash trading (self-purchases to farm attestations) | Attestations carry amount bands and per-order uniqueness; each fake review costs a real completed order through the attestor's rails | **Not solved, priced.** A determined seller can still buy their own goods. The attestor's fraud controls are the real backstop — same as eBay, minus the lock-in |
| Seller suppresses bad reviews                      | Impossible by construction: reviews live on reviewer homeservers                                                                     | A reviewer's homeserver going offline drops their review from fresh crawls; indexers retain cached copies                                                        |
| Reviewer extortion ("pay me or the 1-star stays")  | Seller response records (§6.3) + refund annotations give context                                                                     | No removal mechanism; deliberate — moderation is indexer/client policy, not record surgery (ADR 0020 §5 already states this)                                     |
| Attestor forges or backdates attestations          | Attestor is a single trusted party per marketplace; multiple attestors dilute this                                                   | **Trust assumption, flagged**: an attestation proves "attestor X claims this order completed", nothing stronger                                                  |
| Attestor key compromise                            | Key rotation via attestor profile record (§5.4); annotations can mark an epoch compromised                                           | Attestations from the compromised window are indistinguishable; verifiers decide policy                                                                          |
| Tag brigading                                      | Tags never enter star aggregates; display ranks verified taggers first (§8)                                                          | Ugly tag clouds remain possible; visibility ranking, not operator removal, is the v1 control                                                                     |
| Indexer lies about aggregates                      | Anyone can re-run aggregation from the records (§9); aggregates are reproducible                                                     | Stat attestations (§7) are only signature-checkable, not recomputable                                                                                            |

## 5. The purchase attestation (design question 1)

### 5.1 What it attests

"**Attestor X asserts: an order between buyer B and seller S for listing L, in role R, completed at time T (day granularity), in amount band A.**" It attests the _purchase_, deliberately not the review text: the review is revisable (spec `revision`, service 24h window) and the attestation must survive revisions without re-issuance.

### 5.2 Relationship to ADR 0020 §5

ADR 0020 §5 specified a _short-lived, single-use, service-consumed_ eligibility attestation: the reviewer publishes, the service reads back, consumes eligibility once, and indexes. That shape makes the **service** the verifier — a third party learns nothing from a consumed nonce. This design revises it (recorded in ADR 0024): the embedded attestation is **durable and publicly verifiable**; no expiry, no consumption. Single-use is enforced where it actually lives: the service's `reviews_one_per_order_role` constraint gates _creation_, and the record's deterministic ID makes republication idempotent. ADR 0020's other §5 rules (no private data in review records, moderation never rewrites the reviewer's record) stand unchanged.

### 5.3 Format: compact JWS, EdDSA (Ed25519)

The spec's charset (`[A-Za-z0-9._~-]`, 32–4,096 chars) admits compact JWS serialization (`base64url.base64url.base64url`) exactly. JWS/EdDSA (RFC 7515/8037) is chosen over a bespoke format because every ecosystem this must be verifiable from (Rust, TypeScript, mobile bindings) has audited implementations, and because "verify this yourself" marketing collapses if verification requires our custom parser.

Header: `{"alg":"EdDSA","typ":"pubky-purchase-attestation+v1"}` — `kid` unnecessary; the issuer key is in the payload and self-certifying (§5.4).

Payload claims (closed-world; verifiers must reject unknown versions, tolerate no extra claims within `v:1`):

```json
{
  "v": 1,
  "iss": "<attestor pubky, z-base-32>",
  "sub": "<reviewer pubky, z-base-32>",
  "cpk": "<counterparty pubky, z-base-32>",
  "role": "buyer_reviewing_seller",
  "listing": "pubky://<seller>/pub/pubky.app/marketplace/v1/listings/<listing_id>",
  "order_ref": "<lowercase hex Blake3(order_uuid || attestor_order_salt)>",
  "completed_on": "2026-08-21",
  "amount_band": "SAT:6",
  "iat": 1787654321
}
```

- `order_ref` is an opaque, attestor-salted hash of the private order UUID. It exists so annotations (§5.6) and repeat-purchase attestations can reference a specific order without exposing service identifiers (ADR 0019 §8 forbids payment/order correlation leakage). The salt is held by the attestor; nobody else can link `order_ref` back to an order.
- `completed_on` is **day-granularity**, deliberately: a full timestamp plus an amount band could correlate a review with an on-chain payment. Day granularity plus log-scale banding keeps the correlation weak. This residual correlation risk is real and disclosed here rather than denied.
- `amount_band` is `"{CURRENCY}:{floor(log10(total_minor))}"` — e.g. an 850,000-sat order is `SAT:5`. Optional claim, gated by **both-sides consent (ratified D2)**: the band is included only when the seller's standing band-consent preference (a per-seller setting stored by the transaction service, off by default, revisable at any time; it applies at issuance time) allows it **and** the buyer opted in at review time (a per-review choice in the review flow, off by default, surfaced only when the seller side has already consented). Either side silent or opposed → no band. **No exact amounts, no addresses, no payment IDs, no `bundle_id`** — the ADR 0019 §8 redaction list applies verbatim to attestation claims.
- No `exp`. Portable reputation that evaporates on an attestor-chosen schedule is not portable. Bad outcomes are handled by annotation (§5.6), not expiry.

Size check: header (~46 chars b64) + payload (~450 chars b64) + Ed25519 signature (86 chars b64) ≈ 590 chars — comfortably inside the spec's 4,096 ceiling and above its 32 floor.

### 5.4 The attestor identity is a Pubky identity

The attestor's signing key is an Ed25519 key that **is itself a pubky** (z-base-32 of the public key). This is the decision that makes the whole scheme decentralized-native rather than "our API, but signed":

- **Verification needs no key discovery.** A pubky is self-certifying: decode `iss` from z-base-32 and you hold the Ed25519 verification key. Step 2 of the recipe (§9) works fully offline.
- **Trust still needs pinning — flagged plainly.** The signature proves _which key_ signed; it cannot prove the key belongs to an honest marketplace. Verifiers maintain a trust list of attestor pubkys, obtained out of band (client configuration, curated lists, the marketplace's published documentation). This is the scheme's root trust assumption and every consuming client must state it.
- **The attestor gets a homeserver presence.** The attestor pubky publishes, on its own homeserver: a profile record (operator name, policy URL, key epoch), seller stat attestations (§7), and annotations (§5.6). New spec records under `/pub/pubky.app/marketplace/v1/attestor/…` (specs-fork addition; exact schemas in the plan's Phase 1).
- **Rotation**: a new attestor pubky is announced in the old identity's profile record (`successor` field) and cross-signed (old key signs the new pubky). Verifiers treat attestations from either epoch as one attestor. Compromise of the old key after rotation is handled by an annotation marking the epoch, with the honest caveat from §4: forgeries within the compromised window cannot be distinguished retroactively.
- ADR 0019's rule that the service holds no _user_ identity secrets is unchanged; the attestor key is the service's **own** operational secret (KMS/HSM-grade handling; issuance rate-limited and audited like any ledger-adjacent operation).

### 5.5 Issuance flow

1. Buyer confirms delivery; order reaches a reviewable state (`delivered`/`completed`/`closed` — the existing service table).
2. Client sends `review.create` as today, plus an optional per-review amount-band opt-in flag (ratified D2; the flag is meaningful only when the seller's standing consent also allows the band). On success the service — inside the same transaction that inserts the review row — issues the attestation and returns it in the command result. A new authenticated read (`GET /v1/orders/{id}/review-attestation`, participant-scoped) allows re-fetch for retry/re-publication; issuance is deterministic per order+reviewer, so re-fetching returns the same attestation (idempotent, no consumption semantics).
3. Client builds the `PubkyAppMarketplaceReview` record (schema already in the client), embeds the JWS in `eligibilityAttestation`, and publishes to the reviewer's homeserver. Publication failure leaves a visible retryable outbox item — the exact pattern ADR 0020 §3 established for listing publication. No new distributed-transaction claim: the service copy and the public record converge, and until they do the review simply isn't publicly visible.
4. `review.update` within the 24h window re-publishes the record with `revision + 1`; the attestation is unchanged (it attests the purchase, §5.1).

Ordering choice — attestation only after `review.create` succeeds, not before: it inherits the service's one-review-per-order gate for free, and a reviewer can never hold an unused attestation for a review they never filed.

### 5.6 Refund annotations: annotate, don't revoke

External-refund evidence can annotate a review context, but there is no marketplace adjudicator that can decide trade outcomes or revoke a peer's review.

### 5.7 Multiple attestors

Nothing above is singular. A review's attestation names its `iss`; a second marketplace running its own transaction authority issues its own attestations against the _same_ review record format on the _same_ homeservers. Reputation becomes "reviews attested by authorities **you** choose to trust": Nexus config carries an attestor allow-list; aggregates are computed per-trust-list; a third-party indexer chooses differently. This is the concrete sense in which a seller's standing is not hostage to our service — the day a second attestor exists, their record set already interoperates. (Honesty: today there is exactly one attestor. The claim is "no lock-in by construction", not "federation exists".)

## 6. Record topology (design question 2)

### 6.1 Reviews: confirm reviewer-homeserver ownership; keep one-per-(listing,subject,role)

The spec's placement is confirmed as-is: reviewer's homeserver, reviewer owns the record. The deterministic ID without an order component means a repeat buyer _revises_ one living review rather than accumulating one per order. **Position: keep it for v1.** Rationale: it matches the shipped spec (changing the ID recipe is a breaking spec change); it caps per-buyer influence on a seller's aggregate at one review per listing per direction (an anti-spam property eBay lacked); and repeat purchases still count — each new order yields a fresh attestation, and the record's attestation can be superseded by the newest one while Nexus counts distinct attested orders via `order_ref`. The cost — a buyer cannot keep separate 5-star and 1-star reviews of the same listing — is accepted and listed as open decision D1 for the product owner (§11) since reversing it later means a spec v2.

### 6.2 Discovery: tag-style reverse indexing; portability of discovery stated honestly

Nexus's watcher already receives every PUT/DEL from homeservers it monitors, and the specs parser already routes review URIs. A new review handler validates the record (spec validation incl. ID regeneration), verifies the embedded JWS, and writes a graph edge `(:User{reviewer}) -[:REVIEWED {attested, iss, order_ref, overall, …}]-> (:User{seller})` plus listing linkage — the same reverse-index shape tags use (tags on shops/listings are discovered by watching _tagger_ homeservers, not the target's). Aggregation keys on the **subject**, exactly like `Listing:Taggers`.

Stated limit: Pubky has no global enumeration primitive, so "any indexer can discover all reviews about seller S" means _any indexer that crawls the reviewers' homeservers_ — which is the same coverage model every Pubky aggregate (tags, follows) already has. The records are portable unconditionally; _discovery_ requires an indexer, and anyone can run one (Nexus is open source and the marketplace index is a branch of it). The design does not claim serverless discovery.

### 6.3 Seller responses: a new sibling record on the seller's homeserver

New spec record `PubkyAppReviewResponse` at `/pub/pubky.app/marketplace/v1/review_responses/{review_id}` on the **seller's** homeserver — the responder owns their words, symmetrically. Design points:

- The path ID **equals the subject review's ID**, giving O(1) lookup in both directions and structurally capping responses at one per review (revisable via `revision`).
- Fields: base record fields + `reviewUri` (full URI of the subject review), `text` (1–5,000 chars). **No attestation needed**: authorization is structural — an indexer accepts a response only if the response record's `owner_pubky` equals the review's `subjectPubky`. An impostor's response fails that check without any signature machinery.
- Response to a _buyer_ review (`seller_reviewing_buyer` role) works identically with the buyer as responder.

### 6.4 The service row and the public record: which is canonical

The **public record is the canonical review** (ADR 0020 already says the owner homeserver is canonical for authored public content). The service row remains the _transactional gate_: it enforces one-review-per-order, the edit window, and the `delivered → completed` transition. Two reconciliations this forces, stated explicitly:

- **Ratings shape**: the service row stores a single integer rating; the record carries `overall` plus optional sub-ratings. The service keeps its single `rating = overall` (no service schema change); sub-ratings exist only in the record and are aggregated by indexers. The service copy is a gate, not the display source.
- **Edit window divergence**: the service rejects `review.update` after 24h, but the reviewer _technically_ controls their homeserver record forever. An indexer can flag records whose `updated_at` moved long after `created_at` as "edited outside the marketplace window" (the timestamps are right there); Nexus will surface `edited_late: true` rather than pretending the window is protocol-enforced. The window is app policy; the record is user property. This is the honest cost of user-owned data, and it is small: the attestation still binds the purchase, and late edits are visible, not silent.

## 7. Stats beyond stars (design question 3)

### 7.1 What the service can compute

From the append-only `events` table and order rows, per seller, per period: completed-order counts, median/p90 paid→shipped, shipped→delivered, cancellation rate, external-refund rate. All of this is private-order-derived: **none of it can be recomputed from public records.**

### 7.2 The portable form: signed periodic stat attestations, published by the attestor

The service periodically (weekly, and on-demand after material changes) computes per-seller stats and publishes a **signed stat attestation** to the _attestor's own homeserver_ at `/pub/pubky.app/marketplace/v1/attestor/seller_stats/{seller_pubky}` (latest-wins, revisioned):

```json
{
  "v": 1,
  "attestor": "<attestor pubky>",
  "seller": "<seller pubky>",
  "period": { "from": "2026-05-01", "to": "2026-08-01" },
  "ordersCompletedBand": "2",
  "medianTimeToShipHours": 18,
  "completionRatePermille": 991,
  "signature": "<JWS over the canonical body>"
}
```

Bands and per-mille rates, not raw counts, keep exact GMV/volume private while remaining rankable. Why the **attestor's** homeserver and not the seller's: a seller handed their own stat record would publish the flattering ones and "lose" the bad ones — selective disclosure would gut the signal. On the attestor's homeserver the stats are non-suppressible by the seller and fetchable by anyone.

### 7.3 What is portable here and what honestly is not

- **Portable**: origin-verifiability. Anyone can fetch the record, verify the attestor's signature, and render "attestor X reports median ship time 18h". If the marketplace's frontend dies, the stat record survives on the attestor homeserver, and a seller can point any third party at it.
- **Not portable, and cannot be**: independent recomputation. Time-to-ship and completion rate derive from the attestor's _private_ order book; auditing them would require exposing per-order data that ADR 0019 §8 correctly forbids. A third party must trust the attestor's honesty for these numbers — full stop. The design mitigates at the margins (cross-checks: attested-review counts visible publicly put a floor under `ordersCompletedBand`; a stat attestation claiming fewer orders than there are attested reviews is provably lying) but the core limit is structural: **privacy of orders and auditability of fulfillment stats are in direct tension, and this design chooses privacy.**
- **Not computable by anyone at all**: message responsiveness. Durable-mode messaging is end-to-end encrypted (status.md); the service never sees bodies or timing. A "responds quickly" stat would require weakening E2EE and is rejected. If message-responsiveness signal is ever wanted, it must come from voluntary, client-side disclosure — out of scope.
- Star aggregates, review counts, verified-purchase counts, response rates _to reviews_ (response records are public), and tag aggregates are **fully recomputable** from public records and belong to §5/§6/§8 machinery, not to stat attestations.

## 8. Tags as reputation ingredients (design question 4)

Community tags on shops and listings are already live Pubky records with Nexus aggregation. The question is whether they feed reputation. **Position: tags are a qualitative overlay — annotated by verified-purchase status, ranked by it, but never converted into the star math.**

Why not blend tags into scores:

1. **No eligibility gate, by design.** Tagging is the shared social primitive; anyone may tag anything without a purchase. Gating tag _writes_ on attestations would fork the primitive into "marketplace tags" and "social tags" and break the existing spec, client flow, and Nexus pipeline for no gain.
2. **Unbounded adversarial vocabulary.** Stars are a closed 1–5 scale from attested purchasers; tags are free text from anyone. Any numeric blending imports an unpriced sybil channel into the one number the whole suite exists to defend. A brigade can spray "scammer" tags at a rival today; if tags moved scores, that brigade would move scores.
3. **They answer different questions.** Stars answer "did verified buyers have a good experience?"; tags answer "what does the crowd associate with this shop?" ("fast-shipper", "great-packaging", "vintage-audio"). Collapsing them loses information.

What tags **do** get — tagger-graph weighting, at the index:

- Nexus already knows each tag's taggers. The review pipeline (§6.2) adds `REVIEWED {attested:true}` edges. Joining the two, each tag aggregate on a shop/listing gains `taggers_verified` — the count of taggers holding at least one attested review for that seller — alongside the existing raw count.
- Display policy (client): tag chips ranked by `taggers_verified` first, raw count second; a "✓ n verified buyers" affix on chips where `taggers_verified > 0`. Verified-buyer tags like "fast-shipper" thereby become _legible qualitative evidence_; drive-by tags sink without being censored.
- Anti-brigading inherits existing structure: the deterministic `PubkyAppTag` ID already caps one record per (tagger, uri, label); ranking by verified taggers makes brigades expensive (each verified tagger costs a completed purchase). No new suppression machinery in v1 — visibility ranking, not deletion.
- Deliberately rejected: tag _sentiment_ classification feeding scores (fragile, gameable), and purchase-gated tag creation (breaks the shared primitive, see 1).

## 9. The portability recipe (design question 6)

What a third party — another client, another indexer, a seller migrating away, an auditor — can do **without our service running**, given only: the review record format (`pubky-app-specs`, open source), a list of attestor pubkys they trust, and read access to homeservers.

**To verify one review:**

1. Fetch `pubky://{reviewer}/pub/pubky.app/marketplace/v1/reviews/{review_id}` from the reviewer's homeserver (or any cache/index; step 3 makes the source irrelevant).
2. Validate against `pubky-app-specs`: closed-world parse, `owner_pubky` equals the URI host, ID regeneration `Blake3("{listing_uri}:{subjectPubky}:{role}")` matches the path.
3. Parse `eligibilityAttestation` as compact JWS. Decode `iss` from z-base-32 → that _is_ the Ed25519 verification key. Verify the signature. **No key server, no our-API call, works offline.**
4. Check bindings: `sub == owner_pubky`, `cpk == subjectPubky`, `listing` matches `listingOwnerPubky + listingId`, `role` matches. Any mismatch → attestation does not cover this review.
5. _Optional, availability-dependent_: fetch `iss`'s attestor annotations for `order_ref` (§5.6); apply local policy for `refunded`/`disavowed`.
6. Accept as **verified** iff `iss` is on the verifier's trust list. Otherwise the review is a valid-but-unverified record.

**To recompute a seller's reputation:** enumerate review records about seller S from any index (or crawl), run steps 2–6 per record, deduplicate by `(owner_pubky, review_id)` and count distinct purchases by `order_ref`, then aggregate: average/histogram of `ratings.overall` and sub-ratings over verified reviews, verified counts, response rate (fetch `review_responses/{review_id}` from S's homeserver; accept iff its owner equals `subjectPubky`).

**What the recipe delivers vs. not — the honest marketing boundary:**

- Deliverable claim: _"Every verified review is independently checkable, and the whole score is recomputable, by anyone, without asking us."_ True by construction above.
- Not deliverable: independent verification of _fulfillment stats_ (§7.3 — signature-checkable only); _completeness_ proofs (no one can prove they saw every review — coverage is an indexer property; conversely sellers cannot hide reviews, which is the side that matters); and _attestor honesty_ (§4 — the trust list is the root assumption). Marketing copy must not claim "trustless".

## 10. Aggregation architecture and UX surfaces (design question 5)

### 10.1 Nexus

- **Watcher — review handler** (new, mirrors tag/listing handlers): on `Resource::MarketplaceReview` PUT — spec-validate, JWS-verify against the configured attestor trust list, upsert graph edge + `Reviews:{seller}` sorted set (by `indexed_at`) + review-details JSON in Redis; missing seller → existing missing-dependency retry. DEL → tombstone the edge, decrement aggregates. Response records: same pipeline, joined by shared ID, accepted only when `owner == review.subjectPubky` (§6.3).
- **Aggregates — `ReputationSummary`** per subject (sellers and buyers — the role field keeps the two directions separate): count, verified count, distinct attested `order_ref` count, mean + histogram for `overall`, means for sub-ratings, response count, `last_reviewed_at`, `edited_late` count. Maintained incrementally on each event (the tag-aggregation precedent), full-recompute path via the one-shot-migration pattern for backfill/repair.
- **Stat attestation ingest**: the watcher also indexes the attestor homeserver's `seller_stats/{seller}` records (signature-verified, origin-labeled) so one Nexus round-trip serves both record-derived and attested stats.
- **Endpoints**: `GET /v0/marketplace/reputation/{pubky}` (full summary + latest stat attestation + provenance flags); `GET /v0/marketplace/reviews/{pubky}` (paginated reviews with joined responses and per-review `verified` flags, filterable by role); and — the card-economics decision — **an embedded compact `reputation: {avg, count, verified_count}` object on every entry of `GET /v0/stream/listings` and on shop views**. The auction-terms lesson from status.md is binding: cards must never hydrate per-listing. A cold grid costs the same one index request it costs today.
- **Tag annotation**: `taggers_verified` added to the existing listing/shop tag aggregate responses (§8).

### 10.2 Client

- **Cards** (catalog grid, search results, collection cells): star average + review count + a compact "✓ n" verified affix, straight from the stream projection. Zero additional requests.
- **Listing page**: full reputation block for the seller (stars, verified count, time-to-ship from the stat attestation with its origin label — "reported by marketplace attestor, signed"), review list with per-review verified badges, seller responses inline, `edited_late` flag where set.
- **Shop page**: the reputation block as header material + tag cloud with verified-tagger ranking + review history tab.
- **Buyer-side history**: "Reviews you've written" renders locally-first from the user's own homeserver records (they own them — no index needed), with sync state; "Reviews about you as a buyer" uses the same Nexus reputation endpoint with `role=seller_reviewing_buyer`. Sellers see a buyer's received-reviews summary in offer/order contexts — same endpoint, no new machinery.
- **Honest degradation** (the established mode ladder): no Nexus reputation endpoints → cards render without reputation (never zeros — absence, not a fake 0.0); reviewer's own reviews still render locally. No attestor reachable → verified badges compute (signature math is offline) but annotations show "unchecked".

### 10.3 Cold start: new sellers must not be buried

- **"New seller" is an explicit state, not a zero.** A 0-review seller renders a "New seller" badge — never `0.0 ★`, which reads as "bad", and never a fabricated neutral.
- **Attested activity before first review**: the stat attestation's `ordersCompletedBand` gives a seller with completed sales but no reviews yet something real to show ("10+ completed orders"). Shop age (`created_at` of the shop record) is rendered alongside.
- **Cross-role bootstrap**: a new seller with buyer-side attested history can show it ("member since…, ✓ verified buyer history") — the topology's two-directional records make this free.
- **Ranking policy**: default catalog sorts stay recency/relevance — reputation is a _filter and display facet_, not a default sort key in v1, so zero-history sellers appear in normal browsing. A "top rated" sort is explicit user intent. (Open decision D4 covers whether reputation ever enters default ranking.)

## 11. Decisions — ratified 2026-08-21

All eight decisions were ratified by the product owner on 2026-08-21. The table records the ratified position; D2 departs from the drafted default and §5.3 has been revised to match.

| #   | Decision                                                             | Ratified position                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | One living review per (listing, subject, role) vs. per-order reviews | **Keep spec** (§6.1): one living review per listing per role, revised in place; repeat orders refresh the attestation; Nexus counts distinct attested orders via `order_ref`                                                                                                                             |
| D2  | Amount bands in attestations                                         | **Custom — both-sides consent.** A band is included only when both the buyer and the seller have allowed it: the seller holds a standing band-consent preference on the shop/service side, the buyer opts in per review at review time. Default on both sides is _not included_. Consent mechanics: §5.3 |
| D3  | Stat attestation cadence and stat set                                | **Weekly**, minimal set {ship-time, completion rate} (§7.2)                                                                                                                                                                                                                                              |
| D4  | Does reputation enter default catalog ranking?                       | **Never in v1** (§10.3) — reputation is a filter/display facet only                                                                                                                                                                                                                                      |
| D5  | Unverified reviews on marketplace surfaces                           | **Show with "unverified" label** — hiding contradicts the openness story                                                                                                                                                                                                                                 |
| D6  | Attestor identity operations                                         | **Same process as the service**, key held in KMS/env; revisit before real funds move (§5.4)                                                                                                                                                                                                              |
| D7  | Who may respond to a review                                          | **Subject only**, one revisable response (§6.3)                                                                                                                                                                                                                                                          |
| D8  | Buyer reputation surfacing prominence                                | **Negotiation contexts only** — no public buyer profiles; public buyer scores invite harassment                                                                                                                                                                                                          |

## 12. Alternatives considered and rejected

- **Reviews on the seller's homeserver** (what a "seller-homeserver" reading of the early spec would imply): rejected — the seller could delete negative reviews, destroying the property the suite exists for. The shipped spec already places records with the reviewer; confirmed, not changed.
- **Service-consumed single-use attestations** (ADR 0020 §5 as written): rejected for the portable role — verification would be exclusive to our service (§5.2). Revised by ADR 0024.
- **Global trust score** blending stars, tags, stats, social graph: rejected — unexplainable, gameable at the weakest input, and it converts honest heterogeneous facts into one dishonest number.
- **On-chain anchoring / timestamping of reviews**: deferred — adds cost and machinery; the threat it counters (attestor backdating) is inside the attestor-trust assumption anyway (§4).
- **ZK proofs of purchase** (prove an order completed without naming the attestor or amount): genuinely interesting, wildly out of proportion for v1; the JWS design leaves room (an attestation format v2 could carry a proof instead of a signature).
- **Web-of-trust weighting** (weight reviews by the viewer's social graph distance): Nexus has the graph and nothing in this design precludes it, but it is a ranking-policy experiment, not a trust primitive; explicitly future work.

## 13. Trust assumptions — consolidated register

Every assumption a consuming party inherits, in one place:

1. **Attestor honesty**: attestations and stat attestations are only as true as the attestor's order book and fraud controls (§4, §5.7). Wash trading is priced, not prevented.
2. **Attestor key pinning**: `iss` trust lists are out-of-band configuration; the signature alone proves key possession, not legitimacy (§5.4).
3. **Attestor key custody**: compromise forges history within its window (§5.4).
4. **Stat attestations are not auditable**: origin-verifiable only; the underlying order book is private by design (§7.3).
5. **Indexer coverage**: aggregate completeness depends on which homeservers an indexer crawls; sellers cannot suppress reviews, but no one can prove exhaustiveness (§6.2, §9).
6. **Record persistence**: a reviewer's homeserver going dark removes their records from fresh crawls; caches mitigate (§4).
7. **Edit-window is policy, not protocol**: late edits are detectable and flagged, not preventable (§6.4).
8. **Spec-fork status**: all marketplace records live in a `pubky-app-specs` fork; upstream divergence would require migration (ADR 0021's stated risk, inherited).

## Related documents

- [ADR 0024: Portable Reputation](../adr/0024-portable-reputation.md) — the decision record for §5–§7.
- [Implementation plan](trust-reputation-plan.md) — phases, task graph, sizing.
- [ADR 0019](../adr/0019-marketplace-transaction-authority.md), [ADR 0020](../adr/0020-marketplace-public-records.md), [ADR 0021](../adr/0021-marketplace-record-namespace.md) — the constraints this design composes with.
- [status.md](status.md) — what is actually built today.
