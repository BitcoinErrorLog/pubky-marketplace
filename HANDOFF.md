# Pubky Marketplace Handoff

## What This Is

Pubky Marketplace is a P2P marketplace on Pubky: sellers publish catalog records on their own homeservers, the transaction service sequences the invariants browsers cannot, and payment rails stay outside operator custody. There is no operator authority over trades; disputes, reports, tax, and the moderator role were removed from the transaction service by migration 0018, see `/Users/johncarvalho/.cursor/plans/vibes-first_marketplace_master_plan_d8646c7a.plan.md`.

## Repos And Branches

| Repo | Remote | Deployed branch / line | Current HEAD check |
| --- | --- | --- | --- |
| `pubky-marketplace-umbrella` | `https://github.com/BitcoinErrorLog/pubky-marketplace.git` | `/Users/johncarvalho/work/pubky-marketplace-umbrella`, branch `master` | branch `master`; current HEAD via `git -C /Users/johncarvalho/work/pubky-marketplace-umbrella log -1 --oneline` |
| `mp-ux` / Shop client | `https://github.com/BitcoinErrorLog/pubky-app.git` | integration: `/Users/johncarvalho/work/mp-ux`, branch `marketplace/pr25-ux` (also deploys staging); production: `/Users/johncarvalho/work/mp-prod-deploy`, branch `marketplace/prod-deploy`, Vercel project `pubky-marketplace-production` (serves `https://shop.pubky.app`); shipped single-approval implementation: `/Users/johncarvalho/work/mp-oneauth`, branch `marketplace/one-approval`; bridge rehearsal: `/Users/johncarvalho/work/mp-bridge-rehearsal`, branch `marketplace/bridge-rehearsal`; production probe: `/Users/johncarvalho/work/mp-probe`, branch `marketplace/prod-probe` | current HEAD via `git -C /Users/johncarvalho/work/mp-ux log -1 --oneline`, `git -C /Users/johncarvalho/work/mp-prod-deploy log -1 --oneline`, `git -C /Users/johncarvalho/work/mp-oneauth log -1 --oneline`, `git -C /Users/johncarvalho/work/mp-bridge-rehearsal log -1 --oneline`, or `git -C /Users/johncarvalho/work/mp-probe log -1 --oneline` |
| `marketplace-service` | `https://github.com/BitcoinErrorLog/pubky-marketplace-service.git` | `/Users/johncarvalho/work/marketplace-service`, branch `main` for the transaction service | branch `main`; current HEAD via `git -C /Users/johncarvalho/work/marketplace-service log -1 --oneline` |
| `pubky-nexus` | `https://github.com/BitcoinErrorLog/pubky-nexus` | `/Volumes/vibedrive/vibes-dev/pubky-nexus`, branch `feat/marketplace-indexing` for staging and production marketplace Nexus | branch `feat/marketplace-indexing`; current HEAD via `git -C /Volumes/vibedrive/vibes-dev/pubky-nexus log -1 --oneline`; fixed artifact references remain in `docs/production-cutover.md` and deployment records |
| `pubky-payment-rails` | `https://github.com/BitcoinErrorLog/pubky-payment-rails.git` | `/Users/johncarvalho/work/pubky-payment-rails`, branch `master`, Railway project `pubky-marketplace-staging` | branch `master`; current HEAD via `git -C /Users/johncarvalho/work/pubky-payment-rails log -1 --oneline` |
| `pubky-fiat-verifier` | `https://github.com/BitcoinErrorLog/pubky-fiat-verifier.git` | `/Users/johncarvalho/work/pubky-fiat-verifier`, branch `master`, Railway service `fiat-verifier` | branch `master`; current HEAD via `git -C /Users/johncarvalho/work/pubky-fiat-verifier log -1 --oneline` |
| `specs-mp4` / specs fork | `https://github.com/BitcoinErrorLog/pubky-app-specs.git` | `/Users/johncarvalho/work/specs-mp4`, branch `marketplace-4-build`, consumed by Shop/Nexus/service contracts | branch `marketplace-4-build`; current HEAD via `git -C /Users/johncarvalho/work/specs-mp4 log -1 --oneline` |

## Deployments

Wave 4 cutover happened 2026-09-08 (`mp-ux` `1fd113c0`, procedure correction `790ca03e`): `https://shop.pubky.app` is served by Vercel project `pubky-marketplace-production` (HTTP 200, production runtime). Staging Shop is `https://pubky-marketplace-staging.vercel.app` from `mp-ux` `marketplace/pr25-ux`. Money rails remain test networks; this is not a real-money launch.

The move is not a Vercel domain reassignment. The `pubky.app` zone is externally managed and its apex belongs to another Vercel account, so this team holds a host only by `_vercel` TXT proof. Vercel mints a **new** token on every attach, and attaching while the other project still holds the host fails with `domain_already_in_use`. Detach therefore always takes the hostname offline until the DNS owner publishes the token from the attach response. Re-running attach while waiting mints another token and invalidates the record just published; on 2026-09-08 that mistake became a ~2h 404 outage (published restore token `vc-domain-verify=shop.pubky.app,991fcfd32aa5a880503e`). Rule: DNS owner at the keyboard before detach; do not re-attach while waiting. Details: `mp-ux/docs/ecommerce/runbook-production.md`.

| Stack | Web client | Transaction / index services | Payment rails | Homeserver |
| --- | --- | --- | --- | --- |
| Staging | Vercel project `pubky-marketplace-staging`, alias `https://pubky-marketplace-staging.vercel.app`, deployed from `mp-ux` `marketplace/pr25-ux` | Railway project `pubky-marketplace-nexus`, service `nexusd`, public API `https://nexusd-production-7108.up.railway.app`, watching staging; marketplace-service staging: Railway project `pubky-marketplace-staging`, service `marketplace-service`, `https://marketplace-service-production.up.railway.app` (verified via Railway CLI 2026-09-05) | Railway project `pubky-marketplace-staging`: `locks-server`, `fiat-verifier`, `paykit-server`, `bitcoind` regtest, `fulcrum`, plus Postgres services | `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` / `https://homeserver.staging.pubky.app` |
| Production | Vercel project `pubky-marketplace-production`, public host `https://shop.pubky.app`, stable alias `https://pubky-marketplace-production.vercel.app` | Railway project `pubky-marketplace-production` (`75faa4fe-466c-4277-977f-1d8e4e31df8c`): `nexusd` at `https://nexusd-production-95a0.up.railway.app`, `marketplace-service` at `https://marketplace-service-production-ce23.up.railway.app`, plus `neo4j`, `Redis`, and Postgres | Reuses the staging rails project over public domains (`locks-server-production.up.railway.app`, `paykit-server-production.up.railway.app`, `fiat-verifier-production.up.railway.app`); Railway private networking does not cross projects | `8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty` / `https://homeserver.pubky.app` |
| Same-site bridge rehearsal | Vercel project `pubky-app-bridge-rehearsal`, branch `feat/session-bridge` in the fork checkout `/Volumes/vibedrive/vibes-dev/pubky-app` (current HEAD via `git -C /Volumes/vibedrive/vibes-dev/pubky-app log -1 --oneline feat/session-bridge`), domain `https://bridge.pubky.app`; Shop rehearsal Vercel project `shop-bridge-rehearsal`, worktree `/Users/johncarvalho/work/mp-bridge-rehearsal`, branch `marketplace/bridge-rehearsal`, domain `https://shop-rehearsal.pubky.app` | Not a transaction-service change; rehearsal tests session bridge handoff between pubky.app and Shop | Uses Shop rehearsal env `NEXT_PUBLIC_VIBE_SESSION_BRIDGE_ORIGIN=https://bridge.pubky.app` and `PUBKY_RUNTIME_DEFAULT_URL`; pubky.app rehearsal env allows `https://shop-rehearsal.pubky.app` | Both domains verified 2026-09-06 13:16 UTC+1 and serve HTTP 200; any new `*.pubky.app` host needs a `_vercel.pubky.app` TXT record `vc-domain-verify=<host>,<token>` because the `pubky.app` apex is owned by another Vercel team |

### Tree ↔ Stack

| Tree | Stack |
| --- | --- |
| `/Users/johncarvalho/work/mp-ux` | Vercel `pubky-marketplace-staging`; alias `pubky-marketplace-staging.vercel.app` |
| `/Users/johncarvalho/work/mp-prod-deploy` | Vercel `pubky-marketplace-production`; public host `shop.pubky.app` plus alias `pubky-marketplace-production.vercel.app` |
| `/Users/johncarvalho/work/mp-oneauth` | Not a deploy tree. Branch `marketplace/one-approval` ships `docs/ecommerce/single-approval.md` (feature `c213ae9f`, tests `454828c5`, fixer round `454828c5..3e737732`, cleanup batch `e482e603..8881f90f`, N-1 follow-up `ac593082`) |
| `/Users/johncarvalho/work/mp-bridge-rehearsal` | Vercel `shop-bridge-rehearsal` |
| `pubky-app` fork branch `feat/session-bridge` | Vercel `pubky-app-bridge-rehearsal` |
| `/Users/johncarvalho/work/marketplace-service`, `/Users/johncarvalho/work/pubky-payment-rails`, `/Users/johncarvalho/work/pubky-fiat-verifier` | Railway staging project `pubky-marketplace-staging` (`c991d768-4a3c-42ea-b5ed-eaa22d4916ed`); Railway environment is named `production` |
| `/Volumes/vibedrive/vibes-dev/pubky-nexus` | Railway staging project `pubky-marketplace-nexus` (`af82731f-a6d0-4c0e-84cd-56ce6fcc8818`), and Railway production project `pubky-marketplace-production` (`75faa4fe-466c-4277-977f-1d8e4e31df8c`) using the same git checkout with different `-p` project IDs |

Vercel CLI: use `/Users/johncarvalho/.nvm/versions/node/v22.14.0/bin/vercel` or `npx vercel`; plain `vercel` is not on PATH in the cold-start shell. Team scope `synonymdev` is John's account, orgId `team_y2cqjCWZ9vTnCPWQkUAgfijD`. Each worktree's Vercel project linkage is discovered from its `.vercel/project.json`.

## Env And Secrets

Secrets live in Vercel env or Railway variables only. Do not copy values into this repo, logs, issue comments, or chat.

### Shop client (`mp-ux`, Vercel env)

Required network/runtime vars: `PUBKY_RUNTIME_NEXUS_URL` (main social Nexus), `PUBKY_RUNTIME_CDN_URL` (static file CDN), `PUBKY_RUNTIME_HOMESERVER` (homeserver pubky), `PUBKY_RUNTIME_HOMESERVER_URL` (HTTP homeserver base), `PUBKY_RUNTIME_HOMEGATE_URL` (signup/onboarding service), `PUBKY_RUNTIME_DEFAULT_HTTP_RELAY` (HTTP relay inbox), `PUBKY_RUNTIME_PKARR_RELAYS` (PKARR relay list), `PUBKY_RUNTIME_TESTNET` (DHT/network mode), `PUBKY_RUNTIME_ENV` (declared deploy identity: `staging` or `production`).

Commerce/runtime vars: `PUBKY_RUNTIME_MARKETPLACE_URL` (transaction service), `PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL` (marketplace-only Nexus override), `PUBKY_RUNTIME_LOCKS_URL` (Lock Server public URL), `PUBKY_RUNTIME_PAYKIT_SETUP_URL` (Paykit setup URL), `PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE` (commerce mode, production/staging use `locks-paykit` today), `PUBKY_RUNTIME_COMMERCE_POLL_INTERVAL_MS` (commerce polling), `PUBKY_RUNTIME_EXCHANGE_RATE_API` (indicative BTC/USD rate source).

Optional runtime vars: `PUBKY_RUNTIME_SENTRY_DSN`, `PUBKY_RUNTIME_SENTRY_ENVIRONMENT`, `PUBKY_RUNTIME_SENTRY_TRACES_SAMPLE_RATE`, `PUBKY_RUNTIME_SENTRY_REPLAYS_SESSION_SAMPLE_RATE`, `PUBKY_RUNTIME_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE`, `PUBKY_RUNTIME_NOTIFICATION_POLL_INTERVAL_MS`, `PUBKY_RUNTIME_NOTIFICATION_POLL_ON_START`, `PUBKY_RUNTIME_NOTIFICATION_RESPECT_PAGE_VISIBILITY`, `PUBKY_RUNTIME_STREAM_POLL_INTERVAL_MS`, `PUBKY_RUNTIME_STREAM_POLL_ON_START`, `PUBKY_RUNTIME_STREAM_RESPECT_PAGE_VISIBILITY`, `PUBKY_RUNTIME_STREAM_FETCH_LIMIT`, `PUBKY_RUNTIME_STREAM_CACHE_MAX_AGE_MS`, `PUBKY_RUNTIME_MAX_STREAM_TAGS`, `PUBKY_RUNTIME_TTL_POST_MS`, `PUBKY_RUNTIME_TTL_USER_MS`, `PUBKY_RUNTIME_TTL_BATCH_INTERVAL_MS`, `PUBKY_RUNTIME_TTL_POST_MAX_BATCH_SIZE`, `PUBKY_RUNTIME_TTL_USER_MAX_BATCH_SIZE`, `PUBKY_RUNTIME_TTL_RETRY_DELAY_MS`, `PUBKY_RUNTIME_MODERATION_ID`, `PUBKY_RUNTIME_MODERATED_TAGS`, `PUBKY_RUNTIME_PRELUDE_SDK_KEY`, `PUBKY_RUNTIME_PRELUDE_SDK_TIMEOUT_MS`, `PUBKY_RUNTIME_PLAUSIBLE_DOMAIN`, `PUBKY_RUNTIME_PLAUSIBLE_SCRIPT_URL`, `PUBKY_RUNTIME_PREVIEW_IMAGE`, `PUBKY_RUNTIME_SITE_NAME`, `PUBKY_RUNTIME_LOCALE`, `PUBKY_RUNTIME_AUTHOR`, `PUBKY_RUNTIME_KEYWORDS`, `PUBKY_RUNTIME_TYPE`, `PUBKY_RUNTIME_CREATOR`, `PUBKY_RUNTIME_DEFAULT_URL`, `PUBKY_RUNTIME_PUBKY_RING_URL`, `PUBKY_RUNTIME_PUBKY_CORE_URL`, `PUBKY_RUNTIME_NEXUS_SCOUT_URL`, `PUBKY_RUNTIME_TWITTER_URL`, `PUBKY_RUNTIME_TWITTER_GETPUBKY_URL`, `PUBKY_RUNTIME_TELEGRAM_URL`, `PUBKY_RUNTIME_GITHUB_URL`, `PUBKY_RUNTIME_EMAIL`, `PUBKY_RUNTIME_APP_STORE_URL`, `PUBKY_RUNTIME_PLAY_STORE_URL`.

Build-intrinsic vars: `NEXT_PUBLIC_DB_NAME`, `NEXT_PUBLIC_DB_VERSION`, `NEXT_PUBLIC_DEBUG_MODE`, `NEXT_PUBLIC_APP_VERSION`, `NEXT_PUBLIC_VIBE_SESSION_BRIDGE_ORIGIN` (production artifact points at `https://pubky.app`), `NEXT_PUBLIC_VIBE_ID` (`marketplace`). Source-map upload vars, if used by the deployment pipeline, are `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT`.

Source pointers in `/Users/johncarvalho/work/mp-ux`: `PUBKY_RUNTIME_*` names and defaults live in `src/libs/runtime-config/runtime-config.schema.ts`; `NEXT_PUBLIC_*` build-time names live in `src/libs/env/env.ts`; Sentry runtime and source-map variable names are documented in `docs/sentry.md`.

### Marketplace service (`marketplace-service`, Railway variables)

Core service vars: `DATABASE_URL` (Postgres), `BIND_ADDR` (HTTP bind), `ALLOWED_ORIGINS` (CORS), `AUTH_TOKEN_WINDOW_SECONDS` (AuthToken timestamp window), `AUTH_SESSION_TTL_SECONDS` (bearer session TTL), `WORKER_INTERVAL_SECONDS` (worker cadence), `WORKER_LEASE_SECONDS` (worker lease), `SANDBOX_PAYMENTS_ENABLED` (sandbox command gate; false in production).

Authority/payment vars: `LOCKS_SERVER_URL` (Lock Server base), `LOCKS_BUNDLE_ENCRYPTION_KEY` (sealed bundle IDs), `LOCKS_LOOKUP_HMAC_KEY` (correlation lookup HMAC), `LOCKS_PAYMENT_WINDOW_SECONDS` (Locks hold window), `FIAT_PAYMENT_WINDOW_SECONDS` (fiat hold window), `SANDBOX_PAYMENT_WINDOW_SECONDS` (sandbox hold window), `DROP_CLAIM_WINDOW_SECONDS` (drop claim hold), `LOCKS_POLL_SECONDS` (Locks polling), `ATTESTOR_SECRET_KEY` (service attestor identity), `ATTESTOR_ORDER_SALT` (stable order-ref salt), `STRIPE_KEY_ENCRYPTION_KEY` (seller Stripe key sealing), `STRIPE_API_BASE` (Stripe API base), `PAYKIT_SERVER_URL` (paykit-server base), `PAYKIT_REQUEST_SIGNING_KEY` (request-signing seed trusted by paykit-server), `PAYKIT_POLL_SECONDS` (Paykit polling), `PUBLIC_APP_ORIGIN` (Shop return origin), `PUBLIC_SERVICE_ORIGIN` (service origin for PayPal IPN), `PAYPAL_IPN_VERIFY_URL` (PayPal IPN validation), `SHIPPO_API_BASE` (Shippo API base).

`MODERATOR_PUBKYS` no longer exists in `marketplace-service`: migration 0018 removed operator authority because the target product has no operator arbiter or moderator role.

### Marketplace Nexus (`pubky-nexus`, Railway variables)

`NEXUS_HOMESERVER` (watched homeserver pubky), `NEXUS_NEO4J_URI` (graph DB), `NEXUS_NEO4J_PASSWORD` (Neo4j password), `NEXUS_REDIS_URL` (Redis cache/cursor), `NEXUS_TESTNET` (DHT/network mode), `PORT` (API bind), `NEXUS_EVENTS_LIMIT` (watcher page size), `NEXUS_WATCHER_SLEEP` (watcher sleep), `RAILWAY_DOCKERFILE_PATH` (must be `Dockerfile.railway` for `nexusd`; otherwise Railway can boot the plain Dockerfile and miss the generated config).

### Rails (`pubky-payment-rails`, Railway variables)

`bitcoind`: `BITCOIND_RPC_USER`, `BITCOIND_RPC_PASS`, `MINE_INTERVAL_SECONDS`, plus `/data` volume.

`fulcrum`: `BITCOIND_RPC_HOST`, `BITCOIND_RPC_USER`, `BITCOIND_RPC_PASS`, `FULCRUM_TCP_BIND`, plus `/data` volume.

`locks-server`: `LOCKS_KEYPAIR_SEED`, `LOCKS_PUBLIC_KEY`, `LOCKS_PUBLIC_DOMAIN`, `PUBKY_LOCK_DATABASE_URL`, `PUBKY_LOCK_CREATOR_AUTH_ENCRYPTION_KEY`, `LOCKS_ALLOWED_RETURN_ORIGINS`, `LOCKS_PAYKIT_SERVER_URL`, `LOCKS_PAYKIT_MIN_CONFIRMATIONS`, `LOCKS_PKDNS_PUBLIC_IP`.

`paykit-server`: `PAYKIT_TRUSTED_LOCKS_PUBLIC_KEY`, `PAYKIT_DATABASE_URL`, `PAYKIT_MASTER_KEY`, `PAYKIT_SETUP_ALLOWED_ORIGINS`, `PAYKIT_ELECTRUM_ENDPOINT`, `MARKETPLACE_TRUSTED_PUBLIC_KEYS` (list; legacy single `MARKETPLACE_TRUSTED_PUBLIC_KEY` still accepted, not both), `PAYKIT_AUTH_RELAY`.

`fiat-verifier`: `FIAT_TRUSTED_LOCKS_PUBLIC_KEY`, `FIAT_DATABASE_URL`, `FIAT_PAYKIT_SERVER_URL`, `FIAT_LISTEN_ADDR`, `PORT`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_API_BASE`, `FIAT_DEFAULT_PROCESSOR`, `FIAT_LIVE_MODE`, `FIAT_SETTLEMENT_DELAY_SECONDS`, `FIAT_SYNTHESIZED_CONFIRMATIONS`, `FIAT_ALLOWED_ASSETS`, `FIAT_CHECKOUT_SUCCESS_URL`, `FIAT_CHECKOUT_CANCEL_URL`, `FIAT_POLL_INTERVAL_SECONDS`, `FIAT_CHECKOUT_RATE_PER_SECOND`, `FIAT_CHECKOUT_RATE_BURST`, `STRIPE_API_BASE`.

## Deploy And Rollback

Do not run these from an agent unless the owner has explicitly approved that deploy. This repo is handoff documentation; it is not a deploy workspace.

| Service | Deploy command | Rollback |
| --- | --- | --- |
| Shop staging | From `/Users/johncarvalho/work/mp-ux` on `marketplace/pr25-ux`: `/Users/johncarvalho/.nvm/versions/node/v22.14.0/bin/vercel deploy --prod --scope synonymdev` or `npx vercel deploy --prod --scope synonymdev` for project `pubky-marketplace-staging` | Vercel `vercel rollback <deployment-url|id>` or `vercel promote <deployment-url|id>` for the target deployment |
| Shop production | From `/Users/johncarvalho/work/mp-prod-deploy` on `marketplace/prod-deploy` or the intended integration branch: `/Users/johncarvalho/.nvm/versions/node/v22.14.0/bin/vercel deploy --prod --scope synonymdev` or `npx vercel deploy --prod --scope synonymdev` for project `pubky-marketplace-production` | Vercel `vercel rollback <deployment-url|id>` or `vercel promote <deployment-url|id>`; moving `shop.pubky.app` is parent/owner-only |
| Marketplace service staging/production | From `/Users/johncarvalho/work/marketplace-service`: `railway up -p <project-id> -e production -s marketplace-service` after selecting the correct project (`pubky-marketplace-staging` or `pubky-marketplace-production`) | Railway dashboard rollback to a known-good deployment; `railway down` is not a rollback |
| Marketplace Nexus staging | From `/Volumes/vibedrive/vibes-dev/pubky-nexus` on `feat/marketplace-indexing`: `railway up -p <project-id> -e production -s nexusd` for project `pubky-marketplace-nexus` | Railway redeploy previous successful `nexusd`; keep Redis/Neo4j volumes unless intentionally restarting replay |
| Marketplace Nexus production | Same worktree/branch: `railway up -p <project-id> -e production -s nexusd` for project `pubky-marketplace-production`; set `RAILWAY_DOCKERFILE_PATH=Dockerfile.railway` first | Railway redeploy previous successful `nexusd`; if Redis is wiped, replay restarts from cursor zero |
| Rails services | From `/Users/johncarvalho/work/pubky-payment-rails`: `railway up -p <project-id> -e production -s locks-server`, `railway up -p <project-id> -e production -s paykit-server`, `railway up -p <project-id> -e production -s bitcoind`, `railway up -p <project-id> -e production -s fulcrum`; fiat verifier from `/Users/johncarvalho/work/pubky-fiat-verifier`: `railway up -p <project-id> -e production -s fiat-verifier` | Railway dashboard rollback per service; for identity/key rotation follow the volume coherence rules in `pubky-payment-rails/README.md` |

Railway production project id is `75faa4fe-466c-4277-977f-1d8e4e31df8c` (`pubky-marketplace-production`, verified 2026-09-05 via the Railway CLI). Staging project ids: `pubky-marketplace-staging` is `c991d768-4a3c-42ea-b5ed-eaa22d4916ed`; `pubky-marketplace-nexus` is `af82731f-a6d0-4c0e-84cd-56ce6fcc8818`.

Railway git deploys still read `railway.toml` (Dockerfile + `/health`). Both `marketplace-service` (`8a10253`, `.railway/railway.ts` covering staging **and** production via `ctx.projectId`) and `pubky-fiat-verifier` (`a76b1a4` / docs `5475ec3`) have IaC authored; **neither has been applied**. `railway config apply` is operator-only, once per linked project, after `railway config plan` shows no variable deletes (`preserve()` is load-bearing — omitted vars are planned deletes). Railway's old Config-as-Code (`railway.toml` / `railway.json`) hard-stops on 2026-12-01; apply before then and do not delete `railway.toml` until both applies succeed. Fiat-verifier's file describes only `pubky-marketplace-staging` because production reuses that service over its public domain; there is no second fiat-verifier project in `pubky-marketplace-production`.

Production kill switch and rollback details live in
`/Users/johncarvalho/work/mp-ux/docs/ecommerce/runbook-production.md` (committed at fixed doc artifact `5a1312f7` on `marketplace/pr25-ux`). The runbook also records Railway guidance: use dashboard rollback for an older known-good deployment; `railway down` removes the latest deployment and is not a rollback. The client kill switch is
`PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=unavailable` on Vercel project `pubky-marketplace-production`; restoring current
transaction mode means setting it back to `locks-paykit` and redeploying.

Health checks: `marketplace-service` answers `200` on `/health`; `/` returns `404` by design. `nexusd` also returns `404` on `/` by design; curl `https://nexusd-production-7108.up.railway.app/v0/stream/listings` for staging or `https://nexusd-production-95a0.up.railway.app/v0/stream/listings` for production marketplace stream health.

## Live Proofs

| Command / script | What it proves |
| --- | --- |
| `npm run test:marketplace:service` from `mp-ux` | Client transport, AuthToken session exchange, and durable service command/read contract against the running service. |
| `npm run test:marketplace:locks` / `src/test/live/locks-payment.live.ts` | Regtest Locks + Paykit payment path: proof bundle, payment request, on-chain payment, worker confirmation, receipt, guarded content. |
| `npm run test:marketplace:messaging` / `src/test/live/messaging.live.browser.ts` | Real Paykit encrypted-link messaging over a local Pubky testnet in a browser. |
| `npm run test:marketplace:messaging:staging` / `src/test/live/messaging-staging.live.browser.ts` | Same messaging path against the real staging homeserver/public relays, except the interactive Ring approval leg. |
| `npm run test:marketplace:watchlist` / `src/test/live/marketplace-watchlist-sync.live.browser.ts` | Cross-device private watchlist sync and homeserver `/priv` enforcement. |
| `npm run test:marketplace:cross-account` / `src/test/live/marketplace-cross-account.live.browser.ts` | Cross-account marketplace auth isolation on staging identities. |
| `npm run test:marketplace:reviews` / `src/test/live/reviews-index.live.ts` | Review publishing, attestation verification, Nexus indexing, and reputation path. |
| `npm run test:marketplace:drops` / `src/test/live/drops-race.live.ts` | FCFS drop race on deployed stack: exactly one winner, sold-out refusal, edition attestation, private receipt. |
| `src/test/live/priv-durability-probe.live.ts` | `/priv/pubky.app` write/read durability over elapsed windows. |
| `npx vitest run --config vitest.dm.config.ts` / `src/test/live/dm-to-user.live.browser.ts` | Real app UI receives an encrypted DM from a throwaway identity. |
| `node scripts/probe-listing-registration.mjs <seller> <listingId>` | `listing.sync` can heal an unregistered listing into the transaction service. Requires `STAGING_ADMIN_PASSWORD` (name only). The script defaults `STAGING_HOMESERVER_PUBKY` to `5eh8kjqfx4o7comfbtnqqxxi6oz3axeqfotpi7oiepwmoym1i16o`, which differs from the official staging homeserver `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy`; override with `STAGING_HOMESERVER_PUBKY=<pubky>`. |
| `node scripts/probe-nexus-listing-ingest.mjs` | Dedicated marketplace Nexus sees and serves listing ingest. |
| `node scripts/probe-media-write.mjs` | Media write path under the configured homeserver/session. |
| `node /Users/johncarvalho/work/pubky-payment-rails/verify/driver.mjs checkout <bundle> paypal` | Hosted PayPal sandbox purchase through deployed rails. The driver has no `--help`; document this checkout invocation only. |
| `node /Users/johncarvalho/work/mp-probe/scripts/probe-production-writes.mjs` | Production path-family PUT/GET/DELETE probe with Ring sign-in and `/priv` durability seed. Lives on the unmerged branch `marketplace/prod-probe` (worktree `/Users/johncarvalho/work/mp-probe`, off `pr25-ux`); merges into `pr25-ux` once the owner has run it. |

## ADR Index

| ADR | One-line purpose |
| --- | --- |
| 0019 | Splits marketplace authority: homeservers own public records, the Rust service sequences orders/payments/inventory without custody. |
| 0020 | Defines public marketplace records and transaction projections, amended for open-world records and absence-as-tombstone. |
| 0021 | Keeps v1 marketplace records under `/pub/pubky.app/marketplace/v1` to reuse the existing social app grant. |
| 0022 | Chooses Rust + PostgreSQL for the deployable transaction service and keeps the TypeScript service sandbox-only. |
| 0023 | Ships one deliberate Dexie reset for marketplace tables instead of multiple unreleased schema wipes. |
| 0024 | Makes purchase/review/order/drop attestations durable, signed, and portable outside the operator. |
| 0025 | Proposes v2 migration to `app.marketplace` with independent grants at the social/v1 break. |
| 0026 | Defines drops: seller-signed announcements, service-enforced scarcity/clock, and edition attestations. |
| 0027 | Designs the marketplace record layer migration onto social/v1 primitives and reversed-domain namespaces. |
| 0028 | Draws the indexer boundary by query vocabulary: social indexers keep anchors opaque, marketplace indexers open commerce records. |
| 0029 | Defines Shop as a vibe session consumer using build-time bridge origin and public `sessionExport` restore. |

## Evidence Ledger And Honest Gaps

The primary evidence ledger is `mp-ux/docs/ecommerce/status.md`. Current honest gaps to carry forward:

### 2026-09-08 Evidence Rows

| Evidence | Status | Where |
| --- | --- | --- |
| Wave 4 cutover | `shop.pubky.app` serves `pubky-marketplace-production` (`1fd113c0`). Staging alias is `pubky-marketplace-staging.vercel.app`. Domain-move runbook corrected at `790ca03e` after the ~2h TXT-token outage. | `mp-ux` runbook + changelog |
| Production Nexus residue | **Closed by owner decision, not by replay.** Wipe+replay from cursor zero was declined; ~26 staging-era listings stay dead in the production index (cards render, detail is `Listing unavailable`). New production listings index. Cheaper later remedy: surgical delete of those listing ids. Umbrella heads-up `43d5fec`. | `pubky-nexus` |
| Credential-leak remediation | Merged `9e18155c` (wasm-alias rationale restored `11253c93`). `parseResponseOrThrow` no longer puts a 200-char body excerpt in error context unless the caller passes `PARSE_JSON_WITH_BODY_EXCERPT` (`src/libs/http/response.utils.ts`, `30c1060e`). Session mint, Locks credentials, Homegate signup, homeserver, Chatwoot, and other private marketplace reads stay default-off so a malformed JSON body cannot land session tokens, invite codes, or private files in `Logger.error`. `cbc22659` (same merge) closed a session-fixation hole: trailing-garbage JSON salvage on mint could store a prepended attacker object as the victim's bearer; mint parse is now strict, bound to the requesting pubky, and tokens constrained to the 32-byte url-safe-base64 the service issues. That salvage path never reached the pushed branch. | `mp-ux` |
| Pickup refusal toasts | Merge `7561200b` / `2210ef86`: command-envelope pickup failures map to static `PICKUP_REFUSAL_FAILURE_MESSAGES`. A refusal toast must not render server text (a refusal can carry the meeting point it refused). | `mp-ux` |
| Single-approval sign-in | **Shipped 2026-09-08.** One Pubky Ring approval dual-presents the same `AuthToken` bytes to the homeserver first and the marketplace transaction service second, minting both sessions. `singleApprovalSignIn` (`PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN`) defaults to true; disabling it retains the legacy two-step flow. Feature `c213ae9f`, tests `454828c5`, fixer round `454828c5..3e737732`, cleanup batch `e482e603..8881f90f`, and N-1 follow-up `ac593082`. Round 1: Kimi SHIP on the security lens plus Opus FIX-FIRST (5 P1, 4 P2, 3 P3), all closed. Round 2: Kimi SHIP plus Opus SHIP. Cleanup batch and N-1 fix: Opus SHIP. Staging deployed 19:33; production deployed 19:37; the N-1 fix deployed 2026-09-08 evening. The marketplace capability string is echoed but not stored; see the marketplace-service record. | `mp-ux` / `mp-oneauth` |
| VRT hardening | Merge `98a0610e` (`a977f093` + scenes). Global matcher is 80 px / 0.005% (`allowedMismatchedPixelRatio: 0.00005`); dense feed/onboarding chrome uses `VRT_DENSE_CHROME_SCREENSHOT`. Negative test in `MarketplacePickup.vrt.test.tsx` proves `expectVrtSurface` rejects a stand-in with no production `data-surface`. **Linux baselines were not regenerated:** `.github/workflows/vrt.yml` runs only on `master`/`dev` (plus `workflow_dispatch`). | `mp-ux` |
| Railway IaC | marketplace-service `8a10253`; fiat-verifier `.railway/railway.ts` on master. Authored, not applied. See Deploy And Rollback. | `marketplace-service`, `pubky-fiat-verifier` |
| Wave 8 SSO inventory | Pointer only — nothing approved to build. Master plan section "Wave 8 — Unified auth and Vibes SSO": session bridge is **not deployed** (`/session-bridge` serves the app shell); `vibes.pubky.app` has **no DNS** (the board is live on Cloud Run at `vibes-805562057272.europe-west1.run.app`); upstream `#2484`, `#2483`, `pubky/vibes#9` are OPEN and BLOCKED. Owner principles: stock production Ring must work for every vibe; SSO only where same-site hosting makes it seamless; extra prompts only when a competent user would agree they were necessary. Critical path is upstream review plus DevOps DNS for the board, not Shop code. | plan `vibes-first_marketplace_master_plan_d8646c7a.plan.md` |

### Shop auth: operational note and known gaps

Between 12:53 and 19:37 on 2026-09-08, the P1 credential-leak fix and session-fixation fix were pushed to GitHub but not deployed to Vercel; production continued serving the 07:47 build (`383b6d3e`). Push is not deploy: every merge to `pr25-ux` that changes `src/` must be followed by `vercel --prod --yes` (or `npx vercel --prod --yes`) from `mp-ux` (staging) and `mp-prod-deploy` (production), with the deploy timestamp recorded.

- P4: the commerce store is not persisted while `currentUserPubky` is; after reload and before restore completes, a wrong-Ring step-up can clear the signed-in user's localStorage-only bearer once. Possible fix: use the persisted mirror's owner pubky when the store is empty.
- P3: a wrong-identity step-up can replace the signed-in user's homeserver cookie before the gate rejects it; the gate signs the other identity out, leaving `authStore` on the signed-in identity without a live cookie. Pre-existing and strictly better than before.
- P3: `getSignupAuthUrl` remains outside the ceremony guard; a signup-page mount during the ceremony POST window can wipe local state.
- P3: the guard is released before `initializeAuthenticatedSession` finishes (legacy parity, waived).
- P3: the guard is bounded by the token wait; a `/session` POST that never settles holds the ceremony until the 120-second flow timeout.
- P4: `marketplaceError` from a partial ceremony failure is logged but not surfaced directly; reconnect is inferred from the absent marketplace session.

### 2026-09-07 Evidence Rows

| Evidence | Status | Where |
| --- | --- | --- |
| Wave 6 backlog batch | Merged and deployed at `9483446f` on `marketplace/pr25-ux`. SSR catalog seeds shop names; catalog URL is a libs-only constant; messaging VRT on firefox is deterministic; Duplicate asks before replacing an unsaved draft and seeds before deleting; SSR shop fetch capped at 6 concurrent. | `mp-ux` |
| Graduation dossier | Added at `2e022af5` (`docs/vibes/graduation-dossier.md`). | `mp-ux` |
| Teammate PR triage | `BitcoinErrorLog/pubky-app` #20 (tax removal, icota) closed as superseded by Wave 2b; guard test cherry-picked as `c003e374` under his authorship. #22 (local pickup with post-payment reveal, icota) has changes requested and is absorbed into Wave 7. See `docs/contributions/PR-triage.md`. | `BitcoinErrorLog/pubky-app` |
| Wave 7 kickoff | "Local pickup with scheduling"; design in progress at `docs/ecommerce/local-pickup-design.md` on `marketplace/w7-design`. Owner decisions: buyer may cancel if pickup terms change after payment; seller may delete details; one meeting point per order; pickup off without the encryption key; either party confirms handover, no automatic delivery; no pickup details on sandbox deployments; returns re-choose pickup or shipping with optional seller label. Address-sharing policy: a physical address is shared only when its owner chooses to, for a reason shown to them, with the one person who needs it; buyer→seller only the delivery address for shipped items once the order exists; seller→buyer nothing by default except a deliberately published pickup point revealed only to the paying buyer. | `mp-ux` / `marketplace/w7-design` |
| marketplace-service | `c697e5f` deployed to both stacks (delivery auto-complete worker, return flow surfacing); migration 0019 verified. | `marketplace-service` |
| marketplace-service Wave 7 | `462ed54` (local pickup Part A: sealed pickup details, pinned reveal, either-party handover confirm, unilateral cancel on terms change, key rotation job, migrations 0020+0021) deployed to STAGING only (deployment `3bd800d5`, 2026-09-07); `PICKUP_DETAILS_ENCRYPTION_KEY` set on staging; `/health` reports `pickup_available:false` there because `SANDBOX_PAYMENTS_ENABLED=true`. Production remains `c697e5f` with no pickup key until the client (7.2b) ships. Gates: Opus r1 FIX-FIRST → r2 SHIP, Kimi r1/r2 SHIP, cleanup + final pass SHIP; 291 tests. | `marketplace-service` |
| Wave 7 rollout (2026-09-08) | Service `462ed54` deployed to PRODUCTION (deployment `396128db`), `PICKUP_DETAILS_ENCRYPTION_KEY` set there; `/health` reports `pickup_available:true` (sandbox off). Shop client `383b6d3e` (7.2a data layer `691b810f`+`5a6454f2`, 7.2b UI `2aea0170`..`383b6d3e`) deployed to staging (`pubky-marketplace-staging.vercel.app` after cutover) and to production `shop.pubky.app`. Live check: staging PASS; production catalog cards include the dead staging-era residue below. Sellers whose pre-Wave-7 listings were published as pickup (12 on staging) must set a meeting point on the edit page before pickup orders can complete. | `mp-ux`, `mp-prod-deploy`, `marketplace-service` |
| Production Nexus residue (CLOSED — owner declined replay 2026-09-08) | Production `nexusd` (`95a0`) still serves ~26 stale staging-derived listings. Current `NEXUS_HOMESERVER` is production. Wipe+replay was declined; those cards stay dead. See the 2026-09-08 row. | `pubky-nexus` |

### 2026-09-06 Evidence Rows

| Evidence | Status | Where |
| --- | --- | --- |
| Buyer UX fixes | Shipped on `marketplace/pr25-ux`: Orders entry for signed-in users, approval card removed from passive listing view, approval requested only after Add to cart / Place a bid / Make offer requires it, and copy standardized to `Approve purchases in Pubky Ring` / `Approve in Pubky Ring`. Check the current branch head with `git -C /Users/johncarvalho/work/mp-ux log -1 --oneline`. | `mp-ux` |
| Review and VRT | Opus gating review was FIX-FIRST, then round 2 merged; 33 VRT baselines regenerated; dead `message` prop removed from `MarketplaceSessionRequiredCard`. | `mp-ux` |
| Wave 6 UX remediation | Shipped as `6554dd1f..420856c1` on `marketplace/pr25-ux` (HEAD `420856c1`). Nine slices U1–U9, each Opus-reviewed; U1/U6/U8 Kimi-audited (U1 r3 SHIP). U1 3-step checkout (`Approve in Pubky Ring` up front; Place order disabled until approval + valid form; guarantee opt-in default unchecked; session store cleared from a single `onSessionEnded`, Kimi r3 SHIP). U2 seller identity (shop name + pubky fallback; attestation rating; tenure dropped). U3 offer/bid copy, persisted promo dismissal, drop-ended CTAs, vitest woff2 plugin. U4 order tabs and accessible 5-star input. U5 notification filters, Action-needed strip, drop Draft/Scheduled/Live/Ended, `/marketplace/shop` route. U6 `How you get paid` truthful pills (PayPal `Email saved`; Bitcoin Connected only with Lock Server + Paykit claim); payloads unchanged. U7 mobile sheet, Duplicate listing as local draft. U8 packing slip local-only paste (component state; Sentry-masked). U9 `ShopProfileCard`, a11y labels, `Needs attention`, `Seller studio`. Honesty labels, dual-truth drops, device-local watchlist, privacy-by-design addresses, direct-pay copy, and attestation review tiers preserved. Return-path after sign-in (`6554dd1f`), kill-switch drill runbook, and per-stack Paykit signing keys: see earlier 2026-09-06 rows and Known Decisions; not repeated here. | `mp-ux` |
| Wave 6 review evidence | Two Opus surface reviews of 65 VRT baselines plus 68 live screenshots; capability inventory; five review claims dismissed after verification. | `mp-ux` |
| Vercel deploys | Wave 6 client deployed 2026-09-06 17:52 to `pubky-marketplace-production.vercel.app`, `shop.pubky.app`, and `shop-rehearsal.pubky.app`; all three `locks-paykit`. Earlier production deployment `EAqqVuQq1BkstYJwwciMS3C981tv` / staging `3tPXUhr9Zb5voJqjYRuuGfyz6fZP` remain the prior recorded IDs unless a later deploy superseded them. | Vercel team scope `synonymdev` |
| Same-site bridge rehearsal | Rehearsal projects and domains are attached, with `bridge.pubky.app` and `shop-rehearsal.pubky.app` pending `_vercel.pubky.app` TXT verification. | Vercel projects `pubky-app-bridge-rehearsal` and `shop-bridge-rehearsal` |
| Sprint 3 | Client items still open: sectioned listing studio, guest-indexable catalog (SSR now seeds shop names at `9483446f` but is not the full item), multi-seller cart grouping. Service delivery auto-complete timer plus return/refund surfacing shipped in marketplace-service `c697e5f` (see 2026-09-07). | `mp-ux` / `marketplace-service` |

- Bridged entry awaits upstream `pubky-app` session bridge PR #2484 merge/deploy. Wave 8 inventory (2026-09-08): the production route is not deployed; see the Wave 8 pointer above.
- Same-site bridge rehearsal domains still need `_vercel.pubky.app` TXT verification before the rehearsal is publicly live.
- Production Nexus replay will **not** run; staging-era residue stays dead by owner decision.
- Pubky Ring empty-capabilities display is unverified and blocks the bridged-session step-up UX claim.
- Shippo live API proof is still open; only service/client tests through a local Shippo double are verified.
- Production write probe is pending the owner's Ring scan; the script is on branch `marketplace/prod-probe`.

## Known Decisions From 2026-09-05

- Production launch uses testnet money rails; mainnet money is a later gated decision.
- Rails are reused over public domains because Railway private networking does not cross projects.
- `PAYKIT_REQUEST_SIGNING_KEY` is per stack since 2026-09-06: paykit-server (fork `marketplace-rails` @ 9687ff0, rails `master` @ a8cbd5f) trusts a list via `MARKETPLACE_TRUSTED_PUBLIC_KEYS` (comma-separated `pubky…` keys, exactly one of the single/list env forms; entrypoint validates 57-char pubky-prefixed z-base-32 and fails closed). Production marketplace-service signs with its own seed; staging keeps the original. Proven by signed `POST /transactions/status` probes: both keys → 400 invalid_request (trusted), random key → 401 invalid_signature. Derive a public key from a seed with `pubky-payment-rails/paykit-server/tools/derive-marketplace-pubkey --stdin` (see that README for the no-shell-history pattern). Rotation order: add new key to the list → redeploy paykit-server (`railway redeploy`, variable changes alone do not restart it) → switch the service seed → redeploy → remove the old key.
- Production marketplace-service uses a fresh attestor identity, public pubky `szhtpayftdz3mpkoyyk3zesuad11ufuudqqrc73s35w1tfju7gxy`; the secret stays only in Railway variables/offline operator records.
- Production attestor cross-check: `szhtpayftdz3mpkoyyk3zesuad11ufuudqqrc73s35w1tfju7gxy` is pinned in `/Users/johncarvalho/work/mp-ux/src/config/commerce.ts` alongside staging `ws343aqzmcahagojhmhkbri8odqz9iqg61woxbkh9fd3bxhqomdy`.
- There is no moderator role in the target product; `MODERATOR_PUBKYS` was removed with operator authority in migration 0018.
