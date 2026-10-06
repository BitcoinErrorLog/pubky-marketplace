# ADR 0024: Portable Reputation via Durable Purchase Attestations

## Status

Accepted — 2026-08-21 (proposed and ratified the same day; open decisions D1–D8 resolved, see design doc §11)

> The full design, threat model, and UX treatment live in [trust-reputation-design.md](../ecommerce/trust-reputation-design.md); this ADR records the decisions that bind other components. D2 was ratified as a custom position (both-sides consent for amount bands) and §2 below reflects it.

## Context

Reviews exist today only as rows in the Marketplace Transaction Service's PostgreSQL (`review.create` / `review.update`, one per participant per order, 24-hour edit window). The public review record is fully specified — `PubkyAppMarketplaceReview` in the `pubky-app-specs` fork, anchored on the **reviewer's** homeserver with a reserved opaque `eligibilityAttestation` field (32–4,096 chars, charset `[A-Za-z0-9._~-]`) — but nothing publishes, attests, or indexes it. There is no seller rating aggregation anywhere: no stars on cards, no review counts on shops, no fulfillment stats, no visible dispute record.

A review record without purchase evidence is worthless at aggregation time: any key can mint reviews. ADR 0020 §5 anticipated this with a review eligibility attestation, but specified it as **short-lived, single-use, and consumed by the service** — a shape under which only our service can verify anything, which defeats the strategic goal: reputation that belongs to the Pubky identity, indexable and verifiable by anyone, not hostage to this marketplace.

Constraints inherited from accepted ADRs:

- ADR 0019 §8: no addresses, payment correlations, order identifiers, or bearer material in public records — this applies to attestation claims.
- ADR 0020 §5: reviewers publish under their own homeserver path; moderation never rewrites a reviewer's record.
- ADR 0021: marketplace records live under `/pub/pubky.app/marketplace/v1/…`.
- The service holds no _user_ identity secrets (ADR 0019 §2) and currently has no signing identity of its own.

## Decision

### 1. The embedded attestation is durable and publicly verifiable

This ADR **revises ADR 0020 §5**: the attestation embedded in a published review record is a long-lived, publicly verifiable **purchase attestation**, not a consumed eligibility nonce. It has no expiry. Single-use semantics remain where they are already enforced: the service's `reviews_one_per_order_role` constraint gates review creation, and the record's deterministic path ID makes republication idempotent. All other provisions of ADR 0020 §5 stand.

### 2. Format: compact JWS, EdDSA (Ed25519), closed claim set

The attestation is a compact JWS (RFC 7515, `alg: EdDSA` per RFC 8037) — it fits the spec field's charset exactly and is verifiable with audited libraries in every target ecosystem. Claims (version `v: 1`, closed-world): `iss` (attestor pubky), `sub` (reviewer pubky), `cpk` (counterparty pubky), `role`, `listing` (canonical listing URI), `order_ref` (attestor-salted Blake3 of the private order UUID), `completed_on` (**day granularity**), optional `amount_band` (log-decade band with currency code, e.g. `SAT:5`), `iat`. Exact amounts, timestamps finer than a day, addresses, payment IDs, and `bundle_id` are prohibited in claims — the ADR 0019 §8 redaction list applies verbatim.

**Amount bands require both-sides consent (ratified D2).** The band claim is emitted only when the seller's standing band-consent preference — a per-seller setting stored by the transaction service, off by default, evaluated at issuance time — allows it **and** the reviewer opted in for that specific review at review time. Either side silent or opposed means the claim is omitted. The buyer-side opt-in control is surfaced only when the seller has already consented.

### 3. The attestor is a Pubky identity

The attestation signing key is an Ed25519 key whose z-base-32 encoding is the attestor's pubky. Verification is therefore self-contained — decoding `iss` yields the verification key; no key server and no call to this marketplace is required. The attestor identity publishes on its own homeserver: a profile record (operator, policy, key epoch, `successor` for rotation), per-seller signed stat attestations, and per-`order_ref` outcome annotations, all under `/pub/pubky.app/marketplace/v1/attestor/…` (new spec records, to be added to the fork).

**Recorded trust assumption**: the signature proves key possession, not legitimacy. Verifiers pin attestor pubkys out of band. Multiple attestors are supported by construction (`iss` is data, not configuration); today exactly one exists.

The attestor secret is the service's own operational key (KMS-grade custody, audited issuance). This does not touch ADR 0019's prohibition on holding user secrets.

### 4. Issuance rides the existing review command

The service issues the attestation inside the `review.create` transaction and returns it in the command result; a participant-scoped idempotent read (`GET /v1/orders/{id}/review-attestation`) supports re-fetch. The client embeds it in the record and publishes to the reviewer's homeserver, with failure handled by the visible retryable-outbox pattern of ADR 0020 §3. The public record is the canonical review; the service row remains the transactional gate (eligibility, one-per-order, edit window). The service's single-integer rating stays `= ratings.overall`; sub-ratings live only in the record and are aggregated by indexers.

### 5. Dispute outcomes annotate; they do not revoke

The attestor publishes outcome annotations keyed by `order_ref` (`refunded`, `dispute_resolved_for_reviewer`, `dispute_resolved_against_reviewer`, `attestation_disavowed`) on its own homeserver, driven by the existing `dispute.resolve` / `refund.record_external` events. Verifiers apply their own policy. Blanket revocation is rejected: a dispute lost by the seller strengthens the buyer's review.

### 6. Seller responses are sibling records on the responder's homeserver

New spec record `PubkyAppReviewResponse` at `/pub/pubky.app/marketplace/v1/review_responses/{review_id}` on the subject's homeserver, path ID equal to the subject review's ID (one revisable response per review). Authorization is structural: indexers accept a response iff its `owner_pubky` equals the review's `subjectPubky`. No attestation.

### 7. Fulfillment stats are signed attestor claims, not recomputable facts

Time-to-ship, dispute rate, and completion rate derive from the private order book (the service's append-only events table). They are published as periodic signed stat attestations on the attestor's homeserver — banded and per-mille, never raw counts or amounts — and are **origin-verifiable but not independently auditable**. This limit is structural (order privacy vs. stat auditability) and is disclosed wherever the stats render. Message responsiveness is not computable by anyone (E2EE messaging) and is excluded.

### 8. Tags stay out of the star math

Community tags remain an ungated social primitive. Indexers annotate tag aggregates with the count of taggers holding attested reviews for the subject (`taggers_verified`) and clients rank tag display by it; tags never feed numeric ratings. Rationale and anti-brigading treatment: design doc §8.

### 9. Aggregation lives in Nexus; cards read the stream projection

The Nexus marketplace index gains a review event handler (spec validation + JWS verification against a configured attestor trust list), per-subject reputation aggregates maintained incrementally, reputation/review endpoints, and — binding rule — a compact `reputation {avg, count, verified_count}` object embedded in the listing stream and shop views so cards render reputation with **zero additional requests**. Reviews about buyers aggregate identically, keyed by role.

## Consequences

### Positive ✅

- A seller's reputation is a set of user-owned records plus self-certifying signatures: verifiable and re-aggregatable by any third party without this marketplace's cooperation — the differentiator is real, not aspirational (verification recipe: design doc §9).
- Sellers cannot delete or suppress reviews (reviewer-owned records); the marketplace cannot silently rewrite history (any rewrite breaks signatures or diverges from crawlable records).
- Sybil reviews are priced: a verified review costs a completed order through a trusted attestor.
- The existing spec field, review commands, event timestamps, and Nexus tag-aggregation machinery are reused; no schema break to shipped records.

### Negative ❌

- The service gains a signing identity: key custody, rotation, and audit become operational responsibilities before this ships.
- Attestor trust is the root assumption; wash trading is deterred by cost, not prevented. "Trustless" may never appear in copy.
- Fulfillment stats are trust-me-signed, structurally: privacy of orders was chosen over auditability of aggregates.
- Dual persistence (service row + homeserver record) admits temporary divergence; late record edits are flaggable but not preventable.
- Day-granularity dates plus amount bands still leak a weak correlation surface against on-chain data; disclosed, not eliminated.

### Neutral ⚠️

- Discovery of reviews requires an indexer (as with tags and follows); the records themselves are portable regardless. Anyone can run the indexer.
- The attestor trust list is verifier policy — Nexus deployments, clients, and third parties may legitimately disagree about which attestors count.
- One living review per (listing, subject, role) — per the shipped ID recipe — is kept; repeat purchases refresh the attestation rather than adding records (design doc D1).

## Alternatives Considered

- **Service-consumed single-use attestation (ADR 0020 §5 as written)** — only our service can verify; rejected for the portable role.
- **Reviews on the seller's homeserver** — seller could delete criticism; contradicts the point of the suite.
- **Bespoke signature envelope instead of JWS** — saves ~100 bytes, costs every third-party implementer a custom parser; rejected.
- **Expiring attestations + renewal** — makes reputation evaporate on attestor whim; annotation handles bad outcomes instead.
- **Blended trust score (stars + tags + stats + graph)** — unexplainable and gameable at its weakest input; facts are rendered separately.
- **On-chain anchoring / ZK purchase proofs** — cost and machinery out of proportion for v1; the versioned claim format leaves the door open.

## Implementation Notes

Phasing, task graph, and sizing: [trust-reputation-plan.md](../ecommerce/trust-reputation-plan.md). The purchase attestation (specs claim format → service issuance → client publication → Nexus verification) is the critical path; stat attestations and tag annotation hang off it. Spec additions land in the `pubky-app-specs` fork: attestor profile/stat/annotation records and `PubkyAppReviewResponse`; `PubkyAppMarketplaceReview` itself needs no change.

## Related Decisions

- [ADR 0019: Marketplace Transaction Authority](0019-marketplace-transaction-authority.md)
- [ADR 0020: Marketplace Public Records](0020-marketplace-public-records.md) — §5 revised by this ADR
- [ADR 0021: Marketplace Record Namespace](0021-marketplace-record-namespace.md)
- [ADR 0022: Marketplace Transaction Service in Rust](0022-marketplace-transaction-service-rust.md)
- [Trust & Reputation design](../ecommerce/trust-reputation-design.md)

## References

- RFC 7515 (JWS), RFC 8037 (EdDSA/Ed25519 for JOSE)
- `pubky-app-specs` fork: `src/models/marketplace_review.rs`
- `marketplace-service`: `crates/service/src/handlers/reviews.rs`, `crates/domain/src/state_machines.rs`
- `pubky-nexus` branch `feat/marketplace-indexing`: `nexus-common/src/models/tag/listing.rs` (aggregation precedent)

## Superseded In Part (2026-09-05)

Dispute outcome annotations, dispute-rate seller stats, and moderator disavow mechanisms are superseded. Portable reputation now keeps peer reviews, purchase attestations, seller responses, refund annotations, and non-adjudicative fulfillment stats only.
