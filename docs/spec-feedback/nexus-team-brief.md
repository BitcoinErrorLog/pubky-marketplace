# Marketplace indexer and specs fork, as run on staging

**To:** maintainers of `pubky/pubky-nexus` and `pubky/pubky-app-specs`
**From:** the Pubky Marketplace integration (forks under `BitcoinErrorLog`)
**Date:** 2026-09-01
**Status:** technical brief. Not a PR, not a demand list. Every SHA
below was checked with `git cat-file -e <sha>^{commit}` in the checkout
named for that row, except `09075e83` (current `pubky/pubky-nexus`
`main`). That SHA is not in the BitcoinErrorLog clone (no `pubky`
remote); it was confirmed by `GET /repos/pubky/pubky-nexus/commits/main`
returning `09075e83c4c922feede6c93556a67d42595b115c` (“fix: revert pubky
to v0.9.3 (#1048)”, 2026-09-01). Fork branch tips were confirmed
publicly reachable via the GitHub API:
`feat/marketplace-indexing` → `6fc2dbe3ac8cb81d137cd2fa7dd46b066b5a1adf`;
`marketplace-4-build` → `fada0e5bd3da6916548450dbd0d22d9e271e041e`
(“docs: update fork readme to marketplace-4-build and .9”, pushed
2026-09-01). GitHub compare `pubky:main...feat/marketplace-indexing`
reports **19 ahead / 111 behind**. Specs `marketplace-4-build` compare
against `pubky:main` reports **13 ahead / 4 behind**. A fresh clone of
`BitcoinErrorLog/pubky-nexus` at `feat/marketplace-indexing` and of
`BitcoinErrorLog/pubky-app-specs` at `marketplace-4-build` fetches every
cited fork SHA.

Checkouts used for `cat-file`:

| Row | Checkout | Branch / pin |
| --- | --- | --- |
| Nexus fork | local clone of `BitcoinErrorLog/pubky-nexus` | `feat/marketplace-indexing` @ `6fc2dbe3`, tracking `origin` (`https://github.com/BitcoinErrorLog/pubky-nexus`). GitHub parent `pubky/pubky-nexus`. Local `origin/main` = `0f8f46ba` (merge-base with the marketplace branch). |
| Specs fork | local clone of `BitcoinErrorLog/pubky-app-specs` | `marketplace-4-build` @ `fada0e5`, tracking `origin` (`https://github.com/BitcoinErrorLog/pubky-app-specs`). Merge-base with `pubky/pubky-app-specs` `main` = `5caa8302` (upstream 0.6.2). |
| Client / ADRs | local clone of `BitcoinErrorLog/pubky-app` | `origin/marketplace/pr25-ux` @ `64cb7aee`. Public copies of the ADRs and the R1–R9 note are on that branch. |

This document assumes you have already seen the marketplace roadmap. It
does not re-argue design. It is a verified inventory of what the fork
actually runs, where it diverges from current `pubky/pubky-nexus` `main`
and `pubky/pubky-app-specs` `main`, and a short list of questions. The
indexer-boundary question is surfaced, not answered.

The deployed indexer watches the **official staging homeserver**. It is
not the official staging or production Nexus. Nothing here has had an
independent security review. Where a cause is unproven, it is labeled
that way.

---

## 1. What we run

A staging marketplace (client at `https://shop.pubky.app`) discovers
catalog data through a dedicated Nexus. Social reads stay on the
official Nexus; commerce reads go to this instance.

| Piece | Git | Branch / pin | What it is |
| --- | --- | --- | --- |
| Marketplace Nexus (deployed) | `BitcoinErrorLog/pubky-nexus` (fork of `pubky/pubky-nexus`) | branch `feat/marketplace-indexing` HEAD `6fc2dbe3ac8cb81d137cd2fa7dd46b066b5a1adf` = origin tip. Ahead of merge-base `0f8f46ba661846925372a38a4324dd8e3162da8e` with this clone’s `origin/main`. GitHub compare vs `pubky:main` (`09075e83`) is **19 ahead / 111 behind**. | One process serving upstream social routes plus a separate marketplace route namespace. Specs pin in workspace `Cargo.toml:23`: `pubky-app-specs` git rev `7d79e5e8fc61fd75a503268cdedba75038c9b4d4` (`0.6.2-marketplace.8`, closed-world). `pubky` crate pin is `"0.7.0"`. |
| Specs fork | `BitcoinErrorLog/pubky-app-specs` | `marketplace-4-build` HEAD `fada0e5bd3da6916548450dbd0d22d9e271e041e` (`0.6.2-marketplace.9`, open-world). **13** ahead / **4** behind `pubky:main`. Merge-base `5caa8302f0e875d32089ead9e70ccad681f5079b` = upstream “chore: bump version to 0.6.2 (#148)”. | Marketplace record kinds, JOSE attestation typs, `/priv` watchlist and receipts. The client vendors `.9`; the deployed indexer still parses `.8`. |
| Client | `BitcoinErrorLog/pubky-app` | `marketplace/pr25-ux` | Commerce index client. Env `PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL`, falling back to `PUBKY_RUNTIME_NEXUS_URL`. |

Deployed instance:

- Railway project `pubky-marketplace-nexus`, service `nexusd`, image
  built from this repo (`railway.toml` → `Dockerfile.railway`). Deploys
  via `railway up --service nexusd --detach` (runbook
  `docs/railway-deploy.md` on the branch). No git SHA is recorded on
  the service.
- Public base (already published in our repos):
  `https://nexusd-production-7108.up.railway.app`
- Live `GET /v0/info` on 2026-09-01 returned
  `"commit_hash":""`, `"version":"0.4.1"` (matches
  `nexus-webapi/Cargo.toml`), `"last_index_snapshot":"2026-09-01 08:52:12"`.
- Deployed revision is **inferred, not proven**, as `6fc2dbe3`: GitHub
  `pushed_at` `2026-08-28T11:33:31Z` sits two seconds after the commit
  timestamp `2026-08-28T11:33:29Z` (`6fc2dbe3` subject “perf:
  bounded-concurrency review backfill scan with progress logs”). The
  empty `commit_hash` on `/v0/info` is why this stays inferred.
- Review backfill `ReviewBackfill1787905961` was run on that instance:
  1,948 indexed users, ~4.5 minutes, **zero** pre-cursor reviews on
  staging (the staging homeserver held no review records; recorded in
  the client’s `docs/ecommerce/status.md` on `marketplace/pr25-ux`).

Config roles (names only; no values):

| Name | Role |
| --- | --- |
| `PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL` | Client: commerce index base. Falls back to `PUBKY_RUNTIME_NEXUS_URL` when unset (`src/libs/runtime-config/runtime-config.ts:204-205`). |
| `PUBKY_RUNTIME_NEXUS_URL` | Client: official/social Nexus. |
| `NEXUS_HOMESERVER` | Deployed nexusd: homeserver the watcher polls. |
| `NEXUS_NEO4J_URI`, `NEXUS_NEO4J_PASSWORD`, `NEXUS_REDIS_URL` | Deployed nexusd: graph and index. |

The specs pin mismatch is load-bearing: the deployed indexer still
parses marketplace records **closed-world** (`.8`). The client vendors
open-world `.9`. Additive unknown members that the client will accept
are still rejected at ingest on the running indexer.

---

## 2. The 19 commits on `feat/marketplace-indexing`

Subjects below are verbatim from `git log 0f8f46ba..6fc2dbe3`.
Classification is ours: **marketplace** = product index for this app;
**ops** = this Railway deployment; **docs/ops** = Railway runbook and
observed-rate notes; **maybe-upstream** = looks like a general
watcher/ingest fix, unproven on current `pubky:main`. Overflow class
notes are footnoted.

| SHA | Subject (verbatim) | Class |
| --- | --- | --- |
| `ce500c257f65` | feat: index marketplace shops and listings | marketplace |
| `38aaf20683a8` | chore: ignore macOS AppleDouble files | ops |
| `ec81a91422bc` | chore: fix the macOS ignore patterns | ops |
| `481001edba3b` | feat: index auction terms and end-time sorting for listings | marketplace |
| `cf3c80db4797` | feat: backfill auction terms for listings indexed before the term fields | marketplace |
| `085c8e12ab14` | chore: add Railway deploy config for nexusd | ops |
| `f8c585d400f1` | fix: use a valid moderation key in the Railway entrypoint | ops |
| `a0b2ce14c07b` | docs: add Railway deployment runbook for the marketplace Nexus | docs/ops |
| `9a53e51934a7` | docs: record observed replay rate for the Railway Nexus | docs/ops |
| `308b985e74cc` | feat: aggregate community tags on marketplace listings and shops | marketplace |
| `d559f8f635ed` | feat: index marketplace reviews with attestation verification and reputation aggregates | marketplace |
| `07793aa37ed2` | fix: use bare z32 form when ingesting referenced homeservers | maybe-upstream (see §3.2) |
| `0054b7ca07a3` | fix: bump specs to accept entity-id listing path ids | marketplace (pin bump to specs `.5`) |
| `422dc490a58d` | fix: 30s deadline on event polls so dead homeservers cannot starve the watcher | same class as PR #1043; not a clean cherry-pick (see §3.1) |
| `055cb099c54c` | feat: index marketplace drops with stream, buckets, and per-drop projection | marketplace |
| `f543291b048c` | feat: country filter on the listings stream | marketplace |
| `fa628052580c` | fix: country-only listing queries route to the graph, not the index shortcut | our filter bug (see §4) |
| `a224695c0c54` | feat: one-shot review backfill migration (pre-cursor reviews) | marketplace |
| `6fc2dbe3ac8c` | perf: bounded-concurrency review backfill scan with progress logs | marketplace (JoinSet 16-wide)¹ |

¹ Pattern-consistent with `nexus-common/src/db/reindex.rs`, which already used `JoinSet` at merge-base `0f8f46ba`; that reindex JoinSet is unbounded.

Three marketplace commits (`ce500c25`, `308b985e`, `d559f8f6`) also
modify shared `nexus-common` code social paths use; see §5.

Compare URL:
`https://github.com/BitcoinErrorLog/pubky-nexus/compare/pubky:main...feat/marketplace-indexing`

---

## 3. Two items that look like yours, and are not clean patches

### 3.1 Dead-homeserver poll starvation — `422dc490` and open PR #1043

`422dc490` wraps the events `GET` in
`nexus-watcher/src/service/processor.rs` with
`tokio::time::timeout(..., POLL_TIMEOUT_SECS)` where
`POLL_TIMEOUT_SECS = 30`. The **commit message** is only the subject
plus a Co-authored-by trailer. The 70-minute observation is a **source
comment** introduced by that commit, not the commit body (quoted with
line wrapping normalized):

> Observed in production on 2026-08-21: the watcher went silent for 70
> minutes on unreachable homeservers.

Open upstream PR [#1043](https://github.com/pubky/pubky-nexus/pull/1043)
(author ok300, still open when this was checked) adds a configurable
**global** Pubky HTTP request timeout
(`[stack.net].pubky_http_request_timeout`, default 30 seconds) on the
shared client builder. That is the same *class* of hang (a request that
never returns) and the same default duration. It is not the same patch:
#1043 times out every Pubky HTTP call; `422dc490` times out one poll.

On current `pubky:main` (`09075e83`) the watcher layout has moved.
`processor.rs` is gone. `poll_events` now lives in
`nexus-watcher/src/service/indexer/homeserver.rs` and has **no**
`tokio::time::timeout` around the events GET. Upstream
`nexus-watcher/src/service/constants.rs` still has
`PROCESSING_TIMEOUT_SECS = 3_600` and no `POLL_TIMEOUT_SECS`. So:

- `422dc490` is not a clean cherry-pick onto current main.
- Whether #1043, once landed, covers the poll-starvation case we boxed
  is a question for you (ask 1). It is **unproven** here.

### 3.2 Bare z32 on referenced homeservers — `07793aa3`

`07793aa3` changes `nexus-common/src/models/homeserver.rs` to convert
via `.z32()` because, on the pinned pubky **0.7.0**, `PublicKey`’s
`Display` includes a `pubky` prefix and `PubkyId` rejects it (not 52
chars). That silently broke homeserver ingestion for users on unknown
homeservers.

Current `pubky:main` `homeserver.rs` is a different file (cursor
monotonicity, blacklist, `persist_if_unknown`). Whether the Display /
`PubkyId` issue still exists against current pubky (main just reverted
to v0.9.3 in #1048) is **unproven**. We are not asking you to take this
commit as-is.

---

## 4. Country-filter bug (ours; pattern note only)

`f543291b` added `ListingStreamFilters.country` and a Cypher clause, and
did **not** add `country` to `has_graph_only_filters()`. At that
revision the predicate was:

```
self.category.is_some()
    || self.condition.is_some()
    || self.sale_format.is_some()
    || self.state.is_some()
    || self.min_price.is_some()
    || self.max_price.is_some()
    || self.currency.is_some()
```

`collect_listing_keys` therefore served the unfiltered Redis timeline
when the only extra query param was `country`. `fa628052` is the
one-line fix (`|| self.country.is_some()`, currently
`nexus-common/src/models/marketplace/stream.rs:87-96`) plus a test that
`GET /v0/stream/listings?country=HR` returns `[]` rather than the
timeline (`nexus-webapi/tests/marketplace/mod.rs`).

This is user-visible on the marketplace catalog: the client sends
`country` (`src/core/controllers/commerce/commerce.ts:145`, application
layer `src/core/application/commerce/commerce.ts:1374`).

Upstream has no `country` field. This is not an upstream bug. The
shape we copied is a denylist (`has_graph_only_filters`). Upstream post
streams whitelist known-safe combinations instead
(`can_use_index`, `nexus-common/src/models/post/stream.rs:172-201`). If
you ever grow denylist shortcuts on a new stream, that whitelist is the
safer pattern. Not a request to change post streams.

---

## 5. Indexer boundary (surfaced, not resolved)

Accepted ADR 0028 (2026-08-28), public on
`origin/marketplace/pr25-ux`:

https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr25-ux/docs/adr/0028-indexer-contract.md

Core line, verbatim:

> The line between indexers is the query vocabulary an indexer answers,
> not which records it touches.

Reading that ADR as we wrote it, not as a proposal for you to adopt:

- Social vocabulary over opaque anchors (tagging a store: the tag is
  indexed, the store is opaque).
- Marketplace = commerce vocabulary that opens app-owned records
  (price, category, `ends_at`, reputation, drops).
- Fence: the social contract never grows a commerce query parameter.
- Topography is ops: one process today (this Railway instance runs both
  contracts; marketplace endpoints are a separate route namespace).
  Social *routes* are untouched (no social endpoint changes path,
  parameters, or response shape), but the marketplace work modifies
  shared crate internals social paths run through:
  `TagCollection::del_from_graph` signature change (four-tuple →
  `DeletedTagTarget` struct,
  `nexus-common/src/models/tag/traits/collection.rs`), the `delete_tag`
  Cypher gains `CASE WHEN target:Listing/:Shop` projections
  (`nexus-common/src/db/graph/queries/del.rs`), `setup_ddl` now swallows
  Neo4j `AlreadyExists` and continues
  (`nexus-common/src/db/graph/setup.rs`), and `UserDetails`/`UserView`
  lose their `Default` derive.
- At social/v1, marketplace records move to `app.marketplace/…`, and
  official Nexus would need `legacy_v0` to skip
  `pub/pubky.app/marketplace/…` rather than hard-error; that is R5 in
  §8. It is independent of where the commerce query contract lives
  long-term.

What this indexer answers today (route list,
`nexus-webapi/src/routes/v0/endpoints.rs:31-60`):

- shops: `/v0/shop/{seller_id}` plus tags, taggers, reviews, reputation
- listings: `/v0/listing/{seller_id}/{listing_id}` plus tags, taggers,
  reviews; stream `/v0/stream/listings`
- reviews, with attestation verification at ingest, and reputation
  aggregates
- drops: `/v0/drop/{owner_id}/{drop_id}` and stream `/v0/stream/drops`

Receipts and the watchlist are `/priv/` and are deliberately **not**
indexer-visible. Specs `order_receipt.rs:91-96` says `/priv/` is not
wired into the URI parser used by watchers. `PubkyAppObject` on the
fork enumerates Shop, Listing, Drop, MarketplaceReview, ReviewResponse
— not watchlist, not receipts.

Where that commerce query contract should live long-term is ask 2. This
brief does not pick.

---

## 6. Specs fork inventory

`BitcoinErrorLog/pubky-app-specs` `marketplace-4-build` @ `fada0e5`.
Thirteen commits over `5caa8302`, subjects verbatim:

| SHA | Subject |
| --- | --- |
| `eb35f93c976c` | feat: add marketplace shop, listing, and review objects |
| `035656e62ee2` | docs: document marketplace shop, listing, and review objects |
| `e73b7292ce15` | chore: version 0.6.2-marketplace.1 fork build |
| `fd3028c031c3` | feat: accept marketplace listing URIs as collection items (0.6.2-marketplace.2) |
| `c1f8bbb3f9c1` | feat: purchase attestation format and review response record (0.6.2-marketplace.3) |
| `3cc4c175c772` | chore: bump npm package version to 0.6.2-marketplace.3 |
| `32f5aca33dbc` | feat: listing attributes container and bounded taxonomy version (0.6.2-marketplace.4) |
| `31afc396845d` | fix: accept entity-id listing path ids (0.6.2-marketplace.5) |
| `9fd3eaf975c7` | feat: private watchlist record under /priv (0.6.2-marketplace.6) |
| `33d1c84aad41` | test: watchlist wasm smoke tests and npm version bump |
| `7d79e5e8fc61` | feat: portable receipts, shop transactionService, drops (0.6.2-marketplace.7-.8) |
| `b8e0c2555e26` | feat: open-world record parsing (social/v1 alignment), release .9 |
| `fada0e5bd3da` | docs: update fork readme to marketplace-4-build and .9 |

Compare: `https://github.com/BitcoinErrorLog/pubky-app-specs/compare/pubky:main...marketplace-4-build`

`rg -i paykit` over this fork is empty. Portable receipts and purchase
attestations are service-signed JWS, not Paykit receipts.

---

## 7. Open-world records, closed attestations, honest leftovers

Open-world commit `b8e0c255` removed `#[serde(deny_unknown_fields)]`
from **18** record/struct sites (verified in the diff: drop.rs 1,
listing.rs 6, marketplace.rs `Money`+`Location` 2,
marketplace_review.rs 2, order_receipt.rs 2, review_response.rs 1,
shop.rs 1, watchlist.rs 3). It **kept** closed-world on the **6** JWS
attestation header/claim structs (three files: purchase, order-receipt,
drop-edition). That split is deliberate: records evolve; a verification
boundary does not.

Client mirror on `marketplace/pr25-ux`:
`src/libs/commerce/marketplace-records.ts` `.strict()` →
`.passthrough()` at 24 sites; attestation schemas stay strict. Vendored
tarball `0.6.2-marketplace.9`.

New JOSE `typ` values, registered nowhere on `pubky/pubky-app-specs`
`main` (`git grep` over `upstream/main` is empty):

| typ | Specs const | Service const |
| --- | --- | --- |
| `pubky-purchase-attestation+v1` (`.3`) | `marketplace_attestation.rs:42` | `attestor.rs:48` |
| `pubky-order-receipt+v1` (`.7–.8`) | `order_receipt_attestation.rs:52` | `attestor.rs:55` |
| `pubky-drop-edition+v1` (`.7–.8`) | `drop_edition_attestation.rs:46` | `attestor.rs:59` |

All three are compact EdDSA JWS with closed-world claims. The
finalized Paykit brief names two of the three (`pubky-order-receipt+v1`,
`pubky-drop-edition+v1`); this brief’s three-way mapping is the precise
one. The transaction service also issues `pubky-seller-stats+v1`
(`attestor.rs:50`), which the specs fork does **not** define and which
Nexus does not index.

Honest leftovers, not hidden:

- Marketplace enums still have no `#[serde(other)]` (R3 only partly
  applied). Listing still closes `PubkyAppListingState`,
  `PubkyAppListingCondition`, `PubkyAppFulfillmentMethod`,
  `PubkyAppListingMediaKind`, `PubkyAppListingSale`,
  `PubkyAppShippingOption`, `PubkyAppListingAttributeValue`.
- `validate_locks_uri` hardcodes `/pub/locks.app/`
  (`src/models/marketplace.rs:227-235`). That is R1 in shipped third-party
  code.
- GitHub **Releases** and **git tags** on the fork stop at
  `v0.6.2-marketplace.4`. `.5`–`.9` exist as commits on
  `marketplace-4-build` only (`GET /repos/BitcoinErrorLog/pubky-app-specs/git/refs/tags`
  lists `.1`–`.4`; the local clone’s `git tag -l 'v0.6.2-marketplace.*'`
  matches).
- A local clone of `BitcoinErrorLog/pubky-app-specs` is still checked
  out on `feat/marketplace-objects-0.6.x` at `32f5aca3` (`.4`). That is
  our leftover.

---

## 8. Social/v1 feedback (R1–R9) — not filed upstream

Do not duplicate the note. It is on the pushed branch:

https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr25-ux/docs/spec-feedback/social-v1-feedback.md

One line each:

- **R1.** The RFC recommends `app.locks` and still says `locks.app` in
  two places; our `validate_locks_uri` hardcodes `/pub/locks.app/`.
- **R2.** `ext` key ownership is unspecified; pin it to the writing
  app’s namespace segment.
- **R3.** App-namespace advice is not yet an adopter checklist (epoch,
  never deny unknown fields, preserve unknown members, `#[serde(other)]`
  on enums, byte cap, integer microsecond timestamps).
- **R4.** Commerce is out of scope on the composition fence, not queued
  behind it.
- **R5.** `legacy_v0` must skip live `pub/pubky.app/marketplace/…`
  paths rather than hard-error.
- **R6.** App records must not carry state a service enforces (stock,
  payment).
- **R7.** Publish a scope vocabulary, not only pubky-app’s default
  grant.
- **R8.** Split `PostEnvelope`’s reference/preservation job from the
  versioned-directory storage choice (crate API, not wire).
- **R9.** Attachment dimensions have a second consumer (catalog grid);
  record it for v1.1.

Filing status: **not filed** on `pubky/pubky-app-specs`. Issue and PR
search for `"social-v1-feedback"`, `"validate_locks_uri"`, `"legacy_v0"`,
and `"pub/pubky.app/marketplace"` returned zero items. RFC
[#142](https://github.com/pubky/pubky-app-specs/pull/142) (author
SHAcollision) has three issue comments; none of them is this list. A
PR search for `"app.locks"` hits #142 because the RFC itself uses that
spelling — that is the spec, not our filing. Inline review comments
were not fully retrieved (API timeout); nothing we did retrieve is this
feedback. The active v1 path-grammar PR is open upstream
[#161](https://github.com/pubky/pubky-app-specs/pull/161) (“feat: the
social/v1 path epoch, canonicalizers and the closed URI grammar”,
SHAcollision, opened 2026-08-31). Its diff carries neither `app.locks` /
`locks.app` nor `legacy_v0`.

---

## 9. ADR context (one paragraph each)

All three are on `origin/marketplace/pr25-ux`. Public URLs below.
0028 is in §5.

**ADR 0020** (accepted 2026-08-19, amended 2026-08-27)
https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr25-ux/docs/adr/0020-marketplace-public-records.md
— Owner homeserver is canonical for authored catalog JSON. The index is
a discovery projection, never content authority. Records are open-world
(unknown members tolerated on parse and preserved on rewrite);
attestations stay closed at the verification boundary. Deletion is
absence; there is no tombstone record type. A listing carries
seller-authored terms, not stock, winner, or payment state.

**ADR 0025** (proposed 2026-08-23, amended 2026-08-27)
https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr25-ux/docs/adr/0025-marketplace-v2-namespace.md
— At the v1 break, marketplace records move to `app.marketplace` so
commerce grants uncouple from the social grant. Not `marketplace.app`:
a directory ending in `.app` becomes a macOS bundle when a tree is
exported (the same argument the RFC uses against `locks.app`). Dual-publish
window during migration; identity continuity for ids; existing users
re-grant once.

**ADR 0027** (proposed 2026-08-27)
https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr25-ux/docs/adr/0027-social-v1-migration.md
— Listings and drops become `PostEnvelope` posts under
`pub/app.marketplace/v1/posts/…`. Shop stays app-owned. Receipts stay
`/priv`. The watchlist CRDT is deleted in favor of social private
bookmarks. Catalog discovery stays off v1 feeds (the Feed id is a
pinned six-segment string over social vocabulary). Official Nexus still
needs the R5 `legacy_v0` skip for today’s `pub/pubky.app/marketplace/…`
paths.

---

## 10. Consumption surface (what breaks the client)

Resolver: `getMarketplaceNexusUrl()` at
`src/libs/runtime-config/runtime-config.ts:204-205` —
`PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL`, else `PUBKY_RUNTIME_NEXUS_URL`.

Calls:

- `GET /v0/stream/listings` with `state=active`, `limit` 30 (Nexus
  clamps `limit` with `.min(30)` in
  `nexus-webapi/src/routes/v0/stream/listings.rs:27`; client constant
  `NEXUS_LISTINGS_PER_PAGE = 30`), optional `sale_format`, `condition`,
  `sorting=ends_at`, `country`
- listing details `/v0/listing/{seller_id}/{listing_id}`
- listing and shop tags
- shop reviews and reputation
- `GET /v0/stream/drops` (hook-local fetcher today,
  `src/hooks/useMarketplaceDrops/drops-stream.ts`; 404 returns null,
  which the hook renders as empty (`drops-stream.ts:58`))

Shape assumptions on the listing stream (snake_case Rust field names as
serialized): `country_code` and `price_amount_minor` always present and
non-null; `auction_*` term keys always present and null-legal,
reputation snippet `{avg, count, verified_count}`. Missing reputation
is honest absence — the client renders “New seller”, never `0.0`
(`commerce.schema.ts:53-60`). `sorting=ends_at` excludes fixed-price
listings (`listings.rs` OpenAPI text and
`ListingStreamSorting::EndsAt`). Auction rows indexed before term
fields may be all-null until the auction-terms backfill; the client
schema allows that combination.

Sandbox mode never reads Nexus
(`CommerceApplication.fetchCatalogListings` returns immediately when
`getCommerceAdapterMode() === 'sandbox'`).

---

## 11. What we are not asking for

What you can ignore: Railway ops files (`railway.toml`,
`Dockerfile.railway`, the Railway entrypoint, `docs/railway-deploy.md`).
The review-backfill JoinSet(16) and its progress logs. `/priv` receipts
and the watchlist — they are not indexer-visible and are not a Nexus
API. Fiat, Paykit, Bitkit, Locks, and `pubky-noise`. The client Zod
`.passthrough()` mirror of open-world parsing. The parked
`feat/marketplace-objects-0.6.x` checkout at `.4`. The country-filter
bug and the marketplace route namespace, unless ask 2 lands as “this
contract lives in official Nexus.”

Do not ignore the shared-crate delta in §5
(`TagCollection::del_from_graph`, `delete_tag` Cypher, `setup_ddl`
`AlreadyExists`, `UserDetails`/`UserView` `Default`). Those internals
sit on social paths.

`rg -i paykit` over the specs fork is empty. That is not a Paykit
question.

---

## 12. Asks

Each item is a real question. “Not now” is a valid answer.

1. **Poll deadline vs PR #1043.** Does PR #1043 cover the
   dead-homeserver poll starvation we boxed independently (`422dc490`),
   or is a poll-specific deadline still wanted after it lands?

2. **Commerce query contract.** Long-term, where does the commerce
   query contract belong: an official Nexus module, a separate
   deployment/contract, or third-party-owned?

3. **Open-world vs attestations.** Is “records open-world before v1,
   attestations stay closed” the stance you want third-party app
   records to take now?

4. **JOSE typs.** Do you want `pubky-purchase-attestation+v1`,
   `pubky-order-receipt+v1`, and `pubky-drop-edition+v1` registered in
   `pubky-app-specs`, or are they permanently app-owned?

5. **Before the v1 break.** Do you want any of the marketplace record
   kinds in the official crate before the break, or only the
   `legacy_v0` skip (R5)?

6. **R1 spelling.** Will v1 pin `app.locks` or `locks.app`? We follow
   the ruling.

7. **R1–R9 delivery.** How do you want the R1–R9 feedback delivered:
   comments on RFC #142, comments on PR #161, a separate issue, or is
   the URL in §8 enough?
