# Running the Marketplace Locally

How to get the marketplace working on your machine so you can click through it as a user. Every command here was run and verified; nothing in this file is aspirational.

Read [`status.md`](status.md) first if you want to know which parts are real and which are simulated before you start. New to the Shop: start with [`onboarding.md`](onboarding.md). Shipping a release: [`release.md`](release.md).

## TL;DR

```bash
HUSKY=0 npm ci   # HUSKY=0 keeps husky's prepare script from replacing your global git hooks

# terminal 1 — sandbox transaction service
npm run marketplace:dev

# terminal 2 — the app, with commerce switched on
PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=sandbox \
PUBKY_RUNTIME_MARKETPLACE_URL=http://localhost:3100 \
NEXT_PUBLIC_DB_NAME=franky-marketplace-sandbox \
npm run dev
```

Then sign in (the seed page is auth-gated on top of the adapter-mode gate), open <http://localhost:3000/marketplace/sandbox>, and press **Seed sandbox catalog**. Browse from <http://localhost:3000/marketplace>. The seeded catalog lives in the signed-in account's local database, so each account seeds its own copy.

Keep the sandbox database name separate from staging's database name. Changing
the adapter mode does not clear or isolate an existing browser cache. The seed
action preserves a database containing other listings and reports that it was
skipped; it reports ready only after the demo listings register with the local
transaction service. Existing demos can be registered again after that service
restarts. Do not clear site data to switch modes: that can remove local drafts.

## Why commerce is off unless you ask for it

`commerceAdapterMode` defaults to `unavailable`. In that mode the marketplace routes exist but no transactional command can be issued and the Marketplace entry does not appear in navigation, so a normal deployment is unaffected by any of this work. You have to opt in explicitly, per ADR 0019.

The four modes:

| Mode                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable` (default) | Browse-only. No commands. No nav entry. Fails closed.                                                                                                                                                                                                                                                                                                                                    |
| `sandbox`               | Full click-through against the in-memory service. Everything transactional is simulated and labeled.                                                                                                                                                                                                                                                                                     |
| `transaction-service`   | Commands and reads go to the durable Rust service with real Pubky AuthToken sessions. Authoritative outcomes and an interactive shopping UI; establishing the session is a signer approval started from the in-app "Connect marketplace session" dialog (QR or Pubky Ring deeplink) — see below.                                                                                         |
| `locks-paykit`          | Everything `transaction-service` does, PLUS the real Locks/Paykit payment rails. The modes compose rather than exclude: the durable service stays the transactional authority (its worker independently verifies the Locks lifecycle and confirms payments); the client additionally submits the buyer's proof bundle and registers the correlation. See "Running a real payment" below. |

## Verifying the service is up

```bash
curl -s localhost:3100/health/live    # {"status":"live"}
curl -s localhost:3100/health/ready   # {"status":"ready","mode":"sandbox","storage":"memory"}
```

`storage: memory` is not a bug — this service holds all transactional state in memory and loses it on restart. That is what makes it a sandbox. Re-seed after restarting it.

## What you can click through

With sandbox mode on and the catalog seeded:

- browse, filter, and search the catalog; open a listing; view a seller's shop
- favorite listings and follow shops
- create and publish a listing (this writes a **real record to your homeserver**)
- add to cart and check out
- make and counter offers; bid on auctions
- advance a payment through its states using the visibly-labeled simulate buttons
- act on orders (ship, deliver, cancel, return)
- message a seller, including image attachments
- read notifications and set preferences

## Seeding

Demo data is opt-in and lives behind `/marketplace/sandbox`, which returns 404 unless the deployment is explicitly in sandbox mode. The seeded sellers are fictional (`'y'.repeat(52)` and friends), which is exactly why the page is gated — those records must never appear in a real catalog.

## Nexus discovery

In every mode **except sandbox**, the catalog refreshes itself from the Nexus marketplace index: it reads the listing stream (`GET /v0/stream/listings`), which carries the full card projection, and stores validated index entries directly — the canonical record is fetched from the seller's homeserver only when a listing is opened (or when the index has seen a newer revision than the cache; the homeserver stays canonical per ADR 0020). The catalog always renders from the local cache first; when Nexus is unreachable or does not serve the marketplace endpoints, the refresh fails quietly and browsing continues cache-only.

**Sandbox mode never queries Nexus.** The sandbox catalog is a self-contained demo seeded with fictional sellers, and mixing indexed network listings into it would blend real and simulated content — so with `commerceAdapterMode=sandbox` the browsing flow above works exactly as described with no Nexus involved.

The marketplace endpoints are implemented on the `main` branch of [`BitcoinErrorLog/pubky-nexus`](https://github.com/BitcoinErrorLog/pubky-nexus) and are deployed as a **dedicated marketplace-indexing Nexus on Railway** (`https://nexusd-production-7108.up.railway.app`, runbook in that repository's `docs/railway-deploy.md`), which both the production and the staging Shop reach through the override below. The **official** staging Nexus the app points at by default still has no marketplace endpoints — against it the listing stream 404s and the catalog stays cache-only.

Because a dedicated marketplace-indexing Nexus is deployed separately from the main social Nexus, the app supports an **optional marketplace-only override**: set `PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL` to route ONLY the commerce/marketplace index reads at that deployment — listing stream and details, listing/shop tags, shop reviews/reputation, and the drops stream — while every social surface (posts, users, tags, files, streams, search) keeps using `PUBKY_RUNTIME_NEXUS_URL`. When the override is unset, marketplace reads fall back to the main `nexusUrl` — the variable is genuinely optional, including under the strict deployed-mode config parse. (Pointing the whole app at a marketplace-indexing Nexus with `PUBKY_RUNTIME_NEXUS_URL` still works for a single-Nexus setup.)

## Shared pubky.app sign-in (vibe session consumer)

**Off in both live Shop builds.** The production and staging deployments are built with `NEXT_PUBLIC_VIBE_SESSION_BRIDGE_ORIGIN` and `NEXT_PUBLIC_VIBE_ID` unset, so the Shop uses only its own sign-in, makes no `/session-bridge` request, and ignores a `#s=` hand-off link. Keep them unset. The cookie bridge shares one homeserver cookie between sites, and cookie sessions are deprecated by the homeserver, so it is not the path to single sign-on with pubky.app.

The consumer code remains (ADR 0029): the two variables are **build-time** values, baked into the artifact at `npm run build` — not `PUBKY_RUNTIME_*` values — and consumer mode turns on only when the bridge origin is set (an exact origin such as `https://pubky.app`; `http://localhost:<port>` is accepted only outside production builds). A bridged restore never auto-triggers a re-approval, and the staging homeserver guard still runs on every restore when `PUBKY_RUNTIME_ENV=staging`.

## Running the tests

```bash
bash scripts/prepush.sh                             # the pre-push gate: changed-file prettier/eslint, typecheck, related tests
npm run typecheck
npm run lint
npm run test                                        # the whole unit suite
npm run test:marketplace                            # sandbox service
npm run test:marketplace:service                    # durable Rust service transport, needs it running (see below)
npm run test:marketplace:locks                      # LIVE real-payment purchase, needs the composed stack (see below)
npm run test:marketplace:drops                      # LIVE FCFS drop race on the deployed staging stack (see below)
npm run test:e2e:launch-critical                    # launch-critical browser journey (CI runs it as launch-e2e)
bash scripts/vrt-linux.sh [spec...]                 # Linux visual regression in Docker (npm run test:vrt is the same)
```

Run `bash scripts/prepush.sh` before every push; its last line is `PREPUSH OK <sha> <seconds> fast`. Releases use `PREPUSH_FULL=1 bash scripts/prepush.sh`, which adds Linux VRT for every spec that renders a changed file.

VRT runs in the pinned Playwright container (`mcr.microsoft.com/playwright:v1.60.0-noble`), so it needs Docker but no local browsers. Only Linux baselines (`*-linux.png`) are committed and gate merges. Regenerate them for the specs you changed with `VRT_LINUX_UPDATE=1 bash scripts/vrt-linux.sh <spec...>` followed by `bash scripts/vrt-revert-outside.sh <spec...>`, or with the **VRT Update Baselines** workflow; the rules are in [`release.md`](release.md#visual-regression-baselines). No `TZ` env var is needed (or honored as a mechanism): the VRT harness freezes the system clock and pins the default formatting time zone to UTC in every browser — including WebKit, which ignores `TZ` — so timestamped surfaces render identically locally and in CI. See the "Time determinism" block in `src/test-utils/vrt.setup.ts` for the rules.

## Running the marketplace E2E journeys

`cypress/e2e/marketplace.cy.ts` drives the buyer, seller, and bidder journeys through the browser against the sandbox adapter. The browser user performs every step a real user can perform in the UI; counterparty identities that cannot hold a browser session (a seeded fictional seller and a scripted buyer) act through the sandbox service's own HTTP API using its actual identity model — the trusted `x-pubky-actor` header.

It needs three local services:

```bash
# 1. A local pubky testnet (homeserver + pkarr relay + http relay) with
#    token-required signup, so onboarding's invite-code step works.
cargo install pubky-testnet
cat > /tmp/pubky-homeserver-e2e.toml <<'EOF'
[general]
signup_mode = "token_required"
database_url = "postgres://postgres:postgres@localhost:5432/postgres?pubky-test=true"

[storage]
type = "in_memory"
EOF
pubky-testnet --homeserver-config /tmp/pubky-homeserver-e2e.toml

# 2. A FRESH sandbox transaction service. Its state is in-memory and the spec
#    assumes seeded quantities, so restart it before every run.
MARKETPLACE_MODE=sandbox npm run marketplace:start

# 3. The app, pointed at both.
PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=sandbox \
PUBKY_RUNTIME_MARKETPLACE_URL=http://localhost:3100 \
PUBKY_RUNTIME_HOMESERVER=8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo \
PUBKY_RUNTIME_HOMESERVER_URL=http://localhost:6286 \
PUBKY_RUNTIME_TESTNET=true \
PUBKY_RUNTIME_DEFAULT_HTTP_RELAY=http://localhost:15412/inbox/ \
npm run dev

# then
npx cypress run -P cypress --browser chrome --spec cypress/e2e/marketplace.cy.ts
```

The homeserver admin endpoint on port 6288 matches the Cypress defaults (`HOMESERVER_ADMIN_URL`, password `admin`), so invite codes are minted automatically. Nexus is not needed: sandbox mode never queries it, and the feed pages degrade gracefully. One consequence of not running a local Nexus is that the post-onboarding welcome dialog (which renders only after the new user's details sync back from Nexus) legitimately never appears — the marketplace onboarding helper treats it as optional and says why.

## Running against the durable transaction service

`services/marketplace/` is the **sandbox adapter only**. The real, durable transaction service is a separate Rust service with PostgreSQL persistence and real Pubky AuthToken authentication:

<https://github.com/pubky/pubky-marketplace-service>

```bash
git clone https://github.com/pubky/pubky-marketplace-service
cd pubky-marketplace-service
docker compose up -d --wait
export DATABASE_URL='postgres://marketplace:marketplace@localhost:55432/marketplace'
cargo test --workspace   # optional but recommended
cargo run -p marketplace-service   # listens on 127.0.0.1:8080
```

Then run the app against it:

```bash
PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=transaction-service \
PUBKY_RUNTIME_MARKETPLACE_URL=http://127.0.0.1:8080 \
npm run dev
```

The client selects a wholly different transport in this mode (`MarketplaceTransactionService`):

- **Auth is real.** A session is established by POSTing a Pubky `AuthToken` (obtained through the SDK auth flow after signer approval — see [`service-auth.md`](service-auth.md)) to `/v1/auth/sessions`; commands carry the returned opaque token as `Authorization: Bearer`. The forgeable `x-pubky-actor` header does not exist on this path. The bearer token lives in memory plus a `localStorage` mirror so reloads, new tabs, and browser restarts do not force a fresh signer approval — never in IndexedDB, cookies, or logs — and is dropped on sign-out, account switch, and expiry (see `service-auth.md` for the storage contract and tradeoff).
- **Wire casing is snake_case** per ADR 0019 §3; the client converts its camelCase contracts at the transport boundary in both directions.
- **The ported command set is accepted** — listings, offers, bids, checkout, order cancellation, fulfillment, returns, external-refund evidence, and reviews. Kinds the durable service does not implement (`payment.sandbox_advance`, messaging, notification read state/preferences) are rejected client-side before any bytes are sent, and the UI withholds those affordances in this mode.
- **Reads come from the service's role-scoped projections** (listings, offers, orders with embedded payment/shipment/return/refund/review sub-objects, payments, receipts, and notifications). The interactive shopping UI sources every `expected_revision` from a fresh projection read and treats `REVISION_CONFLICT` as refetch-and-retry.

### Connecting the session from the UI

Durable-mode screens that need a session (orders, offers, notifications, the cart's checkout, listing negotiation state) render a **"Connect marketplace session"** card instead of a dead end. Clicking it opens a dialog that:

1. states what approval authorizes (a marketplace session: the app may transact as you against the transaction service until it expires or you sign out),
2. shows the flow's `pubkyauth://` authorization URL as a QR — scan it with Pubky Ring on another device — plus an "Open in Pubky Ring" deeplink for same-device Ring and a copy affordance,
3. waits for the approval (cancellable; closing the dialog frees the flow), and
4. on approval exchanges the AuthToken for the bearer session and refetches the surfaces that were waiting on it.

If the flow fails (relay timeout, rejected token, unreachable service) the dialog shows the transport's actual error and a "Try again" that begins a fresh flow — AuthTokens are single-use, so a failed flow's QR is never reused. A connect attempt that is never approved times out after two minutes with the same visible-error-plus-retry treatment, so the dialog can never sit in "waiting for approval" forever on a dead relay channel; closing and reopening the dialog likewise cancels the old flow and mints a fresh QR (an old QR from a previous open is dead — scanning it approves into a freed flow and connects nothing). Once connected, the session survives page reloads, new tabs, and browser restarts (`localStorage`, bounded by the service-side TTL); another device still needs its own approval. When a session later expires (or the service answers 401 — including for a restored token the service no longer accepts), the same card resurfaces in place; reconnecting requires a fresh signer approval by design (see `service-auth.md`). The signer approval itself needs a device running Pubky Ring; the integration suite below proves the same transport programmatically with a throwaway keypair.

To prove the transport against the running service (session establishment, snake_case commands, idempotent replay, revision conflicts, report reads):

```bash
npm run test:marketplace:service
```

This integration suite uses no mocks: it runs a genuine Pubky auth flow (acting as the signer with a throwaway keypair), needs the service on `127.0.0.1:8080` (override with `MARKETPLACE_SERVICE_URL`) and network access to the Pubky HTTP relay. It is intentionally not part of the unit gates.

The client's state tables are held in lockstep with the service's canonical contract: `contracts/state-machines.json` from the service repo is vendored at `src/libs/commerce/contracts/state-machines.json`, and `src/libs/commerce/state-machines.contract.test.ts` fails CI on any drift. When the service contract changes, re-vendor the file and reconcile the TypeScript — the service is canonical.

### Enabling encrypted messaging (durable modes)

Marketplace messaging in the durable modes is end-to-end encrypted over Paykit Encrypted Links (experiment grade — see [`status.md`](status.md) and [`paykit-wasm-provenance.md`](paykit-wasm-provenance.md)). It needs its OWN Pubky Ring approval, separate from the marketplace session above, because it grants a different capability:

1. Open a listing's **Message seller** dialog or the marketplace **Messages** page. If messaging is not enabled yet, an **"Enable encrypted messaging"** step appears.
2. The dialog shows a `pubkyauth://` URL (QR for cross-device Ring, deeplink/copy for same-device) requesting exactly `/pub/paykit/:rw` — the Paykit homeserver tree where receiver markers, handshake slots, and encrypted message slots live. Approve it in Pubky Ring.
3. On approval the app generates a receiver-scoped Noise key on this device (never the identity key, which stays in Ring), publishes your receiver marker, and messaging is live for this tab.

Facts to know, all disclosed in the UI: the messaging session survives reloads, new tabs, and browser restarts (secret-free metadata in `localStorage`; the real credential is the browser's HTTP-only homeserver cookie, revalidated on restore — see `service-auth.md`), and the **Reconnect** affordance asks for a fresh Ring approval only when the homeserver no longer accepts that cookie (stored history stays readable without one); BOTH parties must have enabled messaging before anything can be delivered, and the composer stays disabled with a truthful "waiting for the counterparty" state until the Noise handshake completes; one message is capped at 1,000 bytes (live byte meter, no attachments); conversation history and the local key material are device-local in origin-scoped IndexedDB (`franky`, not per-pubky) and wiped on sign-out/account switch — clearing site data also deletes them, and other devices cannot show the history (the multi-device backup key is an open product decision).

To prove the encrypted transport live — two parties, real crypto, real homeserver — against a local Pubky testnet:

```bash
pubky-testnet   # stock ports: pkarr relay 15411, homeserver HTTP 6286, admin 6288
npm run test:marketplace:messaging
```

This live suite runs the vendored WASM binding in a real Chromium page with no mocks: enrollment and marker publish through the app's own messaging service, the not-enrolled honest dead end, the Noise XX handshake over live homeserver outbox slots, bidirectional `marketplace.chat_message.v0` delivery, IndexedDB persistence, and snapshot/restore across a simulated reload. Sessions come from the binding's dev signup helper — the interactive Ring approval is the one leg a machine cannot honestly perform. It is intentionally not part of the unit gates.

The same proof also exists against the REAL staging network — the staging homeserver reached through the public pkarr relays, the exact topology of the staging deployment (`PUBKY_RUNTIME_TESTNET=false`). It passed on 2026-08-21. The staging homeserver requires single-use signup tokens, so this is a run-on-demand suite, never a standing gate:

```bash
PAYKIT_STAGING_SIGNUP_TOKEN_A=XXXX-XXXX-XXXX \
PAYKIT_STAGING_SIGNUP_TOKEN_B=YYYY-YYYY-YYYY \
npm run test:marketplace:messaging:staging
```

The harness prints the throwaway identity secrets it generates; if a run fails after signup (tokens consumed), re-run with `PAYKIT_STAGING_SECRET_A`/`PAYKIT_STAGING_SECRET_B` instead of tokens to sign back in.

## Cross-account live proof (stranger reads a published listing)

The serialized-nulls bug — every published listing unloadable by anyone except its cached seller — shipped because no test ever viewed a listing as a **stranger**: every test either read its own writes back from the local cache or used already-normalized fixtures. This suite makes the stranger journey a first-class live proof against the REAL staging homeserver:

1. Identity A signs up, uploads real media bytes, and publishes a listing through the real create path — with the wire record carrying the exact explicit nulls shipped studios serialize (`region: null`, `sku: null`, `priceOverride: null`); the suite verifies the nulls are really in the raw homeserver JSON. A also publishes their shop record.
2. The local IndexedDB cache is destroyed, identity B signs up fresh, and the suite asserts B's cache is empty.
3. B loads the listing through the REAL read path (`getOrFetchListing` → homeserver fetch → normalizer) and asserts the parsed record is renders-ready: nulls normalized to honest absences, title/price/condition format, the media URL resolves to a fetchable HTTPS URL with the published content hash, and the read populated B's local-first cache.
4. B loads A's shop page data the way `MarketplaceShop.tsx` does: the canonical shop record, the tolerated Nexus seller-catalog refresh, and the local-first seller listings.

The staging homeserver requires single-use signup tokens, so this is a run-on-demand suite, never a standing gate. Generate two tokens from the staging homeserver admin endpoint (`GET https://admin.homeserver.staging.pubky.app/generate_signup_token` with the `X-Admin-Password` header — the password is intentionally not written down in this repo; ask the team), then:

```bash
MARKETPLACE_STAGING_SIGNUP_TOKEN_A=XXXX-XXXX-XXXX \
MARKETPLACE_STAGING_SIGNUP_TOKEN_B=YYYY-YYYY-YYYY \
npm run test:marketplace:cross-account
```

The harness prints the throwaway identity secrets it generates; if a run fails after signup (tokens consumed), re-run with `MARKETPLACE_STAGING_SECRET_A`/`MARKETPLACE_STAGING_SECRET_B` instead of tokens to sign back in. It passed against the live staging homeserver on 2026-08-21.

## Drops (durable modes only)

Drops (ADR 0026, phase D1 — FCFS) run only against the durable transaction service: server time is the feature, so sandbox mode gets no drops and shows the affordances as unavailable, labeled. With the app in `transaction-service` (or `locks-paykit`) mode:

- **Shopper surfaces.** The drops calendar at `/marketplace/drops` (fed by the dedicated Nexus's `GET /v0/stream/drops`; it degrades honestly to an empty state when the configured index lacks the stream) and the drop page at `/marketplace/drop/{seller}/{dropId}` — server-corrected countdown, the pre-T-0 **ready check** (session + address + per-buyer allowance staged before launch), the FCFS claim through the existing checkout path with the service's refusal copy rendered verbatim (never a fake queue), and the ended/archive states. Paid drop orders show their edition badge on the orders timeline; the "Edition N of M" line renders only from the offline-verified `pubky-drop-edition+v1` attestation.
- **Merchant surfaces.** The **Drop Studio** at `/marketplace/sell/drops`: a composer over existing listings with the two-truth publish status (record on your homeserver / registered with the service — the same split listings have), mission control with visibility-bounded polling during the window, a typed-CANCEL kill switch, and post-end release-listings returning remaining stock to open sale.

**Sandbox payment advancement on staging.** The deployed staging service runs with `SANDBOX_PAYMENTS_ENABLED=true`, so buyer-driven sandbox payment advancement works there — staging handles no real orders, and the sandbox path stands in for a real payment rail. The service-side gate defaults to `false`, and per the service README it **must stay `false` on any deployment handling real orders**: with the flag at its default the service rejects `payment.sandbox_advance` outright regardless of what any client sends (the client's own transport allowlist refuses to send it at all — a courtesy, not the boundary).

To prove the whole D1 path live — real records and `drop.sync` on the deployed stack, two real buyers racing the last unit, exactly one winner, terminal sell-out, gapless edition, offline-verified attestation inside the portable receipt on the winner's own homeserver:

```bash
npm run test:marketplace:drops
```

It needs three single-use staging signup tokens (`MARKETPLACE_STAGING_SIGNUP_TOKEN_SELLER`, `MARKETPLACE_STAGING_SIGNUP_TOKEN_BUYER_A`, `MARKETPLACE_STAGING_SIGNUP_TOKEN_BUYER_B` — one per identity) or, on re-runs, a saved-identities JSON file whose path OUTSIDE the repo is supplied at run time via `MARKETPLACE_STAGING_DROP_IDENTITIES_FILE`; the harness writes that file itself on the first successful signup and prefers it afterward so tokens are not burned. `MARKETPLACE_SERVICE_URL` and `MARKETPLACE_NEXUS_URL` override the deployed defaults. Tokens, secrets, and the identities-file path are never committed. Like the other staging proofs, it is run-on-demand, never a standing gate. It passed on 2026-08-23 — see the proof ledger in [`status.md`](status.md).

## Running a real Locks/Paykit payment (`locks-paykit` mode)

Real payments work end to end on regtest, with the wallet's protocol role exercised by the composed environment's real tooling (`paykit-companion-auth` approves the watch-only companion claim; `paykit-reader-demo` receives the private Paykit Payment Request). Only the real Bitkit app UX remains unproven — see [`status.md`](status.md).

Three pieces must run:

1. **The composed payments environment** (Lock Server, Paykit Server, Bitcoin regtest, Fulcrum, pinned Pubky testnet). It lives in its own repo checkout (`payments-env`); `./scripts/up.sh` brings it up with Lock Server on `13000` and Paykit Server on `13001`, and its own `verify.sh` re-proves the protocol leg independently.
2. **The durable transaction service, with Locks verification enabled.** The three `LOCKS_*` values are all-or-nothing; the service fails closed at startup on a partial configuration and refuses `payment.register_locks` entirely when they are absent:

```bash
DATABASE_URL='postgres://marketplace:marketplace@localhost:55432/marketplace' \
LOCKS_SERVER_URL='http://localhost:13000' \
LOCKS_BUNDLE_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
LOCKS_LOOKUP_HMAC_KEY="$(openssl rand -hex 32)" \
cargo run -p marketplace-service
```

3. **The app in `locks-paykit` mode.** Activation is validated fail-closed: every payment-rail URL must be EXPLICITLY set or the runtime config parse throws — the mode never activates on defaulted localhost URLs:

```bash
PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=locks-paykit \
PUBKY_RUNTIME_MARKETPLACE_URL=http://127.0.0.1:8080 \
PUBKY_RUNTIME_LOCKS_URL=http://localhost:13000 \
PUBKY_RUNTIME_PAYKIT_SETUP_URL=http://localhost:13001/setup \
npm run dev
```

What the buyer flow does (and deliberately does not do): after checkout creates an order with an `awaiting_entitlement` payment, the buyer's "Request payment in your wallet" action submits a proof bundle to the Lock Server (which signs and sends the real invoice request to Paykit Server) and registers the correlation with the transaction service via `payment.register_locks`, sourcing `expected_revision` from a fresh projection read. Registration flips the payment to the `locks` adapter — permanently refusing sandbox advancement — and **never advances the payment**: the service's worker independently verifies the Locks lifecycle and confirms exactly once. The buyer-visible status is limited to awaiting payment, confirmed, window expired, and manual review; detection and confirmation counts stay internal per the upstream contract. Status polling is bounded by the registration's payment window, abortable, and resumable after reload (the correlation — including the bearer bundle id in plaintext — is persisted in origin-scoped Dexie `commerce_locks_correlations` and wiped on sign-out/account switch; the Dexie name and the bundle id do not isolate identities). After confirmation, a digital order unlocks its content through a short-lived Locks access credential and the delivered bytes are BLAKE3-verified against the listing record before being offered.

To prove the whole path live — proof bundle, `payment.register_locks`, private Payment Request receipt, on-chain regtest payment, worker confirmation, order `paid` with a durable receipt, and a hash-verified guarded read:

```bash
# expects payments-env checked out as a sibling directory (override: PAYMENTS_ENV_DIR)
npm run test:marketplace:locks
```

This live suite uses no mocks and fails loudly when a dependency is missing. It orchestrates the environment's own tooling over `docker compose` for the seller-side setup and the wallet-simulation roles, and exercises the client's own services (`LocksGatewayService`, `MarketplaceGatewayService`, `CommerceApplication`) for every marketplace-side step. Each run creates a fresh buyer identity (an invoice binds to its reader, so exactly one Payment Request must be actionable) and writes its observed facts to `.live-out/`.

## Troubleshooting

**Marketplace missing from navigation.** Expected unless `PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE` is set to something other than `unavailable`.

**Catalog empty.** Seed it at `/marketplace/sandbox`. If that page 404s, the app is not in sandbox mode.

**`/marketplace/sandbox` 404s.** The env var is not reaching the app. Locally the server reads it when it renders each page, from the environment `npm run dev` started with, so restart `npm run dev` after setting it.

**Everything transactional errors after a restart.** The sandbox service lost its memory. Re-seed.

**Local data disappeared once after upgrading.** Expected. The marketplace adds Dexie tables, which requires a database version change, and the app recreates the database on version change (ADR 0023). Feeds and profiles re-sync from your homeserver; device-local drafts do not.
