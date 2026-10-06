# Pubky Shop: team brief

For developers taking over [shop.pubky.app](https://shop.pubky.app) for the beta. The launch plan, with decisions and the timeline, is in [shop-launch-plan.md](shop-launch-plan.md).

## What the Shop is

A peer-to-peer marketplace on Pubky:

- **Records live with the seller.** Sellers publish shops, listings, reviews and drops as signed records on their own homeserver.
- **A small Rust service enforces the rules a browser can't.** It owns single-winner inventory, auctions, orders and receipts.
- **Payments go straight to the seller.** Bitcoin runs over Paykit and Locks; PayPal is seller-direct. Card payments are paused.
- **No custody.** The Shop never holds funds.
- **Built-in messaging.** Messages are end-to-end encrypted over Paykit Encrypted Links today. That stack is frozen as beta and moves to the shared pubky-chat library on MLS ([chat plan](https://github.com/pubky/pubky-chat/blob/main/docs/chat-unification-plan.md), item E1).

The web client is a fork of the Pubky social app ([pubky/pubky-app](https://github.com/pubky/pubky-app)). For the beta it runs as its own site next to pubky.app, and social pages link back there (launch plan §2).

## Repos and deploys

| Repo | What | Branch for work | Deploys to |
|---|---|---|---|
| [pubky/pubky-marketplace](https://github.com/pubky/pubky-marketplace) (this repo) | Shop web client (Next.js 16, SDK `@synonymdev/pubky` 0.11), these docs, tester issues | `master`, the release line and repo default. Releases up to `shop-v0.6.46` were cut from `release/shop-v0.6.8` in the fork `BitcoinErrorLog/pubky-app`, which is frozen for Shop work from 6 Oct; its history and tags are here | Vercel production project → shop.pubky.app; Vercel staging project → a generated Vercel staging host |
| [pubky/pubky-marketplace-service](https://github.com/pubky/pubky-marketplace-service) | Transaction service (Rust, sqlx, Postgres) | `main` | Railway, via a GHCR image pinned in `.railway/railway.ts`; staging at `staging-api.pubky.app` |
| [BitcoinErrorLog/pubky-nexus](https://github.com/BitcoinErrorLog/pubky-nexus) | Marketplace indexer (Nexus fork) | `main` | Railway, marketplace Nexus project; see `docs/railway-deploy.md` |
| [BitcoinErrorLog/paykit-server](https://github.com/BitcoinErrorLog/paykit-server) | Paykit server (fork, rc55). Being ported onto upstream, on the latest Paykit rc6x, before the beta (launch plan §5); the port runs as exactly one process | `master` | Railway; production host `paykit-shop.pubky.app` |
| [BitcoinErrorLog/pubky-app-specs](https://github.com/BitcoinErrorLog/pubky-app-specs) | Marketplace record types (specs fork) | — | Vendored into the Shop as a tarball |
| [pubky/pubky-shop-sdk](https://github.com/pubky/pubky-shop-sdk) | `@bitcoinerrorlog/pubky-shop` SDK (npm) | `main` | npm |
| [pubky/pubky-marketplace](https://github.com/pubky/pubky-marketplace) | Issue tracker for testers | — | — |

The backend services run today on the current Railway deployment, and the current maintainers run every deploy there until the cutover. Backend PRs merge on GitHub and the current maintainers deploy them, staging then production. Infra is one of two options (launch plan §7, D8):

- **R:** the current Railway deployment stays through the beta.
- **S:** Synonym DevOps builds new instances on Synonym's cloud and cuts over before the beta (recommended).

The full inventory is in launch plan §7.

## Run it locally

```bash
git clone https://github.com/pubky/pubky-marketplace.git && cd pubky-marketplace
HUSKY=0 npm ci           # HUSKY=0 keeps husky from overriding your git hooks
npm run marketplace:dev  # terminal 1: in-memory sandbox service on :3100
PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=sandbox \
PUBKY_RUNTIME_MARKETPLACE_URL=http://localhost:3100 npm run dev   # terminal 2
```

- **Sandbox walkthrough:** sign in, open `/marketplace/sandbox` and seed the catalog. Details: [RUNNING.md](../../docs/ecommerce/RUNNING.md).
- **The real Rust service:** see the service [README](https://github.com/pubky/pubky-marketplace-service#run). It needs a local Postgres that uses scram-sha-256 auth.

## Test and merge

- **Before every push, run `bash scripts/prepush.sh`.** The fast mode (default) runs prettier and eslint on changed files, typecheck, and `vitest related`. Its last line is `PREPUSH OK <sha> <seconds> <mode>`. A passing tree is reused, so pushing the same tree again doesn't rerun it.
- **Releases run the full gate:** `PREPUSH_FULL=1 bash scripts/prepush.sh`. It adds Linux visual-regression (VRT) tests in the pinned Playwright container (`bash scripts/vrt-linux.sh src/test/vrt/marketplace/`).
- **CI checks for `master`** (to be marked required in this repo's branch protection; `launch-e2e` runs on PRs into `master` once the repo has its seller secret):
  - Code Quality, NextJS Build;
  - the five test shards, Run Tests, Merge Coverage Reports;
  - `vrt-marketplace`, `vrt-core`, `launch-e2e`.
  - No approving review is required yet. The Shop team sets its review rule (launch plan §9); the recommendation is an independent reviewer on every PR, plus a security review for auth, crypto, Paykit and messaging changes.
- **Merging:** maintainers merge. Auto-merge is off in this repo; the team decides whether to enable it. After pushing, wait with `gh pr checks <N> --watch`, then ask a maintainer to merge; they merge with `gh pr merge <N> --squash` once every check passed or skipped. Automated agents open PRs and comment, and never merge or push `master`. Docs-only PRs (`docs/`, `payments-env/`, `*.md`) skip the build, unit suite and VRT.
- **A flake outside your diff:** rerun those test files alone twice. If both pass, the push may skip the hook, as long as the logs go in the PR body. Never skip on a touched file, typecheck, lint or VRT.
- **VRT baselines:** regenerate Linux baselines only for scenes you changed, once, in a commit of PNGs alone. Never re-pin a scene you didn't touch.
- **Code rules** are in [AGENTS.md](../../AGENTS.md). In short:
  - layering is UI → controllers → application → services;
  - no `useMemo` or `useCallback`;
  - no barrel files;
  - errors through the `Err.*` factories;
  - telemetry carries no ids or URLs.

## Release

- **The train.** At most 1–2 Shop releases a day. Feature PRs go to `train/shop-<date>-<am|pm>`. At the cut the train merges into the release branch, Linux baselines regenerate once, the full proof runs, then:
  - deploy with `vercel --prod --yes --force`, linked to the Shop's production project;
  - tag `shop-vX.Y.Z`;
  - publish a GitHub release whose notes come from `changelog.d/next` fragments.
- **"Live" needs a signed-in production proof, not a green build.** The proof is `scripts/release/release-proof.mjs`, which signs in two test seats, runs checkout on a temporary PayPal fixture, and cleans up after itself. The team uses its own newly minted test seats (launch plan §9); existing proof seats are not handed over.
- **Service and Nexus releases** follow each repo's README and `.railway/README.md`: GHCR image, digest pin in IaC, a `railway config plan` that shows no changes, then deploy and health checks.
- **Pre-launch policy:** fix forward. Roll back only on data loss or money moving wrongly.

### Release, deploy and rollback per service

Until the infra cutover (launch plan §7), the current maintainers run deploys. Each owning team assigns who takes over its row; a team member shadows the next release of each and writes down any step the repo docs don't cover.

| Service | Release and deploy | Rollback | Documentation gap |
|---|---|---|---|
| Shop | [`docs/ecommerce/release.md`](../../docs/ecommerce/release.md): train, VRT baselines, Vercel deploy, signed-in proof, tag and notes | [`runbook-production.md`](../../docs/ecommerce/runbook-production.md): kill switch, Vercel rollback or promote, moving the domain | The team has no Shop deploy access yet. `release.md`'s staging section needs a PayPal fixture listing that no repo script creates, so listing-creating staging proofs are paused until a fixture script with a teardown check lands in `scripts/release/`. Its "Backend releases" section says "the owner deploys them"; in practice the current maintainers deploy until the cutover |
| Marketplace service | [`.railway/README.md`](https://github.com/pubky/pubky-marketplace-service/blob/main/.railway/README.md) (IaC apply); service [README](https://github.com/pubky/pubky-marketplace-service#run) | `runbook-production.md`, "Railway Service Restart And Rollback". After a migration, fix forward only | Not in the repo yet: the image-connect deploy, the environment-targeting guard (staging's only environment is also named `production`), when to run the hold smoke, the production-schema-clone migration rehearsal, and the variables to drop at the next IaC apply. Target: `docs/operations/deploy.md` |
| Nexus fork | [`docs/railway-deploy.md`](https://github.com/BitcoinErrorLog/pubky-nexus/blob/main/docs/railway-deploy.md), [`docs/production-cutover.md`](https://github.com/BitcoinErrorLog/pubky-nexus/blob/main/docs/production-cutover.md) | Reconnect the previous digest | Check the docs cover waiting for in-flight deployments (one source connect can start two) and the token-redaction smoke |
| Paykit server | [`docs/operations/production-image.md`](https://github.com/BitcoinErrorLog/paykit-server/blob/master/docs/operations/production-image.md) (image pin); `scripts/rehearse-production-schema-clone.sh` | Reconnect the previous digest; stop the old deployment first | No deploy doc and no IaC. The one-process rule needs stop-then-start; write that order into `docs/operations/deploy.md` |
| Locks (fork) | [pubky-payment-rails README](https://github.com/pubky/pubky-payment-rails#readme) | Reconnect the previous digest | No deploy doc and no IaC; ownership at cutover is open (launch plan §9) |

Write the backend deploy docs without machine paths or infrastructure IDs, and rewrite them for Synonym's cloud after the cutover.

## Where the docs are

Shop docs, all in this repo's `docs/`:

- [`docs/ecommerce/status.md`](../../docs/ecommerce/status.md): what's real and what's simulated.
- [`FEATURES.md`](../../docs/ecommerce/FEATURES.md): the feature inventory.
- [`runbook-production.md`](../../docs/ecommerce/runbook-production.md): production operations.
- [`single-approval.md`](../../docs/ecommerce/single-approval.md) and [`step-up-approval.md`](../../docs/ecommerce/step-up-approval.md): sign-in.
- [ADRs 0019–0029](../../docs/adr): the marketplace architecture decisions.

Other repos:

- The service README covers command envelopes, inventory semantics and operations.
- On the Nexus fork: `docs/railway-deploy.md` and `docs/production-cutover.md`.

Project context:

- [launch plan](shop-launch-plan.md), in this folder;
- [SSO proposal](../sso/sso-proposal-for-team.md) and [SSO design](../sso/pubky-sso-design.md);
- the loose-ends list, Nexus fork audit, upstream convergence plan, messaging plan and decisions log are internal; ask John for them.

## Current status (5 Oct)

Launch blockers, deadlines and open decisions are in the launch plan (top section, §5, §9). The state each team needs this week:

- **Access.** Only the current maintainers can merge or deploy yet. Synonym DevOps' write invites for `pubky-app`, `pubky-marketplace-service`, `pubky-nexus`, `paykit-server`, `pubky-marketplace` and `paykit-rs-official`, plus three Railway projects, are unaccepted and expire **Thu 8 Oct around 17:07 UTC**. Every repo is public, so the invites only add write access.
- **Shop:** [v0.6.45](https://github.com/BitcoinErrorLog/pubky-app/releases/tag/shop-v0.6.45) is live (released 1 Oct). It shipped F1 (behind a flag that is off), F4 Passport, F5, F7, D5, [#62](https://github.com/pubky/pubky-marketplace/issues/62), [#63](https://github.com/pubky/pubky-marketplace/issues/63), [#49](https://github.com/pubky/pubky-marketplace/issues/49) copy and the [#164](https://github.com/BitcoinErrorLog/pubky-app/issues/164) fix via [#178](https://github.com/BitcoinErrorLog/pubky-app/issues/178). F4 still needs its Google-login production proof.
- **Next release, v0.6.46:** `release/shop-v0.6.8` is four merged fixes ahead of `shop-v0.6.45`: [#183](https://github.com/BitcoinErrorLog/pubky-app/issues/183), [#184](https://github.com/BitcoinErrorLog/pubky-app/issues/184), [#185](https://github.com/BitcoinErrorLog/pubky-app/issues/185) and the VRT update [#186](https://github.com/BitcoinErrorLog/pubky-app/issues/186). The recommendation is to ship it as a normal train with a team member shadowing.
- **Messaging bug:** [#67](https://github.com/pubky/pubky-marketplace/issues/67). On v0.6.45 the buyer's inbox never loads and "Message seller" does nothing. The mute-list 404s are expected and not causal; the likely blocker is an untimed messaging status check that background sync bypasses. The issue is triaged but unassigned.
- **Test listings:** every listing under our deletion control has been deleted. The production catalogue still shows test-style listings whose source records we do not control ([#69](https://github.com/pubky/pubky-marketplace/issues/69)). The Nexus team owns the denylist for those records, the separate staging index, and the reset and reindex.
- **Monitoring:** Shop Sentry is off in both environments (no DSN is set), the backends alert through log lines only, and nobody is on call yet.
- **Backends:** every health endpoint returns 200. Service `main` is at [#79](https://github.com/pubky/pubky-marketplace-service/issues/79). Marketplace nexusd is at `71637ffa`; upstream merged our token-redaction fix [pubky/pubky-nexus#1099](https://github.com/pubky/pubky-nexus/issues/1099) on 3 Oct, so the fork can drop its redaction patch at the next upstream sync, and [#1100](https://github.com/pubky/pubky-nexus/issues/1100) is open.
- **Payments:** PayPal and Bitcoin have each completed a real production payment ([#53](https://github.com/pubky/pubky-marketplace/issues/53), [#54](https://github.com/pubky/pubky-marketplace/issues/54)). Stripe is paused.
- **Paykit:**
  - Paykit launches at the end of the week of 5 Oct or the week after (Ben, 2 Oct). On 5 Oct Ben gave no production date for Bitkit, and didn't promise rc62 as the shipping version, while performance testing continues ([paykit-rs#169](https://github.com/pubky/paykit-rs/issues/169#issuecomment-5991461514)).
  - Upstream rc59 is wire-incompatible with our rc55 fork, so the Paykit server port onto upstream is the launch's critical path. The recommended starting point, pending D10, is upstream paykit-server rc8, targeting the latest Paykit rc6x: rc62 today, the rc that Bitkit's shared-state PRs pin ([bitkit-android#1401](https://github.com/synonymdev/bitkit-android/issues/1401), [bitkit-ios#856](https://github.com/synonymdev/bitkit-ios/issues/856)); Bitkit `master` is still on rc56.
  - **The Paykit team assigns the port owner and decides which branch the port starts from (launch plan D10).**
  - Ben published Paykit [rc60](https://github.com/pubky/paykit-rs/releases/tag/v0.1.0-rc60), [rc61](https://github.com/pubky/paykit-rs/releases/tag/v0.1.0-rc61) and [rc62](https://github.com/pubky/paykit-rs/releases/tag/v0.1.0-rc62) on 3 Oct, all as prereleases. rc60 pins pubky-noise at revision `42e00f22`, so [pubky-noise#39](https://github.com/pubky/pubky-noise/issues/39) no longer gates us. rc61 fixed a link-lease bug introduced in rc60, and rc62 keeps rc61's API and persisted format. Request delivery on staging isn't down to a few seconds yet. We're pre-launch, so there's no Bitcoin pause plan.
  - rc60 state is readable by rc61 and rc62; the only fresh-state boundary is rc59 → rc60 (Ben, 5 Oct). Following Bitkit's pin within rc6x needs no reset.
  - **No upstream dependency remains for the port.** Upstream paykit-server's latest tag is still `v0.1.0-rc8`, on rc59, and there's no date for an rc62 release (Ben, 5 Oct). So the port bumps Paykit on rc8 itself: the rc62 SDK, the signed-key authorization setup, the delegated `/pub/paykit/:rw` scope, and fresh databases. If an rc6x server release lands first, the port rebases onto it.
  - **Bitkit is the Paykit authorizer** (Ben, 5 Oct), for identities it creates and for Ring identities it reads through the shared keychain on the same device. It publishes the signed key and delegates Paykit access to the server without the Pubky secret. Seller Bitcoin setup therefore needs Bitkit holding the seller's identity. Sellers whose identity lives only in Passport, or in Ring on another phone, see a connect-Bitkit step; PayPal is unaffected.
  - The plan's rule: Paykit state is shared per identity by design, and the server holds the seller's delegated Paykit key, not identity or spending keys. The merge-forward in [paykit-server#28](https://github.com/BitcoinErrorLog/paykit-server/issues/28) departs from that rule on its manual-claim path, so it is held until a protocol design review checks it (launch plan §9 D10).
  - The [paykit-server#27](https://github.com/BitcoinErrorLog/paykit-server/issues/27) fix (a buyer's request must never go to their own claim inbox) landed on `master` via [#29](https://github.com/BitcoinErrorLog/paykit-server/issues/29) on 5 Oct; deployment remains. [paykit-server#23](https://github.com/BitcoinErrorLog/paykit-server/issues/23) was closed on 1 Oct without merging.
  - Ben's signed Noise-key proof ([pubky/paykit-rs#169](https://github.com/pubky/paykit-rs/issues/169)) closes the App Registry key swap. The handshake gap we raised is closed (3 Oct): Ben's commits `4eda7102` and `73345917` check the peer's static key against the signed key before any transport use, on handshake completion and on restore. A mismatch fails into recovery-required, and substitution tests cover both roles and restored links. Jasonvdb approved; dzdidi's re-review is pending.
  - There is no rc59 compatibility fallback: rc59 state is officially unsupported, which fits the port's fresh database.
  - The Shop needs no Paykit code in the browser for payments.
- **Homeserver:**
  - **Production `homeserver.pubky.app` runs v0.14.0 since 5 Oct** ([pubky/pubky-stack#338](https://github.com/pubky/pubky-stack/issues/338)), with the WebDAV locks rc59 and rc60 need. `/info` advertises `webdav-locks`.
    - Locks work on the path-addressed `/storage/{user}/{path}` route. A write without the token on a locked path gets 423, and a stale token gets 412.
    - The Shop, service, Paykit server and marketplace Nexus showed no breakage on it: sign-in (Ring and Bitkit grant), messaging, listings, logs.
    - The Paykit port's production-homeserver gate is cleared, and the Bitkit team can retest lock-based flows on production.
  - **Not in production yet:**
    - the same-path 500 → 429 fix ([pubky/pubky-homeserver#662](https://github.com/pubky/pubky-homeserver/issues/662)) was merged after the v0.14.0 tag, so same-path races still return 500. The Shop already retries 429, 500 and 503 on every write; keep the 500 retry until it ships.
    - The lock-gap fix ([pubky/pubky-homeserver#654](https://github.com/pubky/pubky-homeserver/issues/654)), where a write can still publish after its lock expired, is still open (Sev). Until it ships, nothing should rely on homeserver locks for exclusivity across a stalled write.
- **Open tester issues:** [pubky-marketplace issues](https://github.com/pubky/pubky-marketplace/issues).
- **Known gaps,** detailed in launch plan §3 and §5:
  - **Permissions overwrite.** The two sites' cookie sign-ins overwrite each other's permissions. The stopgap: Ring sign-in requests both sites' scopes (D5, shipped in v0.6.45).
  - **Messaging needs a Ring cookie session.** The vendored `paykit-wasm` supports only cookie sessions, so Bitkit and Passport users get no messaging, and Ring can't move to grants yet. This stays until the MLS cutover (chat plan E1), which is what brings messaging to Passport and Bitkit users. Paykit won't ship a browser package, so there is no Paykit-side fix to wait for.
  - **Released Ring signs in with cookies only.** Ring's grant auth is merged ([pubky-ring#360](https://github.com/pubky/pubky-ring/issues/360)) but isn't in the latest release, [v1.19](https://github.com/pubky/pubky-ring/releases/tag/v1.19). Every Ring sign-in on the Shop is therefore a cookie sign-in. The beta stopgaps don't depend on Ring grants.
  - **No single sign-on with pubky.app.**
    - The target design is **delegated grants through a Passport agent**: [pubky-sso-design.md](../sso/pubky-sso-design.md), team version [sso-proposal-for-team.md](../sso/sso-proposal-for-team.md), summary in launch plan §3.
      - The signer approves once per browser.
      - Passport issues each app its own grant, labelled with the verified origin.
    - It needs:
      - **Two small homeserver fixes first:**
        - several bearers per grant, because two tabs on one grant currently invalidate each other's bearer (vlada's finding);
        - no cookie fallback for bearer requests.
      - **Ring's grant-auth release.**
      - **pubky.app's migration, [#2614](https://github.com/pubky/pubky-app/issues/2614).**
      - **Delegable grants** in the homeserver and SDK.
      - **Passport as the agent.**
      - **Ring and Bitkit** consent and session screens.
      - **Messaging on the app's own grant session:** the shared pubky-chat library on MLS (E1), replacing our `paykit-wasm` in [BitcoinErrorLog/paykit-rs-official](https://github.com/BitcoinErrorLog/paykit-rs-official).
      - **Scoped keys** for `/priv` data, which the signer derives and delivers beside the grant (SSO-K6; SDK work in progress).
    - That puts it outside the beta.
    - The Ring bundle (one approval issuing grants to several apps through companion frames) was considered and rejected; see launch plan §3.
  - **Leftover production test listings:** every listing under our deletion control is deleted. The Nexus team handles the denylist for the remaining source records, the separate staging index, and the reset and reindex (#69).
  - **Address search 503** ([#61](https://github.com/pubky/pubky-marketplace/issues/61)): closed on GitHub on 1 Oct; confirm the service's breaker no longer trips on Photon failures before go/no-go.
  - **Backups:** marketplace production Postgres has daily backups with 30-day retention, and Paykit Postgres has WAL archiving configured. No restore test is recorded, and nothing backs up Neo4j or Redis.

## First tasks

Each owning team assigns the people behind these roles: the Shop team its Shop lead and Shop devs, the marketplace backend team its backend developer, the Paykit team the port owner, and the operations team the beta-week on-call. Dates and owners are in the launch plan's deadline table.

1. **Get access.** Accept the GitHub and Railway invites before Thu 8 Oct, 17:07 UTC. Run the Shop and the sandbox locally.
2. **Paykit team: assign the port owner and choose the base branch (D10)** — a fresh port from upstream rc8, or the merge-forward in #28. Ben answered the authorizer question on 5 Oct: Bitkit publishes the signed key and delegates, and the server never gets the Pubky secret. Before more code, a protocol design review checks the port, and #28's server-minted Paykit secret, against that model. The port is sensitive work: design review, independent protocol review, security review, and a staging proof with rc6x Bitkit builds on Android and iOS, including request-delivery latency. Deploy it once, on the target infra; a port deployed on Railway and then again on Synonym's cloud costs sellers two Paykit reconnects. There's no paykit-server release on rc62 and no date for one, so the owner bumps Paykit on rc8 and rebases if an rc6x release lands first.
3. **Shop team: fix [#67](https://github.com/pubky/pubky-marketplace/issues/67)** before the freeze, starting with the untimed messaging status check, and open `pubky-app` issues for the two chat Phase 0 fixes ([chat plan](https://github.com/pubky/pubky-chat/blob/main/docs/chat-unification-plan.md)): the receive cap must defer messages instead of consuming them unread (P0-1), and sign-out must not keep the encrypted history (P0-2). All three get a security review.
4. **Shop team: shadow v0.6.46** end to end using `release.md`, and write down every step the repo docs don't cover. Then run the F4 Google-login production proof.
5. **Operations team: assign the beta-week on-call.** Set the Shop Sentry DSN on staging, then production. Add uptime checks on the service `/ready`, Paykit `/health/ready`, Nexus `/v0/info`, Locks `/healthz` (there is no `/health`) and the Shop's `/marketplace`. Run one Postgres restore drill.
6. **Marketplace backend team:** write `docs/operations/deploy.md` for `pubky-marketplace-service` and `paykit-server` (gaps in the release table above).
7. **Nexus team:** add the denylist for the remaining test listings, give staging its own index, then run the reset and reindex. Every listing under our deletion control is already deleted.
8. Work through the launch-blocking list in launch plan §5 with QA, including the cross-site sign-in matrix.
9. Start on SSO prerequisites with the upstream teams, using the [team proposal](../sso/sso-proposal-for-team.md):
   - **Core:** several bearers per grant and no cookie fallback (SSO-H5, H6) first.
   - **Ring:** the grant-auth release is in progress (SSO-R0), the client id and scopes on the approval screen are agreed, and the grant list is [#369](https://github.com/pubky/pubky-ring/issues/369).
   - **pubky.app:** review [#2614](https://github.com/pubky/pubky-app/issues/2614).
   - **Paykit:** nothing for SSO. The storage interface and WASM package (SSO-Y1, Y2) are withdrawn.

   Moving the Shop's Ring users to grants (SSO-F1) waits on those, plus the Shop's move to pubky-chat (E1).

## Who to ask

| Topic | Person (GitHub) |
|---|---|
| Product calls, priorities and the open product decisions (launch plan §9) | John ([BitcoinErrorLog](https://github.com/BitcoinErrorLog)) |
| Backend deploys and Shop deploy access until the cutover | the current maintainers, until the handover |
| Infra move, new instances on Synonym's cloud, invite acceptance | Vlad (Synonym DevOps) |
| paykit-server#28 merge-forward | icota |
| paykit-server#27, Bitkit and Paykit wiring | [ovitrif](https://github.com/ovitrif) |
| An rc6x paykit-server release, or coordinating the port's rc62 bump; Paykit rc pins and the authorizer model | dzdidi; Ben for the Paykit architecture |
| Passport integration | [pubky-passport](https://github.com/pubky/pubky-passport) maintainers |
| Testing, issue reports, payment canaries; #50, #12, #67, #69, #70 | Pav ([thisispav](https://github.com/thisispav)) |
| Bitkit testing | Piotr ([piotr-iohk](https://github.com/piotr-iohk)) |
| Visual design and design PRs | Aldert ([aldertnl](https://github.com/aldertnl)) |
| pubky.app changes (menu links, grants) | pubky-app maintainers: [secondl1ght](https://github.com/secondl1ght), [infin1t3](https://github.com/infin1t3), [talosmachina](https://github.com/talosmachina) |
| Nexus upstream | Chris (pubky-nexus maintainer) |
| Homeserver behavior (429s, locks) | tomos (homeserver team); Sev for the lock-gap fix |
| Production homeserver deploys (v0.14.0 since 5 Oct; #662 and #654 next) | James |
| Scoped keys in the SDK | Andrei |
| Delegable grants, several bearers per grant, SDK | Pubky core ([pubky/pubky-core](https://github.com/pubky/pubky-core)); Marcos for the homeserver multi-bearer fix |
| pubky.app grant migration ([#2614](https://github.com/pubky/pubky-app/issues/2614)) | vlada |
| Ring grant-auth release and consent screens | Philipp ([pubky/pubky-ring](https://github.com/pubky/pubky-ring)) |
| Passport as the account agent | [pubky-passport](https://github.com/pubky/pubky-passport) maintainers |
| Paykit server and SDK | dzdidi; Ben for the Paykit architecture |
| Locks, Locks rc8 and the upstream Locks switch | Denys |
| Ring and Bitkit sign-in, keychain sharing | Jay; [ovitrif](https://github.com/ovitrif) for Bitkit and Paykit issues |
