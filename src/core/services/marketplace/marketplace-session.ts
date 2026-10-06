import { z } from 'zod';
import { CAPABILITIES, RING_COOKIE_CAPABILITIES } from '@/config/app';
import { getCommerceAdapterMode, getMarketplaceUrl, isDurableCommerceMode } from '@/config/commerce';
import { MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import { commercePubkySchema } from '@/libs/commerce/transaction-contracts';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import {
  AuthErrorCode,
  ClientErrorCode,
  ServerErrorCode,
  TimeoutErrorCode,
  ValidationErrorCode,
} from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { httpResponseToError, safeFetch } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';
import { isAppError, isRetryable } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import { getMarketplaceGrantFlowEnabled } from '@/libs/runtime-config/runtime-config';
import { sleep } from '@/libs/utils/utils';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { clearMarketplaceBffSession, pairMarketplaceBffSession } from './marketplace-grant-client';
import { resetMarketplaceNotificationDiagnostics } from './marketplace-notification-diagnostics';
import {
  MARKETPLACE_CLAIMABLE_GRANTS,
  MARKETPLACE_PREVIOUS_SESSION_GRANT,
  MARKETPLACE_SESSION_GRANT,
  type SessionReplacementRejection,
  sessionReplacementRejection,
} from './marketplace-session-grant';
import { marketplaceSessionIdSchema } from './marketplace-session-id';

/** Every grant a purchase-session writer may have persisted. */
const MARKETPLACE_RESTORABLE_GRANTS = [
  MARKETPLACE_SESSION_GRANT,
  MARKETPLACE_PREVIOUS_SESSION_GRANT,
  RING_COOKIE_CAPABILITIES,
  CAPABILITIES,
] as const;

/**
 * Treat a session as expired slightly before the server does, so a request
 * never departs with a token that dies in flight.
 */
const SESSION_EXPIRY_MARGIN_MS = 30_000;

/**
 * Upper bound on one connect attempt (QR shown → signer approval → token
 * exchange). Without it a flow whose relay channel silently died keeps the
 * dialog in "waiting for approval" forever — the wedge a tester hit by
 * scanning stale QRs. On timeout the flow is freed and the caller gets a
 * visible, retryable error; the QR from a timed-out flow is dead by design
 * (AuthTokens are single-use), so retry always mints a fresh one.
 */
export const SESSION_FLOW_TIMEOUT_MS = 120_000;

/** Dual-POST marketplace retries stop this long after `awaitToken()` resolved. */
export const MARKETPLACE_TOKEN_RETRY_DEADLINE_MS = 60_000;

/** `localStorage` key for the persisted session (see the class docs for the storage contract). */
export const MARKETPLACE_SESSION_STORAGE_KEY = 'pubky.marketplace.session.v1';

/**
 * Opaque session bearer as issued by `POST /v1/auth/sessions`: 32 random
 * bytes, URL-safe base64 without padding (43 characters). See
 * marketplace-service `auth.rs` (`URL_SAFE_NO_PAD.encode([u8; 32])`).
 */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const sessionResponseSchema = z.object({
  token: z.string().regex(SESSION_TOKEN_PATTERN),
  sessionId: marketplaceSessionIdSchema.optional(),
  pubky: commercePubkySchema,
  capabilities: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});

/** Session facts safe to hand to callers — never includes the bearer token. */
export type MarketplaceSessionInfo = {
  pubky: string;
  capabilities: string;
  expiresAt: string;
  /** Client clock when this bearer was established or restored; last-write-wins key. */
  issuedAt: string;
};

export type MarketplaceSessionEndedReason = 'expired' | 'rejected' | 'cleared';

export type MarketplaceSessionEndedEvent = {
  reason: MarketplaceSessionEndedReason;
  issuedAt: string;
};

export type MarketplaceSessionFlow = {
  authorizationUrl: string;
  awaitSession: () => Promise<MarketplaceSessionInfo>;
  cancel: () => void;
};

type StoredMarketplaceSession = {
  token: string;
  sessionId?: string;
  pubky: string;
  capabilities: string;
  expiresAtMs: number;
  expiresAt: string;
  issuedAt: string;
};

/**
 * Holds the Marketplace Transaction Service session for the signed-in browser
 * session: in memory for request use, mirrored to `localStorage` so reloads,
 * new tabs, and browser restarts do not force a fresh signer approval.
 *
 * Storage contract (a deliberate, documented loosening of the original
 * memory-only rule — see `docs/ecommerce/service-auth.md`; widened from
 * per-tab `sessionStorage` to `localStorage` on user decision: signer
 * approval is a rare ceremony, and the service-side TTL — not tab lifetime —
 * bounds the token):
 *  - The opaque bearer token plus its facts (pubky, capabilities, expiry) are
 *    written ONLY to `localStorage` under {@link MARKETPLACE_SESSION_STORAGE_KEY}.
 *    It survives tabs and restarts until the service TTL expires or the user
 *    signs out.
 *  - Never IndexedDB, never cookies, never logged.
 *  - Restore is account-scoped: {@link restorePersistedSession} validates the
 *    stored blob and adopts it only when its pubky matches the account whose
 *    app session was just restored. Sign-out (and account switch, which
 *    funnels through the same cleanup) clears it via
 *    `CommerceApplication.clearMarketplaceSessionForSignOut()`.
 *  - A restored token the service no longer accepts surfaces as a 401, which
 *    clears the session and re-shows the reconnect affordance — expiry is the
 *    service's call, not this cache's.
 *
 * Establishment (per `docs/ecommerce/service-auth.md`): the Pubky auth flow
 * yields an `AuthToken` after the user approves on their signer; the raw
 * postcard bytes are POSTed to `/v1/auth/sessions`, which verifies them with
 * `pubky-common` and answers with an opaque session token plus TTL. AuthTokens
 * are single-use, so an expired session cannot be refreshed silently — it
 * requires a fresh signer approval through {@link beginSessionFlow}.
 */
export class MarketplaceSessionService {
  private constructor() {}

  private static session: StoredMarketplaceSession | null = null;
  private static sessionEndedListeners = new Set<(event: MarketplaceSessionEndedEvent) => void>();
  private static sessionReplacedListeners = new Set<() => void>();

  /**
   * Fires after the in-memory session is dropped (TTL margin, 401/mismatch, or
   * explicit clear). Controllers subscribe; this service never touches stores.
   */
  static onSessionEnded(listener: (event: MarketplaceSessionEndedEvent) => void): () => void {
    this.sessionEndedListeners.add(listener);
    return () => {
      this.sessionEndedListeners.delete(listener);
    };
  }

  /**
   * Fires synchronously, before the new session is installed, whenever a new
   * session replaces a live one. Unlike {@link onSessionEnded} nothing ended
   * for the user, so listeners only drop what they hold for the old session.
   */
  static onSessionReplaced(listener: () => void): () => void {
    this.sessionReplacedListeners.add(listener);
    return () => {
      this.sessionReplacedListeners.delete(listener);
    };
  }

  /**
   * Starts the interactive session flow. Returns the authorization URL to show
   * on the user's signer (QR/deeplink) and a lazy `awaitSession` that resolves
   * once the user approves and the transaction service issues a session. The
   * request is a `pubkyauth://signin` AuthToken for
   * {@link MARKETPLACE_SESSION_GRANT}, the scope the grant flow asks for, so
   * the session qualifies for the `/priv` data key.
   * `awaitSession` rejects with a retryable timeout error after
   * {@link SESSION_FLOW_TIMEOUT_MS} so an abandoned or dead-relay flow can
   * never hold the UI in an awaiting state forever.
   */
  static beginSessionFlow(): MarketplaceSessionFlow {
    this.assertTransactionServiceMode('beginSessionFlow');
    const flow = HomeserverService.generateAuthTokenFlow(MARKETPLACE_SESSION_GRANT);
    return {
      authorizationUrl: flow.authorizationUrl,
      awaitSession: async () => {
        const authToken = await this.withFlowTimeout(flow.awaitToken(), flow.cancelAuthFlow);
        return await this.establishWithAuthToken(authToken.toBytes(), authToken.publicKey.z32(), [
          MARKETPLACE_SESSION_GRANT,
        ]);
      },
      cancel: flow.cancelAuthFlow,
    };
  }

  static async withFlowTimeout<T>(pending: Promise<T>, cancelFlow: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Free the WASM flow so the relay wait cannot linger; the rejection
        // below is what the caller surfaces.
        cancelFlow();
        reject(
          Err.timeout(
            TimeoutErrorCode.REQUEST_TIMEOUT,
            'The connect request expired before it was approved. Start again to get a fresh QR code.',
            {
              service: ErrorService.Marketplace,
              operation: 'awaitSession',
              context: { timeoutMs: SESSION_FLOW_TIMEOUT_MS },
            },
          ),
        );
      }, SESSION_FLOW_TIMEOUT_MS);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Exchanges signed AuthToken bytes for a transaction-service session and
   * stores it in memory, replacing any previous session. `expectedPubky` is
   * the requesting account (the AuthToken signer); a response for any other
   * pubky is rejected. `acceptedCapabilities` pins the grant the caller
   * requested; the minted session is refused, and the current one kept, when
   * it carries anything else or drops a scope the current session covers.
   */
  static async establishWithAuthToken(
    authTokenBytes: Uint8Array,
    expectedPubky: string,
    acceptedCapabilities: readonly string[] | null = null,
  ): Promise<MarketplaceSessionInfo> {
    this.assertTransactionServiceMode('establishWithAuthToken');
    const url = `${getMarketplaceUrl()}/v1/auth/sessions`;
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: authTokenBytes as BodyInit,
      },
      ErrorService.Marketplace,
      'establishWithAuthToken',
    );
    if (!response.ok) {
      if (response.status >= 500) {
        throw httpResponseToError(response, ErrorService.Marketplace, 'establishWithAuthToken', url);
      }
      const alreadyUsed = response.status === 401 ? await this.responseSaysAuthTokenAlreadyUsed(response) : false;
      throw Err.auth(AuthErrorCode.INVALID_TOKEN, 'The marketplace service rejected the auth token.', {
        service: ErrorService.Marketplace,
        operation: 'establishWithAuthToken',
        context: { statusCode: response.status, alreadyUsed },
      });
    }
    const raw = await this.parseSessionMintBody(response);
    const parsed = sessionResponseSchema.safeParse(toCamelCaseWire(raw));
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned an invalid session response.', {
        service: ErrorService.Marketplace,
        operation: 'establishWithAuthToken',
        context: { statusCode: response.status },
      });
    }
    if (parsed.data.pubky !== expectedPubky) {
      throw Err.auth(AuthErrorCode.FORBIDDEN, 'Marketplace returned a session for a different account.', {
        service: ErrorService.Marketplace,
        operation: 'establishWithAuthToken',
        context: { statusCode: response.status },
      });
    }
    const { token, sessionId, pubky, capabilities, expiresAt } = parsed.data;
    this.assertMayReplace(pubky, capabilities, acceptedCapabilities, 'establishWithAuthToken');
    const issuedAt = new Date().toISOString();
    resetMarketplaceNotificationDiagnostics();
    const installed = this.installSession({
      token,
      sessionId,
      pubky,
      capabilities,
      expiresAt,
      expiresAtMs: Date.parse(expiresAt),
      issuedAt,
    });
    this.writePersistedSession(parsed.data);
    if (getMarketplaceGrantFlowEnabled() && sessionId) {
      void pairMarketplaceBffSession({ token, pubky, sessionId }).catch(() => {
        Logger.warn('Marketplace grant reconnect is unavailable for this session.');
      });
    }
    Logger.info('Established marketplace transaction session', { pubky, expiresAt });
    return this.toPublicInfo(installed);
  }

  /**
   * Marketplace half of the single-approval ceremony: same bytes, retries until
   * 60s after token resolution, 401 already-used is success when this client
   * already holds a bearer for the same pubky.
   */
  static async redeemAuthTokenAfterHomeserver(
    authTokenBytes: Uint8Array,
    expectedPubky: string,
    tokenResolvedAtMs: number,
  ): Promise<MarketplaceSessionInfo> {
    this.assertTransactionServiceMode('redeemAuthTokenAfterHomeserver');
    const deadline = tokenResolvedAtMs + MARKETPLACE_TOKEN_RETRY_DEADLINE_MS;
    for (;;) {
      try {
        return await this.establishWithAuthToken(authTokenBytes, expectedPubky, [RING_COOKIE_CAPABILITIES]);
      } catch (error) {
        if (this.isAuthTokenAlreadyUsedError(error)) {
          const existing = this.bearerForPubky(expectedPubky);
          if (existing) return this.toPublicInfo(existing);
          throw error;
        }
        const retryable = isAppError(error) && isRetryable(error);
        if (!retryable || Date.now() >= deadline) {
          throw error;
        }
        await sleep(250);
      }
    }
  }

  private static bearerForPubky(expectedPubky: string): StoredMarketplaceSession | null {
    const memory = this.getActiveSession();
    if (memory?.pubky === expectedPubky) return memory;
    this.restorePersistedSession(expectedPubky);
    const restored = this.getActiveSession();
    if (restored?.pubky === expectedPubky) return restored;
    return null;
  }

  private static isAuthTokenAlreadyUsedError(error: unknown): boolean {
    return isAppError(error) && error.context?.alreadyUsed === true && error.context?.statusCode === 401;
  }

  private static async responseSaysAuthTokenAlreadyUsed(response: Response): Promise<boolean> {
    try {
      const text = await response.text();
      return /already been used/i.test(text);
    } catch {
      return false;
    }
  }

  /**
   * Restores a persisted session from `localStorage` for the given account.
   * Called once the app's own session restore has identified who is signed in
   * (`AuthController.restorePersistedSession`), and again by Seller Studio and
   * own-drop loads. Anything that does not validate — malformed blob, already
   * past the expiry margin, a grant no writer may store — removes the stored
   * value while the slot still holds exactly what was read, and returns null,
   * so a stale token can never outlive its checks. Another account's record
   * is not this caller's: it is left for its owner, and sign-out removes it.
   *
   * `localStorage` is shared across tabs, so the slot can hold another tab's
   * narrower session. A restore never replaces a wider in-memory session for
   * the same pubky: it keeps memory, leaves the other tab's blob alone, and
   * returns the in-memory facts so the store mirror stays on the wider one.
   */
  static restorePersistedSession(expectedPubky: string): MarketplaceSessionInfo | null {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return null;
    // Expire memory before reading the slot, so the expiry cleanup runs
    // against the old bearer and never against the candidate read below.
    this.getActiveSession();
    const raw = this.readStorage();
    if (raw === null) return null;

    const parsed = sessionResponseSchema.safeParse(this.parseJson(raw));
    if (!parsed.success) {
      this.removePersistedRecordIfUnchanged(raw);
      return null;
    }
    if (parsed.data.pubky !== expectedPubky) return null;
    const { token, sessionId, pubky, capabilities, expiresAt } = parsed.data;
    const expiresAtMs = Date.parse(expiresAt);
    if (Date.now() >= expiresAtMs - SESSION_EXPIRY_MARGIN_MS) {
      this.removePersistedRecordIfUnchanged(raw);
      return null;
    }
    const rejection = this.replacementRejection(
      pubky,
      capabilities,
      MARKETPLACE_RESTORABLE_GRANTS,
      'restorePersistedSession',
    );
    if (rejection === 'unexpected_capabilities') {
      this.removePersistedRecordIfUnchanged(raw);
      const current = this.getActiveSession();
      return current?.pubky === expectedPubky ? this.toPublicInfo(current) : null;
    }
    if (rejection === 'narrower_than_current') {
      const current = this.getActiveSession();
      return current ? this.toPublicInfo(current) : null;
    }

    const issuedAt = new Date().toISOString();
    const installed = this.installSession({ token, sessionId, pubky, capabilities, expiresAt, expiresAtMs, issuedAt });
    if (getMarketplaceGrantFlowEnabled() && sessionId) {
      void pairMarketplaceBffSession({ token, pubky, sessionId }).catch(() => {
        Logger.warn('Marketplace grant reconnect is unavailable for the restored session.');
      });
    }
    Logger.info('Restored marketplace transaction session', { pubky, expiresAt });
    return this.toPublicInfo(installed);
  }

  /**
   * Returns the stored session (including the bearer token) when still valid,
   * dropping it once it reaches the expiry margin. Transport-layer use only.
   */
  static getActiveSession(): StoredMarketplaceSession | null {
    if (!this.session) return null;
    if (Date.now() >= this.session.expiresAtMs - SESSION_EXPIRY_MARGIN_MS) {
      this.clearSession('expired');
      return null;
    }
    return this.session;
  }

  /**
   * Drops the in-memory session (TTL margin, revocation, a refused bearer)
   * and only the persisted record and BFF pairing that belong to it.
   * `localStorage` and the BFF cookie are shared across tabs: another tab may
   * already hold a newer bearer there, and it must survive this tab's expiry.
   * Sign-out and account switch use {@link clearForSignOut} instead.
   */
  static clearSession(reason: MarketplaceSessionEndedReason = 'cleared'): void {
    const ended = this.session;
    this.session = null;
    resetMarketplaceNotificationDiagnostics();
    if (!ended) return;
    this.removePersistedSessionIfOwned(ended.token);
    if (getMarketplaceGrantFlowEnabled() && ended.sessionId) void clearMarketplaceBffSession(ended.sessionId);
    this.notifySessionEnded({ reason, issuedAt: ended.issuedAt });
  }

  /**
   * Drops the session only when `token` is still the in-memory bearer. A
   * 401 answers the bearer a request carried; if the session was replaced
   * while the request was in flight, the newer one stays.
   */
  static clearSessionIfBearer(token: string, reason: MarketplaceSessionEndedReason): void {
    if (this.session?.token !== token) return;
    this.clearSession(reason);
  }

  /**
   * Sign-out and account switch: the user leaves, so no purchase bearer may
   * stay at rest for this browser, whichever tab persisted it. The only path
   * that removes a record it did not write.
   */
  static clearForSignOut(): void {
    const ended = this.session;
    this.session = null;
    resetMarketplaceNotificationDiagnostics();
    this.removePersistedSession();
    if (getMarketplaceGrantFlowEnabled()) void clearMarketplaceBffSession();
    if (!ended) return;
    this.notifySessionEnded({ reason: 'cleared', issuedAt: ended.issuedAt });
  }

  /**
   * Account switch without a sign-out (a sign-in ceremony for another
   * account): the account that left owns nothing here any more, so its
   * bearer goes from memory and from rest, whichever tab persisted it. A
   * bearer `keepPubky` already holds (the ceremony may have minted one) stays,
   * and is persisted again if the departed record had kept it out of the slot.
   */
  static clearOtherAccounts(keepPubky: string): void {
    if (this.session && this.session.pubky !== keepPubky) this.clearSession('cleared');
    const stored = this.persistedBearer();
    if (!stored || stored.pubky === keepPubky) return;
    this.removePersistedSession();
    if (getMarketplaceGrantFlowEnabled() && typeof stored.sessionId === 'string') {
      void clearMarketplaceBffSession(stored.sessionId);
    }
    if (this.session) {
      const { token, sessionId, pubky, capabilities, expiresAt } = this.session;
      this.writePersistedSession({ token, sessionId, pubky, capabilities, expiresAt });
    }
  }

  private static toPublicInfo(session: StoredMarketplaceSession): MarketplaceSessionInfo {
    return {
      pubky: session.pubky,
      capabilities: session.capabilities,
      expiresAt: session.expiresAt,
      issuedAt: session.issuedAt,
    };
  }

  static establishClaimedGrantSession(
    input: {
      token: string;
      sessionId?: string;
      pubky: string;
      capabilities: string;
      expiresAt: string;
    },
    expectedPubky: string,
  ): MarketplaceSessionInfo {
    const parsed = sessionResponseSchema.parse(input);
    if (parsed.pubky !== expectedPubky) {
      throw Err.auth(AuthErrorCode.FORBIDDEN, 'Marketplace returned a session for a different account.', {
        service: ErrorService.Marketplace,
        operation: 'establishClaimedGrantSession',
      });
    }
    this.assertMayReplace(
      parsed.pubky,
      parsed.capabilities,
      MARKETPLACE_CLAIMABLE_GRANTS,
      'establishClaimedGrantSession',
    );
    const issuedAt = new Date().toISOString();
    const installed = this.installSession({
      ...parsed,
      expiresAtMs: Date.parse(parsed.expiresAt),
      issuedAt,
    });
    this.writePersistedSession(parsed);
    resetMarketplaceNotificationDiagnostics();
    return this.toPublicInfo(installed);
  }

  private static installSession(next: StoredMarketplaceSession): StoredMarketplaceSession {
    if (this.session) {
      for (const listener of [...this.sessionReplacedListeners]) listener();
    }
    this.session = next;
    return next;
  }

  /**
   * The one check every path that puts a purchase session into memory or
   * storage runs first: the establish writers through {@link assertMayReplace},
   * the persisted restore directly.
   */
  private static replacementRejection(
    pubky: string,
    capabilities: string,
    accepted: readonly string[] | null,
    operation: string,
  ): SessionReplacementRejection | null {
    const rejection = sessionReplacementRejection(capabilities, accepted, this.getActiveSession(), pubky);
    if (rejection) {
      Logger.warn('Refused a marketplace session that would replace the current one', { rejection, operation });
    }
    return rejection;
  }

  private static assertMayReplace(
    pubky: string,
    capabilities: string,
    accepted: readonly string[] | null,
    operation: string,
  ): void {
    const rejection = this.replacementRejection(pubky, capabilities, accepted, operation);
    if (!rejection) return;
    throw Err.validation(
      ValidationErrorCode.INVALID_INPUT,
      rejection === 'narrower_than_current'
        ? MARKETPLACE_FAILURE_MESSAGES.sessionGrantNarrower
        : MARKETPLACE_FAILURE_MESSAGES.sessionGrantUnexpected,
      { service: ErrorService.Marketplace, operation, context: { rejection } },
    );
  }

  private static notifySessionEnded(event: MarketplaceSessionEndedEvent): void {
    const listeners = [...this.sessionEndedListeners];
    queueMicrotask(() => {
      for (const listener of listeners) listener(event);
    });
  }

  // localStorage access is wrapped because browsers can refuse it (disabled
  // storage, private-mode quirks); a session that cannot persist is still a
  // working in-memory session, so persistence failures only log.
  /**
   * Persists a freshly minted session unless the slot already holds a
   * different bearer that outlives it: another tab minted after this tab's
   * request left, and its newer record must not be overwritten.
   */
  private static writePersistedSession(session: z.infer<typeof sessionResponseSchema>): void {
    if (typeof window === 'undefined') return;
    const stored = this.persistedBearer();
    if (stored && stored.token !== session.token && stored.expiresAtMs > Date.parse(session.expiresAt)) {
      Logger.warn('Kept a newer marketplace session another tab persisted.');
      return;
    }
    try {
      window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      Logger.warn('Could not persist the marketplace session; it will last until the next reload only.');
    }
  }

  /** The bearer, account, BFF pairing and expiry of the persisted record, or null when there is none to compare. */
  private static persistedBearer(): { token: string; pubky: unknown; sessionId: unknown; expiresAtMs: number } | null {
    const raw = this.readStorage();
    if (raw === null) return null;
    const value = this.parseJson(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { token, pubky, sessionId, expiresAt } = value as {
      token?: unknown;
      pubky?: unknown;
      sessionId?: unknown;
      expiresAt?: unknown;
    };
    if (typeof token !== 'string') return null;
    const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    return { token, pubky, sessionId, expiresAtMs: Number.isNaN(expiresAtMs) ? 0 : expiresAtMs };
  }

  /** Removes the persisted record only when it still carries `token`. */
  private static removePersistedSessionIfOwned(token: string): void {
    if (this.persistedBearer()?.token !== token) return;
    this.removePersistedSession();
  }

  /** Removes the persisted record only when it is still exactly `raw`. */
  private static removePersistedRecordIfUnchanged(raw: string): void {
    if (this.readStorage() !== raw) return;
    this.removePersistedSession();
  }

  private static removePersistedSession(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(MARKETPLACE_SESSION_STORAGE_KEY);
    } catch {
      // Removal failing means storage is unavailable, so nothing persisted either.
    }
  }

  private static readStorage(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Reads the `/v1/auth/sessions` body WITHOUT the generic
   * `parseResponseOrThrow`: that helper used to embed a body excerpt in error
   * context (`responseText`), which the factories log to the console — and this
   * body BEGINS with the freshly minted bearer token.
   *
   * Strict `JSON.parse` of the entire body only. A previous "lenient salvage"
   * that sliced from the first `{` to the last `}` accepted a prepended
   * attacker object (session fixation). Prefix salvage of a balanced object
   * starting at byte 0 would still accept a concatenated attacker object
   * followed by the truncated genuine body. The cost of failing closed is a
   * rare second Ring approval when a proxy mangles the bytes.
   *
   * Mid-token truncation fails closed because `JSON.parse` requires the whole
   * text to be one complete value — including if a future nested field adds
   * extra braces. Do not restore brace-slicing salvage.
   */
  private static async parseSessionMintBody(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned an unreadable session response.', {
        service: ErrorService.Marketplace,
        operation: 'establishWithAuthToken',
        context: { statusCode: response.status },
      });
    }
  }

  private static parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private static assertTransactionServiceMode(operation: string): void {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Marketplace transaction-service sessions are disabled.', {
        service: ErrorService.Marketplace,
        operation,
      });
    }
  }
}
