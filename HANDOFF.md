# Pubky Marketplace Handoff

## What This Is

Pubky Marketplace is a P2P marketplace on Pubky: sellers publish catalog records on their own homeservers, the transaction service sequences the invariants browsers cannot, and payment rails stay outside operator custody. There is no operator authority over trades; disputes, reports, tax, and the moderator role were removed from the transaction service by migration 0018, see `/Users/johncarvalho/.cursor/plans/vibes-first_marketplace_master_plan_d8646c7a.plan.md`.

## Repos And Branches

| Repo | Remote | Deployed branch / line | Current HEAD check |
| --- | --- | --- | --- |
| `pubky-marketplace-umbrella` | `https://github.com/BitcoinErrorLog/pubky-marketplace.git` | `/Users/johncarvalho/work/pubky-marketplace-umbrella`, branch `master` | branch `master`; current HEAD via `git -C /Users/johncarvalho/work/pubky-marketplace-umbrella log -1 --oneline` |
| `mp-ux` / Shop client | `https://github.com/BitcoinErrorLog/pubky-app.git` | staging: `/Users/johncarvalho/work/mp-ux`, branch `marketplace/pr25-ux`, Vercel project `pubky-marketplace-staging`; production: `/Users/johncarvalho/work/mp-prod-deploy`, branch `marketplace/prod-deploy`, Vercel project `pubky-marketplace-production`; bridge rehearsal: `/Users/johncarvalho/work/mp-bridge-rehearsal`, branch `marketplace/bridge-rehearsal`; production probe: `/Users/johncarvalho/work/mp-probe`, branch `marketplace/prod-probe` | current HEAD via `git -C /Users/johncarvalho/work/mp-ux log -1 --oneline`, `git -C /Users/johncarvalho/work/mp-prod-deploy log -1 --oneline`, `git -C /Users/johncarvalho/work/mp-bridge-rehearsal log -1 --oneline`, or `git -C /Users/johncarvalho/work/mp-probe log -1 --oneline` |
| `marketplace-service` | `https://github.com/BitcoinErrorLog/pubky-marketplace-service.git` | `/Users/johncarvalho/work/marketplace-service`, branch `main` for the transaction service | branch `main`; current HEAD via `git -C /Users/johncarvalho/work/marketplace-service log -1 --oneline` |
| `pubky-nexus` | `https://github.com/BitcoinErrorLog/pubky-nexus` | `/Volumes/vibedrive/vibes-dev/pubky-nexus`, branch `feat/marketplace-indexing` for staging and production marketplace Nexus | branch `feat/marketplace-indexing`; current HEAD via `git -C /Volumes/vibedrive/vibes-dev/pubky-nexus log -1 --oneline`; fixed artifact references remain in `docs/production-cutover.md` and deployment records |
| `pubky-payment-rails` | `https://github.com/BitcoinErrorLog/pubky-payment-rails.git` | `/Users/johncarvalho/work/pubky-payment-rails`, branch `master`, Railway project `pubky-marketplace-staging` | branch `master`; current HEAD via `git -C /Users/johncarvalho/work/pubky-payment-rails log -1 --oneline` |
| `pubky-fiat-verifier` | `https://github.com/BitcoinErrorLog/pubky-fiat-verifier.git` | `/Users/johncarvalho/work/pubky-fiat-verifier`, branch `master`, Railway service `fiat-verifier` | branch `master`; current HEAD via `git -C /Users/johncarvalho/work/pubky-fiat-verifier log -1 --oneline` |
| `specs-mp4` / specs fork | `https://github.com/BitcoinErrorLog/pubky-app-specs.git` | `/Users/johncarvalho/work/specs-mp4`, branch `marketplace-4-build`, consumed by Shop/Nexus/service contracts | branch `marketplace-4-build`; current HEAD via `git -C /Users/johncarvalho/work/specs-mp4 log -1 --oneline` |

## Deployments

Cutover has NOT happened: `https://shop.pubky.app` still points at the staging Vercel project. Production is live only at the Vercel alias `https://pubky-marketplace-production.vercel.app` until owner-approved cutover moves the custom domain.

| Stack | Web client | Transaction / index services | Payment rails | Homeserver |
| --- | --- | --- | --- | --- |
| Staging | Vercel project `pubky-marketplace-staging`, currently `https://shop.pubky.app`, deployed from `mp-ux` `marketplace/pr25-ux` | Railway project `pubky-marketplace-nexus`, service `nexusd`, public API `https://nexusd-production-7108.up.railway.app`, watching staging; marketplace-service staging: Railway project `pubky-marketplace-staging`, service `marketplace-service`, `https://marketplace-service-production.up.railway.app` (verified via Railway CLI 2026-09-05) | Railway project `pubky-marketplace-staging`: `locks-server`, `fiat-verifier`, `paykit-server`, `bitcoind` regtest, `fulcrum`, plus Postgres services | `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` / `https://homeserver.staging.pubky.app` |
| Production | Vercel project `pubky-marketplace-production`, stable alias `https://pubky-marketplace-production.vercel.app`, deployment `EAqqVuQq1BkstYJwwciMS3C981tv`; `https://shop.pubky.app` moves here only after cutover approval | Railway project `pubky-marketplace-production` (`75faa4fe-466c-4277-977f-1d8e4e31df8c`): `nexusd` at `https://nexusd-production-95a0.up.railway.app`, `marketplace-service` at `https://marketplace-service-production-ce23.up.railway.app`, plus `neo4j`, `Redis`, and Postgres | Reuses the staging rails project over public domains (`locks-server-production.up.railway.app`, `paykit-server-production.up.railway.app`, `fiat-verifier-production.up.railway.app`); Railway private networking does not cross projects | `8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty` / `https://homeserver.pubky.app` |
| Same-site bridge rehearsal | Vercel project `pubky-app-bridge-rehearsal`, branch `feat/session-bridge` (current HEAD via that checkout's `git log -1 --oneline`), domain `https://bridge.pubky.app`; Shop rehearsal Vercel project `shop-bridge-rehearsal`, worktree `/Users/johncarvalho/work/mp-bridge-rehearsal`, branch `marketplace/bridge-rehearsal`, domain `https://shop-rehearsal.pubky.app` | Not a transaction-service change; rehearsal tests session bridge handoff between pubky.app and Shop | Uses Shop rehearsal env `NEXT_PUBLIC_VIBE_SESSION_BRIDGE_ORIGIN=https://bridge.pubky.app` and `PUBKY_RUNTIME_DEFAULT_URL`; pubky.app rehearsal env allows `https://shop-rehearsal.pubky.app` | Domains are attached but pending `_vercel.pubky.app` TXT verification records of the form `vc-domain-verify=<host>,<token>` because the `pubky.app` apex is owned by another Vercel team |

### Tree ↔ Stack

| Tree | Stack |
| --- | --- |
| `/Users/johncarvalho/work/mp-ux` | Vercel `pubky-marketplace-staging`; alias `shop.pubky.app` until cutover |
| `/Users/johncarvalho/work/mp-prod-deploy` | Vercel `pubky-marketplace-production`; alias `pubky-marketplace-production.vercel.app` |
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

`paykit-server`: `PAYKIT_TRUSTED_LOCKS_PUBLIC_KEY`, `PAYKIT_DATABASE_URL`, `PAYKIT_MASTER_KEY`, `PAYKIT_SETUP_ALLOWED_ORIGINS`, `PAYKIT_ELECTRUM_ENDPOINT`, `MARKETPLACE_TRUSTED_PUBLIC_KEY`, `PAYKIT_AUTH_RELAY`.

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

### 2026-09-06 Evidence Rows

| Evidence | Status | Where |
| --- | --- | --- |
| Buyer UX fixes | Shipped on `marketplace/pr25-ux`: Orders entry for signed-in users, approval card removed from passive listing view, approval requested only after Add to cart / Place a bid / Make offer requires it, and copy standardized to `Approve purchases in Pubky Ring` / `Approve in Pubky Ring`. Check the current branch head with `git -C /Users/johncarvalho/work/mp-ux log -1 --oneline`. | `mp-ux` |
| Review and VRT | Opus gating review was FIX-FIRST, then round 2 merged; 33 VRT baselines regenerated; dead `message` prop removed from `MarketplaceSessionRequiredCard`. | `mp-ux` |
| Vercel deploys | Production deployed to `pubky-marketplace-production` alias `pubky-marketplace-production.vercel.app`, deployment `EAqqVuQq1BkstYJwwciMS3C981tv`; staging deployed to `pubky-marketplace-staging` alias `shop.pubky.app`, deployment `3tPXUhr9Zb5voJqjYRuuGfyz6fZP`. | Vercel team scope `synonymdev` |
| Same-site bridge rehearsal | Rehearsal projects and domains are attached, with `bridge.pubky.app` and `shop-rehearsal.pubky.app` pending `_vercel.pubky.app` TXT verification. | Vercel projects `pubky-app-bridge-rehearsal` and `shop-bridge-rehearsal` |

- Bridged entry awaits upstream `pubky-app` session bridge PR #2484 merge/deploy.
- Same-site bridge rehearsal domains still need `_vercel.pubky.app` TXT verification before the rehearsal is publicly live.
- Production Nexus full replay is in progress; streams can be empty/incomplete until replay reaches the relevant production events.
- Pubky Ring empty-capabilities display is unverified and blocks the bridged-session step-up UX claim.
- Shippo live API proof is still open; only service/client tests through a local Shippo double are verified.
- Production write probe is pending the owner's Ring scan; the script is on branch `marketplace/prod-probe`.

## Known Decisions From 2026-09-05

- Production launch uses testnet money rails; mainnet money is a later gated decision.
- Rails are reused over public domains because Railway private networking does not cross projects.
- `PAYKIT_REQUEST_SIGNING_KEY` is shared with staging for now because paykit-server trusts one marketplace key; backlog is a trusted-key list and rotation.
- Production marketplace-service uses a fresh attestor identity, public pubky `szhtpayftdz3mpkoyyk3zesuad11ufuudqqrc73s35w1tfju7gxy`; the secret stays only in Railway variables/offline operator records.
- Production attestor cross-check: `szhtpayftdz3mpkoyyk3zesuad11ufuudqqrc73s35w1tfju7gxy` is pinned in `/Users/johncarvalho/work/mp-ux/src/config/commerce.ts` alongside staging `ws343aqzmcahagojhmhkbri8odqz9iqg61woxbkh9fd3bxhqomdy`.
- There is no moderator role in the target product; `MODERATOR_PUBKYS` was removed with operator authority in migration 0018.
