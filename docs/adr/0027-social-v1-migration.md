# ADR 0027: Marketplace Record Layer on Social/v1

## Status

Proposed — 2026-08-27 (designs the migration now; executes when the social/v1
break ships)

## Context

The 2026-08-26 spec-compatibility review ("Marketplace on Social v1") measured
the marketplace record layer against the planned social/v1 spec and found:

- **Zero additions to social/v1 are required.** The spec's composition law
  (section 6), the reversed-domain app-namespace convention, and the
  `PostEnvelope<K>` generic are the designed extension seam, and they cover
  everything the marketplace publishes.
- **Seven of twelve marketplace objects dissolve into v1 primitives**; five
  stay app-owned, which is where the composition law puts them.
- **Five rules the specs fork adopted are forbidden by v1** and must be
  reversed on the marketplace side: closed-world JSON, mixed timestamp units,
  a fourth id scheme, tombstone records, and revision counters.

Two of those five were reversed immediately (2026-08-27) because they required
no wire break: records are now open-world (ADR 0020 as amended, specs release
`0.6.2-marketplace.9`), and the never-written tombstone record type was
deleted. The remaining three — timestamps, id schemes, revision counters —
reshape live records and paths, so they execute here, at the v1 break, in one
epoch-class change instead of two.

The review also confirmed what does NOT move: the transaction service's
authority model (ADR 0019, "correctly concluded"), and the marketplace Nexus
fork — under any placement the social indexer skips marketplace records, so
listing streams, auction terms, ending-soon sort, reputation aggregates, and
drop projections remain our indexing work.

## Decision

When the social/v1 break ships, the marketplace record layer migrates in one
release, as follows.

### Object placement (the review's ledger, adopted)

Dissolve into v1 primitives:

- **Listing** — a `PostEnvelope<K>` post at
  `pub/app.marketplace/v1/posts/{id}/{editId}.json`. Inherits TimestampId
  minting, immutable versioned edits, parent/embed/attachments/lock, the
  `extra` preservation map, root/ownership rules, and the 512 KiB cap.
  Commerce fields ride the content envelope the way Article and Collection do.
- **Drop** — a `PostEnvelope` specialization. The record remains seller
  intent; the transaction service stays the clock and the only counter.
- **Review response** — a plain reply (`post.parent`). The
  "author equals review subject" rule becomes a client/index check.
- **Listing media** — content-addressed files at
  `{root}/social/v1/files/{hash}.{ext}`. The hash is the id, mime is derived
  by the homeserver, size is Content-Length, alt/name are per-reference.
  Width, height, and durationMs stay in the listing envelope (no v1 home —
  upstream item R9).
- **Watchlist** — one private bookmark per watched target at
  `priv/social/v1/bookmarks/{base64url(canonical_target)}.json`. Watch is one
  PUT, unwatch is one DELETE, reading the list is one LIST with zero GETs,
  dedup is address-level, and cross-device merge is the homeserver's file set.
  The entire LWW CRDT (single document, items + tombstones, ms merge keys,
  500-entry caps, revision counter — `watchlist.rs` in the specs fork and
  roughly 400–900 LOC of client merge/sync/test code) is deleted, not ported.
- **Digital lock** — `post.lock`, which v1 carries on every post; presence
  means locked. The lock file natively carries per-resource type, size, and
  hash, which is what `criterionId`/`resourceHash` restated.
- **Tag/collection reach** — free: `tag.uri` is universal tier and
  `collection.items[]` takes any pubky resource, so tagging listings and
  curating shop windows need nothing from us.

Stay app-owned (no v1 equivalent exists and none should):

- **Shop** — `pub/app.marketplace/v1/shop.json` (per ADR 0025 as amended).
  Not in the profile's `ext`: that would anchor commerce under the social
  grant, the exact coupling ADR 0025 exists to break.
- **Order receipt** — `priv/app.marketplace/v1/receipts/{id}`. App-owned by
  the folder-ownership test; v1 contributes the `/priv/` threat model.
- **Money and Location** — app primitives.
- **Attestations** (purchase, receipt, edition JWS) — opaque strings in app
  fields. Their claim structs remain closed-world: an attestation is a signed
  artifact at a verification boundary, not an evolving record.
- **Catalog discovery** — structurally closed on v1 feeds (the Feed id is a
  pinned six-segment string over social vocabulary). Discovery stays on the
  marketplace Nexus.

### The one deliberate non-envelope object

**Review** stays a HashId-addressed app record:
`HashId({listing_uri}:{subject_pubky}:{role})` at
`pub/app.marketplace/v1/reviews/{hash_id}`. `PostEnvelope` pins TimestampId
and therefore cannot express uniqueness by address; the HashId makes
"one review per buyer per listing per role" a property of the address (write
twice, overwrite) instead of an index dedup job. The shape is v1's own Tag id
idiom (`{canonical_uri}:{label}`), so this is spec-idiomatic, not an
invention.

### The three remaining rule reversals (executed here)

- **Timestamps** — i64 microseconds everywhere a timestamp survives; under
  the envelope, document-level `createdAt`/`updatedAt` disappear entirely
  (the TimestampId is `createdAt`, the newest `editId` is `updatedAt`). The
  watchlist's integer-millisecond merge keys die with the CRDT.
- **Id scheme** — listing and drop ids become TimestampIds via the envelope
  (bytewise LIST order equals chronological order). The fork's
  `validate_entity_id` (1–128 chars of `[A-Za-z0-9_-]`) disappears from
  public records. The transaction service's internal order/receipt UUIDs are
  unaffected: they are private and never enumerated in order.
- **Revision counters** — the base-record sextet (`schemaVersion`,
  `recordType`, `ownerPubky`, `revision`, `createdAt`, `updatedAt`) dissolves
  into the path, the kind, and the id. Immutable versions are also strictly
  better for auctions: a bid can reference a pinned `editId` instead of
  trusting a mutable record.

### Transaction service impact (bounded)

- `listing.sync` convergence (`sync_listing.rs`, `homeserver.rs`) re-keys
  from the record `revision` counter to the newest `editId` (TimestampIds are
  ordered, so "record advanced" remains one comparison). The equal-revision
  shipping-heal rule carries over as an equal-editId derived-terms heal.
- The drop-record parser's strictness is REAFFIRMED as a service-side signing
  boundary: enforcement terms the seller did not sign are refused at the
  service, even though the record schema itself is open-world. Same split as
  ADR 0020's terms-vs-availability rule, one level down.
- Nothing else changes: the service authenticates actors and fetches
  seller-signed documents by URI; the URIs change, the authority model does
  not.

### Grants and sessions

Commerce gets its own grant (`/pub/app.marketplace/:rw`,
`/priv/app.marketplace/:rw`) per ADR 0025. Existing users re-approve once, on
their first commerce write after the migration release, with honest copy:
commerce now has its own permission; the social permission no longer covers
it. The watchlist's new home under `priv/social/v1/bookmarks/` rides the
social grant — watching is a social-tier act on a universal-tier target.

### Data migration

One-time re-publish of live records to the new paths (staging first), with
ADR 0025's mechanics folded in: a dual-publish window, identity continuity
for review hash-ids and receipt ids, attestation reissue on request for
records whose canonical URIs changed (v1 attestations remain valid for v1
URIs — they attest history), and the marketplace Nexus ingesting both
prefixes during the window, preferring the newer record. The Nexus watcher
additionally needs v1's `legacy_v0` classification to treat
`pub/pubky.app/marketplace/…` as skip-not-error (upstream item R5) — that
data exists on the staging homeserver today.

## Blocking dependencies (upstream)

- The v1 break shipping at all, with `PostEnvelope<K>` and the bookmark tier
  as specified.
- R1: the `app.locks` vs `locks.app` spelling settling — the specs fork's
  `validate_locks_uri` and three client constants hardcode `/pub/locks.app/`
  today and will follow the ruling.
- R2: `ext` key ownership pinned to the writing app's namespace segment
  (affects whether shop surface data may ever be mirrored into the profile).

## Consequences

### Positive ✅

- One epoch-class break instead of two; every reversal the spec demands lands
  in the same release users already have to absorb.
- Roughly 400–900 LOC of CRDT machinery and the whole base-record boilerplate
  disappear; three hand-rolled conventions (ids, timestamps, versioning)
  become the substrate's.
- Commerce grants decouple from social grants (ADR 0025's goal), and bids can
  pin immutable listing versions.

### Negative ❌

- A coordinated release across specs fork, client, transaction service, and
  marketplace Nexus, plus a data migration and a one-time re-grant prompt.
- Until the break ships, two conventions coexist in documentation; this ADR
  is the single place that says which wins and when.

### Neutral ⚠️

- The marketplace Nexus epic continues regardless (the review: the
  "no addition" claim "is true of the specs plan and false of nexus").

## Alternatives Considered

### Migrate now, ahead of the v1 break

**Pros**: cruft gone sooner. **Cons**: v1 primitives do not exist on any
deployed surface yet, so we would invent stand-ins, reshape live records
today, and likely reshape them again when v1's details settle. **Why not
chosen**: paying for two breaks to avoid waiting for one.

### Keep the fork conventions and bridge at read time forever

**Pros**: no migration. **Cons**: permanently maintains five conventions the
substrate forbids, and the coupling costs ADR 0025 documents keep growing.
**Why not chosen**: the review shows the seam was designed for us; refusing
it is pure debt.

## Related Decisions

- [ADR 0019: Marketplace Transaction Authority](0019-marketplace-transaction-authority.md) — unchanged
- [ADR 0020: Marketplace Public Records](0020-marketplace-public-records.md) — amended 2026-08-27
- [ADR 0021: Marketplace Record Namespace Under pubky.app](0021-marketplace-record-namespace.md)
- [ADR 0025: Marketplace v2 Namespace — app.marketplace](0025-marketplace-v2-namespace.md) — amended 2026-08-27
- [ADR 0026: Marketplace Drops](0026-marketplace-drops.md)
