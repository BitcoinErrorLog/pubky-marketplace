import type { AuthToken, Session, XCallbackParams } from '@synonymdev/pubky';
import { userUriBuilder } from 'pubky-app-specs';
import type {
  TKeypairParams,
  TMarketplaceRedeemError,
  TRestoreSessionOutcome,
  TRestoreSessionParams,
  TRestoreSessionResult,
  TSingleApprovalCeremonyHooks,
  TSingleApprovalResult,
} from '@/application/auth/auth.types';
import { capabilitiesMatchFullGrant, RING_COOKIE_CAPABILITIES } from '@/config/app';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import {
  isAppError,
  isAuthError,
  isNotFound,
  isRetryable,
  isWrongEnvironmentHomeserverError,
  toAppError,
} from '@/libs/error/error.utils';
import { HttpMethod } from '@/libs/http/http.types';
import { Identity } from '@/libs/identity/identity';
import { Logger } from '@/libs/logger/logger';
import { sleep } from '@/libs/utils/utils';
import { isVibeSessionBridgeLegSkipped, suppressVibeSessionAutoRestore } from '@/libs/vibe-session/auto-restore';
import { requestFromBridge } from '@/libs/vibe-session/bridge';
import { getVibeId, getVibeSessionBridgeOrigin } from '@/libs/vibe-session/config';
import { isPubkyExpiredError } from '@/libs/vibe-session/expired';
import { discardFragmentSessionExport, takeFragmentSessionExport } from '@/libs/vibe-session/fragment';
import { VIBE_SESSION_LOAD_TIMEOUT_MS, VIBE_SESSION_REPLY_TIMEOUT_MS } from '@/libs/vibe-session/types';
import type { Pubky } from '@/models/models.types';
import { HomeserverService } from '@/services/homeserver/homeserver';
import type {
  TGenerateAuthTokenFlowResult,
  TGenerateAuthUrlResult,
  THomeserverPublicKeyParams,
  THomeserverSessionResult,
  THomeserverSignUpParams,
} from '@/services/homeserver/homeserver.types';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';

export function isDefinitiveSessionAuthFailure(error: unknown): boolean {
  if (isWrongEnvironmentHomeserverError(error)) {
    return false;
  }
  if (isAppError(error) && isAuthError(error)) {
    return true;
  }
  return isPubkyExpiredError(error);
}

export class AuthApplication {
  private constructor() {} // Prevent instantiation

  private static restoreSessionPromise: TRestoreSessionResult | null = null;
  private static bridgeAbortController: AbortController | null = null;

  static abortInFlightBridgeRequest(): void {
    this.bridgeAbortController?.abort();
    this.bridgeAbortController = null;
  }

  /** Max attempts before falling back to sign-out (~30 s with a 3 s delay between each) */
  private static readonly RESTORE_MAX_ATTEMPTS = 10;
  /** Fixed delay between retry attempts */
  private static readonly RESTORE_RETRY_DELAY_MS = 3000;

  /**
   * Restores a session from a persisted session export.
   * Prevents concurrent restoration attempts by managing a singleton promise.
   *
   * Retries on transient errors (network, timeout, server) to handle scenarios
   * like ERR_NETWORK_CHANGED when the browser tab is resumed or the device
   * reconnects. Non-retryable errors (e.g. genuinely expired session) bail out
   * immediately. After all attempts are exhausted the session is cleared so the
   * user is signed out rather than left on a loading spinner.
   *
   * @param authStore - The auth store object containing state and actions needed for restoration
   * @returns The restored session, or null if restoration failed
   */
  static async restorePersistedSession({
    authStore,
    confirmSessionHandoff = async () => false,
  }: TRestoreSessionParams): TRestoreSessionResult {
    // If a restoration is already in progress, return the existing promise
    if (this.restoreSessionPromise) {
      return await this.restoreSessionPromise;
    }

    // A grant session (Bitkit sign-in) restores from BrowserSessionStore only:
    // it has no cookie export and never takes the bridge or fragment legs.
    const grantRecordId = authStore.grantSessionRecordId;
    if (grantRecordId) {
      this.restoreSessionPromise = (async () => {
        try {
          return await this.restoreGrantSession(grantRecordId);
        } finally {
          // Same bound as the cookie leg: a `#s=` captured on this load must
          // not survive into a later restore after this one signs out.
          discardFragmentSessionExport();
          this.restoreSessionPromise = null;
        }
      })();
      return await this.restoreSessionPromise;
    }

    const consumerOrigin = getVibeSessionBridgeOrigin();
    const persistedExport = authStore.sessionExport;

    // Safety check: if sessionExport is missing and consumer mode is off, return null
    if (!persistedExport && !consumerOrigin) {
      return { status: 'signed-out' };
    }

    // Start restoration and store the promise so concurrent calls can await the same one.
    // Note: Application never touches `isRestoringSession` — the Controller owns that
    // flag for the whole restore+finalization span so no leg can leave a loading gap.
    this.restoreSessionPromise = (async () => {
      try {
        return await this.runSessionRestore({ persistedExport, consumerOrigin, confirmSessionHandoff });
      } finally {
        // The first restore decision of this page load has run (whichever leg
        // decided it) — drop any cached `#s=` export so a later same-tab
        // logout cannot resurrect the hand-off.
        discardFragmentSessionExport();
        this.restoreSessionPromise = null;
      }
    })();

    return await this.restoreSessionPromise;
  }

  private static async runSessionRestore({
    persistedExport,
    consumerOrigin,
    confirmSessionHandoff,
  }: {
    persistedExport: string | null;
    consumerOrigin: string | undefined;
    confirmSessionHandoff: (pubky: Pubky) => Promise<boolean>;
  }): TRestoreSessionResult {
    let keepPersistedExport = false;

    if (persistedExport) {
      const persisted = await this.restoreSessionFromExport(persistedExport);
      if (persisted.session) {
        return { status: 'restored', session: persisted.session };
      }
      if (isDefinitiveSessionAuthFailure(persisted.lastError)) {
        keepPersistedExport = false;
      } else {
        // Transient / unknown persist failure: never erase the export, with or
        // without consumer mode. The outcome is deferred (retryable on the next
        // load); signed-out is reserved for definitive auth failures.
        keepPersistedExport = true;
      }
    }

    if (!consumerOrigin) {
      return keepPersistedExport ? { status: 'deferred' } : { status: 'signed-out' };
    }

    const fragmentExport = takeFragmentSessionExport();
    if (fragmentExport) {
      const fromFragment = await this.restoreSessionFromExport(fragmentExport);
      if (fromFragment.session) {
        // Any page can link here with a `#s=` for a session the browser holds a
        // cookie for, including one a third party planted. Nothing binds the
        // hand-off to this device, so the user confirms the identity first.
        if (await confirmSessionHandoff(Identity.z32FromSession({ session: fromFragment.session }))) {
          return { status: 'restored', session: fromFragment.session };
        }
        // Declined: the bridge must not apply an identity the user just refused.
        suppressVibeSessionAutoRestore();
        return this.unresolvedConsumerRestore(keepPersistedExport);
      }
    }

    if (isVibeSessionBridgeLegSkipped()) {
      return this.unresolvedConsumerRestore(keepPersistedExport);
    }

    const bridgeExport = await this.obtainBridgeSessionExport(consumerOrigin);
    if (!bridgeExport) {
      return this.unresolvedConsumerRestore(keepPersistedExport);
    }

    const fromBridge = await this.restoreSessionFromExport(bridgeExport);
    if (fromBridge.session) {
      return { status: 'restored', session: fromBridge.session };
    }
    return this.unresolvedConsumerRestore(keepPersistedExport);
  }

  private static unresolvedConsumerRestore(keepPersistedExport: boolean): TRestoreSessionOutcome {
    return keepPersistedExport ? { status: 'deferred' } : { status: 'signed-out' };
  }

  /**
   * Restores a grant session from its BrowserSessionStore record. A transient
   * failure keeps the record (deferred); a definitive one removes it and signs
   * out, and a failed removal rejects so the record pointer is kept. There is
   * no cookie fallback for a grant sign-in.
   */
  private static async restoreGrantSession(recordId: string): TRestoreSessionResult {
    let session: Session | null = null;
    try {
      session = await HomeserverService.restoreGrantSession(recordId);
      if (!capabilitiesMatchFullGrant(session.info.capabilities)) {
        Logger.warn('Stored grant session does not hold the full Shop grant; removing its record');
        await HomeserverService.logout({ session }).catch((logoutError) => {
          Logger.warn('Failed to sign out a narrow grant session', { logoutError });
        });
        await this.removeGrantSession(recordId);
        return { status: 'signed-out' };
      }
      await HomeserverService.assertUserHomeserverAllowed({ publicKey: session.info.publicKey });
      return { status: 'restored', session };
    } catch (error) {
      if (isWrongEnvironmentHomeserverError(error)) {
        if (session) {
          await HomeserverService.logout({ session }).catch((logoutError) => {
            Logger.warn('Failed to sign out wrong-environment grant session', { logoutError });
          });
        }
        await this.removeGrantSession(recordId);
        throw error;
      }
      if (session === null && !isDefinitiveSessionAuthFailure(error) && isAppError(error) && isRetryable(error)) {
        Logger.warn('Grant session restore failed with a transient error; keeping the record', { error });
        return { status: 'deferred' };
      }
      Logger.info('Grant session could not be restored; removing its record', { error });
      // Rejects while the record is still stored: the caller keeps the pointer.
      await this.removeGrantSession(recordId);
      return { status: 'signed-out' };
    }
  }

  private static async restoreSessionFromExport(
    sessionExport: string,
  ): Promise<{ session: Session; lastError?: undefined } | { session: null; lastError: unknown }> {
    // The restored session is kept across attempts so a transient
    // environment-check failure retries only the PKARR lookup instead of
    // re-running the whole restore round-trip.
    let session: Session | null = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.RESTORE_MAX_ATTEMPTS; attempt++) {
      try {
        session ??= await HomeserverService.restoreSession({ sessionExport });
        // Transient lookup failures fall through to the shared retry-or-cleanup
        // policy below — keeping the store in a half-restored state would
        // strand useAuthStatus in its loading branch with no retry trigger.
        await HomeserverService.assertUserHomeserverAllowed({ publicKey: session.info.publicKey });
        Logger.info('Session restored successfully');
        return { session };
      } catch (error) {
        if (isWrongEnvironmentHomeserverError(error)) {
          // The session is about to be discarded and its persisted export
          // erased — sign it out on its own homeserver so it is not left
          // dangling there. Best-effort: the rejection surfaces anyway.
          if (session) {
            await HomeserverService.logout({ session }).catch((logoutError) => {
              Logger.warn('Failed to sign out wrong-environment session', { logoutError });
            });
          }
          throw error;
        }

        lastError = error;
        const canRetry = isAppError(error) && isRetryable(error) && attempt < this.RESTORE_MAX_ATTEMPTS;
        if (!canRetry) {
          Logger.error('Failed to restore session from persisted export', error);
          break;
        }

        Logger.warn(
          `Session restore attempt ${attempt}/${this.RESTORE_MAX_ATTEMPTS} failed with transient error, retrying in ${this.RESTORE_RETRY_DELAY_MS}ms`,
          { error },
        );
        await sleep(this.RESTORE_RETRY_DELAY_MS);
      }
    }
    return { session: null, lastError };
  }

  private static async obtainBridgeSessionExport(bridgeOrigin: string): Promise<string | null> {
    if (isVibeSessionBridgeLegSkipped()) {
      return null;
    }
    const win = (globalThis as { window?: Window }).window;
    if (!win) {
      return null;
    }
    const vibeId = getVibeId();
    Logger.info('Requesting vibe session from bridge', { vibeId });
    this.abortInFlightBridgeRequest();
    const controller = new AbortController();
    this.bridgeAbortController = controller;
    try {
      const result = await requestFromBridge(
        win,
        bridgeOrigin,
        VIBE_SESSION_LOAD_TIMEOUT_MS,
        VIBE_SESSION_REPLY_TIMEOUT_MS,
        controller.signal,
      );
      if (result.kind === 'export') {
        return result.sessionExport;
      }
      return null;
    } finally {
      if (this.bridgeAbortController === controller) {
        this.bridgeAbortController = null;
      }
    }
  }

  /**
   * Signs up a new user in the homeserver with the provided keypair and authentication credentials.
   *
   * @param params - The authentication parameters containing user credentials
   * @param params.keypair - The cryptographic keypair for the user
   * @param params.signupToken - Invitation code for user registration
   * @param params.secretKey - Secret key for homeserver service
   * @returns Session and pubky of the signed up user
   */
  static async signUp({ keypair, signupToken }: THomeserverSignUpParams): Promise<THomeserverSessionResult> {
    return await HomeserverService.signUp({ keypair, signupToken });
  }

  /**
   * Verifies a signup token (invite code) against the homeserver.
   *
   * @param signupToken - The signup token / invite code to verify
   * @returns `'valid'`, `'used'`, or `'invalid'` depending on the homeserver response
   */
  static async verifySignupToken(signupToken: string) {
    return await HomeserverService.verifySignupToken(signupToken);
  }

  /**
   * Authenticates the user against the homeserver using their cryptographic keypair.
   *
   * @param params - The authentication parameters
   * @param params.keypair - The cryptographic keypair for the user authentication
   * @param params.secretKey - Secret key for homeserver service
   * @returns Session and pubky of the authenticated user
   */
  static async signIn({ keypair }: TKeypairParams): Promise<THomeserverSessionResult | undefined> {
    if (!keypair) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        'Keypair not found in onboarding store. Please regenerate your keys and try again.',
        {
          service: ErrorService.Local,
          operation: 'signIn',
        },
      );
    }
    return await HomeserverService.signIn({ keypair });
  }

  /**
   * Generates an authentication URL for Pubky Ring App
   *
   * @returns Authentication URL and approval promise
   */
  static async generateAuthUrl(): Promise<TGenerateAuthUrlResult> {
    return await HomeserverService.generateAuthUrl();
  }

  /** Grant sign-in URL (`pubkyauth://signin_grant`) for signers such as Bitkit and Pubky Passport. */
  static async generateGrantAuthUrl(xCallback?: XCallbackParams): Promise<TGenerateAuthUrlResult> {
    return await HomeserverService.generateGrantAuthUrl(xCallback);
  }

  static isGrantSignInAvailable(): boolean {
    return HomeserverService.isGrantSignInAvailable();
  }

  static isGrantSession(session: Session | null | undefined): boolean {
    return HomeserverService.isGrantSession(session);
  }

  /**
   * A grant session holds exactly the Shop grant (`CAPABILITIES`), so it never
   * needs a step-up re-approval. An approval for anything narrower is signed
   * out and refused, the way the Ring token path refuses it.
   */
  static async assertFullGrantSession(session: Session): Promise<void> {
    if (capabilitiesMatchFullGrant(session.info.capabilities)) return;
    await HomeserverService.logout({ session }).catch((logoutError) => {
      Logger.warn('Failed to sign out a narrow grant session', { logoutError });
    });
    throw Err.validation(
      ValidationErrorCode.INVALID_INPUT,
      'This approval does not include the full Shop permission list. Approve again from Shop.',
      { service: ErrorService.Homeserver, operation: 'assertFullGrantSession' },
    );
  }

  static async saveGrantSession(session: Session): Promise<string> {
    return await HomeserverService.saveGrantSession(session);
  }

  /** Removes one stored grant session and its key; rejects while it is still stored. */
  static async removeGrantSession(recordId: string): Promise<void> {
    await this.withGrantKeyRemovalRetry(() => HomeserverService.removeGrantSession(recordId));
  }

  /** Removes every stored grant session and key for this origin; rejects while any remains. */
  static async clearGrantSessions(): Promise<void> {
    await this.withGrantKeyRemovalRetry(() => HomeserverService.clearGrantSessions());
  }

  private static readonly GRANT_KEY_REMOVAL_RETRY_DELAYS_MS = [100, 400];

  private static async withGrantKeyRemovalRetry(remove: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await remove();
        return;
      } catch (error) {
        const delay = this.GRANT_KEY_REMOVAL_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw error;
        Logger.warn('Grant key removal failed; retrying', { attempt: attempt + 1 });
        await sleep(delay);
      }
    }
  }

  static startDirectSignInFlow(): TGenerateAuthTokenFlowResult {
    return HomeserverService.generateAuthTokenFlow(RING_COOKIE_CAPABILITIES);
  }

  /**
   * The approval-flow wait bounded by the marketplace session-flow timeout.
   * Lives on the Application so controllers never call the service directly.
   */
  static async withAuthFlowTimeout<T>(pending: Promise<T>, cancelFlow: () => void): Promise<T> {
    return await MarketplaceSessionService.withFlowTimeout(pending, cancelFlow);
  }

  /**
   * Homeserver first, marketplace second. Token bytes live only for this call.
   *
   * A marketplace failure is NOT a sign-in failure (single-approval.md §4.3
   * rows 4–5): the homeserver session stands and the caller gets
   * `marketplace: null` plus a no-excerpt `marketplaceError`, so commerce
   * surfaces can offer a separate reconnect approval instead of throwing away
   * a valid session.
   */
  static async completeSingleApprovalCeremony(
    token: AuthToken,
    hooks?: TSingleApprovalCeremonyHooks,
  ): Promise<TSingleApprovalResult> {
    const bytes = token.toBytes();
    const pubky = token.publicKey.z32();
    const tokenResolvedAtMs = Date.now();
    const session = await HomeserverService.signInWithFullGrantAuthToken(bytes);
    // The bridged ceremony swaps the auth-store session here, while the
    // widened cookie and the store cannot drift apart (a failure after the
    // marketplace POST would otherwise leave the cookie wide and the store
    // narrow, and the next click would re-prompt for a grant already held).
    await hooks?.onHomeserverSession?.(session);
    let marketplace = null;
    let marketplaceError: TMarketplaceRedeemError | null = null;
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      try {
        marketplace = await MarketplaceSessionService.redeemAuthTokenAfterHomeserver(bytes, pubky, tokenResolvedAtMs);
      } catch (error) {
        marketplaceError = this.toMarketplaceRedeemError(error);
        Logger.warn('Marketplace session redemption failed after homeserver sign-in; the Shop session stands', {
          marketplaceError,
        });
      }
    }
    return { session, marketplace, marketplaceError };
  }

  /**
   * No-excerpt discipline for the marketplace half's failure: only
   * `statusCode` / `alreadyUsed` may cross this boundary, never body text.
   */
  private static toMarketplaceRedeemError(error: unknown): TMarketplaceRedeemError {
    if (!isAppError(error)) {
      return {};
    }
    const context = error.context ?? {};
    return {
      statusCode: typeof context.statusCode === 'number' ? context.statusCode : undefined,
      alreadyUsed: context.alreadyUsed === true ? true : undefined,
    };
  }

  /**
   * Generates a signup authentication URL for Pubky Ring App.
   * Decorates a standard auth URL with homeserver address and invite code metadata.
   *
   * @param inviteCode - The invite code for signup
   * @returns Authentication URL and approval promise
   */
  static async generateSignupAuthUrl(inviteCode: string): Promise<TGenerateAuthUrlResult> {
    return await HomeserverService.generateSignupAuthUrl({ inviteCode });
  }

  /**
   * Logs out a user from the system.
   *
   * @param params - The logout parameters
   * @param params.session - The authenticated Session
   * @returns Void
   */
  static async logout(data: THomeserverSessionResult) {
    await HomeserverService.logout(data);
  }

  /**
   * Generates a signup token for user registration.
   * @returns Promise resolving to the generated signup token
   */
  static async generateSignupToken() {
    return await HomeserverService.generateSignupToken();
  }

  /** Staging guard: reject keys whose PKARR homeserver does not match this deploy. */
  static async assertUserHomeserverAllowed({ publicKey }: THomeserverPublicKeyParams): Promise<void> {
    await HomeserverService.assertUserHomeserverAllowed({ publicKey });
  }

  /**
   * In the application, there are two signups to do.
   * 1. First the user has to register the user key in the homeserver, throw the inviation code
   * 2. Then the user has to create a profile.json file in the homeserver. That file acts as a proof that the user has signed up.
   * This is a critical step because after that it will start indexing all user related data
   *
   * @param params - Parameters containing the user's public key
   * @param params.pubky - The user's public key identifier
   * @returns Promise resolving to the user profile or undefined if not found
   */
  static async userIsSignedUp({ pubky }: { pubky: Pubky }): Promise<boolean> {
    try {
      await HomeserverService.request({ method: HttpMethod.GET, url: userUriBuilder(pubky) });
      return true;
    } catch (error) {
      const appError = isAppError(error) ? error : toAppError(error, ErrorService.Homeserver, 'userIsSignedUp');
      if (isNotFound(appError)) return false;
      throw appError;
    }
  }
}
