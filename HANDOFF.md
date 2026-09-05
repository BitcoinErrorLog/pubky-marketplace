# Pubky Marketplace Handoff

## What This Is

Pubky Marketplace is a P2P marketplace on Pubky: sellers publish catalog records on their own homeservers, the transaction service sequences the invariants browsers cannot, and payment rails stay outside operator custody. There is no operator authority over trades; disputes, reports, tax, and the moderator role are being removed, see `/Users/johncarvalho/.cursor/plans/vibes-first_marketplace_master_plan_d8646c7a.plan.md` (direct scans still find those symbols in `mp-ux` and `marketplace-service`, so do not call them removed yet).

## Repos And Branches

| Repo | Remote | Deployed branch / line | HEAD as of writing |
| --- | --- | --- | --- |
| `pubky-marketplace-umbrella` | `https://github.com/BitcoinErrorLog/pubky-marketplace.git` | `master` docs handoff line | `0259d994967961cb0b972eba2f11a567d7376dd7` |
| `mp-ux` / Shop client | `https://github.com/BitcoinErrorLog/pubky-app.git` | staging: `marketplace/pr25-ux`; production deploy source recorded as worktree `mp-prod-deploy` at `8a7532699dcee0995b27e5c6af57aeaf1c0f59b2` | current `marketplace/pr25-ux`: `31dcaee795420e8fae571d02747c89ab40bf15c8` |
| `marketplace-service` | `https://github.com/BitcoinErrorLog/pubky-marketplace-service.git` | `main` for the transaction service | `0fd9b45737a8dd2bb35afff4156526ea616ca41e` |
| `pubky-nexus` | `https://github.com/BitcoinErrorLog/pubky-nexus` | `feat/marketplace-indexing` for staging and production marketplace Nexus | current checkout: `e380c88b3f37afa2502fb86813107f8e1398f45b`; `docs/production-cutover.md` records `6fc2dbe3ac8cb81d137cd2fa7dd46b066b5a1adf`; the plan records production deploy `32b51f5` |
| `pubky-payment-rails` | `https://github.com/BitcoinErrorLog/pubky-payment-rails.git` | `master`, Railway project `pubky-marketplace-staging` | `a4d70c893c0e89597a31a6c7b65536a7fed9633a` |
| `pubky-fiat-verifier` | `https://github.com/BitcoinErrorLog/pubky-fiat-verifier.git` | `master`, Railway service `fiat-verifier` | `e379bd99073735380c4c84d87e8fb1d228a5727b` |
| `specs-mp4` / specs fork | `https://github.com/BitcoinErrorLog/pubky-app-specs.git` | `marketplace-4-build`, consumed by Shop/Nexus/service contracts | `8b84bf6f43e7b2035473be7114c92494d3d6d829` |

## Deployments

| Stack | Web client | Transaction / index services | Payment rails | Homeserver |
| --- | --- | --- | --- | --- |
| Staging | Vercel project `pubky-marketplace-staging`, currently `https://shop.pubky.app`, deployed from `mp-ux` `marketplace/pr25-ux` | Railway project `pubky-marketplace-nexus`, service `nexusd`, public API `https://nexusd-production-7108.up.railway.app`, watching staging; marketplace-service staging: Railway project `pubky-marketplace-staging`, service `marketplace-service`, `https://marketplace-service-production.up.railway.app` (verified via Railway CLI 2026-09-05) | Railway project `pubky-marketplace-staging`: `locks-server`, `fiat-verifier`, `paykit-server`, `bitcoind` regtest, `fulcrum`, plus Postgres services | `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` / `https://homeserver.staging.pubky.app` |
| Production | Vercel project `pubky-marketplace-production`, stable alias `https://pubky-marketplace-production.vercel.app`; `https://shop.pubky.app` moves here after cutover approval | Railway project `pubky-marketplace-production`: `nexusd` at `https://nexusd-production-95a0.up.railway.app`, `marketplace-service` at `https://marketplace-service-production-ce23.up.railway.app`, plus `neo4j`, `Redis`, and Postgres | Reuses the staging rails project over public domains (`locks-server-production.up.railway.app`, `paykit-server-production.up.railway.app`, `fiat-verifier-production.up.railway.app`); Railway private networking does not cross projects | `8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty` / `https://homeserver.pubky.app` |

## Env And Secrets

Secrets live in Vercel env or Railway variables only. Do not copy values into this repo, logs, issue comments, or chat.

### Shop client (`mp-ux`, Vercel env)

Required network/runtime vars: `PUBKY_RUNTIME_NEXUS_URL` (main social Nexus), `PUBKY_RUNTIME_CDN_URL` (static file CDN), `PUBKY_RUNTIME_HOMESERVER` (homeserver pubky), `PUBKY_RUNTIME_HOMESERVER_URL` (HTTP homeserver base), `PUBKY_RUNTIME_HOMEGATE_URL` (signup/onboarding service), `PUBKY_RUNTIME_DEFAULT_HTTP_RELAY` (HTTP relay inbox), `PUBKY_RUNTIME_PKARR_RELAYS` (PKARR relay list), `PUBKY_RUNTIME_TESTNET` (DHT/network mode), `PUBKY_RUNTIME_ENV` (declared deploy identity: `staging` or `production`).

Commerce/runtime vars: `PUBKY_RUNTIME_MARKETPLACE_URL` (transaction service), `PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL` (marketplace-only Nexus override), `PUBKY_RUNTIME_LOCKS_URL` (Lock Server public URL), `PUBKY_RUNTIME_PAYKIT_SETUP_URL` (Paykit setup URL), `PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE` (commerce mode, production/staging use `locks-paykit` today), `PUBKY_RUNTIME_COMMERCE_POLL_INTERVAL_MS` (commerce polling), `PUBKY_RUNTIME_EXCHANGE_RATE_API` (indicative BTC/USD rate source).

Optional runtime vars: `PUBKY_RUNTIME_SENTRY_DSN`, `PUBKY_RUNTIME_SENTRY_ENVIRONMENT`, `PUBKY_RUNTIME_SENTRY_TRACES_SAMPLE_RATE`, `PUBKY_RUNTIME_SENTRY_REPLAYS_SESSION_SAMPLE_RATE`, `PUBKY_RUNTIME_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE`, `PUBKY_RUNTIME_NOTIFICATION_POLL_INTERVAL_MS`, `PUBKY_RUNTIME_NOTIFICATION_POLL_ON_START`, `PUBKY_RUNTIME_NOTIFICATION_RESPECT_PAGE_VISIBILITY`, `PUBKY_RUNTIME_STREAM_POLL_INTERVAL_MS`, `PUBKY_RUNTIME_STREAM_POLL_ON_START`, `PUBKY_RUNTIME_STREAM_RESPECT_PAGE_VISIBILITY`, `PUBKY_RUNTIME_STREAM_FETCH_LIMIT`, `PUBKY_RUNTIME_STREAM_CACHE_MAX_AGE_MS`, `PUBKY_RUNTIME_MAX_STREAM_TAGS`, `PUBKY_RUNTIME_TTL_POST_MS`, `PUBKY_RUNTIME_TTL_USER_MS`, `PUBKY_RUNTIME_TTL_BATCH_INTERVAL_MS`, `PUBKY_RUNTIME_TTL_POST_MAX_BATCH_SIZE`, `PUBKY_RUNTIME_TTL_USER_MAX_BATCH_SIZE`, `PUBKY_RUNTIME_TTL_RETRY_DELAY_MS`, `PUBKY_RUNTIME_MODERATION_ID`, `PUBKY_RUNTIME_MODERATED_TAGS`, `PUBKY_RUNTIME_PRELUDE_SDK_KEY`, `PUBKY_RUNTIME_PRELUDE_SDK_TIMEOUT_MS`, `PUBKY_RUNTIME_PLAUSIBLE_DOMAIN`, `PUBKY_RUNTIME_PLAUSIBLE_SCRIPT_URL`, `PUBKY_RUNTIME_PREVIEW_IMAGE`, `PUBKY_RUNTIME_SITE_NAME`, `PUBKY_RUNTIME_LOCALE`, `PUBKY_RUNTIME_AUTHOR`, `PUBKY_RUNTIME_KEYWORDS`, `PUBKY_RUNTIME_TYPE`, `PUBKY_RUNTIME_CREATOR`, `PUBKY_RUNTIME_DEFAULT_URL`, `PUBKY_RUNTIME_PUBKY_RING_URL`, `PUBKY_RUNTIME_PUBKY_CORE_URL`, `PUBKY_RUNTIME_NEXUS_SCOUT_URL`, `PUBKY_RUNTIME_TWITTER_URL`, `PUBKY_RUNTIME_TWITTER_GETPUBKY_URL`, `PUBKY_RUNTIME_TELEGRAM_URL`, `PUBKY_RUNTIME_GITHUB_URL`, `PUBKY_RUNTIME_EMAIL`, `PUBKY_RUNTIME_APP_STORE_URL`, `PUBKY_RUNTIME_PLAY_STORE_URL`.

Build-intrinsic vars: `NEXT_PUBLIC_DB_NAME`, `NEXT_PUBLIC_DB_VERSION`, `NEXT_PUBLIC_DEBUG_MODE`, `NEXT_PUBLIC_APP_VERSION`, `NEXT_PUBLIC_VIBE_SESSION_BRIDGE_ORIGIN` (production artifact points at `https://pubky.app`), `NEXT_PUBLIC_VIBE_ID` (`marketplace`). Source-map upload vars, if used by the deployment pipeline, are `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT`.

### Marketplace service (`marketplace-service`, Railway variables)

Core service vars: `DATABASE_URL` (Postgres), `BIND_ADDR` (HTTP bind), `ALLOWED_ORIGINS` (CORS), `AUTH_TOKEN_WINDOW_SECONDS` (AuthToken timestamp window), `AUTH_SESSION_TTL_SECONDS` (bearer session TTL), `WORKER_INTERVAL_SECONDS` (worker cadence), `WORKER_LEASE_SECONDS` (worker lease), `SANDBOX_PAYMENTS_ENABLED` (sandbox command gate; false in production).

Authority/payment vars: `LOCKS_SERVER_URL` (Lock Server base), `LOCKS_BUNDLE_ENCRYPTION_KEY` (sealed bundle IDs), `LOCKS_LOOKUP_HMAC_KEY` (correlation lookup HMAC), `LOCKS_PAYMENT_WINDOW_SECONDS` (Locks hold window), `FIAT_PAYMENT_WINDOW_SECONDS` (fiat hold window), `SANDBOX_PAYMENT_WINDOW_SECONDS` (sandbox hold window), `DROP_CLAIM_WINDOW_SECONDS` (drop claim hold), `LOCKS_POLL_SECONDS` (Locks polling), `ATTESTOR_SECRET_KEY` (service attestor identity), `ATTESTOR_ORDER_SALT` (stable order-ref salt), `STRIPE_KEY_ENCRYPTION_KEY` (seller Stripe key sealing), `STRIPE_API_BASE` (Stripe API base), `PAYKIT_SERVER_URL` (paykit-server base), `PAYKIT_REQUEST_SIGNING_KEY` (request-signing seed trusted by paykit-server), `PAYKIT_POLL_SECONDS` (Paykit polling), `PUBLIC_APP_ORIGIN` (Shop return origin), `PUBLIC_SERVICE_ORIGIN` (service origin for PayPal IPN), `PAYPAL_IPN_VERIFY_URL` (PayPal IPN validation), `SHIPPO_API_BASE` (Shippo API base). `MODERATOR_PUBKYS` exists in current service docs but is deliberately unset on production per the 2026-09-05 no-moderator decision.

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
| Shop staging | From `<work>/mp-ux` on `marketplace/pr25-ux`: `vercel deploy --prod` for project `pubky-marketplace-staging` | Vercel instant rollback to the prior deployment in the project dashboard/CLI |
| Shop production | From the production deploy worktree recorded in the plan (`mp-prod-deploy`) or the intended integration branch: `vercel deploy --prod` for project `pubky-marketplace-production` | Vercel instant rollback to the prior deployment; moving `shop.pubky.app` is parent/owner-only |
| Marketplace service staging/production | From `<work>/marketplace-service`: `railway up -p <project-id> -e production -s marketplace-service` after selecting the correct project (`pubky-marketplace-staging` or `pubky-marketplace-production`) | Railway redeploy previous successful deployment; database migrations are forward-only unless a specific rollback migration exists |
| Marketplace Nexus staging | From `/Volumes/vibedrive/vibes-dev/pubky-nexus` on `feat/marketplace-indexing`: `railway up -p <project-id> -e production -s nexusd` for project `pubky-marketplace-nexus` | Railway redeploy previous successful `nexusd`; keep Redis/Neo4j volumes unless intentionally restarting replay |
| Marketplace Nexus production | Same worktree/branch: `railway up -p <project-id> -e production -s nexusd` for project `pubky-marketplace-production`; set `RAILWAY_DOCKERFILE_PATH=Dockerfile.railway` first | Railway redeploy previous successful `nexusd`; if Redis is wiped, replay restarts from cursor zero |
| Rails services | From `<work>/pubky-payment-rails`: `railway up -p <project-id> -e production -s locks-server`, `railway up -p <project-id> -e production -s paykit-server`, `railway up -p <project-id> -e production -s bitcoind`, `railway up -p <project-id> -e production -s fulcrum`; fiat verifier from `<work>/pubky-fiat-verifier`: `railway up -p <project-id> -e production -s fiat-verifier` | Railway redeploy previous per service; for identity/key rotation follow the volume coherence rules in `pubky-payment-rails/README.md` |

Railway production project id is `75faa4fe-466c-4277-977f-1d8e4e31df8c` (`pubky-marketplace-production`, verified 2026-09-05 via the Railway CLI). Staging project ids: resolve with read-only Railway project inspection before running any command.

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
| `node scripts/probe-listing-registration.mjs <seller> <listingId>` | `listing.sync` can heal an unregistered listing into the transaction service. |
| `node scripts/probe-nexus-listing-ingest.mjs` | Dedicated marketplace Nexus sees and serves listing ingest. |
| `node scripts/probe-media-write.mjs` | Media write path under the configured homeserver/session. |
| `pubky-payment-rails/verify/driver.mjs checkout <bundle> paypal` | Hosted PayPal sandbox purchase through deployed rails. |
| `scripts/probe-production-writes.mjs` | Production path-family PUT/GET/DELETE probe with Ring sign-in and `/priv` durability seed. Lives on the unmerged branch `marketplace/prod-probe` (worktree `mp-probe`, off `pr25-ux`); merges into `pr25-ux` once the owner has run it. |

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

- Bridged entry awaits upstream `pubky-app` session bridge PR #2484 merge/deploy.
- Production Nexus full replay is in progress; streams can be empty/incomplete until replay reaches the relevant production events.
- Pubky Ring empty-capabilities display is unverified and blocks the bridged-session step-up UX claim.
- Shippo live API proof is still open; only service/client tests through a local Shippo double are verified.
- Production write probe is pending the owner's Ring scan; the script is on branch `marketplace/prod-probe`.

## Known Decisions From 2026-09-05

- Production launch uses testnet money rails; mainnet money is a later gated decision.
- Rails are reused over public domains because Railway private networking does not cross projects.
- `PAYKIT_REQUEST_SIGNING_KEY` is shared with staging for now because paykit-server trusts one marketplace key; backlog is a trusted-key list and rotation.
- Production marketplace-service uses a fresh attestor identity, public pubky `szhtpayftdz3mpkoyyk3zesuad11ufuudqqrc73s35w1tfju7gxy`; the secret stays only in Railway variables/offline operator records.
- There is no moderator role in the target product; `MODERATOR_PUBKYS` is deliberately unset on production while the removal work finishes.
