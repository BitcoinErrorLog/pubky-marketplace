# ADR 0025: Marketplace v2 Namespace — app.marketplace

## Status

Proposed — 2026-08-23. Amended — 2026-08-27: the namespace is
**`app.marketplace`** (reversed-domain), not `marketplace.app`, and the
primary trigger is now the social/v1 break. The planned social/v1 spec
(section 6) mandates reversed-domain app namespaces and explicitly rejects
`*.app` directory names: a directory ending in `.app` is treated as an
application bundle by macOS the moment a tree is exported. The v1 break also
supersedes triggers as the natural moment to execute this move — see
[ADR 0027](0027-social-v1-migration.md) for the full migration design this
ADR's mechanics fold into. (Commits v2 to a sibling namespace; changes
nothing in v1.)

## Context

[ADR 0021](0021-marketplace-record-namespace.md) placed marketplace v1 records under `/pub/pubky.app/marketplace/v1/…` so the existing `/pub/pubky.app/:rw` session grant could publish them with no second approval. It accepted the cost explicitly: any app holding the social grant can write commerce records, and vice versa — the scopes cannot be separated. ADR 0021 named migration to a sibling marketplace namespace as "the expected path" at the v2 boundary, but committed to nothing.

Since then the coupling has grown teeth:

- The private tree is now in use (`/priv/pubky.app/marketplace/v1/watchlist.json`, and portable order receipts under `/priv/pubky.app/marketplace/v1/receipts/…`), so a `/priv/pubky.app/:rw` grant now carries commerce purchase history alongside whatever private social data lands there later.
- The 2026-08 architecture review called the coupling out as the namespace becoming "implicit protocol": a seller cannot delegate listing management to a tool without also granting it social write access, and a social client cannot be denied commerce writes.
- The shop record now carries a `transactionService` authority declaration (specs `0.6.2-marketplace.7`), which makes the shop document the anchor of a seller's commerce identity — an anchor that should not be writable by every social app.

This ADR turns ADR 0021's "expected path" into a decision with criteria, so v2 work does not re-litigate it.

## Decision

Marketplace **v2** records move to a sibling namespace with its own grants:

```text
/pub/app.marketplace/v1/shop.json
/pub/app.marketplace/v1/posts/{listing_or_drop_id}/…   (listings/drops as social/v1 PostEnvelope posts)
/pub/app.marketplace/v1/reviews/{review_hash_id}       (HashId-addressed app record — see ADR 0027)
/priv/app.marketplace/v1/receipts/{receipt_id}
```

(The watchlist does not move — it dissolves into social/v1 private bookmarks,
one file per watched target under `/priv/social/v1/bookmarks/`; see ADR 0027.
The version segment restarts at `v1` of the new namespace's own epoch.)

Grants separate accordingly: selling and buying require `/pub/app.marketplace/:rw` (and `/priv/app.marketplace/:rw` for private commerce state); neither implies nor requires `/pub/pubky.app/:rw`. A commerce-only tool (inventory manager, listing scheduler) gets commerce scope and nothing else.

### Trigger

v2 migration work starts when the **first** of these is true:

1. **The social/v1 break ships** (amended 2026-08-27, now the expected path):
   marketplace records ride the same epoch-class break instead of forcing a
   second one of their own — the full design is ADR 0027;
2. A third-party client or tool wants commerce write access and the operator is unwilling to hand it the social grant (the delegation case ADR 0021 anticipated);
3. The specs fork upstreams (official `pubky-app-specs` adopting the marketplace objects) — the upstream conversation must not inherit the v1 coupling;
4. A second marketplace operator deploys against the same records (multi-operator listing registration per the `transactionService` shop field), because at that point the namespace is shared infrastructure, not one app's directory.

Until a trigger fires, v1 stays where it is. No speculative migration.

### Migration mechanics (normative for the v2 plan)

- **Dual-publish window**: during migration a client writes v2 records to `app.marketplace` and keeps the v1 record updated, until the operator's index and known third-party consumers read v2. The v1 record's final revision gains a `supersededBy` pointer to the v2 URI (a spec change gated to the migration release).
- **Identity continuity**: listing ids, review hash-ids, and receipt ids carry over unchanged — only the path prefix changes. Attestation JWS claims that embed canonical listing URIs are reissued for v2 URIs by the attestor on request; v1 attestations remain valid for v1 URIs (they attest history, and history happened under v1 paths).
- **Nexus**: the marketplace indexer ingests both prefixes during the window and serves one merged view keyed by the id, preferring the v2 record at equal-or-higher revision.
- **Sessions**: existing users are prompted for the new grant on their first commerce write after the migration release — one approval, once, explained ("commerce now has its own permission; your social permission no longer covers it"). Reads need no grant.

## Consequences

### Positive ✅

- Commerce write authority becomes delegable and revocable independently of social write authority — the control boundary the review demanded.
- Purchase history under `/priv/app.marketplace/` is no longer exposed to every holder of the private social grant.
- Upstreaming and multi-operator conversations start from a namespace no single app owns.

### Negative ❌

- A migration release: dual-publish code, a `supersededBy` spec field, attestation reissue support, index merge logic, and a re-grant prompt for every active seller and buyer.
- Two namespaces exist during the window; every consumer must state which it reads.

### Neutral ⚠️

- The transaction service is unaffected: it authenticates actors and syncs listing documents by URI; v2 changes the URIs it is given, not its authority model.

## Alternatives Considered

### Stay under pubky.app permanently

**Pros**: no migration ever. **Cons**: the delegation, privacy, and upstreaming costs above are permanent, and the grant coupling worsens as commerce grows. **Why not chosen**: ADR 0021 already judged the coupling acceptable only for v1.

### Fine-grained path scopes within pubky.app (e.g. `/pub/pubky.app/marketplace/:rw`)

**Pros**: no new namespace; grants narrow. **Cons**: depends on homeserver/Ring supporting arbitrary sub-path scopes in grants and on every session flow exposing them; still leaves commerce inside an app directory another product owns; does not help upstreaming. **Why not chosen**: it solves the grant problem at most, on infrastructure that does not promise it, and none of the other problems.

## Related Decisions

- [ADR 0019: Marketplace Transaction Authority](0019-marketplace-transaction-authority.md)
- [ADR 0020: Marketplace Public Records](0020-marketplace-public-records.md)
- [ADR 0021: Marketplace Record Namespace Under pubky.app](0021-marketplace-record-namespace.md)
- [ADR 0024: Portable Reputation](0024-portable-reputation.md)
- [ADR 0027: Social/v1 Migration](0027-social-v1-migration.md)
