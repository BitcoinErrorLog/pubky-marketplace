[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/pubky/pubky-app)

# Pubky web app

## Pubky Marketplace

`pubky/pubky-marketplace` holds the Shop web client, its documentation and
the tester issue tracker. The client is built on the official
[`pubky/pubky-app`](https://github.com/pubky/pubky-app) and adds a full
peer-to-peer **marketplace** on top of the social app; its history includes
the official app's history. Release line: branch `master` (the repository
default), live at [shop.pubky.app](https://shop.pubky.app). Payments there are
real and go straight to the seller.

New to the Shop: [`docs/ecommerce/onboarding.md`](docs/ecommerce/onboarding.md).
Releasing: [`docs/ecommerce/release.md`](docs/ecommerce/release.md).
Project documents (launch plan, team brief, SSO, upstream briefs):
[`docs/README.md`](docs/README.md), the
[marketplace overview](docs/marketplace-overview.md) and
[`SUMMARY.md`](SUMMARY.md). Report bugs and questions in
[issues](https://github.com/pubky/pubky-marketplace/issues).

**What the Shop adds over the official app:**

- **User-owned commerce catalog** — shops, listings (variants, shipping,
  auctions, digital goods), reviews, and drops are seller-signed records on
  the seller's homeserver (specs fork `pubky-app-specs`
  `0.6.2-marketplace.x`), indexed by a dedicated Nexus; portable by design.
- **Durable transactions** — carts, checkout, offers/counteroffers, proxy-bid
  auctions, orders, fulfillment, returns, and disputes run against a
  separate Rust transaction service
  ([`pubky/pubky-marketplace-service`](https://github.com/pubky/pubky-marketplace-service),
  ADR 0019/0022): server-time deadlines, constraint-backed one-winner
  concurrency, idempotent command envelopes.
- **Real payments, out of band** — Bitcoin via Locks + Paykit (regtest,
  proven end to end including a real Bitkit wallet swipe-to-pay), and
  PayPal behind a payment-agnostic Locks fiat gateway. Card payments are
  paused in the shop. The app never holds or moves funds, and says so.
- **Drops** (ADR 0026) — timed, limited releases with server-enforced
  schedules and caps, honest stock display, and attested edition numbers
  ("7 of 100") that live in the buyer's own private receipt documents.
- **Portable trust** — service-attested purchase attestations on public
  reviews, reputation aggregates, and signed order receipts published to
  the participants' own homeservers ("credible exit": operator death leaves
  verifiable history).
- **E2EE messaging & DMs** — listing chat and general direct messages over
  Paykit Encrypted Links (Noise XX), vendored browser WASM binding; no
  operator can read bodies.
- **Watchlist with private cross-device sync** (`/priv` homeserver
  documents), saved searches, device-honest alerts.
- **Honesty architecture** — commerce modes fail closed
  (`unavailable` by default), simulated states are labeled, redactions are
  structural, and the client/service state machines are contract-locked in
  CI.

**Notable fixes made along the way:** a DM handshake bug where a persisted
mid-handshake snapshot bound to a rotated counterparty key polled `pending`
forever (`5b0174a4`), plus assorted deployed-rails defects surfaced by the
live wallet-leg proof.

Start with [`docs/ecommerce/status.md`](docs/ecommerce/status.md) (what is
real vs simulated, per mode, with a reproducible proof ledger) and ADRs
0019–0029 in [`docs/adr/`](docs/adr/).

## Prerequisites

- Node.js (see [.nvmrc](./.nvmrc) for the recommended version)

## Getting Started

First, install the dependencies and run the development server:

```bash
HUSKY=0 npm ci
npm run dev
```

`HUSKY=0` keeps husky's `prepare` script from setting a repository-local
`core.hooksPath`, which would replace your global git hooks.

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.
The marketplace is off unless you opt in; [`docs/ecommerce/RUNNING.md`](docs/ecommerce/RUNNING.md)
runs it against the local sandbox service.

## Environment Variables

Copy the example environment file and adjust the values as needed:

```bash
cp .env.example .env
```

See [docs/environment.md](./docs/environment.md) for more details.

## Common Workflows

- Check architecture and coding conventions: [docs/README.md](./docs/README.md)
- Run local code review workflow (Cursor): use `/review` (defined in `.cursor/skills/code-review/SKILL.md`)
- Follow commit message format: [docs/commit-message.md](./docs/commit-message.md)

## License

This project is licensed under the MIT License.  
See the [LICENSE](./LICENSE) file for more details.
