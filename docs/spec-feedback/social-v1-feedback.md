# Social/v1 Spec Feedback from the Marketplace Build

Audience: the authors of `pubky_social_v1.md`. Source: the 2026-08-26
compatibility review ("Marketplace on Social v1") plus the working marketplace
deployment (`BitcoinErrorLog/pubky-app-specs` @ `marketplace-4-build`,
`BitcoinErrorLog/pubky-app` @ `marketplace/pr25-ux`,
`BitcoinErrorLog/pubky-marketplace-service`). The headline finding stands
without qualification: the marketplace record layer needs zero additions to
social/v1 — section 6's composition law, the app-namespace convention, and
`PostEnvelope<K>` are the designed seam, and we have committed to riding the
break (our ADR 0027). Everything below is wording, vectors, and one decision,
offered with a live third-party deployment as the evidence.

We have already reversed the two fork rules that needed no wire break —
records are open-world as of specs `0.6.2-marketplace.9`, and our tombstone
record type is deleted — so this feedback comes from a codebase that is
converging on v1, not resisting it.

## Free — wording and one test vector, worth spending inside the break

### R1. Settle `app.locks` against `locks.app`

Section 6 recommends reversed-domain `app.locks` and explicitly rejects
`locks.app` (a directory ending in `.app` is treated as an application bundle
by macOS when a tree is exported), but two places in the same document still
say `locks.app`: the reference-rewriting note in 7.3 and the `Post.lock`
ledger row. The losing spelling is in shipped third-party code today: our
specs fork's `validate_locks_uri` hardcodes `/pub/locks.app/`, and three
client constants mirror it. We will follow whichever spelling the spec pins —
our v1 migration ADR lists this as a blocking dependency — but it has to pin
one. Suggest also moving the naming rule out of section 6 prose into the
README, where an app team actually looks first. (Our own ADR 0025 originally
chose `marketplace.app`; we have amended it to `app.marketplace` on the
strength of section 6's argument.)

### R2. Say who owns an `ext` key

Section 2.2 reserves the member and 4.0 says it is keyed by extension name,
but nothing says what the key is. Pin it to the writing app's namespace
segment — `"ext": {"app.marketplace": {…}}` — one sentence. It makes 4.5's
tag read-modify-write rule actionable (preserve foreign `ext.*` keys, rewrite
only your own); without it, two vendors both write `ext.badge`.

### R3. Turn the app-namespace advice into an adopter checklist

Section 6 tells app authors one thing (carry an epoch in the path). The rest
of the forward-compat contract deserves the same five lines, and our fork is
the evidence it needs saying out loud — we independently adopted five rules
v1 forbids and are now paying to reverse them. The checklist: epoch in the
path; never deny unknown fields; preserve unknown members on rewrite;
`#[serde(other)]` on every enum; one total byte cap; integer microsecond
timestamps.

### R4. Name commerce on the section 11 fence

Everything on the section 11 fence is deferred-but-additive. A commerce
vocabulary is a different answer — out of scope by the composition law, not
queued behind it. With a working marketplace in hand there will be pressure
to add a listing kind to social/v1; pre-write the refusal and point at
section 6's two placement tests.

### R5. Add a `legacy_v0` vector for third-party data under `pubky.app`

The permanent `legacy_v0` module must classify
`pub/pubky.app/marketplace/v1/listings/{id}` as a SKIP, not an error. Defect
1.1.1 records that v0's parser hard-rejects unknown app paths, and this data
is live on the staging homeserver today — a nexus dual-read will meet it on
the events feed the moment it turns on. One conformance vector, on a path
that already exists in the wild.

### R6. State that an app record must not carry state a service enforces

Our ADR 0020 split the listing into seller-authored terms and authoritative
availability because a mutable public record cannot be trusted for stock or
payment state. That generalizes to every app namespace and belongs next to
the epoch recommendation in section 6 — it is the line that stops the next
app from putting `availableQuantity` in a homeserver file.

## Needs a decision — the break is the free moment

### R7. Publish a scope vocabulary, not just pubky-app's default grant

Section 7.7 pins one grant (`/pub/social/v1/:rw,/priv/social/v1/:rw,…`).
Right for pubky-app, but as the only named scope it becomes the scope
everything asks for: a bookmark exporter or read-only feed reader ends up
holding write access to drafts, private notes, and mutes. Section 1.4
confirms per-resource scopes are expressible (a trailing-slash scope covers
descendants). This is our ADR 0025 coupling complaint one level down, inside
the social tree, and the late fix is priced by our own migration mechanics: a
re-grant prompt for every active user. It also feeds the open question of
the Ring permission screen — user testing of our marketplace session flow
surfaced exactly the confusion an identity-only approval causes when Ring has
no vocabulary to describe what is (not) being granted.

## Real work, additive later — optional for the break

### R8. Split the envelope's two jobs

`PostEnvelope<K>` fuses the reference-and-preservation mechanics (reference
tier, root/ownership rules, `extra`, byte cap, validation context) with one
storage choice (versioned directory + TimestampId). The marketplace wants the
first for its shop, receipt, and drop records and only sometimes the second.
A record-level trait carrying just the first — which `PostEnvelope`
implements and an app record can implement directly — would turn three of our
hand-rolled validators into one adoption. Crate API, not wire format: safe as
a crate-major later, re-ids nothing.

## No change — ledger update

### R9. Per-attachment metadata has its second consumer

The section 11 row says "additive whenever a consumer commits." The
marketplace commits: a catalog grid needs `width`/`height` (and `durationMs`
for video) to lay out without fetching bytes. Record the marketplace as the
second consumer and ship it in v1.1, not v1.
