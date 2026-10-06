# Encrypted Transport for Marketplace Private Messaging — Candidate Evaluation

Date: 2026-08-20.
Scope: plan task 5.1 — replace the sandbox-only, operator-readable messaging with a reviewed encrypted transport, under the hard constraint that the browser cannot sign or decrypt with the user's Pubky identity key.

## Sources actually read

Every claim below is grounded in source read during this evaluation, not in README marketing.

| Source                                     | Revision                                                                                                     | Notes                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `pubky/paykit-rs` (official)               | `c8892f638951f033acbcd12804a31667a81ddc14` (= the marketplace's audited commit, tag anchor v0.1.0-rc43)      | Cloned to `reference/paykit-rs-official` (gitignored)   |
| `pubky/pubky-noise` (official)             | `5ab90b6738d1da05cfb2b430ff21171fceb5cd31` (main, 2026-08-11, v0.1.0-rc6)                                    | Cloned to `reference/pubky-noise-official` (gitignored) |
| `/Volumes/vibedrive/vibes-dev/pubky-noise` | legacy fork, HEAD June 2026                                                                                  | Read-only; see Candidate 2                              |
| `/Volumes/vibedrive/vibes-dev/paykit-rs`   | legacy fork (`BitcoinErrorLog/paykit-rs`), HEAD June 2026                                                    | Read-only; see Candidate 1                              |
| mp-launch docs                             | `docs/ecommerce/status.md`, `upstream-integration.md`, `service-auth.md`, `implementation-plan.md`, ADR-0019 | Constraint sources                                      |
| mp-launch code                             | `services/marketplace/src/server.ts`, `MarketplaceInbox.tsx`, `MarketplaceMessageDialog.tsx`                 | Current sandbox messaging surface                       |
| pubky-app-specs fork                       | `~/work/pubky-app-specs`                                                                                     | Model inventory for Candidate 3                         |

**Important provenance note:** both `/Volumes/vibedrive` repos are _deprecated legacy forks_ with no shared git history with the official `pubky/*` repositories, and both carry explicit "no new code may depend on this repository" notices (pubky-noise README ¶2; paykit-rs README ¶2, final commit "docs: deprecate this legacy fork as a dependency"). The marketplace's audited contract points at the official repos. This evaluation is therefore against the official repos; the legacy forks are disqualified as dependencies outright.

## Evaluation criteria

1. Browser viability
2. Requires reimplementing crypto? (forbidden by `upstream-integration.md`: "General Paykit encrypted links, private lists, requests, and receipts require Paykit Rust. They must not be reimplemented in TypeScript.")
3. Key management under the no-browser-identity-key constraint
4. Multi-device and history recovery
5. Operator-readability (the thing being fixed)
6. Maturity / review status
7. Demands on upstream projects

---

## Candidate 1 — Paykit encrypted links (official `pubky/paykit-rs`)

### What it actually is

An Encrypted Link is a Noise XX session between two _receiver-scoped_ X25519/Ed25519 keys, transported asynchronously through both parties' Pubky homeservers (outbox model: each side writes ciphertext to its own homeserver under a derived private path; the counterparty polls and reads). `paykit-lib` supplies the handshake, message stream, snapshots, and recovery; `paykit-sdk` supplies stateful runtime, contact linking, backup state; `paykit-ffi` supplies Swift/Kotlin bindings (no JS/WASM).

### The decisive key-management fact

**Paykit messaging does not need the Pubky identity secret.** Verified in source:

- `initiate_encrypted_link(session, sender_noise_secret_key, …)` takes a 32-byte _receiver Noise secret_ separate from the identity (`paykit-lib/src/encrypted_link/handshake.rs:127`). The Noise static and the DH used for path derivation are this key, not the identity key (`paykit-lib/src/encrypted_link/paths.rs`: "The DH exchange uses the independent receiver Noise keys published in Receiver Markers"; identity public keys enter only as domain-separation data).
- `paykit-sdk` generates that key randomly: `ReceiverNoiseSecretKey::random()` (`paykit-sdk/src/identity.rs:210`).
- `PubkySessionAccess.local_secret_key` is `Option<PubkyLocalSecretKey>` (`paykit-sdk/src/identity.rs:267`) — the SDK runs without the identity secret.
- The homeserver session it needs can be obtained via the Pubky auth flow with signer approval ("Wait for auth approval and validate the resulting session capabilities", `paykit-sdk/src/pubky_session.rs`) — the same Ring-mediated mechanism the app already uses for its `/pub/pubky.app/:rw` grant and the transaction-service AuthToken.

So the hard constraint does **not** kill this candidate. What the constraint really decides is _where the receiver Noise secret and the Paykit Rust runtime live_, because the browser can hold a random non-identity secret (IndexedDB) but cannot run Paykit (no JS/WASM binding, TS reimplementation forbidden).

### Generic messages are in-contract

`EncryptedLink::send_private_application_message_json` is a public API that "does not require a known Paykit kind or validate known Paykit message bodies" (`paykit-lib/src/encrypted_link/link.rs:203-221`). Received messages preserve raw payloads for unknown kinds. A marketplace-defined kind (e.g. `marketplace.chat_message`) rides the same reviewed encrypted stream without touching Paykit's closed-world payment kinds. This is designed extension surface, not off-label use.

### Real constraints found in source

- **Message size: 1000 bytes** per Noise message (`pubky-noise/src/snow_crypto.rs:9`, `PUBKY_NOISE_MSG_LEN = 1000`), minus JSON envelope. Chat text mostly fits; anything bigger — and all attachments — must use the pattern Paykit already uses for receipts: encrypted blob stored at a homeserver path + a small access message carrying location and decryption key over the link (`prepare_receipt` / `store_prepared_receipt` / `send_receipt_access`). An attachment kind is the same shape.
- **Session snapshots are secrets and currently serialize unencrypted** at the pubky-noise layer (`pubky-noise/src/lib.rs:627`: "TODO: encrypt serialized bytes with a key derived from pubky_root_keypair"). Paykit documents caller-managed encryption for snapshots and for `SdkBackupState` ("Store and transport it with caller-managed encryption", `paykit-sdk/src/backup/mod.rs`). Whoever holds the snapshot can decrypt the conversation.
- **Ciphertexts persist on homeservers under `/pub/paykit/v0/private/{receiver}/messages/{derived-hash}/…`**. `/pub/` is world-readable; privacy of _who talks to whom_ comes from unguessable DH-derived path components; message _content_ privacy comes from Noise. Transport uses ChaCha20-Poly1305 with explicit nonces, so history remains decryptable from stored ciphertexts given the session state — history recovery is a state-backup problem, not a re-handshake problem.
- **Homeserver write grant**: the messaging component needs a session grant covering `/pub/paykit/…`, which the app's existing `/pub/pubky.app/:rw` grant does not cover. One more Ring approval scope — same product-decision family already recorded in `service-auth.md`.

### Criteria verdicts

| Criterion              | Verdict                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser viability      | **Not directly.** No JS/WASM binding exists (`upstream-integration.md:80` confirms; verified in repo — `paykit-ffi` is UniFFI Swift/Kotlin only). Two honest topologies exist; see below.                                                                                                                                                                                                                     |
| Reimplement crypto?    | **No.** All crypto is Paykit Rust / pubky-noise / snow. The marketplace defines only JSON message kinds.                                                                                                                                                                                                                                                                                                      |
| Keys under constraint  | **Compatible.** Random receiver Noise secret, identity secret never needed; homeserver session via Ring-approved grant.                                                                                                                                                                                                                                                                                       |
| Multi-device / history | **Solvable but undecided.** Ciphertexts persist; `SdkBackupState` exists; but its encryption key is caller-managed — what the user recovers it with (passphrase, recovery file, Ring-mediated wrap) is an open product decision. A second device without the backup is a new receiver with no history.                                                                                                        |
| Operator-readability   | **Depends entirely on topology** (the crux — see below).                                                                                                                                                                                                                                                                                                                                                      |
| Maturity               | Pre-1.0 RC (rc43), README says "WIP - not for production". 393 commits, active changelog, security policy with private-disclosure channel, CI + coverage. Shipped inside Bitkit 2.4.0 (Android/iOS) per the marketplace's own audit. **No independent security review is claimed anywhere in the repo.** The marketplace already requires an independent review before real funds; messaging joins that gate. |
| Upstream demands       | Topology-dependent: browser topology needs an upstream WASM binding (real packaging work — see Candidate 2 compile evidence); both topologies benefit from an upstream-registered message-kind spec and closure of the snapshot-encryption TODO.                                                                                                                                                              |

### The topology fork (this is the human decision)

**(a) Marketplace-run Rust messaging adapter** ("Paykit BFF" per `upstream-integration.md:80`): a constrained Rust service using `paykit-sdk` holds each user's receiver Noise secret, session grant, and link snapshots, and exposes conversation APIs to the browser.

- Honest assessment: **the adapter operator can decrypt every message.** This does not fix operator-readability; it relocates it from "sandbox service memory" to "adapter key store," with better at-rest and on-path properties (peers, Nexus, homeserver operators see only ciphertext; the transaction service never sees bodies, preserving ADR-0019 §8). If built, the UI must say "encrypted in transit and at rest; the messaging service operator can read messages" — not "private."
- Cheapest to ship; reuses the exact service boundary that already exists for Locks/Paykit Server.

**(b) Browser-side Paykit via an upstream WASM binding**: compile `paykit-lib`(+ minimal SDK surface)/`pubky-noise` to wasm32 and ship it like `@synonymdev/pubky` and the Locks JS/WASM binding. Receiver Noise secret is generated in the browser and stored in account-scoped IndexedDB; crypto happens client-side; the operator never holds keys.

- Honest assessment: **this is the only topology that actually delivers "operator cannot read."**
- Verified feasibility evidence (not assumption): `cargo check -p pubky-noise --target wasm32-unknown-unknown` fails out of the box on `getrandom` 0.3 (needs `wasm_js` backend feature + cfg) and then on `ring`'s C build (needs a wasm-capable clang; pulled in via the `pubky` crate's TLS stack). Neither failure is API-shape-fundamental — `pubky` itself already ships a browser WASM package built from the same stack, and `pubky-noise`/`paykit-lib` have no tokio/socket dependencies of their own — but there is **no wasm target in either repo's CI and no binding crate**, so this is real upstream work someone must own, plus the same pin/checksum/vendoring discipline the Locks binding already requires.
- Multi-device then requires the backup-key product decision (what encrypts `SdkBackupState`).

**(c) Wait for a user-side Paykit runtime** (Bitkit companion messaging, or a future native client): no marketplace work now; messaging stays sandbox-only until the ecosystem provides a user-controlled runtime. Legitimate, since payments are already deferred on a comparable external dependency (a person with a Bitkit wallet).

---

## Candidate 2 — pubky-noise directly

### The `/Volumes/vibedrive` copy is disqualified

Its own README (June 2026): "**DEPRECATED AS A DEPENDENCY** … the official `pubky/pubky-noise` is the normative base … its Noise stack cannot interoperate with the official library … no new code may depend on this repository. Zero dependents." Everything the legacy README advertises (WASM-adjacent mobile managers, storage-queue feature, IK patterns, `ChaChaPoly_BLAKE2s`) describes a stack the official library deliberately does not share. Any assessment built on that README would be wrong about the real library.

### The official `pubky/pubky-noise`

A small (102-commit, v0.1.0-rc6) crate: Noise NN/XX over homeserver outboxes, `ChaChaPoly_SHA256`, 197-byte session snapshots, asymmetric path derivation, write-failure recovery, real e2e tests against ephemeral Pubky testnets. It is the layer Paykit's Encrypted Links are built on — its Cargo.toml describes it as "Fully-integrated Noise AE framework in pubky-sdk".

| Criterion              | Verdict                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser viability      | Same WASM facts as Candidate 1(b): no binding, no wasm CI; compile experiment shows packaging obstacles (getrandom backend, ring toolchain), not fundamental blockers.                                                                                                                                                                                                     |
| Reimplement crypto?    | No for the Noise layer itself — but see next row.                                                                                                                                                                                                                                                                                                                          |
| Keys under constraint  | Its raw API (`PubkyNoiseConfig`) wants a `pubky_root_keypair` and `path_derivation::derive_asymmetric_paths` wants the local Ed25519 _seed_. Paykit resolves this by feeding the _receiver Noise_ key as that seed. Using pubky-noise directly, the marketplace would have to make the same key-architecture decision itself — i.e. redesign what Paykit already designed. |
| Multi-device / history | Snapshots exist but everything above them (message framing, kinds, dedupe, backup schema) would be ours to invent.                                                                                                                                                                                                                                                         |
| Operator-readability   | Same topology fork as Candidate 1.                                                                                                                                                                                                                                                                                                                                         |
| Maturity               | Younger than Paykit (rc6 vs rc43), plus the open snapshot-encryption TODO. No independent review claimed.                                                                                                                                                                                                                                                                  |
| Upstream demands       | Same WASM work, _plus_ the marketplace would carry a bespoke messaging protocol on top.                                                                                                                                                                                                                                                                                    |

**Verdict: use it only through Paykit.** Building marketplace messaging directly on pubky-noise means designing message kinds, ordering/dedupe semantics, attachment semantics, receiver discovery, and backup — that is inventing an unreviewed protocol, which the task forbids and which Paykit has already done with review, tests, and a spec (`specs/`). Candidate 2 collapses into Candidate 1.

---

## Candidate 3 — Homeserver-mediated encrypted records

Assessed against the homeserver access model and pubky-app-specs:

- The Pubky homeserver has **no counterparty-readable private paths**: `/pub/` is world-readable; everything else is owner-session-only. There is no per-path ACL that could grant one counterparty read access. So "encrypted blobs the counterparty can read" necessarily means _ciphertext under `/pub/` at unguessable paths_ — which is exactly the pubky-noise outbox design (its path-derivation module exists precisely because `/pub/` is public).
- pubky-app-specs (including the marketplace fork) has **no message or conversation model** — models are user/post/tag/follow/mute/bookmark/file/blob/feed/last_read plus the marketplace's shop/listing/review. Adding an "encrypted message record" spec means specifying the encryption: key exchange, nonce discipline, replay, ordering — a protocol.
- The key exchange has no ecosystem primitive outside pubky-noise: `@synonymdev/pubky`'s `Keypair` exposes no signing or DH with the identity key (the `service-auth.md` finding), so browser-side ECDH against the counterparty identity key is impossible, and any fresh-key exchange scheme is hand-rolled protocol design.

**Verdict: blocked as an independent candidate.** Every honest instantiation of "encrypted records on homeservers with counterparty read" reinvents pubky-noise (forbidden as hand-rolled protocol design), and the properly reviewed instantiation of it _is_ Candidates 1/2. This candidate collapses into Candidate 1.

---

## Candidate 4 — Anything else the ecosystem provides

Surveyed, nothing qualifies:

- **Sealed Blob v2 / atomicity-core**: per the legacy pubky-noise README, that stack moved to `atomicity-core`/`atomicity-ffi` and serves Atomicity's messaging profile. It is not part of the marketplace's audited upstream set (`upstream-integration.md` audited-revisions table), has no browser binding, and adopting it would add a new upstream dependency for no capability Paykit lacks.
- **Locks**: entitlement infrastructure, explicitly "not custody, escrow, a marketplace guarantee, or a refund rail" — it has no user↔user messaging surface. Its role here is precedent: it proves the pinned-commit → wasm-pack → vendored-artifact pipeline the browser topology would reuse.
- **Paykit Server's "Pubky private messages"**: that is Paykit Server sending payment requests to Bitkit over the same Paykit encrypted links — evidence the transport works in the composed environment, not an alternative.
- **Chatwoot** (present in mp-launch): operator support chat; by definition operator-readable; not a candidate for buyer↔seller privacy.
- **Pubky App DMs**: do not exist; the app has no private-messaging feature to inherit.

No other reviewed encrypted transport exists in this ecosystem. Inventing one is out of scope by rule.

---

## Comparative summary

|                            | 1. Paykit encrypted links                                             | 2. pubky-noise direct                                      | 3. Homeserver encrypted records      | 4. Other   |
| -------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------ | ---------- |
| Browser viability          | Via adapter service today; via upstream WASM binding later            | Same WASM facts, worse layering                            | N/A (collapses into 1)               | None found |
| Crypto reimplementation    | None                                                                  | None for Noise; whole protocol layer above it becomes ours | Hand-rolled key exchange — forbidden | —          |
| No-identity-key constraint | Satisfied (random receiver key)                                       | Satisfiable only by re-deriving Paykit's key design        | Violated or hand-rolled              | —          |
| Multi-device / history     | `SdkBackupState`; backup key = product decision                       | Invent our own                                             | Invent our own                       | —          |
| Fixes operator-readability | Only in browser-WASM topology; adapter topology relocates it          | Same                                                       | Same                                 | —          |
| Maturity                   | rc43, shipped in Bitkit 2.4.0, security policy, no independent review | rc6, e2e-tested, snapshot-encryption TODO                  | No spec exists                       | —          |
| Verdict                    | **Only viable candidate; topology decision required**                 | Use only through Paykit                                    | Blocked / collapses into 1           | Nothing    |
