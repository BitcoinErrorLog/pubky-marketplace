# Pubky Shop: team brief

For developers taking over [shop.pubky.app](https://shop.pubky.app) for the beta. The launch plan, with decisions and the timeline, is in [shop-launch-plan.md](shop-launch-plan.md).

## What the Shop is

A peer-to-peer marketplace on Pubky:

- **Records live with the seller.** Sellers publish shops, listings, reviews and drops as signed records on their own homeserver.
- **A small Rust service enforces the rules a browser can't.** It owns single-winner inventory, auctions, orders and receipts.
- **Payments go straight to the seller.** Bitcoin runs over Paykit and Locks; PayPal is seller-direct. Card payments are paused.
- **No custody.** The Shop never holds funds.
- **Built-in messaging.** Messages are end-to-end encrypted over Paykit Encrypted Links.

The web client is a fork of the Pubky social app ([pubky/pubky-app](https://github.com/pubky/pubky-app)). For the beta it runs as its own site next to pubky.app, and social pages link back there (launch plan §2).

## Repos and deploys

| Repo | What | Branch for work | Deploys to |
|---|---|---|---|
| [BitcoinErrorLog/pubky-app](https://github.com/BitcoinErrorLog/pubky-app) | Shop web client (Next.js 16, SDK `@synonymdev/pubky` 0.11) | `release/shop-v0.6.8`, the long-lived release line despite the name. The repo default is being switched to it from `pubchi/v1`, a different product. Until that lands, clone with `-b release/shop-v0.6.8` | Vercel production project → shop.pubky.app; Vercel staging project → a generated staging host (ask John) |
| [BitcoinErrorLog/pubky-marketplace-service](https://github.com/BitcoinErrorLog/pubky-marketplace-service) | Transaction service (Rust, sqlx, Postgres) | `main` | Railway, via a GHCR image pinned in `.railway/railway.ts`; staging at `staging-api.pubky.app` |
| [BitcoinErrorLog/pubky-nexus](https://github.com/BitcoinErrorLog/pubky-nexus) | Marketplace indexer (Nexus fork) | `main` | Railway, marketplace Nexus project; see `docs/railway-deploy.md` |
| [BitcoinErrorLog/paykit-server](https://github.com/BitcoinErrorLog/paykit-server) | Paykit server (fork) | `master` | Railway; production host `paykit-shop.pubky.app` |
| [BitcoinErrorLog/pubky-app-specs](https://github.com/BitcoinErrorLog/pubky-app-specs) | Marketplace record types (specs fork) | — | Vendored into the Shop as a tarball |
| [BitcoinErrorLog/pubky-shop](https://github.com/BitcoinErrorLog/pubky-shop) | `@bitcoinerrorlog/pubky-shop` SDK (npm) | `main` | npm |
| [BitcoinErrorLog/pubky-marketplace](https://github.com/BitcoinErrorLog/pubky-marketplace) | Issue tracker for testers | — | — |

The backend services run today on John's own Railway account, and only John deploys them there. Backend PRs merge on GitHub and John deploys them; [paykit-server#23](https://github.com/BitcoinErrorLog/paykit-server/pull/23) goes this way. Infra is one of two options (launch plan §7, D8):

- **R:** John keeps running Railway alone.
- **S:** Synonym DevOps builds new instances on Synonym's cloud and cuts over before the beta (recommended).

The full inventory is in launch plan §7.

## Run it locally

```bash
git clone -b release/shop-v0.6.8 https://github.com/BitcoinErrorLog/pubky-app.git && cd pubky-app
HUSKY=0 npm ci           # HUSKY=0 keeps husky from overriding your git hooks
npm run marketplace:dev  # terminal 1: in-memory sandbox service on :3100
PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=sandbox \
PUBKY_RUNTIME_MARKETPLACE_URL=http://localhost:3100 npm run dev   # terminal 2
```

- **Sandbox walkthrough:** sign in, open `/marketplace/sandbox` and seed the catalog. Details: [RUNNING.md](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/docs/ecommerce/RUNNING.md).
- **The real Rust service:** see the service [README](https://github.com/BitcoinErrorLog/pubky-marketplace-service#run). It needs a local Postgres that uses scram-sha-256 auth.

## Test and merge

- **Before every push, run `bash scripts/prepush.sh`.** The fast mode (default) runs prettier and eslint on changed files, typecheck, and `vitest related`. Its last line is `PREPUSH OK <sha> <seconds> <mode>`. A passing tree is reused, so pushing the same tree again doesn't rerun it.
- **Releases run the full gate:** `PREPUSH_FULL=1 bash scripts/prepush.sh`. It adds Linux visual-regression (VRT) tests in the pinned Playwright container (`bash scripts/vrt-linux.sh src/test/vrt/marketplace/`).
- **CI checks required on `release/shop-v0.6.8`:**
  - Code Quality, NextJS Build;
  - the five test shards, Run Tests, Merge Coverage Reports;
  - `vrt-marketplace`, `vrt-core`, `launch-e2e`.
  - No approving review is required; the team should agree its own review rule on day 1.
- **Auto-merge is on.** After pushing, arm it with `gh pr merge --auto --squash` and move on instead of waiting on CI.
- **A flake outside your diff:** rerun those test files alone twice. If both pass, the push may skip the hook, as long as the logs go in the PR body. Never skip on a touched file, typecheck, lint or VRT.
- **VRT baselines:** regenerate Linux baselines only for scenes you changed, once, in a commit of PNGs alone. Never re-pin a scene you didn't touch.
- **Code rules** are in [AGENTS.md](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/AGENTS.md). In short:
  - layering is UI → controllers → application → services;
  - no `useMemo` or `useCallback`;
  - no barrel files;
  - errors through the `Err.*` factories;
  - telemetry carries no ids or URLs.

## Release

- **The train.** At most 1–2 Shop releases a day. Feature PRs go to `train/shop-<date>-<am|pm>`. At the cut the train merges into the release branch, Linux baselines regenerate once, the full proof runs, then:
  - deploy with `vercel --prod --yes --force`, linked to the Shop's production project in the `synonymdev` Vercel team;
  - tag `shop-vX.Y.Z`;
  - publish a GitHub release whose notes come from `changelog.d/next` fragments.
- **"Live" needs a signed-in production proof, not a green build.** The proof is `release-proof.mjs`, which signs in two test seats, runs checkout on a temporary PayPal fixture, and cleans up after itself.
- **The release runbook is still on John's machine.** It is a local runbook there, with `release-proof.mjs` and the PayPal fixture script beside it. Its paths are specific to that machine. A repo copy is being written today (launch plan F7). It drops the two `#s=` hand-off checks (steps 3 and 6), which test a path that can no longer run now that the session-bridge variables are unset. The proof seats' keys stay with John; ask him for team test seats and pass them out of band.
- **Service and Nexus releases** follow each repo's README and `.railway/README.md`: GHCR image, digest pin in IaC, a `railway config plan` that shows no changes, then deploy and health checks.
- **Pre-launch policy:** fix forward. Roll back only on data loss or money moving wrongly.

## Where the docs are

Shop docs, all in `docs/` on the release branch:

- [`docs/ecommerce/status.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/docs/ecommerce/status.md): what's real and what's simulated.
- [`FEATURES.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/docs/ecommerce/FEATURES.md): the feature inventory.
- [`runbook-production.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/docs/ecommerce/runbook-production.md): production operations.
- [`single-approval.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/docs/ecommerce/single-approval.md) and [`step-up-approval.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/docs/ecommerce/step-up-approval.md): sign-in.
- [ADRs 0019–0029](https://github.com/BitcoinErrorLog/pubky-app/tree/release/shop-v0.6.8/docs/adr): the marketplace architecture decisions.

Other repos:

- The service README covers command envelopes, inventory semantics and operations.
- On the Nexus fork: `docs/railway-deploy.md` and `docs/production-cutover.md`.

Project context:

- [launch plan](shop-launch-plan.md), in this folder;
- [SSO proposal](../sso/sso-proposal-for-team.md) and [SSO design](../sso/pubky-sso-design.md);
- the loose-ends list, Nexus fork audit, upstream convergence plan, messaging plan and decisions log are internal; ask John for them.

## Current status (1 Oct)

- **Shop:** [v0.6.41](https://github.com/BitcoinErrorLog/pubky-app/releases/tag/shop-v0.6.41) is live (`5fbcfe80`, proof 42/42). Repeat signed-in loads take 240 ms on desktop.
- **Next release, v0.6.42:**
  - deleted-listing wording ([#170](https://github.com/BitcoinErrorLog/pubky-app/pull/170));
  - message retry backoff reset ([#171](https://github.com/BitcoinErrorLog/pubky-app/pull/171));
  - session-bridge variables removed from the build config;
  - the [#164](https://github.com/BitcoinErrorLog/pubky-app/pull/164) rebase, once ready.
- **Being coded today:**
  - F1 link-out, behind a build flag;
  - F4 Passport;
  - [#62](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/62);
  - [#63](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/63);
  - [#49](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/49) copy;
  - F5 sign-out copy;
  - F7 docs.
  See the "Today" section of the launch plan.
- **Service:** `main` at [#79](https://github.com/BitcoinErrorLog/pubky-marketplace-service/pull/79). It includes the PayPal email privacy fix, the listing-revival fix and address search.
- **Nexus:** marketplace nexusd at `71637ffa`. Two generic fixes are open upstream ([#1099](https://github.com/pubky/pubky-nexus/pull/1099), [#1100](https://github.com/pubky/pubky-nexus/pull/1100)).
- **Payments:** PayPal and Bitcoin have each completed a real production payment ([#53](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/53), [#54](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/54)). Stripe is paused.
- **Open tester issues:** [pubky-marketplace issues](https://github.com/BitcoinErrorLog/pubky-marketplace/issues). Open PRs: [#164](https://github.com/BitcoinErrorLog/pubky-app/pull/164) on the Shop, [paykit-server #23](https://github.com/BitcoinErrorLog/paykit-server/pull/23).
- **Known gaps,** detailed in launch plan §3 and §5:
  - **Permissions overwrite.** The two sites' cookie sign-ins overwrite each other's permissions. The stopgap: Ring sign-in requests both sites' scopes (D5, decided).
  - **Messaging needs a Ring cookie session.** The vendored `paykit-wasm` supports only cookie sessions, so Bitkit and Passport users get no messaging, and Ring can't move to grants yet.
  - **Released Ring signs in with cookies only.** Ring's grant auth is merged ([pubky-ring#360](https://github.com/pubky/pubky-ring/pull/360)) but isn't in the latest release, [v1.19](https://github.com/pubky/pubky-ring/releases/tag/v1.19). Every Ring sign-in on the Shop is therefore a cookie sign-in. The beta stopgaps don't depend on Ring grants.
  - **No single sign-on with pubky.app.**
    - The target design is **delegated grants through a Passport agent**: [pubky-sso-design.md](../sso/pubky-sso-design.md), team version [sso-proposal-for-team.md](../sso/sso-proposal-for-team.md), summary in launch plan §3.
      - The signer approves once per browser.
      - Passport issues each app its own grant, labelled with the verified origin.
    - It needs:
      - **Two small homeserver fixes first:**
        - several bearers per grant, because two tabs on one grant currently invalidate each other's bearer (vlada's finding);
        - no cookie fallback for bearer requests.
      - **Ring's grant-auth release.**
      - **pubky.app's migration, [#2614](https://github.com/pubky/pubky-app/pull/2614).**
      - **Delegable grants** in the homeserver and SDK.
      - **Passport as the agent.**
      - **Ring and Bitkit** consent and session screens.
      - **Messaging on the app's own grant session:** a Paykit storage interface and WASM package, replacing our `paykit-wasm` in [BitcoinErrorLog/paykit-rs-official](https://github.com/BitcoinErrorLog/paykit-rs-official).
    - That puts it outside the beta.
    - The Ring bundle (one approval issuing grants to several apps through companion frames) was considered and rejected; see launch plan §3.
  - **Leftover production test listings:** being deleted (D6).
  - **Address search 503** ([#61](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/61)): the fix is in progress.

## First tasks

1. Get access: GitHub repos, the Vercel `synonymdev` team, Sentry. Run the Shop and the sandbox locally.
2. Cut one release end to end (v0.6.42 or the next train) with John watching, using the F7 repo runbook. Write down every step that still only works on John's machine.
3. Pick up today's work in review: the F1 link-out (merged behind a flag that is off) and the F4 Passport Kimi audit and fixes. The Passport proof needs a Google test account from John.
4. Build the D5 scope stopgap: Ring cookie sign-in requests both sites' scopes, with a separate constant so Bitkit's exact-set checks are unaffected. It needs Sol + Kimi.
5. Work through the launch-blocking list in launch plan §5 with QA, including the cross-site sign-in matrix.
6. Start on SSO prerequisites with the upstream teams, using the [team proposal](../sso/sso-proposal-for-team.md):
   - **Core:** several bearers per grant and no cookie fallback (SSO-H5, H6) first.
   - **Ring:** the grant-auth release is in progress (SSO-R0), the client id and scopes on the approval screen are agreed, and the grant list is [#369](https://github.com/pubky/pubky-ring/pull/369).
   - **pubky.app:** review [#2614](https://github.com/pubky/pubky-app/pull/2614).
   - **Paykit:** the storage interface and WASM package (SSO-Y1, Y2).

   Moving the Shop's Ring users to grants (SSO-F1) waits on those, plus our messaging port (SSO-F2).

## Who to ask

| Topic | Person (GitHub) |
|---|---|
| Product calls, priorities, Vercel access, test seats, backend deploys until the cutover | John ([BitcoinErrorLog](https://github.com/BitcoinErrorLog)) |
| New instances on Synonym's cloud | Synonym DevOps |
| Passport integration | [pubky-passport](https://github.com/pubky/pubky-passport) maintainers |
| Testing, issue reports, payment canaries | Pav ([thisispav](https://github.com/thisispav)) |
| Bitkit testing | Piotr ([piotr-iohk](https://github.com/piotr-iohk)) |
| Visual design and design PRs | Aldert ([aldertnl](https://github.com/aldertnl)) |
| pubky.app changes (menu links, grants) | pubky-app maintainers: [secondl1ght](https://github.com/secondl1ght), [infin1t3](https://github.com/infin1t3), [talosmachina](https://github.com/talosmachina) |
| Nexus upstream | Chris (pubky-nexus maintainer) |
| Homeserver behavior (429s, locks) | tomos (homeserver team) |
| Delegable grants, several bearers per grant, SDK | Pubky core ([pubky/pubky-core](https://github.com/pubky/pubky-core)); Marcos for the homeserver multi-bearer fix |
| pubky.app grant migration ([#2614](https://github.com/pubky/pubky-app/pull/2614)) | vlada |
| Ring grant-auth release and consent screens | Philipp ([pubky/pubky-ring](https://github.com/pubky/pubky-ring)) |
| Passport as the account agent | [pubky-passport](https://github.com/pubky/pubky-passport) maintainers |
| Paykit server and SDK | dzdidi; Ben for the Paykit architecture |
| Locks | Denys |
| Ring and Bitkit sign-in, keychain sharing | Jay; [ovitrif](https://github.com/ovitrif) for Bitkit and Paykit issues |
