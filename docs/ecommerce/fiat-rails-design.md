# Fiat Rails for the Marketplace: Stripe and PayPal through Locks

**Status:** Implemented and live-proven on staging (Stripe test-mode + PayPal sandbox, 2026-08-22).
**Scope:** Add card (Stripe) and PayPal payment support to the marketplace's Locks-based
payment architecture, beside the existing Bitcoin/Paykit rail.
**Strategic goal:** Demonstrate that Locks is a payment-agnostic entitlement layer:
Paykit, Locks, and Pubky bridge _any_ settlement system, not just blockchains. A fiat
rail plugging into the same verifier contract, the same lifecycle, and the same
marketplace verification loop is the proof.

All source citations are against pinned revisions:

| Repo                 | Location                             | Revision                                |
| -------------------- | ------------------------------------ | --------------------------------------- |
| Locks (lock-server)  | `payments-env/sources/locks`         | `ba49a77`                               |
| Paykit Server        | `payments-env/sources/paykit-server` | `f38c791`                               |
| payments-env overlay | `payments-env` (overlay/)            | working tree                            |
| marketplace-service  | `~/work/marketplace-service`         | `b1c03d2`                               |
| mp-ux (this repo)    | branch base                          | `23058c65` (origin/marketplace/pr25-ux) |

---

## 1. Research findings: the verifier contract

These are the load-bearing facts. Everything in the design follows from them.

### 1.1 `verifier_type` is a closed enum, enforced at the serde boundary

`VerifierType` has exactly two variants and rejects everything else during
deserialization — of content locks, of submitted proof bundles, and of verified proof
bundles:

- `locks-core/src/lock_policy.rs:306-323` — `enum VerifierType { DevStatic, PaykitPayment }`,
  wire values `"dev-static"` / `"paykit-payment"` (kebab-case serde).
- `locks-core/src/lock_policy.rs:835-842` — test `content_lock_rejects_unknown_verifier_type`
  proves an unknown string fails deserialization of the whole lock.
- `locks-core/src/verification.rs:161-169` and `:252-260` — the same rejection applies to
  submitted and verified proof bundles.

**Consequence:** a new wire value like `"stripe-payment"` is an upstream code change, not
a configuration change. There is no plugin or config extension point for verifier types.

### 1.2 The verifier registry is static and hardcoded per type

`locks-service/src/infrastructure/verifiers/registry.rs:6-41` —
`StaticCriterionVerifierRegistry` has one struct field per verifier type
(`dev_static`, `paykit_payment`) and a `match` in `verifier_for()`. Adding a verifier
type means a new enum variant, a new registry field, and new wiring in the server. The
adapter boundary itself is a clean trait
(`CriterionVerifier::verify(CriterionVerificationRequest) -> CriterionVerificationResult`,
`locks-service/src/application/ports/verification.rs:108-116`), so upstream extension is
mechanical — but it is upstream.

### 1.3 The criterion schema can already express fiat amounts

`validate_paykit_payment_params` (`locks-core/src/lock_policy.rs:380-426`) requires
exactly three fields:

- `recipient_pubky` — valid pubky, must equal the lock creator
  (`validate_paykit_payment_v1_policy`, `lock_policy.rs:146-188`);
- `amount` — a **positive decimal integer string** ("50000"); no unit semantics;
- `asset` — **any non-empty string**. `"BTC"` is convention, not constraint.

So `{ "recipient_pubky": ..., "amount": "1999", "asset": "USD" }` (19.99 USD in minor
units) is a valid `paykit-payment` criterion **today**, accepted by the Lock Server with
zero changes. The v1 policy additionally requires the payment criterion to be the lock's
_only_ criterion with lock logic referencing exactly it (`lock_policy.rs:157-186`) — fine
for a single-price marketplace listing.

The BTC restriction lives one hop away, in Paykit Server, not in Locks:
`paykit-server/src/domain/invoice.rs:59-83` — `CriterionAsset::parse` accepts the exact
string `"BTC"` and nothing else. This is the precise seam where fiat plugs in.

### 1.4 The Lock Server ↔ payment verifier trust wiring

The Lock Server talks to _one_ payment backend over a small signed HTTP contract:

- **Config:** `[paykit] server_url, minimum_confirmations`
  (`locks-server/src/config/schema.rs:27,31-33`) — a single optional section; one payment
  backend per Lock Server deployment.
- **Outbound calls** (`locks-server/src/paykit_http_client.rs`):
  - `POST {server_url}/invoices` with `{bundle_id, lock_resource, reader}` (`:109-123`)
    — called synchronously during proof-bundle submission
    (`locks-server/src/api/verification.rs:83-147`); a `409` maps to task conflict, other
    failures fail the submission.
  - `POST {server_url}/transactions/status` with `{creator, bundle_id}` (`:125-142`) —
    polled by the verification worker.
- **Authentication:** every request body is canonical JSON (RFC 8785/JCS), signed with
  the Lock Server's ed25519 keypair; the signature travels in `X-Paykit-Signature`
  (base64url-no-pad) (`paykit_http_client.rs:160-174, 227-233`).
- **The verifier side:** Paykit Server verifies that signature against a single
  configured `[locks] trusted_public_key`
  (`paykit-server/src/http/auth.rs:46-52`, `paykit-server/src/config.rs:36-37, 293-296`).
- **The overlay that wires them:** `payments-env/overlay/locks-server-entrypoint-paykit.sh`
  extracts the generated `lock_server_public_key` and writes it into the Paykit Server
  config as `trusted_public_key` (`:56-58, 127-133`), and writes the Lock Server's
  `[paykit] server_url` (`:110-112`). Trust is exactly: _one pinned ed25519 key, each way
  implicit_ — the Lock Server trusts whatever the configured URL answers, and the
  verifier trusts whoever holds the Lock Server key.

### 1.5 The lifecycle state contract for a payment verifier

Two layered state machines:

**Task lifecycle (Lock Server–owned, what the marketplace sees):**
`pending → in_progress → completed | failed | expired`
(`locks-service/src/application/models/verification.rs:11-22`). Tasks are created on
proof-bundle submission, claimed by a worker with leases, and retried.

**Payment status (verifier-owned, what moves the task):** the status endpoint returns
`{status: "undetected" | "detected" | "confirmed", confirmations: u32, amount_matched: bool}`
(`paykit_http_client.rs:66-79`). The `PaykitPaymentVerifier` maps this onto the task:

- `payment_status_satisfies` (`locks-service/src/infrastructure/verifiers/paykit_payment.rs:93-102`):
  satisfied iff `amount_matched == true` AND (`minimum_confirmations == 0` and status is
  detected-or-confirmed, or status is `confirmed` with `confirmations >= minimum_confirmations`).
- Anything not satisfied — including transport errors and 404s — returns
  `ApplicationError::VerificationPending` (`paykit_payment.rs:75-82`), which schedules a
  worker retry ~30s later (`locks-server/src/worker.rs:141-166, 217`, `retry_delay()` is
  30 seconds). The task simply stays `pending`/`in_progress` until satisfied or expired.

**The state contract for a NON-paykit verifier is therefore:** answer the status
endpoint truthfully; the task completes when you report a state satisfying the
confirmation rule; there is no failure webhook — you _withhold_ satisfaction and the
task expires on the Lock Server's schedule. A fiat verifier that speaks this same HTTP
shape inherits the entire lifecycle, worker, retry, and entitlement machinery unchanged.

### 1.6 The marketplace service is rail-agnostic (confirmed)

`marketplace-service/crates/service/src/locks.rs` is explicit: _"Verification is a pure
function of what Locks reports: nothing in this module accepts a client-supplied
status"_ (`:20-21`). The only upstream call is `POST /verification-task-lookups` with
`{creator, bundle_id}` (`:224-230`); the only inputs are the five lifecycle statuses
(`:143-164`). The worker maps them: `Completed → confirm`, `Failed`/`Expired → fail`,
completion after the marketplace payment window → `manual_review`
(`workers.rs:538, 571-581`). Payment-window expiry is a marketplace-time transition
(`workers.rs:603-654`, `LOCKS_PAYMENT_WINDOW_SECONDS`, default 3600 —
`config.rs:60-62`). Bundle ids are sealed at rest and HMAC-tokenized for lookup
(`locks.rs:80-133`). **Nothing in the service knows or cares what rail satisfied the
lock.** Zero marketplace-service changes are required for fiat.

### 1.7 The client flow and what changes for a fiat instruction

The buyer flow (`src/core/application/commerce/commerce.ts:319-403`,
`src/hooks/useMarketplaceLocksPayment/useMarketplaceLocksPayment.ts`):

1. Generate a canonical bundle id via the vendored SDK (`locks.ts:116-123`).
2. `POST /proof-bundles` with one proof `{verifier_type: "paykit-payment", payload: {}}`
   and `reader_public_key` (`locks.ts:125-161`). Submission triggers the Lock Server's
   invoice call to the payment backend (`api/verification.rs:83-147`).
3. Persist the correlation locally, then register with the marketplace via
   `payment.register_locks` (`commerce.ts:353-401`).
4. Poll the marketplace projection; **the client never advances the payment**
   (`useMarketplaceLocksPayment.ts:87-111`).
5. On confirmation, redeem an access credential and unlock content (`locks.ts:171-211`).

For the Bitcoin rail the payment _instruction_ reaches the buyer out-of-band: Paykit
Server publishes a private Payment Request Proposal (terms: amount, asset,
payment_reference, expiry) to the buyer's wallet through Paykit delivery paths
(`paykit-server/src/application/semantic_intent.rs:126-149`,
`create_invoice.rs:446-476`). The status card says "check your wallet"
(`MarketplacePaymentStatusCard.tsx:206-219`).

**For a fiat rail, only step "how the buyer receives the payment instruction" changes:**
instead of a wallet-delivered Paykit request, the buyer needs a Stripe Checkout URL or a
PayPal approval URL. Steps 1–5 — bundle id, proof bundle, registration, polling,
unlock — are untouched. That is the payment-agnostic claim, demonstrated.

### 1.8 Currency: how prices work today, and the honest gap

- Listing records carry structured money: `{amountMinor, currency, exponent}`
  (`marketplace-records.ts:510-515` and throughout). The listing form hardcodes
  `{currency: 'USD', exponent: 2}` (`useCreateMarketplaceListing.ts:151-152, 209, 239`).
- The **live regtest Bitcoin flow did NOT convert USD → bitcoin.** The live test priced its
  listing directly in BTC — `unitPrice: {amountMinor: 15_000, currency: 'BTC', exponent: 8}` —
  matching a lock criterion of `{amount: "15000", asset: "BTC"}`
  (`src/test/live/locks-payment.live.ts`). There is no conversion code anywhere in the
  client, the marketplace service, or the verifier chain.
- The app never authors content locks: the listing studio explicitly _cannot_ create a
  `digitalLock` (`useEditMarketplaceListing.ts:44`); locks are created by external
  tooling/the live test harness against the Lock Server's creator-publishing API.

**Gap statement:** a USD-priced listing currently has no defined Bitcoin payment amount.
The lock criterion's amount is fixed at lock creation, in the criterion's own asset.
Fiat rails actually fit the existing listing pricing _better_ than Bitcoin does: a USD
listing maps 1:1 to `{amount: "<cents>", asset: "USD"}` with no exchange-rate problem.
For the Bitcoin rail, converting fiat-priced listings needs a rate-at-lock-creation or
rate-at-invoice decision — out of scope here, but recorded in §9 as a known gap.

---

## 2. Verifier topology decision

### Options considered

**A. A "fiat verifier" service speaking the existing Paykit wire contract (chosen).**
Deploy one new service — working name `fiat-verifier` — that implements exactly the two
endpoints the Lock Server already calls (`POST /invoices`,
`POST /transactions/status`), authenticated the same way (ed25519 over canonical JSON,
`X-Paykit-Signature`, one trusted Lock Server key). Internally it has pluggable
processors (Stripe, PayPal). Requires **zero upstream changes** to Locks, Paykit Server,
or marketplace-service.

**B. Extend paykit-server with fiat processors.** Same wire contract by construction,
but it means forking/patching upstream `paykit-server` (the `CriterionAsset` BTC pin at
`domain/invoice.rs:63-68` plus everything downstream of it assumes bitcoin base units and Electrum).
Paykit Server's internals — Electrum watchers, receiver paths, delivery via Paykit
directories — are Bitcoin-shaped; fiat would be a parallel code path grafted into a
codebase we do not own. Rejected: higher coupling, upstream PR required, no benefit over A.

**C. Upstream Locks changes: new `VerifierType` variant(s) + registry entries.** The
architecturally honest end-state (a `"stripe-payment"` criterion should say so on the
wire), but it requires changes to `locks-core`, `locks-service`, and `locks-server`
(§1.1–1.2), a new config section, and a release of a repo we do not control. Rejected
_as the dependency for shipping_; written up as a ready-to-send proposal instead
(`docs/ecommerce/upstream-proposals/locks-fiat-verifier.md`).

### Why A works with zero upstream changes

1. The Lock Server accepts `asset: "USD"` criteria today (§1.3).
2. The Lock Server trusts whatever service its `[paykit] server_url` names (§1.4). Our
   deployments (staging on Railway beside marketplace-service and the composed rails)
   configure that URL; pointing it at `fiat-verifier` is an operator decision, not a code
   change.
3. The status contract is three states + confirmations + amount*matched (§1.5). Fiat
   maps cleanly: \_undetected* = no completed checkout; _detected_ = processor reports
   paid, settlement delay running; _confirmed_ = paid AND the anti-chargeback delay
   elapsed (`confirmations` synthesized as `minimum_confirmations` so the existing
   satisfaction rule passes; see §5).
4. Because a Lock Server has exactly ONE payment backend URL, `fiat-verifier` is
   designed as a **payment verifier gateway**: on `/invoices` it fetches the public
   content lock named by `lock_resource` (exactly as Paykit Server does), reads the
   criterion's `asset`, and dispatches — `BTC` → proxy the signed call to the real
   Paykit Server; `USD`/`EUR`/… → the Stripe or PayPal processor. One URL, all rails.
   BTC proxying is pass-through (it re-signs with the gateway's key only if the Paykit
   Server is configured to trust the gateway; the simpler staging arrangement is to
   configure Paykit Server's `trusted_public_key` to the Lock Server key and have the
   gateway forward the original body + signature verbatim, which the contract permits
   because the signature covers only the canonical body).

### Honest limitation of A (and why it's acceptable)

On the wire, a Stripe-settled entitlement still says `verifier_type: "paykit-payment"`.
That is a semantic misnomer: the verified proof bundle records evidence produced by our
fiat verifier under a label that names a different system. It is _not_ a security
problem — the label was never a trust statement; trust is the Lock Server's signing key
and its operator-configured backend URL — but it is a documentation/clarity debt. The
remedy is the upstream proposal (option C) which introduces a generic
`external-payment` verifier type; when accepted, `fiat-verifier` migrates by changing
one string and the lock-creation tooling. Until then, the design docs and the UI copy
carry the truth (the UI already never renders `verifier_type`).

---

## 3. The fiat-verifier service

A small Rust service (same stack as the rails it sits beside), deployable to Railway
next to marketplace-service, the Lock Server, and Paykit Server.

### 3.1 Wire surface (Lock Server–facing, existing contract)

| Endpoint                                              | Auth                                                            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /invoices` `{bundle_id, lock_resource, reader}` | `X-Paykit-Signature` verified against pinned Lock Server pubkey | Fetch + validate the content lock from the creator's homeserver; read criterion `{asset, amount, recipient_pubky}`; dispatch by asset: `BTC` → forward to Paykit Server; fiat → create a processor payment intent for `{amount, currency}` with `creator‖bundle_id` as the idempotent external reference; persist the correlation row. `409` on duplicate (mirrors upstream conflict semantics, `api/verification.rs:149-158`). |
| `POST /transactions/status` `{creator, bundle_id}`    | same                                                            | `BTC` → forward. Fiat → answer from local state, which is _only_ advanced by webhook-then-API-pull verification (§3.3). Unknown handle → 404 (stays `VerificationPending` upstream, `paykit_http_client.rs:447-470` test shows 404 is retryable).                                                                                                                                                                               |

### 3.2 Buyer-facing surface (new, minimal)

The Bitcoin rail delivers payment instructions privately to a wallet. Fiat has no
wallet; the buyer needs a checkout URL. One new endpoint:

| Endpoint                                         | Auth                                                                                                                                                             | Behavior                                                                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /checkout-sessions` `{creator, bundle_id}` | none beyond possession of the bundle id (the bundle id is already treated as bearer material everywhere — marketplace-service seals it at rest, `locks.rs:1-21`) | Returns `{checkout_url, processor, expires_at}` for a fiat correlation created by `/invoices`. Idempotent: repeated calls return the same live session, or mint a replacement if the processor session expired. |

The client calls this after `beginMarketplaceLocksPayment` succeeds and opens the URL.
Rate-limited and unlinkable: the response contains no buyer identity; the buyer's
identity exposure is to the _processor_ (unavoidable, disclosed — §4).

### 3.3 Processor contract (what Stripe and PayPal must each provide)

Each processor plugin implements:

1. **`create_payment(amount_minor, currency, reference) → {processor_ref, checkout_url, expires_at}`**
   - Stripe: `POST /v1/checkout/sessions` (mode=payment, `client_reference_id` =
     `creator‖bundle_id`, Stripe `Idempotency-Key` = derived from the reference). The
     session `url` is the checkout URL. ([Stripe Checkout Sessions API][stripe-sessions])
   - PayPal: `POST /v2/checkout/orders` with `intent=CAPTURE`, `custom_id`/
     `invoice_id` = reference, `PayPal-Request-Id` header for idempotency. The
     `payer-action` link is the approval URL. Recommended
     `processing_instruction=ORDER_COMPLETE_ON_PAYMENT_APPROVAL` so PayPal auto-captures
     on approval. ([PayPal Orders v2][paypal-orders], [PayPal lifecycle][paypal-lifecycle])
2. **Webhook ingestion — a hint, never a fact.**
   - Stripe: verify the `stripe-signature` header (constructed-event verification with
     the endpoint secret over the raw body); handle `checkout.session.completed` and
     `checkout.session.async_payment_succeeded`; dedupe by `event.id` with a unique
     constraint. ([Stripe fulfillment][stripe-fulfillment])
   - PayPal: verify via the postback endpoint
     `POST /v1/notifications/verify-webhook-signature` (transmission id/time/sig +
     cert URL + webhook id + exact raw body); handle `PAYMENT.CAPTURE.COMPLETED`,
     `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.PENDING`. ([PayPal webhooks][paypal-webhooks])
3. **`verify_payment(processor_ref) → Paid{amount_minor, currency} | Unpaid | Reversed` — the API pull.**
   The webhook only _schedules_ this pull; state transitions happen exclusively on
   what the processor's read API says:
   - Stripe: `GET /v1/checkout/sessions/:id`, require `payment_status == "paid"` and
     `amount_total`/`currency` matching the criterion. `status: complete` alone is not
     payment ([session object][stripe-session-object]).
   - PayPal: `GET /v2/checkout/orders/:id`, require order `status == "COMPLETED"` and
     the capture object's `status == "COMPLETED"` with matching amount
     ([PayPal lifecycle][paypal-lifecycle]).
     The pull also runs on a slow poll (e.g. every 60s while a correlation is open) so a
     lost webhook delays but never loses a payment — matching the Lock Server's own
     retry-forever-until-expiry posture (§1.5).
4. **Reversal ingestion.** Stripe: `charge.dispute.created` / `charge.dispute.closed`,
   `charge.refunded` ([Stripe events][stripe-events]). PayPal:
   `CUSTOMER.DISPUTE.CREATED`, `PAYMENT.CAPTURE.REVERSED`, `PAYMENT.CAPTURE.REFUNDED`
   ([PayPal event names][paypal-events]). Same rule: webhook schedules an API pull;
   the pulled chargeback/refund object is the fact. Consequences in §5.

`amount_matched` is computed by the verifier: pulled paid amount and currency must
equal the criterion's `amount`/`asset` exactly. Underpayment/overpayment cannot happen
in hosted checkout (the verifier sets the amount), but the check stays — it is the same
defensive posture the Bitcoin rail has, and it catches processor/config drift.

### 3.4 State mapping (the fiat "confirmations" semantics)

| Verifier-internal state                     | Reported to Lock Server                                                 | Trigger                                           |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| created (no completed checkout)             | `undetected, confirmations: 0, amount_matched: false`                   | initial                                           |
| paid, inside settlement delay               | `detected, confirmations: 0, amount_matched: true`                      | API pull confirms paid                            |
| paid, settlement delay elapsed, no reversal | `confirmed, confirmations: minimum_confirmations, amount_matched: true` | delay timer + fresh API re-pull at promotion time |
| reversed before completion                  | `undetected` again (or simply never promoted)                           | reversal pull                                     |

The settlement delay is the fiat analogue of block confirmations and the primary
chargeback mitigation (§5). `confirmations` is synthesized to exactly satisfy
`payment_status_satisfies` (§1.5) — honest in mechanism (the delay really elapsed),
synthetic in unit. The upstream proposal (§2 option C) includes making the
confirmation rule verifier-specific so this shim can retire.

Deliberate consequence of the Lock Server contract: there is **no way to fail a task
early** from the verifier side (§1.5). A buyer who abandons checkout leaves the task
`pending` until the marketplace payment window (1h) and Lock Server task expiry lapse.
That is exactly what the Bitcoin rail does with an unpaid invoice; the existing UI
copy for expiry already covers it (`MarketplacePaymentStatusCard.tsx:119-124`).

---

## 4. Trust model, stated bluntly

The fiat verifier is **our service** and its operator is trusted in ways the Bitcoin
rail's operator is not. The same is true of Stripe and PayPal themselves. This table is
the disclosure; a condensed version belongs in user-facing docs and the payment sheet.

| Property                                         | Bitcoin via Paykit                                                                                                                        | Card via Stripe                                                                            | PayPal                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Who attests payment                              | Paykit Server operator reading its own Electrum view of the Bitcoin chain                                                                 | fiat-verifier operator reading Stripe's API                                                | fiat-verifier operator reading PayPal's API                            |
| Can the attestor lie about payment status?       | Yes (operator could fake status) — but anyone can independently verify on-chain                                                           | Yes — and only Stripe + the seller's dashboard can contradict it                           | Yes — and only PayPal + the seller's dashboard can contradict it       |
| Can payment be reversed after Locks `completed`? | No (after N confirmations, reorg risk is negligible)                                                                                      | **Yes** — chargebacks up to ~120 days                                                      | **Yes** — chargebacks up to 180 days                                   |
| Who eats a reversal                              | n/a                                                                                                                                       | The seller (seller-owned account, §6) + chargeback fee                                     | The seller + chargeback fee                                            |
| Who sees the buyer                               | Paykit Server operator sees reader pubky ↔ invoice; chain sees amounts                                                                    | Stripe sees card identity, name, often address; fiat-verifier sees pubky ↔ session linkage | PayPal sees account identity; fiat-verifier sees pubky ↔ order linkage |
| Buyer identity required                          | Pubky only                                                                                                                                | Card (real-world identity)                                                                 | PayPal account (real-world identity)                                   |
| Censorship surface                               | Operator can refuse invoices; buyer/seller can move to another Paykit deployment                                                          | Stripe can freeze/close the seller account; card networks can block categories             | PayPal can freeze/close; famously discretionary                        |
| Settlement finality signal                       | Block confirmations (objective, public)                                                                                                   | Settlement-delay timer we impose (policy, not physics)                                     | Same                                                                   |
| What Locks itself trusts                         | Identical in every case: the Lock Server operator and its configured verifier backend (§1.4). Locks is rail-agnostic; the _rails_ differ. |

Plain statements the docs and UI must not soften:

- **The fiat verifier operator can see who paid for what** (pubky ↔ processor session)
  **and could falsely report payment status in either direction.** Mitigation is
  operational (logging, the seller's own processor dashboard as a cross-check), not
  cryptographic. This is the same trust class as the Paykit Server operator, with a
  larger identity exposure because the processor knows the buyer's legal identity.
- **Stripe/PayPal can reverse a payment after the entitlement is granted and the
  content delivered.** Locks has no un-complete transition; the reversal lands in the
  marketplace's refund evidence flow, not in Locks (§5).
- **Fiat rails identify the buyer to the processor.** A privacy-conscious buyer should
  use the Bitcoin rail; the payment-method chooser says so (§7).

## 5. Chargebacks, refunds, and the Locks lifecycle

The Locks task lifecycle is monotonic: once `completed`, there is no reversal
transition (§1.5, `verification.rs:11-22`), and the entitlement (verified proof
bundle) is already written. Fighting that would be dishonest engineering. Instead:

1. **Before completion — settlement delay.** The verifier holds fiat payments in
   `detected` for a configurable delay (staging default: 5 minutes for demos; live
   recommendation: hours-to-days for high-value digital goods, seller-configurable
   within operator bounds). Reversals inside the window mean the task simply never
   completes and expires normally. This mirrors `minimum_confirmations` for Bitcoin —
   same knob, same UI state ("Awaiting payment"), honest analogue.
2. **After completion — marketplace reversal handling.** The marketplace keeps reversal handling outside Locks via
   `refund.record_external`
   (`marketplace-service/crates/domain/src/commands.rs:108-110, 659-663`) and a
   `manual_review` payment state for out-of-band verified events
   (`state_machines.rs:368-420`). When the verifier's reversal ingestion (§3.3.4) fires
   for an already-completed correlation, the verifier records the reversal and exposes
   it on an operator/reporting endpoint; the marketplace operator (phase 1) or an
   automated bridge (phase 2, see plan) records `refund.record_external` on the affected order with
   the processor chargeback reference as evidence. The peer refund evidence flow already
   assumes refunds are external.
   The design leans into that: the chargeback IS the external refund, already executed.
3. **The seller carries chargeback risk, and the UI says so.** With seller-owned
   processor accounts (§6) the reversal debits the seller directly — the marketplace
   never holds funds (which the existing manual-review copy already states:
   `MarketplacePaymentStatusCard.tsx:126-129`). Seller-facing onboarding copy must
   state: _"Card and PayPal payments can be reversed by the buyer's bank for ~120–180
   days. The marketplace grants the buyer access when the payment verifies; a later
   chargeback does not automatically revoke access. Price this risk or use the Bitcoin
   rail for irreversibility."_
4. **Refunds initiated by the seller** (goodwill/return policy) go through the seller's
   own processor dashboard; the verifier observes them (`charge.refunded` /
   `PAYMENT.CAPTURE.REFUNDED`) and records them against the correlation for the reversal
   trail. No Locks interaction — the entitlement intentionally survives a voluntary
   refund.

## 6. Seller onboarding

The decentralization-honest answer is **seller-owned processor accounts**: the
marketplace and the verifier operator never custody funds, matching the Bitcoin rail
(where payment goes straight to the seller's wallet) and the existing UI promise ("No
funds are held by this marketplace").

### Stripe: Connect **Standard accounts + direct charges** (recommended)

- Seller connects an existing or new Stripe account through Stripe-hosted Connect
  onboarding; the platform (fiat-verifier operator) holds only the account id and
  creates Checkout Sessions _on the connected account_ (direct charges).
- Liability lands where it should: **the connected account (seller) is the merchant of
  record and bears Stripe fees, refunds, and chargebacks**; negative-balance liability
  is assignable to Stripe. ([Stripe integration recommendations][stripe-connect-recs],
  [risk management][stripe-connect-risk])
- Effort: **M**. One OAuth-style onboarding flow in the seller settings (mirrors the
  existing Paykit legacy-connect pattern — hosted flow, `return_to` + one-time code,
  `LocksGatewayService.createFrontendSession`, `locks.ts:220-250`), plus storing
  `stripe_account_id` against the seller's pubky in the verifier.
- Alternative rejected: **destination charges / platform-collects**. The platform
  becomes merchant of record and eats every chargeback and refund
  ([destination charges][stripe-destination]); it centralizes funds custody in exactly
  the way this architecture exists to avoid. Lower seller friction (no Stripe account
  needed) is not worth inverting the trust story. Effort would be S–M but with an
  ongoing liability tail.

### PayPal: **Commerce Platform (multiparty) with seller-owned accounts** (recommended)

- PayPal's marketplace product: sellers grant the platform permission to create orders
  on their behalf; funds settle to the seller's PayPal account. Onboarding is
  PayPal-hosted ("connect your PayPal account"), same UX shape as Stripe Connect.
- Effort: **M–L** (PayPal multiparty requires a platform application review even for
  sandbox-to-live promotion; sandbox works immediately). Fallback for staging demos:
  the demo seller's sandbox credentials configured directly in the verifier
  (operator-held, staging only, clearly marked — this is _not_ the production shape).
- Same rejection of platform-collects, same reason.

Both onboarding states live in the verifier's seller registry keyed by pubky:
`{pubky → {stripe_account_id?, paypal_merchant_id?}}`. A lock criterion with
`asset: "USD"` is payable iff its `recipient_pubky` has at least one connected
processor. The `/invoices` call fails (non-409 error → submission fails upstream,
§1.4) when the seller has no processor — surfaced to the buyer as "this seller has not
enabled card payments."

## 7. Buyer UX

### Payment method choice

Today the status card offers exactly one action ("Request payment in your wallet",
`MarketplacePaymentStatusCard.tsx:180-187`). With fiat rails the awaiting-payment state
becomes a method chooser, driven by what the listing's lock supports and what the
seller has connected:

- **Pay with Bitcoin (your wallet)** — existing flow, unchanged. Copy unchanged: "Paykit
  delivers the Bitcoin payment request privately to your wallet…"
- **Pay with card (Stripe)** — creates the same proof bundle + registration, then calls
  `/checkout-sessions` and opens Stripe Checkout. Copy: _"Card checkout is processed by
  Stripe on the seller's own Stripe account. Stripe learns your card identity; this app
  never sees your card. The marketplace verifies the payment through Locks, exactly as
  it does for Bitcoin. Card payments can be reversed by your bank; sellers may delay
  delivery of high-value items until the settlement window passes."_
- **Pay with PayPal** — same shape, PayPal approval link.

Because the lock criterion carries one `{asset, amount}`, **which rails a listing
accepts is set at lock creation**: a `USD` lock is payable by Stripe/PayPal; a `BTC`
lock by wallet. Dual-rail listings (buyer picks BTC _or_ USD at checkout) require
either two locks per listing or upstream `Any`-logic pricing criteria — recorded as a
phase-2+ item in the plan, not fudged now. For the demo, fiat listings and Bitcoin
listings coexist in one marketplace, which already proves the thesis.

### Status card per rail

The truthful-status vocabulary (awaiting / confirmed / expired / manual_review,
`MarketplacePaymentStatusCard.tsx:23-28`) is rail-agnostic and survives unchanged. Rail-
specific adaptations, all in the awaiting state:

- Bitcoin: "Check your wallet for the private Paykit request…" (existing).
- Fiat, checkout not opened: "Complete checkout with Stripe/PayPal" + reopen-checkout
  button (sessions expire; the endpoint re-mints, §3.2).
- Fiat, returned from checkout: "Payment received by the processor. The marketplace
  independently verifies it through Locks — this page updates when verification
  completes." (Never claim paid from the redirect; the redirect is buyer-attested, the
  projection poll is the only truth — same rule the hook already enforces,
  `useMarketplaceLocksPayment.ts:36-37`.)
- The `Locks/Paykit` badge becomes rail-labeled: `Locks · Bitcoin`, `Locks · Stripe`,
  `Locks · PayPal` — same entitlement layer, honestly labeled rails.

## 8. Test-mode-first rollout

Stripe test mode and PayPal sandbox make the entire fiat path demoable with zero real
funds and no live-credential security exposure:

- Stripe test mode: full Checkout + webhooks + chargeback simulation with test cards
  (including chargeback-triggering test cards), `livemode: false` on every object.
- PayPal sandbox: full Orders v2 + webhooks + a chargeback-testing harness
  ([PayPal chargeback webhook testing][paypal-dispute-test]).
- The verifier refuses to start with live credentials unless an explicit
  `FIAT_LIVE_MODE=true` flag is set; live mode is gated behind the security review.
  Staging = test keys only, forever.

This gives the phase structure in `fiat-rails-plan.md`: everything through a full
staging demo (fiat listing → Stripe test checkout → Locks completion → unlock →
simulated chargeback → reversal handling) ships without touching real money.

## 9. Known gaps and non-goals (recorded, not hidden)

1. **`verifier_type` misnomer on the wire** for fiat-settled entitlements (§2) — fixed
   by the upstream proposal when accepted.
2. **USD-priced listings have no Bitcoin conversion** (§1.8) — a Bitcoin-rail gap that
   predates this design; fiat rails don't inherit it.
3. **No dual-rail single listing** in v1 (§7).
4. **Chargeback → reversal handling is operator-manual in phase 1** (§5.2); automation is
   a planned phase, needs a small marketplace-service-adjacent bridge worker (we own
   the verifier; the bridge submits `refund.record_external` as an authorized party — needs a
   decision on who signs those commands).
5. **PayPal multiparty live approval** is a business process with PayPal, not
   engineering; the plan treats PayPal live as strictly after Stripe live.
6. **Fiat verifier availability**: if it is down, `/invoices` fails and buyers can't
   _start_ fiat payments (same failure mode as Paykit Server being down for Bitcoin —
   the submission fails closed, `api/verification.rs:132-146`).

## References

[stripe-sessions]: https://docs.stripe.com/api/checkout/sessions
[stripe-session-object]: https://docs.stripe.com/api/checkout/sessions/object
[stripe-fulfillment]: https://docs.stripe.com/checkout/fulfillment
[stripe-events]: https://docs.stripe.com/api/events/types
[stripe-connect-recs]: https://docs.stripe.com/connect/integration-recommendations
[stripe-connect-risk]: https://docs.stripe.com/connect/risk-management
[stripe-destination]: https://docs.stripe.com/connect/destination-charges
[paypal-orders]: https://developer.paypal.com/api/rest/integration/orders-api/
[paypal-lifecycle]: https://developer.paypal.com/beta/apm-beta/additional-information/lifecycle/
[paypal-webhooks]: https://developer.paypal.com/api/rest/webhooks
[paypal-events]: https://developer.paypal.com/api/rest/webhooks/event-names/
[paypal-dispute-test]: https://developer.paypal.com/docs/multiparty/disputes-chargebacks/webhooks/

- Stripe: Checkout Sessions API, fulfillment guide (verify `payment_status == paid` via
  retrieve, never the redirect), event types (chargebacks/refunds), Connect
  integration/risk docs (Standard + direct charges liability). Accessed 2026-08.
- PayPal: Orders v2 API + lifecycle (capture status COMPLETED before fulfillment),
  webhooks overview (verify-webhook-signature postback), webhook event names
  (PAYMENT.CAPTURE._, CUSTOMER.DISPUTE._), chargeback webhook sandbox testing. Accessed 2026-08.
