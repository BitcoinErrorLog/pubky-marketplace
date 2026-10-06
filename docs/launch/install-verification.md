# Verifying a marketplace installation

`verify.mjs` checks a deployed marketplace stack from the outside: the Shop, the marketplace service, the Paykit server, the Locks server, the marketplace Nexus and, when deployed, the fiat verifier. Every check prints PASS, FAIL, WARN, SKIP or INFO, and every FAIL or WARN carries the fix. Run it after each deployment, before switching DNS, and again after the switch.

The default run is safe against production: it only reads, or sends requests the server must reject before doing any work. Nothing pays, orders or charges.

## 1. Prerequisites

- Node.js 20 or newer. The core checks need nothing else.
- A checkout of this repository. `npm ci` is needed only for the Nexus write probe and the browser check; the browser check also needs `npx playwright install chromium` once.
- `psql` (or any psql-compatible client) for the migration check, with read access to each service's database.
- Shell access that can answer platform questions: how many Paykit processes run, which commit each image was built from, and whether private service addresses answer from inside their network.

## 2. Configure

Copy [`stack.env.example`](../../.cursor/skills/marketplace-install-verify/stack.env.example) to a private location, one file per environment. Values in the environment override the file. Keep secrets (database URLs, registry tokens) in the environment; commands in the file can reference them as `$VAR`.

Minimum:

```bash
MIV_ENV=staging                       # or production
SHOP_ORIGINS=https://staging.shop.example
SERVICE_URL=https://api.staging.shop.example
PAYKIT_URL=https://paykit.staging.shop.example
LOCKS_URL=https://locks.staging.shop.example
NEXUS_URL=https://nexus.staging.shop.example
FIAT_VERIFIER_URL=https://fiat.staging.shop.example   # only if deployed
```

Then add, as they become available:

| What                       | Keys                                                                                                                                                       | Enables                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Source pins                | `SHOP_SOURCE`, `SERVICE_SOURCE`, `PAYKIT_SOURCE`, `LOCKS_SOURCE`, `NEXUS_SOURCE`, `FIAT_SOURCE` as `owner/repo@<commit>`                                   | version parity, migration checksums             |
| Running commits            | `<SVC>_RUNNING_COMMIT_CMD`: prints the commit the running image was built from                                                                             | version parity (the Nexus reports its own)      |
| Rendered configs           | `PAYKIT_CONFIG_FILE`, `LOCKS_CONFIG_FILE` (only named non-secret keys are read)                                                                            | trusted key, allowed origins, Locks Paykit URL  |
| Service environment values | `SERVICE_PAYKIT_SERVER_URL`, `SERVICE_LOCKS_SERVER_URL`, `SERVICE_ALLOWED_ORIGINS`, `SERVICE_SANDBOX_PAYMENTS_ENABLED`, `FIAT_*`                           | wiring checks                                   |
| Private addresses          | `SERVICE_PAYKIT_EXPECTED_URL`, `SERVICE_LOCKS_EXPECTED_URL`, `LOCKS_PAYKIT_EXPECTED_URL`, `FIAT_PAYKIT_EXPECTED_URL`, and `<KEY>_REACH_CMD` for each       | internal URLs accepted and proven reachable     |
| Platform                   | `PAYKIT_INSTANCE_COUNT_CMD` (must print 1); `SERVICE_DB_SQL_CMD`, `PAYKIT_DB_SQL_CMD`, `LOCKS_DB_SQL_CMD`                                                  | single-instance Paykit, applied migrations      |
| Expectations               | `EXPECT_LOCK_SERVER_KEY`, `EXPECT_HOMESERVER`, `EXPECT_SHOP_DEPLOY_ENV`, `EXPECT_BITCOIN_NETWORK`, `EXPECT_BITCOIN_OFFER`, `EXPECT_MIN_LISTINGS`, `FORBIDDEN_HOSTS`, `REFERENCE_NEXUS_URL` | identity carry-over, cutover hygiene, parity    |

Command recipes for VMs and Google Cloud:

```bash
# Paykit process count on a Docker VM
PAYKIT_INSTANCE_COUNT_CMD=ssh paykit-vm docker ps -q --filter name=paykit-server | wc -l
# Commit of a running container (needs the org.opencontainers.image.revision label at build time)
SERVICE_RUNNING_COMMIT_CMD=ssh api-vm docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' marketplace-service
# Commit of a registry image (private registries: export REGISTRY_BASIC=oauth2accesstoken:$(gcloud auth print-access-token))
LOCKS_RUNNING_COMMIT_CMD=node .cursor/skills/marketplace-install-verify/scripts/running-commit.mjs image <registry>/<name>@sha256:<digest>
# Read-only SQL through psql (a read-only database user is enough)
PAYKIT_DB_SQL_CMD=psql "$PAYKIT_DATABASE_URL_RO" -X -q
# A private address, tested from inside the caller's network
LOCKS_PAYKIT_REACH_CMD=ssh locks-vm docker exec locks wget -qO- -T 10 http://paykit.internal:3001/health/live
```

If the image build does not set `org.opencontainers.image.revision`, add `--label org.opencontainers.image.revision=<commit>` (or the pipeline's equivalent) so the running commit is answerable.

## 3. Run

```bash
cd pubky-marketplace
node .cursor/skills/marketplace-install-verify/scripts/verify.mjs --config ~/stacks/staging.env --out ~/stacks/evidence/staging-$(date +%Y%m%d-%H%M)
```

Order for a new installation:

1. **Staging, read-only**, with database and platform commands configured. Fix every FAIL.
2. **Staging probes:** `--flow-probes --write-probe --browser`, then `--deep` with the staging proofs configured. For the write probe on a fresh staging homeserver, `NEXUS_PROBE_HOMESERVER` plus `NEXUS_PROBE_SIGNUP_TOKEN_CMD` sign up a throwaway identity for the run.
3. **Production, read-only, before DNS:** point the URLs at the new hosts directly. Set `FORBIDDEN_HOSTS` to the retired hosts and `REFERENCE_NEXUS_URL` to the old Nexus until the listing parity check passes.
4. **Production after DNS:** the same run with the public hostnames, plus `--browser`.
5. The team's signed-in Shop proof and the Bitkit regtest purchase on staging (section 6).

Exit code 0 means no FAIL; `--strict` also fails on WARN. `report.md` in the output folder is the table to attach to the change record.

## 4. Checks and fixes

| Section   | Check                                     | Passes when                                                                                                          | Usual fix on FAIL                                                                                         |
| --------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tls`     | `tls.<host>`                              | trusted certificate for the exact host, TLS 1.2+, at least 7 days left (WARN under `TLS_MIN_DAYS`, default 21)       | install or renew the certificate                                                                          |
| `tls`     | `tls.<host>.redirect`                     | port 80 redirects to HTTPS or is closed                                                                              | redirect HTTP to HTTPS                                                                                    |
| `shop`    | `shop.page`, `shop.runtime`               | `/marketplace` returns HTML with `window.__PUBKY_CONFIG__`                                                            | check the Shop deployment                                                                                 |
| `shop`    | `shop.runtime.<key>`                      | `marketplaceUrl`, `marketplaceNexusUrl`, `locksUrl`, `paykitSetupUrl` point at this stack; expectations match        | set the matching `PUBKY_RUNTIME_*` value and restart the Shop                                             |
| `shop`    | `shop.runtime.forbidden`, `shop.llms`     | no retired host in the runtime config; `/llms.txt` names this Nexus                                                  | replace the retired host                                                                                  |
| `service` | `service.ready`, `service.health`         | `/ready` is `ready`; `/health` is `ok`                                                                               | read the service log                                                                                      |
| `service` | `service.paykit-rail`                     | the service has polled Paykit in the last 5 minutes                                                                  | fix `PAYKIT_SERVER_URL` or the service's Paykit signing key                                               |
| `service` | `service.cors.*`                          | each Shop origin is allowed with `authorization`; a foreign origin is not                                            | set `ALLOWED_ORIGINS` to the exact Shop origins                                                           |
| `service` | `service.public-read`, `service.auth-required` | a public database read answers; protected routes answer 401                                                      | read the service log                                                                                      |
| `paykit`  | `paykit.live`, `paykit.ready`             | live; ready with Postgres, Electrum, delivery and outbox ready                                                       | check the database URL and the Electrum endpoint                                                          |
| `paykit`  | `paykit.auth.*`                           | every signed route answers 401 to unsigned and forged requests; 404 means a wrong release                            | deploy the expected Paykit release                                                                        |
| `paykit`  | `paykit.bitcoin-network`, `paykit.electrum-chain` | config network and Electrum chain match `EXPECT_BITCOIN_NETWORK`                                             | fix `[bitcoin] network` or the Electrum endpoint                                                          |
| `paykit`  | `paykit.single-instance`                  | `PAYKIT_INSTANCE_COUNT_CMD` prints 1                                                                                 | one replica, stop-then-start deploys: a second process invalidates the first one's grants                 |
| `paykit`  | `paykit.log-authorization-url`            | `[setup] log_authorization_url` is not true                                                                          | set it to false: each logged URL is a bearer secret                                                       |
| `locks`   | `locks.healthz`, `locks.readyz`, `locks.storage`, `locks.worker` | ready, Postgres-backed, worker enabled                                                        | configure the database and `[worker] enabled`                                                             |
| `locks`   | `locks.identity.*`                        | `/.well-known/locks-server` publishes the Lock Server key, equal to `EXPECT_LOCK_SERVER_KEY`                         | install the carried-over `lock_server_secret_key`; a new key makes every seller republish                 |
| `locks`   | `locks.dev-route-closed`                  | `POST /verification-task-completions` answers 404                                                                    | set `[runtime] environment` to production or staging: the route completes tasks without payment           |
| `fiat`    | `fiat.health`, `fiat.auth.*`, `fiat.<processor>` | healthy with its database; signed routes answer 401; enabled processors have webhooks                       | check `FIAT_DATABASE_URL` and the webhook secrets                                                         |
| `nexus`   | `nexus.info`, `nexus.commit`              | `/v0/info` answers and `commit_hash` equals `NEXUS_SOURCE`                                                           | build from a git checkout with `.git` in the Docker context                                               |
| `nexus`   | `nexus.snapshot`, `nexus.listings`        | the index snapshot is recent; `/v0/stream/listings` returns at least `EXPECT_MIN_LISTINGS`                           | wait for the replay; check the watcher log                                                                |
| `nexus`   | `nexus.parity`                            | the same listings, revisions and states as `REFERENCE_NEXUS_URL`                                                     | wait for the replay, then compare again                                                                   |
| `wiring`  | `wiring.paykit-trusts-locks`              | Paykit `[locks] trusted_public_key` equals the Lock Server key Locks publishes                                       | copy the published `lock_server` value into the Paykit config and restart Paykit                          |
| `wiring`  | `wiring.*-origins`                        | Paykit setup, Locks connect, the service and the fiat verifier list every Shop origin, and no `*` in production      | add the missing origins                                                                                   |
| `wiring`  | `wiring.*-url`, `wiring.*-reachable`      | the service, Locks and the fiat verifier point at this stack's Paykit and Locks, and those addresses answer          | fix the URL, or the network path                                                                          |
| `wiring`  | `wiring.service-sandbox`                  | sandbox payments are off in production                                                                               | unset `SANDBOX_PAYMENTS_ENABLED`                                                                          |
| `wiring`  | `wiring.shop-setup-creator-param`         | the Shop sends `creator` to Paykit `/setup` only for the fork server                                                 | set `PUBKY_RUNTIME_PAYKIT_SETUP_CREATOR_PARAM` (false for upstream Paykit)                                |
| `version` | `version.<svc>`                           | the running commit equals the source pin (`<SVC>_BUILD_SOURCE` when a wrapper repo builds the image)                 | rebuild from the pin                                                                                      |
| `db`      | `db.<svc>.migrations`                     | `_sqlx_migrations` holds exactly the source's migrations, all successful, with matching SHA-384 checksums            | extra or mismatched rows mean another build migrated this database: use a fresh database for this release |
| `flow`    | `flow.paykit-setup.*`, `flow.locks-connect.*` | the setup and connect pages frame each Shop origin and refuse a foreign one                                      | fix `[setup] allowed_origins` or `allowed_return_origins`                                                 |
| `write`   | `write.nexus*`                            | a fresh post appears in the Nexus, its delete is indexed, and the probe data is gone from the homeserver             | check the watcher's homeserver and its log                                                                |
| `browser` | `browser.<host>.*`                        | the running client reads from this Nexus, calls no retired host, and logs no CORS error                              | fix the Shop runtime config or CORS                                                                       |
| `deep`    | `deep.<name>`                             | each configured staging proof exits 0 and prints its pass marker                                                     | read `deep-<name>.log` in the output folder                                                               |

## 5. What each opt-in probe leaves behind

- `--flow-probes`: on an upstream Paykit, one in-memory setup flow per Shop origin, which expires. On Locks, one pending connect row per Shop origin, which expires and is never completed.
- `--write-probe`: nothing once it passes. It writes one post (and a profile only if the identity has none), deletes them, and verifies they are gone from the homeserver and from the Nexus. On failure it names what is left and keeps a throwaway identity's secret, mode 600, in the output folder so the data can be removed.
- `--browser`: nothing; a signed-out page load in a throwaway profile.
- `--deep`: whatever the configured proofs leave. The marketplace service's `hold-smoke.py` cancels every order it creates and verifies the restock. `--deep` is refused for production.

## 6. Not covered here

- **Signed-in Shop journeys:** Ring and Bitkit sign-in, checkout up to the payment step, Activity and sign-out. The Shop team runs these with its release proof and test identities.
- **A real Bitcoin purchase:** it needs Bitkit wallets for buyer and seller. On staging, follow [`pubky/pubky-payment-rails` `docs/wallet-leg.md`](https://github.com/pubky/pubky-payment-rails/blob/master/docs/wallet-leg.md) against the regtest stack after this run passes.
- **Logs:** watcher panics, migration log lines and redaction of connection strings are read in the platform's log viewer.

## 7. Sample run

Production on Railway, 6 October 2026 (read-only, excerpt):

```text
== wiring
PASS  wiring.paykit-trusts-locks             Paykit trusts the Lock Server key — trusted pubkyrqrnn1d…, Locks pubkyrqrnn1d…
PASS  wiring.paykit-setup-origins            Paykit setup allows the Shop origins — 1 origin(s)
PASS  wiring.locks-paykit-reachable          Locks [paykit] server_url answers (from inside its network) — LOCKS_PAYKIT_REACH_CMD exit 0
FAIL  wiring.fiat-paykit-url                 fiat verifier forwards Bitcoin to this Paykit — http://paykit-server.railway.internal:3001
      fix: set FIAT_PAYKIT_SERVER_URL to this stack’s Paykit (declare a private address as FIAT_PAYKIT_EXPECTED_URL)
== db
PASS  db.service.migrations                  marketplace service migrations match the source exactly — 51 applied of 51
PASS  db.paykit.migrations                   Paykit migrations match the source exactly — 27 applied of 27

RESULT FAIL  PASS 82  FAIL 1  WARN 0  SKIP 2  INFO 3
```

That FAIL is real: production Locks forwards Bitcoin invoices through the fiat verifier to the staging Paykit, not to the production Paykit the Shop's seller setup uses.
