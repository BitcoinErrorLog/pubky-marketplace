# Pubky Marketplace

Umbrella repository for the Pubky App marketplace project: the integration environment lives here, and this README maps every repository, branch, and document that makes up the feature. Everything is hosted under the `BitcoinErrorLog` GitHub org for now.

**Start with [SUMMARY.md](SUMMARY.md)** — the full feature summary with UI screenshots from the visual-regression suites and links to every repo and document.

## Repository map

| Piece | Where | What it is |
| --- | --- | --- |
| Client (Pubky App) | [`BitcoinErrorLog/pubky-app`](https://github.com/BitcoinErrorLog/pubky-app), stacked branches `marketplace/pr1-docs` … `marketplace/pr44-watch-sync` and counting; `marketplace/pr25-ux` is the integration/deploy line, live at <https://shop.pubky.app> (Vercel) | Next.js app with the marketplace UI, local-first Dexie cache, commerce application layer, VRT suites, and E2E journeys. The original slice plan is `docs/ecommerce/pr-split.md` (now a historical record); `docs/ecommerce/status.md` on `marketplace/pr25-ux` is current truth. |
| Transaction service | [`BitcoinErrorLog/pubky-marketplace-service`](https://github.com/BitcoinErrorLog/pubky-marketplace-service) | Rust + PostgreSQL event-sourced service: offers, auctions (proxy bidding, exactly-once close), orders, returns, disputes, moderation, notifications, role-scoped read projections, Pubky AuthToken auth, server-side Locks verification. Canonical state machines in `contracts/state-machines.json`. |
| Specs fork | [`BitcoinErrorLog/pubky-app-specs`](https://github.com/BitcoinErrorLog/pubky-app-specs), branch `feat/marketplace-objects-0.6.x` | Fork of `pubky/pubky-app-specs` adding the marketplace objects (shop, listing, review — later purchase attestations, review responses, and the listing attributes container) under `/pub/pubky.app/marketplace/v1/`, published as releases `v0.6.2-marketplace.1`–`.4` and consumed by the client and Nexus. Reconciliation notes for upstreaming: `docs/ecommerce/pr-split.md` in the app. |
| Nexus indexing | [`BitcoinErrorLog/pubky-nexus`](https://github.com/BitcoinErrorLog/pubky-nexus), branch `feat/marketplace-indexing` | Indexer support for marketplace shops/listings/reviews: `/v0/stream/listings`, shop/listing endpoints, auction terms, `sorting=ends_at`, community-tag aggregation, review indexing with offline attestation verification, and reputation aggregates. Deployed as a dedicated marketplace-indexing Nexus on Railway (`https://nexusd-production-7108.up.railway.app`, project `pubky-marketplace-nexus`; runbook in the branch's `docs/railway-deploy.md`), watching the official staging homeserver. The official shared Nexus deployments still carry none of this. |
| Locks SDK (vendored) | inside `pubky-app` branches | `locks-sdk-wasm` built from `pubky/locks`; provenance (source commit, toolchain, checksums) in `docs/ecommerce/locks-sdk-provenance.md`. |
| Paykit WASM binding | [`BitcoinErrorLog/paykit-rs-official`](https://github.com/BitcoinErrorLog/paykit-rs-official), branch `feat/wasm-binding` | Fork of the official `pubky/paykit-rs` with an experiment-grade browser WASM binding of the encrypted-link messaging surface — vendored into the client and powering the durable modes' end-to-end-encrypted messaging (16/16 three-engine browser e2e). Not the deprecated legacy `BitcoinErrorLog/paykit-rs`, which shares no history with the official library. |
| Payments environment | [`payments-env/`](payments-env/) in this repo | Composed Locks Server + Paykit Server + Bitcoin Core (regtest) + Electrum + Pubky testnet, with a re-runnable script proving the protocol-level payment leg end to end. See its own README. |
| Deployed staging rails | [`BitcoinErrorLog/pubky-payment-rails`](https://github.com/BitcoinErrorLog/pubky-payment-rails) | Railway deployment (project `pubky-marketplace-staging`) of the pinned Lock Server + Paykit Server + regtest bitcoind + Fulcrum, plus the verification driver that proves live purchases against the deployed stack over the real staging Pubky network. |
| Fiat verifier gateway | [`BitcoinErrorLog/pubky-fiat-verifier`](https://github.com/BitcoinErrorLog/pubky-fiat-verifier) | Rust payment verifier gateway sitting behind the Lock Server's single `[paykit] server_url` (staging is cut over to it): BTC criteria proxy verbatim to the real Paykit Server, `USD` criteria settle through a Stripe **test-mode** processor (Checkout Sessions, webhook-as-hint / API-pull-as-truth, settlement-delay window). Proves Locks is payment-agnostic with zero upstream changes — design and Phase 1 execution record in `docs/ecommerce/fiat-rails-*.md` on the app branches. |

## Key documents (on the `pubky-app` marketplace branches)

- `docs/ecommerce/status.md` — what is real, simulated, or deferred; single source of truth for honesty about the feature.
- `docs/ecommerce/RUNNING.md` — how to run the marketplace locally (durable mode and sandbox).
- `docs/ecommerce/pr-split.md` — the stacked-PR plan and specs-upstreaming reconciliation notes.
- `docs/ecommerce/upstream-integration.md` — pinned upstream commits (`pubky/locks`, `pubky/paykit-rs`, `pubky/paykit-server`) and API contracts.
- `docs/ecommerce/service-auth.md` — Pubky AuthToken design for service authentication.
- `docs/ecommerce/messaging/` — encrypted-transport evaluation, recommendation, and implementation record for private messaging (E2EE over Paykit Encrypted Links shipped in the durable modes; general DMs too).
- `docs/ecommerce/trust-reputation-design.md` / `trust-reputation-plan.md` — attested public reviews and portable reputation (Phases 0–2 and the Phase 4 surfaces landed).
- `docs/adr/0019`–`0024` — architectural decisions (transaction authority, public records, namespace, Rust service, DB migration, portable reputation).

## Status

Pre-production, deployed to staging: the client at <https://shop.pubky.app> (Vercel), the transaction service, payment rails (Bitcoin **regtest** only), fiat-verifier gateway, and marketplace-indexing Nexus on Railway. Private messaging in the durable modes is real end-to-end encryption at experiment grade (sandbox mode stays plaintext and labeled). No independent security review has been performed — required before any real funds. `docs/ecommerce/status.md` on `marketplace/pr25-ux` in the app is authoritative on what works.
