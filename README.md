# Pubky Marketplace

Umbrella repository for the Pubky App marketplace project: the integration environment lives here, and this README maps every repository, branch, and document that makes up the feature. Everything is hosted under the `BitcoinErrorLog` GitHub org for now.

## Repository map

| Piece | Where | What it is |
| --- | --- | --- |
| Client (Pubky App) | [`BitcoinErrorLog/pubky-app`](https://github.com/BitcoinErrorLog/pubky-app), stacked branches `marketplace/pr1-docs` … `marketplace/pr20-payments` | Next.js app with the marketplace UI, local-first Dexie cache, commerce application layer, VRT suites, and E2E journeys. The stack order and review plan live in `docs/ecommerce/pr-split.md` on the branches. |
| Transaction service | [`BitcoinErrorLog/pubky-marketplace-service`](https://github.com/BitcoinErrorLog/pubky-marketplace-service) | Rust + PostgreSQL event-sourced service: offers, auctions (proxy bidding, exactly-once close), orders, returns, disputes, moderation, notifications, role-scoped read projections, Pubky AuthToken auth, server-side Locks verification. Canonical state machines in `contracts/state-machines.json`. |
| Specs fork | [`BitcoinErrorLog/pubky-app-specs`](https://github.com/BitcoinErrorLog/pubky-app-specs) | Fork of `pubky/pubky-app-specs` adding the marketplace objects (shop, listing, review) under `/pub/pubky.app/marketplace/v1/`, published as `0.6.2-marketplace.1` and consumed by the client. Reconciliation notes for upstreaming: `docs/ecommerce/pr-split.md` in the app. |
| Nexus indexing | [`BitcoinErrorLog/pubky-nexus`](https://github.com/BitcoinErrorLog/pubky-nexus), branch `feat/marketplace-indexing` | Indexer support for marketplace shops/listings: `/v0/stream/listings`, `/v0/shop/{seller_id}`, `/v0/listing/{seller_id}/{listing_id}`, auction terms, `sorting=ends_at`. Not deployed to any shared Nexus yet. |
| Locks SDK (vendored) | inside `pubky-app` branches | `locks-sdk-wasm` built from `pubky/locks`; provenance (source commit, toolchain, checksums) in `docs/ecommerce/locks-sdk-provenance.md`. |
| Paykit WASM binding (experiment) | [`BitcoinErrorLog/paykit-rs-official`](https://github.com/BitcoinErrorLog/paykit-rs-official), branch `feat/wasm-binding` | Fork of the official `pubky/paykit-rs` attempting a browser WASM binding for encrypted-link messaging — the recommended end state for operator-unreadable marketplace DMs. Not the deprecated legacy `BitcoinErrorLog/paykit-rs`, which shares no history with the official library. |
| Payments environment | [`payments-env/`](payments-env/) in this repo | Composed Locks Server + Paykit Server + Bitcoin Core (regtest) + Electrum + Pubky testnet, with a re-runnable script proving the protocol-level payment leg end to end. See its own README. |

## Key documents (on the `pubky-app` marketplace branches)

- `docs/ecommerce/status.md` — what is real, simulated, or deferred; single source of truth for honesty about the feature.
- `docs/ecommerce/RUNNING.md` — how to run the marketplace locally (durable mode and sandbox).
- `docs/ecommerce/pr-split.md` — the stacked-PR plan and specs-upstreaming reconciliation notes.
- `docs/ecommerce/upstream-integration.md` — pinned upstream commits (`pubky/locks`, `pubky/paykit-rs`, `pubky/paykit-server`) and API contracts.
- `docs/ecommerce/service-auth.md` — Pubky AuthToken design for service authentication.
- `docs/ecommerce/messaging/` — encrypted-transport evaluation, recommendation, and implementation plan for private messaging.
- `docs/adr/0019`–`0023` — architectural decisions (transaction authority, public records, namespace, Rust service, DB migration).

## Status

Pre-production. Payments run against regtest only; private messaging is sandbox-only pending the Paykit WASM binding; no independent security review has been performed. `docs/ecommerce/status.md` in the app is authoritative on what works.
