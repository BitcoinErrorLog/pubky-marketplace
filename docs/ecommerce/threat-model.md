# Pubky Marketplace Threat Model

Status: active
Reviewed baseline: 2026-08-19

## Scope

This threat model covers:

- Pubky App marketplace browser/PWA;
- Next.js server routes used as a narrow browser-facing proxy;
- Marketplace Transaction Service and PostgreSQL;
- Pubky homeserver/Nexus public catalog data;
- Locks browser SDK, Lock Server, and its PostgreSQL database;
- Paykit Server, Paykit private messaging, Bitkit, Electrum, and Bitcoin observations;

## Security objectives

1. A user can act only as their authenticated Pubky identity and authorized role.
2. A user can access only public data or private objects in which they are an authorized participant.
3. One unit, accepted offer, auction, order, payment fact, refund, and ledger posting cannot be created twice.
4. The browser cannot forge price, inventory, winner, settlement, refund, guarantee, or payout facts.
5. Public Pubky records cannot expose private commerce data.
6. Pubky secrets, wallet secrets, xpubs, Paykit/Locks secrets, bearer credentials, delivery details, messages, and evidence do not enter telemetry.
7. A failed dependency, delayed event, restart, replay, or restore fails safely without inventing finality.
8. Digital content is released only after a valid Locks entitlement and hash verification.
9. Supply-chain and runtime configuration are pinned, validated, and fail closed.

## Assets and classification

| Asset                                            | Classification                               | Authority                                | Required protection                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | -------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pubky recovery phrase/private key                | Secret; prohibited from marketplace systems  | User/Ring                                | Never received, stored, logged, or requested                                                                                                                                                                                                                                                                                                                                                                                                      |
| Short-lived Pubky auth assertion                 | Sensitive credential                         | Auth issuer                              | Audience/nonce/expiry binding, replay prevention                                                                                                                                                                                                                                                                                                                                                                                                  |
| Public shop/listing/review                       | Public, signed                               | Owner homeserver                         | Signature/source validation, version/tombstone handling                                                                                                                                                                                                                                                                                                                                                                                           |
| Drafts/cart/saved search                         | Private local                                | Origin-scoped Dexie (`franky`)           | Shared IndexedDB name for the origin, not per-pubky; identity isolation is keyed wipe on sign-out/switch under the auth-finalization lock; purge/export, quota recovery                                                                                                                                                                                                                                                                           |
| Messaging receiver Noise secret + link snapshots | Secret key material (decrypts conversations) | Account-scoped Dexie (this browser only) | AES-GCM-256 wrap at rest under a non-extractable keyring CryptoKey, AAD-bound to table + row id; wiped on sign-out; a lost wrapping key makes rows unrecoverable (treated as lost, user re-enables); never synced, exported, or logged; the wrap protects against at-rest IndexedDB/disk dumps and cross-profile copying, but NOT against same-origin script execution (XSS, malicious dependency), which can invoke the unwrap path — see WEB-02 |
| Delivery/contact details                         | Restricted personal data                     | Transaction Service                      | Encryption, participant authorization, redacted support views                                                                                                                                                                                                                                                                                                                                                                                     |
| Messages/offers/evidence                         | Restricted private content                   | Transaction/encrypted messaging service  | Participant ACL, safe attachments, retention policy                                                                                                                                                                                                                                                                                                                                                                                               |
| Order/event/ledger state                         | Integrity-critical                           | Transaction Service/PostgreSQL           | Serializable command handling, constraints, immutable audit                                                                                                                                                                                                                                                                                                                                                                                       |
| Locks `bundle_id`/access credential              | Bearer secret                                | Viewer/Lock Server                       | Service seals `bundle_id` at rest and looks up via HMAC. Client `commerce_locks_correlations` is plaintext in origin-scoped Dexie (`franky`) — not encrypted, not named per pubky or per bundle id; isolation is identity-keyed wipe on sign-out/switch. No URLs/logs, bounded exposure                                                                                                                                                           |
| Locks creator frontend session                   | Sensitive credential                         | Lock Server                              | Account-scoped secure storage, clear on sign-out                                                                                                                                                                                                                                                                                                                                                                                                  |
| Paykit receiver/Noise state                      | Secret                                       | Paykit Server/Bitkit                     | Never exposed to web app or generic API                                                                                                                                                                                                                                                                                                                                                                                                           |
| Bitkit account xpub/index                        | Highly sensitive metadata                    | Bitkit/Paykit Server                     | Companion-claim path only; prohibited from app storage/telemetry                                                                                                                                                                                                                                                                                                                                                                                  |
| Payment address/correlation/status               | Restricted financial metadata                | Paykit Server/Locks                      | Narrow signed APIs, opaque client status                                                                                                                                                                                                                                                                                                                                                                                                          |
| Logs/traces/metrics/backups                      | Sensitive operational data                   | Operator                                 | Redaction, access control, retention, encrypted backup                                                                                                                                                                                                                                                                                                                                                                                            |

## Trust boundaries

```text
Untrusted browser
  | Pubky auth assertion + HTTPS
  v
Next.js BFF (optional)
  | service-authenticated HTTPS
  v
Marketplace Transaction Service ----> PostgreSQL
  |                                        |
  | adapters                               | encrypted backup/restore
  v                                        v
Lock Server ----signed----> Paykit Server ----> Electrum/Bitcoin
  |                             |
  v                             v
Homeserver                  Paykit/Bitkit private messaging

Public browser ----> Pubky public storage/Nexus
Staff browser ----step-up----> role-scoped admin API
```

Assumptions:

- Browser code, local storage, IndexedDB, service workers, extensions, and client clocks are untrusted.
- Next.js route handlers may be restarted or replicated and are not transaction authority.
- Public homeserver/Nexus data is untrusted until schema, owner, path, and revision/source are validated.
- External callbacks are untrusted until signature, audience, timestamp/replay window, and correlation are validated.
- Locks and Paykit are pre-production dependencies whose current documented limitations are enforced in product policy.

## Threat register

### Identity and authorization

| ID      | Threat                                        | Impact                                   | Required mitigation and evidence                                                                                                                                                                                                                                               |
| ------- | --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AUTH-02 | Replayed assertion or command                 | Duplicate transaction or stale privilege | One-time nonce/session binding; actor-scoped command ID; replay tests                                                                                                                                                                                                          |
| AUTH-03 | Confused-deputy assertion for another service | Unauthorized marketplace access          | Exact audience and origin binding; wrong-audience tests                                                                                                                                                                                                                        |
| AUTH-04 | IDOR through order/listing/message IDs        | Private data disclosure or mutation      | Object participation checked after lookup on every route; cross-user matrix tests                                                                                                                                                                                              |
| AUTH-05 | Stale suspension or revoked session           | Restricted user continues transacting    | Server-side role/status checks per command; revocation propagation test                                                                                                                                                                                                        |
| AUTH-06 | Account switch leaks Dexie projections        | Private data disclosure                  | Origin-scoped Dexie (`franky`); identity-keyed wipe on sign-out/switch under the cross-tab `navigator.locks` finalization lock, keyed to `AUTH_PERSIST_KEY` pubky (Zustand is per-tab); no-op if persist blob or live store holds a different identity; not per-pubky DB names |

### Public catalog and media

| ID     | Threat                                                 | Impact                               | Required mitigation and evidence                                                               |
| ------ | ------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| CAT-01 | Listing source/path spoofing                           | Buyer sees attacker-controlled terms | Validate owner Pubky, canonical path, schema version, and signature/source                     |
| CAT-02 | Stale Nexus listing remains purchasable                | Wrong price or oversell              | Transaction Service revalidates listing snapshot/version and stock at command time             |
| CAT-03 | Seller edits terms after order                         | Buyer loses purchased terms          | Immutable server-side order snapshot and hash; mutation tests                                  |
| CAT-04 | Unsafe HTML/URL                                        | XSS, phishing, unsafe redirect       | Plain/allowlisted rendering, safe URL parser, CSP, link warning, security tests                |
| CAT-05 | MIME spoof, decompression bomb, metadata leak, malware | Client compromise or privacy leak    | Signature/MIME/size/dimension limits, isolated processing, metadata stripping, rejection tests |
| CAT-06 | Prohibited item bypass by edit/import/variant          | Policy violation                     | One server-side policy validator shared by create/edit/import with versioned rules             |

### Transaction concurrency and integrity

| ID    | Threat                                 | Impact                                         | Required mitigation and evidence                                                |
| ----- | -------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| TX-01 | 100 buyers reserve one unit            | Oversell                                       | PostgreSQL transaction/constraint; concurrency test yields exactly one winner   |
| TX-02 | Offer acceptance races public sale     | Two buyers believe they won                    | Shared inventory aggregate/revision; one atomic reservation                     |
| TX-03 | Duplicate checkout or callback         | Duplicate order/payment event                  | Actor-scoped idempotency record, canonical input hash, unique constraints       |
| TX-04 | Changed replay under same command ID   | Confused result or tampering                   | Exact canonical request hash; conflict response; adversarial replay test        |
| TX-05 | Stale expected revision                | Lost update                                    | Compare expected/current revision atomically; return current projection         |
| TX-07 | Fractional/overflow money              | Incorrect totals/ledger                        | Integer safe minor units, explicit exponent/currency, bounds and rounding tests |
| TX-08 | Unbalanced ledger transaction          | Incorrect statement/payout                     | Deferred balance constraint/application invariant; block commit and alert       |
| TX-09 | Worker crash around side effect        | Lost or duplicated notification/adapter action | Transactional outbox, leases, at-least-once delivery, consumer dedupe           |
| TX-10 | Backup restore replays external effect | Duplicate external action                      | Environment/deployment epoch, idempotency retention, isolated restore drill     |

### Auctions and manipulation

| ID     | Threat                                      | Impact                 | Required mitigation and evidence                                                   |
| ------ | ------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| AUC-01 | Concurrent/late bids create two leaders     | Invalid auction        | Server time, ordered transaction, deterministic tie-break, 100-bid test            |
| AUC-02 | Duplicate close worker                      | Two winners/orders     | Unique auction result/order constraints; idempotent close test                     |
| AUC-03 | Client clock extends auction                | Late bid accepted      | Server clock only; fake-clock boundary tests                                       |
| AUC-04 | Seller edits material terms after first bid | Bidder harm            | Immutable auction fields after first accepted bid                                  |
| AUC-05 | Self/shill/coordinated bidding              | Manipulated price      | Identity/linkage rules and review signals; never silently rewrite accepted history |
| AUC-06 | Bid amount/private maximum leak             | Strategic/privacy harm | Role-scoped projection; proxy maximum excluded from public/event telemetry         |

### Paykit, Locks, and digital access

| ID     | Threat                                       | Impact                        | Required mitigation and evidence                                                                                                                                          |
| ------ | -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PAY-01 | Browser calls Paykit Server business route   | Invoice/status abuse          | Network isolation plus Lock Server Ed25519 signature; unsigned request rejected                                                                                           |
| PAY-02 | Client claims Locks completion               | Unpaid order/content access   | Transaction Service independently verifies lifecycle; duplicate completion test                                                                                           |
| PAY-03 | `bundle_id` or access credential leaks       | Bearer entitlement theft      | Service: sealed storage + HMAC lookup. Client: plaintext origin-scoped Dexie; identity-keyed wipe, not client encryption-at-rest. No URLs/logs/analytics; redaction tests |
| PAY-04 | Changed lock/amount under existing order     | Underpayment or wrong content | Bind lock hash, seller, buyer, amount, asset, policy, and order snapshot                                                                                                  |
| PAY-05 | Split/under/late payment ambiguity           | Incorrect confirmation        | Respect current Paykit Server semantics; pending/manual reconciliation, never infer                                                                                       |
| PAY-06 | Reorg before finality                        | Premature finality            | Configured `0..6` policy with explicit guarantee disclosure and reconciliation                                                                                            |
| PAY-07 | Locks/Paykit outage shown as failure or paid | False finality                | Pending state, bounded client polling, durable server reconciliation                                                                                                      |
| PAY-08 | xpub enters Pubky App                        | Financial privacy compromise  | Companion claim only; network/storage/log assertion that app never receives it                                                                                            |
| PAY-09 | Refund UI claims funds moved                 | Buyer deception               | `external_refund_required` until independently verified transaction evidence                                                                                              |
| PAY-10 | Guarded content hash mismatch                | Wrong/mutated digital good    | Lock/order resource hash binding and verification before render/download                                                                                                  |

### Messaging, reviews, and social abuse

| ID     | Threat                                      | Impact                  | Required mitigation and evidence                                                      |
| ------ | ------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| MSG-01 | Non-participant reads conversation/evidence | Privacy breach          | Participant ACL and staff purpose/role check on each object                           |
| MSG-02 | Spoofed system/payment message              | Scam                    | Server-authored typed system events rendered distinctly; user text cannot choose type |
| MSG-03 | Unsafe link/attachment                      | Phishing or malware     | URL warning, attachment validation/isolation, no active content                       |
| MSG-04 | Block suppresses order-critical event       | Missed obligation       | Block user messages but retain required server transaction notices                    |
| MSG-05 | Spam/rate-limit bypass                      | Abuse/cost              | Actor/device/network-aware admission without exposing linkage to other users          |
| REP-01 | Self/fake/duplicate review                  | Reputation manipulation | Completed-order eligibility and unique participant review constraints                 |
| REP-02 | Seller deletes criticism                    | Misleading reputation   | User cannot delete another review; moderation removal remains audit-visible           |

### Browser and PWA

| ID     | Threat                                               | Impact                         | Required mitigation and evidence                                                 |
| ------ | ---------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| WEB-01 | CSRF on cookie-backed proxy                          | Unauthorized command           | SameSite cookies, origin check, CSRF token where needed                          |
| WEB-02 | XSS steals local bearer/session data                 | Account/entitlement compromise | CSP, output encoding, no unsafe HTML, minimize bearer persistence                |
| WEB-03 | Service worker serves stale transaction action/state | False finality                 | Network-only transaction commands; versioned projection with freshness           |
| WEB-04 | Offline UI claims success                            | Buyer/seller deception         | Disable authoritative actions offline and use explicit submitting/pending labels |
| WEB-05 | Clickjacking on setup/admin                          | Unauthorized approval/action   | `frame-ancestors` policy with exact documented setup exceptions                  |
| WEB-06 | Open redirect/deep-link injection                    | Phishing/app abuse             | Exact schemes/hosts/origins and opaque state verification                        |

## Data-flow rules

### Allowed public data

- schema/version identifiers;
- shop display profile and public policies;
- listing terms, media references, category, condition, price, and public stock status;
- public review content and aggregate reputation;
- public Locks policy/resource reference for a digital listing.

### Prohibited public data

- address, email, phone, precise location;
- order/cart identifiers that permit enumeration;
- private offer, bid maximum, message, or evidence;
- payment address/hash/correlation;
- `bundle_id`, access credential, creator frontend session;
- raw Pubky auth assertion or session export.

### Telemetry policy

Telemetry may include:

- opaque deployment, trace, aggregate-type, and internal correlation IDs;
- coarse result/error code;
- latency, queue depth, revision-conflict count, invariant counters;
- adapter name/version and redacted health.

Telemetry must not include user-authored content, private identifiers, public keys/URLs, payment values tied to an identity, delivery details, evidence, credentials, raw callback bodies, or cryptographic material.

## Abuse and failure policy

- Risk signals create review/hold states; they do not silently change auction ordering, payment facts, ledger history, or review text.
- A dependency timeout is distinct from a negative business result.
- Unknown payment/refund outcomes remain reconciling and block release/payout simulation.
- Rate limiting must not make exact idempotent replay unsafe.
- Every user-facing guarantee names its sandbox or independently verified basis.

## Required security verification

### Automated

- contract fuzz/property tests for closed schemas, bounds, money, revisions, and canonical replay;
- 100-way stock and bid concurrency;
- duplicate, changed, reordered, delayed, and forged commands/callbacks;
- CSRF, origin, audience, expiry, nonce, unsafe redirect, SSRF, and path traversal;
- upload MIME/signature/size/dimension/decompression/metadata cases;
- ledger balance, refund ceiling, one-winner, one-payment, and review uniqueness constraints;
- Locks/Paykit unsigned route, pending failure, late completion, credential secrecy, and content hash cases;
- log/Sentry/analytics/browser-storage redaction scanning;
- migration failure, worker crash, dead-letter replay, backup, and isolated restore.

### Manual

- Pubky Ring creator grant scope and cancellation;
- Bitkit/helper setup without xpub exposure to Pubky App;
- desktop/mobile setup and payment-progress language;
- keyboard and screen-reader completion of purchase, fulfillment, and return;
- browser storage inspection before/after sign-out and account switch;
- successful payment followed by late/duplicate/restart reconciliation;
- security headers, setup iframe policy, deep links, and unsafe-link warnings.

### Independent review gates

Before real funds:

- review current Locks, Paykit, Paykit Server, Bitkit, Homeserver, and generated WASM revisions;
- cryptographic and protocol review;
- web/API penetration test;
- infrastructure/secrets/backup review;
- incident response and responsible disclosure process.

## Residual risks

- The Marketplace Transaction Service is a centralized prototype sequencer.
- Locks and Paykit Server are pre-production and may change without migration compatibility.
- Paykit Server is single-process, on-chain-only, and cannot refund.
- Anonymous/bearer-compatible Locks credentials can be shared if stolen.
- Public catalog records and private transaction projections can temporarily diverge.

These risks must remain visible in runtime configuration, operator documentation, and user-facing labels. They cannot be converted into “accepted” production guarantees solely because prototype tests pass.
