# Watchlist, Alerts, and Saved Searches

The re-engagement loop: watch items, get told when something about them actually changed, save searches and see what arrived since you last looked. This document states exactly which alerts are server-delivered and which are detected client-side, and where the honest boundary between the two runs.

## The one concept

The watchlist IS the favorites store (`commerce_favorites` — account-scoped, device-local IndexedDB). There is no second bookmark system: the heart on a fixed-price card, the bell on an auction card, the toggle on the listing page, and the `/marketplace/watchlist` page all read and write the same rows. Unwatching deletes the item's observation baseline with it, so an unwatched item can never produce another alert.

## Server-delivered vs. device-detected

Two different kinds of rows reach the notification surfaces, and the UI never lets them impersonate each other:

**Server-delivered** (real outbox rows from the durable Marketplace Transaction Service, read via `GET /v1/notifications`): the service DOES emit an `outbid` notification to the displaced auction leader (verified in its `handlers/auction.rs` — sent to the previous `leader_pubky` when a new bid changes the leader, skipped when the leader outbids themselves), and `auction_won` to the winning bidder on close. These render with an actor ("Rival outbid you in an auction") in the general notification surface and are surfaced prominently at the top of the watchlist page.

**Device-detected** (rows in `commerce_watch_alerts`, produced by checks this device runs): everything else below. These rows have NO actor — nobody sent them — and every surface labels them as such ("Watchlist · checked on this device", "Detected on this device … not server events"). Their read state is honestly clearable precisely because they exist only locally.

## What detection actually observes

There is no background daemon. A bounded detection pass runs when a marketplace surface is visited and when the tab regains focus, spaced at least 60 seconds apart per account, over at most the 24 most recently watched items. Each pass makes two kinds of REAL reads per item:

1. **Index read** — `GET v0/listing/{seller}/{listing}` on the Nexus marketplace index: revision, price, state, auction deadline. (Sandbox mode reads the locally seeded catalog instead; the sandbox never queries Nexus.) Fresh rows are folded into the catalog cache, so the watchlist renders what detection observed.
2. **Projection read** — `GET /v1/listings/{aggregate_id}` on the transaction service: current bid, bid count, leader, sale state. Transactional modes only.

The result of each pass is compared against a persisted per-item baseline (`commerce_watch_snapshots`) — the last state this device actually observed. A failed or impossible read produces no observation and therefore no claim; the baseline stays put.

## The alert types and their exact trigger truth

| Alert        | Fires when                                                                                                                                                                                                                                                                                                                                                         | Never fires when                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Ending soon  | An observed `ends_at` is within 24h of the check's clock and the listing was observed running. Once per distinct `ends_at` (anti-sniping extensions produce a new deadline and may alert again).                                                                                                                                                                   | The deadline passed, the listing is not running, or this deadline already alerted.                        |
| New bid      | A projection read shows a higher bid count than the baseline this device recorded, and the fresh leader is not the user.                                                                                                                                                                                                                                           | No prior projection baseline exists (first read only records it), or the user's own bid raised the price. |
| Outbid       | Same as new bid, PLUS the baseline recorded the user as auction leader and the fresh read shows someone else leading — participation proven by this device's own reads. Note the service also delivers a real `outbid` notification; the client-side alert covers the case where the user bid from another device or the service notification hasn't been fetched. | The user was never observed leading. The client never infers "outbid" from a price movement alone.        |
| Price change | The index served a newer revision whose price differs from the baseline price.                                                                                                                                                                                                                                                                                     | The revision didn't advance, the price is unchanged, or no baseline exists.                               |
| State change | The observed index state differs from the baseline (`active→ended`, `ended→active` = relisted, `paused`, `removed`), or — when the index didn't move in the same pass — the projection's sale state differs (`available→sold` = sold out).                                                                                                                         | No baseline state exists.                                                                                 |

First visit after watching an item records baselines only — no delta alert can fire without a prior observation, by construction (tested).

Alert ids are deterministic (`owner|listing|kind|dedupeKey`), and persistence skips existing ids, so re-detection can never duplicate an alert or resurrect one the user already saw.

## Saved searches

A saved search (`commerce_saved_searches`) stores a name plus the exact catalog filter state (query, category, sale format, conditions, price range, sort). On marketplace visit/focus (bounded to 10 searches, same 60s spacing), the client refreshes discovery from the Nexus listing stream (one request per distinct server-side filter combo) and re-runs each search with the same client-side filter the catalog page uses. The NEW badge counts matches whose catalog `updated_at` is strictly newer than the search's acknowledged watermark:

- At save time the watermark starts at the newest current match — nothing that already existed can ever count as NEW.
- Checks record counts but never move the watermark; only opening the search (which shows the user the results) acknowledges it.
- Badges computed against a stale cache can lag; they never invent arrivals.

## Known gaps and follow-ups

- **CLOSED — watcher/loser auction close notification**: the service now emits `auction_ended` to every distinct bidder except the winner on close (sold and unsold), sharing the one close event so redelivery dedups by `(event, recipient)`. The client normalizer already handled the kind; the item copy now renders the closing price it carries. Watchers who never bid still have no server event (the service only knows bidders), so the client's `state_change`/ending-soon detection continues to cover pure watchers locally.
- **CLOSED — outbox payload amounts**: service notifications now carry an optional `amount` (money JSON) where ADR-0019 §8 permits — the offer amount on offer notifications, the auction's visible price on `outbid`/`auction_won`/`auction_ended` — because the recipient already reads those figures in role-scoped projections. Older delivered rows have no amount and keep rendering without one; device-detected rows keep their projection-read amounts as before.
- Detection recency is bounded by visits: a price drop is detected the next time the user opens a marketplace surface, not the moment it happens. This is inherent to a local-first app without push, and the UI's "checked/observed … by this device" phrasing states it.
- **CLOSED — cross-device watch sync**: watch state now syncs across devices through a private homeserver document; see the implementation section below. What remains device-local by design: observation baselines and detected alerts (they describe what THIS device observed), and an alert about a bid placed from another device still reports "new bid" rather than "outbid" unless this device observed the user leading — syncing watch marks does not sync observation history, and the UI's per-device labeling stays accurate.

## Cross-device watch sync (implemented)

**Status: IMPLEMENTED and proven live.** The user approved the "new grant" option this section originally put up for decision: the app's single sign-in grant now includes `/priv/pubky.app/:rw` (see `CAPABILITIES` in `src/config/app.ts`), and the sync engine described below ships on this branch. The privacy analysis and the empirical findings that justified the mechanism are preserved as written — they are the reason the feature looks the way it does.

### The privacy question, stated first

A watchlist reveals **purchase intent**, and intent is strategically valuable to the counterparties who could read it. On an auction it enables sniping and demand signaling (a seller who can see who is watching knows exactly whose reserve to test and when interest peaks); on fixed-price items it exposes a buyer's shopping list. eBay treats watchlists as private for precisely this reason. So the acceptable-leakage bar here is not "consistent with the rest of the app" — it is "no third party can enumerate what a given pubky is watching."

This runs against the ecosystem grain. Every existing `pubky.app` record — follows, bookmarks, mutes, `last_read` — lives under `/pub/` and is **public by construction** (`pubky-app-specs` defines only `PUBLIC_PATH = "/pub/"`; `last_read_uri_builder` writes `pubky://<id>/pub/pubky.app/last_read`, and Nexus indexes the whole `/pub/pubky.app/` subtree). A watchlist stored the same way would be world-readable. Obscuring the path (a random or hashed filename under `/pub/`) does not fix this: `/pub/` directories are **listable** by anyone (`publicStorage.list` needs no auth), so an obscured name is discoverable, and even a truly unguessable name is security-through-obscurity that Nexus indexing and directory enumeration defeat. **A public-but-obscured watchlist is not acceptable for a purchase-intent record**, and this memo treats that option as closed.

### What the homeserver and the app's session can actually do (empirical)

Tested against the live staging homeserver (`homeserver.staging.pubky.app`, pkarr relays `pkarr.pubky.app`/`pubky.org`) with throwaway identities via the vendored `@synonymdev/pubky` 0.8 SDK — the exact client the deployed app uses. Results:

| #   | Actor / session                                                                                                         | Operation on `/priv/pubky.app/…`                 | Result                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1   | Signup/keypair session (`signer.signup`/`signin`) — capabilities `["/:rw"]`                                             | `putJson`, `getJson`, `list`, raw `PUT`/`GET`    | **All succeed** (201 / 200)                                                         |
| 2   | Ring auth-flow session requesting `/pub/pubky.app/:rw` — capabilities `["/pub/pubky.app/:rw"]`                          | `PUT` and `GET` `/priv/…`                        | **403 Forbidden** — "Session does not have write access to path" (and reads denied) |
| 3   | Ring auth-flow session requesting `/pub/pubky.app/:rw,/priv/pubky.app/:rw` — capabilities include `/priv/pubky.app/:rw` | approval, `PUT`, `GET` `/priv/…`                 | **All succeed** (approval accepted, 201 / 200)                                      |
| 4   | A **different pubky**, fresh process, no session                                                                        | `GET`, `list`, `PUT` on another user's `/priv/…` | **401** — "Authentication required to read private storage"                         |

Two findings matter and one is a trap:

- **`/priv/` is genuinely private.** From a separate process holding no session, reads, listings, and writes to another user's `/priv/` path are refused with 401 (row 4). The staging homeserver enforces authentication on `/priv/` for both reads and writes — unlike `/pub/`, whose reads are open and whose directories are listable. This is exactly the confidentiality the intent record needs.
  - _Trap that had to be ruled out:_ an in-process "anonymous" client initially appeared to read and even overwrite `/priv/` (200/201). That was a **process-global cookie jar** in the WASM SDK — separate `Client` instances in one Node process share the owner's session cookie. Re-run from a clean process, the same requests return 401. Privacy is load-bearing here, so this was verified cross-process rather than trusted from the single-process run.
- **The SDK fully expresses `/priv` scopes.** `validateCapabilities("/pub/pubky.app/:rw,/priv/pubky.app/:rw")` normalizes cleanly, the auth flow accepts the string, and the resulting `SessionInfo.capabilities` carries both entries (row 3). There is no SDK-level blocker.
- **The app's Ring session could not touch `/priv` at measurement time.** The app then requested exactly `CAPABILITIES = '/pub/pubky.app/:rw'` (now in `src/config/app.ts`). A Ring-authenticated session therefore held only that scope and was refused on `/priv/` (row 2). Only keypair/recovery-phrase sign-in yielded root `/:rw` (row 1) and could reach `/priv/`. (The grant has since been widened — see below — but sessions approved under the old grant still behave exactly like row 2, which is why the capability gate exists.)

### The decision that unblocked it

**Pubky Ring is the flagship sign-in method**, and under the previous grant (`/pub/pubky.app/:rw` only) Ring sessions could not touch `/priv/` — building sync that silently worked for recovery-phrase users (root `/:rw`) and no-oped for Ring users would have been a dishonestly-labeled half-version. The user approved widening the grant: the app's single sign-in approval now requests `/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw` (one combined grant on purpose — the homeserver keeps ONE session cookie per user per origin, so split approvals clobber each other; see the `CAPABILITIES` comment in `src/config/app.ts`). **Already-authorized legacy sessions do not gain the scope retroactively**; how the app stays honest for them is the capability-gating section below.

### The record

`pubky-app-specs` fork `0.6.2-marketplace.6` (branch `marketplace-4-build`) reserves the first private-record convention:

- **`PubkyAppWatchlist`** — a SINGLE revisioned document at `/priv/pubky.app/marketplace/v1/watchlist.json` (`PRIVATE_PATH` constant, `watchlistUriBuilder`, wasm `createWatchlist` + `fromJson`/`toJson`). One document instead of per-item records because watch toggles are high-churn (one `PUT` per sync instead of a create/delete stream), merge needs items and tombstones resolved atomically, and private storage has no index to benefit from per-item paths.
- Shape: base marketplace envelope (`schemaVersion`, `recordType: "watchlist"`, `ownerPubky`, `revision`, ISO `createdAt`/`updatedAt`) plus `items[]` and `tombstones[]`, each entry `(listingOwnerPubky, listingId)` with an **integer epoch-milliseconds timestamp** (`watchedAtMs` / `removedAtMs`) — integers because they are merge keys compared numerically, immune to offset-formatting skew. Caps of 500 each; every listing key appears in at most ONE of the two lists (the document is the post-merge resolved state). Deliberately NOT wired into `PubkyAppObject`/URI resource resolution: nothing under `/priv/` is watcher- or Nexus-visible.

### The merge rule

Per listing key, **last-write-wins on the entry timestamp; a tie resolves to the tombstone** (deletion wins — resurrecting an item the user removed is the worse failure). The merged state is applied to Dexie (favorites + a new `commerce_watch_tombstones` table; snapshots of removed items are deleted so an unwatched item can never alert) and written back with `revision` incremented when it differs from the remote. Tombstones beyond the cap are pruned oldest-first. The pure implementation and property tests (commutativity, idempotence, disjointness, tie-to-tombstone, pruning) live in `src/core/pipes/commerce/commerce.watchlist.ts(.test.ts)`.

### The sync engine

Local-first throughout: Dexie stays the source of immediate truth, every toggle works signed-in-offline, and sync is a background reconciliation.

- **Push on change**: each watch/unwatch stages a deterministic outbox job (`commerce_sync_jobs`, id `watchlist|<owner>` — whole-state document, so one pending job coalesces any number of toggles) and triggers a sync round; a failed push leaves the job pending and heals on the next round.
- **Pull on sign-in/restore**: the auth controller fires a sync round after bootstrap.
- **Per visit**: the watchlist page triggers a round on load; overlapping triggers share one round-trip (single-flight per owner).
- Reads/writes go through the app's homeserver session (`HomeserverService.request` now resolves owned `/priv/*` paths alongside `/pub/*`).

### Encrypted storage (2026-09-28)

The synced document is now sealed in the browser before it reaches the homeserver. It lives at one opaque entry under `/priv/pubky.app/marketplace/v2/s/`, encrypted with XChaCha20-Poly1305 under a per-user data key the marketplace service releases only to a session whose grant covers `/priv/pubky.app/` with read and write (`GET /v1/me/priv-keys`). The plaintext is the same `PubkyAppWatchlist` document. A round reads the sealed entry and any plaintext v1 `watchlist.json`, merges both with local state, writes and reads back the sealed entry, and only then deletes v1. The homeserver has no conditional write, so rounds for one account hold a Web Lock shared by every tab of the Shop, and a round completes the outbox job only if no change was staged after it read the local state. Without a released key nothing is written: `needs_reauth` shows the re-approval notice, and `unavailable` says private sync is off while the list keeps working on this device. The envelope, paths and offline recipe are in [`priv-encryption-recovery.md`](priv-encryption-recovery.md).

### Capability gating (the honesty contract)

Whether sync can work is decided from **session facts** — `session.info.capabilities`, the homeserver's own statement of the grant — never by probing and swallowing 403s (`capabilitiesGrantWrite` in `homeserver.utils.ts`). Three states:

- **capable**: the grant covers writing `/priv/pubky.app/` (widened Ring grant, or root `/:rw` from recovery-phrase sign-in) — sync runs.
- **needs_reauth**: a live legacy session whose grant predates the `/priv` scope. The watchlist keeps working locally, and the watchlist page shows ONE non-blocking notice: "Sync across devices needs a fresh sign-in approval." An actual 401/403 on a real read or write ALSO flips to this state. Never a silent no-op.
- **no_session / sandbox**: sync is skipped and nothing is claimed.

### Live proof (2026-09-28, staging, encrypted storage)

`npm run test:marketplace:priv` (Node, the deployed staging homeserver and marketplace service, nothing mocked) proves the encrypted watchlist together with receipts and badge checkpoints: under an identity-only session the key is refused and nothing is written; under the Shop grant the plaintext v1 document is sealed, read back and deleted in that order on the wire; a fresh device with an empty IndexedDB restores the watch from the sealed entry; a tampered entry is never overwritten; another identity is refused the sealed entry and the `/priv` listing. It replaces the browser-mode proof below, which predates encryption: the staging service does not answer CORS for a localhost test origin, so a browser harness cannot obtain the key.

### Live proof (2026-08-22, staging, plaintext v1; retired)

The former `npm run test:marketplace:watchlist` (vitest browser mode, real staging homeserver over the public pkarr relays, nothing mocked) proves in one journey: device 1 of identity A watches → the private document is live at the `/priv` URI; a wiped-DB fresh sign-in (device 2) pulls the watch; device 2 unwatches → pushed as a tombstone with the revision advanced; device 3 sees the item absent and the tombstone present; identity B's read AND directory listing of A's document are both refused — verbatim: `401 Unauthorized - Authentication required to read private storage`. Result recorded in the proof ledger in [`status.md`](status.md). The legacy-session `needs_reauth` half is covered by unit tests (`commerce.watchlist.test.ts`) because a machine cannot honestly approve a narrow-scope Ring flow.

### Known limits, stated

- **What syncs is the watch marks** (and their removals). Observation baselines, device-detected alerts, and saved searches remain device-local by design — they describe what a specific device observed, and the UI's "on this device" labeling stays true.
- The synced document carries at most 500 items and 500 tombstones (spec caps); overflow beyond the newest 500 stays local-only, as do watches on non-pubky sellers (sandbox catalog).
- A pruned tombstone stops protecting against re-adds older than itself; both are by construction the oldest signals in play.
