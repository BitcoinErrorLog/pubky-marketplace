# Fiat Rails Phase 1: Execution Record

Companion to [`fiat-rails-design.md`](fiat-rails-design.md) (the ratified design) and
[`fiat-rails-plan.md`](fiat-rails-plan.md) (the phased plan). This document records what
Phase 1 actually built, deployed, and proved on staging, with the observed values.
Everything here happened on 2026-08-21 against the deployed staging stack
(Railway project `pubky-marketplace-staging`, identities on the official staging
homeserver `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy`, Bitcoin regtest only,
Stripe test mode only).

## What was built

**[`BitcoinErrorLog/pubky-fiat-verifier`](https://github.com/BitcoinErrorLog/pubky-fiat-verifier)** —
a Rust (axum + Postgres) payment verifier gateway implementing the design's option A
(design §2). It impersonates the Paykit Server wire contract behind the Lock Server's
single `[paykit] server_url`:

- `POST /invoices` and `POST /transactions/status` with `X-Paykit-Signature` ed25519
  verification against the pinned Lock Server public key, canonical-JSON (RFC 8785)
  strict-body semantics mirroring `paykit-server/src/http/auth.rs` exactly (one header,
  base64url-no-pad canonical encoding, signature over raw bytes, canonicalization
  round-trip, unknown fields rejected).
- Asset dispatch on the fetched content lock's criterion: `BTC` → the signed call is
  forwarded **verbatim** (original body + original signature) to the real Paykit Server;
  `USD` → Stripe Checkout Session, idempotently keyed to `creator‖bundle_id‖attempt`.
- Webhook-as-hint, API-pull-as-truth: webhook receipt (signature-verified, deduped by
  event id) only schedules a pull of `GET /v1/checkout/sessions/:id`; state advances
  solely on pulled facts (`payment_status == "paid"` plus exact amount/currency match
  against the criterion). A slow poll (60s) covers lost webhooks, and the Lock Server's
  own ~30s status poll doubles as a pull trigger, so detection works with no webhook at
  all.
- Settlement-delay window (default 300s, config) between `detected` and `confirmed`,
  with a fresh re-pull at promotion time; `confirmations` synthesized to satisfy the
  upstream rule (design §3.4). Verified reversals (refund/chargeback webhooks corroborated
  by a charge pull) block promotion.
- `POST /checkout-sessions` buyer endpoint (design §3.2): the payment instruction
  cannot ride the invoice response (the Lock Server discards that body), so the client
  fetches `{checkout_url, processor, expires_at}` with the `{creator, bundle_id}` pair
  it already holds. Idempotent, re-mints expired sessions, rate-limited. **Client
  integration is Phase 2**; the data flows today (proven with the verification driver's
  new `checkout` subcommand).
- `GET /health`, structured JSON logs, fail-closed fiat path (no Stripe key ⇒ 503
  `fiat_unavailable`; BTC proxying unaffected), `FIAT_LIVE_MODE` gate (a live-looking
  key refuses to boot).

49 unit tests cover signature verification (valid/tampered/duplicate/padded/unknown
fields/non-canonical), dispatch (BTC forwarded byte-identically with the original
signature; USD never touches Paykit), idempotent invoice creation (exact replay → 204,
conflicting binding → 409), webhook-vs-pull disagreement (a lying webhook moves
nothing — the pull wins), delay-window behavior (detected inside, promotion only after
a fresh paid re-pull), amount-mismatch honesty (reported, never promoted), session
re-mint after expiry, reversal suppression, and webhook signature/dedup handling.

## What was deployed

| Item                                         | Value                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Railway service                              | `fiat-verifier` in the existing `pubky-marketplace-staging` project                                   |
| Public domain (Stripe webhooks need one)     | `https://fiat-verifier-production.up.railway.app`                                                     |
| Private endpoint (Lock Server-facing)        | `http://fiat-verifier.railway.internal:3002`                                                          |
| Database                                     | new Railway Postgres in the same project (service `Postgres-sa-c`), referenced as `FIAT_DATABASE_URL` |
| Stripe                                       | **disabled** (no test key available at deploy time) — fail-closed by design                           |
| Settlement delay / synthesized confirmations | 300s / 1 (Lock Server `minimum_confirmations` is 1)                                                   |

**The cutover is done.** The staging Lock Server's `LOCKS_PAYKIT_SERVER_URL` now points
at `http://fiat-verifier.railway.internal:3002` (was `http://paykit-server.railway.internal:3001`).
Rollback is that one env var set back plus a redeploy.

## Proof 1: BTC purchase through the gateway, after cutover

Full live purchase on the deployed rails with the Lock Server talking **only** to the
gateway, run with the `BitcoinErrorLog/pubky-payment-rails` verification driver:

| Step                                                          | Observed value                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pre-cutover proxy parity                                      | Signed status for the morning's direct-path purchase (`7FT83CSKN02AS0J6WB7DZMVYSM`) returned byte-identical `{"status":"confirmed","confirmations":6,"amount_matched":true}` via gateway and via Paykit directly; unsigned/garbage-signed calls 401 at the gateway |
| Creator (staging homeserver, Paykit setup done)               | `pubkyd16moaibedrpri5zitbzuidb7otkuxy6ixcsspj3e7fgudanqmno`                                                                                                                                                                                                        |
| Fresh reader                                                  | `pubkyzoet63gw84j6pj9pkidqweonox5offe4sk5i5nj3ejyycot8dgdy`                                                                                                                                                                                                        |
| Content lock (BTC, ₿15,000 — 15000 base units)                | `…/pub/locks.app/09KDJ3HSB3PXRZBJ0A75PQHK413A7VED68EAHQJY4JBZZRZE9GJ0.json`                                                                                                                                                                                        |
| Bundle id                                                     | `J7827Z902XWG7ES2RK2E979FTC`, submitted 13:05:07Z → task `pending`                                                                                                                                                                                                 |
| Gateway dispatch log                                          | `dispatch: BTC criterion, proxying invoice to paykit-server` (bundle above)                                                                                                                                                                                        |
| Private Payment Request (received by `paykit-reader-mainnet`) | id `5c47bf21-ea43-419c-8627-20504f8f56e4`, address `bcrt1qgsf9s0dz2au4aa80gtuc4hph7c35tudxjpddhy`, ₿15,000 (15000 base units, wire field `amount_sats`)                                                                                                            |
| On-chain regtest payment (Railway bitcoind miner wallet)      | txid `31b1425b46ea6d7d0e1cbb7540e4a211157f9c07450a2078f2741251673dcf4a`                                                                                                                                                                                            |
| Status polled via gateway                                     | `{"status":"confirmed","confirmations":2,"amount_matched":true}`                                                                                                                                                                                                   |
| Locks lifecycle                                               | `completed` at 13:07:11.588997Z (~2m04s submit→complete, one confirmation cycle)                                                                                                                                                                                   |
| Credential + guarded read                                     | both 200; bytes `deployed rails guarded bytes railsstaging-1787301246` (exact match)                                                                                                                                                                               |

Honest footnote: a first attempt (`SJTMW2ZE6A69BY4VWRZHWGAJPR`) published the reader
marker with a throwaway Noise key, so its Payment Request delivery could not be
decrypted. That invoice sits unpaid and its task will expire on schedule — the exact
behavior an abandoned checkout has. The retry above used a properly prepared reader.

## Proof 2: the fiat path, to the exact edge of the Stripe credential

- **A USD lock is accepted by the deployed Lock Server today, zero upstream changes**
  (design §1.3 proven live, not just cited): criterion
  `{recipient_pubky, amount: "1999", asset: "USD"}`, stored at
  `…/pub/locks.app/BHKTAW0H2TV3FXXN6X56KFZSX52T5T27HG2J9WZ3X3T46EBX5PV0.json`.
- **A USD proof bundle dispatches to the fiat path and fails closed without a
  processor**: submission of bundle `HSAT4TS8MATMREVAH781SPD9HC` → the Lock Server's
  invoice call hit the gateway → gateway answered `503 fiat_unavailable` → submission
  failed upstream with `paykit_invoice_creation_failed` (the designed fail-closed
  behavior for a seller/deployment without fiat enabled, design §6; nothing persisted,
  the bundle id remains reusable).
- The buyer endpoint answers `503 fiat_unavailable` for the same reason.
- The full happy path (Checkout Session, webhook, pull, delay, `completed`, credential,
  guarded read) is exercised end to end in the service's handler tests against a mock
  Stripe API with real ed25519 signatures.

**Blocker for the live fiat purchase proof — needs exactly one credential.** No Stripe
test-mode key exists on the build machine (no `stripe` CLI, nothing in the secret
stores). To run the live proof:

1. Provide a **test-mode** secret key (`sk_test_…`) → set `STRIPE_SECRET_KEY` on the
   `fiat-verifier` Railway service.
2. The webhook signing secret is then self-provisioned: `POST /v1/webhook_endpoints`
   with that key against `https://fiat-verifier-production.up.railway.app/webhooks/stripe`
   returns the `whsec_…` secret → set `STRIPE_WEBHOOK_SECRET` (runbook in the service
   README). Redeploy; `/health` reports both flags.
3. Re-run: driver `proof` on the USD lock → `checkout <bundleId>` → complete the hosted
   Checkout with a Stripe test card (`4242…`) → watch
   `undetected → detected → (300s) → confirmed → completed` → `credential`.

## What this proves, and what it does not

Proven: the zero-upstream-change claim (Phase 1's make-or-break exit criterion). The
deployed Lock Server, Paykit Server, and marketplace-service are all unchanged; one env
var moved; the BTC rail completes a real purchase through the gateway; the fiat surface
is live, authenticated, fail-closed, and dispatches correctly.

Not proven yet: a completed Stripe test-mode payment on staging (blocked on the test
key above — the design's §8 test-mode rollout is otherwise ready), and everything
explicitly deferred by the plan: client UX (Phase 2), PayPal (Phase 3), seller-owned
Stripe Connect accounts (Phase 4 — the deployed processor settles into the operator's
test account, staging-only by declaration), automated chargeback→reversal handling
(Phase 5), live mode (Phase 6, gated on security review).

## Update 2026-08-22: Stripe proven live; PayPal built and deployed fail-closed

**The Stripe live proof landed.** With a real test-mode key on the `fiat-verifier`
Railway service (webhook self-provisioned per the runbook above), the full purchase
ran on the deployed stack: USD lock → proof bundle → gateway invoice → hosted
Checkout paid with the `4242` test card in a real browser → webhook `detected`
(amount matched) → 300s settlement → `confirmed` → `completed` → access credential →
guarded content read. `/health` reports `stripe_enabled:true, stripe_webhook_configured:true`.

**PayPal (the plan's Phase 3) is built, tested (72 verifier tests, 24 new), and
deployed fail-closed.** Orders v2 with capture-on-approval, postback-verified
webhooks treated as hints (only a fresh order+capture pull with the exact criterion
amount advances state), the same settlement machine and reversal corroboration as
Stripe. Verifier configuration:

| Env var                                     | Meaning                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Sandbox REST app credentials, set together; absent ⇒ the PayPal path answers 503 `fiat_unavailable`    |
| `PAYPAL_WEBHOOK_ID`                         | Webhook verification id; absent ⇒ webhook endpoint 503s and detection is poll-only                     |
| `PAYPAL_API_BASE`                           | Defaults to the sandbox host; a live host refuses to boot without `FIAT_LIVE_MODE=true`                |
| `FIAT_DEFAULT_PROCESSOR`                    | `stripe` (default) or `paypal`; used when both processors are configured and the buyer does not choose |

`POST /checkout-sessions` accepts an optional `processor` (`stripe`\|`paypal`);
the binding is permanent per correlation (asking for the other processor afterwards
is a 409 — switching would strand a still-payable session the gateway no longer
observes). The design §7 `Locks · PayPal` badge case is now reachable.

**Update, same day: the live PayPal sandbox proof landed.** With sandbox
credentials and a self-provisioned webhook on the Railway service (`/health`
reports both processors enabled), the full purchase ran on the deployed stack:
proof bundle → gateway invoice bound to PayPal → hosted approval page paid via
guest card checkout → `detected` (amount matched) → 300s settlement →
`confirmed` → `completed` → access credential → guarded content read. Both
fiat rails are now live-proven end to end.
