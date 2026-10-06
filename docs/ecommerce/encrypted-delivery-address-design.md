DESIGN STATUS: NEEDS-OWNER-INPUT (r4 = r3 + two Kimi round-3 P3 wording fixes; Kimi round 3 verdict SHIP-DESIGN)

# Encrypted buyer delivery address to seller

**Scope.** This design applies to Shop at `mp-ux` commit `17a21e77` and marketplace-service at `132a61a`. It follows the owner decision on BitcoinErrorLog/pubky-marketplace#12: encrypt the address in the buyer client, store only ciphertext the service cannot open, and decrypt in the seller client. The issue has no additional comments beyond that decision. This document is design-only.

V1 covers `checkout.create` orders only. Auction-won orders and offer flows remain conversation-based address exchange in v1 and must not accidentally gain a plaintext address path.

## A. Current data flow

| Field                                                                                 | Who writes it                                   | Stored today                                                                                                                                                                                                   | Who can read today                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout `deliveryAddress` (`name`, street lines, city, region, postal code, country) | Buyer form / saved-address selection            | Browser form, then `checkout.create` command (`src/hooks/useMarketplaceCheckout/useMarketplaceCheckout.ts:337-351`); no buyer homeserver address path was found — **UNVERIFIED** as an absence claim           | Buyer and scripts in the buyer tab before submit; the command recipient/service; not public by this client contract                                                                                                                                                       |
| Saved delivery address                                                                | Buyer after successful checkout, when opting in | Account-scoped browser IndexedDB through `CommerceController.commitUpsertDeliveryAddress` (`src/hooks/useMarketplaceCheckout/useMarketplaceCheckout.ts:250-274`); the exact Dexie table name is **UNVERIFIED** | Buyer in that browser profile; browser/device attacker with IndexedDB access; not seller, homeserver, or service under the observed call path                                                                                                                             |
| Order delivery address                                                                | Checkout handler                                | `orders.delivery_address JSONB` in service PostgreSQL (`crates/service/migrations/0001_init.sql:87-102`); handler serializes and inserts it (`crates/service/src/handlers/checkout.rs:189-192,276-328`)        | Service operator/DB readers; checkout response initially includes `order.view()` (`crates/service/src/handlers/checkout.rs:400-405`), so buyer; ordinary order projections remove it (`crates/service/src/model.rs:356-367`), so seller does not receive it through reads |
| Order address in server model                                                         | Service DB reader                               | `OrderRow.delivery_address: Option<Value>` (`crates/service/src/model.rs:270-289`)                                                                                                                             | Any service code with `OrderRow`, including Shippo label flow; not public in `projection()`                                                                                                                                                                               |
| Shippo destination object                                                             | Service shipping endpoint                       | In process only while converting `order.delivery_address` to Shippo JSON (`crates/service/src/shipping.rs:477-512`)                                                                                            | Service process/operator at runtime and Shippo; seller receives quoted rates, not shown address in this code                                                                                                                                                              |
| Purchased shipping label metadata/URL                                                 | Service                                         | `orders.shipping_label` (`crates/service/src/model.rs:334-338`; update at `crates/service/src/shipping.rs:562-584`)                                                                                            | Seller-only label endpoint (`crates/service/src/shipping.rs:609-646`); Shippo label PDF/URL embeds the address by design; service operator can read its database                                                                                                          |
| Pasted packing-slip address                                                           | Seller                                          | React component state only; cleared on close, print completion, and route change (`src/hooks/usePackingSlipAddress/usePackingSlipAddress.ts:16-49`)                                                            | Seller tab and print/PDF destination; intentionally not the service, homeserver, or IndexedDB                                                                                                                                                                             |

`shipping_minor` is a price field, not address data: it is computed from seller-published shipping options in the service (`crates/service/src/homeserver.rs:233-295`) and stored on `orders` (`crates/service/src/model.rs:287-290`).

## B. Threat model

After this change, a valid address envelope protects plaintext from public readers, homeserver operators, marketplace-service operators, and a later compromise/export of the marketplace service DB. The service still sees metadata required to route the order: order UUID, buyer and seller pubkys, listing/line data, fulfillment, and the ciphertext length. It must not receive an address-derived shipping quote or any plaintext fallback.

Plaintext remains visible to the buyer while entering and retaining an address; to the seller after a successful client-side decrypt; to same-origin malicious script/extensions/XSS in either browser while plaintext or the seller private key is usable; to the browser/OS print subsystem and any print-to-PDF file; and to Shippo when a seller uses Shippo to quote or buy a label. This does not hide order existence, parties, purchase information, IP/network metadata, ciphertext timing/size, or the fact that Shippo was used. It does not make a malicious seller harmless: the seller is the intended recipient.

The seller delivery-key record is authenticated only by homeserver path ownership. A malicious or compromised seller homeserver (or any holder of a seller session grant covering the key path, including XSS in an origin holding a broad grant) can substitute the key document at fetch time and receive addresses sealed to it; TOFU pinning (§C) provides cross-order detection, not prevention. Separately, the envelope is unauthenticated at the crypto layer: the seller cannot prove to a third party that the buyer authored a ciphertext, the recipient can forge a valid envelope for an order it can read, and the buyer cannot prove which plaintext they sealed. Buyer authentication for the order is provided solely by the marketplace bearer session (`docs/ecommerce/status.md:25`); the service-stored envelope is the only committed evidence in a dispute.

Padding is mandatory: before sealing, pad the canonical plaintext to the next 512-byte bucket, with 1,024 bytes the maximum padded plaintext. The padding format is specified in §D (0x80 then zeros to the bucket boundary) and is covered by shared vectors; an over-limit plaintext is rejected rather than truncated. The ciphertext length side channel is consequently limited to the two buckets plus envelope metadata.

## C. Key model and recommendation

### Recommendation: seller-published app-scoped X25519 public key

Publish a versioned seller encryption-key document at a marketplace public homeserver record controlled by the seller's authenticated session. The seller browser generates a random X25519 keypair locally. It publishes only `{v, keyId, publicKey, createdAt, revokedAt?}`. It stores the private key as an account-scoped encrypted IndexedDB record using the existing device-keyring AES-GCM storage pattern documented for messaging: receiver Noise material is wrapped under a non-extractable device key before IndexedDB (`docs/ecommerce/paykit-wasm-provenance.md:128-133`). The exact reusable module/API and its backup semantics require code confirmation.

The key record lives on a marketplace-specific path with its own Ring capability, not under the standing `/pub/pubky.app/:rw` grant; follow messaging’s separate `/pub/paykit/:rw` approval precedent (`docs/ecommerce/messaging/README.md:38`). A service must never author, substitute, or proxy the key.

Buyer-side TOFU pins `(sellerPubky → kid, key fingerprint, firstSeenAt)` in account-scoped Dexie. On key change, show the fingerprint difference and require explicit re-confirmation before sealing. A previously retired `kid` reappearing is a hard failure. Require monotonic `createdAt`; a rollback warns and requires re-confirmation.

This is a deliberately device-bound v1 key: a seller may decrypt on the device that generated/imported the key. On a second device, onboarding must either import a seller-exported encrypted key package through an explicit recovery ceremony or generate a new key epoch; do not silently copy a raw secret through homeserver storage. The existing messaging documentation states that its multi-device backup-key decision is open (`docs/ecommerce/messaging/README.md:13`), so it cannot be claimed as an address-key backup solution. A lost private key means previously encrypted undelivered addresses cannot be recovered; seller UI must say that before replacing/revoking a key. The safe recovery outcome is seller/buyer contact and buyer re-encryption only while their local plaintext/saved address remains available; no service escrow.

Rotation publishes a new `keyId`, retains the previous private key locally until every associated shippable order is terminal, and marks the old public key retired rather than deleting it. Buyers fetch the current key immediately before creating each seller order and include `keyId` in the envelope. A seller with no active key makes shipping checkout unavailable for that seller: show “This seller has not set up encrypted delivery. Remove this shipping item or ask the seller to finish setup.” Pickup-only orders remain address-free. A key document must be written only with a seller-authenticated homeserver session; the service must never author, substitute, or proxy the key.

### Rejected: derive an encryption key from Ring/Bitkit identity

Reject for v1. The code/docs establish that Shop normally receives Ring/bridge sessions and that the identity secret does not enter the browser for the existing encrypted messaging path (`docs/ecommerce/status.md:33`). The messaging path instead creates a receiver-scoped key in-browser (`docs/ecommerce/paykit-wasm-provenance.md:128-133`). No verified code path exposes an authorized deterministic X25519 derivation from the seller's Ed25519 identity secret to Shop. Ed25519 signing authentication is not an authorization to export or repurpose its signing seed. Do not add a conversion/derivation scheme.

### Rejected: Paykit Noise Encrypted Link delivery

Reject for address delivery: the existing Paykit Noise Encrypted Link requires an interactive XX handshake, both parties enrolled, and no store-and-forward delivery property (`docs/ecommerce/status.md:33-34`).

### Rejected: service-mediated escrow

Escrow would give the marketplace service a decryption capability, contradicting the owner’s “stored only as ciphertext the service cannot open” decision. It is justified only by an explicit owner reversal for cross-device recovery or server-side Shippo, neither of which this design assumes.

## D. Envelope and storage

Use an audited hybrid construction, not bespoke crypto: ephemeral X25519 Diffie-Hellman, HKDF-SHA-256 with a domain-separated salt/info, then XChaCha20-Poly1305 AEAD. `@noble/curves` is already declared as `^2.3.0` (`package.json:59`) and provides X25519; however its exact installed version and whether an already-vendored client AEAD API is suitable have not been verified — **UNVERIFIED**. `chacha20poly1305` is already a service dependency (`crates/service/Cargo.toml:10-18`, workspace version `0.10` at `Cargo.toml:21`), but the service must never decrypt this envelope. The browser AEAD provider is @noble/ciphers (same author/family as the already-declared @noble/curves and @noble/hashes at package.json:59-60); it is not yet declared and must be ADDED and pinned to an exact reviewed version in the buyer/seller slice, with interoperable vectors run before the slice is gated; do not write crypto primitives.

`@noble/ciphers` is added and pinned to an exact reviewed version as the browser AEAD provider; `@noble/curves` supplies X25519, while the pinned ciphers package supplies XChaCha20-Poly1305.

Suggested wire value, encoded as strict JSON:

```json
{
  "v": 1,
  "alg": "X25519-HKDF-SHA256-XCHACHA20POLY1305",
  "kid": "base64url-random-key-id",
  "epk": "base64url-32-byte-ephemeral-public-key",
  "nonce": "base64url-24-byte-nonce",
  "ct": "base64url-ciphertext-and-16-byte-tag"
}
```

The AAD is a fixed byte layout, not JSON: `DOMAIN || u16be(orderId_len) || orderId_utf8 || sellerPubky_raw32 || buyerPubky_raw32 || u8(count) || for each listingAggregateId, sorted lexicographically by UTF-8 bytes and deduplicated: u16be(len) || bytes`, where `DOMAIN = "pubky-marketplace.delivery-address/v1"`, orderId is the canonical lowercase hyphenated UUID string, and pubkys are the decoded 32-byte keys (not z-base-32 text). HKDF-SHA-256: `salt = empty`, `info = DOMAIN || 0x00 || kid || seller_static_x25519_pk` (transcript/key binding). Test vectors in both implementations are a release gate (§I docs/vectors slice).

The buyer must generate the order UUID client-side before sealing, and the service must validate that the submitted UUID is the ID it persists; current service code generates IDs after receiving plaintext (`crates/service/src/handlers/checkout.rs:250-252`), so this is a required contract change. UUIDs are v4 only and the service validates version and variant; a duplicate order UUID is a clean `INVALID_COMMAND` rejection on the orders-PK conflict, never an upsert or 500. Existing idempotency remains scoped to `checkout_command_id`. The service must validate that every listed aggregate maps to the order’s seller and exact lines before storing. This prevents replay to a different order, seller, buyer, or listing set.

Cap canonical plaintext at 1,000 UTF-8 bytes and envelope JSON at 2,048 bytes; reject malformed base64url, unknown fields/version/algorithm, non-32-byte `epk`, non-24-byte nonce, or a ciphertext whose length is not exactly 528 or 1,040 bytes (the two padding buckets plus the 16-byte Poly1305 tag; any other length is rejected before AEAD open). Store the ciphertext envelope in `orders.delivery_address_ciphertext` (JSONB or bounded TEXT) and never in the current plaintext `delivery_address`. Buyer keeps the entered/saved address only in its existing local address book by opt-in, and keeps no plaintext order-address copy beyond form state unless it chooses a saved address.

Canonical plaintext (≤ 1,000 UTF-8 bytes) is followed by a single `0x80` byte then `0x00` bytes up to the next bucket boundary (512 or 1,024); the seller client, after AEAD open, strips from the last `0x80` and rejects if no `0x80` is present or any byte after it is non-zero; the padding bytes are inside the AEAD plaintext, so they are integrity-protected; padding vectors are part of the shared test vectors gated in §I.

## E. State machines and credential provenance

### Buyer

1. **Address entered** → validate locally; selected saved address only fills the same form (`src/hooks/useMarketplaceCheckout/useMarketplaceCheckout.ts:150-177,237-245`).
2. **Seller key discovery** → read public seller key document directly from homeserver; reject absent, malformed, expired, non-current, or identity-mismatched document.
3. **Order identity allocated** → generate UUID(s), one per `(seller, fulfillment)` group; pickup groups allocate an order but no envelope.
4. **Envelope sealed** → bind the exact group/order AAD; discard transient plaintext after request construction.
   Pad per §D (0x80 then zeros to the 512/1,024 bucket) before sealing.
5. **Checkout submitted** → marketplace session bearer authorizes the service command. Provenance: Ring/bridge signer mints an AuthToken; service exchanges it for an opaque marketplace bearer (documented at `docs/ecommerce/status.md:25`). The bearer authenticates actor/request; it is not an encryption key and must not be included in ciphertext/AAD.
6. **Accepted** → service stores ciphertext atomically with order. **Key changed before submit / typed refusal** → refetch once, re-seal from in-memory form, show a confirmation that destination-key changed; never retry with a different seller identity. **Buyer edit after sealing** → invalidate envelope and re-seal; no “edit order” mutates an existing ciphertext.

### Seller

1. **No active key** → settings requires key creation/import before enabling shipping checkout.
2. **Active key / order notification** → service notification contains order metadata only; notification insertion explicitly forbids address-bearing data (`crates/service/src/handlers/mod.rs:193-203`).
3. **Order received** → seller client loads seller-authorized order projection plus its ciphertext envelope through a seller-only endpoint. The current projection strips `delivery_address` (`crates/service/src/model.rs:356-367`); adding an envelope must not accidentally make it public or buyer-readable.

Model the ciphertext endpoint on the existing seller-scoped label endpoint (`crates/service/src/shipping.rs:611-649`, actor check at 632): it must compare the authenticated actor to `order.seller_pubky` and reject a non-seller. Never add the envelope to `OrderRow::view()` or `projection()` for non-sellers. The buyer’s own checkout result may echo the envelope because the buyer authored it.

4. **Decrypt** → confirm AAD against returned order facts before rendering. Unknown `kid`, authentication failure, malformed envelope, or unavailable private key is a hard failure: do not show a guessed address or call Shippo.
5. **Packing slip** → render decrypted address in local component state; existing pasted-address behavior is local-only and clears after printing (`src/components/organisms/Marketplace/MarketplacePackingSlipDialog.tsx:16-33,150-172`).
6. **Shippo** → seller browser, not service, submits the seller’s own Shippo request or accesses a Shippo-hosted flow. Current server-side Shippo uses server-held seller token and plaintext `order.delivery_address` (`crates/service/src/shipping.rs:420-512`), so it is incompatible and must be disabled/migrated before this feature is enabled.

Key provenance: seller browser mints encryption keypair; seller-authenticated homeserver session writes public half; only the seller device imports/generates private half; buyer reads public half; buyer browser mints ephemeral key and ciphertext; service stores/routs ciphertext but owns no decryption credential; Shippo receives plaintext only from the seller-side label action.

## F. Service impact, migration, and rollout

- Replace `orders.delivery_address JSONB` for newly created shipped orders with `delivery_address_ciphertext` plus `delivery_key_id`; make plaintext null. Update `OrderRow`, `ORDER_COLUMNS`, checkout insert, command schema/domain models, serializers, and all test fixtures. Current inserts are at `crates/service/src/handlers/checkout.rs:310-339`; current read model is at `crates/service/src/model.rs:270-367`.
- `orders.delivery_address_epk BYTEA` (32 bytes, NULL for plaintext/legacy rows) with a `UNIQUE` index (partial, `WHERE delivery_address_epk IS NOT NULL`); the service extracts `epk` from the validated envelope and writes it in the same transaction as the ciphertext; a unique-violation is surfaced as `INVALID_COMMAND` (same clean path as the order-UUID conflict).
- Remove service-side address use from `quote_shipping_rates` and `purchase_shipping_label`; it currently performs the plaintext conversion at `crates/service/src/shipping.rs:477-512`. Do not merely encrypt the column then decrypt in the service.
- Preserve the no-address notification rule; it is already explicit (`crates/service/src/handlers/mod.rs:193-203`). Audit events, IPN/webhooks, error strings, tracing, metrics, and label metadata so no address is copied there. Their full absence is **UNVERIFIED**.
- Existing plaintext rows: keep only for legally/operationally required in-progress fulfillment, with a service-enforced terminal-state purge deadline. The exact deadline is owner input. New ciphertext-only service must never offer legacy plaintext to a new endpoint. Before purge, restrict the legacy Shippo path to legacy rows and seller authorization; do not coerce plaintext into a seller envelope because the seller key might be absent and the migration would create a new trust event.
- Shippo launch behavior is an owner decision. If Shippo must work at launch, implement seller-client direct Shippo interaction without transmitting a Shippo token/address through marketplace-service, or retain the legacy server path only for legacy plaintext orders. A service-side proxy necessarily sees the destination and violates this design.

Scrub upstream Shippo rejection text before logging or returning it: carrier validation errors can echo submitted address fields into logs. Errors returned to callers use stable, non-address-bearing categories.

**Rollout, in order:** (1) service deploy accepts BOTH plaintext and validated ciphertext for new orders — no behavior change for legacy clients; (2) client ships seller key lifecycle + seller decrypt/packing slip; (3) client ships buyer sealing behind a runtime flag, active only for seller groups whose published key passed discovery — groups without a key fall back to the transition behavior chosen by the owner (legacy plaintext with disclosure, or shipping checkout unavailable per §C); (4) after an adoption threshold, a service flag rejects plaintext for new rows (v2 command schema + DB check). Step 3 must never activate before step 2 ships; step 4 is the only irreversible step and is an owner decision.

## G. UX

Add **Get Paid → Delivery privacy** settings: “Create delivery key” explains device custody, loss risk, rotation, and multi-device limitation before generation. Show active key fingerprint/key ID, creation date, “retire and replace” (requires loss warning), and an explicit import/recovery entry only once such a verified format exists.

Retire the interim Cart copy: “Your delivery address is sent with your order and shown only to the seller of that order. Encrypting it to the seller’s key is scheduled.” (`src/components/templates/Marketplace/MarketplaceCart.tsx:320-324`). Replace it only after the end-to-end gate passes with “Encrypted to this seller’s delivery key. The marketplace service cannot read it.”

Seller failures: “This delivery address cannot be opened on this device. Do not ship yet. Restore the key that received this order or contact the buyer through the order conversation.” Never ask the buyer to paste an address into a service form. The packing slip receives a decrypted address as an in-memory prop/state and retains the existing print/PDF warning; it must remove the “pasted delivery address” normal workflow once decrypted rendering ships.

The decrypted packing-slip render must warn where the seller initiates printing that browser and OS print systems, printer queues, print previews, and print-to-PDF destinations can retain a plaintext address after the component clears its in-memory state.

## H. Self-attack table

| Attack                                                                 | Required control / gate                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replay ciphertext onto another order                                   | Exact fixed AAD includes order UUID, parties, and listing IDs; wrong AAD makes AEAD open fail (fail closed)                                                                                                                                                                                   |
| Downgrade a shipping order to plaintext                                | v2 command schema rejects `deliveryAddress`; DB constraint/check rejects non-null plaintext for new rows; deliberate plaintext request fails                                                                                                                                                  |
| Malicious seller key swap                                              | Buyer fetches immediately before submit; show seller fingerprint/key change; require seller-authenticated homeserver write and preserve key epochs                                                                                                                                            |
| Service substitutes key                                                | Client reads seller homeserver record directly, validates owner path/signature/authorship, binds seller pubky and key ID in AAD; integration test substitutes service response and proves no effect                                                                                           |
| Seller loses private key                                               | Explicit device custody/recovery UX; no escrow; decryption failure is safe-stop, not plaintext fallback                                                                                                                                                                                       |
| XSS exfiltrates seller plaintext/key                                   | CSP/dependency hygiene remain necessary; at-rest wrapping does not protect live same-origin JS; minimize plaintext lifetime and do not claim XSS protection                                                                                                                                   |
| Buyer edits after encryption                                           | Form mutation invalidates envelope; submission creates fresh order UUID/envelope; test edited address differs after decrypt                                                                                                                                                                   |
| Key published by non-owner                                             | Homeserver write requires seller session with narrow path grant; client verifies record owner equals seller pubky; unauthorized publish fails                                                                                                                                                 |
| Ciphertext/parser resource exhaustion                                  | Strict JSON/base64/byte caps before cryptographic work; oversized or unknown-field envelope fails                                                                                                                                                                                             |
| Legacy plaintext endpoint leak                                         | Separate legacy-only route/retention, redaction tests, deadline purge; grep/contract tests assert new order has null plaintext                                                                                                                                                                |
| Garbage-ciphertext griefing (buyer sends undecryptable envelope)       | Ordinary orders hold no stock until payment starts (status.md:26 inventory rule), but the bounded payment window and drop lock-at-claim (`DROP_CLAIM_WINDOW_SECONDS`) burn scarce slots; define a decrypt-failure cancel/refund path and rate-limit checkout; owner policy for drop-slot burn |
| Seller falsely claims "cannot decrypt" to stall                        | Order state machine needs a decrypt-failure/dispute path; the service-stored envelope is the only committed evidence (no third party can verify without the seller key — disclosed in §B)                                                                                                     |
| Ephemeral key/nonce reuse across envelopes                             | Fresh X25519 keypair + fresh 24-byte nonce per envelope, never persisted; service rejects a duplicate `epk` across orders; test asserts two envelopes never share `epk`                                                                                                                       |
| Homeserver substitutes or rolls back the seller key record             | Buyer TOFU pin (§C); `createdAt` monotonicity check; warn + require re-confirmation on change                                                                                                                                                                                                 |
| Seller session with a broad pre-existing grant overwrites the key path | Key record lives on a marketplace-specific path with its own Ring capability (precedent: messaging’s `/pub/paykit/:rw`), not under the general app grant                                                                                                                                      |

## I. Implementation slices

| Slice (one agent)                 | Scope / hot files                                                                                                                                                                                                     | Proof command                                                                                                              | Required FAIL calibration                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Client key lifecycle              | Public key record, seller settings, encrypted local private-key storage, key discovery. Touches **W1.x one-approval** only if a new homeserver capability is necessary; otherwise avoid it.                           | Focused Vitest key storage/discovery suite, then `npm run typecheck`                                                       | Attempt publish with wrong seller identity; malformed/retired key unavailable at checkout                                |
| Client envelope + checkout        | Envelope module, canonical AAD, UUID-before-seal contract, Cart UX. Touches **W1.x `MarketplaceCart`** and likely one-approval only if scope changes.                                                                 | Real-crypto known-answer and tamper tests; `npm run test -- --project unit` narrowed to changed tests; `npm run typecheck` | Wrong order/seller/buyer/listing AAD fails; plaintext `deliveryAddress` request rejected                                 |
| Service ciphertext contract       | Migration, checkout validation/store/read endpoint, redactions, legacy separation.                                                                                                                                    | `cargo test -p marketplace-service`; `cargo clippy -p marketplace-service --all-targets`                                   | Raw DB/order JSON contains no plaintext for a new order; malformed/oversize ciphertext and mismatched actor are rejected |
| Service duplicate `epk` rejection | Validate the envelope ephemeral public key and calibrate the duplicate rejection; the `delivery_address_epk` column and its partial UNIQUE index ship in the Service ciphertext contract slice's migration, not here. | `cargo test -p marketplace-service`; `cargo clippy -p marketplace-service --all-targets`                                   | submit two orders with the same `epk`; the second must be rejected with `INVALID_COMMAND` and no ciphertext row written  |
| Seller decrypt + packing slip     | Seller-only fetch/decrypt, local display/print lifecycle; remove paste-as-normal path.                                                                                                                                | Focused Vitest component + crypto tests; `npm run typecheck`                                                               | Wrong `kid`/tag cannot render or trigger Shippo/print address                                                            |
| Shippo migration                  | Disable server plaintext Shippo path for ciphertext orders; add seller-client direct path only if owner requires it.                                                                                                  | Service/client focused tests and an integration fixture with a fake Shippo endpoint                                        | Ciphertext order cannot cause server to call Shippo with any address; legacy-only behavior rejected for new row          |
| Docs and protocol vectors         | ADR/spec, exact wire vectors, privacy and recovery UX copy.                                                                                                                                                           | Parser/vector tests in both client and Rust where applicable                                                               | Version 0/2, altered field order/AAD, and malformed vector rejected                                                      |
| External audit                    | Kimi audit after implementation, plus a strongest-tier state-machine review before/after first implementation.                                                                                                        | OpenCode newest Kimi verdict plus rerun relevant proofs                                                                    | Audit prompt includes a deliberately insecure plaintext fallback/key-substitution diff and must flag it                  |

| Rollout sequencing | Four flags/releases: dual-format service acceptance, seller lifecycle/decrypt, buyer sealing flag only after seller ship, then owner-authorized plaintext retirement | Service/client focused tests and flag-gated release checks | Runtime-flag attempt before seller decrypt ships is blocked; groups without a key follow the owner-selected transition behavior |
| Test vectors in both implementations | Fixed AAD/KDF and envelope vectors are a release gate in browser and Rust implementations | Browser and Rust parser/vector tests | Successful vector plus malformed, tampered, wrong-AAD, wrong-version, and altered-layout vectors reject |

The existing Service ciphertext contract slice must additionally calibrate duplicate client UUID → clean `INVALID_COMMAND` rejection. The Client key lifecycle slice must calibrate retired `kid` rejected at checkout. The Client envelope + checkout slice must calibrate substitute-key AND rollback-key responses have no effect.

Every slice must use real production components/handlers, no mocked crypto seam; envelope tests need one calibrated failure before any passing baseline. Kimi external audit is mandatory because this changes keys, privacy, auth-adjacent access, and cryptographic handling.

## J. Owner questions

J4 merges r1 J4 into J3; Kimi questions 5–8 are renumbered J4–J7.

1. Must the Shippo integration remain available when ciphertext-only orders launch? If yes, choose seller-direct Shippo (recommended) versus an explicit relaxation of the no-service-plaintext rule.
2. What exact terminal-state retention/purge deadline is acceptable for legacy plaintext orders, including disputes/returns?
3. Is v1 acceptable as device-bound seller decryption with deliberate key import/recovery deferred, or is a multi-device recovery experience a launch requirement? If yes, should a buyer be able to re-send to a rotated seller key after payment, and what order state/consent must constrain that action?
4. Transition-window behavior for sellers without a published key: legacy plaintext with disclosure, shipping checkout unavailable (the §C default — adoption impact?), or buyer choice? This gates rollout step 3.
5. Scope confirmation: auction-won and offer-accepted shipped orders (`auction.rs:412,422` carries no address today) stay conversation-based in v1?
6. Coarse-destination (country + postal code) server-side Shippo rate quotes for ciphertext orders — acceptable privacy trade, or does §B’s no-address-derived-quote rule stand absolute?
7. Buyer-facing key-pinning change warnings (TOFU) — acceptable friction?
   J8. What policy should govern drop-slot burn by undecryptable envelopes: auto-release the slot on seller `cannot_decrypt` after N minutes, hold until buyer re-sends, or count it against the buyer?

## Changes from r1

- P1-1 → §B; P1-2 → §D; P1-3 → §F, §I; P1-4 → §H.
- P2-1, P2-2 → §D; P2-3, P2-4 → §C; P2-5 → Scope, §E; P2-6 → §E.
- P3-1 → §D; P3-2 → §F; P3-3 → §B; P3-4 → §G; P3-5 → §C.

## Changes from r2

- Padding bucket lengths, format, and buyer sealing are specified in §B, §D, and §E.
- Duplicate `epk` persistence and rejection are specified in §F and §I.
- Browser AEAD provider declaration and pinning language are aligned in §D.
- Drop-slot burn policy is added as owner question J8.
- The design status reflects Kimi r1+r2 folding.

DESIGN STATUS: NEEDS-OWNER-INPUT

The encrypt-to-seller decision is implementable without giving the marketplace service a decrypting credential: a seller-owned, versioned X25519 key record plus buyer-side hybrid encryption can bind each address to one order and let the seller decrypt only in their browser. The two unresolved product constraints are material: current Shippo code is server-side and consumes plaintext, and the appropriate retention deadline for existing plaintext orders is not a code question. Until those are decided, implementation must not claim that operators cannot read addresses or silently preserve a plaintext fallback.
