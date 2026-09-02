# Locks + Paykit + Bitcoin regtest — composed integration environment

A composed Docker environment that runs the real Locks -> Paykit Server ->
Bitcoin payment path end to end on regtest, with no stubs, no dev-route manual
completion, and no fabricated payment facts. It corresponds to plan task 4.2
and to the topology in `mp-ui/docs/ecommerce/upstream-integration.md`.

**Status: the protocol-level payment leg is verified end to end on regtest.**
A real `paykit-payment` proof bundle produced a real signed invoice, Paykit
Server derived a unique BIP84 address from a watch-only account tpub, delivered
a private Payment Request to the reader, observed the on-chain payment through
Fulcrum (`undetected -> detected -> confirmed`, capped at 6 confirmations), and
the Locks worker completed the verification, issued an access credential, and
served the guarded bytes. Only the wallet-app leg (Bitkit UX) remains; see
[What still requires Bitkit](#what-still-requires-bitkit-and-why).

## Topology

```text
verify.sh (host driver, curl/jq)
  ├─ Lock Server :3000 ──────────────┐  signed HTTP (X-Paykit-Signature,
  │    └─ PostgreSQL (locks)         │  Ed25519 over canonical JCS body)
  │                                  ▼
  ├─ Paykit Server :3001  ◄── trusted Locks public key
  │    ├─ PostgreSQL (paykit)
  │    ├─ Paykit SDK / Pubky private messages ──► paykit-reader (Bitkit's role)
  │    └─ Electrum ──► Fulcrum ──► bitcoind (regtest)
  └─ pubky-testnet (DHT + PKARR relay + HTTP relay + homeserver)
       shared network namespace for every Pubky-testnet-dependent service
```

Services that use the pinned Pubky client's fixed localhost testnet ports
(`locks-server`, `paykit-server`, `paykit-reader`, `creator-demo`,
`reader-demo`) share the `pubky-testnet` container's network namespace, exactly
like the upstream Locks compose. `bitcoind`, `fulcrum`, and both Postgres
instances live on the normal compose network; the shared namespace resolves
them by service name through compose DNS.

## Pinned revisions

| Component | Source | Revision |
| --- | --- | --- |
| Lock Server / Locks stack | `pubky/locks` | `ba49a777a94db318ec6ebd427315080a5b904645` |
| Paykit Server | `pubky/paykit-server` | `867fc883125c7b89a7b712c2551619cccdfdc0f7` (immutable merge commit for [pubky/paykit-server#2](https://github.com/pubky/paykit-server/pull/2)) |
| paykit-rs (build dep of Paykit Server) | `pubky/paykit-rs` | `6b241878a9bba5cecea919c0298c3f90624be6ff` (the exact rev pinned in paykit-server's Cargo manifests) |
| locks-core (build dep of Paykit Server) | `pubky/locks` | `df5ea1b6d8dcdec3a9b5a915c3f57bca69d75c8a` (the exact rev pinned in paykit-server's Cargo manifests; an ancestor of `ba49a777`) |
| Pubky Core (testnet image) | `pubky/pubky-core` | `f68014c111af0458e6a321e2d87a12479bfb3218` (pinned inside locks' `docker/pubky-testnet.Dockerfile`) |

`scripts/fetch-sources.sh` clones all four trees into `sources/` and fails if a
checkout does not match its pin. The Paykit Server image is built with the
upstream `Dockerfile.local` and its named BuildKit contexts; the upstream
`prepare-local-docker-sources.sh` step fails closed if the supplied trees drift
from the manifest pins. `Dockerfile.local` itself pins its Rust and Debian base
images by digest.

## Image pins

| Image | Digest |
| --- | --- |
| `postgres:16-alpine` | `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` |
| `node:22-bookworm-slim` | `sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436` |
| `bitcoin/bitcoin:29.1` | `sha256:de62c536feb629bed65395f63afd02e3a7a777a3ec82fbed773d50336a739319` |
| `cculianu/fulcrum:v2.0.0` | `sha256:cb1c006d0cff104696f4791d0f1516699b2c163120165461385e4de206271943` |
| `paykit-server:local-867fc883` | built locally from pinned source; image ID at verification time `sha256:2e5c2e8391a4a9f60dfaed3326fce0b772f01e81b4a51b69cbf08c0b02bd89e8` |

The two images built from the locks tree (`pubky-testnet`, `locks-server`) use
the upstream Dockerfiles at the pinned locks revision (`rust:1.89.0`,
`alpine:3.20`, `debian:bookworm-slim` bases as committed upstream).

## Ports

Host ports are set in `.env` (`cp .env.example .env`, or let `scripts/up.sh`
do it). In-container ports are fixed because the pinned Pubky client resolves
its local testnet on fixed localhost ports. Defaults avoid everything already
listening on this machine, including the natively running `pubky-testnet`
process (6881/udp, 15411, 15412, 6286-6288), a node server on 3000, and the
Postgres instances on 5432/5433/55432. This environment never stops, renames,
or removes containers it did not create; all containers live in the
`payments-env` compose project.

| Service | Container port | Host default |
| --- | --- | --- |
| Lock Server HTTP | 3000 | `13000` |
| Paykit Server HTTP | 3001 | `13001` |
| Locks Postgres | 5432 | `55433` |
| Paykit Postgres | 5432 | `55434` |
| Testnet DHT | 6881 tcp+udp | `16881` |
| PKARR relay | 15411 | `25411` |
| HTTP relay | 15412 | `25412` |
| Homeserver HTTP / Pubky TLS / admin | 6286 / 6287 / 6288 | `16286` / `16287` / `16288` |
| Creator demo app | 8080 | `18080` |
| Reader demo app | 8081 | `18081` |
| bitcoind / Fulcrum | 18443 / 50001 | not published (internal only) |

## Start / stop

```bash
./scripts/up.sh        # fetch pinned sources, build images, compose up, wait for readiness
./scripts/verify.sh    # drive the full payment path (see below); re-runnable
./scripts/down.sh              # stop the stack, keep state
./scripts/down.sh --volumes    # stop and delete all state (fresh start)
```

`up.sh` generates `PAYKIT_MASTER_KEY` into `.env` on first run. The Lock
Server entrypoint overlay (`overlay/locks-server-entrypoint-paykit.sh`)
reproduces the upstream compose entrypoint and additionally: adds the
`[paykit]` runtime section (`server_url = http://127.0.0.1:3001`,
`minimum_confirmations = 1` by default), and generates the Paykit Server
config into a shared volume with `trusted_public_key` set to the Lock Server's
generated `credentials.lock_server_public_key` — following the generated-config
contract in paykit-server `docs/local-locks-demo.md`. All credentials in this
stack (Postgres, bitcoind RPC) are local-only dev values that never leave the
compose network.

Note: Paykit Server's trusted Locks key is immutable deployment metadata. If
you ever wipe only the `lock-home` volume (new Lock Server identity) you must
also wipe `paykit-postgres-data`; `down.sh --volumes` resets both coherently.

## What the verification script covers

`scripts/verify.sh` drives, against the running stack, with per-step
assertions (each step aborts the run on mismatch; artifacts land in
`.verify-out/<timestamp>/`):

1. Readiness: Locks `/readyz` `ready`; Paykit `/health/ready` `200` with
   `postgres/electrum/paykit_delivery/outbox` all `ready`.
2. Regtest funding: `miner` wallet, 101+ blocks.
3. Creator watch-only account: BIP84 account tpub extracted from a real
   bitcoind descriptor wallet (`paykit_creator`, path `m/84h/1h/0h`). The
   environment never gives Paykit Server spending keys.
4. Locks creator authority via hosted legacy-connect (`/connect` ->
   Pubky-SDK approval -> `/frontend-sessions`).
5. Paykit creator setup: `GET /setup` -> `paykit-companion-auth` approves the
   `watch-only-account-v1` companion claim (Bitkit's approval role) with the
   creator's Pubky secret and the tpub -> `POST /setup/{flow}/complete` `200`.
6. Reader (Bitkit's protocol role): fresh Pubky identity signed up on the
   testnet homeserver; `paykit-reader-demo prepare` publishes the Paykit
   receiver marker. A fresh reader is created per run so exactly one Payment
   Request is actionable.
7. Creator publishing through authenticated Locks routes: guarded bytes
   upload, then a `paykit-payment` content lock (`recipient_pubky` = creator,
   `amount` in sats, `asset` `BTC`; Paykit normalizes the delivered wire asset).
8. Trust boundary (negative checks): `POST /invoices` unsigned -> `401
   invalid_signature`; garbage-signed -> `401`; unsigned
   `POST /transactions/status` -> `401`.
9. Proof bundle -> real invoice: `POST /proof-bundles` returns `200 pending`
   (not `422 paykit_not_configured`, not `502`), which per Locks RUNTIME.md
   means the Lock Server signed and sent a real `POST /invoices` before
   creating the verification task.
10. Paykit signed status (signed with the Lock Server's own Ed25519 key,
    extracted from its volume, over the canonical JCS body): `undetected`.
11. Payment Request receipt: `paykit-reader-demo receive` links with the
    Creator peer over Paykit private messages and requires lowercase `btc`,
    exactly `btc-regtest-p2wpkh`, and a strict JSON endpoint payload with a
    non-empty string `value`. Uppercase `BTC`, a mainnet identifier, or a bare
    address payload fails verification. The returned unique BIP84 address is
    independently re-derived from the tpub via `bitcoin-cli deriveaddresses`
    (external chain scan).
12. Payment from the regtest node (`sendtoaddress`): signed status becomes
    `detected` (`confirmations 0`, `amount_matched true`); Locks lifecycle
    still `pending` because `minimum_confirmations = 1`.
13. One mined block: signed status `confirmed`; the Locks worker completes
    the verification task with no dev-route completion.
14. `POST /access-credentials` issues a credential; the guarded proxy read
    returns byte-identical uploaded content.
15. Five more blocks: reported confirmations cap at exactly `6` (finality).

### Observed results (run of 2026-09-02, artifacts `.verify-out/20260902-030740/`)

```json
"paykit_status_progression": {
  "before_payment":        {"status":"undetected","confirmations":0,"amount_matched":false},
  "after_mempool_payment": {"status":"detected",  "confirmations":0,"amount_matched":true},
  "after_one_block":       {"status":"confirmed", "confirmations":1,"amount_matched":true},
  "at_finality":           {"status":"confirmed", "confirmations":6,"amount_matched":true}
},
"locks_lifecycle": {"status":"completed", "failure_message":null}
```

The same run received a canonical `btc` / `btc-regtest-p2wpkh` request whose
JSON endpoint `value` was a regtest BIP84 address, and refused unsigned and
garbage-signed Paykit business calls with
`401 {"error":{"code":"invalid_signature"}}`. All fifteen steps passed.

## What still requires Bitkit, and why

Regtest completes the payment leg without Bitkit because the payment
attribution input is purely on-chain: Paykit Server watches the invoice's
unique BIP84 address through Electrum, and any wallet — including the regtest
node itself — can produce the amount-matched output. What this environment
therefore does NOT prove is the wallet-app UX leg:

- **Companion-claim approval inside real Bitkit.** Here
  `paykit-companion-auth` plays that role with the same claim format
  (`watch-only-account-v1`, xpub + hardened account index) but it is the demo
  helper, not the Bitkit app. Real-device approval flow, key handling, and UI
  remain unproven.
- **Payment Request receipt and payment execution from a phone.** Here
  `paykit-reader-demo` receives the Paykit private Payment Request and the
  regtest node pays. Bitkit receiving the request, rendering it, and executing
  the payment from its own wallet remain unproven.
- **Mainnet/public-network variants.** This stack runs the pinned local Pubky
  testnet and regtest Bitcoin by construction.

Everything protocol-side that Bitkit would talk to — invoice creation, private
message delivery, address derivation, settlement observation, status
reporting, Locks completion, credential issuance, guarded reads — is exercised
for real here.

## Repository layout

```text
docker-compose.yml    composed stack (project name payments-env)
.env / .env.example   host ports + PAYKIT_MASTER_KEY
overlay/              lock-server entrypoint (+[paykit] + config generation),
                      fulcrum.conf, node helper scripts (identity/signing)
scripts/              fetch-sources, build-paykit-image, up, down, verify
sources/              pinned upstream checkouts (git-ignored; recreated by
                      fetch-sources.sh)
.verify-out/          verification artifacts per run (git-ignored)
```
