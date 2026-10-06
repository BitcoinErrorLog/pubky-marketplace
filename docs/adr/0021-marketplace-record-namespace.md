# ADR 0021: Marketplace Record Namespace Under pubky.app

## Status

Accepted — 2026-08-20

## Context

Marketplace public records (shop profile, listings, reviews) must live on user homeservers as signed, user-owned documents. Two placements were possible:

1. Extend the existing app namespace: `/pub/pubky.app/marketplace/v1/…`
2. Create a sibling app namespace: `/pub/marketplace.app/v1/…`

The existing Pubky App session grant is `/pub/pubky.app/:rw`. A sibling namespace would require a second authorization grant, a second specs crate or module, and a second session flow in the client. The current `pubky-app-specs` URI parser treats any path it does not know as `Resource::Unknown`, so whichever namespace is chosen must also be added to the specs crate before Nexus or other clients can index it (see the marketplace implementation plan, Phase 1).

## Decision

Marketplace v1 records live under the existing app namespace:

```text
/pub/pubky.app/marketplace/v1/shop.json
/pub/pubky.app/marketplace/v1/listings/{listing_id}
/pub/pubky.app/marketplace/v1/reviews/{review_id}
```

Rationale: the existing `/pub/pubky.app/:rw` grant already authorizes these writes, so current sessions can publish marketplace records with no new auth flow, no re-authorization prompt for existing users, and no second specs package. The `marketplace/v1` segment keeps the record family versioned and separable.

The coupling of commerce records to the social app's grant is accepted for v1. The decision is revisited at the stable/v2 boundary; if commerce needs independent authorization scopes (e.g. delegating listing management without granting social write access), migration to a sibling `marketplace.app` namespace is the expected path.

## Consequences

### Positive ✅

- Existing sessions publish marketplace records immediately; no second auth grant or session flow.
- One specs crate covers social and marketplace objects; one URI parser, one npm package for pipes.
- Nexus can index marketplace records with the same event pipeline it uses for `pubky.app` paths.

### Negative ❌

- Any app holding a `/pub/pubky.app/:rw` grant can write marketplace records, and vice versa; scopes cannot be separated in v1.
- A future namespace migration (if v2 separates commerce) will require republishing records and a compatibility window.

### Neutral ⚠️

- Marketplace object specs land in `pubky-app-specs` and follow its release cadence.

## Alternatives Considered

### Sibling namespace `/pub/marketplace.app/v1/…`

**Pros**: clean separation of authorization scopes; commerce records portable independently of the social app.

**Cons**: second grant and session flow; second specs surface; every existing session must re-authorize before selling.

**Why not chosen**: v1 optimizes for shipping with the existing auth model; separation is deferred until a concrete need for independent scopes exists.

## Related Decisions

- [ADR 0020: Marketplace Public Records](0020-marketplace-public-records.md)
- [ADR 0019: Marketplace Transaction Authority](0019-marketplace-transaction-authority.md)
