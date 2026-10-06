# Fiat Rails: Phased Implementation Plan

Companion to `fiat-rails-design.md` (read it first — all design decisions and citations
live there). This plan turns the design into phases with sizing, parallelization, and an
explicit ownership boundary: **what we build vs what becomes an upstream proposal**.

> **Status (2026-08-21): Phase 1 executed.** The `fiat-verifier` gateway is built,
> tested, deployed to staging, and the Lock Server is cut over to it; the BTC live
> purchase re-passed through the proxy, and a USD lock was published and dispatched
> live. The Stripe test-card purchase (task 1.10's final leg) is blocked on a test-mode
> secret key. Observed values and the exact remaining step:
> [`fiat-rails-phase1.md`](fiat-rails-phase1.md).

Sizing: **S** ≤ 1 day · **M** = 2–4 days · **L** = 1–2 weeks.

## Ownership boundary

| We own (no upstream permission needed)                                                        | Upstream proposals (documents only, never pushed)                                                          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `fiat-verifier` service (new repo/deployment)                                                 | `VerifierType::ExternalPayment` + registry + config in Locks (`upstream-proposals/locks-fiat-verifier.md`) |
| mp-ux client changes (this repo)                                                              | Paykit Server multi-asset `CriterionAsset` (noted in same proposal, optional)                              |
| Lock-creation tooling for `asset: "USD"` locks (extends the live-test harness we already run) | Verifier-specific confirmation semantics in Lock Server config                                             |
| Our Lock Server / Paykit Server / marketplace-service _deployments_ and their config          | Any change to Locks task lifecycle (none proposed — deliberately)                                          |
| Chargeback handling without marketplace adjudication                                          | —                                                                                                          |

marketplace-service requires **zero changes** in every phase (design §1.6).

---

## Phase 0 — Design ratification and environment plumbing

Goal: agreement on the gateway topology and a staging environment where the Lock
Server's `[paykit] server_url` can be repointed.

| #   | Task                                                                                         | Size | Parallel? |
| --- | -------------------------------------------------------------------------------------------- | ---- | --------- |
| 0.1 | Review/ratify `fiat-rails-design.md` (topology, trust table, seller-owned accounts decision) | S    | —         |
| 0.2 | Confirm staging deploy target (Railway) + secret handling for processor test keys            | S    | with 0.1  |
| 0.3 | Send nothing upstream; file the proposal doc in-repo (done on this branch)                   | S    | with 0.1  |

Exit: sign-off on design; staging plan agreed.

## Phase 1 — fiat-verifier core + Stripe test mode (the make-or-break phase)

Goal: a USD-locked listing is purchasable end-to-end on staging with a Stripe test
card, producing a real Locks `completed` lifecycle and content unlock — no client
changes yet beyond a temporary checkout-URL surface for testing.

| #    | Task                                                                                                                                                                                                                               | Size | Parallel?      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------- |
| 1.1  | Service skeleton: axum + Postgres, `X-Paykit-Signature` ed25519 verification against pinned Lock Server key (mirror `paykit-server/src/http/auth.rs` semantics)                                                                    | M    | —              |
| 1.2  | `/invoices`: signed-body validation, content-lock fetch via `lock_resource` (public homeserver read), criterion parse (`asset`, `amount`, `recipient_pubky`), correlation persistence, 409 on duplicate                            | M    | after 1.1      |
| 1.3  | Asset dispatch + BTC pass-through proxy to Paykit Server (verbatim body + signature forward)                                                                                                                                       | M    | with 1.4       |
| 1.4  | Stripe processor: Checkout Session create (idempotency key from `creator‖bundle_id`), webhook endpoint (sig verify, event dedupe), **API-pull verification** (`payment_status == paid`, amount/currency match), slow-poll fallback | L    | with 1.3       |
| 1.5  | `/transactions/status`: state mapping incl. settlement-delay promotion (detected → confirmed with synthesized confirmations; fresh re-pull at promotion)                                                                           | M    | after 1.4      |
| 1.6  | `/checkout-sessions` buyer endpoint (idempotent re-mint, rate-limited)                                                                                                                                                             | S    | after 1.4      |
| 1.7  | Seller registry: `pubky → stripe_account_id`, manual/CLI insert for staging (Connect onboarding is Phase 4)                                                                                                                        | S    | with 1.4       |
| 1.8  | Lock-creation tooling: extend the live-test harness to author `asset: "USD"` locks                                                                                                                                                 | S    | with 1.2       |
| 1.9  | Deploy to Railway; point staging Lock Server `[paykit] server_url` at the gateway; verify existing BTC regtest live-test still passes through the proxy                                                                            | M    | after 1.3, 1.5 |
| 1.10 | Integration test: scripted USD purchase → Stripe test checkout → webhook → pull → delay → Locks `completed` → credential → unlock (extend `src/test/live/` pattern)                                                                | M    | after 1.9      |

Exit: `npm run test:marketplace:locks` still green through the proxy; new fiat live
test green with Stripe test mode. **This phase proves the zero-upstream-change claim;
if any hidden coupling appears here, stop and re-plan before touching the client.**

## Phase 2 — Buyer UX in mp-ux

Goal: real users on staging can choose card checkout.

| #   | Task                                                                                                                                      | Size | Parallel? |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------- |
| 2.1 | Payment-method chooser in `MarketplacePaymentStatusCard` driven by lock `asset` + seller processor availability                           | M    | —         |
| 2.2 | Fiat flow in `useMarketplaceLocksPayment`/commerce application: after registration, fetch `/checkout-sessions`, open URL, re-open support | M    | after 2.1 |
| 2.3 | Rail-labeled badges + truthful per-rail copy (design §7, incl. reversibility disclosure)                                                  | S    | with 2.2  |
| 2.4 | Return-from-checkout handling: no paid claims from redirect; projection poll remains sole truth                                           | S    | with 2.2  |
| 2.5 | Unit + integration tests for the chooser and fiat status states                                                                           | M    | after 2.2 |

Exit: staging demo — Bitcoin listing and USD listing side by side, both completing
through the identical Locks lifecycle. **This is the demoable thesis moment.**

## Phase 3 — PayPal sandbox processor

| #   | Task                                                                                                                                                              | Size | Parallel?                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------- |
| 3.1 | PayPal processor: Orders v2 create (`intent=CAPTURE`, `PayPal-Request-Id`), approval-link surface, webhook verify via signature postback, capture-status API pull | L    | fully parallel with Phase 2 (verifier-side) |
| 3.2 | Sandbox seller credentials path (staging-only, clearly marked)                                                                                                    | S    | with 3.1                                    |
| 3.3 | Client: PayPal option in chooser + copy                                                                                                                           | S    | after 2.1, 3.1                              |
| 3.4 | Fiat live test variant for PayPal sandbox                                                                                                                         | M    | after 3.1                                   |

## Phase 4 — Seller onboarding (seller-owned accounts)

| #   | Task                                                                                                                                                        | Size | Parallel?             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------- |
| 4.1 | Stripe Connect Standard onboarding flow in verifier (hosted onboarding, return handling) + seller settings UI in mp-ux mirroring the Paykit connect pattern | L    | parallel with Phase 3 |
| 4.2 | Direct-charge switch: sessions created on connected account; negative-balance liability assignment                                                          | M    | after 4.1             |
| 4.3 | "Seller has not enabled card payments" failure surfacing (invoice failure → buyer copy)                                                                     | S    | after 4.1             |
| 4.4 | PayPal Commerce Platform onboarding (sandbox); start the live-approval business process with PayPal early — it gates Phase 6 for PayPal                     | L    | after 3.1             |

## Phase 5 — Chargebacks and reversal handling

| #   | Task                                                                                                                                                                 | Size | Parallel?                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------- |
| 5.1 | Reversal ingestion (Stripe chargeback/refund events, PayPal chargeback/reversal events) + reversal state on correlations; suppress promotion inside settlement delay | M    | parallel with Phase 4        |
| 5.2 | Operator reporting endpoint + runbook: reversal on completed correlation → manual `refund.record_external` with processor reference as evidence                      | M    | after 5.1                    |
| 5.3 | Automated bridge (decision needed: signing identity for `refund.record_external` commands)                                                                           | M    | after 5.2, optional for demo |
| 5.4 | Chargeback drill on staging: Stripe test-card chargeback + PayPal sandbox reversal → verify delay suppression and reversal handling end-to-end                       | M    | after 5.2                    |
| 5.5 | Seller-facing chargeback disclosure copy (onboarding + docs)                                                                                                         | S    | with 5.2                     |

## Phase 6 — Live-mode gating (after security review)

| #   | Task                                                                                                                                       | Size         | Parallel? |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | --------- |
| 6.1 | `FIAT_LIVE_MODE` gate, live-key handling, webhook endpoint hardening review                                                                | M            | —         |
| 6.2 | Security review of the verifier (signing, webhook auth, idempotency, secret storage) — **blocker for live keys, not for anything earlier** | — (external) | —         |
| 6.3 | Settlement-delay production defaults + seller-facing configuration bounds                                                                  | S            | after 6.2 |
| 6.4 | Stripe live enablement; PayPal live pending platform approval (4.4)                                                                        | S            | after 6.2 |

## Critical path and parallel tracks

```
0 → 1.1 → 1.2 → ┬ 1.3 (BTC proxy) ──┐
                └ 1.4 (Stripe) → 1.5/1.6 ┴→ 1.9 → 1.10 → 2.x (client) → demo
Parallel track A (verifier team): 3.x PayPal from end of Phase 1
Parallel track B: 4.1 Stripe Connect from end of Phase 1
Parallel track C: 5.x chargebacks from end of Phase 1 (5.4 needs 2.x for full drill)
Business-process long pole: 4.4 PayPal platform approval (start earliest)
Security review (6.2): gates live keys only — the entire staging demo is test-mode.
```

Rough totals: Phase 1 ≈ 3–4 engineer-weeks; Phases 2–5 ≈ 5–6 engineer-weeks across
parallel tracks; Phase 6 mostly external.

## Upstream proposals (documents on this branch, never sent without approval)

1. `upstream-proposals/locks-fiat-verifier.md` — generic `external-payment` verifier
   type for Locks. Removes the `paykit-payment` wire misnomer (design §2) and the
   synthesized-confirmations shim (design §3.4). Not a dependency for any phase above.
2. Optional note in the same doc: Paykit Server multi-asset criterion support — only
   relevant if upstream prefers extending Paykit Server over a generic verifier type.
