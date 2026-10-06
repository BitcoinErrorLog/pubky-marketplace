# ADR 0028: The Indexer Contract — Query Vocabulary, Not Records

## Status

Accepted — 2026-08-28 (records the design settled in the 2026-08-27 indexer
topography discussion; no code moves)

## Context

The 2026-08-26 spec-compatibility review confirmed the marketplace record
layer needs zero additions to the planned social/v1 spec, and simultaneously
that catalog discovery is structurally closed on social feeds: the v1 Feed id
is a pinned six-segment string over social vocabulary, so price, category,
and ending-soon will never ride v1 feeds. That left an open question with a
blurry surface: our deployed marketplace Nexus is one fork doing two jobs
(social indexing untouched, plus `/v0/stream/listings`, `/v0/stream/drops`,
shop reputation), and "Nexus will index listings too / we will tag stores —
so where is the line?" was a fair challenge.

## Decision

**The line between indexers is the query vocabulary an indexer answers, not
which records it touches.**

- **The social indexer serves social-vocabulary queries over opaque
  anchors.** Tags, replies, reviews-as-annotations, bookmarks, follows, and
  collections are social objects; the URI they point at — a listing, a shop,
  a crawled external resource's hash (e.g. BTC Maps) — is an anchor the
  indexer never opens. Tagging a store lives in the social index, and that is
  not a contradiction: the tag is the indexed object, the store is opaque.
- **The marketplace indexer serves commerce-vocabulary queries, which require
  opening app-owned records.** Price ranges, currency, category taxonomy,
  auction `ends_at`, stock display, seller-declared location, reputation
  aggregates, drop projections. These parse record content and sometimes join
  commerce semantics; they are this contract's job and no one else's.
- **The fence (upstream item R4):** the social contract never grows a
  commerce query parameter. When someone asks for a `price` filter on a
  social feed, the answer is pre-written: out of scope by the composition
  law, not queued behind it.
- **Topography is ops, not design.** "Another indexing engine" means another
  _contract_. Whether the commerce module runs as a feature-flagged module of
  nexusd, a second deployment of the same codebase (today's shape), or its
  own binary is an operational choice that can change without touching this
  decision. What may not change is contract mixing.

### The rule, generalized

A future domain that only needs tags/replies/bookmarks anchored on its
resources rides the social index for free — crawled data included, because
the anchor is a hash and hashes are opaque. The moment a domain needs
content-aware queries (geo radius, price, inventory), it brings its own
indexer module for its own namespace. One fixed social indexer, N app
indexers, anchors as the seam — the same composition law the specs use,
applied one layer down.

### Current deployment, restated under this contract

The dedicated marketplace-indexing Nexus (Railway, watching the staging
homeserver) is BOTH indexers sharing one codebase and one deployment. The
social endpoints are upstream-untouched; the marketplace endpoints are a
separate route namespace. This is compliant: the contracts are separate even
though the process is one. At the social/v1 break (ADR 0027), marketplace
records move to `app.marketplace/…` and the social indexer skips them as
Foreign by design; the marketplace indexer follows the new paths, and the
official social Nexus needs v1's `legacy_v0` classification to treat
`pub/pubky.app/marketplace/…` as skip-not-error (upstream item R5).

## Consequences

### Positive ✅

- "Where is the line" has a mechanical answer that survives new domains,
  crawled data, and the v1 break, and it never requires arguing topography.
- The social indexer's contract is protected from scope creep by a
  pre-written refusal; the marketplace indexer can evolve freely inside its
  own namespace.
- Restructuring (module vs binary vs deployment) becomes reversible ops work
  with no design meaning.

### Negative ❌

- Two contracts means every consumer must state which it reads — already
  true today via `PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL` vs
  `PUBKY_RUNTIME_NEXUS_URL`.
- Some queries that FEEL like one question ("popular listings near me") are
  two contracts joined client-side, and stay that way.

### Neutral ⚠️

- The marketplace Nexus epic continues regardless (the review: the
  "no addition" claim "is true of the specs plan and false of nexus").

## Alternatives Considered

### One indexer, one merged contract

**Pros**: one query surface. **Cons**: the social feed id cannot carry
commerce vocabulary without an epoch-class re-id of every feed, and every
added domain would bloat the shared contract forever. **Why not chosen**:
structurally closed upstream, and scope creep by construction.

### Split by record ownership (social indexer never touches non-social URIs)

**Pros**: simple to state. **Cons**: breaks tagging stores, reviewing
listings, bookmarking crawled resources — the anchor-opacity property is
exactly what makes social composition work. **Why not chosen**: it draws the
line through the wrong layer.

## Related Decisions

- [ADR 0027: Marketplace Record Layer on Social/v1](0027-social-v1-migration.md)
- [ADR 0025: Marketplace v2 Namespace — app.marketplace](0025-marketplace-v2-namespace.md)
- `docs/spec-feedback/social-v1-feedback.md` — items R4 and R5
