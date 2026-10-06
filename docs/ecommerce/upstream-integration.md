# Marketplace Upstream Integration Contract

Audit date: 2026-08-19  
Status: architecture baseline; upstream components are pre-production.

This document records the exact upstream behavior the marketplace may rely on. It prevents the web app from inventing browser APIs, payment facts, refund capabilities, or security guarantees that Paykit and Locks do not provide.

## Audited revisions

| Repository                   | Branch   | Commit                                     |
| ---------------------------- | -------- | ------------------------------------------ |
| `pubky/paykit-rs`            | `master` | `c8892f638951f033acbcd12804a31667a81ddc14` |
| `pubky/locks`                | `master` | `ba49a777a94db318ec6ebd427315080a5b904645` |
| `pubky/paykit-server`        | `master` | `f38c7915e6b9b104e040773e78438f8aa984c46c` |
| `pubky/pubky-ring`           | `main`   | `16320e786af4ab2916cdb629e0f186a14a728ed0` |
| `pubky/pubky-ring-simulator` | `main`   | `14b333bc18579b96e57efb256ceefff44f62616f` |
| `pubky/pubky-homeserver`     | `main`   | `214bb4685e56bc404ba6694990d7d653342e86ec` |
| `pubky/pubky-docker`         | `main`   | `4e8dfb9a5067f59dd91e0abe60ef19edde17813b` |
| `synonymdev/bitkit-android`  | `master` | `d13d0e225cb7699a59b61485f84dc99bdccdda40` |
| `synonymdev/bitkit-ios`      | `master` | `625b54e2fcce5f076f42cca434c4c7cad2b6f9d5` |

Known release anchors at audit time:

- Paykit: `v0.1.0-rc43`
- Pubky Ring: `1.18`
- Pubky Homeserver: `v0.11.0`
- Bitkit Android/iOS: `v2.4.0`, each using Paykit `0.1.0-rc43`
- Locks and Paykit Server: no stable release

Builds and generated bindings must pin exact commits and checksums. They must not consume mutable `master`, `main`, or `latest` references.

## Supported topology

```text
Pubky App browser
  ├─ @synonymdev/pubky JS/WASM
  │    └─ PKARR / relay / Pubky Homeserver
  ├─ Locks JS/WASM, client-only
  │    └─ Lock Server
  │         ├─ PostgreSQL
  │         └─ signed HTTP
  │              └─ Paykit Server
  │                   ├─ PostgreSQL
  │                   ├─ Paykit Rust SDK / Pubky private messages
  │                   └─ Electrum -> Bitcoin
  └─ Marketplace API
       └─ Marketplace Transaction Service -> PostgreSQL

Pubky Ring
  └─ Pubky identity and creator-authority approval

Bitkit
  └─ Paykit companion claim, private payment request, wallet execution
```

Hard boundaries:

- The browser and Marketplace Transaction Service never call Paykit Server business routes.
- Paykit Server accepts `POST /invoices` and `POST /transactions/status` only when signed by the configured Lock Server Ed25519 key.
- The browser uses Locks for proof, verification, credential, and guarded-resource flows.
- The Marketplace Transaction Service may correlate an encrypted Locks lifecycle with an order, but it must not forge completion from client input.
- General Paykit encrypted links, private lists, requests, and receipts require Paykit Rust. They must not be reimplemented in TypeScript.
- Locks is entitlement infrastructure, not custody, escrow, a marketplace guarantee, or a refund rail.

## Browser packaging

`@synonymdev/pubky` is already a published browser JS/WASM dependency.

Locks has a real browser JS/WASM binding under `locks-sdk/bindings/js`, but it is unpublished. Integration therefore requires:

1. Pin the audited or later reviewed Locks commit.
2. Build the generated package with the upstream Rust/wasm-pack toolchain.
3. Record source commit, tool versions, package checksum, license, and generation command.
4. Vendor the generated artifact or publish it to a controlled immutable registry.
5. Load it only in a client component through a dynamic import.
6. Run its generated API smoke test before the Next.js build.

Do not create hand-written substitutes for Locks canonicalization, identifiers, proof payloads, credentials, or session handling.

Paykit has Swift and Kotlin UniFFI bindings but no JS/WASM package. Browser code interacts with it only through the current Locks/Paykit Server topology. A future browser-facing Paykit BFF must be a constrained Rust service using `paykit-sdk`; it must not expose raw encrypted-link snapshots, receiver secrets, identity secrets, or generic storage access.

## Identity and setup

### Pubky App identity

The existing app uses `@synonymdev/pubky` browser sessions and a `/pub/pubky.app/:rw` grant. That grant does not authorize Locks private content or creator proof storage.

### Lock Server creator authority

Creator setup uses the Lock Server flow:

```text
GET  /connect
POST /connect/{flow_id}/complete
POST /frontend-sessions
```

Pubky Ring approves the requested creator capability. The app must show the exact grant scope and Lock Server identity before leaving the browser. Creator frontend session material is sensitive, account-scoped, and cleared on sign-out.

### Paykit Server creator setup

Paykit Server setup uses:

```text
GET  /setup?return_to={exact_origin}&state={opaque_state}
POST /setup/{flow_id}/complete
```

Bitkit approves a `watch-only-account-v1` companion claim containing a BIP84 account xpub and hardened account index. Paykit Server derives receive addresses but does not receive spending keys.

Requirements:

- Validate the exact return origin and opaque state.
- Never accept an xpub in Pubky App, its API routes, logs, analytics, or IndexedDB.
- Show setup as pending until Paykit Server confirms completion.
- Treat setup loss after Paykit Server restart according to its documented single-process behavior.
- Do not use Pubky Ring Simulator for Paykit setup; it only simulates generic local-testnet Pubky auth.

## Creator publishing contract

Locks creator routes:

```text
PUT  /creator/priv-resources/content/<path>
POST /creator/content-locks
POST /creator/lock-service-config
```

Marketplace use:

1. Upload guarded digital content through Locks.
2. Verify returned resource identity and hash.
3. Publish a `paykit-payment` lock with the seller as recipient.
4. Store the public lock resource on the listing snapshot.
5. Optionally attach the lock resource to a `pubky-app-specs` post `lock` field for a social preview.

Raw digital content must not pass through public marketplace paths or Nexus.

## Buyer payment and access contract

Locks viewer routes:

```text
POST /proof-bundles
POST /verification-task-lookups
POST /access-credentials
GET  /priv-resources/content/<path>
```

Canonical Paykit proof shape:

```json
{
  "reader_public_key": "pubky...",
  "proofs": [
    {
      "criterion_id": "criterion-1",
      "verifier_type": "paykit-payment",
      "payload": {}
    }
  ]
}
```

The proof payload does not contain a transaction, invoice, receipt, or wallet proof. Payment details come from the public lock criterion.

Flow:

1. Transaction Service creates the pending order and one encrypted correlation record.
2. Buyer reads and validates the listing's public lock.
3. Buyer submits a cryptographically random `bundle_id`, reader identity, lock resource, and empty Paykit proof.
4. Lock Server signs an invoice request to Paykit Server.
5. Paykit Server derives a unique BIP84 receive address and sends Paykit private messages to the reader's Bitkit identity.
6. Bitkit receives and executes the wallet payment outside Pubky App.
7. Paykit Server observes Bitcoin through Electrum.
8. Lock Server polls the signed payment status.
9. Pubky App polls the opaque Locks verification lifecycle.
10. Completed verification permits access-credential issuance and guarded-resource proxy read.
11. Transaction Service independently verifies the Locks result before advancing the order.

The browser does not receive the Paykit Server invoice response and therefore cannot truthfully show its address as a QR code or copyable invoice. The real UI shows request delivery and entitlement progress. A sandbox adapter may show simulated QR/deep-link behavior only with persistent sandbox labeling.

## Settlement semantics

Current Paykit Server behavior:

- direct on-chain Bitcoin only;
- one unique BIP84 external-chain address per invoice;
- one output must meet the required amount; split outputs are not aggregated;
- `undetected`: no active output;
- `detected`: zero-confirmation output exists;
- `confirmed`: at least one confirmation;
- one amount-matched output is sufficient;
- overpayment is factual but has no credit/refund workflow;
- reorg handling is supported before six-confirmation finality;
- finality is six confirmations and the reported count is capped at six;
- Paykit Server has no spending keys and cannot refund or create change.

Locks acceptance:

- `minimum_confirmations = 0` accepts detected, amount-matched payment;
- `minimum_confirmations = 1..6` requires confirmed status at that depth;
- a value above six can never complete against this Paykit Server;
- transport, status, decode, and authorization errors remain pending and retryable;
- v1 exposes no terminal payment-failure state to the viewer.

Marketplace mapping:

| Upstream fact                                          | Marketplace state                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| Proof submitted; Locks pending                         | `awaiting_payment_entitlement`                                    |
| Locks verification completed                           | `payment_confirmed` exactly once                                  |
| Marketplace payment window elapsed while Locks pending | `payment_window_elapsed` plus reconciliation                      |
| Completion after marketplace expiry                    | `manual_review`, never silently discard                           |
| Locks/network error                                    | remains pending with bounded UI polling and server reconciliation |
| Refund requested                                       | `external_refund_required`; never `refunded`                      |
| Independently verified seller transaction evidence     | `refunded_external`                                               |

Detected, underpaid, overpaid, and confirmation-count details are operator-only unless a future signed Locks API deliberately exposes them. The client must not infer them.

## Transaction-service correlation

`bundle_id` is a bearer secret. Correlation records must:

- encrypt `bundle_id` at rest;
- store an HMAC lookup token rather than expose the raw value in logs or URLs;
- bind order ID, buyer Pubky, seller Pubky, lock resource hash, amount, asset, and policy version;
- reject a changed replay under the same order/idempotency key;
- verify Locks completion server-side;
- append one payment-confirmed event under a unique order/payment constraint;
- retain late-completion and reconciliation history;
- never place the raw bundle, Pubky URL, address, or payment correlation in telemetry.

## Local integration environment

`pubky/pubky-docker` is useful for Pubky App, Homeserver, Nexus, Homegate, and supporting services, but it does not provide Locks, Paykit Server, Electrum, Bitcoin, Ring, or Bitkit.

The integration environment must use pinned images/source and compose:

- Pubky testnet/relay/homeserver;
- Nexus when catalog indexing is under test;
- Pubky App;
- Marketplace Transaction Service and PostgreSQL;
- Lock Server and PostgreSQL;
- Paykit Server and PostgreSQL;
- deterministic Bitcoin regtest plus an Electrum-compatible indexer;
- Locks creator demo/auth helper where native Ring is unavailable;
- `paykit-companion-auth` for creator companion approval;
- `paykit-reader-demo` for protocol-real payment request receipt and regtest payment instructions.

Only one Pubky testnet stack should own a test run. Do not start both Pubky Docker and Locks' bundled testnet on colliding ports.

Pubky Ring Simulator may verify generic auth handoff against a local testnet. It is not evidence for Ring native behavior, Bitkit approval, Paykit private messaging, payment execution, or production homeserver compatibility.

## Verification addresses

| Requirement                                | Automated address                               | Manual evidence                                   |
| ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------- |
| Locks generated package loads in Next.js   | generated API smoke + production Next build     | creator/viewer UI opens without SSR or WASM error |
| Creator authority uses Ring grant          | Lock Server contract test with pinned build     | grant scope and approved setup shown              |
| Paykit setup keeps xpub out of app         | network/log/storage assertions                  | Bitkit/helper approval completes                  |
| Browser cannot call Paykit business routes | route/security test                             | direct unsigned request rejected                  |
| Paykit proof shape stays canonical         | fixture contract test against Lock Server       | proof creates one pending lifecycle               |
| Payment confirmation is idempotent         | duplicate/reordered completion integration test | one order transition/timeline event               |
| Confirmations stay in `0..6`               | schema boundary tests                           | unsupported policy blocked before publish         |
| Network errors remain pending              | fault-injection test                            | UI shows retrying, not failed/paid                |
| Late payment reconciles                    | fake-clock integration test                     | manual-review timeline shown                      |
| Digital content requires entitlement       | unauthorized/authorized proxy-read tests        | access denied before and allowed after payment    |
| External refund is not automatic           | state-machine and evidence-verifier tests       | UI requests evidence and never claims funds moved |
| No sensitive telemetry                     | log/Sentry/analytics redaction tests            | browser storage and operator output inspected     |

Before completion, run the pinned upstream smoke suites plus a composed buyer/seller flow from creator setup through regtest payment, confirmation, credential issuance, content read, order advancement, restart recovery, and duplicate event replay.

## Blockers tracked as work

- Build and package the unpublished Locks JS/WASM binding reproducibly.
- Add a protocol-real local Compose overlay; neither Pubky Docker nor Locks Compose alone is complete.
- Implement Marketplace Transaction Service verification of the Locks lifecycle without exposing bearer material.
- Define private marketplace messaging: use Paykit encrypted links through a Rust adapter or adopt another reviewed encrypted Pubky protocol.
- Add explicit expiry/reconciliation because Locks v1 has no terminal payment failure.
- Perform an independent security review before any real-funds deployment.
- Re-audit upstream revisions before upgrading any pin.

## Design-source resolution

`pubky/design.md` is neither a current repository nor a discoverable current Pubky organization file. The old `pubky/pubky-locks` receipt/HTTP-402 design is not the implementation contract.

For this integration:

- current `pubky/locks/docs/API.md` and `docs/RUNTIME.md` are authoritative;
- the lower design-proposal section in current `pubky/locks/README.md` supplies rationale only where it does not conflict with those documents;
- Pubky App UI follows this repository's Shadcn/Tailwind tokens, Figma workflow, atomic component rules, and accessibility requirements.
