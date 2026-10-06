# paykit-wasm Build Provenance

The paykit-wasm browser binding — the Paykit Encrypted Link messaging surface compiled to WASM — is not published to npm. It is built from source at a pinned commit and vendored into this repository, then loaded through a dynamic import so the WASM module never enters a server-rendered module graph. This file records the provenance of the build so it is reproducible and auditable.

Vendored: 2026-09-05 (rc50, picking up the homeserver write-abort fixes and additive endpoint/SB2 surfaces; see the rc44 → rc50 summary below). The five vendored artifacts are byte-identical to `paykit-wasm/pkg` at the pinned commit — verified on copy by hashing the git blobs at the pin (`git show d4a73a57…:paykit-wasm/pkg/<file> | shasum -a 256`) against the files on disk; all five SHA-256 values matched.

## Source

| Field           | Value                                                                          |
| --------------- | ------------------------------------------------------------------------------ |
| Repository      | `https://github.com/BitcoinErrorLog/paykit-rs-official`                        |
| Branch          | `fix/wasm-homeserver-write-abort`                                              |
| Commit          | `d4a73a5765e1f0b18ed451d78f98dab97c611a8c`                                     |
| Upstream        | `https://github.com/pubky/paykit-rs`                                           |
| Upstream pin    | `c8892f638951f033acbcd12804a31667a81ddc14` (tag anchor v0.1.0-rc43)            |
| Package path    | `paykit-wasm/pkg`                                                              |
| Package name    | `paykit-wasm`                                                                  |
| Package version | `0.1.0-rc50`                                                                   |
| License         | MIT                                                                            |
| Previous pin    | `0a6c6e4521fd41f5081ad9f074020f4813d8a03e` (`0.1.0-rc44`, `feat/wasm-binding`) |

The upstream pin matches the audited paykit-rs commit recorded in [`messaging/README.md`](messaging/README.md). The fork adds packaging-class fixes for the wasm32 target plus additive binding surfaces (session export/restore, zero-approval cookie resume, and — new in rc50 — payment endpoints, SB2, X25519, public storage, and sign-out). Upstream paykit-rs is pre-1.0 ("WIP - not for production") and claims no independent security review; the binding and this integration inherit that status.

## rc44 → rc50 change summary

Seventeen commits, from the source checkout's log
(`git log 0a6c6e45..d4a73a57`, read-only at `/Users/johncarvalho/work/paykit-rs-official`):

```
2cc42e9 docs: add marketplace fork section explaining differences from upstream
2144f3c Revert "docs: add marketplace fork section explaining differences from upstream"
132628c docs: add marketplace fork section explaining differences from upstream
f753cb2 feat: bind SB2, X25519, public storage, and sign-out in wasm
93d3dba feat: bind public Payment Endpoints and private lists in wasm
24ed3a0 fix: keep __proto__ payment identifiers as own JS properties
4c0b7a1 feat: export sb2Encrypt and sb2Sign from wasm
51f1e68 Export migrateHomeserverWithSecret on paykit-wasm
a4c66d9 Restore pkarr CAS baseline before republish retry
2ff7d44 Retry WASM homeserver publish after CAS and transport errors.
6a58d26 fix: retry pkarr publish on unexpected relay responses
3867a08 feat: expose resolveMostRecentHomeserver on wasm client
a2999bf chore: rebuild paykit-wasm pkg
b04e05c fix: drain wasm write bodies so fetch is not aborted
cae1a8f fix: drop leftover pkarr stream after BrowserHttp
f978731 fix: bound wasm write-body drain so a stalled 2xx cannot hang
d4a73a5 fix: bound error-body drain and bump wasm to rc50
```

The API delta on `paykit_wasm.d.ts` is **purely additive** — no existing
signature changed and nothing was removed, so no consumer in this repository
needed adaptation. New surface (unused by this app today): SB2
encrypt/decrypt/sign/verify, `x25519GenerateKeypair`, `computeInboxKid`,
public/private Payment Endpoints and lists, `sendPrivatePaymentList`,
`putPublic`/`deletePublic`/`publicGet`, `signOutSession`,
`migrateHomeserverWithSecret`, `resolveMostRecentHomeserver`.

The runtime-relevant changes for this app's messaging usage are the
homeserver-write robustness fixes: WASM homeserver writes now drain response
bodies (2xx and error paths, both bounded so a stalled/hostile homeserver
cannot hang the fetch or abort the write), pkarr publish retries after CAS
and transport errors with the CAS baseline restored, and the wasm
`setTimeout` is cleared on `wasm_sleep` drop. The publish path these fixes
harden is the one receiver-marker publish/discovery and link outbox writes
ride on.

## Toolchain (recorded at the source build)

Recorded with the rc50 source build (2026-09-01, per the sibling product's provenance record, which re-recorded it on the build machine):

| Tool              | Version                              |
| ----------------- | ------------------------------------ |
| `wasm-pack`       | 0.13.1 (bundled binaryen `wasm-opt`) |
| `rustc`           | 1.93.1 (01f6ddf75 2026-02-11)        |
| `wasm-bindgen`    | 0.2.115                              |
| Rust target       | `wasm32-unknown-unknown`             |
| Node (smoke test) | v22.14.0                             |

## Generation command

```bash
git clone https://github.com/BitcoinErrorLog/paykit-rs-official.git
cd paykit-rs-official && git checkout d4a73a5765e1f0b18ed451d78f98dab97c611a8c
rustup target add wasm32-unknown-unknown
wasm-pack build paykit-wasm --target web --out-dir pkg --release
node paykit-wasm/scripts/smoke.mjs   # requires Node >= 20
```

## Artifact checksums

SHA-256 of the vendored files, computed with `shasum -a 256` against the files on disk after the copy (and matched to the git blobs at the pin — see the header):

| File                       | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `paykit_wasm_bg.wasm`      | `fe41d70bfb4a23ec7e21713998cf960318a84ab3845775f62211a0f0bfb3024d` |
| `paykit_wasm.js`           | `df0e5f7804ee62bd4b880c2f532635afe9e47c5cd06c766c95df4eec47db6392` |
| `paykit_wasm.d.ts`         | `bf0696f9d72fc02310a6a1815a99b41b1be768020f3a41199cc337ce54dc2398` |
| `paykit_wasm_bg.wasm.d.ts` | `cebe23ebf38336009e38e3e7627d7df503b54fba24e18ae1abb33834c93941c0` |
| `package.json`             | `043f33bb2b4fdb2602b609e5138b68b506937953d0c1775ccc624eb27238764f` |

Generated package size: ~1.8 MB (wasm ~1.8 MB). `wasm-opt` output is not guaranteed bit-identical across platforms; treat these checksums as a record of this build, and re-record when the pin or toolchain changes.

## Vendoring mechanism

The generated `pkg/` output is committed verbatim at `vendor/paykit-wasm/` and referenced from `package.json` as a `file:` dependency:

```json
"paykit-wasm": "file:vendor/paykit-wasm"
```

npm symlinks `node_modules/paykit-wasm` to the vendored directory, so a fresh clone plus `npm ci` resolves the binding with no extra steps and no network fetch from a mutable source. The vendored directory carries a `PROVENANCE.md` pointing back to this file, and is excluded from Prettier (`.prettierignore`) so the committed artifacts stay byte-identical to the recorded build. Tests alias `paykit-wasm` to the vendored file directly (`vitest.config.ts`), so test runs exercise this artifact even when a shared/linked `node_modules` resolves the `file:` dependency elsewhere.

### Re-vendoring

1. Rebuild from the pinned (or newly pinned) source commit using the generation command above, or copy the already-built `paykit-wasm/pkg` at that HEAD.
2. Copy `pkg/package.json`, `paykit_wasm.js`, `paykit_wasm.d.ts`, `paykit_wasm_bg.wasm`, and `paykit_wasm_bg.wasm.d.ts` into `vendor/paykit-wasm/`.
3. Run `npm install` to refresh `package-lock.json`, then `node scripts/paykit-wasm-smoke.mjs`.
4. Update the commit pin, toolchain table, and checksums in this file.

## Verification performed

- Byte-identity with the source: all five artifacts hash-identical to `paykit-wasm/pkg` at `d4a73a5765e1f0b18ed451d78f98dab97c611a8c` in the source checkout (see the header). The sibling product's independent rebuild verification of the same pin (same-tree rebuild reproduced the `.wasm` SHA-256; clean-worktree rebuild matched JS/`.d.ts`/`package.json` with the `.wasm` differing only in the data segment, the documented `wasm-opt` non-determinism) is recorded in its own provenance file and was not re-run here.
- `node scripts/paykit-wasm-smoke.mjs` passes against the vendored copy with REAL crypto in Node (module instantiation, the bound messaging API surface, receiver Noise key generation, in-memory Noise XX handshake, encrypted roundtrips, AEAD tamper rejection, the 1000-byte limit, `pubkyauth` URL construction). CI runs it in `.github/workflows/build.yml` ahead of `next build`. Note: in a network-restricted environment the script prints its pass line but the process lingers on the mainnet `PubkyClient`'s relay handles — pre-existing behavior, identical on rc44.
- This repo's unit suites pass against the rc50 artifact with no consumer adaptation: the real-crypto integration tests (`paykit-messaging.realcrypto.test.ts`, which instantiate the vendored `.wasm`) and the full messaging/service suites.
- The binding's own homeserver-backed browser e2e and the native unit tests for the new write-drain/retry behavior live in the source repository at the pinned commit; they were not re-run in this tree. As before, the production `startAuthFlow` signer approval leg remains the one flow proven only by this repo's live scripting, not by the binding's e2e.

## What the binding is used for here

`PaykitMessagingService` (`src/core/services/paykit/paykit-messaging.ts`) uses the binding for end-to-end-encrypted marketplace messaging in durable commerce modes: a Ring-approved homeserver session scoped to `/pub/paykit/:rw`, a receiver-scoped Noise key generated in the browser (never the identity secret), receiver marker publish/discovery, Noise XX Encrypted Links per counterparty, and Private Application Messages with marketplace kinds. The WASM module is loaded lazily via dynamic import on first use, never at module scope, mirroring the Locks SDK loading pattern. The rc50 additions (payment endpoints, SB2, X25519, public storage, sign-out) are NOT used by this app today.

## Known limitations inherited from the binding

- 1000-byte limit per Private Application Message (JSON envelope included) — attachments are not possible inline and are not offered in encrypted mode.
- Link and handshake snapshots serialize UNENCRYPTED from the binding and contain key material; the caller owns at-rest protection. This app wraps them (and the receiver Noise secret) with AES-GCM-256 under a non-extractable device keyring key before they touch IndexedDB (`src/libs/crypto/`, DB 4 → 5 migration); the multi-device backup-key decision remains open.
- `PubkyClient` exposes only mainnet defaults and the fixed local-testnet topology (`testnet()`, pkarr relay `localhost:15411`); no custom relay/host overrides.
- Link handles reject overlapping operations ("operation in flight"); callers serialize per-link operations (the service does).
- No independent security review of paykit-rs, pubky-noise, or the binding.
