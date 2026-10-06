/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

type ReadableStreamType = "bytes";

/**
 * An in-progress pubkyauth flow.
 */
export class AuthFlowHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The `pubkyauth:` URL to present to the signer (QR code / deep link).
     */
    authorizationUrl(): string;
    /**
     * Wait until the signer approves and resolve to a `SessionHandle`.
     * Consumes the flow; subsequent calls reject.
     */
    awaitApproval(): Promise<any>;
}

/**
 * Handle to an established Encrypted Link.
 */
export class EncryptedLinkHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Close the link and clean up Noise session state. The handle becomes
     * unusable afterwards.
     */
    close(): Promise<any>;
    /**
     * Local Paykit receiver path.
     */
    localReceiverPath(): string;
    /**
     * Receive available Private Application Messages in stream order.
     * Resolves to an array of `{ version, kind, rawJson }`. Persist returned
     * messages before replacing a stored link snapshot (the read checkpoint
     * advances past them).
     */
    receivePrivateApplicationMessages(): Promise<any>;
    /**
     * Counterparty Pubky identity public key (z-base-32).
     */
    recipient(): string;
    /**
     * Counterparty receiver Noise public key (z-base-32).
     */
    remoteNoisePublicKey(): string;
    /**
     * Counterparty Paykit receiver path.
     */
    remoteReceiverPath(): string;
    /**
     * Send one raw JSON Private Application Message. The JSON must carry a
     * `version` (u8) and `kind` (string) envelope; unknown kinds are allowed
     * by contract (`send_private_application_message_json`).
     */
    sendPrivateApplicationMessageJson(raw_json: string): Promise<any>;
    /**
     * Encrypt and send a complete Private Payment List over this link.
     *
     * `endpoints` is a plain object `{ identifier: payload }` — the full
     * desired list, not a patch. Binds paykit-lib
     * `set_private_payment_list`. There is no homeserver GET for private
     * endpoints; the counterparty reads them via
     * `receivePrivateApplicationMessages` + `parsePrivatePaymentListJson`.
     * Do not log payloads. Session and link lifetime remain the caller's
     * responsibility.
     */
    sendPrivatePaymentList(endpoints: object): Promise<any>;
    /**
     * Override the automatic send retry limit for transient homeserver
     * write failures.
     */
    setMaxSendRetries(max: number): void;
    /**
     * Serialize the current link state for persistence. Take a fresh
     * snapshot after sending/receiving when persisted counters must catch
     * up. Snapshot bytes contain key material — store as secrets.
     */
    snapshot(): Uint8Array;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * Handle to an in-progress Encrypted Link handshake.
 */
export class LinkHandshakeHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Advance the handshake by one step. Resolves to
     * `{ status: "pending" }` (poll again after a delay) or
     * `{ status: "complete", link: EncryptedLinkHandle }`.
     *
     * If the step errors, the in-memory handshake is consumed (matching the
     * paykit-lib ownership model); recover via
     * `restoreEncryptedLinkHandshake` with a persisted snapshot.
     */
    advance(): Promise<any>;
    /**
     * Override the automatic write-failure recovery attempt limit.
     */
    setMaxRecoveryAttempts(max: number): void;
    /**
     * Serialize the current handshake state. Snapshot bytes contain key
     * material — store as secrets.
     */
    snapshot(): Uint8Array;
}

/**
 * An in-memory Noise XX session using the exact crypto stack of Paykit
 * Encrypted Links (`pubky_noise::snow_crypto::DataLinkContext`,
 * `Noise_XX_25519_ChaChaPoly_SHA256`, 1000-byte messages, explicit nonces)
 * with the caller shuttling packets instead of homeserver outboxes.
 *
 * Purpose: smoke tests and vector checks of the compiled WASM crypto. It is
 * NOT the Paykit messaging protocol — it has no homeserver transport, no
 * private path derivation, no Private Application Message envelope, and no
 * snapshots. Use the `EncryptedLink` surface for real messaging.
 */
export class MemoryNoiseSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Zeroize key material held by this session.
     */
    close(): void;
    /**
     * Decrypt and authenticate one transport packet from the counterparty.
     */
    decrypt(packet: Uint8Array): Uint8Array;
    /**
     * Encrypt one transport message (max `maxNoiseMessageLen()` bytes).
     */
    encrypt(plaintext: Uint8Array): Uint8Array;
    /**
     * True once all handshake messages have been processed on this side.
     */
    isHandshakeComplete(): boolean;
    /**
     * True once the session has transitioned to transport mode.
     */
    isTransport(): boolean;
    /**
     * The 32-byte link id (hex) derived from the handshake transcript hash.
     * Available after `transitionTransport()`. Both parties derive the same
     * value — comparing them proves the handshakes converged.
     */
    linkIdHex(): string | undefined;
    /**
     * Create one side of an in-memory Noise XX session.
     *
     * `localStaticSecret` is a 32-byte Noise static secret (e.g. from
     * `generateNoiseSecretKey()`). `remoteIdentityPubky` is the
     * counterparty's identity public key (z-base-32); it labels the endpoint
     * exactly as `PubkyNoiseEncryptor::new` does and plays no role in the
     * XX key exchange itself.
     */
    constructor(initiator: boolean, local_static_secret: Uint8Array, remote_identity_pubky: string);
    /**
     * Consume an inbound handshake packet from the counterparty.
     */
    readHandshakeMessage(packet: Uint8Array): void;
    /**
     * Transition a completed handshake to transport mode. Mirrors
     * `PubkyNoiseEncryptor::transition_transport`, including deriving the
     * link id from the handshake transcript hash.
     */
    transitionTransport(): void;
    /**
     * Produce the next outbound handshake packet.
     */
    writeHandshakeMessage(): Uint8Array;
}

/**
 * Pubky client facade. Construct once and reuse.
 */
export class PubkyClient {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Move an existing identity to `homeserverZ32` and republish `_pubky`.
     *
     * Dev/test helper. Signs up on that host, or signs in there if the user
     * already exists (HTTP 409). Host-local data is not copied.
     */
    migrateHomeserverWithSecret(identity_secret_key: Uint8Array, homeserver_z32: string, signup_token?: string | null): Promise<any>;
    /**
     * Construct with mainnet defaults.
     */
    constructor();
    /**
     * Force a fresh `_pubky` lookup for `pubkyZ32` from relays/DHT.
     *
     * Call after a counterparty migrates homeserver so subsequent requests
     * do not keep using a cached mailbox pointer.
     */
    resolveMostRecentHomeserver(pubky_z32: string): Promise<any>;
    /**
     * Restore a homeserver session from metadata previously produced by
     * `SessionHandle.exportSession()`, without a new signer approval.
     *
     * The export string carries no secrets; the actual credential is the
     * HTTP-only session cookie in the browser's cookie jar (set by the
     * homeserver, sent via `credentials: include`). Restoring performs a
     * `/session` round-trip to revalidate; it rejects if the export is
     * malformed or the cookie is missing, expired, or revoked. Resolves to
     * a `SessionHandle`.
     */
    restoreSession(exported_session: string): Promise<any>;
    /**
     * Resume a homeserver session purely from the browser's EXISTING
     * HTTP-only session cookie for `pubky` — no exported metadata and no new
     * signer approval. This is the zero-approval path for apps whose sign-in
     * grant already covers the Paykit tree (`/pub/paykit/:rw`): the cookie
     * set at sign-in is the credential; this call only rebuilds the wasm-side
     * handle around it.
     *
     * How it works: the same `/session` revalidation round-trip
     * `restoreSession` performs (the browser attaches the cookie via
     * `credentials: include`), seeded with a synthesized placeholder for the
     * requested pubky instead of a previously exported string. The
     * homeserver's response supplies the authoritative `SessionInfo`
     * (pubky, capabilities), which is verified before a handle is returned.
     *
     * Resolves to a `SessionHandle` identical to what `restoreSession` would
     * produce (including `exportSession()` support). Rejects with a typed
     * error the caller can branch on via `Error.name`:
     *
     * - `"SessionResumeUnauthorized"` — the homeserver holds no valid session
     *   for this pubky behind the browser's cookies (missing/expired/revoked
     *   cookie, or a cookie for another account).
     * - `"SessionResumePubkyMismatch"` — a session validated but belongs to a
     *   different pubky than requested.
     * - `"SessionResumeScopeMissing"` — the session is valid but its scope
     *   does not grant `/pub/paykit/` read+write (a legacy sign-in that
     *   predates the combined grant); an interactive approval is required.
     *
     * Transport failures reject with the plain `cookie resume failed: ...`
     * shape (retryable; says nothing about the cookie).
     */
    resumeSessionFromCookie(pubky: string): Promise<any>;
    /**
     * Sign in with a raw identity secret key. Dev/test helper only — in
     * production browser deployments the identity key must stay in the
     * signer (use `startAuthFlow` instead).
     */
    signinWithSecret(identity_secret_key: Uint8Array): Promise<any>;
    /**
     * Sign up a new account on a homeserver with a raw identity secret key.
     * Dev/test helper only (used against ephemeral testnets).
     */
    signupWithSecret(identity_secret_key: Uint8Array, homeserver_z32: string, signup_token?: string | null): Promise<any>;
    /**
     * Start a pubkyauth sign-in flow for the given capabilities
     * (e.g. `"/pub/paykit/:rw"`). Present `authorizationUrl()` to the
     * signer (Pubky Ring), then `awaitApproval()`.
     *
     * This is the production path for obtaining a homeserver session in the
     * browser: the identity secret key never enters this runtime.
     */
    startAuthFlow(capabilities: string): AuthFlowHandle;
    /**
     * Construct preconfigured for a local Pubky testnet.
     */
    static testnet(): PubkyClient;
}

/**
 * An authenticated homeserver session for one Pubky identity.
 */
export class SessionHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Authenticated DELETE of an absolute homeserver path. Cookie-authorized
     * the same way as `putPublic`.
     */
    deletePublic(path: string): Promise<any>;
    /**
     * Export session metadata for rehydrating via
     * `PubkyClient.restoreSession()` after a page reload.
     *
     * The returned string contains **no secrets** — it is a base64 encoding
     * of the public `SessionInfo` (pubky, capabilities). The credential
     * itself is the HTTP-only session cookie the browser holds; the export
     * only lets a new runtime reconstruct the session handle and revalidate
     * against the homeserver through that cookie.
     */
    exportSession(): string;
    /**
     * The session owner's public key (z-base-32).
     */
    pubky(): string;
    /**
     * Authenticated PUT of `body` at an absolute homeserver path (e.g.
     * `/pub/hypercolor.app/v1/…`). The browser attaches the HTTP-only
     * session cookie; this is not a Cookie-header constructor and must
     * never be fed `exportSession()` as a bearer.
     */
    putPublic(path: string, body: Uint8Array): Promise<any>;
}

/**
 * Accept a Noise XX Encrypted Link Handshake from a counterparty
 * (responder role).
 */
export function acceptEncryptedLink(session: SessionHandle, receiver_noise_secret_key: Uint8Array, sender_pubky: string, sender_noise_public_key: string, local_receiver_path: string, remote_receiver_path: string, client: PubkyClient): LinkHandshakeHandle;

/**
 * Delete all encrypted stream slots written by the local identity for one
 * counterparty (recovery before a fresh handshake). Resolves to the number
 * of deleted slots.
 */
export function clearEncryptedLinkOutbox(session: SessionHandle, local_noise_secret_key: Uint8Array, remote_pubky: string, remote_noise_public_key: string, local_receiver_path: string, remote_receiver_path: string): Promise<any>;

/**
 * Compute `inbox_kid` for a recipient InboxKey X25519 public key.
 *
 * `inbox_kid = first_16_bytes(SHA256(x25519_pub))`, returned as lowercase
 * 32-character hex. `x25519PubHex` is a 64-character hex public key (the
 * form returned by `x25519GenerateKeypair`).
 *
 * Binds `pubky_crypto::sealed_blob_v2::Sb2Header::compute_inbox_kid`.
 */
export function computeInboxKid(x25519_pub_hex: string): string;

/**
 * Generate a random receiver-scoped Noise secret key (32 bytes).
 *
 * Mirrors `paykit_sdk::ReceiverNoiseSecretKey::random()`: the key is an
 * independent random Ed25519 secret, never the Pubky identity secret. Store
 * it as a secret (e.g. account-scoped IndexedDB); it is required to restore
 * Encrypted Links and to derive private message paths.
 */
export function generateNoiseSecretKey(): Uint8Array;

/**
 * Fetch one public Payment Endpoint for `payee` at `receiverPath`.
 *
 * Resolves to the payload string, or `undefined` when the endpoint file is
 * missing or empty (homeserver 404/410). Other transport failures reject.
 * Session creation is not required; this is an unauthenticated public read.
 */
export function getPaymentEndpoint(client: PubkyClient, payee_pubky: string, receiver_path_value: string, identifier: string): Promise<any>;

/**
 * Fetch a peer's public Payment List (identifier → payload).
 *
 * Resolves to a plain object. A missing directory or empty list is `{}`
 * (list ops treat 404 as empty). Invalid UTF-8 or unparseable paths reject.
 */
export function getPaymentList(client: PubkyClient, payee_pubky: string, receiver_path_value: string): Promise<any>;

/**
 * Fetch a counterparty's public Paykit Receiver Marker. Resolves to
 * `{ receiverPath, noisePublicKey, capabilities: { privatePayments,
 * paymentRequests, receipts, outgoingPayments } }`, or `undefined` if the
 * owner has not published one at that path.
 */
export function getReceiverMarker(client: PubkyClient, owner_pubky: string, receiver_path_value: string): Promise<any>;

/**
 * Initiate a Noise XX Encrypted Link Handshake toward a counterparty
 * (initiator role).
 *
 * `receiverNoisePublicKey` comes from the counterparty's Receiver Marker
 * (see `getReceiverMarker`). Drive the returned handshake with `advance()`
 * until it completes.
 */
export function initiateEncryptedLink(session: SessionHandle, sender_noise_secret_key: Uint8Array, receiver_pubky: string, receiver_noise_public_key: string, local_receiver_path: string, remote_receiver_path: string, client: PubkyClient): LinkHandshakeHandle;

/**
 * List publicly advertised Paykit receiver paths for a Pubky identity.
 *
 * Discovery helper only — payment flows should still use the exact
 * receiver path selected by the app. Resolves to a sorted string array;
 * a missing tree is `[]`.
 */
export function listPaykitReceiverPaths(client: PubkyClient, owner_pubky: string): Promise<any>;

/**
 * List the Payment Endpoint Identifiers a peer has published publicly.
 *
 * Same fetch as `getPaymentList`; resolves to a sorted string array.
 * A missing directory is `[]`.
 */
export function listPaymentMethods(client: PubkyClient, payee_pubky: string, receiver_path_value: string): Promise<any>;

/**
 * Maximum plaintext size of one Private Application Message, in bytes.
 *
 * This is `pubky_noise`'s fixed message buffer (1000 bytes). JSON envelope
 * bytes count against it; callers should budget payloads accordingly.
 */
export function maxNoiseMessageLen(): number;

/**
 * Derive the public key published in a Receiver Marker from a receiver
 * Noise secret key. Returns the z-base-32 encoding.
 *
 * Mirrors `paykit_sdk::ReceiverNoiseSecretKey::public_key()`.
 */
export function noisePublicKeyFromSecret(secret: Uint8Array): string;

/**
 * AEAD tag overhead per encrypted Noise message, in bytes.
 */
export function noiseTagLen(): number;

/**
 * Parse a versioned `paykit.private_payment_list` JSON message.
 *
 * Returns `{ identifier: payload, ... }`. There is no homeserver GET for
 * private endpoints — they arrive as Encrypted Link messages. Rejects
 * invalid identifiers, unknown versions/kinds, or malformed JSON.
 */
export function parsePrivatePaymentListJson(json: string): object;

/**
 * Unauthenticated public GET of `{ownerPubky}{path}`.
 *
 * `ownerPubky` accepts z-base-32 or 64-hex. A homeserver 404 or 410
 * resolves to `undefined`; other failures reject. Used to fetch a
 * paykit-connect SB2 handoff from `/pub/`.
 */
export function publicGet(client: PubkyClient, owner_pubky: string, path: string): Promise<any>;

/**
 * Publish a public Paykit Receiver Marker for the session owner, making the
 * receiver path discoverable and advertising the receiver Noise public key
 * used for Encrypted Link path derivation.
 *
 * A messaging-only receiver typically sets `privatePayments = true` (the
 * Encrypted Link capability) and the payment capabilities to `false`.
 */
export function publishReceiverMarker(session: SessionHandle, receiver_path_value: string, noise_public_key: string, private_payments: boolean, payment_requests: boolean, receipts: boolean, outgoing_payments: boolean): Promise<any>;

/**
 * Remove a public Payment Endpoint owned by the session.
 *
 * A missing endpoint is success (paykit-lib treats homeserver 404 as
 * already absent). Session creation and capability scope remain the
 * caller's responsibility.
 */
export function removePaymentEndpoint(session: SessionHandle, receiver_path_value: string, identifier: string): Promise<any>;

/**
 * Remove the session owner's public Paykit Receiver Marker at a path.
 */
export function removeReceiverMarker(session: SessionHandle, receiver_path_value: string): Promise<any>;

/**
 * Restore an established Encrypted Link from snapshot bytes previously
 * produced by `EncryptedLinkHandle.snapshot()`.
 */
export function restoreEncryptedLink(session: SessionHandle, noise_secret_key: Uint8Array, remote_pubky: string, local_receiver_path: string, remote_receiver_path: string, client: PubkyClient, snapshot: Uint8Array): Promise<any>;

/**
 * Restore an in-progress handshake from snapshot bytes previously produced
 * by `LinkHandshakeHandle.snapshot()`.
 */
export function restoreEncryptedLinkHandshake(session: SessionHandle, noise_secret_key: Uint8Array, remote_pubky: string, local_receiver_path: string, remote_receiver_path: string, client: PubkyClient, snapshot: Uint8Array): Promise<any>;

/**
 * Decrypt an SB2 envelope for the recipient X25519 secret key.
 *
 * Binds `Sb2::decode` + `Sb2::decrypt`. `ownerPubky` accepts z-base-32 or
 * 64-hex. `canonicalPath` must match the path bound into the AAD at encrypt.
 */
export function sb2Decrypt(envelope: Uint8Array, recipient_sk: Uint8Array, owner_pubky: string, canonical_path: string): Uint8Array;

/**
 * Encrypt plaintext to an unsigned SB2 binary envelope.
 *
 * Binds `Sb2::encrypt_with_cert_id` + `Sb2::encode`. Does not reimplement
 * the cipher. Plaintext is capped at 64 KiB and `msg_id` at 128 ASCII
 * characters by the encoder. `ownerPubky`, `senderPeerid`, and
 * `recipientPeerid` accept z-base-32 or 64-hex.
 *
 * Call `sb2Sign` afterwards when the envelope must authenticate the sender.
 */
export function sb2Encrypt(recipient_inbox_pk: Uint8Array, plaintext: Uint8Array, context_id: Uint8Array, msg_id: string | null | undefined, purpose: string | null | undefined, owner_pubky: string, sender_peerid: string, recipient_peerid: string, canonical_path: string, created_at?: bigint | null, expires_at?: bigint | null, cert_id?: Uint8Array | null): Uint8Array;

/**
 * Sign an SB2 envelope with the sender's Ed25519 secret key.
 *
 * Binds `Sb2::decode` + `Sb2::sign` + `Sb2::encode`. `ownerPubky` accepts
 * z-base-32 or 64-hex and must match the path bound into the AAD at encrypt.
 */
export function sb2Sign(envelope: Uint8Array, sender_ed25519_sk: Uint8Array, owner_pubky: string, canonical_path: string): Uint8Array;

/**
 * Verify the Ed25519 signature on an SB2 envelope.
 *
 * Returns `true` when a signature is present and valid, `false` when no
 * signature is present. Rejects when a signature is present but invalid
 * (mirrors `pubky_noise` UniFFI `sb2_verify_signature`).
 *
 * `ownerPubky` accepts z-base-32 or 64-hex and is normalized to 32 bytes.
 */
export function sb2VerifySignature(envelope: Uint8Array, owner_pubky: string, canonical_path: string): boolean;

/**
 * Serialize a complete Private Payment List to its versioned JSON wire form.
 *
 * `endpoints` is a plain object `{ identifier: payload }`. The result is
 * the full latest-state message (`version` 1, kind
 * `paykit.private_payment_list`), not a patch. Do not log payloads.
 */
export function serializePrivatePaymentListJson(endpoints: object): string;

/**
 * Publish or update a public Payment Endpoint for the session owner.
 *
 * Authenticated PUT via the session. Path construction stays inside
 * paykit-lib (`PAYKIT_PATH_PREFIX`). Session creation, capability scope
 * (`/pub/paykit/:rw`), and key rotation remain the caller's
 * responsibility. Do not log `payload`.
 */
export function setPaymentEndpoint(session: SessionHandle, receiver_path_value: string, identifier: string, payload: string): Promise<any>;

/**
 * Sign out and invalidate the homeserver session (cookie) server-side.
 * Consumes the `SessionHandle`.
 */
export function signOutSession(session: SessionHandle): Promise<any>;

/**
 * Generate a random X25519 keypair.
 *
 * Returns `{ publicKey, secretKey }` as lowercase 64-character hex strings.
 * This is **not** `generateNoiseSecretKey` (that is an Ed25519 seed).
 *
 * Binds `pubky_crypto::sealed_blob::x25519_generate_keypair`.
 */
export function x25519GenerateKeypair(): object;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly getPaymentEndpoint: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly getPaymentList: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly getReceiverMarker: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly listPaykitReceiverPaths: (a: number, b: number, c: number) => [number, number, number];
    readonly listPaymentMethods: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly parsePrivatePaymentListJson: (a: number, b: number) => [number, number, number];
    readonly publishReceiverMarker: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly removePaymentEndpoint: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly removeReceiverMarker: (a: number, b: number, c: number) => [number, number, number];
    readonly serializePrivatePaymentListJson: (a: any) => [number, number, number, number];
    readonly setPaymentEndpoint: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly __wbg_authflowhandle_free: (a: number, b: number) => void;
    readonly __wbg_pubkyclient_free: (a: number, b: number) => void;
    readonly __wbg_sessionhandle_free: (a: number, b: number) => void;
    readonly authflowhandle_authorizationUrl: (a: number) => [number, number];
    readonly authflowhandle_awaitApproval: (a: number) => any;
    readonly pubkyclient_migrateHomeserverWithSecret: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly pubkyclient_new: () => [number, number, number];
    readonly pubkyclient_resolveMostRecentHomeserver: (a: number, b: number, c: number) => [number, number, number];
    readonly pubkyclient_restoreSession: (a: number, b: number, c: number) => any;
    readonly pubkyclient_resumeSessionFromCookie: (a: number, b: number, c: number) => [number, number, number];
    readonly pubkyclient_signinWithSecret: (a: number, b: number, c: number) => [number, number, number];
    readonly pubkyclient_signupWithSecret: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly pubkyclient_startAuthFlow: (a: number, b: number, c: number) => [number, number, number];
    readonly pubkyclient_testnet: () => [number, number, number];
    readonly publicGet: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly sessionhandle_deletePublic: (a: number, b: number, c: number) => any;
    readonly sessionhandle_exportSession: (a: number) => [number, number];
    readonly sessionhandle_pubky: (a: number) => [number, number];
    readonly sessionhandle_putPublic: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly signOutSession: (a: number) => any;
    readonly __wbg_encryptedlinkhandle_free: (a: number, b: number) => void;
    readonly __wbg_linkhandshakehandle_free: (a: number, b: number) => void;
    readonly acceptEncryptedLink: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly clearEncryptedLinkOutbox: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly encryptedlinkhandle_close: (a: number) => any;
    readonly encryptedlinkhandle_localReceiverPath: (a: number) => [number, number];
    readonly encryptedlinkhandle_receivePrivateApplicationMessages: (a: number) => any;
    readonly encryptedlinkhandle_recipient: (a: number) => [number, number];
    readonly encryptedlinkhandle_remoteNoisePublicKey: (a: number) => [number, number];
    readonly encryptedlinkhandle_remoteReceiverPath: (a: number) => [number, number];
    readonly encryptedlinkhandle_sendPrivateApplicationMessageJson: (a: number, b: number, c: number) => any;
    readonly encryptedlinkhandle_sendPrivatePaymentList: (a: number, b: any) => [number, number, number];
    readonly encryptedlinkhandle_setMaxSendRetries: (a: number, b: number) => [number, number];
    readonly encryptedlinkhandle_snapshot: (a: number) => [number, number, number, number];
    readonly initiateEncryptedLink: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly linkhandshakehandle_advance: (a: number) => any;
    readonly linkhandshakehandle_setMaxRecoveryAttempts: (a: number, b: number) => [number, number];
    readonly linkhandshakehandle_snapshot: (a: number) => [number, number, number, number];
    readonly restoreEncryptedLink: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly restoreEncryptedLinkHandshake: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly maxNoiseMessageLen: () => number;
    readonly noiseTagLen: () => number;
    readonly computeInboxKid: (a: number, b: number) => [number, number, number, number];
    readonly generateNoiseSecretKey: () => [number, number];
    readonly noisePublicKeyFromSecret: (a: number, b: number) => [number, number, number, number];
    readonly sb2Decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly sb2Encrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: bigint, u: number, v: bigint, w: number, x: number) => [number, number, number, number];
    readonly sb2Sign: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly sb2VerifySignature: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly x25519GenerateKeypair: () => any;
    readonly __wbg_memorynoisesession_free: (a: number, b: number) => void;
    readonly memorynoisesession_close: (a: number) => void;
    readonly memorynoisesession_decrypt: (a: number, b: number, c: number) => [number, number, number, number];
    readonly memorynoisesession_encrypt: (a: number, b: number, c: number) => [number, number, number, number];
    readonly memorynoisesession_isHandshakeComplete: (a: number) => number;
    readonly memorynoisesession_isTransport: (a: number) => number;
    readonly memorynoisesession_linkIdHex: (a: number) => [number, number];
    readonly memorynoisesession_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly memorynoisesession_readHandshakeMessage: (a: number, b: number, c: number) => [number, number];
    readonly memorynoisesession_transitionTransport: (a: number) => [number, number];
    readonly memorynoisesession_writeHandshakeMessage: (a: number) => [number, number, number, number];
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly wasm_bindgen__convert__closures_____invoke__h0c1430703438ec11: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h31c10299f3023db4: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h7d83aa45adf6d0a1: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
