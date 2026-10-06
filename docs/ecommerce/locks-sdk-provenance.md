# Locks SDK Build Provenance

The Pubky Locks browser SDK is not published to npm. It is built from source at a pinned commit and vendored into this repository, then loaded through a dynamic import so the WASM module never enters a server-rendered module graph. This file records the provenance of the build so it is reproducible and auditable.

Reproduced: 2026-08-20. Vendored: 2026-08-20.

## Source

| Field           | Value                                         |
| --------------- | --------------------------------------------- |
| Repository      | `https://github.com/pubky/locks`              |
| Commit          | `ba49a777a94db318ec6ebd427315080a5b904645`    |
| Package path    | `locks-sdk/bindings/js`                       |
| Package name    | `@pubky/locks-sdk` (`private: true` upstream) |
| Package version | `0.1.0`                                       |
| License         | MIT                                           |

The commit matches the audited revision pinned in [`upstream-integration.md`](upstream-integration.md).

## Toolchain

| Tool              | Version                       |
| ----------------- | ----------------------------- |
| `wasm-pack`       | 0.13.1                        |
| `rustc`           | 1.89.0 (29483883e 2025-08-04) |
| Rust target       | `wasm32-unknown-unknown`      |
| Node (smoke test) | v22.14.0                      |

## Generation command

```bash
git clone https://github.com/pubky/locks.git
cd locks && git checkout ba49a777a94db318ec6ebd427315080a5b904645
cd locks-sdk/bindings/js
rustup target add wasm32-unknown-unknown
npm run build            # wasm-pack build --target web --out-dir pkg
node scripts/smoke-generated-api.mjs
```

## Artifact checksums

SHA-256 of the generated `pkg/` outputs:

| File                     | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `locks_sdk_wasm_bg.wasm` | `90e388d0cde26955bf384c2dc899e289efc24d71feb95f15976b7af3fdb21e06` |
| `locks_sdk_wasm.js`      | `c8d3ae13f0e556da906fc6adecc7a9c22afdf43037132275b9510c7896d8556e` |

Generated package size: ~1.2 MB. Note that `wasm-opt` output is not guaranteed bit-identical across platforms; treat these checksums as a record of this build, and re-record when the pin or toolchain changes.

## Vendoring mechanism

The generated `pkg/` output is committed verbatim at `vendor/locks-sdk-wasm/` and referenced from `package.json` as a `file:` dependency:

```json
"locks-sdk-wasm": "file:vendor/locks-sdk-wasm"
```

npm symlinks `node_modules/locks-sdk-wasm` to the vendored directory, so a fresh clone plus `npm ci` resolves the SDK with no extra steps and no network fetch from a mutable source. The vendored directory carries a `PROVENANCE.md` pointing back to this file, and is excluded from Prettier (`.prettierignore`) so the committed artifacts stay byte-identical to the recorded build.

Vendored files and their SHA-256 checksums (the `.js` and `.wasm` match the build record above):

| File                          | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `locks_sdk_wasm_bg.wasm`      | `90e388d0cde26955bf384c2dc899e289efc24d71feb95f15976b7af3fdb21e06` |
| `locks_sdk_wasm.js`           | `c8d3ae13f0e556da906fc6adecc7a9c22afdf43037132275b9510c7896d8556e` |
| `locks_sdk_wasm.d.ts`         | `91cc6bf29ed2e13fd248b68185b2b63d0fbbc1ec83f4d2739c157ff1dae98dae` |
| `locks_sdk_wasm_bg.wasm.d.ts` | `2dc0e05420095ef8a7992d07154c0702372b2dfd6664d436e729002e6c34dbf4` |
| `package.json`                | `c760bc271fbe85ad8d10bc48ccdec1f9cf869f369ece58102a18adbf046d66d6` |

Upstream's `pkg/.gitignore` (which ignores everything) is deliberately not copied.

### Re-vendoring

1. Rebuild from the pinned (or newly pinned) upstream commit using the generation command above.
2. Copy `pkg/package.json`, `locks_sdk_wasm.js`, `locks_sdk_wasm.d.ts`, `locks_sdk_wasm_bg.wasm`, and `locks_sdk_wasm_bg.wasm.d.ts` into `vendor/locks-sdk-wasm/` (never copy `pkg/.gitignore`).
3. Run `npm install` to refresh `package-lock.json`, then `node scripts/locks-sdk-smoke.mjs`.
4. Update the commit pin, toolchain table, and checksums in this file.

## Verification performed

- `npm run build` (upstream `wasm-pack` build) completed successfully.
- `node scripts/locks-sdk-smoke.mjs` passes against the vendored copy; CI runs it in `.github/workflows/build.yml` ahead of `next build`, so a regression in the generated API surface fails the build job.
- The generated API exposes the viewer surface the marketplace needs on `Locks.viewer`: `submitProofBundle`, `lookupVerificationTask`, `completeVerificationTask`, `issueAccessCredential`, and `proxyReadGuardedResource`, plus the creator surface (`Creator`, `CreateContentLockRequestBuilder`, `RegisterGuardedResourceOptions`, session/connect helpers).

`LocksGatewayService` (`src/core/services/locks/locks.ts`) uses this SDK for canonical identifier generation (`BundleId.generate()`), per the upstream guidance in `upstream-integration.md` ("do not create hand-written substitutes for Locks canonicalization, identifiers, proof payloads, credentials, or session handling") — the client's previous hand-rolled Crockford base32 generator is removed. The WASM module is loaded lazily via dynamic import on first use; `src/core/services/locks/locks.ssr.test.ts` proves it is never imported at module scope anywhere in the Locks call chain.

## SDK-backed vs raw HTTP — what is measured, not aspirational

| Flow                                                                              | Transport | Why                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle-id generation                                                              | SDK       | `BundleId.generate()` is pure WASM (no network): canonical Crockford base32 ids, usable from any context.                                                                                                                     |
| Proof-bundle submission, verification lookups, credential issuance, guarded reads | Raw HTTP  | See below — the SDK's viewer surface covers these APIs but cannot target a configured endpoint.                                                                                                                               |
| Frontend-session exchange (seller connect)                                        | Raw HTTP  | The SDK's `exchangeFrontendSessionCode` returns an opaque `Session` handle and never exposes the raw `session_token`/`creator` pair the connect flow consumes (to show who is connected and hold the bearer token in memory). |

The SDK's generated `Viewer` API does cover proof-bundle submission, verification-task lookups, access-credential issuance, and guarded proxy reads. The network routes nevertheless stay on the Lock Server's documented HTTP contract at the explicitly configured `getLocksUrl()`, for two measured reasons:

1. **The SDK has no configured-endpoint mode.** Its clients (`Locks.forServer`/`forCreator`/`forContentLock`) accept only pubkys and resolve the Lock Server's HTTP endpoint through pkarr; `LocksOptions` configures relays and nothing else (verified against the vendored `locks_sdk_wasm.d.ts` and by direct probing — `forServer('http://…')` throws `invalid lock server pubky`). This app's `locks-paykit` activation is fail-closed on an explicit `PUBKY_RUNTIME_LOCKS_URL`; routing payment-rail traffic to whatever endpoint a pkarr record names would bypass that operator decision.
2. **The SDK requires browser-usable domain endpoints in the resolved records.** The composed regtest environment — the only place real payments are live-verified — publishes compose-internal endpoints (`localhost:3000`, `127.0.0.1:6287`), unreachable from outside the compose network. Driving the viewer flows through the SDK was attempted post-vendoring and fails there with `PKARR record did not contain a browser-usable domain endpoint`, which would forfeit the live purchase proof (`npm run test:marketplace:locks`).

The HTTP surface in use (proof-bundle submission, lifecycle lookups, credential issuance, guarded proxy reads, frontend sessions) is live-verified against the pinned Lock Server revision by `npm run test:marketplace:locks`, which bounds the drift risk the SDK would otherwise eliminate. Moving the viewer routes onto the SDK requires upstream support for an explicitly configured Lock Server endpoint (or this app adopting pkarr-published lock servers with browser-usable domains, including in its verification environment).

## Remaining work before real payments can be exercised

Still open:

1. Move the viewer network routes onto the SDK once it supports an explicitly configured Lock Server endpoint (see the transport table above for why that is blocked today).

Done since this file was first written:

- ~~Vendor the generated `pkg/` and wire the smoke test into CI ahead of `next build`~~ — done: committed at `vendor/locks-sdk-wasm/`, `scripts/locks-sdk-smoke.mjs` runs in `.github/workflows/build.yml`.
- ~~Stop hand-minting Locks identifiers~~ — done: bundle ids now come from the SDK's `BundleId.generate()`.
- ~~Stand up the composed integration environment (Lock Server, Paykit Server, Bitcoin regtest, Electrum)~~ — done: the `payments-env` composed stack builds paykit-server from its pinned commit and proves the protocol leg with its own `verify.sh`.
- ~~Exercise the buyer flow end to end~~ — done on regtest with the wallet's protocol role simulated by the environment's real tooling (`paykit-companion-auth`, `paykit-reader-demo`); the real Bitkit app UX was proven live 2026-08-22 (companion claim, in-app Payment Request, swipe-to-pay). See [`status.md`](status.md) and [`RUNNING.md`](RUNNING.md).
