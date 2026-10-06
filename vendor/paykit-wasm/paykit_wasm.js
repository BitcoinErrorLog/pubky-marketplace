/* @ts-self-types="./paykit_wasm.d.ts" */

/**
 * An in-progress pubkyauth flow.
 */
export class AuthFlowHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AuthFlowHandle.prototype);
        obj.__wbg_ptr = ptr;
        AuthFlowHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AuthFlowHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_authflowhandle_free(ptr, 0);
    }
    /**
     * The `pubkyauth:` URL to present to the signer (QR code / deep link).
     * @returns {string}
     */
    authorizationUrl() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.authflowhandle_authorizationUrl(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Wait until the signer approves and resolve to a `SessionHandle`.
     * Consumes the flow; subsequent calls reject.
     * @returns {Promise<any>}
     */
    awaitApproval() {
        const ret = wasm.authflowhandle_awaitApproval(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) AuthFlowHandle.prototype[Symbol.dispose] = AuthFlowHandle.prototype.free;

/**
 * Handle to an established Encrypted Link.
 */
export class EncryptedLinkHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(EncryptedLinkHandle.prototype);
        obj.__wbg_ptr = ptr;
        EncryptedLinkHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EncryptedLinkHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_encryptedlinkhandle_free(ptr, 0);
    }
    /**
     * Close the link and clean up Noise session state. The handle becomes
     * unusable afterwards.
     * @returns {Promise<any>}
     */
    close() {
        const ret = wasm.encryptedlinkhandle_close(this.__wbg_ptr);
        return ret;
    }
    /**
     * Local Paykit receiver path.
     * @returns {string}
     */
    localReceiverPath() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.encryptedlinkhandle_localReceiverPath(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Receive available Private Application Messages in stream order.
     * Resolves to an array of `{ version, kind, rawJson }`. Persist returned
     * messages before replacing a stored link snapshot (the read checkpoint
     * advances past them).
     * @returns {Promise<any>}
     */
    receivePrivateApplicationMessages() {
        const ret = wasm.encryptedlinkhandle_receivePrivateApplicationMessages(this.__wbg_ptr);
        return ret;
    }
    /**
     * Counterparty Pubky identity public key (z-base-32).
     * @returns {string}
     */
    recipient() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.encryptedlinkhandle_recipient(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Counterparty receiver Noise public key (z-base-32).
     * @returns {string}
     */
    remoteNoisePublicKey() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.encryptedlinkhandle_remoteNoisePublicKey(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Counterparty Paykit receiver path.
     * @returns {string}
     */
    remoteReceiverPath() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.encryptedlinkhandle_remoteReceiverPath(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Send one raw JSON Private Application Message. The JSON must carry a
     * `version` (u8) and `kind` (string) envelope; unknown kinds are allowed
     * by contract (`send_private_application_message_json`).
     * @param {string} raw_json
     * @returns {Promise<any>}
     */
    sendPrivateApplicationMessageJson(raw_json) {
        const ptr0 = passStringToWasm0(raw_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.encryptedlinkhandle_sendPrivateApplicationMessageJson(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
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
     * @param {object} endpoints
     * @returns {Promise<any>}
     */
    sendPrivatePaymentList(endpoints) {
        const ret = wasm.encryptedlinkhandle_sendPrivatePaymentList(this.__wbg_ptr, endpoints);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Override the automatic send retry limit for transient homeserver
     * write failures.
     * @param {number} max
     */
    setMaxSendRetries(max) {
        const ret = wasm.encryptedlinkhandle_setMaxSendRetries(this.__wbg_ptr, max);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Serialize the current link state for persistence. Take a fresh
     * snapshot after sending/receiving when persisted counters must catch
     * up. Snapshot bytes contain key material — store as secrets.
     * @returns {Uint8Array}
     */
    snapshot() {
        const ret = wasm.encryptedlinkhandle_snapshot(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) EncryptedLinkHandle.prototype[Symbol.dispose] = EncryptedLinkHandle.prototype.free;

export class IntoUnderlyingByteSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingByteSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingbytesource_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get autoAllocateChunkSize() {
        const ret = wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr);
        return ret >>> 0;
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingbytesource_cancel(ptr);
    }
    /**
     * @param {ReadableByteStreamController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingbytesource_pull(this.__wbg_ptr, controller);
        return ret;
    }
    /**
     * @param {ReadableByteStreamController} controller
     */
    start(controller) {
        wasm.intounderlyingbytesource_start(this.__wbg_ptr, controller);
    }
    /**
     * @returns {ReadableStreamType}
     */
    get type() {
        const ret = wasm.intounderlyingbytesource_type(this.__wbg_ptr);
        return __wbindgen_enum_ReadableStreamType[ret];
    }
}
if (Symbol.dispose) IntoUnderlyingByteSource.prototype[Symbol.dispose] = IntoUnderlyingByteSource.prototype.free;

export class IntoUnderlyingSink {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSinkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsink_free(ptr, 0);
    }
    /**
     * @param {any} reason
     * @returns {Promise<any>}
     */
    abort(reason) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_abort(ptr, reason);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    close() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_close(ptr);
        return ret;
    }
    /**
     * @param {any} chunk
     * @returns {Promise<any>}
     */
    write(chunk) {
        const ret = wasm.intounderlyingsink_write(this.__wbg_ptr, chunk);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSink.prototype[Symbol.dispose] = IntoUnderlyingSink.prototype.free;

export class IntoUnderlyingSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsource_free(ptr, 0);
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingsource_cancel(ptr);
    }
    /**
     * @param {ReadableStreamDefaultController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingsource_pull(this.__wbg_ptr, controller);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSource.prototype[Symbol.dispose] = IntoUnderlyingSource.prototype.free;

/**
 * Handle to an in-progress Encrypted Link handshake.
 */
export class LinkHandshakeHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(LinkHandshakeHandle.prototype);
        obj.__wbg_ptr = ptr;
        LinkHandshakeHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LinkHandshakeHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_linkhandshakehandle_free(ptr, 0);
    }
    /**
     * Advance the handshake by one step. Resolves to
     * `{ status: "pending" }` (poll again after a delay) or
     * `{ status: "complete", link: EncryptedLinkHandle }`.
     *
     * If the step errors, the in-memory handshake is consumed (matching the
     * paykit-lib ownership model); recover via
     * `restoreEncryptedLinkHandshake` with a persisted snapshot.
     * @returns {Promise<any>}
     */
    advance() {
        const ret = wasm.linkhandshakehandle_advance(this.__wbg_ptr);
        return ret;
    }
    /**
     * Override the automatic write-failure recovery attempt limit.
     * @param {number} max
     */
    setMaxRecoveryAttempts(max) {
        const ret = wasm.linkhandshakehandle_setMaxRecoveryAttempts(this.__wbg_ptr, max);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Serialize the current handshake state. Snapshot bytes contain key
     * material — store as secrets.
     * @returns {Uint8Array}
     */
    snapshot() {
        const ret = wasm.linkhandshakehandle_snapshot(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) LinkHandshakeHandle.prototype[Symbol.dispose] = LinkHandshakeHandle.prototype.free;

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
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MemoryNoiseSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_memorynoisesession_free(ptr, 0);
    }
    /**
     * Zeroize key material held by this session.
     */
    close() {
        wasm.memorynoisesession_close(this.__wbg_ptr);
    }
    /**
     * Decrypt and authenticate one transport packet from the counterparty.
     * @param {Uint8Array} packet
     * @returns {Uint8Array}
     */
    decrypt(packet) {
        const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.memorynoisesession_decrypt(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Encrypt one transport message (max `maxNoiseMessageLen()` bytes).
     * @param {Uint8Array} plaintext
     * @returns {Uint8Array}
     */
    encrypt(plaintext) {
        const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.memorynoisesession_encrypt(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * True once all handshake messages have been processed on this side.
     * @returns {boolean}
     */
    isHandshakeComplete() {
        const ret = wasm.memorynoisesession_isHandshakeComplete(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * True once the session has transitioned to transport mode.
     * @returns {boolean}
     */
    isTransport() {
        const ret = wasm.memorynoisesession_isTransport(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * The 32-byte link id (hex) derived from the handshake transcript hash.
     * Available after `transitionTransport()`. Both parties derive the same
     * value — comparing them proves the handshakes converged.
     * @returns {string | undefined}
     */
    linkIdHex() {
        const ret = wasm.memorynoisesession_linkIdHex(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Create one side of an in-memory Noise XX session.
     *
     * `localStaticSecret` is a 32-byte Noise static secret (e.g. from
     * `generateNoiseSecretKey()`). `remoteIdentityPubky` is the
     * counterparty's identity public key (z-base-32); it labels the endpoint
     * exactly as `PubkyNoiseEncryptor::new` does and plays no role in the
     * XX key exchange itself.
     * @param {boolean} initiator
     * @param {Uint8Array} local_static_secret
     * @param {string} remote_identity_pubky
     */
    constructor(initiator, local_static_secret, remote_identity_pubky) {
        const ptr0 = passArray8ToWasm0(local_static_secret, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(remote_identity_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.memorynoisesession_new(initiator, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        MemoryNoiseSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Consume an inbound handshake packet from the counterparty.
     * @param {Uint8Array} packet
     */
    readHandshakeMessage(packet) {
        const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.memorynoisesession_readHandshakeMessage(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Transition a completed handshake to transport mode. Mirrors
     * `PubkyNoiseEncryptor::transition_transport`, including deriving the
     * link id from the handshake transcript hash.
     */
    transitionTransport() {
        const ret = wasm.memorynoisesession_transitionTransport(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Produce the next outbound handshake packet.
     * @returns {Uint8Array}
     */
    writeHandshakeMessage() {
        const ret = wasm.memorynoisesession_writeHandshakeMessage(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) MemoryNoiseSession.prototype[Symbol.dispose] = MemoryNoiseSession.prototype.free;

/**
 * Pubky client facade. Construct once and reuse.
 */
export class PubkyClient {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PubkyClient.prototype);
        obj.__wbg_ptr = ptr;
        PubkyClientFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PubkyClientFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pubkyclient_free(ptr, 0);
    }
    /**
     * Move an existing identity to `homeserverZ32` and republish `_pubky`.
     *
     * Dev/test helper. Signs up on that host, or signs in there if the user
     * already exists (HTTP 409). Host-local data is not copied.
     * @param {Uint8Array} identity_secret_key
     * @param {string} homeserver_z32
     * @param {string | null} [signup_token]
     * @returns {Promise<any>}
     */
    migrateHomeserverWithSecret(identity_secret_key, homeserver_z32, signup_token) {
        const ptr0 = passArray8ToWasm0(identity_secret_key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(homeserver_z32, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(signup_token) ? 0 : passStringToWasm0(signup_token, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len2 = WASM_VECTOR_LEN;
        const ret = wasm.pubkyclient_migrateHomeserverWithSecret(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Construct with mainnet defaults.
     */
    constructor() {
        const ret = wasm.pubkyclient_new();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        PubkyClientFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Force a fresh `_pubky` lookup for `pubkyZ32` from relays/DHT.
     *
     * Call after a counterparty migrates homeserver so subsequent requests
     * do not keep using a cached mailbox pointer.
     * @param {string} pubky_z32
     * @returns {Promise<any>}
     */
    resolveMostRecentHomeserver(pubky_z32) {
        const ptr0 = passStringToWasm0(pubky_z32, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pubkyclient_resolveMostRecentHomeserver(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
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
     * @param {string} exported_session
     * @returns {Promise<any>}
     */
    restoreSession(exported_session) {
        const ptr0 = passStringToWasm0(exported_session, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pubkyclient_restoreSession(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
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
     * @param {string} pubky
     * @returns {Promise<any>}
     */
    resumeSessionFromCookie(pubky) {
        const ptr0 = passStringToWasm0(pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pubkyclient_resumeSessionFromCookie(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Sign in with a raw identity secret key. Dev/test helper only — in
     * production browser deployments the identity key must stay in the
     * signer (use `startAuthFlow` instead).
     * @param {Uint8Array} identity_secret_key
     * @returns {Promise<any>}
     */
    signinWithSecret(identity_secret_key) {
        const ptr0 = passArray8ToWasm0(identity_secret_key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pubkyclient_signinWithSecret(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Sign up a new account on a homeserver with a raw identity secret key.
     * Dev/test helper only (used against ephemeral testnets).
     * @param {Uint8Array} identity_secret_key
     * @param {string} homeserver_z32
     * @param {string | null} [signup_token]
     * @returns {Promise<any>}
     */
    signupWithSecret(identity_secret_key, homeserver_z32, signup_token) {
        const ptr0 = passArray8ToWasm0(identity_secret_key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(homeserver_z32, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(signup_token) ? 0 : passStringToWasm0(signup_token, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len2 = WASM_VECTOR_LEN;
        const ret = wasm.pubkyclient_signupWithSecret(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Start a pubkyauth sign-in flow for the given capabilities
     * (e.g. `"/pub/paykit/:rw"`). Present `authorizationUrl()` to the
     * signer (Pubky Ring), then `awaitApproval()`.
     *
     * This is the production path for obtaining a homeserver session in the
     * browser: the identity secret key never enters this runtime.
     * @param {string} capabilities
     * @returns {AuthFlowHandle}
     */
    startAuthFlow(capabilities) {
        const ptr0 = passStringToWasm0(capabilities, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pubkyclient_startAuthFlow(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return AuthFlowHandle.__wrap(ret[0]);
    }
    /**
     * Construct preconfigured for a local Pubky testnet.
     * @returns {PubkyClient}
     */
    static testnet() {
        const ret = wasm.pubkyclient_testnet();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PubkyClient.__wrap(ret[0]);
    }
}
if (Symbol.dispose) PubkyClient.prototype[Symbol.dispose] = PubkyClient.prototype.free;

/**
 * An authenticated homeserver session for one Pubky identity.
 */
export class SessionHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SessionHandle.prototype);
        obj.__wbg_ptr = ptr;
        SessionHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SessionHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sessionhandle_free(ptr, 0);
    }
    /**
     * Authenticated DELETE of an absolute homeserver path. Cookie-authorized
     * the same way as `putPublic`.
     * @param {string} path
     * @returns {Promise<any>}
     */
    deletePublic(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionhandle_deletePublic(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Export session metadata for rehydrating via
     * `PubkyClient.restoreSession()` after a page reload.
     *
     * The returned string contains **no secrets** — it is a base64 encoding
     * of the public `SessionInfo` (pubky, capabilities). The credential
     * itself is the HTTP-only session cookie the browser holds; the export
     * only lets a new runtime reconstruct the session handle and revalidate
     * against the homeserver through that cookie.
     * @returns {string}
     */
    exportSession() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sessionhandle_exportSession(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The session owner's public key (z-base-32).
     * @returns {string}
     */
    pubky() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sessionhandle_pubky(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Authenticated PUT of `body` at an absolute homeserver path (e.g.
     * `/pub/hypercolor.app/v1/…`). The browser attaches the HTTP-only
     * session cookie; this is not a Cookie-header constructor and must
     * never be fed `exportSession()` as a bearer.
     * @param {string} path
     * @param {Uint8Array} body
     * @returns {Promise<any>}
     */
    putPublic(path, body) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(body, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sessionhandle_putPublic(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
}
if (Symbol.dispose) SessionHandle.prototype[Symbol.dispose] = SessionHandle.prototype.free;

/**
 * Accept a Noise XX Encrypted Link Handshake from a counterparty
 * (responder role).
 * @param {SessionHandle} session
 * @param {Uint8Array} receiver_noise_secret_key
 * @param {string} sender_pubky
 * @param {string} sender_noise_public_key
 * @param {string} local_receiver_path
 * @param {string} remote_receiver_path
 * @param {PubkyClient} client
 * @returns {LinkHandshakeHandle}
 */
export function acceptEncryptedLink(session, receiver_noise_secret_key, sender_pubky, sender_noise_public_key, local_receiver_path, remote_receiver_path, client) {
    _assertClass(session, SessionHandle);
    const ptr0 = passArray8ToWasm0(receiver_noise_secret_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(sender_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(sender_noise_public_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(local_receiver_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(remote_receiver_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    _assertClass(client, PubkyClient);
    const ret = wasm.acceptEncryptedLink(session.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, client.__wbg_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return LinkHandshakeHandle.__wrap(ret[0]);
}

/**
 * Delete all encrypted stream slots written by the local identity for one
 * counterparty (recovery before a fresh handshake). Resolves to the number
 * of deleted slots.
 * @param {SessionHandle} session
 * @param {Uint8Array} local_noise_secret_key
 * @param {string} remote_pubky
 * @param {string} remote_noise_public_key
 * @param {string} local_receiver_path
 * @param {string} remote_receiver_path
 * @returns {Promise<any>}
 */
export function clearEncryptedLinkOutbox(session, local_noise_secret_key, remote_pubky, remote_noise_public_key, local_receiver_path, remote_receiver_path) {
    _assertClass(session, SessionHandle);
    const ptr0 = passArray8ToWasm0(local_noise_secret_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(remote_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(remote_noise_public_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(local_receiver_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(remote_receiver_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.clearEncryptedLinkOutbox(session.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Compute `inbox_kid` for a recipient InboxKey X25519 public key.
 *
 * `inbox_kid = first_16_bytes(SHA256(x25519_pub))`, returned as lowercase
 * 32-character hex. `x25519PubHex` is a 64-character hex public key (the
 * form returned by `x25519GenerateKeypair`).
 *
 * Binds `pubky_crypto::sealed_blob_v2::Sb2Header::compute_inbox_kid`.
 * @param {string} x25519_pub_hex
 * @returns {string}
 */
export function computeInboxKid(x25519_pub_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(x25519_pub_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.computeInboxKid(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Generate a random receiver-scoped Noise secret key (32 bytes).
 *
 * Mirrors `paykit_sdk::ReceiverNoiseSecretKey::random()`: the key is an
 * independent random Ed25519 secret, never the Pubky identity secret. Store
 * it as a secret (e.g. account-scoped IndexedDB); it is required to restore
 * Encrypted Links and to derive private message paths.
 * @returns {Uint8Array}
 */
export function generateNoiseSecretKey() {
    const ret = wasm.generateNoiseSecretKey();
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * Fetch one public Payment Endpoint for `payee` at `receiverPath`.
 *
 * Resolves to the payload string, or `undefined` when the endpoint file is
 * missing or empty (homeserver 404/410). Other transport failures reject.
 * Session creation is not required; this is an unauthenticated public read.
 * @param {PubkyClient} client
 * @param {string} payee_pubky
 * @param {string} receiver_path_value
 * @param {string} identifier
 * @returns {Promise<any>}
 */
export function getPaymentEndpoint(client, payee_pubky, receiver_path_value, identifier) {
    _assertClass(client, PubkyClient);
    const ptr0 = passStringToWasm0(payee_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(receiver_path_value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(identifier, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.getPaymentEndpoint(client.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Fetch a peer's public Payment List (identifier → payload).
 *
 * Resolves to a plain object. A missing directory or empty list is `{}`
 * (list ops treat 404 as empty). Invalid UTF-8 or unparseable paths reject.
 * @param {PubkyClient} client
 * @param {string} payee_pubky
 * @param {string} receiver_path_value
 * @returns {Promise<any>}
 */
export function getPaymentList(client, payee_pubky, receiver_path_value) {
    _assertClass(client, PubkyClient);
    const ptr0 = passStringToWasm0(payee_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(receiver_path_value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.getPaymentList(client.__wbg_ptr, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Fetch a counterparty's public Paykit Receiver Marker. Resolves to
 * `{ receiverPath, noisePublicKey, capabilities: { privatePayments,
 * paymentRequests, receipts, outgoingPayments } }`, or `undefined` if the
 * owner has not published one at that path.
 * @param {PubkyClient} client
 * @param {string} owner_pubky
 * @param {string} receiver_path_value
 * @returns {Promise<any>}
 */
export function getReceiverMarker(client, owner_pubky, receiver_path_value) {
    _assertClass(client, PubkyClient);
    const ptr0 = passStringToWasm0(owner_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(receiver_path_value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.getReceiverMarker(client.__wbg_ptr, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Initiate a Noise XX Encrypted Link Handshake toward a counterparty
 * (initiator role).
 *
 * `receiverNoisePublicKey` comes from the counterparty's Receiver Marker
 * (see `getReceiverMarker`). Drive the returned handshake with `advance()`
 * until it completes.
 * @param {SessionHandle} session
 * @param {Uint8Array} sender_noise_secret_key
 * @param {string} receiver_pubky
 * @param {string} receiver_noise_public_key
 * @param {string} local_receiver_path
 * @param {string} remote_receiver_path
 * @param {PubkyClient} client
 * @returns {LinkHandshakeHandle}
 */
export function initiateEncryptedLink(session, sender_noise_secret_key, receiver_pubky, receiver_noise_public_key, local_receiver_path, remote_receiver_path, client) {
    _assertClass(session, SessionHandle);
    const ptr0 = passArray8ToWasm0(sender_noise_secret_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(receiver_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(receiver_noise_public_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(local_receiver_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(remote_receiver_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    _assertClass(client, PubkyClient);
    const ret = wasm.initiateEncryptedLink(session.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, client.__wbg_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return LinkHandshakeHandle.__wrap(ret[0]);
}

/**
 * List publicly advertised Paykit receiver paths for a Pubky identity.
 *
 * Discovery helper only — payment flows should still use the exact
 * receiver path selected by the app. Resolves to a sorted string array;
 * a missing tree is `[]`.
 * @param {PubkyClient} client
 * @param {string} owner_pubky
 * @returns {Promise<any>}
 */
export function listPaykitReceiverPaths(client, owner_pubky) {
    _assertClass(client, PubkyClient);
    const ptr0 = passStringToWasm0(owner_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.listPaykitReceiverPaths(client.__wbg_ptr, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * List the Payment Endpoint Identifiers a peer has published publicly.
 *
 * Same fetch as `getPaymentList`; resolves to a sorted string array.
 * A missing directory is `[]`.
 * @param {PubkyClient} client
 * @param {string} payee_pubky
 * @param {string} receiver_path_value
 * @returns {Promise<any>}
 */
export function listPaymentMethods(client, payee_pubky, receiver_path_value) {
    _assertClass(client, PubkyClient);
    const ptr0 = passStringToWasm0(payee_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(receiver_path_value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.listPaymentMethods(client.__wbg_ptr, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Maximum plaintext size of one Private Application Message, in bytes.
 *
 * This is `pubky_noise`'s fixed message buffer (1000 bytes). JSON envelope
 * bytes count against it; callers should budget payloads accordingly.
 * @returns {number}
 */
export function maxNoiseMessageLen() {
    const ret = wasm.maxNoiseMessageLen();
    return ret >>> 0;
}

/**
 * Derive the public key published in a Receiver Marker from a receiver
 * Noise secret key. Returns the z-base-32 encoding.
 *
 * Mirrors `paykit_sdk::ReceiverNoiseSecretKey::public_key()`.
 * @param {Uint8Array} secret
 * @returns {string}
 */
export function noisePublicKeyFromSecret(secret) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.noisePublicKeyFromSecret(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * AEAD tag overhead per encrypted Noise message, in bytes.
 * @returns {number}
 */
export function noiseTagLen() {
    const ret = wasm.noiseTagLen();
    return ret >>> 0;
}

/**
 * Parse a versioned `paykit.private_payment_list` JSON message.
 *
 * Returns `{ identifier: payload, ... }`. There is no homeserver GET for
 * private endpoints — they arrive as Encrypted Link messages. Rejects
 * invalid identifiers, unknown versions/kinds, or malformed JSON.
 * @param {string} json
 * @returns {object}
 */
export function parsePrivatePaymentListJson(json) {
    const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parsePrivatePaymentListJson(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Unauthenticated public GET of `{ownerPubky}{path}`.
 *
 * `ownerPubky` accepts z-base-32 or 64-hex. A homeserver 404 or 410
 * resolves to `undefined`; other failures reject. Used to fetch a
 * paykit-connect SB2 handoff from `/pub/`.
 * @param {PubkyClient} client
 * @param {string} owner_pubky
 * @param {string} path
 * @returns {Promise<any>}
 */
export function publicGet(client, owner_pubky, path) {
    _assertClass(client, PubkyClient);
    const ptr0 = passStringToWasm0(owner_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.publicGet(client.__wbg_ptr, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Publish a public Paykit Receiver Marker for the session owner, making the
 * receiver path discoverable and advertising the receiver Noise public key
 * used for Encrypted Link path derivation.
 *
 * A messaging-only receiver typically sets `privatePayments = true` (the
 * Encrypted Link capability) and the payment capabilities to `false`.
 * @param {SessionHandle} session
 * @param {string} receiver_path_value
 * @param {string} noise_public_key
 * @param {boolean} private_payments
 * @param {boolean} payment_requests
 * @param {boolean} receipts
 * @param {boolean} outgoing_payments
 * @returns {Promise<any>}
 */
export function publishReceiverMarker(session, receiver_path_value, noise_public_key, private_payments, payment_requests, receipts, outgoing_payments) {
    _assertClass(session, SessionHandle);
    const ptr0 = passStringToWasm0(receiver_path_value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(noise_public_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.publishReceiverMarker(session.__wbg_ptr, ptr0, len0, ptr1, len1, private_payments, payment_requests, receipts, outgoing_payments);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Remove a public Payment Endpoint owned by the session.
 *
 * A missing endpoint is success (paykit-lib treats homeserver 404 as
 * already absent). Session creation and capability scope remain the
 * caller's responsibility.
 * @param {SessionHandle} session
 * @param {string} receiver_path_value
 * @param {string} identifier
 * @returns {Promise<any>}
 */
export function removePaymentEndpoint(session, receiver_path_value, identifier) {
    _assertClass(session, SessionHandle);
    const ptr0 = passStringToWasm0(receiver_path_value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(identifier, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.removePaymentEndpoint(session.__wbg_ptr, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Remove the session owner's public Paykit Receiver Marker at a path.
 * @param {SessionHandle} session
 * @param {string} receiver_path_value
 * @returns {Promise<any>}
 */
export function removeReceiverMarker(session, receiver_path_value) {
    _assertClass(session, SessionHandle);
    const ptr0 = passStringToWasm0(receiver_path_value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.removeReceiverMarker(session.__wbg_ptr, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Restore an established Encrypted Link from snapshot bytes previously
 * produced by `EncryptedLinkHandle.snapshot()`.
 * @param {SessionHandle} session
 * @param {Uint8Array} noise_secret_key
 * @param {string} remote_pubky
 * @param {string} local_receiver_path
 * @param {string} remote_receiver_path
 * @param {PubkyClient} client
 * @param {Uint8Array} snapshot
 * @returns {Promise<any>}
 */
export function restoreEncryptedLink(session, noise_secret_key, remote_pubky, local_receiver_path, remote_receiver_path, client, snapshot) {
    _assertClass(session, SessionHandle);
    const ptr0 = passArray8ToWasm0(noise_secret_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(remote_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(local_receiver_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(remote_receiver_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    _assertClass(client, PubkyClient);
    const ptr4 = passArray8ToWasm0(snapshot, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.restoreEncryptedLink(session.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, client.__wbg_ptr, ptr4, len4);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Restore an in-progress handshake from snapshot bytes previously produced
 * by `LinkHandshakeHandle.snapshot()`.
 * @param {SessionHandle} session
 * @param {Uint8Array} noise_secret_key
 * @param {string} remote_pubky
 * @param {string} local_receiver_path
 * @param {string} remote_receiver_path
 * @param {PubkyClient} client
 * @param {Uint8Array} snapshot
 * @returns {Promise<any>}
 */
export function restoreEncryptedLinkHandshake(session, noise_secret_key, remote_pubky, local_receiver_path, remote_receiver_path, client, snapshot) {
    _assertClass(session, SessionHandle);
    const ptr0 = passArray8ToWasm0(noise_secret_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(remote_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(local_receiver_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(remote_receiver_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    _assertClass(client, PubkyClient);
    const ptr4 = passArray8ToWasm0(snapshot, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.restoreEncryptedLinkHandshake(session.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, client.__wbg_ptr, ptr4, len4);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Decrypt an SB2 envelope for the recipient X25519 secret key.
 *
 * Binds `Sb2::decode` + `Sb2::decrypt`. `ownerPubky` accepts z-base-32 or
 * 64-hex. `canonicalPath` must match the path bound into the AAD at encrypt.
 * @param {Uint8Array} envelope
 * @param {Uint8Array} recipient_sk
 * @param {string} owner_pubky
 * @param {string} canonical_path
 * @returns {Uint8Array}
 */
export function sb2Decrypt(envelope, recipient_sk, owner_pubky, canonical_path) {
    const ptr0 = passArray8ToWasm0(envelope, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(recipient_sk, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(owner_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(canonical_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.sb2Decrypt(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v5;
}

/**
 * Encrypt plaintext to an unsigned SB2 binary envelope.
 *
 * Binds `Sb2::encrypt_with_cert_id` + `Sb2::encode`. Does not reimplement
 * the cipher. Plaintext is capped at 64 KiB and `msg_id` at 128 ASCII
 * characters by the encoder. `ownerPubky`, `senderPeerid`, and
 * `recipientPeerid` accept z-base-32 or 64-hex.
 *
 * Call `sb2Sign` afterwards when the envelope must authenticate the sender.
 * @param {Uint8Array} recipient_inbox_pk
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} context_id
 * @param {string | null | undefined} msg_id
 * @param {string | null | undefined} purpose
 * @param {string} owner_pubky
 * @param {string} sender_peerid
 * @param {string} recipient_peerid
 * @param {string} canonical_path
 * @param {bigint | null} [created_at]
 * @param {bigint | null} [expires_at]
 * @param {Uint8Array | null} [cert_id]
 * @returns {Uint8Array}
 */
export function sb2Encrypt(recipient_inbox_pk, plaintext, context_id, msg_id, purpose, owner_pubky, sender_peerid, recipient_peerid, canonical_path, created_at, expires_at, cert_id) {
    const ptr0 = passArray8ToWasm0(recipient_inbox_pk, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(context_id, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    var ptr3 = isLikeNone(msg_id) ? 0 : passStringToWasm0(msg_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len3 = WASM_VECTOR_LEN;
    var ptr4 = isLikeNone(purpose) ? 0 : passStringToWasm0(purpose, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len4 = WASM_VECTOR_LEN;
    const ptr5 = passStringToWasm0(owner_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passStringToWasm0(sender_peerid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passStringToWasm0(recipient_peerid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passStringToWasm0(canonical_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len8 = WASM_VECTOR_LEN;
    var ptr9 = isLikeNone(cert_id) ? 0 : passArray8ToWasm0(cert_id, wasm.__wbindgen_malloc);
    var len9 = WASM_VECTOR_LEN;
    const ret = wasm.sb2Encrypt(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, !isLikeNone(created_at), isLikeNone(created_at) ? BigInt(0) : created_at, !isLikeNone(expires_at), isLikeNone(expires_at) ? BigInt(0) : expires_at, ptr9, len9);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v11 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v11;
}

/**
 * Sign an SB2 envelope with the sender's Ed25519 secret key.
 *
 * Binds `Sb2::decode` + `Sb2::sign` + `Sb2::encode`. `ownerPubky` accepts
 * z-base-32 or 64-hex and must match the path bound into the AAD at encrypt.
 * @param {Uint8Array} envelope
 * @param {Uint8Array} sender_ed25519_sk
 * @param {string} owner_pubky
 * @param {string} canonical_path
 * @returns {Uint8Array}
 */
export function sb2Sign(envelope, sender_ed25519_sk, owner_pubky, canonical_path) {
    const ptr0 = passArray8ToWasm0(envelope, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(sender_ed25519_sk, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(owner_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(canonical_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.sb2Sign(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v5;
}

/**
 * Verify the Ed25519 signature on an SB2 envelope.
 *
 * Returns `true` when a signature is present and valid, `false` when no
 * signature is present. Rejects when a signature is present but invalid
 * (mirrors `pubky_noise` UniFFI `sb2_verify_signature`).
 *
 * `ownerPubky` accepts z-base-32 or 64-hex and is normalized to 32 bytes.
 * @param {Uint8Array} envelope
 * @param {string} owner_pubky
 * @param {string} canonical_path
 * @returns {boolean}
 */
export function sb2VerifySignature(envelope, owner_pubky, canonical_path) {
    const ptr0 = passArray8ToWasm0(envelope, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(owner_pubky, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(canonical_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.sb2VerifySignature(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Serialize a complete Private Payment List to its versioned JSON wire form.
 *
 * `endpoints` is a plain object `{ identifier: payload }`. The result is
 * the full latest-state message (`version` 1, kind
 * `paykit.private_payment_list`), not a patch. Do not log payloads.
 * @param {object} endpoints
 * @returns {string}
 */
export function serializePrivatePaymentListJson(endpoints) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.serializePrivatePaymentListJson(endpoints);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Publish or update a public Payment Endpoint for the session owner.
 *
 * Authenticated PUT via the session. Path construction stays inside
 * paykit-lib (`PAYKIT_PATH_PREFIX`). Session creation, capability scope
 * (`/pub/paykit/:rw`), and key rotation remain the caller's
 * responsibility. Do not log `payload`.
 * @param {SessionHandle} session
 * @param {string} receiver_path_value
 * @param {string} identifier
 * @param {string} payload
 * @returns {Promise<any>}
 */
export function setPaymentEndpoint(session, receiver_path_value, identifier, payload) {
    _assertClass(session, SessionHandle);
    const ptr0 = passStringToWasm0(receiver_path_value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(identifier, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(payload, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.setPaymentEndpoint(session.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Sign out and invalidate the homeserver session (cookie) server-side.
 * Consumes the `SessionHandle`.
 * @param {SessionHandle} session
 * @returns {Promise<any>}
 */
export function signOutSession(session) {
    _assertClass(session, SessionHandle);
    var ptr0 = session.__destroy_into_raw();
    const ret = wasm.signOutSession(ptr0);
    return ret;
}

/**
 * Generate a random X25519 keypair.
 *
 * Returns `{ publicKey, secretKey }` as lowercase 64-character hex strings.
 * This is **not** `generateNoiseSecretKey` (that is an Ed25519 seed).
 *
 * Binds `pubky_crypto::sealed_blob::x25519_generate_keypair`.
 * @returns {object}
 */
export function x25519GenerateKeypair() {
    const ret = wasm.x25519GenerateKeypair();
    return ret;
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_debug_string_d89627202d0155b7: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_2a95406423ea8626: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_59a002e76b059312: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_624d5244bb2bc87c: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_87a3a837f331fef5: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_number_get_769f3676dc20c1d7: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_f1161390414f9b59: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_5549492daedad139: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_fbe69bb076c16bad: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_abort_b007790bcfd9fff2: function(arg0, arg1) {
            arg0.abort(arg1);
        },
        __wbg_abort_bdf419e9dcbdaeb3: function(arg0) {
            arg0.abort();
        },
        __wbg_append_7c8e49986ab5288d: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_arrayBuffer_9f258d017f7107c5: function() { return handleError(function (arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        }, arguments); },
        __wbg_buffer_0a57788cdfce21ba: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_byobRequest_ab0e57f55bf774f2: function(arg0) {
            const ret = arg0.byobRequest;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_byteLength_9931db00e5861bf9: function(arg0) {
            const ret = arg0.byteLength;
            return ret;
        },
        __wbg_byteOffset_0a985a98f8ffb8d7: function(arg0) {
            const ret = arg0.byteOffset;
            return ret;
        },
        __wbg_call_4f2f92601568b772: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_call_6ae20895a60069a2: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_8f5d7bb070283508: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_clearTimeout_2256f1e7b94ef517: function(arg0) {
            const ret = clearTimeout(arg0);
            return ret;
        },
        __wbg_close_62f6a4eadc94565f: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_close_f287058716088a50: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_defineProperty_0096265c3e5479b6: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.defineProperty(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_done_19f92cb1f8738aba: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_encryptedlinkhandle_new: function(arg0) {
            const ret = EncryptedLinkHandle.__wrap(arg0);
            return ret;
        },
        __wbg_enqueue_ee0593cea9be93bd: function() { return handleError(function (arg0, arg1) {
            arg0.enqueue(arg1);
        }, arguments); },
        __wbg_entries_dc69bbf25538adc3: function(arg0) {
            const ret = arg0.entries();
            return ret;
        },
        __wbg_fetch_3f39346b50886803: function(arg0, arg1) {
            const ret = arg0.fetch(arg1);
            return ret;
        },
        __wbg_fetch_43b2f110608a59ff: function(arg0) {
            const ret = fetch(arg0);
            return ret;
        },
        __wbg_getRandomValues_3f44b700395062e5: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getRandomValues_76dfc69825c9c552: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_get_94f5fc088edd3138: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_ff5f1fb220233477: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_has_3f87d148146a0f4e: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.has(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_headers_6ccffabdaab0d021: function(arg0) {
            const ret = arg0.headers;
            return ret;
        },
        __wbg_instanceof_Response_fece7eabbcaca4c3: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_867202cf8f195ed8: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_keys_e84d806594765111: function(arg0) {
            const ret = Object.keys(arg0);
            return ret;
        },
        __wbg_length_e6e1633fbea6cfa9: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_fae3e439140f48a4: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_linkhandshakehandle_new: function(arg0) {
            const ret = LinkHandshakeHandle.__wrap(arg0);
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_1d96678aaacca32e: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_210ef5849ab6cf48: function() { return handleError(function () {
            const ret = new Headers();
            return ret;
        }, arguments); },
        __wbg_new_4370be21fa2b2f80: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_48e1d86cfd30c8e7: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_4a843fe2ee4082a9: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_694161c660bbefba: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h31c10299f3023db4(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_ce17f0bcfcc7b8ef: function() { return handleError(function () {
            const ret = new AbortController();
            return ret;
        }, arguments); },
        __wbg_new_from_slice_0bc58e36f82a1b50: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_25dda2388d7e5e9f: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h31c10299f3023db4(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_byte_offset_and_length_ab1e1002d7a694e4: function(arg0, arg1, arg2) {
            const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_new_with_length_0f3108b57e05ed7c: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_str_and_init_cb3df438bf62964e: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_next_e34cfb9df1518d7c: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_46736a527d2e74e7: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
            const ret = arg0.performance;
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_3875d54d12ef2eec: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_d0006a37f9fcda6d: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queueMicrotask_8868365114fe23b5: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_queueMicrotask_cfc5a0e62f9ebdbe: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_resolve_d8059bc113e215bf: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_respond_1ec29395edbe7fce: function() { return handleError(function (arg0, arg1) {
            arg0.respond(arg1 >>> 0);
        }, arguments); },
        __wbg_sessionhandle_new: function(arg0) {
            const ret = SessionHandle.__wrap(arg0);
            return ret;
        },
        __wbg_setTimeout_b188b3bcc8977c7d: function(arg0, arg1) {
            const ret = setTimeout(arg0, arg1);
            return ret;
        },
        __wbg_set_295bad3b5ead4e99: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbg_set_991082a7a49971cf: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_body_e2cf9537a2f3e0be: function(arg0, arg1) {
            arg0.body = arg1;
        },
        __wbg_set_cache_542e710bfd7aa57a: function(arg0, arg1) {
            arg0.cache = __wbindgen_enum_RequestCache[arg1];
        },
        __wbg_set_credentials_5838a4909b379d8e: function(arg0, arg1) {
            arg0.credentials = __wbindgen_enum_RequestCredentials[arg1];
        },
        __wbg_set_headers_22d4b01224273a83: function(arg0, arg1) {
            arg0.headers = arg1;
        },
        __wbg_set_method_4a4ab3faba8a018c: function(arg0, arg1, arg2) {
            arg0.method = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_mode_7b856ab49b64c0db: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_RequestMode[arg1];
        },
        __wbg_set_name_3a8e5679e3158633: function(arg0, arg1, arg2) {
            arg0.name = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_signal_cd4528432ab8fe0b: function(arg0, arg1) {
            arg0.signal = arg1;
        },
        __wbg_signal_6740ecf9bc372e29: function(arg0) {
            const ret = arg0.signal;
            return ret;
        },
        __wbg_static_accessor_GLOBAL_8dfb7f5e26ebe523: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_941154efc8395cdd: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_58dac9af822f561f: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_ee64f0b3d8354c0b: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_1ae443dc56281de7: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_subarray_035d32bb24a7d55d: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_text_6d3a70da69d27961: function() { return handleError(function (arg0) {
            const ret = arg0.text();
            return ret;
        }, arguments); },
        __wbg_then_0150352e4ad20344: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_5160486c67ddb98a: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_url_c6d54634d7005dd1: function(arg0, arg1) {
            const ret = arg1.url;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_value_d5b248ce8419bd1b: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbg_view_38a930844c964103: function(arg0) {
            const ret = arg0.view;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 1279, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h0c1430703438ec11);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 1105, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h7d83aa45adf6d0a1);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./paykit_wasm_bg.js": import0,
    };
}

function wasm_bindgen__convert__closures_____invoke__h7d83aa45adf6d0a1(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__h7d83aa45adf6d0a1(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h0c1430703438ec11(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h0c1430703438ec11(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h31c10299f3023db4(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h31c10299f3023db4(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_ReadableStreamType = ["bytes"];


const __wbindgen_enum_RequestCache = ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"];


const __wbindgen_enum_RequestCredentials = ["omit", "same-origin", "include"];


const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];
const AuthFlowHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_authflowhandle_free(ptr >>> 0, 1));
const EncryptedLinkHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_encryptedlinkhandle_free(ptr >>> 0, 1));
const IntoUnderlyingByteSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingbytesource_free(ptr >>> 0, 1));
const IntoUnderlyingSinkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsink_free(ptr >>> 0, 1));
const IntoUnderlyingSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsource_free(ptr >>> 0, 1));
const LinkHandshakeHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_linkhandshakehandle_free(ptr >>> 0, 1));
const MemoryNoiseSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_memorynoisesession_free(ptr >>> 0, 1));
const PubkyClientFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pubkyclient_free(ptr >>> 0, 1));
const SessionHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sessionhandle_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('paykit_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
