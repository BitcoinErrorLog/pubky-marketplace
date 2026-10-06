# Marketplace PR Split

> **Historical record — the plan below executed and then grew past itself.** All nine slices landed, and the stack continued far beyond them (branches `marketplace/pr1-docs` through `marketplace/pr44-watch-sync` and counting; `marketplace/pr25-ux` is the integration/deploy line, live at <https://shop.pubky.app>). The specs blocker in the last section was resolved by taking option 2 — the marketplace objects were backported onto the 0.6.x line and published from the `feat/marketplace-objects-0.6.x` branch of `BitcoinErrorLog/pubky-app-specs` (releases `v0.6.2-marketplace.1` … `v0.6.2-marketplace.4`), which the client consumes; the path/ID reconciliation table below was carried out in that slice. [`status.md`](status.md) is the current source of truth; nothing below is a live plan.

Delivery sequence for landing the marketplace work as reviewable, independently revertible slices. Source branch: `marketplace/main` (rebased from the prototype branch). Each slice targets < ~2.5k reviewable lines, passes the standing gates before review, and gets a Bugbot review before push.

| #    | Slice                               | Contents                                                                                                                                                                                                                                    | Depends on             | Status       |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------ |
| PR-1 | Docs + ADRs                         | `docs/ecommerce/*`, ADRs 0019–0023 (0019/0020 amended with current-state notes), `.gitignore` hygiene                                                                                                                                       | —                      | branch ready |
| PR-2 | Config, routes, Dexie               | `routes.ts` marketplace routes, `config/commerce.ts`, runtime-config additions (adapter mode default `unavailable`), `franky.ts` `commerce_*` tables, DB version 2→3 (ADR 0023), `.env.example` + CI workflow version updates, release note | PR-1                   | pending      |
| PR-3 | Specs consumption + core layers     | commerce models, pipes rebuilt on published `pubky-app-specs` builders, local + homeserver services, `CommerceApplication`, `CommerceController`, commerce store; orphaned `register` sync-job enqueue removed                              | PR-2, specs release    | pending      |
| PR-4 | Catalog UI                          | Marketplace template, filters, listing cards, listing detail, shop page, skeletons; VRT baselines (all states) regenerated post-rebase; nav gated on adapter mode                                                                           | PR-3                   | pending      |
| PR-5 | Sell / listing studio               | Listing form, variants, media picker, draft autosave, publish to homeserver; VRT for studio states                                                                                                                                          | PR-3                   | pending      |
| PR-6 | Favorites + shop follows            | Local-first favorites/follows; VRT                                                                                                                                                                                                          | PR-4                   | pending      |
| PR-7 | Service client + sandbox (dev-only) | Marketplace gateway service, sandbox adapter quarantined behind dev settings, sandbox catalog seed as dev action                                                                                                                            | PR-3                   | pending      |
| PR-8 | Real service integration            | Client wiring to the Rust Marketplace Transaction Service (ADR 0022): real auth, unified state-machine contract validation, transactional UI (offers, bids, cart, checkout, orders, dashboard) + VRT                                        | PR-7, Rust service     | pending      |
| PR-9 | Payments                            | Locks JS/WASM SDK vendoring, seller setup, buyer proof-bundle flow, truthful status UI, `locks-paykit` adapter mode; VRT for payment states                                                                                                 | PR-8, Locks/Paykit env | pending      |

Parallel tracks outside this repo:

- `pubky-app-specs`: marketplace object specs (shop, listing, review) — prerequisite for PR-3.
- Rust Marketplace Transaction Service (new repo) — prerequisite for PR-8.
- `pubky-nexus`: marketplace record indexing — prerequisite for public-discovery launch, not for PRs 1–9.

Rules: no slice ships stubs or dead code; nav baselines for existing surfaces stay byte-identical until launch; every UI slice carries its own VRT baselines in the same PR.

## Known reconciliation required when specs land

The marketplace objects now implemented in `pubky-app-specs` follow the canonical `pubky.app` conventions, which differ from the prototype paths currently shipped in the client. Both differences must be resolved in the specs-consumption slice, and both are breaking for any record written before that slice:

| Concern      | Client today (prototype)            | Specs (canonical)                                 | Resolution                                                                                                                                 |
| ------------ | ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Listing path | `marketplace/v1/listings/{id}.json` | `marketplace/v1/listings/{id}`                    | Drop the `.json` suffix. Existing `pubky.app` objects (`posts/{id}`, `tags/{id}`) carry no suffix; only the shop singleton is `shop.json`. |
| Review path  | `marketplace/v1/reviews/{id}.json`  | `marketplace/v1/reviews/{id}`                     | Same.                                                                                                                                      |
| Listing ID   | free-form (`boots_01`)              | Timestamp ID (13-char Crockford Base32)           | Generate timestamp IDs for new listings, matching posts. Update fixtures.                                                                  |
| Review ID    | free-form                           | Hash ID of `{listing_uri}:{subject_pubky}:{role}` | Derive the ID from content, matching tags/bookmarks.                                                                                       |

Consequences to plan for:

- The client's hand-rolled URI builders in `src/core/pipes/commerce/commerce.normalizer.ts` are replaced by the specs package builders, so these changes arrive together.
- Commerce fixtures and any test asserting a `.json` listing/review URL change with them.
- Nexus indexing must target the suffix-free paths.

No records exist in production yet (commerce ships disabled), so no migration of live data is required — but any sandbox or staging records written before this slice become unreadable and should be re-seeded.

## Blocker: the specs-consumption slice requires a specs major upgrade

The marketplace objects are implemented on `pubky-app-specs` **0.8.0** (current upstream). This app pins **0.6.2**. Consuming the marketplace builders therefore means upgrading the specs dependency by two minor versions, and that upgrade is breaking in one specific place.

Measured, not assumed — pointing the app at a locally built 0.8.0 package produces exactly six TypeScript errors, all from one API change:

| What changed                                                                            | Effect                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `createFeed` moved from seven positional arguments to a single `CreateFeedInput` object | Mechanical; 6 call sites in `feed.normalizer.ts`, `feed/feed.ts`, and their tests                            |
| `CreateFeedInput` adds a **required** `icon: string`                                    | Not mechanical. This app has no feed/collection icon concept anywhere — no model field, no UI, no Nexus type |

Nothing else in the app breaks on 0.8.0, which makes this a small but genuinely product-scoped blocker rather than a refactor.

Two ways forward, and the choice belongs to whoever owns collections:

1. **Schedule the 0.8.0 upgrade** as its own PR: add feed icons (model, UI, and a decision about what icon existing collections get), then land marketplace specs consumption on top. Cleanest long-term, since the app has to reach 0.8.0 eventually.
2. **Backport the marketplace objects onto the 0.6.x line** and publish that, keeping the marketplace slice independent of the feed-icon work. Unblocks commerce sooner at the cost of maintaining a second specs line.

Until one is chosen, the client keeps its own URI builders and the paths above stay as-is. Supplying a placeholder icon is not an option — it would write a fabricated value into users' homeserver feed records.

The marketplace specs work itself is complete and verified on 0.8.0: 352 crate tests pass (32 marketplace-specific), clippy and fmt are clean, the wasm bindings compile, and the generated npm package's own suite passes (35 tests). It lives on `BitcoinErrorLog/pubky-app-specs` branch `feat/marketplace-objects`.
