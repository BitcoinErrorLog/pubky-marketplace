# Shop Developer Onboarding

Everything a developer needs to run, test and release [Pubky Shop](https://shop.pubky.app), the marketplace client
built from this repository.

## What the Shop is

A peer-to-peer marketplace on Pubky:

- **Records live with the seller.** Shops, listings, reviews and drops are signed records on the seller's own
  homeserver, indexed by a marketplace Nexus.
- **A small Rust service enforces what a browser can't:** single-winner inventory, auctions, orders and receipts.
- **Payments go straight to the seller.** Bitcoin runs over Paykit and Locks; PayPal is seller-direct. Card payments
  are paused. The Shop never holds funds.
- **Messaging is end-to-end encrypted** over Paykit Encrypted Links.

This repository holds the Shop web client, built on the Pubky social app
([pubky/pubky-app](https://github.com/pubky/pubky-app)), together with the project documents and the tester issue
tracker. The Shop runs as its own site next to pubky.app.

Read [`status.md`](status.md) for what is real and what is simulated, and [`FEATURES.md`](FEATURES.md) for the
feature inventory.

## Repositories

| Repository                                                                            | What                                                                             | Work branch | Deploys to                                                                              |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| [pubky/pubky-marketplace](https://github.com/pubky/pubky-marketplace)                 | Shop web client (Next.js, `@synonymdev/pubky` 0.11), project docs, tester issues | `master`    | Vercel `pubky-marketplace-production` (shop.pubky.app) and `pubky-marketplace-staging`  |
| [pubky/pubky-marketplace-service](https://github.com/pubky/pubky-marketplace-service) | Transaction service (Rust, sqlx, Postgres)                                       | `main`      | Railway, GHCR image pinned in `.railway/railway.ts`; staging at `staging-api.pubky.app` |
| [BitcoinErrorLog/pubky-nexus](https://github.com/BitcoinErrorLog/pubky-nexus)         | Marketplace indexer (Nexus fork)                                                 | `main`      | Railway; see its `docs/railway-deploy.md`                                               |
| [BitcoinErrorLog/paykit-server](https://github.com/BitcoinErrorLog/paykit-server)     | Paykit server (fork)                                                             | `master`    | Railway; production host `paykit-shop.pubky.app`                                        |
| [BitcoinErrorLog/pubky-app-specs](https://github.com/BitcoinErrorLog/pubky-app-specs) | Marketplace record types (specs fork)                                            | —           | Vendored into this repository as a tarball                                              |
| [pubky/pubky-shop-sdk](https://github.com/pubky/pubky-shop-sdk)                       | `@bitcoinerrorlog/pubky-shop` SDK                                                | `main`      | npm                                                                                     |

In this repository, `master` is the default branch and the Shop release line. Releases up to `shop-v0.6.46` were cut
from `release/shop-v0.6.8` in `BitcoinErrorLog/pubky-app`; that history and its tags are part of this repository.

## Access to request on day one

- Write access to the repositories above.
- Membership of the Vercel team `synonymdev` (both Shop projects live there).
- Sentry, for the Shop's error reports.
- Test seats for the release proof, passed out of band by the product owner. Never commit them.

## Run it locally

```bash
git clone https://github.com/pubky/pubky-marketplace.git && cd pubky-marketplace
HUSKY=0 npm ci           # HUSKY=0 keeps husky from replacing your global git hooks
npm run marketplace:dev  # terminal 1: in-memory sandbox transaction service on :3100
PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=sandbox \
PUBKY_RUNTIME_MARKETPLACE_URL=http://localhost:3100 npm run dev   # terminal 2: http://localhost:3000
```

Sign in, open `/marketplace/sandbox`, and seed the catalog. [`RUNNING.md`](RUNNING.md) covers every mode: the durable
Rust service (it needs a local Postgres using scram-sha-256 auth, which its `docker compose` provides), encrypted
messaging, drops, and real Locks/Paykit payments.

## Test

| What                            | Command                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| Pre-push gate (required)        | `bash scripts/prepush.sh` (last line `PREPUSH OK <sha> <seconds> fast`) |
| Release gate                    | `PREPUSH_FULL=1 bash scripts/prepush.sh` (last line ends in `full`)     |
| Types and lint                  | `npm run typecheck`, `npm run lint`                                     |
| Unit tests                      | `npm run test`                                                          |
| Sandbox service tests           | `npm run test:marketplace`                                              |
| Linux visual regression         | `bash scripts/vrt-linux.sh [spec...]` (Docker; the CI merge gate)       |
| Launch-critical browser journey | `npm run test:e2e:launch-critical`                                      |

Live suites that need a running service, a local Pubky testnet, or staging signup tokens are listed in
[`RUNNING.md`](RUNNING.md#running-the-tests). They are run on demand, not as standing gates.

## Merge

- Pull requests target the open train branch `train/shop-<date>-<am|pm>`; the train merges into
  `master` at the cut.
- CI must pass: Check Code Quality, Check NextJS Build, the five test shards, Run Tests, Merge Coverage Reports,
  `vrt-marketplace`, `vrt-core`, `launch-e2e`. No approving review is configured; agree a review rule as a team.
- Auto-merge is off, and maintainers do the merges. After pushing, wait with `gh pr checks <N> --watch`, then ask a
  maintainer to merge; they merge with `gh pr merge <N> --squash` once every check passed or skipped. Automated agents
  never merge and never push `master`.
- Regenerate Linux VRT baselines only for scenes you changed, once, in a commit of PNGs alone. Never re-pin a scene
  you did not touch. Details: [`release.md`](release.md#visual-regression-baselines).
- User-visible changes add a fragment under `changelog.d/next/`.

## Code rules

[`AGENTS.md`](../../AGENTS.md) and [`docs/README.md`](../README.md) are binding. In short:

- Layering is UI → controllers → application → services; components call hooks, not controllers.
- No `useMemo` or `useCallback` (the React Compiler memoizes).
- No barrel `index.ts` files under `src/components`.
- Errors go through the `Err.*` factories, never `new Error`.
- Telemetry carries static text only: no ids, pubkys, URLs or query values.
- Commit messages follow [`commit-message.md`](../commit-message.md).

## Release

Follow [`release.md`](release.md): train cut, proof on the release head, Vercel deploy, the signed-in production
proof (`scripts/release/release-proof.mjs`), tag and notes. Production operations, the kill switch and rollback are
in [`runbook-production.md`](runbook-production.md).

## Known limits

- **Messaging needs a Pubky Ring cookie session.** The vendored `paykit-wasm` supports cookie sessions only, so users
  signed in with a grant (Bitkit) have no messaging, and Ring sign-in cannot move to grants without losing it.
- **No single sign-on with pubky.app.** Each site has its own sign-in. Both sites' Ring cookie sign-ins share one
  homeserver cookie, so signing in on one site replaces the permissions the other was granted, and signing out of the
  Shop with a Ring session also signs pubky.app out in that browser.
- **The session-bridge consumer is off.** `NEXT_PUBLIC_VIBE_SESSION_BRIDGE_ORIGIN` and `NEXT_PUBLIC_VIBE_ID` are unset
  in both Shop builds, so the `#s=` hand-off from pubky.app does not run ([ADR 0029](../adr/0029-vibe-session-consumer.md)).

## Architecture decisions

ADRs 0019–0029 in [`docs/adr/`](../adr/) record the marketplace architecture: the transaction service, the record
specs, local-first commerce state, drops, and the session consumer. Sign-in flows are in
[`single-approval.md`](single-approval.md), [`step-up-approval.md`](step-up-approval.md) and
[`service-auth.md`](service-auth.md).

## Who to ask

| Topic                                                         | GitHub                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Product decisions, Vercel access, test seats, backend deploys | [BitcoinErrorLog](https://github.com/BitcoinErrorLog)                                                                                   |
| Testing, issue reports, payment canaries                      | [thisispav](https://github.com/thisispav)                                                                                               |
| Bitkit testing                                                | [piotr-iohk](https://github.com/piotr-iohk)                                                                                             |
| Visual design                                                 | [aldertnl](https://github.com/aldertnl)                                                                                                 |
| pubky.app changes                                             | [secondl1ght](https://github.com/secondl1ght), [infin1t3](https://github.com/infin1t3), [talosmachina](https://github.com/talosmachina) |
| Bitkit and Paykit client issues                               | [ovitrif](https://github.com/ovitrif)                                                                                                   |
| Nexus, homeserver, Paykit server, Locks, Passport             | The maintainers of the corresponding `pubky/*` repositories                                                                             |
