# Paykit surface as used by the Pubky Marketplace

**To:** maintainers of `pubky/paykit-rs` and `pubky/paykit-server`
**From:** the Pubky Marketplace integration (forks under `BitcoinErrorLog`)
**Date:** 2026-09-01
**Status:** technical brief. Not a PR, not a demand list. Every SHA below was
checked with `git cat-file -e <sha>^{commit}` in the checkout named for that
row. `feat/chat-ffi` was checked in a second clone of the same GitHub repo;
the clone used for the wasm-binding and write-abort lines does not contain
that branch. A fresh clone of `BitcoinErrorLog/paykit-rs-official` fetches
every cited SHA.

This document assumes you have not seen the marketplace. It covers only the
Paykit / Locks / pubky-core payment-and-messaging surface: what we run, what
changed in our forks, what looks like yours to fix, what we deliberately built
around you, and what you can ignore.

Nothing here has had an independent security review. paykit-rs is pre-1.0.
Bitcoin is **regtest only**. Where a cause is unproven, it is labeled that way.

---

## 1. What we run

A staging marketplace (client at `https://shop.pubky.app`) buys and sells over
three settlement rails. Two of those rails touch your code:

- **Bitcoin (regtest).** Locks entitlement + Paykit Server invoice observation
  + Bitkit as the buyer wallet. Proven live on 2026-08-22, including companion
  claim, in-app Payment Request, swipe-to-pay, and on-chain confirmation.
- **USD.** Stripe test-mode and PayPal sandbox, settled by a verifier gateway
  that *speaks* the Paykit Server wire contract. Paykit Server itself is not
  in that path except as the BTC proxy target. See §7.

Encrypted buyer↔seller messaging in the durable client modes uses official
Paykit Encrypted Links (Noise XX, homeserver outbox) through a browser WASM
binding of `paykit-lib`. That binding is a fork of your repo, not a new
protocol.

Payments-related repos:

| Piece | Git | Branch / pin | What it is |
| --- | --- | --- | --- |
| Paykit Server (deployed) | `BitcoinErrorLog/paykit-server` | branch `marketplace-rails`; **deployed** `98f7c2251e5eabf1d7b14704dcdababf25499c53` | Fork of `pubky/paykit-server` @ `f38c7915e6b9b104e040773e78438f8aa984c46c` (“Initial public release”). Wallet-interop fixes plus two marketplace extensions. Branch HEAD is one docs commit later (`651d428`); staging is pinned at `98f7c22`. |
| paykit-rs (wasm binding) | `BitcoinErrorLog/paykit-rs-official` | `feat/wasm-binding` HEAD `24ed3a0e85067d3416e1a7085ed8b7ff9f241267` | Fork of `pubky/paykit-rs` @ `c8892f638951f033acbcd12804a31667a81ddc14` (merge of #130, one commit after tag `v0.1.0-rc43` / `6b24187`; `paykit-lib` version at that commit is still `0.1.0-rc43`). |
| paykit-rs (pubky wasm patches) | same repo | `fix/wasm-homeserver-write-abort` HEAD `d4a73a5765e1f0b18ed451d78f98dab97c611a8c` (`paykit-wasm` 0.1.0-rc50) | Same line plus a vendored `pubky` 0.8.0 with the wasm write/pkarr patches in §5. |
| paykit-rs (chat FFI) | same repo, second clone tracking `origin/feat/chat-ffi` | `feat/chat-ffi` HEAD `4b2c495cb01a705d7858d1815b2bc170055d64ea` | Separate line from `0a6c6e4`. Not vendored into the web client. The wasm-binding working copy does not have this branch fetched; a fresh clone of the fork does. |
| Client-vendored wasm | inside `BitcoinErrorLog/pubky-app` | `paykit-wasm` **0.1.0-rc44** built from `0a6c6e4521fd41f5081ad9f074020f4813d8a03e` | Behind the wasm-binding HEAD and the write-abort line above. The write-abort tip is 0.1.0-rc50; the web client still runs this rc44 build. Provenance: `vendor/paykit-wasm/PROVENANCE.md`. |
| Fiat verifier | `BitcoinErrorLog/pubky-fiat-verifier` | new service, no upstream | Sits at Lock Server `[paykit] server_url`. Proxies `asset: "BTC"` verbatim to paykit-server; settles `USD` itself. |
| Staging rails | `BitcoinErrorLog/pubky-payment-rails` | Railway project `pubky-marketplace-staging` | Lock Server + paykit-server @ `98f7c22` + regtest bitcoind + Fulcrum. |
| Locks | `pubky/locks` **(no fork)** | detached at `ba49a777a94db318ec6ebd427315080a5b904645` | Clean upstream checkout. Local `origin/master` is **8** commits ahead of this pin (not 7). One of those is `e6a2027` “fix(paykit): consume server-issued companion handles (#38)”. |
| Local compose | this repo, `payments-env/` | Paykit Server image built from **upstream** `f38c7915` | Protocol-level Locks→Paykit→regtest path. This local stack is *not* the deployed fork pin. |

Config roles (names only; no values):

| Name | Role |
| --- | --- |
| `[locks] trusted_public_key` | Paykit Server trust anchor for Lock Server request signatures (`X-Paykit-Signature` over canonical JSON). |
| `[marketplace] trusted_public_key` | Optional second trust anchor on the fork; the marketplace transaction service’s matching private material is `PAYKIT_REQUEST_SIGNING_KEY`. |
| `LOCKS_BUNDLE_ENCRYPTION_KEY` | Marketplace service: encrypts Locks bundle ids at rest. |
| `LOCKS_LOOKUP_HMAC_KEY` | Marketplace service: HMAC token for bundle lookup; required to differ from the encryption key. |
| `ATTESTOR_SECRET_KEY` | Marketplace service: Ed25519 attestor for portable JWS receipts (not a Paykit receipt). |
| Stripe restricted keys, PayPal sandbox credentials, Shippo tokens | Processor credentials inside the marketplace service / fiat verifier. Never sent to Paykit Server. |

---

## 2. The wallet-interop trio (highest value)

Upstream paykit-server at `f38c7915` emitted payment material that Bitkit
silently rejected. Confirmed in
`paykit-server/src/application/create_invoice.rs` at that revision:

1. **Hardcoded mainnet endpoint identifier** `btc-bitcoin-p2wpkh` on every
   network, including regtest. Bitkit filters identifiers whose network
   segment does not match the wallet’s chain: `MethodId` /
   `onchainNetwork` in `Bitkit/Services/PublicPaykitService.swift`
   (currently 98–179) plus `supportedEndpointIdentifiers` in
   `Bitkit/Services/PaykitPaymentRequestService.swift` (currently 75–87),
   which keeps identifiers whose `onchainNetwork` equals `Env.network`.
   The fork advertises `btc-regtest-p2wpkh` / `btc-testnet-p2wpkh` /
   `btc-signet-p2wpkh` / `btc-bitcoin-p2wpkh` from
   `PaykitIntentBuilder::for_network`.
2. **Asset `"BTC"`** (uppercase) in `PaymentRequestTerms.amount`. The
   payment-requests spec is case-sensitive; Bitkit requires lowercase
   `"btc"` (`Bitkit/Services/PaykitPaymentRequestService.swift:32`,
   `terms.amount.asset == "btc"`), matching the identifier’s asset
   segment.
3. **Endpoint payload as a bare address string**, via
   `PaymentEndpointPayload::new(address)`. Spec section 7’s interoperable
   convention is JSON `{"value": "<address>"}`. Bitkit’s `parsePayload`
   (`Bitkit/Services/PublicPaykitService.swift`, currently 403–421)
   returns nil unless the payload is a JSON object with a non-empty
   string `value`. The SDK reports
   `PublicPaymentResolutionStatus::UnsupportedEndpoint` or `NoEndpoint`
   (`paykit-sdk/src/domain/payment_resolution.rs`, currently 17–24;
   derived in `paykit-sdk/src/runtime/payment_resolution.rs`, currently
   593–619).

The fork fix is `1a7f242b7224` (“Advertise network-correct endpoint
identifiers and JSON payloads”) in `create_invoice.rs`, `server.rs`, and
`tests/create_invoice.rs`. Follow-ups: `865703213b4b` (e2e workflow
assertions), `1f154610fe3b` (`paykit-reader-demo` now requires the same
shapes, in `paykit-server/src/bin/paykit-reader-demo/payment_instructions.rs`),
`98f7c2251e5e` (e2e compares endpoint payloads as parsed JSON values, not
as strings).

At `f38c7915`, `paykit-reader-demo` was strict against the server’s own
output, not against the spec. It required `terms.amount.asset == "BTC"`,
`accepted_payment_endpoint_identifiers == ["btc-bitcoin-p2wpkh"]`, and
`Address::from_str` on the raw map value — so a spec-conventional
`{"value": "..."}` payload, lowercase `"btc"`, or `btc-regtest-p2wpkh`
would each have failed. The e2e suite stayed green because the reader
asserted the same shapes the server emitted; server and reader could
drift from the spec together. The failures appeared only when the real
Bitkit wallet leg was attempted (2026-08-22). A reader whose fixtures are
the server’s output cannot detect the server drifting from the spec.

We are not asserting these three still exist on current `pubky/paykit-server`
master — only that they existed at `f38c7915`, which is what staging ran,
and that Bitkit’s filter is what made them load-bearing.

---

## 3. Marketplace extensions on the paykit-server fork (upstream-or-fork)

`cb2bc3ab8cbc` (“Add manual watch-only claims and marketplace payment
requests”), 17 files, +2246/−61, adds two HTTP surfaces and a second
trusted signer. New files include
`paykit-server/src/application/create_payment_request.rs`,
`paykit-server/src/manual_claim.rs` (not under `application/`),
`paykit-server/src/http/accounts.rs`,
`paykit-server/src/http/payment_requests.rs`.

- `POST /v0/payment-requests` — lock-free signed invoice creation. Settlement
  terms come from the signed body; no ContentLock is fetched. Downstream
  (per-reader address derivation, persistence, outbox delivery, Electrum
  observation, status keyed by `(creator, reference)`) reuses the invoice
  pipeline. Used so the marketplace transaction service can request
  receiver-side invoices for **physical-goods** Bitcoin orders without a
  Locks entitlement and without holding wallet material.
- `POST /v0/accounts/claim` and `GET /v0/accounts/{creator}` — a watch-only
  companion claim that takes a capability-scoped Pubky `AuthToken`, loops it
  through the configured HTTP relay into the SDK auth flow, then reuses the
  companion commit path (marker + encrypted credential). Browser seller
  onboarding cannot run the Bitkit companion binary or hold the identity
  secret.
- **Multi-key request auth.** Signed routes accept the Lock Server key *or*,
  when configured, a marketplace key (`[marketplace] trusted_public_key`).
  Implementation: `paykit-server/src/http/auth.rs` builds `trusted_keys`
  from both.

This is a genuine product decision for you, not a patch we expect you to
take as-is: do multi-trusted-signer and marketplace-initiated payment
requests belong in paykit-server, or should they stay a deployment
extension?

There is a documented tension on our side. ADR 0019 §7 in the marketplace
app repo states, verbatim:

> Only the configured Lock Server may call signed Paykit Server business
> routes. Pubky App and the Marketplace Transaction Service do not call
> them directly.

The physical-Bitcoin path does exactly that: the transaction service POSTs
`/v0/payment-requests` as a trusted signer (`PAYKIT_REQUEST_SIGNING_KEY` ↔
`marketplace.trusted_public_key`). The fork exists because of that
contradiction. If you take the extension upstream, the ADR should change.
If you reject it, we keep it as a deployment patch and keep the ADR honest
about the exception.

---

## 4. The paykit-rs fork is smaller than it looks

The fork remote of `BitcoinErrorLog/paykit-rs-official` has `master`,
`badges`, `feat/homeserver-migration`, `feat/sb2-encrypt-export`,
`feat/wasm-binding`, `fix/wasm-homeserver-write-abort`, and
`feat/chat-ffi`. This document covers three of those heads. They are easy
to conflate.

### 4.1 `feat/wasm-binding` (the binding)

12 commits over `c8892f6`. `paykit-lib` has **no** fork-specific logic
changes on this branch (`git diff c8892f6..feat/wasm-binding -- paykit-lib`
is empty). Divergence is:

- a new `paykit-wasm` crate;
- vendored `snow` 0.10.0 under `[patch.crates-io]` (one-line manifest fix;
  see §6);
- crates.io `pubky` 0.8.0 as a normal dependency (not a path patch on this
  branch).

Consequence: you can evaluate a browser binding without inheriting
marketplace product logic. The crate also depends on a git pin of
`BitcoinErrorLog/pubky-crypto` for an SB2/X25519 handoff used by a
different client; Encrypted Links and Payment Endpoints do not need that
dep.

Notable commits:

| SHA | Subject |
| --- | --- |
| `2b80b9fd99ab` | Add paykit-wasm: browser WASM binding for Encrypted Link messaging |
| `7bbaba037f12` | Expose session export/restore for reload survival in browsers |
| `0a6c6e4521fd` | Add resumeSessionFromCookie: zero-approval session resume from the browser cookie |
| `93d3dba5ba50` | feat: bind public Payment Endpoints and private lists in wasm |
| `24ed3a0e8506` | fix: keep __proto__ payment identifiers as own JS properties |

Payment surface in wasm is **partial by design**. Public endpoints and
private lists are bound. Payment Requests, receipts, and the `paykit-sdk`
runtime (`SdkBackupState`, adapter-driven sync/resolve) are deliberately
excluded — they need the SDK session/store/adapter loop this crate does not
host.

`24ed3a0` is a small standalone bug fix, worth taking whether or not you
adopt the wasm crate. Identifier→payload maps used `Reflect::set`, which
silently no-ops for the valid identifier `__proto__`. The fix is
`Reflect::define_property` in `paykit-wasm/src/payments.rs`.

The client vendors `0a6c6e4` (`paykit-wasm` 0.1.0-rc44). That revision is
behind `feat/wasm-binding` HEAD `24ed3a0` (still 0.1.0-rc44) and behind
write-abort HEAD `d4a73a5` (`paykit-wasm` 0.1.0-rc50). The web client still
runs the rc44 vendored build. Browser e2e at the vendored revision is
**19/19** first-attempt on Chromium, Firefox, and WebKit
(`paykit-wasm/README.md` and `paykit-wasm/docs/browser-e2e.md` at
`0a6c6e4`); the same document records intermittent pkarr-resolution
failures at `signupWithSecret` / `signinWithSecret` (1 of 10 Chromium runs
of the earlier 14-check suite; first Chromium run of the 16-check suite)
attributed to relay/DHT publish timing rather than to the binding. An
earlier 16-check suite existed at `847f505`, before the cookie-resume
checks.

### 4.2 `fix/wasm-homeserver-write-abort` (vendored pubky)

Based on `feat/wasm-binding` (`merge-base` = `24ed3a0`). 11 further commits;
23 commits over `c8892f6` in total. HEAD `d4a73a5` (`paykit-wasm`
0.1.0-rc50). This is the line that path-patches `pubky` 0.8.0
(`vendor/pubky`, `[patch.crates-io]`). The patches are pubky-core bugs that
showed up through the wasm path; see §5. `paykit-lib` is still unmodified
vs `c8892f6`.

### 4.3 `feat/chat-ffi` (not in the web client)

Checked in a second clone of `BitcoinErrorLog/paykit-rs-official` tracking
`origin/feat/chat-ffi` (pushed; a fresh clone of the fork fetches it).
Branches from `0a6c6e4`. Adds chat Encrypted Links in
`paykit-ffi/src/chat_links.rs` (`96fa9e6498ac`) and a standalone xchacha20
attachment AEAD in `paykit-lib` (`ade3721283da`,
“feat: expose standalone xchacha20 attachment aead”). This **is** a
`paykit-lib` change, unlike the wasm lines. It is not vendored into the
marketplace web client. Question for you: is chat FFI in paykit-rs scope at
all?

### 4.4 Staleness

Against local `pubky-upstream/master` at `c83c7c01aa97` (2026-08-31, merge
of #146), `feat/wasm-binding` is **21 commits behind**. That window includes
Pubky 0.11 grant authentication (#143, `9b56a0e`), session lifecycle
hardening (#146), and tags `v0.1.0-rc44` through `v0.1.0-rc50`. A rebase
will collide on `Cargo.lock`, generated FFI bindings, and the pubky 0.8.0 →
0.11 bump; that collision set is the obvious one, not a completed rebase.

---

## 5. These are pubky-core bugs, not Paykit bugs

They were found through paykit-wasm’s homeserver writes. The code lives in
vendored crates.io `pubky` 0.8.0. Rationale is in
`vendor/pubky/PATCHES.md` on `fix/wasm-homeserver-write-abort`. Recommend
routing to **pubky-core** maintainers rather than a paykit-rs-only PR;
paykit-rs just depends on pubky. Whether current pubky 0.11 already
contains any of this is **unproven** here — the patches were written
against 0.8.0.

From `PATCHES.md`, relative to crates.io 0.8.0 (plus the later timeout
commits, which that file does not yet list):

| SHA | What failed | Fix | Key files |
| --- | --- | --- | --- |
| `b04e05cde937` | reqwest wasm `AbortGuard` aborted in-flight `fetch` when a 2xx body went unread on PUT/DELETE/POST (`net::ERR_ABORTED`) | Drain write bodies before returning `Ok` | `vendor/pubky/src/client/http_targets/browser.rs`, `vendor/pubky/src/client/http_targets/wasm.rs`, `vendor/pubky/src/actors/storage/verbs.rs`, `vendor/pubky/src/util.rs` |
| `cae1a8fb8bf9` | Awaiting leftover pkarr HTTPS SVCB records after `BrowserHttp` won endpoint selection resumed pkarr `resolve()` and trapped wasm `RuntimeError: unreachable` on cancelled sibling GETs | Drop the leftover stream; do not await it | `vendor/pubky/src/client/http_targets/browser.rs` |
| `a4c66d940fd3` | pkarr CAS retry looped because pkarr cached an unconfirmed packet | Restore the cache baseline before republish | `vendor/pubky/src/actors/pkdns.rs` |
| `2ff7d44e5cc9`, `6a58d269fecd` | Publish died on CAS/transport errors and unexpected relay responses | Retry | `vendor/pubky/src/actors/pkdns.rs` (and signer session on `2ff7d44`) |
| `f97873183491` | A stalled 2xx body could hang the drain forever | Bound the drain with a 5s timeout | `vendor/pubky/src/util.rs`, `vendor/pubky/src/errors.rs` |
| `d4a73a5765e1` (“fix: bound error-body drain and bump wasm to rc50”) | A hostile homeserver could hang `check_http_status` the same way a stalled 2xx hung the write-ack drain | Bound the error-body drain; clear wasm sleep timers on drop; rebuild paykit-wasm 0.1.0-rc50 | `vendor/pubky/src/util.rs`, `paykit-wasm/Cargo.toml` |

`PATCHES.md` also records WASM endpoint selection preferring ICANN/HTTP
(`HTTP_PORT`) over Pubky TLS for every host (browsers cannot speak Pubky
TLS), and `PubkySigner::migrate_homeserver`. Those are in the same vendored
tree; they are not claimed as Paykit defects.

---

## 6. wasm32 packaging blockers

Compiling unmodified paykit-rs (`c8892f6`) for `wasm32-unknown-unknown`
fails on four reproducible packaging issues. None are API-shape problems.
Documented in `paykit-wasm/README.md` and in the unfiled draft
`docs/upstream-issue-draft.md` on `feat/wasm-binding`:

1. **getrandom** backends (0.3 `wasm_js` + cfg; 0.2 `js`).
2. **`snow` 0.10.0** default feature `"ring/std"` force-enables optional
   `ring` (C, no stock-Apple-clang wasm32). Correct spelling is weak dep
   `"ring?/std"`. Vendored one-line fix. Belongs upstream at `mcginty/snow`.
3. **`uuid`** `v4` needs an explicit RNG feature on wasm32 (`uuid/js`).
4. **`pubky` 0.8.0** omits `reqwest/stream` on its wasm32 dependency line,
   so `Response::bytes_stream()` does not compile.

Whether a wasm binding crate, wasm32 CI, an npm package, and browser e2e
belong in paykit-rs are asks 6a–6d. The draft issue is unfiled.

Receiver-path constraint we hit: `paykit-lib` (`paykit-lib/src/receiver.rs`)
requires the runtime segment to be `wallet` or `server`. Publishing
`marketplace/web` is a validation error
(`PaykitReceiverPath runtime segment must be 'wallet' or 'server', got '{runtime}'`).
The browser runtime holds the receiver Noise key itself, so we publish
`marketplace/wallet`. The plan originally said `marketplace/web`; that
example is invalid against current paykit-lib. What is the supported naming
for a non-wallet browser runtime?

---

## 7. What we built around Paykit, and why

Fiat (Stripe, PayPal IPN, Shippo shipping labels) lives in the marketplace
transaction service and in `pubky-fiat-verifier`, **not** in Paykit Server.

For Locks-guarded USD entitlements, Lock Server `[paykit] server_url` points
at the fiat verifier. That service mirrors the paykit-server wire contract
(`POST /invoices`, `POST /transactions/status`, same signed-body auth),
proxies BTC verbatim (original body + `X-Paykit-Signature`) to the real
paykit-server, and settles USD itself.

We considered putting processors inside paykit-server and rejected it. From
`docs/ecommerce/fiat-rails-design.md` §2 option B, verbatim:

> **B. Extend paykit-server with fiat processors.** Same wire contract by
> construction, but it means forking/patching upstream `paykit-server` (the
> `CriterionAsset` BTC pin at `domain/invoice.rs:63-68` plus everything
> downstream of it assumes bitcoin base units and Electrum). Paykit
> Server's internals — Electrum watchers, receiver paths, delivery via
> Paykit directories — are Bitcoin-shaped; fiat would be a parallel code
> path grafted into a codebase we do not own. Rejected: higher coupling,
> upstream PR required, no benefit over A.

Two consequences for you to weigh:

1. **Semantic misnomer.** A Stripe-settled entitlement still records
   `verifier_type: "paykit-payment"` on the Locks wire, because
   `VerifierType` is a closed enum (`dev-static` / `paykit-payment`) and
   unknown values fail deserialization. Trust is the Lock Server key and
   the configured URL, not the label — but the audit trail names the wrong
   system. Proposed remedy: a generic `external-payment` verifier type, a
   parallel `[external_payment]` config section, and verifier-owned
   finality (`final` rather than synthesized `confirmations`). Draft
   (unfiled) at `docs/ecommerce/upstream-proposals/locks-fiat-verifier.md`
   in the marketplace app repo. That proposal is for **Locks**, not for
   paykit-server. It explicitly does not recommend extending Paykit Server
   to multi-asset. Flagging it here so Paykit and Locks do not design past
   each other on the wire label. No Paykit code change is required for it.

2. **Paykit Server accepts only `asset: "BTC"`** (exact uppercase),
   `paykit-server/src/domain/invoice.rs` `CriterionAsset::parse`. Fiat-priced
   listings cannot take the BTC rail without a USD→sats decision we have
   not implemented. Locks already accepts any non-empty `asset` string.
   Question: is multi-asset ever planned for paykit-server, or is the
   verifier-gateway pattern the intended permanent seam?

---

## 8. Open and unresolved

### 8.1 Noise message slot index 1

Observation, not a diagnosis. Source:
`BitcoinErrorLog/pubky-payment-rails` `docs/wallet-leg.md`.

On the deployed server, noise channels showed a gap at slot index 1 (two
independent channels). `pubky-noise`’s `receive_messages` treats a 404 at
the read counter as “no more messages”, so slots ≥ 2 are never read. A
filler write to the missing slot restored forward progress. A later
wallet-leg run (the 2026-08-22 finality run)
did **not** need the workaround. Root cause is **unconfirmed**. It might be
paykit-server outbox writing, pubky-noise read-stop semantics, or something
in the deployed homeserver. We need your eyes; we do not have a
reproducer we trust enough to call a bug report.

### 8.2 Guarded-content 404

A day-old guarded upload under `/priv/locks.app/content/` answered 404
despite a valid credential; re-uploading the same bytes restored the
pinned hash and the read. The Lock Server does not hold those bytes in
process memory — it writes them to the creator homeserver and re-reads via
an imported creator session.

A targeted `/priv` durability probe
(`src/test/live/priv-durability-probe.live.ts` in the marketplace client)
has since passed: three files written to the identity’s own `/priv` tree
stayed byte-identical by BLAKE3 at T+1h and T+1day (~25h, seeded
2026-08-28T09:09:26Z, check completed 2026-08-29T10:13Z). Because the probe
wrote under `/priv/pubky.app/durability-probe/` rather than
`/priv/locks.app/`, it tests the homeserver storage engine, not the locks
subtree, across a window that spanned **no Lock Server redeploy** — and
redeploy was the leading suspected trigger for the original 404. (The
deploy history weakens that suspicion without clearing it: the last Lock
Server deploy before the 404 was 2026-08-21 14:03 UTC+1 and the 404 was
observed 2026-08-22, but whether the vanished object was written before
or after that deploy is unrecorded — so redeploy remains an untested
suspect, not a proven trigger.) The
staging homeserver’s `/priv` durability is exonerated for that window.
That does not distinguish the Lock Server’s imported-creator-session /
serve layer from redeploy-triggered loss. The original 404’s root cause
is **still not proven**.

### 8.3 Locks pin

`ba49a777` is 8 commits behind `pubky/locks` `origin/master` in our
checkout. `e6a2027f3005` “fix(paykit): consume server-issued companion
handles (#38)” is in that window and is in your lane. We have not rebased
the pin.

### 8.4 Review status

No independent security review has been performed on this integration, on
the forks, or (as you already document) on paykit-rs itself. Pre-1.0.
Regtest coins only. That is not a request to review us; it is the bound on
every claim above.

---

## 9. What we are not asking for

What you can ignore: `BitcoinErrorLog/pubky-noise`. That repository is
deprecated (its own README, June 2026). It has no shared git history with
official `pubky/pubky-noise` (`git merge-base` fails). It is not
interoperable: `ChaChaPoly_BLAKE2s` vs official `ChaChaPoly_SHA256` (as
used by Encrypted Links / `DataLinkContext` in the wasm binding), different
prologue (`pubky-noise-v1`), direct TCP vs homeserver outbox. Local commit
count is 87. The marketplace does **not** use it. Messaging uses official
`pubky-noise` (crates.io `0.1.0-rc5`) indirectly through vendored
paykit-wasm.

**Our marketplace specs fork contains zero Paykit references.** No payment
endpoint records, no Paykit private-list shapes, no Paykit receipt blobs
(`rg -i paykit` over `BitcoinErrorLog/pubky-app-specs` is empty). Portable
order receipts and purchase attestations are service-signed JWS
(`pubky-order-receipt+v1`, `pubky-drop-edition+v1`), a separate concern
from Paykit receipts. Optional question: are Paykit-verifiable payment
receipts linkable to an external order id ever planned? We are not blocked
on that.

---

## 10. Asks

Each item is a real question. “Not now” is a valid answer.

1. **Wallet-interop trio.** Will current `pubky/paykit-server` advertise
   network-correct identifiers, lowercase `"btc"`, and JSON
   `{"value":"<address>"}` payloads on non-mainnet? If master already does,
   we will drop the corresponding fork diff on the next rebase.

2. **Demo-reader fidelity.** Will `paykit-reader-demo` (and e2e) reject the
   shapes production wallets reject, so a recurrence of (1) cannot go
   green? Our own `1f154610` does not solve this class of problem either:
   it hardcodes `BITCOIN_ENDPOINT = "btc-regtest-p2wpkh"` with a comment
   that the demo validates regtest instructions — the same single-network
   coupling, inverted.

3. **Multi-trusted-signer.** Does optional `[marketplace] trusted_public_key`
   (or a generic second signer) belong upstream, or should signed business
   routes stay single-key (Lock Server only)?

4. **Marketplace-initiated payment requests.** Does
   `POST /v0/payment-requests` (lock-free, terms in the signed body) belong
   in paykit-server, or is “only Lock Server creates invoices” the intended
   invariant?

5. **Manual watch-only claims.** Is `POST /v0/accounts/claim` (AuthToken →
   relay → session, no companion binary) in scope for browser/server
   sellers, or should watch-only setup remain Bitkit-companion-only?

6a. **wasm crate.** Do you want a first-class `paykit-wasm` crate in
    paykit-rs? The draft issue is `docs/upstream-issue-draft.md` on
    `feat/wasm-binding`. We have not filed it.

6b. **wasm32 CI.** Do you want wasm32 CI on paykit-rs itself?

6c. **npm package.** Do you want an official npm package for the binding?

6d. **browser e2e.** Do you want browser e2e in paykit-rs CI?

7. **`__proto__` map keys.** Will you take `24ed3a0` (`define_property`
   instead of `Reflect::set` in identifier→payload maps) independently of
   (6a–6d)?

8. **pubky-core routing.** Will you route the §5 wasm write-abort / leftover
   pkarr / CAS patches to pubky-core, or do you want them as a paykit-rs
   `vendor`/`patch` story until 0.11 is shown to contain them? Unproven
   whether 0.11 already fixed any of this.

9. **BTC-only `CriterionAsset` vs verifier gateway.** Same question as the
   close of §7.

10. **Receiver-path naming.** Same question as the close of §6.

11. **Noise slot-1 gap.** Does the observation in §8.1 match anything you
    already know about outbox slot assignment or `receive_messages` 404
    semantics? We are not attaching a failing test; the second live run did
    not reproduce it.
