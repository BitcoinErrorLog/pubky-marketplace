// Type-only imports are erased at compile time; the WASM module itself is only ever
// loaded through the dynamic import in loadPaykitWasm(), never at module scope, so this
// file stays safe to pull into server-rendered module graphs (same rule as the Locks SDK).
import type { EncryptedLinkHandle, LinkHandshakeHandle, PubkyClient, SessionHandle } from 'paykit-wasm';
import {
  buildChatMessage,
  decodeChatMessage,
  isListingConversationBound,
  MARKETPLACE_CHAT_MESSAGE_KIND,
  type MarketplaceChatMessage,
  PAYKIT_MESSAGING_CAPABILITY,
  PAYKIT_MESSAGING_RECEIVER_PATH,
} from '@/libs/commerce/messaging-contracts';
import { isMessagingKeyringChanged } from '@/libs/crypto/messaging-keyring';
import { isAppError } from '@/libs/error/error';
import {
  AuthErrorCode,
  ClientErrorCode,
  DatabaseErrorCode,
  ServerErrorCode,
  ValidationErrorCode,
} from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import {
  buildDmConversationId,
  buildDmMessage,
  decodeDmMessage,
  PUBKY_APP_DM_KIND,
  type PubkyAppDmMessage,
} from '@/libs/messaging/dm-contracts';
import type { ConversationOrigin } from '@/libs/messaging/first-contact';
import type { MessagingIntakeGate } from '@/libs/messaging/intake-gate';
import {
  isMarkerReadFailure,
  type MarkerReadFailureReason,
  type MarkerReadSleep,
  readMarkerWithRetry,
  realMarkerReadSleep,
} from '@/libs/messaging/marker-read';
import { RetryBackoff } from '@/libs/messaging/retry-backoff';
import { getTestnet } from '@/libs/runtime-config/runtime-config';
import type { CommerceMessagingReceiverModelSchema } from '@/models/messaging/messaging.schema';
import { retryHomeserverWrite } from '@/services/homeserver/write-retry';
import { LocalMessagingService } from '@/services/local/messaging/messaging';

type PaykitWasmModule = typeof import('paykit-wasm');

let wasmModulePromise: Promise<PaykitWasmModule> | null = null;
let moduleOverrideForTests: PaykitWasmModule | null = null;
const LOCKED_WRITE_RETRY_BUDGET_MS = 2_000;
const LOCKED_BINDING_RETRIES = 0;

/**
 * Loads and initializes the vendored paykit-wasm binding exactly once. The dynamic
 * import keeps the ~1.5 MB WASM binary out of every server-rendered and initial-client
 * module graph; it is only fetched when a messaging operation actually runs in the
 * browser. Mirrors the Locks SDK loading pattern (locks.ts).
 */
async function loadPaykitWasm(): Promise<PaykitWasmModule> {
  if (moduleOverrideForTests) return moduleOverrideForTests;
  wasmModulePromise ??= (async () => {
    const sdk = await import('paykit-wasm');
    await sdk.default();
    return sdk;
  })();
  try {
    return await wasmModulePromise;
  } catch (error) {
    // A failed WASM fetch/instantiation must stay retryable on the next call.
    wasmModulePromise = null;
    throw error;
  }
}

/**
 * Test seam: unit tests initialize the REAL vendored module from file bytes
 * (jsdom cannot fetch the .wasm asset) — or a purpose-built fake for
 * orchestration-logic tests — and inject it here. Never used in production.
 */
export function setPaykitWasmModuleForTests(wasmModule: PaykitWasmModule | null): void {
  moduleOverrideForTests = wasmModule;
  wasmModulePromise = null;
}

/** Marker facts for a counterparty who has enabled encrypted messaging. */
export type CounterpartyMessagingMarker = {
  receiverPath: string;
  noisePublicKey: string;
};

export type MessagingEnableFlow = {
  authorizationUrl: string;
  awaitEnabled: () => Promise<MessagingEnabledInfo>;
  cancel: () => void;
};

export type MessagingEnabledInfo = {
  pubky: string;
  receiverPath: string;
  noisePublicKey: string;
};

/**
 * The truthful conversation transport states, empirically grounded in the
 * binding's semantics:
 *
 * - `not-enrolled`: the counterparty has published no receiver marker — no
 *   handshake can even start, and the UI must say so, never fake delivery.
 * - `handshaking`: a Noise XX handshake is queued on the homeservers. XX
 *   needs BOTH parties: the initiator writes message 1 and then CANNOT send
 *   application messages until the counterparty's runtime reads it and
 *   answers (messages 2/3 alternate). So `role: 'initiator'` means "waiting
 *   for the counterparty to open their messages"; `role: 'responder'` means
 *   an inbound handshake is being answered and completion needs the
 *   initiator to come back online for the final round.
 * - `ready`: the link is established; sends/receives are live.
 * - `key-changed`: the counterparty's marker advertises a different key than
 *   the one pinned for them on this device (trust on first use: the key of
 *   the first link). It may be their new device or app, or a takeover of
 *   their marker; nothing tells the two apart. No handshake is started with
 *   the new key and nothing is sent until the user accepts it
 *   ({@link PaykitMessagingService.acceptCounterpartyKey}); an established
 *   link on the pinned key keeps receiving. The marker is read again on the
 *   retry schedule, and the state clears if it advertises the pinned key
 *   again.
 * - `recovery-needed`: a persisted link cannot proceed — a handshake or
 *   established snapshot failed to restore, a send may have left after the
 *   saved snapshot, or the binding reported a link bound to another key than
 *   the pinned one. Every local row and remote slot is kept and the link is
 *   retried unchanged on an exponential, jittered, capped schedule
 *   (`MESSAGING_RETRY_POLICY`); nothing is deleted or restarted.
 * - `unreachable`: the counterparty's receiver marker could not be read —
 *   their homeserver did not resolve or answer, or the marker they publish is
 *   unusable. This says nothing about whether they enabled messaging, so it
 *   is neither `not-enrolled` nor a failure of this account. It is retried
 *   on the same backoff schedule as `recovery-needed` and never stops other
 *   counterparties from syncing.
 */
export type MessagingLinkState =
  | { status: 'not-enrolled' }
  | { status: 'unreachable'; reason: MarkerReadFailureReason }
  | { status: 'handshaking'; role: 'initiator' | 'responder' }
  | { status: 'key-changed'; pinnedKey: string; observedKey: string }
  | {
      status: 'recovery-needed';
      reason: 'handshake-restore-failed' | 'link-restore-failed' | 'link-key-mismatch' | 'send-state-unknown';
    }
  | { status: 'ready' };

/**
 * What the own-marker check found and did on a resumed session: `replaced`
 * — the published marker advertised another key (another app or device
 * wrote it), and this device published its own again; `missing` — no marker
 * was published, and this device published it again.
 */
export type OwnMarkerRepublished = 'replaced' | 'missing';

/** The keys a conversation's Verify step shows: this device's, and the one pinned for the counterparty. */
export type MessagingKeys = {
  ownKey: string | null;
  pinnedKey: string | null;
  observedKey: string | null;
};

/** Probe-only result: `none` means no local state and no inbound handshake — nothing was started. */
export type MessagingProbeState = MessagingLinkState | { status: 'none' };

/**
 * One inbound message after kind routing, flattened to the persisted row's
 * vocabulary: `kind: 'listing'` came in as `marketplace.chat_message.v0` (its
 * own `conversation_id`/`listing_ref` from the envelope, accepted only when
 * they name both link endpoints), `kind: 'dm'` came in
 * as `pubky_app.dm.v0` (conversation identity derived from the counterparty).
 */
export type ReceivedMessage = {
  kind: 'listing' | 'dm';
  event_id: string;
  conversation_id: string;
  listing_ref: string | null;
  sent_at: number;
  body: string;
  counterpartyPubky: string;
};

type ActiveSession = { handle: SessionHandle; pubky: string };
/** `boundKey` is the counterparty key the handshake was created with: the key its link must report. */
type ActiveHandshake = { handle: LinkHandshakeHandle; role: 'initiator' | 'responder'; boundKey: string };

/**
 * `localStorage` key for the persisted messaging-session metadata. The
 * stored value is the binding's `exportSession()` string — base64 public
 * `SessionInfo` (pubky, capabilities), NO secrets. The actual credential is
 * the homeserver's HTTP-only session cookie, which the BROWSER holds and
 * attaches (`credentials: include`); this app can neither read nor persist
 * it. Storage contract mirrors the marketplace transaction session
 * (`marketplace-session.ts`): `localStorage` (survives tabs and restarts —
 * the cookie, which the browser shares across tabs, is the real credential),
 * account-scoped validation on restore, cleared on sign-out/account switch.
 * A restore the homeserver rejects falls through to cookie resume, and only
 * when that also fails does the UI surface the honest reconnect state.
 */
export const MESSAGING_SESSION_STORAGE_KEY = 'pubky.messaging.session.v1';

/**
 * End-to-end-encrypted messaging over Paykit Encrypted Links (vendored
 * paykit-wasm binding). One link per counterparty pair carries BOTH message
 * kinds — marketplace listing conversations (`marketplace.chat_message.v0`)
 * and general direct messages (`pubky_app.dm.v0`); the kind on the wire
 * decides which conversation an inbound message lands in.
 *
 * This service is deliberately independent of the commerce adapter mode: it
 * needs only a signed-in user, a browser environment for the WASM binding,
 * and the homeserver. Marketplace-contextual SURFACES gate themselves on the
 * commerce mode (the sandbox keeps its own labeled plaintext transport for
 * listing chat); general DMs never do.
 *
 * Key facts the rest of the app relies on:
 *
 * - The homeserver session normally comes from the app's OWN sign-in: the
 *   Ring cookie sign-in set (`RING_COOKIE_CAPABILITIES`, which includes
 *   `/pub/paykit/:rw`) already covers the Paykit tree, and the credential is the HTTP-only
 *   homeserver cookie the BROWSER holds from that sign-in. The binding's
 *   `resumeSessionFromCookie` rebuilds a session handle from that cookie
 *   with ZERO additional signer approvals ({@link restorePersistedSession}
 *   resume order: in-memory session → persisted `exportSession` metadata →
 *   cookie resume → only then the interactive flow). The Pubky identity
 *   secret never enters this runtime, and this code persists only
 *   secret-free session metadata to `localStorage`
 *   ({@link MESSAGING_SESSION_STORAGE_KEY}) so later loads take the fast
 *   path. The interactive Ring approval ({@link beginEnableFlow}) remains
 *   ONLY for legacy sessions whose sign-in predates the combined grant
 *   (cookie resume rejects with `SessionResumeScopeMissing`) or whose
 *   cookie the homeserver no longer accepts.
 * - Link crypto uses a receiver-scoped Noise key generated here and persisted
 *   in account-scoped IndexedDB (`commerce_messaging_receivers`); the secret
 *   and every link snapshot are encrypted at rest by `LocalMessagingService`
 *   (AES-GCM-256 under the non-extractable keyring key, AAD-bound to their
 *   table row — see `src/libs/crypto/`), so this service only ever handles
 *   them unwrapped in memory. The multi-device backup-key decision stays an
 *   open product decision: wrapped rows remain device-local.
 * - The binding rejects overlapping operations per link ("operation in
 *   flight"), so every public operation is serialized per counterparty.
 * - Received messages are persisted BEFORE the advanced link snapshot — the
 *   read checkpoint moves past returned messages, so the reversed order
 *   would lose them on a crash.
 */
export class PaykitMessagingService {
  private constructor() {}

  private static configureLinkWriteRetries(link: EncryptedLinkHandle): EncryptedLinkHandle {
    // The binding sleeps inside `send`, while the cross-tab pair lock is held.
    // Let the durable outbox schedule the next attempt after this lock releases.
    link.setMaxSendRetries?.(LOCKED_BINDING_RETRIES);
    return link;
  }

  private static configureHandshakeWriteRetries(handshake: LinkHandshakeHandle): LinkHandshakeHandle {
    // A failed handshake step is restored on the pair's outer retry schedule.
    // Never hold every tab out while the binding performs delayed recovery.
    handshake.setMaxRecoveryAttempts?.(LOCKED_BINDING_RETRIES);
    return handshake;
  }

  private static session: ActiveSession | null = null;
  private static restoreInFlight: { pubky: string; done: Promise<boolean> } | null = null;
  private static client: PubkyClient | null = null;
  private static links = new Map<string, EncryptedLinkHandle>();
  /**
   * Pairs whose live handle sent a message after its last saved snapshot,
   * because saving the snapshot after the send failed. Restoring such a
   * pair from the saved snapshot would send again under a counter the peer
   * already received, so the handle is kept and the snapshot is saved
   * before anything else runs on the pair.
   */
  private static unsavedSends = new Set<string>();
  /**
   * The link row revision this tab last wrote or read for each pair, taken
   * while holding the pair's lock (see {@link withLinkLock}).
   */
  private static linkRevisions = new Map<string, string | null>();
  private static handshakes = new Map<string, ActiveHandshake>();
  private static queues = new Map<string, Promise<unknown>>();
  // Automatic retries are spaced by MESSAGING_RETRY_POLICY, never by the
  // surfaces' poll cadence. Cleared with the session.
  private static linkRetry = new RetryBackoff<MessagingProbeState>();
  private static sessionRetry = new RetryBackoff<true>();
  private static receiverRetry = new RetryBackoff<true>();
  /** Accounts under {@link withoutReceiverProvisioning}, with how many holds each. */
  private static provisioningHolds = new Map<string, number>();
  /** Accounts whose published marker was confirmed (or published) by this session. Cleared with the session. */
  private static ownMarkerChecked = new Set<string>();
  /**
   * The receiver check running for each account and the session it runs
   * for. Another check of that session joins it, so status reads retried
   * while one is slow never queue more receiver-lock requests or marker
   * reads behind it. Cleared with the session.
   */
  private static provisioningInFlight = new Map<string, { session: ActiveSession; run: Promise<void> }>();
  /** What the own-marker check republished and the user has not been told yet, per account. */
  private static ownMarkerNotices = new Map<string, OwnMarkerRepublished>();
  private static markerReadSleep: MarkerReadSleep = realMarkerReadSleep;

  /** Test seam: replaces the wait between marker read attempts. Never used in production. */
  static setMarkerReadSleepForTests(sleep: MarkerReadSleep | null): void {
    this.markerReadSleep = sleep ?? realMarkerReadSleep;
  }

  /**
   * Starts the interactive enable flow: a fresh `pubkyauth://` URL for the
   * `/pub/paykit/:rw` grant to show on the user's signer, and a lazy
   * `awaitEnabled` that — once approved — verifies the approving identity,
   * provisions (or reuses) the receiver Noise key, and publishes the receiver
   * marker that makes this user discoverable for encrypted messaging.
   *
   * This flow is the LAST resort in the resume order: it is only reached for
   * sign-ins that predate the combined grant (no `/pub/paykit/` scope in the
   * session cookie) or whose cookie the homeserver no longer accepts —
   * current sign-ins resume silently via {@link restorePersistedSession}.
   *
   * `cancel` detaches the flow: the binding exposes no abort for a pending
   * approval, so a later approval on a detached flow is dropped (its session
   * handle is freed unused).
   */
  static async beginEnableFlow(expectedPubky: string): Promise<MessagingEnableFlow> {
    const wasmModule = await loadPaykitWasm();
    const client = this.getClient(wasmModule);
    const flow = client.startAuthFlow(PAYKIT_MESSAGING_CAPABILITY);
    let detached = false;
    return {
      authorizationUrl: flow.authorizationUrl(),
      cancel: () => {
        detached = true;
      },
      awaitEnabled: async () => {
        const handle = (await flow.awaitApproval()) as SessionHandle;
        if (detached) {
          handle.free();
          throw Err.client(ClientErrorCode.BAD_REQUEST, 'The messaging enable flow was cancelled.', {
            service: ErrorService.Paykit,
            operation: 'awaitEnabled',
          });
        }
        const pubky = handle.pubky();
        if (pubky !== expectedPubky) {
          handle.free();
          throw Err.auth(
            AuthErrorCode.INVALID_TOKEN,
            'The signer approved with a different identity than the signed-in user.',
            { service: ErrorService.Paykit, operation: 'awaitEnabled' },
          );
        }
        const enabled = await this.provisionReceiver(wasmModule, handle, pubky);
        this.setSession({ handle, pubky });
        return enabled;
      },
    };
  }

  /** True while a Ring-approved messaging session for this pubky is held in memory. */
  static hasActiveSession(pubky: string): boolean {
    return this.session?.pubky === pubky;
  }

  /**
   * Attempts to silently resume the messaging session, in strict order:
   *
   * 1. in-memory session (already live in this tab),
   * 2. persisted `exportSession` metadata + the browser's HTTP-only cookie
   *    via the binding's `restoreSession` (revalidates against the
   *    homeserver),
   * 3. cookie-ONLY resume via the binding's `resumeSessionFromCookie` — the
   *    zero-approval path: the app's sign-in grant already covers
   *    `/pub/paykit/:rw`, so the sign-in cookie alone is sufficient. On
   *    success the session is persisted via `exportSession` exactly like
   *    the approval path, so subsequent loads take path 2.
   *
   * Only when ALL of these fail does the UI show the interactive enable
   * flow — which is now reachable ONLY by legacy sessions without the
   * paykit scope or cookies the homeserver rejects. Every successful resume
   * also ensures the receiver key + marker are provisioned, so messaging
   * surfaces go straight to ready after sign-in. Never throws for "no
   * session"; concurrent callers share one in-flight resume.
   *
   * `provision: false` resumes the session only: whenever it settles, it
   * never creates, replaces or publishes a receiver key. A caller that
   * joins a resume already in flight gets that resume's outcome.
   */
  static async restorePersistedSession(
    expectedPubky: string,
    { provision = true }: { provision?: boolean } = {},
  ): Promise<boolean> {
    if (this.hasActiveSession(expectedPubky)) {
      if (provision) await this.ensureReceiverProvisioned(expectedPubky);
      return true;
    }
    if (this.restoreInFlight?.pubky === expectedPubky) return await this.restoreInFlight.done;
    // A failed silent resume is not retried on every status poll: until the
    // next spaced attempt the answer stays "no session" (the enable flow and
    // sign-out both reset the schedule).
    if (this.sessionRetry.status(expectedPubky) === 'waiting') return false;
    const done = this.resumeSessionSilently(expectedPubky, provision);
    this.restoreInFlight = { pubky: expectedPubky, done };
    try {
      const resumed = await done;
      if (resumed) this.sessionRetry.succeed(expectedPubky);
      else this.sessionRetry.fail(expectedPubky, true);
      return resumed;
    } finally {
      this.restoreInFlight = null;
    }
  }

  /** Paths 2 and 3 of the resume order, plus receiver provisioning on success when `provision` is set. */
  private static async resumeSessionSilently(expectedPubky: string, provision: boolean): Promise<boolean> {
    const resumed =
      (await this.restoreSessionFromStorage(expectedPubky)) || (await this.resumeSessionFromCookie(expectedPubky));
    if (resumed && provision) await this.ensureReceiverProvisioned(expectedPubky);
    return resumed;
  }

  /**
   * The zero-approval resume: rebuilds the session handle purely from the
   * browser's existing homeserver cookie (set by the app's sign-in, whose
   * grant covers `/pub/paykit/:rw`). The binding revalidates against the
   * homeserver and verifies both the identity and the paykit scope, so a
   * `true` here is a fully working messaging session with no signer
   * involvement. Typed failures are deliberate no-session outcomes:
   * `SessionResumeScopeMissing` means the sign-in predates the combined
   * grant (the ONLY population that still sees the enable dialog);
   * `SessionResumeUnauthorized` means the homeserver holds no valid session
   * behind the browser's cookies. Both fall through to the honest
   * reconnect/enable state.
   */
  private static async resumeSessionFromCookie(expectedPubky: string): Promise<boolean> {
    try {
      const wasmModule = await loadPaykitWasm();
      const client = this.getClient(wasmModule);
      const handle = (await client.resumeSessionFromCookie(expectedPubky)) as SessionHandle;
      if (handle.pubky() !== expectedPubky) {
        // Defensive: the binding already rejects this as SessionResumePubkyMismatch.
        closeQuietly(() => handle.free());
        return false;
      }
      // Persist like the approval path so subsequent loads take the
      // restoreSession fast path instead of re-running cookie resume.
      this.setSession({ handle, pubky: expectedPubky });
      Logger.info('Resumed the encrypted messaging session from the sign-in cookie (no signer approval)', {
        pubky: expectedPubky,
      });
      return true;
    } catch (error) {
      if (isErrorNamed(error, 'SessionResumeScopeMissing')) {
        Logger.info('The sign-in session predates the combined paykit grant; messaging needs a one-time approval', {
          pubky: expectedPubky,
        });
      } else {
        Logger.info('Could not resume the messaging session from the sign-in cookie', { error });
      }
      return false;
    }
  }

  /**
   * Ensures the resumed session is usable for RECEIVING, not just holding a
   * session: on the cookie-resume path there was never an enable flow, so
   * the receiver Noise key and the published marker may not exist yet. Runs
   * the same idempotent {@link provisionReceiver} the approval path runs; a
   * transient publish failure is logged and retried on a spaced schedule
   * (this method is on every resume path) instead of failing the session.
   *
   * Once per session, a receiver already marked published is also checked
   * against the marker actually published ({@link reconcileOwnMarker}): any
   * app holding the Paykit scope, or another device of this account, can
   * overwrite it. A marker that advertises another key, or none, is
   * republished with this device's key and the user is told
   * ({@link takeOwnMarkerRepublished}). A marker that cannot be read is
   * checked again on the spaced schedule; nothing is republished on a
   * failed read.
   *
   * A check of the same session already running is joined, not repeated.
   */
  private static async ensureReceiverProvisioned(pubky: string): Promise<void> {
    const session = this.session;
    if (session?.pubky !== pubky) return;
    if (this.provisioningHolds.has(pubky)) {
      Logger.info('Skipped receiver provisioning while background sync holds it', {
        reason: 'receiver_provisioning_held',
      });
      return;
    }
    const running = this.provisioningInFlight.get(pubky);
    if (running?.session === session) return await running.run;
    const run = this.ensureReceiverProvisionedFor(session, pubky).finally(() => {
      if (this.provisioningInFlight.get(pubky)?.run === run) this.provisioningInFlight.delete(pubky);
    });
    this.provisioningInFlight.set(pubky, { session, run });
    return await run;
  }

  private static async ensureReceiverProvisionedFor(session: ActiveSession, pubky: string): Promise<void> {
    const receiver = await this.endSessionIfKeyringChanged(() => LocalMessagingService.getReceiver(pubky));
    if (receiver?.marker_published && this.ownMarkerChecked.has(pubky)) return;
    if (this.receiverRetry.status(pubky) === 'waiting') return;
    try {
      const wasmModule = await loadPaykitWasm();
      if (receiver?.marker_published) {
        const outcome = await this.reconcileOwnMarker(wasmModule, session.handle, pubky);
        if (outcome !== 'match') {
          this.ownMarkerNotices.set(pubky, outcome);
          Logger.warn('The published messaging marker did not advertise this device key; republished it', {
            reason: outcome === 'replaced' ? 'own_marker_replaced' : 'own_marker_missing',
          });
        }
      } else {
        await this.provisionReceiver(wasmModule, session.handle, pubky);
        Logger.info('Provisioned the messaging receiver automatically for the resumed session', { pubky });
      }
      this.receiverRetry.succeed(pubky);
    } catch (error) {
      // Keys reset in another tab end this session; there is nothing to retry.
      if (isMessagingKeyringChanged(error)) throw error;
      this.receiverRetry.fail(pubky, true);
      Logger.warn('Could not provision the messaging receiver for the resumed session; will retry later', {
        error,
      });
    }
  }

  private static async restoreSessionFromStorage(expectedPubky: string): Promise<boolean> {
    const raw = this.readSessionStorage();
    if (raw === null) return false;
    let stored: { pubky?: unknown; exported?: unknown } | null;
    try {
      stored = JSON.parse(raw) as { pubky?: unknown; exported?: unknown };
    } catch {
      stored = null;
    }
    if (!stored || typeof stored.pubky !== 'string' || typeof stored.exported !== 'string') {
      this.removePersistedSessionIfUnchanged(raw);
      return false;
    }
    // Another account's blob is not this restore's; sign-out removes it.
    if (stored.pubky !== expectedPubky) return false;
    try {
      const wasmModule = await loadPaykitWasm();
      const client = this.getClient(wasmModule);
      const handle = (await client.restoreSession(stored.exported)) as SessionHandle;
      if (handle.pubky() !== expectedPubky) {
        closeQuietly(() => handle.free());
        this.removePersistedSessionIfUnchanged(raw);
        return false;
      }
      this.setSession({ handle, pubky: expectedPubky }, raw);
      Logger.info('Restored the encrypted messaging session after reload', { pubky: expectedPubky });
      return true;
    } catch (error) {
      // The homeserver rejected the cookie (expired/revoked) or the restore
      // failed in transit; either way the metadata that was read is useless
      // now. Another tab may have saved a newer session during the await.
      // Cookie resume still runs next — a fresh sign-in may hold a new cookie.
      Logger.info('Could not restore the persisted messaging session from its exported metadata', { error });
      this.removePersistedSessionIfUnchanged(raw);
      return false;
    }
  }

  /**
   * Live-test seam: runs the REAL receiver provisioning and marker publish
   * for a session obtained through the binding's dev/test signup helpers
   * (`signupWithSecret` against an ephemeral local testnet) instead of the
   * Ring approval. Everything downstream — markers, links, crypto,
   * persistence — is the production path; only the interactive signer leg is
   * swapped, exactly as the binding's own e2e does. Never called in
   * production code.
   */
  static async enableWithSessionForTests(handle: SessionHandle): Promise<MessagingEnabledInfo> {
    const wasmModule = await loadPaykitWasm();
    const pubky = handle.pubky();
    const enabled = await this.provisionReceiver(wasmModule, handle, pubky);
    this.setSession({ handle, pubky });
    return enabled;
  }

  /** Facts about local provisioning (no network): has a receiver key + published marker. */
  static async isReceiverProvisioned(pubky: string): Promise<boolean> {
    return (await this.publishedReceiverKey(pubky)) !== null;
  }

  /**
   * The public key of the receiver this device holds for `pubky`, when its
   * marker was published from here; otherwise `null`. Local read only.
   */
  static async publishedReceiverKey(pubky: string): Promise<string | null> {
    const receiver = await this.endSessionIfKeyringChanged(() => LocalMessagingService.getReceiver(pubky));
    return receiver?.marker_published ? receiver.noise_public_key : null;
  }

  /**
   * Runs `operation` while no session resume for `pubky` may create,
   * replace or publish a receiver key. Session resumes still run; the
   * receiver is only ever used as it is. Holds nest.
   */
  static async withoutReceiverProvisioning<T>(pubky: string, operation: () => Promise<T>): Promise<T> {
    this.provisioningHolds.set(pubky, (this.provisioningHolds.get(pubky) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.provisioningHolds.get(pubky) ?? 1) - 1;
      if (remaining > 0) this.provisioningHolds.set(pubky, remaining);
      else this.provisioningHolds.delete(pubky);
    }
  }

  /**
   * Drops the in-memory session, the persisted session metadata, and every
   * live link/handshake handle. Sign-out and account-switch teardown.
   */
  static clearSession(): void {
    this.removePersistedSession();
    this.dropLiveSession();
  }

  /**
   * Account switch without a sign-out: drops the live session and the
   * persisted export of any account but `keepPubky`.
   */
  static clearOtherAccounts(keepPubky: string): void {
    if (this.session && this.session.pubky !== keepPubky) this.dropLiveSession();
    const raw = this.readSessionStorage();
    if (raw === null) return;
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof stored !== 'object' || stored === null || (stored as { pubky?: unknown }).pubky === keepPubky) return;
    this.removePersistedSessionIfUnchanged(raw);
  }

  /** The in-memory half of {@link clearSession}: the session and every live handle, not the persisted slot. */
  private static dropLiveSession(): void {
    for (const link of this.links.values()) closeQuietly(() => void link.close());
    for (const handshake of this.handshakes.values()) closeQuietly(() => handshake.handle.free());
    this.links.clear();
    this.unsavedSends.clear();
    this.linkRevisions.clear();
    this.handshakes.clear();
    this.queues.clear();
    this.linkRetry.clear();
    this.sessionRetry.clear();
    this.receiverRetry.clear();
    this.ownMarkerChecked.clear();
    this.ownMarkerNotices.clear();
    this.provisioningInFlight.clear();
    if (this.session) closeQuietly(() => this.session?.handle.free());
    this.session = null;
    // The client is stateless config; dropping it costs one lazy re-create
    // and keeps a test-injected module from leaking a stale client.
    this.client = null;
  }

  /**
   * Whether a counterparty can receive encrypted messages at all: they must
   * have published a receiver marker (i.e. enabled messaging themselves).
   * Public read — needs no session.
   */
  static async getCounterpartyMarker(counterpartyPubky: string): Promise<CounterpartyMessagingMarker | null> {
    const wasmModule = await loadPaykitWasm();
    return await this.getCounterpartyMarkerWith(wasmModule, counterpartyPubky);
  }

  /**
   * Whether `ownerPubky` publishes a Paykit receiver that takes both private
   * payments and Payment Requests — the receiver a Bitcoin checkout's payment
   * request is delivered to (a Paykit wallet such as Bitkit). The Shop's own
   * messaging receiver never qualifies: it takes private payments only.
   * Public read — needs no session. Rejects when the listing or a marker
   * cannot be read, so a read failure is never reported as "no wallet".
   */
  static async hasPaymentRequestReceiver(ownerPubky: string): Promise<boolean> {
    const wasmModule = await loadPaykitWasm();
    const client = this.getClient(wasmModule);
    const paths: unknown = await wasmModule.listPaykitReceiverPaths(client, ownerPubky);
    if (!Array.isArray(paths)) {
      throw Err.server(ServerErrorCode.UNKNOWN_ERROR, 'The Paykit receiver list could not be read.', {
        service: ErrorService.Paykit,
        operation: 'hasPaymentRequestReceiver',
      });
    }
    for (const path of paths) {
      if (typeof path !== 'string') continue;
      const marker = (await wasmModule.getReceiverMarker(client, ownerPubky, path)) as
        | { capabilities?: { privatePayments?: unknown; paymentRequests?: unknown } }
        | undefined;
      if (marker?.capabilities?.privatePayments === true && marker.capabilities.paymentRequests === true) {
        return true;
      }
    }
    return false;
  }

  /**
   * Brings the Encrypted Link toward `counterpartyPubky` as far as one poll
   * step allows and reports the truthful state. Serialized per counterparty.
   */
  static async ensureLink(ownerPubky: string, counterpartyPubky: string): Promise<MessagingLinkState> {
    return await this.withQueue(ownerPubky, counterpartyPubky, async () => {
      const state = await this.ensureLinkLocked(ownerPubky, counterpartyPubky, true);
      // `allowInitiate` guarantees the probe-only 'none' branch is unreachable.
      return state as MessagingLinkState;
    });
  }

  /**
   * Advances existing state and answers queued inbound handshakes for one
   * counterparty WITHOUT ever initiating a new handshake — the inbox sync
   * path. The binding exposes no way to enumerate unknown inbound initiators,
   * so probing is limited to counterparties this account already knows
   * (existing conversations/links plus marketplace order/offer participants).
   */
  static async probeCounterparty(ownerPubky: string, counterpartyPubky: string): Promise<MessagingProbeState> {
    return await this.withQueue(ownerPubky, counterpartyPubky, () =>
      this.ensureLinkLocked(ownerPubky, counterpartyPubky, false),
    );
  }

  /**
   * The user's explicit acceptance of a counterparty's changed key.
   * `acceptedKey` must be the key recorded as shown to the user (the row's
   * `observed_noise_public_key`); any other key is refused and the user is
   * asked again about the key published now. It is accepted only while
   * the counterparty's marker still advertises exactly it. Then the pair's
   * link state on the old key is replaced: live handles are dropped and a
   * fresh handshake on the accepted key is answered or initiated, whose
   * link row pins the accepted key from now on. If the marker meanwhile
   * advertises the pinned key again, the hold is simply cleared; if it
   * advertises yet another key, that key is recorded as the shown key and
   * reported instead, and nothing is accepted. A marker that cannot be read rejects with the
   * marker read failure and changes nothing.
   */
  static async acceptCounterpartyKey(
    ownerPubky: string,
    counterpartyPubky: string,
    acceptedKey: string,
  ): Promise<MessagingLinkState> {
    return await this.withQueue(ownerPubky, counterpartyPubky, async () => {
      const wasmModule = await loadPaykitWasm();
      const session = await this.requireSessionOrRestore(ownerPubky);
      const key = this.linkKey(ownerPubky, counterpartyPubky);
      const pin = await LocalMessagingService.getPeerKeyPin(ownerPubky, counterpartyPubky);
      if (!pin?.observedKey)
        return (await this.ensureLinkLocked(ownerPubky, counterpartyPubky, true)) as MessagingLinkState;
      // Only the key recorded as shown to the user can be accepted.
      if (acceptedKey !== pin.observedKey) {
        Logger.warn('Refused to accept a messaging key that was not the one shown', {
          reason: 'accepted_key_not_shown',
        });
        return await this.repromptKeyChange(ownerPubky, counterpartyPubky);
      }
      const marker = await this.getCounterpartyMarkerWith(wasmModule, counterpartyPubky);
      if (!marker) {
        return { status: 'key-changed', pinnedKey: pin.pinnedKey, observedKey: pin.observedKey };
      }
      if (marker.noisePublicKey !== acceptedKey) {
        Logger.warn('The contact published another messaging key after it was shown; nothing was accepted', {
          reason: 'shown_key_superseded',
        });
        return await this.repromptKeyChange(ownerPubky, counterpartyPubky);
      }
      const receiver = await this.requireReceiver(ownerPubky);
      this.dropPairState(key);
      this.linkRetry.succeed(key);
      Logger.info('The user accepted a changed messaging key for a counterparty', {
        reason: 'counterparty_key_accepted',
      });
      return (await this.discoverAndStart(
        wasmModule,
        session,
        receiver,
        ownerPubky,
        counterpartyPubky,
        marker,
        true,
      )) as MessagingLinkState;
    });
  }

  /**
   * After a refused accept: reads the marker again now, so the key recorded
   * as shown becomes the one published (or the hold clears when the pinned
   * key is back), and reports the state the user must decide on again.
   */
  private static async repromptKeyChange(ownerPubky: string, counterpartyPubky: string): Promise<MessagingLinkState> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    this.linkRetry.restart((candidate) => candidate === key);
    return (await this.ensureLinkLocked(ownerPubky, counterpartyPubky, true)) as MessagingLinkState;
  }

  /**
   * Sends one marketplace chat message over an established link. Enforces the
   * 1000-byte serialized ceiling before the crypto layer would reject it
   * anyway. On success the message row is persisted (direction `sent`) and
   * THEN the advanced link snapshot; a failure leaves no message row behind —
   * the UI keeps the draft and shows the real error.
   *
   * `eventId` is normally minted here; the outbox flush passes the queued
   * row's UUID instead, so a crash between a successful send and the row
   * delete replays idempotently (receivers and local history dedupe by
   * `event_id`) rather than double-delivering.
   */
  static async sendChatMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    input: { conversationId: string; listingRef: string; body: string; eventId?: string },
  ): Promise<MarketplaceChatMessage> {
    return await this.withQueue(ownerPubky, counterpartyPubky, async () => {
      assertListingConversationBound(ownerPubky, counterpartyPubky, input, 'sendChatMessage');
      await this.settleUnsavedSend(ownerPubky, counterpartyPubky);
      const link = await this.requireReadyLink(ownerPubky, counterpartyPubky, 'sendChatMessage');
      const { message, json } = buildChatMessage({
        eventId: input.eventId ?? crypto.randomUUID(),
        conversationId: input.conversationId,
        listingRef: input.listingRef,
        sentAt: Date.now(),
        body: input.body,
      });
      await this.sendOnLink(ownerPubky, counterpartyPubky, link, json, {
        kind: 'listing',
        eventId: message.event_id,
        conversationId: message.conversation_id,
        listingRef: message.listing_ref,
        sentAt: message.sent_at,
        body: message.body,
      });
      return message;
    });
  }

  /**
   * Sends one general direct message over the same established link the
   * marketplace kinds ride. The DM conversation identity IS the counterparty
   * pubky (`dm:{counterparty}`); same ceiling, same persistence ordering, and
   * a failed send leaves no row behind. `eventId` follows the same outbox
   * contract as {@link sendChatMessage}.
   */
  static async sendDmMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    input: { body: string; eventId?: string },
  ): Promise<PubkyAppDmMessage> {
    return await this.withQueue(ownerPubky, counterpartyPubky, async () => {
      await this.settleUnsavedSend(ownerPubky, counterpartyPubky);
      const link = await this.requireReadyLink(ownerPubky, counterpartyPubky, 'sendDmMessage');
      const { message, json } = buildDmMessage({
        eventId: input.eventId ?? crypto.randomUUID(),
        sentAt: Date.now(),
        body: input.body,
      });
      await this.sendOnLink(ownerPubky, counterpartyPubky, link, json, {
        kind: 'dm',
        eventId: message.event_id,
        conversationId: buildDmConversationId(counterpartyPubky),
        listingRef: null,
        sentAt: message.sent_at,
        body: message.body,
      });
      return message;
    });
  }

  /**
   * Receives pending inbound events on an established link and routes them
   * by kind: `marketplace.chat_message.v0` lands in its envelope's listing
   * conversation, `pubky_app.dm.v0` lands in the counterparty's DM
   * conversation. Everything the binding returns in one drain is dealt with
   * before the advanced snapshot is persisted, because the binding's read
   * position moves past all of it:
   *
   * - a message of a known kind is stored (or refused by `gate`, or dropped
   *   when its envelope is invalid or names another thread);
   * - an event of a kind or version this build cannot interpret is stored
   *   unprocessed, wrapped at rest, and offered to the router again at the
   *   start of every later receive, so a build that understands it can still
   *   process it. If it cannot be stored, this throws and the snapshot is not
   *   advanced.
   *
   * Every new event passes `gate` (Shop policy: mutes, the receive cap,
   * Requests) before it is stored. A refused event is consumed like any
   * other: the snapshot still advances past it, so it is never stored later.
   */
  static async receiveMessages(
    ownerPubky: string,
    counterpartyPubky: string,
    gate: MessagingIntakeGate,
  ): Promise<ReceivedMessage[]> {
    return await this.withQueue(ownerPubky, counterpartyPubky, async () => {
      const key = this.linkKey(ownerPubky, counterpartyPubky);
      const link = this.links.get(key);
      if (!link) return [];
      await this.settleUnsavedSend(ownerPubky, counterpartyPubky);
      const received: ReceivedMessage[] = [];
      await this.reprocessUnprocessed(ownerPubky, counterpartyPubky, gate, received);
      try {
        const inbound = (await link.receivePrivateApplicationMessages()) as InboundEvent[];
        const now = Date.now();
        for (const [position, item] of inbound.entries()) {
          const classified = this.classifyInbound(item, ownerPubky, counterpartyPubky);
          if (classified.type === 'invalid') continue;
          if (classified.type === 'unknown') {
            await this.keepUnprocessed(ownerPubky, counterpartyPubky, item, classified, gate, { now, position });
            continue;
          }
          await this.intakeMessage(ownerPubky, counterpartyPubky, classified.message, gate, now, received);
        }
        if (inbound.length > 0) {
          await this.persistLinkSnapshot(ownerPubky, counterpartyPubky, link);
        }
      } catch (error) {
        // The live handle's read position already moved past this batch;
        // only the persisted snapshot did not. Dropping the handle makes the
        // next operation restore from that snapshot and read the batch
        // again, so nothing in it is skipped. Redeliveries are deduplicated.
        // Only this handle is dropped: a sign-out and sign-in during the
        // receive may already have put a new one under the same key.
        if (this.links.get(key) === link) this.links.delete(key);
        closeQuietly(() => void link.close());
        throw error;
      }
      return received;
    });
  }

  /**
   * Offers every stored unprocessed event from this peer to the router
   * again, oldest first. One this build now understands is taken in like a
   * new message and its row is removed; one refused by the mute policy or
   * no longer valid is removed too. One still unknown, or only held back by
   * the receive cap, stays for a later receive.
   */
  private static async reprocessUnprocessed(
    ownerPubky: string,
    counterpartyPubky: string,
    gate: MessagingIntakeGate,
    received: ReceivedMessage[],
  ): Promise<void> {
    for (const event of await LocalMessagingService.getUnprocessed(ownerPubky, counterpartyPubky)) {
      const classified = this.classifyInbound(event, ownerPubky, counterpartyPubky);
      if (classified.type === 'unknown') continue;
      if (classified.type === 'message') {
        const outcome = await this.intakeMessage(
          ownerPubky,
          counterpartyPubky,
          classified.message,
          gate,
          Date.now(),
          received,
        );
        if (outcome === 'rate_limited') continue;
      }
      await LocalMessagingService.deleteUnprocessed(ownerPubky, event.id);
    }
  }

  /** Stores one event this build cannot interpret, unless the gate refuses it or it is already stored. */
  private static async keepUnprocessed(
    ownerPubky: string,
    counterpartyPubky: string,
    item: InboundEvent,
    classified: { kind: string; version: number | null },
    gate: MessagingIntakeGate,
    at: { now: number; position: number },
  ): Promise<void> {
    const id = LocalMessagingService.unprocessedId(ownerPubky, counterpartyPubky, item.rawJson);
    if (await LocalMessagingService.hasUnprocessed(id)) return;
    const decision = await gate.admit({ counterpartyPubky, kind: 'unknown', conversationId: null });
    if (!decision.store) {
      Logger.info('Skipped an inbound event', { reason: decision.reason });
      return;
    }
    await LocalMessagingService.storeUnprocessed({
      ownerId: ownerPubky,
      counterpartyPubky,
      kind: classified.kind,
      version: classified.version,
      rawJson: item.rawJson,
      receivedAt: at.now,
      position: at.position,
    });
  }

  /**
   * Takes one routed message in: puts a new one to the gate, stores it
   * first-write-wins, and makes sure its conversation row exists.
   */
  private static async intakeMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    routed: ReceivedMessage,
    gate: MessagingIntakeGate,
    now: number,
    received: ReceivedMessage[],
  ): Promise<'stored' | 'replay' | 'muted' | 'rate_limited' | 'conflict'> {
    // A redelivery of a stored message is not new traffic, so it is not
    // put to the gate (it must not use up the receive cap). Its thread
    // row is normally there already; if a crash lost it, the row is
    // recreated under Requests until the next sync reclassifies it.
    let origin: ConversationOrigin = 'request';
    if (!(await LocalMessagingService.hasMessage(ownerPubky, routed.event_id))) {
      const decision = await gate.admit({
        counterpartyPubky,
        kind: routed.kind,
        conversationId: routed.conversation_id,
      });
      if (!decision.store) {
        Logger.info('Skipped an inbound message', { reason: decision.reason });
        return decision.reason;
      }
      origin = decision.origin;
    }
    // `event_id` is sender-chosen too, so a stored row is never
    // overwritten: an exact redelivery is a no-op and any other reuse of
    // the id is dropped.
    const stored = await LocalMessagingService.insertReceivedMessage(routed.event_id, {
      owner_id: ownerPubky,
      conversation_id: routed.conversation_id,
      listing_ref: routed.listing_ref,
      counterparty_pubky: counterpartyPubky,
      body: routed.body,
      sent_at: routed.sent_at,
      recorded_at: now,
    });
    if (stored.status === 'conflict') {
      Logger.warn('Dropped an inbound message that reuses the id of a different stored message', {
        reason: 'event_id_collision',
      });
      return 'conflict';
    }
    // A replay still ensures the conversation row exists (the first
    // delivery may have crashed before this write) but never moves its
    // timestamps past the original receipt.
    const touchedAt = stored.status === 'replay' ? stored.recordedAt : now;
    await LocalMessagingService.touchConversation({
      owner_id: ownerPubky,
      conversation_id: routed.conversation_id,
      kind: routed.kind,
      listing_ref: routed.listing_ref,
      counterparty_pubky: counterpartyPubky,
      last_message_at: touchedAt,
      updated_at: touchedAt,
      origin,
    });
    if (stored.status === 'inserted') {
      received.push(routed);
      return 'stored';
    }
    return 'replay';
  }

  /**
   * What one inbound event is. A known kind at a known version is decoded:
   * a valid one is a `message`, anything else about it (a malformed body, a
   * listing thread that does not name both link ends) is `invalid` and
   * dropped. Any other kind, or a known kind at a version this build does
   * not know, is `unknown` and kept. An event with no kind at all is not an
   * application message and is `invalid`.
   */
  private static classifyInbound(
    item: InboundEvent,
    ownerPubky: string,
    counterpartyPubky: string,
  ):
    | { type: 'message'; message: ReceivedMessage }
    | { type: 'invalid' }
    | { type: 'unknown'; kind: string; version: number | null } {
    const envelope = readEnvelopeHeader(item.rawJson);
    const kind = envelope.kind ?? (typeof item.kind === 'string' && item.kind.length > 0 ? item.kind : null);
    const version = envelope.kind ? envelope.version : typeof item.version === 'number' ? item.version : null;
    if (kind === null) return { type: 'invalid' };
    const known = kind === MARKETPLACE_CHAT_MESSAGE_KIND || kind === PUBKY_APP_DM_KIND;
    if (!known || version !== 1) return { type: 'unknown', kind, version };
    const message = this.routeInboundMessage(item.rawJson, ownerPubky, counterpartyPubky);
    return message ? { type: 'message', message } : { type: 'invalid' };
  }

  /**
   * Decodes one inbound payload into its conversation routing, or `null` for
   * unknown kinds and for listing messages whose envelope names a
   * conversation this link does not carry. The link authenticates only the
   * two endpoints, so a listing message is stored only when its
   * `conversation_id`/`listing_ref` name exactly the owner and this
   * counterparty; a forged thread reference is dropped, never re-filed.
   */
  private static routeInboundMessage(
    rawJson: string,
    ownerPubky: string,
    counterpartyPubky: string,
  ): ReceivedMessage | null {
    const chat = decodeChatMessage(rawJson);
    if (chat) {
      if (
        !isListingConversationBound({
          conversationId: chat.conversation_id,
          listingRef: chat.listing_ref,
          ownerPubky,
          counterpartyPubky,
        })
      ) {
        Logger.warn('Dropped an inbound listing message whose conversation does not match the encrypted link', {
          reason: 'unbound_conversation',
        });
        return null;
      }
      return {
        kind: 'listing',
        event_id: chat.event_id,
        conversation_id: chat.conversation_id,
        listing_ref: chat.listing_ref,
        sent_at: chat.sent_at,
        body: chat.body,
        counterpartyPubky,
      };
    }
    const dm = decodeDmMessage(rawJson);
    if (dm) {
      return {
        kind: 'dm',
        event_id: dm.event_id,
        conversation_id: buildDmConversationId(counterpartyPubky),
        listing_ref: null,
        sent_at: dm.sent_at,
        body: dm.body,
        counterpartyPubky,
      };
    }
    return null;
  }

  /** Advances the link if needed and returns the ready handle, or throws the honest state. */
  private static async requireReadyLink(
    ownerPubky: string,
    counterpartyPubky: string,
    operation: string,
  ): Promise<EncryptedLinkHandle> {
    const state = await this.ensureLinkLocked(ownerPubky, counterpartyPubky, true);
    if (state.status !== 'ready') {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'The encrypted link is not established yet.', {
        service: ErrorService.Paykit,
        operation,
        context: { linkStatus: state.status },
      });
    }
    const link = this.links.get(this.linkKey(ownerPubky, counterpartyPubky));
    if (!link) {
      throw Err.server(ServerErrorCode.UNKNOWN_ERROR, 'The encrypted link handle is missing.', {
        service: ErrorService.Paykit,
        operation,
      });
    }
    return link;
  }

  /**
   * Sends one message and saves what it changed, in an order that can never
   * let a later restore reuse the link's send counter:
   *
   * 1. A durable "send pending" mark goes on the link row BEFORE the
   *    ciphertext leaves. A restore that finds it set cannot know whether
   *    the counter advanced past the saved snapshot, so that pair never
   *    sends from that snapshot (see the restore in `stepLink`).
   * 2. The message is sent. The binding may advance its counter even when
   *    the send fails, so the snapshot is saved either way.
   * 3. After a successful send, the message row and its conversation are
   *    stored, then the snapshot is saved, which clears the mark.
   *
   * If the snapshot cannot be saved, the pair is recorded as having an
   * unsaved send: its live handle is kept, and every later send or receive
   * on the pair saves the snapshot first ({@link settleUnsavedSend}).
   */
  private static async sendOnLink(
    ownerPubky: string,
    counterpartyPubky: string,
    link: EncryptedLinkHandle,
    json: string,
    sent: {
      kind: 'listing' | 'dm';
      eventId: string;
      conversationId: string;
      listingRef: string | null;
      sentAt: number;
      body: string;
    },
  ): Promise<void> {
    await LocalMessagingService.markSendPending(ownerPubky, counterpartyPubky);
    let failure: { error: unknown } | null = null;
    try {
      await link.sendPrivateApplicationMessageJson(json);
    } catch (error) {
      failure = { error };
    }
    if (!failure) {
      try {
        const now = Date.now();
        await LocalMessagingService.upsertMessage(sent.eventId, {
          owner_id: ownerPubky,
          conversation_id: sent.conversationId,
          listing_ref: sent.listingRef,
          counterparty_pubky: counterpartyPubky,
          direction: 'sent',
          body: sent.body,
          sent_at: sent.sentAt,
          recorded_at: now,
        });
        await LocalMessagingService.touchConversation({
          owner_id: ownerPubky,
          conversation_id: sent.conversationId,
          kind: sent.kind,
          listing_ref: sent.listingRef,
          counterparty_pubky: counterpartyPubky,
          last_message_at: now,
          updated_at: now,
        });
      } catch (error) {
        failure = { error };
      }
    }
    // Keys reset in another tab: the link row and its key are gone, so there
    // is no snapshot to save, and this session must end on this error.
    if (failure && isMessagingKeyringChanged(failure.error)) throw failure.error;
    try {
      await this.persistLinkSnapshot(ownerPubky, counterpartyPubky, link);
    } catch (error) {
      this.unsavedSends.add(this.linkKey(ownerPubky, counterpartyPubky));
      Logger.warn('Could not save the link after a send; the pair waits until it is saved', {
        reason: 'send_snapshot_unsaved',
      });
      throw error;
    }
    if (failure) throw failure.error;
  }

  /**
   * Saves the snapshot of a pair whose last send was not saved, before the
   * pair is used again. Throws while it still cannot be saved, so nothing
   * sends or receives on a handle that is ahead of its saved state.
   */
  private static async settleUnsavedSend(ownerPubky: string, counterpartyPubky: string): Promise<void> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    if (!this.unsavedSends.has(key)) return;
    const link = this.links.get(key);
    if (!link) {
      this.unsavedSends.delete(key);
      return;
    }
    await this.persistLinkSnapshot(ownerPubky, counterpartyPubky, link);
    this.unsavedSends.delete(key);
  }

  // --- internals -----------------------------------------------------------

  private static async ensureLinkLocked(
    ownerPubky: string,
    counterpartyPubky: string,
    allowInitiate: boolean,
  ): Promise<MessagingProbeState> {
    const wasmModule = await loadPaykitWasm();
    const session = await this.requireSessionOrRestore(ownerPubky);
    const key = this.linkKey(ownerPubky, counterpartyPubky);

    // A recorded key change holds the pair, live handle or not, until the
    // user accepts the new key or the marker advertises the pinned key again.
    const pin = await LocalMessagingService.getPeerKeyPin(ownerPubky, counterpartyPubky);
    if (pin?.observedKey) {
      const waiting = this.linkRetry.waiting(key);
      if (waiting) return waiting;
      const held = await this.recheckKeyChange(wasmModule, session, ownerPubky, counterpartyPubky, pin.pinnedKey);
      if (held) return held;
    }

    if (this.links.has(key)) return { status: 'ready' };

    const waiting = this.linkRetry.waiting(key);
    if (waiting) return waiting;

    let state: MessagingProbeState;
    try {
      state = await this.stepLink(wasmModule, session, ownerPubky, counterpartyPubky, allowInitiate);
    } catch (error) {
      if (!isMarkerReadFailure(error)) throw error;
      Logger.warn('Could not read the counterparty messaging marker; will retry later', {
        error,
        context: { counterparty: counterpartyPubky, reason: error.reason },
      });
      return this.deferLink(key, { status: 'unreachable', reason: error.reason });
    }
    if (!this.linkRetry.holds(key, state)) this.linkRetry.succeed(key);
    return state;
  }

  /**
   * Whether this pair has a failed link attempt on its retry schedule:
   * `waiting` costs no network until it is `due`. Inbox sync uses it to keep
   * retries out of the budget healthy links are probed from.
   */
  static linkRetryStatus(ownerPubky: string, counterpartyPubky: string): 'none' | 'waiting' | 'due' {
    return this.linkRetry.status(this.linkKey(ownerPubky, counterpartyPubky));
  }

  /**
   * Makes the failed link attempts of `ownerPubky` — with `counterpartyPubky`
   * only, when given — due now on a restarted schedule. Memory only: no
   * request is made here, and nothing changes for a pair with no recorded
   * failure. An attempt already running under the pair's lock finishes and
   * records its outcome on the restarted schedule.
   */
  static restartLinkRetries(ownerPubky: string, counterpartyPubky?: string): void {
    const exact = counterpartyPubky === undefined ? null : this.linkKey(ownerPubky, counterpartyPubky);
    const prefix = this.linkKey(ownerPubky, '');
    this.linkRetry.restart((key) => (exact === null ? key.startsWith(prefix) : key === exact));
  }

  /** Reports `state` until the pair's next backoff-spaced attempt is due. */
  private static deferLink<T extends MessagingProbeState>(key: string, state: T): T {
    this.linkRetry.fail(key, state);
    return state;
  }

  /**
   * Records that the counterparty's marker advertises `observedKey` instead
   * of the pinned key, and reports `key-changed` on the pair's retry
   * schedule. Nothing is started with the new key. When this attempt
   * already recorded a failure (`deferred`), only the state it reports is
   * replaced, so one attempt never counts twice.
   */
  private static async holdForKeyChange(
    ownerPubky: string,
    counterpartyPubky: string,
    pinnedKey: string,
    observedKey: string,
    deferred?: MessagingProbeState,
  ): Promise<Extract<MessagingLinkState, { status: 'key-changed' }>> {
    await LocalMessagingService.setPeerKeyObserved(ownerPubky, counterpartyPubky, observedKey, Date.now());
    Logger.warn('The counterparty publishes a different messaging key than the one pinned on this device', {
      reason: 'counterparty_key_changed',
    });
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    const held = { status: 'key-changed', pinnedKey, observedKey } as const;
    if (deferred && this.linkRetry.holds(key, deferred)) {
      this.linkRetry.replace(key, held);
      return held;
    }
    return this.deferLink(key, held);
  }

  /**
   * Reads the marker of a pair held for a key change. Advertising the pinned
   * key again clears the hold (`null`: the pair continues as usual).
   * Otherwise the newest different key is recorded and the pair stays held,
   * while its state on the pinned key keeps moving: a pending handshake
   * bound to the pinned key is advanced (it may complete), and an
   * established link is restored so it keeps receiving. Nothing is ever
   * started or answered on another key. A marker that cannot be read, or is
   * gone, keeps the hold as it was.
   */
  private static async recheckKeyChange(
    wasmModule: PaykitWasmModule,
    session: ActiveSession,
    ownerPubky: string,
    counterpartyPubky: string,
    pinnedKey: string,
  ): Promise<Extract<MessagingLinkState, { status: 'key-changed' }> | null> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    const marker = await this.getCounterpartyMarkerWith(wasmModule, counterpartyPubky).catch((error: unknown) => {
      if (isMarkerReadFailure(error)) return undefined;
      throw error;
    });
    if (marker?.noisePublicKey === pinnedKey) {
      await LocalMessagingService.setPeerKeyObserved(ownerPubky, counterpartyPubky, null, Date.now());
      this.linkRetry.succeed(key);
      Logger.info('The counterparty publishes the pinned messaging key again', { reason: 'counterparty_key_restored' });
      return null;
    }
    const recorded = (await LocalMessagingService.getPeerKeyPin(ownerPubky, counterpartyPubky))?.observedKey;
    const observedKey = marker?.noisePublicKey ?? recorded ?? pinnedKey;
    const advanced = this.links.has(key)
      ? undefined
      : await this.movePinnedStateOn(wasmModule, session, ownerPubky, counterpartyPubky);
    return await this.holdForKeyChange(ownerPubky, counterpartyPubky, pinnedKey, observedKey, advanced);
  }

  /**
   * For a pair held for a key change with no live link: advances a pending
   * handshake bound to the pinned key one step, or restores an established
   * link for receiving. Resolves the state a handshake step reported, if
   * one ran.
   */
  private static async movePinnedStateOn(
    wasmModule: PaykitWasmModule,
    session: ActiveSession,
    ownerPubky: string,
    counterpartyPubky: string,
  ): Promise<MessagingProbeState | undefined> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    let handshake = this.handshakes.get(key);
    if (!handshake) {
      const stored = await LocalMessagingService.getLink(ownerPubky, counterpartyPubky);
      if (stored?.status === 'established') {
        await this.restoreEstablishedForReceive(wasmModule, session, ownerPubky, counterpartyPubky);
        return undefined;
      }
      if (stored?.status !== 'handshaking') return undefined;
      const receiver = await LocalMessagingService.getReceiver(ownerPubky);
      if (!receiver?.marker_published) return undefined;
      try {
        const handle = this.configureHandshakeWriteRetries(
          (await wasmModule.restoreEncryptedLinkHandshake(
            session.handle,
            receiver.noise_secret,
            counterpartyPubky,
            stored.local_receiver_path,
            stored.remote_receiver_path,
            this.getClient(wasmModule),
            stored.snapshot,
          )) as LinkHandshakeHandle,
        );
        handshake = { handle, role: stored.role, boundKey: stored.remote_noise_public_key };
      } catch (error) {
        Logger.warn('Could not restore the pending handshake of a pair held for a key change', { error });
        return undefined;
      }
      this.handshakes.set(key, handshake);
    }
    return await this.advanceHandshake(wasmModule, ownerPubky, counterpartyPubky, handshake);
  }

  /**
   * Restores the established link of a pair held for a key change, so
   * messages the counterparty sent on the pinned key are still received.
   * Best effort: a pair with no established row, one whose last send is not
   * known to be saved, or a restore that fails, stays without a live handle.
   */
  private static async restoreEstablishedForReceive(
    wasmModule: PaykitWasmModule,
    session: ActiveSession,
    ownerPubky: string,
    counterpartyPubky: string,
  ): Promise<void> {
    const stored = await LocalMessagingService.getLink(ownerPubky, counterpartyPubky);
    if (stored?.status !== 'established' || stored.send_pending) return;
    const receiver = await LocalMessagingService.getReceiver(ownerPubky);
    if (!receiver?.marker_published) return;
    try {
      const link = this.configureLinkWriteRetries(
        (await wasmModule.restoreEncryptedLink(
          session.handle,
          receiver.noise_secret,
          counterpartyPubky,
          stored.local_receiver_path,
          stored.remote_receiver_path,
          this.getClient(wasmModule),
          stored.snapshot,
        )) as EncryptedLinkHandle,
      );
      if (link.remoteNoisePublicKey() !== stored.remote_noise_public_key) {
        closeQuietly(() => void link.close());
        return;
      }
      this.links.set(this.linkKey(ownerPubky, counterpartyPubky), link);
    } catch (error) {
      Logger.warn('Could not restore the established link of a pair held for a key change', { error });
    }
  }

  private static async stepLink(
    wasmModule: PaykitWasmModule,
    session: ActiveSession,
    ownerPubky: string,
    counterpartyPubky: string,
    allowInitiate: boolean,
  ): Promise<MessagingProbeState> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    const active = this.handshakes.get(key);
    if (active) {
      return await this.advanceHandshake(wasmModule, ownerPubky, counterpartyPubky, active);
    }

    const stored = await LocalMessagingService.getLink(ownerPubky, counterpartyPubky);
    const receiver = await this.requireReceiver(ownerPubky);

    if (stored?.status === 'established') {
      if (stored.send_pending) {
        // A send may have left after this snapshot was saved; its counter
        // is unknown, and sending from here could reuse it. Nothing is
        // deleted, and queued messages stay queued.
        Logger.warn('A link was saved before a send finished; it will not send from that snapshot', {
          reason: 'send_state_unknown',
        });
        return this.deferLink(key, { status: 'recovery-needed', reason: 'send-state-unknown' });
      }
      try {
        const link = this.configureLinkWriteRetries(
          (await wasmModule.restoreEncryptedLink(
            session.handle,
            receiver.noise_secret,
            counterpartyPubky,
            stored.local_receiver_path,
            stored.remote_receiver_path,
            this.getClient(wasmModule),
            stored.snapshot,
          )) as EncryptedLinkHandle,
        );
        if (link.remoteNoisePublicKey() !== stored.remote_noise_public_key) {
          closeQuietly(() => void link.close());
          Logger.warn('A restored link reports another counterparty key than the one pinned for it', {
            reason: 'link_key_mismatch',
          });
          return this.deferLink(key, { status: 'recovery-needed', reason: 'link-key-mismatch' });
        }
        this.links.set(key, link);
      } catch (error) {
        Logger.warn('Failed to restore an established link snapshot; keeping it for the next attempt', { error });
        return this.deferLink(key, { status: 'recovery-needed', reason: 'link-restore-failed' });
      }
      // The link itself keeps working on its own keys; the marker is read
      // once per restore so a changed key is shown before anything is sent.
      // A marker that cannot be read, or is gone, says nothing about a key.
      const marker = await this.getCounterpartyMarkerWith(wasmModule, counterpartyPubky).catch((error: unknown) => {
        if (isMarkerReadFailure(error)) return null;
        throw error;
      });
      if (marker && marker.noisePublicKey !== stored.remote_noise_public_key) {
        return await this.holdForKeyChange(
          ownerPubky,
          counterpartyPubky,
          stored.remote_noise_public_key,
          marker.noisePublicKey,
        );
      }
      return { status: 'ready' };
    }

    if (stored?.status === 'handshaking') {
      // Recovery never deletes link state. The counterparty may already have
      // completed its side and be writing messages this snapshot alone can
      // read, and our outbox may hold handshake slots it has not read yet;
      // dropping the row or clearing the outbox kills the pair for good. The
      // vendored binding has no per-counterparty recovery marker, so a
      // handshake that cannot proceed reports a fixed recovery state and is
      // retried unchanged on the pair's backoff schedule.
      let handle: LinkHandshakeHandle;
      try {
        handle = this.configureHandshakeWriteRetries(
          (await wasmModule.restoreEncryptedLinkHandshake(
            session.handle,
            receiver.noise_secret,
            counterpartyPubky,
            stored.local_receiver_path,
            stored.remote_receiver_path,
            this.getClient(wasmModule),
            stored.snapshot,
          )) as LinkHandshakeHandle,
        );
      } catch (error) {
        Logger.warn('Failed to restore a mid-handshake snapshot; keeping it for the next attempt', { error });
        return this.deferLink(key, { status: 'recovery-needed', reason: 'handshake-restore-failed' });
      }
      const handshake: ActiveHandshake = { handle, role: stored.role, boundKey: stored.remote_noise_public_key };
      this.handshakes.set(key, handshake);
      const state = await this.advanceHandshake(wasmModule, ownerPubky, counterpartyPubky, handshake);
      // Completed, failed its step, or switched to a crossed inbound handshake.
      if (this.handshakes.get(key) !== handshake) return state;
      // Advancing a handshake bound to the pinned key is safe, so it was
      // advanced first; only a still-pending one is held for a new key.
      const currentMarker = await this.getCounterpartyMarkerWith(wasmModule, counterpartyPubky).catch(() => null);
      if (currentMarker && currentMarker.noisePublicKey !== stored.remote_noise_public_key) {
        this.handshakes.delete(key);
        closeQuietly(() => handshake.handle.free());
        return await this.holdForKeyChange(
          ownerPubky,
          counterpartyPubky,
          stored.remote_noise_public_key,
          currentMarker.noisePublicKey,
        );
      }
      return state;
    }

    // No readable link state: discover the counterparty, prefer answering an
    // inbound handshake if one is queued, otherwise initiate our own.
    const marker = await this.getCounterpartyMarkerWith(wasmModule, counterpartyPubky);
    if (!marker) return allowInitiate ? { status: 'not-enrolled' } : { status: 'none' };

    // A row whose snapshot no longer opens still pins its key: a new
    // handshake starts on its own only with that key.
    const pin = await LocalMessagingService.getPeerKeyPin(ownerPubky, counterpartyPubky);
    if (pin && pin.pinnedKey !== marker.noisePublicKey) {
      return await this.holdForKeyChange(ownerPubky, counterpartyPubky, pin.pinnedKey, marker.noisePublicKey);
    }

    return await this.discoverAndStart(
      wasmModule,
      session,
      receiver,
      ownerPubky,
      counterpartyPubky,
      marker,
      allowInitiate,
    );
  }

  /**
   * First contact with no local link state: answers a queued inbound
   * handshake if one exists, otherwise initiates.
   */
  private static async discoverAndStart(
    wasmModule: PaykitWasmModule,
    session: ActiveSession,
    receiver: { noise_secret: Uint8Array; receiver_path: string },
    ownerPubky: string,
    counterpartyPubky: string,
    marker: CounterpartyMessagingMarker,
    allowInitiate: boolean,
  ): Promise<MessagingProbeState> {
    const inbound = await this.probeInboundHandshake(wasmModule, session, receiver, counterpartyPubky, marker);
    if (inbound) {
      return await this.adoptHandshakeProgress(ownerPubky, counterpartyPubky, marker, receiver.receiver_path, inbound);
    }

    if (!allowInitiate) return { status: 'none' };

    const handle = this.configureHandshakeWriteRetries(
      wasmModule.initiateEncryptedLink(
        session.handle,
        receiver.noise_secret,
        counterpartyPubky,
        marker.noisePublicKey,
        receiver.receiver_path,
        marker.receiverPath,
        this.getClient(wasmModule),
      ),
    );
    const handshake: ActiveHandshake = { handle, role: 'initiator', boundKey: marker.noisePublicKey };
    this.handshakes.set(this.linkKey(ownerPubky, counterpartyPubky), handshake);
    await LocalMessagingService.upsertLink({
      owner_id: ownerPubky,
      counterparty_pubky: counterpartyPubky,
      role: 'initiator',
      status: 'handshaking',
      local_receiver_path: receiver.receiver_path,
      remote_receiver_path: marker.receiverPath,
      remote_noise_public_key: marker.noisePublicKey,
      snapshot: handle.snapshot(),
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    return await this.advanceHandshake(wasmModule, ownerPubky, counterpartyPubky, handshake);
  }

  /**
   * One handshake step. On `pending`, persists the advanced snapshot so a
   * reload resumes instead of restarting. On error the in-memory handshake is
   * consumed (paykit-lib ownership model); the persisted snapshot restores it
   * on the pair's next backoff-spaced attempt. When our own initiated
   * handshake stalls, the lexicographically smaller pubky additionally probes for a CROSSED inbound
   * handshake (both sides initiated at once) and switches to answering it —
   * the deterministic tiebreak that keeps exactly one side switching.
   */
  private static async advanceHandshake(
    wasmModule: PaykitWasmModule,
    ownerPubky: string,
    counterpartyPubky: string,
    handshake: ActiveHandshake,
  ): Promise<MessagingLinkState> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    let result: { status: string; link?: EncryptedLinkHandle };
    try {
      result = (await handshake.handle.advance()) as { status: string; link?: EncryptedLinkHandle };
    } catch (error) {
      this.handshakes.delete(key);
      Logger.warn('Encrypted link handshake step failed; will restore from the persisted snapshot', { error });
      return this.deferLink(key, { status: 'handshaking', role: handshake.role });
    }

    if (result.status === 'complete' && result.link) {
      result.link = this.configureLinkWriteRetries(result.link);
      this.handshakes.delete(key);
      if (result.link.remoteNoisePublicKey() !== handshake.boundKey) {
        const unbound = result.link;
        closeQuietly(() => void unbound.close());
        Logger.warn('A completed handshake reports another counterparty key than the one pinned for it', {
          reason: 'link_key_mismatch',
        });
        return this.deferLink(key, { status: 'recovery-needed', reason: 'link-key-mismatch' });
      }
      // Saved before it is used: a link registered ahead of its saved
      // state could send, and a later restore would then reuse its counter.
      try {
        await this.persistLinkSnapshot(ownerPubky, counterpartyPubky, result.link);
      } catch (error) {
        const unsaved = result.link;
        closeQuietly(() => void unsaved.close());
        Logger.warn('Could not save a completed handshake; it restarts from its saved state', { error });
        return this.deferLink(key, { status: 'handshaking', role: handshake.role });
      }
      this.links.set(key, result.link);
      return { status: 'ready' };
    }

    await this.persistHandshakeSnapshot(ownerPubky, counterpartyPubky, handshake);

    if (handshake.role === 'initiator' && ownerPubky < counterpartyPubky) {
      const session = this.requireSession(ownerPubky);
      const receiver = await this.requireReceiver(ownerPubky);
      // The crossed-handshake probe is best effort: an unreadable marker
      // leaves this handshake pending for the next attempt.
      const marker = await this.getCounterpartyMarkerWith(wasmModule, counterpartyPubky).catch((error: unknown) => {
        if (isMarkerReadFailure(error)) return null;
        throw error;
      });
      // A crossed handshake is answered only on the key this one is bound to.
      if (marker?.noisePublicKey === handshake.boundKey) {
        const inbound = await this.probeInboundHandshake(wasmModule, session, receiver, counterpartyPubky, marker);
        if (inbound) {
          closeQuietly(() => handshake.handle.free());
          this.handshakes.delete(key);
          return await this.adoptHandshakeProgress(
            ownerPubky,
            counterpartyPubky,
            marker,
            receiver.receiver_path,
            inbound,
          );
        }
      }
    }

    return { status: 'handshaking', role: handshake.role };
  }

  /**
   * Answers a possibly-queued inbound handshake: creates responder state and
   * advances once. The binding reports `pending` both for "nothing inbound"
   * and "read message 1, wrote message 2", so progress is detected by
   * comparing snapshots — identical bytes mean nothing was read and the
   * probe state is discarded.
   */
  private static async probeInboundHandshake(
    wasmModule: PaykitWasmModule,
    session: ActiveSession,
    receiver: { noise_secret: Uint8Array; receiver_path: string },
    counterpartyPubky: string,
    marker: CounterpartyMessagingMarker,
  ): Promise<{ handshake?: ActiveHandshake; link?: EncryptedLinkHandle } | null> {
    const handle = this.configureHandshakeWriteRetries(
      wasmModule.acceptEncryptedLink(
        session.handle,
        receiver.noise_secret,
        counterpartyPubky,
        marker.noisePublicKey,
        receiver.receiver_path,
        marker.receiverPath,
        this.getClient(wasmModule),
      ),
    );
    const before = handle.snapshot();
    let result: { status: string; link?: EncryptedLinkHandle };
    try {
      result = (await handle.advance()) as { status: string; link?: EncryptedLinkHandle };
    } catch {
      // A failed probe step is not an inbound handshake; the consumed probe
      // state was never persisted, so there is nothing to recover.
      return null;
    }
    if (result.status === 'complete' && result.link) {
      return { link: this.configureLinkWriteRetries(result.link) };
    }
    const after = handle.snapshot();
    if (bytesEqual(before, after)) {
      closeQuietly(() => handle.free());
      return null;
    }
    return { handshake: { handle, role: 'responder', boundKey: marker.noisePublicKey } };
  }

  /** Persists whichever stage the adopted inbound handshake reached. */
  private static async adoptHandshakeProgress(
    ownerPubky: string,
    counterpartyPubky: string,
    marker: CounterpartyMessagingMarker,
    localReceiverPath: string,
    inbound: { handshake?: ActiveHandshake; link?: EncryptedLinkHandle },
  ): Promise<MessagingLinkState> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    const now = Date.now();
    if (inbound.link) {
      const adopted = inbound.link;
      if (adopted.remoteNoisePublicKey() !== marker.noisePublicKey) {
        closeQuietly(() => void adopted.close());
        Logger.warn('An answered handshake reports another counterparty key than the one it was answered with', {
          reason: 'link_key_mismatch',
        });
        return this.deferLink(key, { status: 'recovery-needed', reason: 'link-key-mismatch' });
      }
      try {
        await LocalMessagingService.upsertLink({
          owner_id: ownerPubky,
          counterparty_pubky: counterpartyPubky,
          role: 'responder',
          status: 'established',
          local_receiver_path: localReceiverPath,
          remote_receiver_path: marker.receiverPath,
          remote_noise_public_key: marker.noisePublicKey,
          snapshot: adopted.snapshot(),
          created_at: now,
          updated_at: now,
        });
      } catch (error) {
        closeQuietly(() => void adopted.close());
        throw error;
      }
      this.links.set(key, adopted);
      return { status: 'ready' };
    }
    if (inbound.handshake) {
      this.handshakes.set(key, inbound.handshake);
      await LocalMessagingService.upsertLink({
        owner_id: ownerPubky,
        counterparty_pubky: counterpartyPubky,
        role: 'responder',
        status: 'handshaking',
        local_receiver_path: localReceiverPath,
        remote_receiver_path: marker.receiverPath,
        remote_noise_public_key: marker.noisePublicKey,
        snapshot: inbound.handshake.handle.snapshot(),
        created_at: now,
        updated_at: now,
      });
      return { status: 'handshaking', role: 'responder' };
    }
    return { status: 'handshaking', role: 'responder' };
  }

  private static async persistLinkSnapshot(
    ownerPubky: string,
    counterpartyPubky: string,
    link: EncryptedLinkHandle,
  ): Promise<void> {
    await LocalMessagingService.updateLinkSnapshot(
      ownerPubky,
      counterpartyPubky,
      link.snapshot(),
      'established',
      Date.now(),
    );
  }

  private static async persistHandshakeSnapshot(
    ownerPubky: string,
    counterpartyPubky: string,
    handshake: ActiveHandshake,
  ): Promise<void> {
    await LocalMessagingService.updateLinkSnapshot(
      ownerPubky,
      counterpartyPubky,
      handshake.handle.snapshot(),
      'handshaking',
      Date.now(),
    );
  }

  /**
   * Gets or creates the account's receiver Noise key and publishes its
   * marker, all while holding the account's receiver lock
   * ({@link withReceiverLock}). Every tab of the origin therefore ends with
   * the same key, the marker advertises that key, and the row is marked
   * published only while it still holds the published key.
   */
  private static async provisionReceiver(
    wasmModule: PaykitWasmModule,
    session: SessionHandle,
    pubky: string,
  ): Promise<MessagingEnabledInfo> {
    return await this.withReceiverLock(pubky, () => this.provisionReceiverLocked(wasmModule, session, pubky));
  }

  /** {@link provisionReceiver} for a caller already holding the account's receiver lock. */
  private static async provisionReceiverLocked(
    wasmModule: PaykitWasmModule,
    session: SessionHandle,
    pubky: string,
  ): Promise<MessagingEnabledInfo> {
    // Read only once the lock is held: another tab may have created,
    // replaced or published the receiver while this one waited.
    const receiver = (await LocalMessagingService.getReceiver(pubky)) ?? (await this.createReceiver(wasmModule, pubky));
    // Republishing is idempotent and heals a marker removed or replaced
    // elsewhere. A messaging-only receiver advertises exactly the Encrypted
    // Link capability (`privatePayments`) and none of the payment capabilities.
    await retryHomeserverWrite(
      HttpMethod.PUT,
      () =>
        wasmModule.publishReceiverMarker(
          session,
          receiver.receiver_path,
          receiver.noise_public_key,
          true,
          false,
          false,
          false,
        ),
      { maxTotalDelayMs: LOCKED_WRITE_RETRY_BUDGET_MS },
    );
    if (!(await LocalMessagingService.markReceiverPublished(pubky, receiver.noise_public_key, Date.now()))) {
      throw Err.database(
        DatabaseErrorCode.WRITE_FAILED,
        'The messaging receiver changed while its marker was being published.',
        { service: ErrorService.Local, operation: 'provisionReceiver' },
      );
    }
    this.ownMarkerChecked.add(pubky);
    return { pubky, receiverPath: receiver.receiver_path, noisePublicKey: receiver.noise_public_key };
  }

  /**
   * Compares the marker this account publishes with the receiver key this
   * device holds, holding the receiver lock so no tab of this device
   * publishes in between. A marker that advertises another key (`replaced`)
   * or no marker at all (`missing`) is republished with this device's key;
   * `match` changes nothing. A marker that cannot be read rejects with the
   * marker read failure and nothing is published.
   */
  private static async reconcileOwnMarker(
    wasmModule: PaykitWasmModule,
    session: SessionHandle,
    pubky: string,
  ): Promise<'match' | OwnMarkerRepublished> {
    return await this.withReceiverLock(pubky, async () => {
      const receiver = await LocalMessagingService.getReceiver(pubky);
      if (!receiver?.marker_published) {
        await this.provisionReceiverLocked(wasmModule, session, pubky);
        return 'match';
      }
      const published = await this.getCounterpartyMarkerWith(wasmModule, pubky);
      if (published?.noisePublicKey === receiver.noise_public_key) {
        this.ownMarkerChecked.add(pubky);
        return 'match';
      }
      await this.provisionReceiverLocked(wasmModule, session, pubky);
      return published ? 'replaced' : 'missing';
    });
  }

  /**
   * What the own-marker check last republished for `pubky` and the user has
   * not been told yet; `null` when nothing was. Reading it clears it, so the
   * notice is shown once.
   */
  static takeOwnMarkerRepublished(pubky: string): OwnMarkerRepublished | null {
    const notice = this.ownMarkerNotices.get(pubky) ?? null;
    this.ownMarkerNotices.delete(pubky);
    return notice;
  }

  /**
   * Puts back a notice {@link takeOwnMarkerRepublished} handed to a status
   * read nobody was waiting for any more, so the next read tells the user.
   * Only while that account's session is still live, and never over a newer
   * notice.
   */
  static returnOwnMarkerRepublished(pubky: string, notice: OwnMarkerRepublished): void {
    if (!this.hasActiveSession(pubky) || this.ownMarkerNotices.has(pubky)) return;
    this.ownMarkerNotices.set(pubky, notice);
  }

  /**
   * The keys the Verify step compares out of band: the receiver key this
   * device publishes, and the key pinned for the counterparty with any
   * different key their marker advertised since. Local reads only.
   */
  static async getMessagingKeys(ownerPubky: string, counterpartyPubky: string): Promise<MessagingKeys> {
    const receiver = await this.endSessionIfKeyringChanged(() => LocalMessagingService.getReceiver(ownerPubky));
    const pin = await LocalMessagingService.getPeerKeyPin(ownerPubky, counterpartyPubky);
    return {
      ownKey: receiver?.noise_public_key ?? null,
      pinnedKey: pin?.pinnedKey ?? null,
      observedKey: pin?.observedKey ?? null,
    };
  }

  /**
   * Creates the receiver key for an account with no readable receiver. A
   * row that exists but cannot be opened (its wrapping key is lost, or it
   * was tampered with) is replaced, as re-enabling always has; a row some
   * other writer added meanwhile is adopted.
   */
  private static async createReceiver(
    wasmModule: PaykitWasmModule,
    pubky: string,
  ): Promise<CommerceMessagingReceiverModelSchema> {
    const now = Date.now();
    const noiseSecret = wasmModule.generateNoiseSecretKey();
    const receiver: CommerceMessagingReceiverModelSchema = {
      id: pubky,
      noise_secret: noiseSecret,
      noise_public_key: wasmModule.noisePublicKeyFromSecret(noiseSecret),
      receiver_path: PAYKIT_MESSAGING_RECEIVER_PATH,
      marker_published: false,
      created_at: now,
      updated_at: now,
    };
    if (await LocalMessagingService.addReceiver(receiver)) return receiver;
    const stored = await LocalMessagingService.getReceiver(pubky);
    if (stored) return stored;
    Logger.warn('The stored messaging receiver cannot be opened; replacing it with a new key', {
      reason: 'receiver_unreadable',
    });
    await LocalMessagingService.upsertReceiver(receiver);
    return receiver;
  }

  private static async getCounterpartyMarkerWith(
    wasmModule: PaykitWasmModule,
    counterpartyPubky: string,
  ): Promise<CounterpartyMessagingMarker | null> {
    const client = this.getClient(wasmModule);
    const marker = await readMarkerWithRetry(
      async () =>
        (await wasmModule.getReceiverMarker(client, counterpartyPubky, PAYKIT_MESSAGING_RECEIVER_PATH)) as
          | { receiverPath: string; noisePublicKey: string }
          | undefined,
      this.markerReadSleep,
    );
    return marker ? { receiverPath: marker.receiverPath, noisePublicKey: marker.noisePublicKey } : null;
  }

  private static requireSession(ownerPubky: string): ActiveSession {
    if (!this.session || this.session.pubky !== ownerPubky) {
      throw Err.auth(AuthErrorCode.SESSION_EXPIRED, 'No active messaging session. Reconnect with your signer.', {
        service: ErrorService.Paykit,
        operation: 'requireSession',
      });
    }
    return this.session;
  }

  /** Like {@link requireSession}, but first tries the silent reload restore. */
  private static async requireSessionOrRestore(ownerPubky: string): Promise<ActiveSession> {
    if (!this.hasActiveSession(ownerPubky)) {
      await this.restorePersistedSession(ownerPubky);
    }
    return this.requireSession(ownerPubky);
  }

  private static async requireReceiver(ownerPubky: string) {
    const receiver = await LocalMessagingService.getReceiver(ownerPubky);
    if (!receiver) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Messaging is not provisioned on this device.', {
        service: ErrorService.Paykit,
        operation: 'requireReceiver',
      });
    }
    // A key the marker may not advertise yet is never used: a peer would
    // encrypt to whichever key the marker holds.
    if (!receiver.marker_published) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Messaging is still being set up on this device.', {
        service: ErrorService.Paykit,
        operation: 'requireReceiver',
      });
    }
    return receiver;
  }

  /**
   * `restoredFrom` is the persisted blob a restore read: the restored session
   * is written back only while the slot still holds it, so a newer session
   * another tab saved during the restore is never overwritten.
   */
  private static setSession(session: ActiveSession, restoredFrom?: string): void {
    if (this.session && this.session.pubky !== session.pubky) this.dropLiveSession();
    else if (this.session) closeQuietly(() => this.session?.handle.free());
    this.session = session;
    this.sessionRetry.succeed(session.pubky);
    if (restoredFrom !== undefined && this.readSessionStorage() !== restoredFrom) return;
    this.writePersistedSession(session);
  }

  // localStorage access is wrapped because browsers can refuse it; a
  // session that cannot persist is still a working in-memory session, so
  // persistence failures only log (same posture as the marketplace session).
  private static writePersistedSession(session: ActiveSession): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        MESSAGING_SESSION_STORAGE_KEY,
        JSON.stringify({ pubky: session.pubky, exported: session.handle.exportSession() }),
      );
    } catch {
      Logger.warn('Could not persist the messaging session metadata; reconnect will be needed after a reload.');
    }
  }

  private static removePersistedSessionIfUnchanged(raw: string): void {
    if (this.readSessionStorage() !== raw) return;
    this.removePersistedSession();
  }

  private static removePersistedSession(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(MESSAGING_SESSION_STORAGE_KEY);
    } catch {
      // Removal failing means storage is unavailable, so nothing persisted either.
    }
  }

  private static readSessionStorage(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(MESSAGING_SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private static getClient(wasmModule: PaykitWasmModule): PubkyClient {
    this.client ??= getTestnet() ? wasmModule.PubkyClient.testnet() : new wasmModule.PubkyClient();
    return this.client;
  }

  /**
   * Serializes operations per counterparty: the binding rejects overlapping
   * operations on one link, and interleaved persistence would break the
   * messages-before-snapshot ordering. Each operation also holds the pair's
   * lock shared with every other tab ({@link withLinkLock}).
   */
  private static async withQueue<T>(
    ownerPubky: string,
    counterpartyPubky: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(counterpartyPubky) ?? Promise.resolve();
    const locked = () => this.withLinkLock(ownerPubky, counterpartyPubky, operation);
    const next = previous.then(locked, locked);
    this.queues.set(
      counterpartyPubky,
      next.catch(() => undefined),
    );
    return await next;
  }

  /**
   * Runs one link operation while holding the pair's lock, which every tab
   * of this origin shares. Each tab restores its own handle from the same
   * saved snapshot, so without the lock two tabs could send under the same
   * counter, complete the same handshake twice, or save a snapshot older
   * than another tab's send. Every send, snapshot save, receive and
   * handshake step runs here.
   *
   * Holding the lock, the tab first drops any in-memory handle or handshake
   * whose row another tab has written since this tab last did, so the
   * operation continues from the saved state instead of a stale one.
   * Without the Web Locks API, or when the lock is refused, nothing runs.
   */
  private static async withLinkLock<T>(
    ownerPubky: string,
    counterpartyPubky: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.endSessionIfKeyringChanged(() =>
      withWebLock(`pubky-messaging-link|${ownerPubky}|${counterpartyPubky}`, 'withLinkLock', async () => {
        await this.dropStateMovedByAnotherTab(ownerPubky, counterpartyPubky);
        try {
          return await operation();
        } finally {
          await this.recordLinkRevision(ownerPubky, counterpartyPubky);
        }
      }),
    );
  }

  /**
   * Runs receiver provisioning (reading, creating or replacing the receiver
   * Noise key, publishing its marker and marking it published) while
   * holding the account's receiver lock, which every tab of the origin
   * shares. Without it, two tabs could each create a key, and the marker
   * could end up advertising one while the device keeps the other.
   * Nothing is kept in memory across it: each holder reads the receiver
   * afresh.
   *
   * Lock order: a link operation may restore the session and so provision
   * the receiver while it holds its pair lock, so the order is always pair
   * lock, then receiver lock, then the key fence (shared, held only around
   * one database read or write of wrapped state, see
   * `withCurrentWrappingKey`), then the keyring's create lock. Nothing under
   * the receiver lock takes a pair lock or the receiver lock again, nothing
   * under the key fence takes the fence again or any lock but the create
   * lock, the create lock takes none, and sign-out holds only the fence, so
   * no two holders can wait on each other.
   */
  private static async withReceiverLock<T>(ownerPubky: string, operation: () => Promise<T>): Promise<T> {
    return await this.endSessionIfKeyringChanged(() =>
      withWebLock(`pubky-messaging-receiver|${ownerPubky}`, 'withReceiverLock', operation),
    );
  }

  /**
   * Another tab signed out or reset this account's messaging keys while this
   * tab still held its session: every handle, handshake and session this tab
   * holds belongs to state that no longer exists, so all of it is dropped.
   * Messaging resumes only through a fresh session restore.
   */
  private static async endSessionIfKeyringChanged<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isMessagingKeyringChanged(error)) this.clearSession();
      throw error;
    }
  }

  /**
   * Drops this tab's in-memory handle and handshake for the pair when the
   * stored row is no longer the one this tab last wrote or read. Runs under
   * the pair's lock, so no other tab is mid-operation on it.
   */
  private static async dropStateMovedByAnotherTab(ownerPubky: string, counterpartyPubky: string): Promise<void> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    const link = this.links.get(key);
    const handshake = this.handshakes.get(key);
    if (!link && !handshake) return;
    const revision = await LocalMessagingService.getLinkRevision(ownerPubky, counterpartyPubky);
    if (this.linkRevisions.has(key) && this.linkRevisions.get(key) === revision) return;
    Logger.warn('Another tab moved this link on; continuing from its saved state', {
      reason: 'link_moved_by_another_tab',
    });
    this.dropPairState(key);
  }

  /** Closes and forgets this tab's live handle and handshake for one pair. */
  private static dropPairState(key: string): void {
    const link = this.links.get(key);
    const handshake = this.handshakes.get(key);
    this.links.delete(key);
    this.handshakes.delete(key);
    this.unsavedSends.delete(key);
    if (link) closeQuietly(() => void link.close());
    if (handshake) closeQuietly(() => handshake.handle.free());
  }

  /**
   * Records the row revision this tab leaves behind. If it cannot be read,
   * the record is dropped, so the next operation treats the row as changed.
   */
  private static async recordLinkRevision(ownerPubky: string, counterpartyPubky: string): Promise<void> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    try {
      this.linkRevisions.set(key, await LocalMessagingService.getLinkRevision(ownerPubky, counterpartyPubky));
    } catch {
      this.linkRevisions.delete(key);
    }
  }

  private static linkKey(ownerPubky: string, counterpartyPubky: string): string {
    return `${ownerPubky}:${counterpartyPubky}`;
  }
}

/**
 * Runs `operation` holding the exclusive Web Lock `name`, shared by every
 * tab of the origin. Without the Web Locks API, or when the browser refuses
 * the lock, `operation` never runs and the call fails; an error thrown by
 * `operation` itself is passed on as it is.
 */
async function withWebLock<T>(name: string, operation: string, run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (typeof locks?.request !== 'function') {
    throw Err.client(
      ClientErrorCode.UNPROCESSABLE,
      'Private messages are paused: this browser cannot keep your open tabs from sending at the same time.',
      { service: ErrorService.Paykit, operation, context: { reason: 'lock_unsupported' } },
    );
  }
  let granted = false;
  try {
    return await locks.request(name, async () => {
      granted = true;
      return await run();
    });
  } catch (error) {
    if (granted) throw error;
    Logger.warn('A messaging lock was refused; nothing was sent or saved', { reason: 'lock_refused', operation });
    throw Err.client(
      ClientErrorCode.UNPROCESSABLE,
      'Private messages are paused: this tab could not coordinate with your other tabs. Try again.',
      { service: ErrorService.Paykit, operation, context: { reason: 'lock_refused' } },
    );
  }
}

/**
 * Send-side mirror of the inbound binding check: receivers drop a listing
 * message whose conversation does not name both link endpoints, so sending
 * one would be a silent loss. Throws the typed validation error instead.
 */
export function assertListingConversationBound(
  ownerPubky: string,
  counterpartyPubky: string,
  input: { conversationId: string; listingRef: string },
  operation: string,
): void {
  if (
    isListingConversationBound({
      conversationId: input.conversationId,
      listingRef: input.listingRef,
      ownerPubky,
      counterpartyPubky,
    })
  ) {
    return;
  }
  throw Err.validation(
    ValidationErrorCode.INVALID_INPUT,
    'This conversation is not between you and the person you are messaging.',
    { service: ErrorService.Paykit, operation },
  );
}

/**
 * The binding's typed rejections carry a stable machine-readable code in
 * `Error.name` (`SessionResumeUnauthorized` / `SessionResumePubkyMismatch` /
 * `SessionResumeScopeMissing`); everything else is untyped and treated as
 * transient.
 */
function isErrorNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function closeQuietly(dispose: () => void): void {
  try {
    dispose();
  } catch (error) {
    if (isAppError(error)) throw error;
    // wasm handles throw if already consumed/freed; that is fine on teardown.
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** One event as the binding returns it (`{ version, kind, rawJson }`), or as stored unprocessed. */
type InboundEvent = { rawJson: string; kind?: unknown; version?: unknown };

/** The `kind` and `version` a JSON envelope declares, when it declares a kind. */
function readEnvelopeHeader(rawJson: string): { kind: string | null; version: number | null } {
  let value: unknown;
  try {
    value = JSON.parse(rawJson);
  } catch {
    return { kind: null, version: null };
  }
  if (typeof value !== 'object' || value === null) return { kind: null, version: null };
  const { kind, version } = value as { kind?: unknown; version?: unknown };
  return {
    kind: typeof kind === 'string' && kind.length > 0 ? kind : null,
    version: typeof version === 'number' ? version : null,
  };
}
