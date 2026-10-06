# ADR 0020: Marketplace Public Records and Transaction Projections

## Status

Accepted — 2026-08-19. Amended — 2026-08-27 (social/v1 alignment): two rules
below are REVERSED, marked inline. Records are now open-world (unknown members
are tolerated on parse and preserved on rewrite), and deletion publishes no
tombstone — absence is the tombstone. Rationale: the planned social/v1 spec
forbids closed-world records because they make additive growth impossible, and
rejects durable tombstones because the substrate cannot enforce them against
the owner's own writes while public ones leak deletion metadata forever; the
receipt JWS keeps a buyer's history verifiable after a listing disappears. The
full v1 migration is designed in [ADR 0027](0027-social-v1-migration.md).

> **Current state (2026-08-23)**: the marketplace objects (shop, listing, review — later joined by purchase attestations, review responses, the private watchlist, portable order receipts with edition attestations, and drop records) are registered and validated in the `pubky-app-specs` fork (`BitcoinErrorLog/pubky-app-specs`, branches `feat/marketplace-objects-0.6.x` and then `marketplace-4-build`, releases `v0.6.2-marketplace.1`–`.8`), which this client vendors and the marketplace Nexus parses for indexing. Two path details changed from the v1 sketch below when the specs landed: listing/review paths carry no `.json` suffix (only the `shop.json` singleton keeps one), and listing/review IDs follow the specs' timestamp/hash ID rules. Namespace choice is recorded in [ADR 0021](0021-marketplace-record-namespace.md).

## Context

Marketplace shops and listings should retain Pubky's owner-controlled public-data model. A seller must be able to publish and move their catalog with their Pubky identity rather than handing canonical listing content to a marketplace database.

At the same time:

- `pubky-app-specs` currently has no listing, inventory, order, offer, auction, or review record;
- Nexus has no marketplace index or search endpoints;
- a mutable public listing cannot be trusted for current stock, auction, order, or payment state;
- stale public/indexed data must not permit a purchase;
- public records cannot contain addresses, private messages/offers, evidence, payment correlations, or bearer credentials;
- adding marketplace tables to Dexie currently triggers the repository's destructive database-version reset behavior;
- marketplace media and records must follow the existing `/pub/pubky.app/:rw` grant without widening the Pubky App session.

The protocol needs an explicit owner/public boundary and a safe composition with ADR 0019's Marketplace Transaction Service.

## Decision

### 1. Publish versioned marketplace JSON under the existing app namespace

Version 1 paths:

```text
/pub/pubky.app/marketplace/v1/shop.json
/pub/pubky.app/marketplace/v1/listings/{listing_id}.json
/pub/pubky.app/marketplace/v1/media/{media_id}
/pub/pubky.app/marketplace/v1/reviews/{review_id}.json
/pub/pubky.app/marketplace/v1/collections/{collection_id}.json
```

The owner homeserver remains canonical for authored public content. The protocol is an app-owned versioned JSON contract until a reviewed upstream commerce specification exists.

Rules:

- ~~every object is closed-world JSON and rejects unknown fields~~ REVERSED
  2026-08-27: every object is OPEN-WORLD JSON — unknown members are tolerated
  on parse and preserved on rewrite (the JWS attestation claim structs stay
  strict as a verification-boundary exception);
- every object carries `schema_version`, owner Pubky, stable path-safe ID, revision, `created_at`, and `updated_at`;
- IDs are random and never derived from title, price, email, address, or another sensitive field;
- object identity is `{owner_pubky}:{object_id}`;
- revision starts at 1 and increases exactly by 1 for each owner-authored replacement;
- timestamps are RFC 3339, but owner timestamps never decide transaction deadlines;
- ~~deletion publishes a minimal tombstone before best-effort later cleanup~~
  REVERSED 2026-08-27: deletion removes the record; ABSENCE is the tombstone
  (no tombstone record type exists — the write path never shipped one);
- readers validate owner/path agreement before using content;
- unsupported schema versions render an honest unsupported state and cannot transact.

### 2. Keep authored terms separate from authoritative availability

A listing record contains seller-authored terms:

- shop/listing identity;
- sale format (`fixed_price` or `auction`);
- fulfillment type (`physical`, `digital`, `pickup`, or supported combinations);
- title, description, category/version, condition, and item specifics;
- variants/SKUs, seller price, quantity offered, media, package facts, and location granularity;
- shipping and return policy inputs;
- auction configuration;
- digital Locks policy/resource reference when applicable;
- disclosure, age/restriction, and policy metadata;
- owner lifecycle intent (`draft` is never public, then `active`, `paused`, `ended`, or `removed`).

The record does not authoritatively state:

- available/reserved/sold quantity;
- accepted offer;
- current auction leader/price/result;
- cart reservation;
- payable total/tax/shipping quote;
- paid/refunded/guaranteed/payout state;
- order, delivery, return, or dispute state.

Those fields come from a signed/authenticated role-appropriate projection returned by the Marketplace Transaction Service.

The browser composes:

```text
validated public listing terms
  + transaction-service availability/auction projection
  + local display preferences/cache metadata
  = rendered listing view
```

If the transaction projection is unavailable or does not match the listing content hash/revision, browsing may continue with a stale warning, but buy, offer acceptance, and bidding fail closed.

### 3. Register public records with the transaction authority

Publishing an active listing is a retryable two-authority workflow:

1. Validate and save the draft in account-scoped Dexie.
2. Upload validated marketplace media.
3. Write the closed listing JSON to the seller's homeserver.
4. Send `listing.register` with listing Pubky URL, expected service revision, and idempotency key.
5. Transaction Service independently fetches the public document, validates owner/path/schema, computes the canonical content hash, applies policy, and registers inventory/auction terms.
6. Client stores the returned transaction projection and marks publication synchronized.

Failure behavior:

- media failure leaves a draft and resumable upload state;
- homeserver failure leaves a local draft/pending-publication state;
- service registration failure leaves a public but non-purchasable listing and a visible retryable outbox item;
- changed replay under the same command ID conflicts;
- seller edit uses the prior public revision and service projection revision;
- service rejects transaction-critical edits that conflict with reservations, bids, or completed orders;
- stale Nexus or Dexie content never bypasses service validation.

The workflow does not require one distributed transaction. It explicitly exposes partial progress and converges through idempotent registration.

### 4. Preserve immutable purchased terms

Checkout stores:

- exact canonical listing/variant snapshot;
- public record URL, owner, revision, and content hash;
- selected quantity and seller-authored policy versions;
- authoritative tax/shipping/discount/guarantee inputs and results;
- accepted offer or auction-result reference when applicable.

Later seller edits or deletion cannot alter that order snapshot. Authorized participants and staff retain access to the snapshot even if the public listing is removed.

### 5. Publish reviews with eligibility attestations

The Transaction Service decides whether a completed order/item/role may review and issues a single-use, short-lived review eligibility attestation bound to:

- reviewer Pubky;
- subject seller/listing;
- order item opaque reference;
- allowed review role;
- expiry and nonce.

The reviewer publishes public review content under their own homeserver path. The service independently reads and validates it, consumes eligibility once, and indexes an aggregate projection. Public review records contain no buyer address, private order ID, payment fact, message, dispute evidence, or staff note.

Moderation never rewrites the reviewer's record. It applies an auditable visibility decision in the service projection. Seller replies follow their own signed public record/attestation contract.

### 6. Use marketplace-owned media paths and services

Marketplace media uses the existing Pubky session capability but a separate namespace and validation policy. Listing code may reuse pure file validators and low-level homeserver/local services; it must not make an unapproved Application-to-Application call.

Media requirements:

- image/video count, byte, dimension, duration, and MIME/signature limits;
- generated random media ID and content hash;
- metadata stripping where supported;
- explicit alt text/caption and display order in the listing JSON;
- owner/path validation on read;
- orphan cleanup after a retention window;
- no active HTML/SVG/script execution;
- upload retry and abort;
- immutable purchased snapshot references.

CDN/Nexus transformation is optional for the first prototype. Direct public-storage reads need loading, failure, and unsupported-media states.

### 7. Define local records as caches/drafts, not transaction authority

Dexie stores:

- shop/listing/review/collection public-record cache;
- local drafts and media-upload state;
- transaction projections with server revision/freshness;
- safe outbox commands for public publication and social actions;
- private role-scoped projections only under the active Pubky account.

It does not decide stock, winner, payment, refund, or ledger state.

The first schema addition requires:

- a database version bump;
- explicit acceptance of the current wipe-and-recreate behavior;
- migration resync of owner public records and service projections;
- preservation/export of unsynchronized drafts before any future destructive reset;
- account-switch and quota-eviction tests.

### 8. Provide search without changing source ownership

The prototype Transaction Service may maintain a PostgreSQL search projection by independently fetching seller-signed public records. Search results identify source URL, owner, revision, content hash, and projection freshness.

Search indexing does not make the service canonical for listing content. A future Nexus marketplace index may replace this projection after its contract covers:

- full-text/category/filter/sort queries;
- tombstones and moderation visibility;
- freshness and stable pagination;
- owner/path/schema validation;
- transaction projection join or safe availability revalidation.

Every purchase/bid still revalidates current terms and authority state.

## Consequences

### Positive ✅

- Sellers retain canonical ownership of public catalog and review content.
- Private and financial data has an explicit non-public boundary.
- The transaction service can enforce current stock and auction/order invariants without becoming the listing author.
- Public records remain portable and independently readable.
- Partial publish failures are visible and retryable instead of hidden behind a false atomicity claim.
- Search can evolve from a prototype projection to Nexus without changing authored record ownership.

### Negative ❌

- Listing publication and editing require reconciliation between homeserver and transaction service.
- Public listing content can be visible before it is purchasable.
- App-owned v1 records require a future migration if an upstream commerce spec differs.
- The initial Dexie schema change resets existing local caches under current database behavior.
- Direct homeserver media reads may be slower and less transformed than CDN-backed post media.

### Neutral ⚠️

- The service stores content hashes and read projections while the homeserver remains canonical.
- Moderation and transaction availability can hide a still-public owner record from marketplace discovery.
- Review visibility is a service decision; the signed public review can still exist outside the marketplace UI.

## Alternatives Considered

### Encode listings as ordinary posts

Posts provide media, tags, feeds, and social reach, but do not carry variants, inventory, shipping, returns, auctions, or immutable commerce terms. A preview post may link to a listing, but it is not the listing contract.

### Extend `pubky-app-specs` before prototyping

An upstream spec is desirable, but no current commerce contract exists. Blocking the full prototype on an unapproved external spec would not remove the need for transaction projections. Versioned app-owned records provide an explicit migration boundary.

### Store canonical listings only in PostgreSQL

This simplifies indexing and transaction joins but abandons Pubky owner-controlled public data and credible exit.

### Trust listing quantity and auction state from the seller record

A seller-controlled mutable file cannot arbitrate competing buyers or bind an immutable result. It remains an intent/input, not authority.

### Publish order records on buyer and seller homeservers

This duplicates private data across independent authorities without an atomic consistency or encryption design and risks public leakage. The prototype keeps private transaction data in role-scoped service projections.

## Implementation Notes

Initial code locations:

- Zod wire/domain contracts: `src/libs/commerce/`
- pure normalization/validation: `src/core/pipes/commerce/`
- local models/services: `src/core/models/commerce/`, `src/core/services/local/commerce/`
- homeserver IO: `src/core/services/homeserver/commerce/`
- transaction HTTP adapter: `src/core/services/marketplace/`
- applications/controllers split by listing, discovery, negotiation, checkout, order, and trust;
- UI actions wrapped in hooks; components do not call controllers.

The listing schema and state transition contracts must exist with tests before adding routes. Template-level marketplace surfaces require VRT coverage from their first stable delivery slice.

## Related Decisions

- [ADR 0001: Local-First Writes](0001-local-first-writes.md)
- [ADR 0007: Dexie Version Normalization](0007-dexie-version-normalization.md)
- [ADR 0009: Application Cross-Domain Orchestration](0009-application-cross-domain-orchestration.md)
- [ADR 0019: Marketplace Transaction Authority](0019-marketplace-transaction-authority.md)
- [Marketplace upstream integration](../ecommerce/upstream-integration.md)
- [Marketplace threat model](../ecommerce/threat-model.md)

## Superseded In Part (2026-09-05)

References to marketplace dispute adjudication, marketplace report moderation, staff visibility decisions, and tax quotes are superseded by the peer-to-peer marketplace decision: the client keeps public seller records, participant order records, reviews, receipts, returns/refunds, and peer evidence, but no operator trade-adjudication surface.
