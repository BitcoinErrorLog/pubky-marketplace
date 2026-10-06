# Implementation Plan — Marketplace Private Messaging over Paykit Encrypted Links

Status: executed — Topology B (browser WASM) was chosen and implemented; see the dated updates at the top of [README.md](README.md) for what actually shipped (including corrections to details below, e.g. the receiver path must be `marketplace/wallet`, not the `marketplace/web` example). Kept as the design record.

Two topologies are planned. Topology B (browser WASM) is the one that actually delivers "operator cannot read" and is the recommended end state. Topology A (Rust adapter service) is documented because it is the only way to ship sooner, and its honest limitation is stated up front: **the adapter operator can decrypt messages.**

Repo placement, when implementation is approved:

- Protocol/adapter Rust work: a new service crate (adapter topology) or upstream `pubky/paykit-rs` / `pubky/pubky-noise` PRs (WASM topology). Upstream PRs go through a fresh fork under an approved org, never pushed from here.
- Client work: mp-launch, following its layering (UI → Controllers → Application → Services; message bodies never in projections or telemetry per ADR-0019 §8).
- Nothing lands in the durable transaction service except (optionally) conversation _existence_ metadata — never bodies, never keys.

---

## Phase 0 — Decision-independent groundwork (can start now)

**0.1 Interim honesty fix (mp-launch, small).** In sandbox mode the inbox and message dialog do not disclose operator-readability at the point of use (verified: no "readable"/"plaintext"/"memory" copy in `MarketplaceInbox.tsx`, `MarketplaceMessageDialog.tsx`, `MarketplaceMessageAttachment.tsx`; the labels only say "sandbox-only"). Add one persistent line inside the active conversation view and the attachment picker: messages and attachments here are unencrypted, held in sandbox service memory, and readable by the operator; do not share sensitive details. Test: copy renders in sandbox mode; durable mode unchanged (button stays disabled with the existing explanation).

**0.2 Message-kind contract draft (docs only).** Define the marketplace Private Application Message kinds as closed-world JSON, versioned, mirroring Paykit's envelope (`version: u8`, `kind: string`):

- `marketplace.chat_message.v0` — `{ version, kind, event_id (uuid), conversation_id, listing_ref, sent_at, body }`. Budget: must serialize ≤ ~900 bytes (Noise message limit is 1000 bytes total; leave envelope headroom). Enforce a body character limit in the client accordingly.
- `marketplace.chat_attachment.v0` — receipt-access pattern: `{ version, kind, event_id, conversation_id, blob_location, blob_hash, decryption_key, content_type, size }`. The blob itself is an encrypted file at a caller-chosen homeserver path (encrypt-then-store, same shape as Paykit's `prepare_receipt`/`store_prepared_receipt`), never plaintext, never on public marketplace paths, never through Nexus.
- `marketplace.chat_read.v0` (optional, later) — read cursor as an Event Message.

Semantics: all kinds are Event Messages (every one matters, dedupe by `event_id`), consistent with Paykit's stream rules: persist handled/unhandled state _before_ persisting an advanced link snapshot; replay after crash is expected and deduped.

**0.3 Upstream conversation (issues, not code).** File against `pubky/paykit-rs` and `pubky/pubky-noise` from an approved-org account: (a) request/offer a wasm32 binding of `pubky-noise` + `paykit-lib` (evidence from this evaluation: getrandom 0.3 `wasm_js` backend config and `ring`-via-`pubky` toolchain are the known build obstacles; no API-shape blockers found); (b) ask whether a `marketplace.*` kind namespace over `send_private_application_message_json` is the intended extension pattern; (c) flag the snapshot-encryption TODO (`pubky-noise/src/lib.rs:627`) as a prerequisite for any design that stores snapshots outside secure storage.

---

## Phase 1 — Shared plumbing (either topology)

**1.1 Ring grant scope.** Messaging needs a homeserver session grant covering `/pub/paykit/…` (verified path prefix: `/pub/paykit/v0/private/{receiver_path}/messages/…`). Decide (with the same product owner as `service-auth.md`'s open decision) whether this is a separate approval or folded into an existing flow. Show the exact scope in the approval UI.

**1.2 Receiver provisioning.** On first messaging use: generate `ReceiverNoiseSecretKey::random()`, choose a marketplace receiver path (e.g. `marketplace/web`), publish the Receiver Marker (`receiver.json` with the Noise public key) under the user's homeserver. Counterparty discovery: `list_paykit_receiver_paths` + marker read, keyed off the pubkys already present on every listing/order.

**1.3 Conversation bootstrap.** Buyer initiates `initiate_encrypted_link` toward the seller's marketplace receiver; seller side `accept_encrypted_link` on next inbox poll; both drive `advance_handshake` until Complete. Persist handshake snapshots (they contain key material — secure storage only) so restarts recover via `restore_encrypted_link_handshake`.

**1.4 Inbox transport switch in mp-launch.** Introduce a messaging service interface in `src/core/services/marketplace/` with two impls: existing sandbox client (unchanged, still labelled) and the encrypted transport. Controllers/hooks (`useMarketplaceInbox`, `useMarketplaceMessages`) select by mode. Message bodies live only in account-scoped Dexie tables (`commerce_conversations`, `commerce_messages` — already reserved in the implementation plan §Local tables) and never in logs/Sentry/projections (extend the existing redaction tests).

---

## Phase 2A — Topology A: constrained Rust messaging adapter (ships sooner; operator CAN decrypt — label it)

- New Rust service (own Postgres schema or sqlite; NOT inside the transaction service) using `paykit-sdk` pinned to the audited commit. Per authenticated user it stores: receiver Noise secret (encrypted at rest under a service KMS key), session bearer (from the user's Ring-approved grant, exchanged the same way `MarketplaceSessionService` exchanges AuthTokens today), link snapshots, and `SdkBackupState`.
- API to the browser: `POST /v1/conversations` (bootstrap link), `GET /v1/conversations`, `GET /v1/conversations/{id}/messages`, `POST …/messages`, `POST …/attachments`. Auth: the same AuthToken→opaque-session pattern the transaction service uses (`service-auth.md` design; verified interoperable pubky-common 0.8↔0.11).
- Constraints copied from `upstream-integration.md:80` verbatim into the service README: it must not expose raw encrypted-link snapshots, receiver secrets, identity secrets, or generic storage access.
- **UI copy requirement (non-negotiable):** conversations in this mode are labelled "Encrypted in transit and at rest. The messaging service operator holds the keys and can read messages." Anything else is a false claim.
- Multi-device/history: free — state is server-side. That is exactly the trade.
- Tests: handshake against two ephemeral homeserver testnet users (pubky-noise's e2e crate shows the pattern); message + attachment round-trip; restart recovery from snapshots; redaction tests proving bodies never hit logs; authz tests proving cross-user conversation reads fail.

## Phase 2B — Topology B: browser WASM binding (the real fix; depends on upstream)

- Upstream: wasm32 binding crate for `pubky-noise` + the encrypted-link surface of `paykit-lib` (+ the thin SDK state machinery the browser needs), built with wasm-pack; CI target added upstream. Consume it exactly like the Locks binding: pinned commit, recorded toolchain, checksummed vendored artifact, dynamic import in a client component, generated-API smoke test before the Next build (`upstream-integration.md` §Browser packaging, steps 1–6).
- Keys: receiver Noise secret generated in-browser, stored in account-scoped IndexedDB; homeserver session is the user's own (Ring grant from 1.1). The operator never holds keys. Snapshots and `SdkBackupState` are stored in IndexedDB **and** backed up as one encrypted blob to the user's own homeserver under a private-derived path — encrypted under the key chosen in Decision 2 (backup key).
- Multi-device/history: restore = fetch backup blob + decrypt with backup key + `restore_encrypted_link` + re-read homeserver ciphertexts (explicit-nonce transport makes old ciphertexts re-decryptable). A device without the backup key starts a fresh receiver and sees no history — the UI must say so.
- Tests: wasm smoke (binding loads, handshake vectors pass) in CI; two-browser-context e2e over a local homeserver testnet: handshake, chat round-trip, attachment round-trip, snapshot-restore, second-device restore from backup, and a negative test that no plaintext body ever appears in network traffic to any marketplace-operated host.

## Phase 3 — Cutover and durable-service touchpoints

- Durable transaction service: unchanged except, optionally, a conversation-existence pointer on orders/offers (participants + receiver paths only — no bodies, no keys, no derived path hashes, which would deanonymize the pair relationship).
- Sandbox messaging remains for sandbox mode until the encrypted transport passes its e2e suite in the composed environment; then the sandbox impl is retired or kept solely for offline demo with its labels.
- Update `status.md` (move messaging from Simulated), ADR note for the transport choice, and the acceptance rows in `implementation-plan.md` §Messaging.

## Explicitly out of scope

- Any TypeScript re-implementation of Paykit/Noise primitives (forbidden by contract).
- Group conversations.
- Real-funds claims: messaging joins the existing independent-security-review gate before production.
