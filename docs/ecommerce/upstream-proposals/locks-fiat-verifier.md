# Upstream proposal: a generic `external-payment` verifier type for Locks

**Status: DRAFT — NOT SENT.** This is a ready-to-send proposal for the Locks
maintainers. It must not be filed as an issue or PR against `pubky/*` without explicit
approval. It exists because the marketplace's fiat-rails work (see
`../fiat-rails-design.md`) found exactly one place where the current Locks contract
forces a semantic compromise, and the compromise deserves a clean upstream fix.

All line references are against Locks revision `ba49a77`.

## What we are doing today without upstream changes (context)

We run a payment verifier gateway behind the Lock Server's existing `[paykit]
server_url` (`locks-server/src/config/schema.rs:31-33`). It speaks the Paykit Server
wire contract — `POST /invoices`, `POST /transactions/status`,
`X-Paykit-Signature` ed25519 over canonical JSON — and dispatches on the lock
criterion's `asset`: `"BTC"` proxies to a real Paykit Server; fiat assets (`"USD"`, …)
settle through Stripe/PayPal processors. This is possible because
`validate_paykit_payment_params` (`locks-core/src/lock_policy.rs:380-426`) constrains
`asset` only to a non-empty string and `amount` to a positive decimal integer string.

It works, and it needs nothing from you. But it has two honest wrinkles this proposal
would remove.

## Problems

1. **Wire-label misnomer.** A Stripe-settled entitlement's verified proof bundle
   records `verifier_type: "paykit-payment"` (`locks-core/src/verification.rs:84`),
   because `VerifierType` is a closed enum with only `dev-static` and `paykit-payment`
   (`lock_policy.rs:306-314`) and unknown values are rejected at deserialization
   (`lock_policy.rs` test at `:835-842`). The evidence label misnames the system that
   produced the evidence. Nothing breaks — trust was never carried by the label — but
   the audit trail is less truthful than it could be.

2. **Confirmation semantics are Bitcoin-shaped.** `payment_status_satisfies`
   (`locks-service/src/infrastructure/verifiers/paykit_payment.rs:93-102`) interprets
   the status response through `minimum_confirmations`, a single global
   `[paykit]`-section number. A fiat verifier's finality signal is a settlement-delay
   policy, not block confirmations, so today it must synthesize
   `confirmations: minimum_confirmations` to pass the rule — mechanically honest
   (the delay really elapsed), semantically borrowed.

## Proposed change

### 1. New verifier type: `external-payment`

```rust
// locks-core/src/lock_policy.rs
pub enum VerifierType {
    DevStatic,
    PaykitPayment,
    /// Payment verified by an operator-configured external payment verifier
    /// (settlement system intentionally unspecified by the protocol).
    ExternalPayment,   // wire: "external-payment"
}
```

Criterion params: identical shape to `paykit-payment` — `recipient_pubky` (must equal
creator, same v1 policy as `validate_paykit_payment_v1_policy`,
`lock_policy.rs:146-188`), `amount` (positive decimal integer string, minor units),
`asset` (non-empty string; e.g. ISO-4217 codes or `"BTC"`). One added optional param:

- `display_asset_exponent` (optional integer): purely presentational hint so viewers
  can render `"1999"`/`"USD"` as `$19.99` without a hardcoded currency table.

Rationale for one generic type rather than `stripe-payment`/`paypal-payment`: the Lock
Server neither knows nor verifies which processor settled the payment — that knowledge
lives in the verifier service. A per-processor wire value would be a _claim the Lock
Server cannot check_, which is worse than a generic one it can (namely: "my configured
external verifier attested this").

### 2. Config: a second, parallel verifier section

```toml
[external_payment]
server_url = "https://fiat-verifier.example"
# finality is the verifier's policy; the Lock Server does not reinterpret it
```

Same client machinery as `[paykit]` (`locks-server/src/paykit_http_client.rs` — the
signing, canonicalization, and endpoint code are already verifier-agnostic; only the
config key and the registry wiring are paykit-named). The registry gains one field
(`locks-service/src/infrastructure/verifiers/registry.rs:6-41` pattern).

### 3. Status contract: verifier-owned finality

For `external-payment`, the status response drops `confirmations` and reports
finality directly:

```json
{ "status": "undetected" | "detected" | "final", "amount_matched": true }
```

The verifier adapter satisfies the criterion iff `status == "final" &&
amount_matched`. `detected` exists so operators/UIs can observe progress (and so the
invoice→settlement-delay flow has an inspectable intermediate state), but the Lock
Server applies no confirmation arithmetic — finality is explicitly the external
verifier's attestation, which matches the trust reality (the Lock Server already
believes whatever `transactions/status` returns; the `confirmations >= N` check only
re-applies policy to a number the same trusted party supplied).

### 4. Invoice call: unchanged

`POST /invoices {bundle_id, lock_resource, reader}` is already settlement-agnostic and
is reused verbatim for `external-payment` criteria
(`locks-server/src/api/verification.rs:83-147` — the only change is dispatching the
branch on `ExternalPayment` as well as `PaykitPayment`).

## Compatibility

- Additive: existing `dev-static` and `paykit-payment` locks, bundles, and deployments
  are untouched. `deny_unknown_fields`/closed-enum semantics stay (a v0 server rejects
  `external-payment` locks loudly, which is correct fail-closed behavior).
- The v1 "payment must be the only criterion" policy extends to the new type unchanged.
- Migration for us: our gateway switches its accepted `verifier_type` string and drops
  the synthesized-confirmations shim; lock-creation tooling writes the new type.

## Alternative we considered and do not recommend

Extending Paykit Server itself to multi-asset (relaxing
`paykit-server/src/domain/invoice.rs:59-83` `CriterionAsset` beyond `"BTC"`). Paykit
Server's pipeline — Electrum detection, receiver paths, wallet delivery — is
Bitcoin-shaped end to end; fiat processors inside it would be a bolt-on with none of
the shared machinery actually shared. The verifier boundary (this proposal) is the
right seam; Paykit Server stays exactly what it is.

## What we are asking for

1. Reaction to the `external-payment` type + parallel config section (§1–2).
2. A decision on the finality-shape question (§3): verifier-owned `final` vs reusing
   the confirmations rule.
3. If agreed in principle, we will prepare the implementation PR against `locks` for
   review, including tests mirroring the existing `paykit-payment` coverage.
