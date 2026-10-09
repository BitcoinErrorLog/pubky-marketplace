# Locks SDK Provenance

The Pubky Locks browser SDK is installed from npm as `@synonymdev/locks-sdk`, pinned to an exact release-candidate version, and loaded through a dynamic import so the WASM module never enters a server-rendered module graph. This file records where the artifact comes from so it is reproducible and auditable.

Previously the SDK was built from source at a pinned commit and committed under `vendor/locks-sdk-wasm` (`pubky/locks` `ba49a777`, 2026-08-20, because it was then unpublished). It is published now, so the vendored copy was replaced by the npm package: the registry tarball is integrity-pinned in `package-lock.json`, builds need no Rust toolchain, and re-pinning is a one-line dependency bump instead of a rebuild-and-copy.

## Source

| Field             | Value                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| npm package       | `@synonymdev/locks-sdk@0.1.0-rc10` (dist-tag `rc`; `latest` is still rc5 — never install by tag)  |
| Repository        | `https://github.com/pubky/locks`                                                                  |
| Package path      | `locks-sdk/bindings/js`                                                                           |
| Source commit     | `01cfeca14c7b5d385d8c3536c0cb4e1af81b458c` (`chore: prepare locks 0.1.0-rc10 (#78)`)              |
| Upstream tag      | `v0.1.0-rc10` (resolves to the same commit)                                                       |
| Published         | 2026-10-08                                                                                        |
| Tarball integrity | `sha512-0RAAxUgV2PsEFHulxeqAFwjYQ3nOIK9BCUqXsrL63V8wbfC3cCJ1B/GBDx92fYtAQ+Xsv2L9TEsG5iEbO5Fz2Q==` |
| License           | MIT                                                                                               |

The source commit is the `gitHead` field the registry records for the published version (`npm view @synonymdev/locks-sdk@0.1.0-rc10 gitHead`) and equals the upstream `v0.1.0-rc10` tag. The npm release carries no registry provenance attestation, so the commit link is the registry's recorded claim, not a signed one; the integrity hash in `package-lock.json` is what guarantees every install gets the same bytes.

The package build is `wasm-pack build --target web --out-dir pkg` (upstream `package.json` `build` script, run by its `prepack`).

## Installed artifact

`package.json` pins the exact version (no range) and `package-lock.json` records the tarball. Files under `node_modules/@synonymdev/locks-sdk/pkg/` and their SHA-256:

| File                          | SHA-256                                                            | Bytes     |
| ----------------------------- | ------------------------------------------------------------------ | --------- |
| `locks_sdk_wasm_bg.wasm`      | `02888fa14cd12cc6ae440014e736e9501ec40f10bfd8d3da739726fd160ac545` | 1,313,137 |
| `locks_sdk_wasm.js`           | `f44ee59fe14aa06bea75acb6b5583f88b4b7b7a132b4614f6d48ef35296d90ef` | 76,290    |
| `locks_sdk_wasm.d.ts`         | `5ca7f0aba5d7d4d747281525e60cbda6895907fc103bb29751295a28c4a0a589` | 15,765    |
| `locks_sdk_wasm_bg.wasm.d.ts` | `c7a9aca8c6bdfd6c8c25c775be87767c01f025f15c274963188a002b22b877ca` | 8,850     |

Size versus the replaced `ba49a777` vendored build: the `.wasm` grew from 1,114,311 to 1,313,137 bytes (+198,826, +17.8%; gzip 431,140 to 498,799 bytes) because rc10 carries more upstream surface (Paykit setup/connection-state lookups, `proxyReadGuardedResourceResponse`, `hasPaykitData`). The Shop calls only `BundleId.generate()`, whose API is unchanged. The WASM is still fetched lazily, only when a Locks operation runs in the browser, and is excluded from the service-worker precache.

## Re-pinning

1. Pick the target release tag from `https://github.com/pubky/locks/tags` and confirm it is published: `npm view @synonymdev/locks-sdk versions`.
2. `HUSKY=0 npm install --save-exact @synonymdev/locks-sdk@<version>` (always an explicit version; `latest` is not the release candidate line).
3. Confirm the source commit: `npm view @synonymdev/locks-sdk@<version> gitHead` equals the upstream tag's commit (`gh api repos/pubky/locks/git/ref/tags/v<version>`).
4. Run `node scripts/locks-sdk-smoke.mjs` and the Locks tests (`npx vitest run --project unit src/core/services/locks`).
5. Update the version, commit, integrity, and checksums in this file (`sha256sum node_modules/@synonymdev/locks-sdk/pkg/*`).

## Verification performed

- `node scripts/locks-sdk-smoke.mjs` passes against the installed package; CI runs it in `.github/workflows/build.yml` ahead of `next build`, so a regression in the generated API surface fails the build job.
- The generated API still exposes the viewer surface the marketplace needs on `Locks.viewer` (`submitProofBundle`, `lookupVerificationTask`, `completeVerificationTask`, `issueAccessCredential`, `proxyReadGuardedResource`) plus the creator surface and `BundleId`.

`LocksGatewayService` (`src/core/services/locks/locks.ts`) uses this SDK for canonical identifier generation (`BundleId.generate()`), per the upstream guidance in `upstream-integration.md` ("do not create hand-written substitutes for Locks canonicalization, identifiers, proof payloads, credentials, or session handling"). The WASM module is loaded lazily via dynamic import on first use; `src/core/services/locks/locks.ssr.test.ts` proves it is never imported at module scope anywhere in the Locks call chain. The SDK is never used for status reads or any other network route (see below), so it has no effect on compatibility with the Lock Server versions the Shop talks to over HTTP.

## SDK-backed vs raw HTTP — what is measured, not aspirational

| Flow                                                                              | Transport | Why                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle-id generation                                                              | SDK       | `BundleId.generate()` is pure WASM (no network): canonical Crockford base32 ids, usable from any context.                                                                                                                     |
| Proof-bundle submission, verification lookups, credential issuance, guarded reads | Raw HTTP  | See below — the SDK's viewer surface covers these APIs but cannot target a configured endpoint.                                                                                                                               |
| Frontend-session exchange (seller connect)                                        | Raw HTTP  | The SDK's `exchangeFrontendSessionCode` returns an opaque `Session` handle and never exposes the raw `session_token`/`creator` pair the connect flow consumes (to show who is connected and hold the bearer token in memory). |

The SDK's generated `Viewer` API does cover proof-bundle submission, verification-task lookups, access-credential issuance, and guarded proxy reads. The network routes nevertheless stay on the Lock Server's documented HTTP contract at the explicitly configured `getLocksUrl()`, for two measured reasons:

1. **The SDK has no configured-endpoint mode.** Its clients (`Locks.forServer`/`forCreator`/`forContentLock`) accept only pubkys and resolve the Lock Server's HTTP endpoint through pkarr; `LocksOptions` configures relays and nothing else (verified against the SDK's `locks_sdk_wasm.d.ts` and by direct probing — `forServer('http://…')` throws `invalid lock server pubky`). This app's `locks-paykit` activation is fail-closed on an explicit `PUBKY_RUNTIME_LOCKS_URL`; routing payment-rail traffic to whatever endpoint a pkarr record names would bypass that operator decision.
2. **The SDK requires browser-usable domain endpoints in the resolved records.** The composed regtest environment — the only place real payments are live-verified — publishes compose-internal endpoints (`localhost:3000`, `127.0.0.1:6287`), unreachable from outside the compose network. Driving the viewer flows through the SDK was attempted and fails there with `PKARR record did not contain a browser-usable domain endpoint`, which would forfeit the live purchase proof (`npm run test:marketplace:locks`).

The HTTP surface in use (proof-bundle submission, lifecycle lookups, credential issuance, guarded proxy reads, frontend sessions) is live-verified against the pinned Lock Server revision by `npm run test:marketplace:locks`, which bounds the drift risk the SDK would otherwise eliminate. Moving the viewer routes onto the SDK requires upstream support for an explicitly configured Lock Server endpoint (or this app adopting pkarr-published lock servers with browser-usable domains, including in its verification environment).

## Remaining work before real payments can be exercised

Still open:

1. Move the viewer network routes onto the SDK once it supports an explicitly configured Lock Server endpoint (see the transport table above for why that is blocked today).

Done since this file was first written:

- ~~Get the SDK into the build reproducibly and wire the smoke test into CI ahead of `next build`~~ — done: exact-pinned `@synonymdev/locks-sdk` from npm (initially a vendored source build), `scripts/locks-sdk-smoke.mjs` runs in `.github/workflows/build.yml`.
- ~~Stop hand-minting Locks identifiers~~ — done: bundle ids now come from the SDK's `BundleId.generate()`.
- ~~Stand up the composed integration environment (Lock Server, Paykit Server, Bitcoin regtest, Electrum)~~ — done: the `payments-env` composed stack builds paykit-server from its pinned commit and proves the protocol leg with its own `verify.sh`.
- ~~Exercise the buyer flow end to end~~ — done on regtest with the wallet's protocol role simulated by the environment's real tooling (`paykit-companion-auth`, `paykit-reader-demo`); the real Bitkit app UX was proven live 2026-08-22 (companion claim, in-app Payment Request, swipe-to-pay). See [`status.md`](status.md) and [`RUNNING.md`](RUNNING.md).
