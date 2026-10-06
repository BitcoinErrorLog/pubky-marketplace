# Locks surface as used by the Pubky Marketplace

**To:** maintainers of `pubky/locks`
**From:** the Pubky Marketplace integration (forks under `BitcoinErrorLog`)
**Date:** 2026-09-01
**Status:** technical brief. Not a PR, not a demand list. Every SHA below was
checked with `git cat-file -e <sha>^{commit}` in the checkout named for that
row. `pubky/locks` SHAs were checked in a clean clone of
`https://github.com/pubky/locks.git` detached at the deployed pin; a fresh
clone of that repo fetches every cited Locks SHA. There is no
`BitcoinErrorLog/locks` fork.

This document assumes you have not seen the marketplace. It covers only the
Locks surface: what we run, how we call you, what we built around your
Paykit verifier, what looks like yours to fix, and what you can ignore.

Nothing here has had an independent security review. Locks is pre-1.0
(`v0.1.0-rc2` is the current `origin/master` tag). Bitcoin is **regtest
only**. Where a cause is unproven, it is labeled that way.

Related: the Paykit brief in the same folder, for paykit-server /
paykit-rs items that sit next to this path.

---

## 1. What we run

A staging marketplace (client at `https://shop.pubky.app`) buys and sells
over three settlement rails. Digital Locks-guarded listings (Bitcoin and
USD) go through one Lock Server. Physical-goods Bitcoin does not. We do
not fork Locks.

| Piece | Git | Branch / pin | What it is |
| --- | --- | --- | --- |
| Lock Server (deployed) | `pubky/locks` **(no fork)** | detached at `ba49a777a94db318ec6ebd427315080a5b904645` (“fix: docker local dev setup env generation (#9)”, 2026-08-03) | Clean upstream clone, working tree clean. Railway image clones this revision at build time. |
| `pubky/locks` `origin/master` | same repo | `1329f16771dd78b4b5f1de41483a8cd158d95404`, tag `v0.1.0-rc2` | **8** commits ahead of the pin. All eight are on `origin/master` (`git ls-remote` + `git merge-base --is-ancestor`). |
| Staging rails | `BitcoinErrorLog/pubky-payment-rails` | `master` `a4d70c893c0e89597a31a6c7b65536a7fed9633a` | Railway project `pubky-marketplace-staging`. `locks-server/Dockerfile` `ARG LOCKS_REV=ba49a777…` with a fail-closed `test "$(git rev-parse HEAD)" = "$LOCKS_REV"`. |
| Client-vendored WASM | `BitcoinErrorLog/pubky-app` | app `64cb7aee23f4762c995c5ae1b16eef37346c9e10` (`marketplace/pr25-ux`); WASM from locks pin `ba49a777…` | Built from `locks-sdk/bindings/js`. Provenance: `docs/ecommerce/locks-sdk-provenance.md`. Used for `BundleId.generate()` only. |
| Fiat verifier | `BitcoinErrorLog/pubky-fiat-verifier` | `master` `e379bd99073735380c4c84d87e8fb1d228a5727b` | Sits at Lock Server `[paykit] server_url`. New service, no upstream. |
| Transaction service | `BitcoinErrorLog/pubky-marketplace-service` | `main` `0fd9b45737a8dd2bb35afff4156526ea616ca41e` | Stores an encrypted Locks correlation. Does not advance payment on registration. |
| Paykit Server (BTC target) | `BitcoinErrorLog/paykit-server` | deployed `98f7c2251e5eabf1d7b14704dcdababf25499c53` | Fork of `pubky/paykit-server`. Locks is not on the physical-goods invoice path; see the Paykit brief. |

Live Railway facts, re-checked 2026-09-01. Both deploy timestamps
below were read from the Railway deploy history (dashboard/API) on
2026-09-01; they appear in no git artifact and are not reproducible
from any repo.

- Last **SUCCESS** `locks-server` deploy: `2026-08-21T13:03:06.045Z`
  (14:03 UTC+1).
- Last **SUCCESS** `fiat-verifier` deploy: `2026-08-22T07:44:59.398Z`
  (08:44 UTC+1). Whether that image is byte-identical to
  `e379bd99` is **unproven** (timestamp is consistent with the
  08:29 UTC+1 commit on `origin/master`; we did not hash the running
  container).
- Live `LOCKS_PAYKIT_SERVER_URL=http://fiat-verifier.railway.internal:3002`.
  The Railway entrypoint writes that value into `[paykit] server_url`
  (`locks-server/entrypoint.sh` in the rails repo). That hostname is
  Railway-internal DNS, non-routable from the public internet.

Config roles (names only; no values):

| Name | Role |
| --- | --- |
| `LOCKS_PAYKIT_SERVER_URL` | Injected as Lock Server `[paykit] server_url`. Currently the fiat-verifier origin above. |
| `LOCKS_PAYKIT_MIN_CONFIRMATIONS` | Injected as `[paykit] minimum_confirmations` (default 1). |
| `LOCKS_SERVER_URL` | Marketplace service: Lock Server base URL for proof-bundle and lookup HTTP. |
| `LOCKS_BUNDLE_ENCRYPTION_KEY` | Marketplace service: XChaCha20-Poly1305 key for bundle ids at rest. |
| `LOCKS_LOOKUP_HMAC_KEY` | Marketplace service: HMAC-SHA256 lookup token; required to differ from the encryption key. |
| `PUBKY_LOCK_DATABASE_URL` | Lock Server Postgres (creator authority, tasks). |
| `PUBKY_LOCK_CREATOR_AUTH_ENCRYPTION_KEY` | Lock Server: encrypts creator-authority secrets at rest. |
| `LOCKS_KEYPAIR_SEED` / `LOCKS_PUBLIC_KEY` | Lock Server signing identity. Names only. |

The three marketplace `LOCKS_*` values are all-or-nothing. The service
fails closed at startup on a partial set and refuses
`payment.register_locks` when they are absent.

---

## 2. The pin vs `v0.1.0-rc2`

We run `ba49a777`. We have not rebased the pin. Local `origin/master` is
these eight commits ahead, oldest last:

| SHA | Subject |
| --- | --- |
| `1329f16771dd78b4b5f1de41483a8cd158d95404` | chore(release): prepare v0.1.0-rc2 (#40) |
| `e6a2027f30050e5268ff501f0a4bb7f077adee77` | fix(paykit): consume server-issued companion handles (#38) |
| `8502ef79c443c640976a2a901b80c5e717319149` | chore(release): prepare v0.1.0-rc1 (#37) |
| `7a525b8115c951950baa93e236a9e911df4430eb` | feat: dependencies update (#34) |
| `4fec58b037314768be4fa35d3b5561d7ddfd165d` | Feat/paykit payment lock demo (#10) |
| `808ee4638cc6fc4206cd15c0d94377bc4331bbbe` | fix(connect): match the embedded shell to the app modal (#27) |
| `5d4b6a8a452d8edd5d38351851cc7f22bb37854c` | chore(deps): bump @synonymdev/pubky (#13) |
| `6b0365da8389e69b69c928cbb25b062893afad3b` | chore(deps): bump the compatible-updates group across 1 directory with 5 updates (#26) |

`#38` is in your lane. At `origin/master` it requires
`paykit.server_url` to be an exact HTTP(S) origin: no credentials, path,
query, fragment, or trailing slash. Config load
(`locks-server/src/config/raw.rs` at master, `into_paykit_config`) and
the HTTP client (`locks-server/src/paykit_http_client.rs` `parse_server_url`)
both compare `parsed.origin().ascii_serialization()` to the configured
string. Tests reject `http://127.0.0.1:3001/`, a path, a query, a
fragment, and `user:password`. They accept `http://127.0.0.1:3001`.
ADR 0020 at master states, after that commit:

> Configured Paykit `server_url` is a canonical exact HTTP(S) origin
> without credentials, path, query, fragment, or trailing slash; endpoint
> paths are appended only after validation.

At the pin we actually run, that check does **not** exist. Pin-era
`parse_server_url` accepts any `http`/`https` URL, and pin-era tests
preserve a path prefix (`endpoints_preserve_server_url_path_prefix_…`
in `paykit_http_client.rs`).

Our staging value `http://fiat-verifier.railway.internal:3002` is an
origin of the same shape as the value the master tests accept (scheme +
host + non-default port, no path or slash). Whether a Lock Server built
from `v0.1.0-rc2` / `#38` **boots** in this Railway project with that
value — and with the rest of `#38` (companion-handle consumption, demo
wiring) — is **untested**.

---

## 3. How the marketplace consumes Locks

Seller publish goes through Lock Server creator APIs (legacy-connect
frontend session, then guarded-resource PUT). Buyer payment of a
Locks-guarded listing:

1. Client submits a proof bundle `POST {locks}/proof-bundles`
   (`src/core/services/locks/locks.ts` in `BitcoinErrorLog/pubky-app`
   at `64cb7aee23f4762c995c5ae1b16eef37346c9e10`). The body is a v1
   bundle with
   `verifier_type: "paykit-payment"` and an empty payload.
2. Transaction service command `payment.register_locks` stores an
   encrypted correlation (XChaCha20-Poly1305 ciphertext, payment id as
   AEAD associated data, HMAC-SHA256 lookup token). Registration does
   **not** advance payment. It flips the payment onto the `locks`
   adapter and refuses sandbox advancement from then on.
3. A worker polls `POST /verification-task-lookups` and advances
   `awaiting_entitlement → confirmed` exactly once when Locks reports
   `completed`.
4. Delivery is a credentialed read
   `GET /priv-resources/content/…` with `Authorization: Bearer`
   (`locks.ts`, `fetchGuardedContent`).

ADR 0019 §7 in the marketplace app repo states, verbatim:

> Only the configured Lock Server may call signed Paykit Server business
> routes. Pubky App and the Marketplace Transaction Service do not call
> them directly.

There is a disclosed contradiction on a **different** path: physical-goods
Bitcoin orders. The transaction service POSTs `/v0/payment-requests` to
paykit-server as a second trusted signer. That is a Paykit-brief item.
Locks is not on that invoice path. Digital Locks-guarded payments still
match the ADR: the Lock Server is the only signer of
`POST /invoices`.

Client WASM: the vendored `@pubky/locks-sdk` at `ba49a777` is loaded
lazily and used for `BundleId.generate()` only. Viewer network calls
use raw HTTP to `PUBKY_RUNTIME_LOCKS_URL` because `Locks.forServer`
parses a `LockServerPubky` (`locks-sdk/bindings/js/src/locks.rs:191-199`
at the pin and at `origin/master`). An HTTP URL is not a pubky; the
error path is `invalid lock server pubky`. The provenance document
records that `forServer('http://…')` throws that error. This app is
fail-closed on an explicit Lock Server URL and will not send payment-rail
traffic to whatever endpoint a pkarr record names.

---

## 4. The `verifier_type` misnomer, and the gateway behind `[paykit]`

USD listings are settled by Stripe test-mode / PayPal sandbox. We did
not put processors inside paykit-server (see the Paykit brief §7). For
Locks-guarded USD entitlements, `[paykit] server_url` points at
`pubky-fiat-verifier`.

That service mirrors the Paykit Server wire contract Locks already
calls:

- Auth: exactly one `x-paykit-signature` header, ed25519 over the raw
  body, body must be RFC 8785 canonical JSON, payload types reject
  unknown fields (`src/auth.rs` at `e379bd99`: header/signature
  `21-49`, canonical parse `53-65`).
- Locks-facing routes: `POST /invoices`, `POST /transactions/status`.
- Gateway-native: `POST /checkout-sessions`, `POST /webhooks/stripe`,
  `POST /webhooks/paypal`, `GET /health` (`src/http.rs:3-12,72-81`).

BTC dispatch (`src/http.rs:128-138`): if the criterion asset is the
exact string `"BTC"`, the gateway forwards the original body and the
original signature verbatim to real paykit-server (`src/proxy.rs`). No
gateway key on that path. Any other spelling, including `"btc"`, misses
this branch.

USD: local persistence; Stripe test-mode / PayPal sandbox settlement.
Webhooks are hints. Status is advanced only by processor API pulls
(`src/verification.rs`, module comment: “The pull-is-truth core”).
Fiat status mapping (`src/state.rs`):

| internal | reported to Locks |
| --- | --- |
| created / reversed | `undetected`, confirmations `0`, `amount_matched: false` |
| paid, inside settlement delay | `detected`, `0`, `amount_matched` |
| paid, delay elapsed | promotion due: paid AND delay elapsed AND amount matched; a fresh API re-pull must still say paid |
| confirmed | `confirmed`, `confirmations` = `FIAT_SYNTHESIZED_CONFIRMATIONS` (default 1), `amount_matched: true` |

That last row is what satisfies Locks
`payment_status_satisfies`
(`locks-service/src/infrastructure/verifiers/paykit_payment.rs:93-101`
at the pin **and** at `origin/master`): `amount_matched` plus either
`(minimum_confirmations == 0 and detected|confirmed)` or
`(confirmed and confirmations >= required)`.

`VerifierType` is a closed two-variant serde enum at the pin and at
`origin/master` (`locks-core/src/lock_policy.rs:309-314`):
`dev-static`, `paykit-payment`, kebab-case wire, no catch-all. Test
`content_lock_rejects_unknown_verifier_type` (`:835-842`) asserts
unknown values fail deserialization. A Stripe-settled entitlement
therefore records `verifier_type: "paykit-payment"`. Trust is the Lock
Server key and the configured URL, not the label. The audit trail names
the Paykit verifier for a payment Paykit Server never saw.

`validate_paykit_payment_params` (`lock_policy.rs:380-426`) requires
`asset` only non-empty. Locks itself accepts `"BTC"`, `"btc"`,
`"USD"`. The exact-uppercase-`"BTC"` constraint is paykit-server’s
(`paykit-server/src/domain/invoice.rs` at deployed pin `98f7c225`:
`CriterionAsset::parse` at `:63-68`; the message `"criterion asset
must be exact uppercase BTC"` is `CriterionAssetError::UnsupportedAsset`
at `:81`).

---

## 5. The `external-payment` proposal (draft, not filed)

Draft only. Status in the source doc is “DRAFT — NOT SENT”. We have not
filed it.

Public URL (commit `64cb7aee23f4762c995c5ae1b16eef37346c9e10` of
`BitcoinErrorLog/pubky-app`):
https://github.com/BitcoinErrorLog/pubky-app/blob/64cb7aee23f4762c995c5ae1b16eef37346c9e10/docs/ecommerce/upstream-proposals/locks-fiat-verifier.md

Substance:

- Add `VerifierType::ExternalPayment` (wire `"external-payment"`).
  Existing `dev-static` / `paykit-payment` untouched. Closed-enum
  unknown-reject stays.
- Params same as `paykit-payment`, plus optional presentational
  `display_asset_exponent`.
- Parallel `[external_payment] server_url` config, reusing the same
  signing HTTP client.
- Status contract without `confirmations`:
  `{status: undetected|detected|final, amount_matched}`, satisfied iff
  `final && amount_matched`.
- `POST /invoices` dispatch extended to the new type.

The draft explicitly does not recommend multi-asset inside
paykit-server. Flagged here so Locks and Paykit do not design past each
other on the wire label. No Paykit code change is required for it.

---

## 6. Guarded-content 404 (root cause unproven)

Quoted from `BitcoinErrorLog/pubky-payment-rails` `docs/wallet-leg.md`
at `a4d70c893c0e89597a31a6c7b65536a7fed9633a` (the current text; an
earlier revision of that file is obsolete):

> New operational finding: yesterday's guarded upload was gone (404 on
> read despite a valid credential). Re-uploading the original 45-byte body
> reproduced the
> lock's pinned hash exactly, after which the credentialed read returned
> the content. A later `/priv` durability probe (2026-08-28 →
> 2026-08-29, ~25h, three files under `/priv/pubky.app/durability-probe/`,
> BLAKE3-verified green at T+1h and T+~25h) exonerated the staging
> homeserver's `/priv` storage engine for that window — but the window
> spanned no Lock Server redeploy, and the probe wrote to
> `/priv/pubky.app/`, not `/priv/locks.app/`. Remaining suspects are the
> Lock Server's imported-creator-session/serve layer and
> redeploy-triggered loss; the original 404's root cause is still not
> proven. Railway's last locks-server deploy before the 404 was
> 2026-08-21 14:03; the 404 was observed 2026-08-22; whether the vanished
> object was written before or after that deploy is unrecorded, so
> redeploy is an untested suspect, not a proven trigger. Re-publishing
> restores service; that is an operator note, not a cause.

The 404 itself was 2026-08-22. Probe seed `2026-08-28T09:09:26Z`, check
completed `2026-08-29T10:13Z`, three files, BLAKE3-verified. Probe
source: `src/test/live/priv-durability-probe.live.ts` in
`BitcoinErrorLog/pubky-app` at `64cb7aee`. That probe authenticates as
`saved.buyerA` from the marketplace staging drop identities file
(`:86-97`); it is a marketplace test/buyer identity, not the creator
whose guarded content 404’d. The 404’d bytes belonged to the
driver-held creator identity recorded in `wallet-leg.md`
(`86xyamrh…zr9go` at rails `a4d70c8`). The two are not the same
identity; the probe did not test same-identity `/priv/locks.app/` vs
`/priv/pubky.app/` durability. Railway’s last SUCCESS `locks-server`
deploy before that 404 is the `2026-08-21T13:03:06.045Z` row in §1.

Serve mechanism at the pin: Lock Server writes guarded bytes to the
creator homeserver and re-reads them via an imported creator session.
`PubkyImportedSession` wraps `pubky::PubkySession`
(`locks-service/src/infrastructure/pubky/storage_client.rs:249-270`).
Creator-authority secrets live in Postgres
(`locks-service/src/infrastructure/postgres/creator_authority.rs`; table
`creator_authorities`). The server does not hold guarded bytes in
process memory. A unit test shows the **Postgres record** survives
store-handle recreation (`record_survives_store_recreation_…`). That is
not a live process-replace proof against `/priv/locks.app/`.

Root cause of the original 404 is **still not proven**.

---

## 7. Homeserver write denial surfaced as HTTP 500

When a creator storage PUT fails because the homeserver denies the
write (`403 Write to this path is not allowed` — a homeserver
write-path allowlist on `allowed_write_paths`, not a Locks policy
decision), the Lock Server surfaces it as HTTP 500. The recorded 403
observation was on public creator paths during publish
(`/pub/locks.app/**`, `/pub/pubky.app/**`); it is not a `/priv`
finding and is not the §6 guarded-content 404. The 500 mapping:

- SDK put failure → `pubky_storage_error` →
  `ApplicationError::Storage`
  (`locks-service/src/infrastructure/pubky/storage_client.rs:319-329`
  for `put_bytes`, mapper `541-551`).
  Private Locks paths redact the inner error.
- `ApplicationError::Storage { .. }` maps to
  `ApiErrorCode::InternalError` / HTTP 500
  (`locks-server/src/api/errors.rs:225-236`, status at `:94`).

No 403 mapping exists for homeserver write denial.
`EntitlementNotAuthorized` is HTTP 403 (`errors.rs:73`) on a different
path: missing/unsatisfied entitlement and content-lock hash mismatch
(`:203-208`).

The isolation of that 403 as a homeserver allowlist (not Locks) is a
documentary claim in `wallet-leg.md` (“isolated with a direct
delegated-session probe”). No probe script survives. The isolation
method is **documentary**. Homegate-provisioned `allowed_write_paths`
themselves belong to the core/homeserver brief, not this one.

---

## 8. Open and unresolved

### 8.1 Pin drift

§2. We have not absorbed `#38` or `v0.1.0-rc2`.

### 8.2 Guarded-content 404

§6. Unproven.

### 8.3 SDK configured-endpoint gap

§3. Viewer flows stay on raw HTTP until `Locks.forServer` (or an
equivalent) accepts an explicit HTTP origin.

### 8.4 Review status

No independent security review has been performed on this integration
or on the gateway. Pre-1.0. Regtest coins only. That is not a request
to review us; it is the bound on every claim above.

---

## 9. What we are not asking for

What you can ignore:

- The Noise message slot-1 gap is not a Locks finding. `git grep -i
  noise` on this pin hits only the `synchronoise` crate name in
  `Cargo.lock`. See the Paykit brief.
- Companion claim, Bitkit identifier/payload filters, and the
  stale-Electrum locktime incident are wallet / paykit-server items.
  See the Paykit brief.
- paykit-rs wasm work, `BitcoinErrorLog/pubky-noise`, and Hypercolor
  do not involve Locks source.
- `CriterionAsset` exact-uppercase `"BTC"` is paykit-server’s. Locks
  already accepts any non-empty `asset` string.
- The Railway entrypoint and the local compose overlay inject
  `[paykit] server_url` from `LOCKS_PAYKIT_SERVER_URL`. They do not
  patch Locks source.
- A local clone of `BitcoinErrorLog/pubky-app` on
  `marketplace/pr15-locks-sdk` (directory name `mp-locks`) is not a
  Locks source tree.

---

## 10. Asks

Each item is a real question. “Not now” is a valid answer.

1. **Support baseline.** Should our Lock Server pin stay `ba49a777`, or
   rebase to `v0.1.0-rc2` (`1329f167`) first?

2. **`#38` origin validation.** Does the exact-origin
   `paykit.server_url` rule cover an HTTP origin on private internal
   DNS (scheme + host + port, no path), or is that deployment class
   outside what you document?

3. **`external-payment`.** Do you want an additive
   `VerifierType::ExternalPayment` (wire `"external-payment"`) plus a
   parallel `[external_payment]` config, or is `paykit-payment` behind
   an operator-chosen gateway the intended permanent contract? The
   draft in §5 is unfiled.

4. **Finality shape.** For non-Bitcoin verifiers, do you want
   verifier-owned `final` (no `confirmations` field), or is
   synthesizing `confirmations` against `[paykit] minimum_confirmations`
   the contract you want to keep?

5. **Homeserver write denial.** Does a homeserver `403` on creator PUT
   belong on HTTP 403 (a new code, or reuse of an existing one) rather
   than 500 / `internal_error`?

6. **Locks-subtree 404.** Do you know a serve / imported-session
   failure mode that would 404 `/priv/locks.app/` content the Lock
   Server itself wrote, while direct owner-session `/priv` reads by a
   separate identity stay durable?

7. **Process replace.** Do imported creator sessions and credentialed
   guarded reads survive a Lock Server process replace against the same
   Postgres, or is re-publish expected after replace?

8. **SDK endpoint.** Is a configured HTTP origin (non-pkarr) Lock
   Server endpoint in scope for the JS/WASM SDK?
