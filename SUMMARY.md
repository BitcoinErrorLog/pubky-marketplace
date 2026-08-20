# Pubky Marketplace — Project Summary

A decentralized e-commerce marketplace for [Pubky App](https://github.com/BitcoinErrorLog/pubky-app): seller-owned public records on homeservers, a durable event-sourced transaction service for the invariants local-first cannot hold, real Bitcoin payments over Locks + Paykit (regtest-proven), and an encrypted-messaging path proven in real browsers. Everything below is built, tested, and pushed under the `BitcoinErrorLog` GitHub org.

Everything started from an unfinished AI prototype; it was assessed, kept where sound, and rebuilt where it was fake. The project's core discipline is **truthful labeling**: every simulated state says it is simulated, and [`docs/ecommerce/status.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr20-payments/docs/ecommerce/status.md) is the authoritative real-vs-simulated ledger.

## Repositories

| Repo | Role |
| --- | --- |
| [`BitcoinErrorLog/pubky-app`](https://github.com/BitcoinErrorLog/pubky-app) — branches `marketplace/pr1-docs` … `marketplace/pr20-payments` (linear review stack) | The client: marketplace UI, local-first Dexie layer, commerce application/controller/service layers, ~20 VRT suites, Cypress E2E journeys |
| [`BitcoinErrorLog/pubky-marketplace-service`](https://github.com/BitcoinErrorLog/pubky-marketplace-service) | Rust + PostgreSQL transaction authority: event log, outbox workers, role-scoped projections, Pubky AuthToken auth, server-side Locks verification |
| [`BitcoinErrorLog/pubky-app-specs`](https://github.com/BitcoinErrorLog/pubky-app-specs) | Specs fork adding marketplace objects (shop, listing, review) under `/pub/pubky.app/marketplace/v1/`, published as `0.6.2-marketplace.1` |
| [`BitcoinErrorLog/pubky-nexus`](https://github.com/BitcoinErrorLog/pubky-nexus) — branch `feat/marketplace-indexing` | Indexer support: listing stream, shop/listing endpoints, auction terms, ending-soon sort, one-shot backfill migration |
| [`BitcoinErrorLog/paykit-rs-official`](https://github.com/BitcoinErrorLog/paykit-rs-official) — branch `feat/wasm-binding` | Fork of official `pubky/paykit-rs` with a browser WASM binding of the encrypted-link messaging surface (distinct from the deprecated legacy `BitcoinErrorLog/paykit-rs`) |
| [`BitcoinErrorLog/pubky-marketplace`](https://github.com/BitcoinErrorLog/pubky-marketplace) (this repo) | Umbrella: composed payments environment (`payments-env/`), project map, this summary |

## Key documents

All on the `marketplace/pr20-payments` branch of `pubky-app` unless noted:

- [`docs/ecommerce/status.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr20-payments/docs/ecommerce/status.md) — what is real, simulated, or deferred (the honesty ledger)
- [`docs/ecommerce/RUNNING.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr20-payments/docs/ecommerce/RUNNING.md) — how to run everything locally
- [`docs/ecommerce/pr-split.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr20-payments/docs/ecommerce/pr-split.md) — the 20-branch review stack and specs-upstreaming notes
- [`docs/ecommerce/upstream-integration.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr20-payments/docs/ecommerce/upstream-integration.md) — pinned upstream commits and API contracts (`pubky/locks`, `pubky/paykit-rs`, `pubky/paykit-server`)
- [`docs/ecommerce/service-auth.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr20-payments/docs/ecommerce/service-auth.md) — Pubky AuthToken bearer-session design
- [`docs/ecommerce/locks-sdk-provenance.md`](https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr20-payments/docs/ecommerce/locks-sdk-provenance.md) — Locks SDK build provenance and the SDK-vs-HTTP routing decision with probe evidence
- [`docs/ecommerce/messaging/`](https://github.com/BitcoinErrorLog/pubky-app/tree/marketplace/pr20-payments/docs/ecommerce/messaging) — encrypted-transport evaluation, recommendation, implementation plan
- ADRs [`0019`](https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr20-payments/docs/adr/0019-marketplace-transaction-authority.md) (transaction authority), [`0020`](https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr20-payments/docs/adr/0020-marketplace-public-records.md) (public records), plus 0021–0023 (namespace, Rust service, single DB migration)
- Service contract: [`contracts/state-machines.json`](https://github.com/BitcoinErrorLog/pubky-marketplace-service/blob/main/contracts/state-machines.json) — canonical state machines, vendored into the client with a CI drift test
- WASM binding: [`paykit-wasm/README.md`](https://github.com/BitcoinErrorLog/paykit-rs-official/blob/feat/wasm-binding/paykit-wasm/README.md) (provenance, API, limits), [`paykit-wasm/docs/browser-e2e.md`](https://github.com/BitcoinErrorLog/paykit-rs-official/blob/feat/wasm-binding/paykit-wasm/docs/browser-e2e.md) (14/14 browser proof), [`docs/upstream-issue-draft.md`](https://github.com/BitcoinErrorLog/paykit-rs-official/blob/feat/wasm-binding/docs/upstream-issue-draft.md) (ready-to-file, deliberately unfiled)
- Environment: [`payments-env/README.md`](payments-env/README.md) — composed Locks + Paykit + regtest stack and the re-runnable payment verification

## Features

### Catalog, shops, and selling

Seller-owned shop/listing/review records live on the seller's homeserver (specified and validated in the specs fork — parseable protocol objects, not client-private JSON). Discovery runs through the Nexus listing stream; the index carries the full card projection including auction terms, so the grid renders straight from validated index entries and the canonical record is fetched only when a listing is opened. Auction cards lazily fetch the live current bid from the transaction service when they scroll into view — one request per card actually seen, never an invented bid. The sell studio covers variants, SKUs, content-hashed media, draft autosave, and publish. Carts, drafts, favorites, and shop follows are local-first in account-scoped IndexedDB.

![Catalog browse](docs/vrt/catalog-browse.png)
![Auction cards with live bid](docs/vrt/auction-cards-live-bid.png)
![Catalog filters](docs/vrt/catalog-filters.png)
![Shop page](docs/vrt/shop-page.png)
![Sell studio with variants](docs/vrt/sell-studio.png)
![Seller dashboard](docs/vrt/seller-dashboard.png)

### Listings, offers, and auctions

Fixed-price, auction (with proxy bidding, reserve, buy-now, exactly-once close on the service), and Locks-guarded digital listings. Offers and counter-offers run through the durable service with optimistic-concurrency (`expected_revision` on every command; conflicts refetch and prompt retry).

![Fixed-price listing](docs/vrt/listing-fixed-price.png)
![Auction listing](docs/vrt/listing-auction.png)
![Digital listing with Locks/Paykit rails](docs/vrt/listing-digital-locks-paykit.png)
![Offers inbox](docs/vrt/offers-inbox.png)
![Bid dialog](docs/vrt/auction-bid-dialog.png)

### Cart, checkout, orders, and post-purchase

Checkout creates durable orders on the transaction service. The orders timeline covers the full lifecycle: payment, shipping with tracking, delivery confirmation, returns, disputes with sealed evidence, externally-evidenced refunds, reviews with a 24-hour edit window, and exactly-once receipts.

![Multi-seller cart](docs/vrt/cart-multi-seller.png)
![Cart in locks-paykit mode](docs/vrt/cart-locks-paykit.png)
![Orders in every lifecycle state](docs/vrt/orders-every-state.png)
![Resolved dispute on the order timeline](docs/vrt/orders-dispute-resolved.png)

### Real Bitcoin payments (regtest-proven)

In `locks-paykit` mode the full purchase path is real and verified live: buyer proof bundle → real Paykit invoice → private Payment Request → on-chain regtest payment → the service's worker independently verifies the Locks lifecycle and confirms exactly once → order paid, durable receipt, BLAKE3 hash-verified digital delivery. The mode fails closed twice over (config refuses to parse without explicit rail URLs; the service refuses registration without its Locks secrets). The buyer UI shows only the service's verified projection — the client never advances payment state, and sandbox-simulated states carry a visible label. The only unproven leg is the Bitkit phone-app UX, which requires a person with a device and is documented as such.

![Payment confirmed](docs/vrt/payment-confirmed.png)
![Hash-verified digital delivery unlocked](docs/vrt/payment-delivery-unlocked.png)
![Sandbox payment state, labeled](docs/vrt/payment-sandbox-labeled.png)
![Seller payment settings with Locks connected](docs/vrt/payment-settings-locks.png)

### Moderation and disputes

Configured moderator roles (no hardcoded identities, no broad admin). Moderators get a dispute adjudication queue and audited case-file reads; participants see the same case file from their order and submit sealed evidence. Non-moderators get a 403 and no queue at all.

![Moderation dispute queue](docs/vrt/moderation-queue.png)
![Moderator dispute case file](docs/vrt/moderator-dispute-case.png)

### Notifications

Service-delivered notification rows (outbox, at-least-once with dedup) merge into the app's general notification surface, interleaved with social notifications, feeding the unread badge and deep-linking to the right surface — carrying only what ADR-0019 §8 allows, with tests asserting nothing else can leak through. Durable rows never fake read-state the service doesn't store.

![Marketplace notifications](docs/vrt/notifications.png)
![Marketplace events in the app's general notification surface](docs/vrt/notifications-app-surface.png)

### Private messaging (sandbox-only, encrypted path proven)

Messaging is sandbox-only and says so at the point of use (plaintext, in-memory, operator-readable — disclosed where people type). The encrypted end state is built and proven: a browser WASM binding of official paykit-rs encrypted links passes 14/14 e2e checks in real Chromium, Firefox, and WebKit against a live testnet homeserver — sessions, marker discovery, Noise XX handshake over homeserver transport, bidirectional encrypted messages, and snapshot/restore across a destroyed browser context. Remaining before it ships: live signer-approval flow, mainnet relay topology, backup-key and Ring-grant product decisions.

![Messaging inbox with plaintext disclosure](docs/vrt/messaging-inbox.png)
![Message dialog with point-of-use disclosure](docs/vrt/message-dialog.png)

## The transaction service

[`pubky-marketplace-service`](https://github.com/BitcoinErrorLog/pubky-marketplace-service) exists because atomic inventory, one-winner auctions, and payment verification cannot be enforced by local-first clients ([ADR-0019](https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr20-payments/docs/adr/0019-marketplace-transaction-authority.md)). It is event-sourced on PostgreSQL with constraint-enforced invariants and 100-way concurrency proofs (one winner, idempotent commands). Auth is real Pubky `AuthToken` verification with replay protection — no passwords, no custom challenge scheme. Reads are role-scoped projections that structurally withhold what a role must not see (bearer bundle ids, delivery addresses, evidence bodies). Workers handle auction close, expiry, outbox delivery, and independent Locks payment verification. The canonical state machines are a cross-language contract with a CI drift test on the client.

## Test surface

- **12,000+ client unit tests** across core, libs, hooks, and components
- **~20 VRT suites, 300+ committed baselines** across chromium/firefox/webkit, darwin+linux (the images above are drawn from them)
- **10 Cypress E2E journeys** (buyer, seller, bidder, moderator) plus an accessibility pass
- **Live proofs, not mocks**: a re-runnable real purchase over the composed regtest stack (`npm run test:marketplace:locks`), live client-vs-service auth/command verification (`npm run test:marketplace:service`), 14/14 browser e2e for encrypted messaging, and the service's own integration suite (100+ tests) with concurrency proofs

## Honest limits

- **No independent security review** (explicitly waived for now; still required before real funds)
- **Bitkit phone-app UX** unproven (protocol role exercised by real tooling; the phone leg needs a human)
- **Nexus marketplace index** not deployed to any shared Nexus (branch + one-shot backfill migration ready; operator runbook in the Nexus README)
- **Messaging** remains sandbox-only pending signer-flow proof and two product decisions (backup key, Ring grant UX)
- **Upstream engagement** deliberately withheld: the paykit wasm-binding issue is drafted but unfiled; the specs fork reconciliation notes are written but not proposed upstream
