# ADR 0023: Single Deliberate Dexie Version Reset for Marketplace Tables

## Status

Accepted — 2026-08-20

## Context

The marketplace adds `commerce_*` tables to the Dexie database. Franky recreates the entire local database whenever `NEXT_PUBLIC_DB_VERSION` changes (see ADR 0007), which wipes all local IndexedDB data for every user on upgrade. The prototype branch bumped the version 2→5 across several intermediate schema iterations, which would have shipped three wipes' worth of churn as one uncoordinated jump.

Local data is a cache of homeserver/Nexus state for almost everything; the exceptions are device-local-only records (drafts, carts, unsent content), which a wipe permanently loses.

## Decision

Ship exactly **one** coordinated version bump, `NEXT_PUBLIC_DB_VERSION` 2→3, carrying the complete `commerce_*` schema. The bump ships only with the first Dexie-touching marketplace PR and is release-noted: users are told the upgrade resets local data, that feeds/profiles re-sync automatically, and that device-local drafts are lost.

No additive Dexie migration machinery is built for this release. Franky's existing recreate-on-mismatch behavior is the migration.

## Amendment — 2026-08-20 (folded into version 3, no second reset)

Consuming the Nexus auction-terms fields added a `commerce_catalog_entries` table (the index-projection cache the catalog grid renders from). That table was briefly shipped as a 3→4 bump — an explicit second reset — before we checked whether one was needed.

It is not. Version 3 has never reached a user: every marketplace slice is still an unmerged pull request and `dev` remains at version 2. Since franky declares all tables in a single `this.version(DB_VERSION).stores({…})` call, adding a table to the not-yet-released version 3 costs nothing, whereas bumping to 4 would have charged users a second full wipe purely because of the order we happened to build things in.

So the table is folded into version 3 and the decision above stands unchanged: **exactly one reset, 2→3.**

The rule this establishes for the remaining pre-launch work: while version 3 is unreleased, new `commerce_*` tables are added to it directly. The moment version 3 ships, any further schema change needs its own explicit reset decision, exactly as the neutral consequence below requires.

## Consequences

### Positive ✅

- One wipe instead of several; the cost is paid once and communicated once.
- No new migration framework to build, test, and maintain for a schema that is still settling.

### Negative ❌

- Users lose device-local drafts and unsent content on upgrade, once.

### Neutral ⚠️

- Subsequent marketplace schema changes before launch must batch into the same version or accept another reset decision explicitly; silent version churn is not permitted.

## Alternatives Considered

### Additive Dexie versioning for commerce tables

**Pros**: no data loss on upgrade.

**Cons**: builds migration machinery the app deliberately avoids (ADR 0007's recreate model); the commerce schema is new and will still change, multiplying migration paths that must each be tested.

**Why not chosen**: the one-time cost of a reset is lower than the permanent cost of a migration framework, given local data is mostly re-syncable cache.

## Related Decisions

- [ADR 0007: Dexie Version Normalization](0007-dexie-version-normalization.md)
- [ADR 0019: Marketplace Transaction Authority](0019-marketplace-transaction-authority.md)

## Amendment (2026-08-21): the version-3 fold policy after the first deployment

Version 3 shipped to the staging deployment on 2026-08-21, so "fold new tables
into unreleased version 3" stopped being safe that morning: Dexie 4 performs
additive table creation in place by bumping the NATIVE IndexedDB version by +1
(30 -> 31) at the same declared version, and the initialization guard treated
the resulting 3.1 as a version mismatch — recreating (wiping) the local
database for every returning browser after each additive deploy. The guard now
floors the normalized version, so Dexie's additive auto-migrations no longer
trigger recreation. Standing policy from here: additive table additions at the
declared version are safe and wipe nothing; any breaking schema change
(indexes, primary keys, reshaped rows) requires a real DB_VERSION bump, which
performs the documented destructive recreate.
