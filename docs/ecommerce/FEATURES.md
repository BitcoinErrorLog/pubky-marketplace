# Marketplace Feature Inventory

Every feature in the Pubky marketplace, organized hierarchically. Honesty
labels follow [`status.md`](status.md) (the authoritative real-vs-simulated
ledger with live-proof records): anything unlabeled is built, tested, and
deployed to the staging stack; **experiment-grade** and **sandbox-only**
mean exactly that.

## 1. Catalog and discovery

- **Browse**
  - Catalog grid and list layouts, served by the deployed marketplace Nexus
    index with a local-first Dexie cache
  - Auction browsing with seller terms on cards (starting bid, buy-now, end
    date) and lazy live-bid reads once a card scrolls into view
  - Hot-marketplace modules and a followed-sellers shelf
- **Search and filters**
  - Text search; filters for category, price, condition, sale format, and
    location
  - Attribute facet chips derived from the taxonomy (size, brand, color, …)
  - Saved searches in a compact popover with per-search NEW badges
- **Category taxonomy (v2)**
  - Hierarchical category tree with category-scoped attribute sets, brand
    lists, size charts, and controlled vocabularies
  - Attributes render on catalog cards and drive browse facets
- **SEO and sharing**
  - Open Graph / Twitter preview images and descriptions for listings,
    shops, profiles, and posts (Satori-rendered, serverless-traced fonts)

## 2. Selling

- **Sell studio**
  - Up to 8 photos: sanitized, metadata-stripped, BLAKE3 content-hashed
  - Title, description, condition (with optional details), adult-content flag
  - Category picker with per-category attribute fields
  - Drafts autosave locally; legacy-draft migration
  - Namespaced as **Seller studio**; mobile sheet **My marketplace**
  - Duplicate listing creates a new local draft (photos not copied; auctions
    copied as fixed price)
- **Pricing**
  - USD or Bitcoin pricing; BIP-177 display everywhere (₿ symbol, whole base
    units, never "sats")
  - Indicative fiat/bitcoin conversion display (labeled as indicative)
- **Variants and inventory**
  - Up to three option dimensions per variant with independent SKU,
    quantity, and price override
- **Package and shipping**
  - Unit-aware package dimensions with an inline in/oz ⇄ cm/g toggle
    (loss-free conversion; stored canonically in millimeters and grams;
    device-wide measurement preference also settable in settings)
  - Shipping label, flat cost, delivery estimate range, reusable presets
  - Return policy (window or no-returns)
- **Listing management**
  - Edit, unlist/relist (fixed-price), delete, copy public link
  - Owner panel self-heals transaction-service registration (re-runs on
    session connect)
  - Listing thumbnails in seller lists
- **Drop Studio**
  - Compose FCFS drops over existing listings at `/marketplace/sell/drops`:
    schedule, total and per-buyer caps, stock-display policy
    (exact / bands / hidden)
  - Two-truth publish status — record on the seller's homeserver and
    registered with the transaction service, shown separately (the same
    honesty split listings have); operator-facing status is Draft /
    Scheduled / Live / Ended, with sync detail under Technical details
  - Mission control during the window (visibility-bounded polling),
    typed-CANCEL kill switch, post-end release of remaining stock back to
    open sale
- **Shop profile**
  - Shop record on the seller's homeserver: name, bio, avatar and banner
    uploads, vacation mode
  - Shared `ShopProfileCard` on the public shop page and My Shop live preview
  - Icon-only seller controls have aria-labels, covered by an a11y test
  - Public identity: shop name with pubky fallback; attestation-derived
    rating and review count; `New seller · no reviews yet`; `Shipping:
calculated at checkout`. Seller-stated tenure is not shown.
  - `/marketplace/shop` is a real route (was a 404)
  - Optional `transactionService` authority declaration in the record
    (specs `0.6.2-marketplace.7`); the editor deliberately does not offer
    the field yet (see the multi-operator guard under Buying)
- **Digital delivery**
  - Locks-guarded content entitlements delivered on completed payment

## 3. Buying and transactions

All transactional invariants are enforced by the durable, event-sourced
transaction service (PostgreSQL, exactly-one-winner concurrency proofs).

- **Cart and checkout**
  - Multi-seller cart with per-asset subtotals; cart entry points (toast
    action, header cart pill with count)
  - Three-step checkout; `Approve in Pubky Ring` up front when there is no
    marketplace session; Place order disabled until approval and a valid
    form; purchase-guarantee opt-in default unchecked
  - Checkout with delivery address book (save, reuse, last-used ordering)
    plus an orientation line; the address travels only inside the checkout
    command
  - Variant snapshots ride order lines (packing slip and order rows)
  - Unregistered listings self-heal at read and checkout time via
    service-side `listing.sync` (the service fetches the canonical
    seller-signed record from the homeserver)
- **Offers**
  - Make, counter, accept, reject — revision-guarded
  - Offer dialog shows asking price and % vs asking (hidden on currency
    mismatch)
- **Auctions**
  - Bids with reserve prices, minimum increments, anti-sniping extensions;
    scheduled close workers; `auction_won` / `auction_ended` notifications
  - Bid dialog copy is `Set your maximum bid`
- **Drops (FCFS, ADR 0026 phase D1)** — durable modes only; live-proven
  two-buyer race on the deployed staging stack (2026-08-23)
  - Drops calendar (`/marketplace/drops`, fed by the Nexus drops stream
    with estimate-labeled buckets) and drop pages with server-corrected
    countdowns; `live` and `sold out` render only from the service's
    public projection
  - Pre-launch **ready check** (session, delivery address, per-buyer
    allowance staged before T-0); the claim is the normal checkout with
    the service's refusal copy verbatim — no fake queues, ever
  - Server-side stock redaction honoring the seller's display policy;
    total and per-buyer caps constraint-enforced with 100-way concurrency
    proofs; seller kill switch and post-end listing release
  - Gapless edition numbers assigned inside exactly-once payment
    confirmation; edition badges on paid drop orders
- **Multi-operator guard**
  - When a shop record declares a `transactionService` whose origin
    differs from the configured service, the client surfaces the declared
    authority and refuses to send that seller's transactional commands to
    a service the seller never declared; per-shop routing itself is
    designed, not built (see [`multi-operator.md`](multi-operator.md))
- **Orders**
  - Full lifecycle: awaiting payment → paid → shipped (carrier + tracking,
    soft carrier vocabulary) → delivered → completed
  - Tabs: To ship / In transit / Completed / All; `You bought` / `You sold`;
    seller `Needs attention`
  - Cancellation request/approve with inventory release
  - Packing slip dialog: optional local-only pasted address in component
    state, cleared on close/print/route, Sentry-masked, with a truthful
    print caveat (never a service read path; see [`shipping.md`](shipping.md))
  - Accessible 5-star review input
- **Post-purchase**
  - Returns and peer refund evidence
  - Per-order reviews (see Trust)

## 4. Payments

Bitcoin and PayPal are the offered rails. The same lock and proof-bundle
flow settles over either of them, and both are live-proven on the deployed
stack (see the proof ledger). Card payments are paused in the shop.

- **Bitcoin (Locks + Paykit)**
  - Regtest rails deployed (bitcoind, Fulcrum, Lock Server, Paykit Server)
  - Proof bundle → invoice → on-chain payment → worker confirmation →
    receipt → access credential
  - Real-wallet proof: Bitkit iOS seller watch-only claim AND buyer
    swipe-to-pay confirmed on-chain
  - Payment status UI with fail-closed `locks-paykit` adapter mode
- **Card payments**
  - Paused in the shop. Buyers are not offered a card rail, and sellers do
    not see card setup. Stored card configuration stays on the service.
- **PayPal**
  - Orders v2 with capture-on-approval; postback-verified webhooks treated
    as hints with authoritative order pulls; same settlement machine
  - Buyer-side processor choice at checkout when both are configured;
    binding is permanent per purchase
- **Verification labeling**
  - Payment status card badges keep the two truth origins visibly
    distinct: **Processor-verified** (truth pulled from PayPal) vs
    **Seller-attested** (the seller's own confirmation, labeled as
    exactly that)
- **Sessions and auth**
  - Marketplace transaction session from a Pubky AuthToken (single-use,
    verified with `pubky-common`), bearer token with 30-day TTL, persisted
    in `localStorage` across tabs and restarts
  - Session store cleared from a single `onSessionEnded` signal
    (service → controller) covering every transport path
  - Seller payment settings **How you get paid**: cards PayPal → Bitcoin
    with truthful pills (PayPal is `Email saved`, never
    Connected; Bitcoin Connected only with Lock Server + Paykit claim);
    protocol detail under Technical details; payloads unchanged

## 5. Trust and reputation

- **Portable order receipts and drop editions (credible exit)**
  - Every paid order's receipt is issued as a deterministic signed JWS
    (`pubky-order-receipt+v1`, Ed25519 attestor key) and published to each
    participant's own homeserver under the enforced-private `/priv` tree
  - The offline verification recipe re-runs before every publication;
    deleting the operator leaves both parties a verifiable purchase
    history
  - Paid drop orders additionally embed a `pubky-drop-edition+v1`
    attestation ("edition N of M") — a second JWS, so existing receipt
    verifiers are untouched
- **Attested reviews**
  - Per-order reviews attested by the transaction service (JWS, Ed25519,
    salted order refs); 24-hour edit window with `edited_late` flags
  - Portable by construction: review records live on the reviewer's
    homeserver, anchored to Pubky identities, indexable by anyone
- **Verification at ingest**
  - Nexus cryptographically verifies attestations when indexing; unverified
    reviews index labeled, never dropped
- **Reputation surfaces**
  - Aggregates (count, verified count, average, histogram, per-attestor
    breakdown) served by Nexus and embedded in the listing stream
  - Stars on catalog cards, rating headers on shops and listings, paged
    review sections with three-state labeling, explicit new-seller state
  - Seller responses: one revisable response per review, a pure homeserver
    record threaded by Nexus
  - "My reviews" panel with attestation and publication status

## 6. Social

- **Community tags** on listings (Nexus-indexed, separate from seller
  keywords)
- **Collections**: save listings into post collections; collection pages
  hydrate listing cards through the commerce read path
- **Commerce activity** renamed **Transaction history** in the UI
- **Shop follows** and followed-seller discovery
- **Watchlist / favorites**
  - Watch toggles on cards and listing pages (bell for auctions, heart for
    fixed price)
  - Promo dismissal persisted; compact mobile promo
  - **Cross-device private sync** over homeserver-enforced `/priv` storage:
    local-first, per-item last-write-wins with tombstones, coalescing push,
    pull on sign-in; capability-gated with an honest re-approval notice on
    legacy sessions
- **Notifications**
  - Marketplace events (offers, bids, outbid, auction won/ended, orders,
    returns) in the app's notification UI, with §8-permitted amounts
    rendered in BIP-177 / fiat
  - Filters All / Marketplace / Social (type-exhaustive)
  - Dashboard Action-needed strip; KPI chip strip on mobile

## 7. Messaging

- **End-to-end encrypted messaging** (durable modes): Noise XX over Paykit
  Encrypted Links via the vendored WASM binding — marketplace listing
  conversations and general direct messages on one link per counterparty.
  **Experiment grade**; live browser e2e 16/16 across engines
- Receiver markers with messaging-only capability advertisement
- Session persistence across reloads and tabs (secret-free metadata;
  the credential is a browser-held HTTP-only cookie)
- Unencrypted key-snapshot storage is disclosed in the UI (backup-key
  encryption is a deliberate open decision)
- **Sandbox mode**: plaintext transport, labeled as operator-readable at
  every point of use

## 8. Identity and sessions

- **Single Ring grant**: one sign-in approval covers the app's public
  storage, the Paykit messaging tree, and the private watchlist scope —
  immune to the homeserver's one-cookie-per-user session replacement
- Sessions persist across tabs and browser restarts, bounded by service
  TTLs; account-scoped restore validation; sign-out clears everything

## 9. Infrastructure and operations

- **Transaction service** (Rust): event-sourced PostgreSQL with outbox,
  registration drain, auction close, reservation expiry, and drop
  open/close workers; server-time drop gating with gapless edition
  assignment; health, readiness, metrics; Docker + Railway deploy
- **Marketplace Nexus** (fork): listing/shop/review/tag/drop indexing
  (`/v0/stream/drops` + per-drop projections), reputation aggregation,
  auction-terms and review backfill migrations, replay runbooks, poll
  deadlines against dead homeservers
- **Specs fork** (`pubky-app-specs`): marketplace objects (listing, shop,
  review, response, attestation, private watchlist, portable order
  receipt with edition attestation, drop record), entity-ID validation,
  WASM/npm packaging
- **Fiat verifier gateway** (Rust): PayPal bridging to Locks. Card
  verification code stays in the service and is not offered in the shop.
  Fail-closed configuration, live-mode guards
- **Payment rails**: per-service Dockerfiles and Railway entrypoints for
  bitcoind, Fulcrum, Lock Server, Paykit Server; verification driver
- **Testing discipline**: unit suites, visual regression (timezone-frozen
  harness), contract drift tests against the canonical service contract,
  live staging proofs — all recorded with reproduction commands in the
  [proof ledger](status.md)

## Explicitly not included (honest boundaries)

- Real funds anywhere: mainnet is gated on the independent security review
- Platform-mediated fiat collection and payouts (a processor collecting
  buyer funds and then disbursing to
  sellers): deliberately absent, not pending. Sellers are paid DIRECTLY
  into their own PayPal account (see Payments — seller-configured
  rails). Card payments are paused and are not offered, so no payout leg
  exists to build. Connect-style onboarding would only become relevant if
  the marketplace ever took custody or platform fees, which it does not.
- Messaging backup-key encryption (open product decision, disclosed in UI)

## In progress (Sprint 3, not shipped)

- Sectioned listing studio
- Delivery auto-complete timer and return/refund surfacing in the service
- Guest-indexable catalog
- Multi-seller cart grouping
