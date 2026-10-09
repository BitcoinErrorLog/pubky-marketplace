import type { Session, XCallbackParams } from '@synonymdev/pubky';
import { AuthApplication } from '@/application/auth/auth';
import type {
  TKeypairParams,
  TRestorePersistedSessionResult,
  TSingleApprovalResult,
} from '@/application/auth/auth.types';
import { BootstrapApplication, type BootstrapProgressCallback } from '@/application/bootstrap/bootstrap';
import { CommerceApplication } from '@/application/commerce/commerce';
import { FirstContactApplication } from '@/application/messaging/first-contact';
import { MessagingApplication } from '@/application/messaging/messaging';
import { SettingsApplication } from '@/application/settings/settings';
import { postStreamQueue } from '@/application/stream/posts/muting/post-stream-queue';
import { TagApplication } from '@/application/tag/tag';
import { isSingleApprovalSignInEnabled } from '@/config/app';
import type {
  TBridgedCommerceSessionFlow,
  TLoginWithEncryptedFileParams,
  TLoginWithMnemonicParams,
  TSignUpParams,
} from '@/controllers/auth/auth.types';
import { broadcastSignedOut, bumpAuthEpoch, readAuthEpoch, subscribeSignedOut } from '@/controllers/auth/auth-epoch';
import { withAuthFinalizationLock } from '@/controllers/auth/auth-finalization-lock';
import {
  captureAuthIdentityFromStore,
  type CapturedAuthIdentity,
  nonEmptyPubky,
  shouldAbortIdentityPersist,
  shouldSkipDestructiveCleanup,
} from '@/controllers/auth/auth-identity-guard';
import {
  clearGrantKeyCleanupPending,
  isGrantKeyCleanupPending,
  markGrantKeyCleanupPending,
} from '@/controllers/auth/grant-key-cleanup';
import { CommerceController } from '@/controllers/commerce/commerce';
import { NotificationCoordinator } from '@/coordinators/notifications/notifications';
import { StreamCoordinator } from '@/coordinators/streams/stream';
import { TtlCoordinator } from '@/coordinators/ttl/ttl';
import { clearDatabase, clearPrivateData } from '@/database/franky/franky.helpers';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { isWrongEnvironmentHomeserverError, toAppError } from '@/libs/error/error.utils';
import { Identity } from '@/libs/identity/identity';
import { Logger } from '@/libs/logger/logger';
import { clearMuteSyncCursorSessionStorage } from '@/libs/mute-sync/clear-cursor-session-storage';
import { clearAllQueryClients } from '@/libs/query-client/query-client.factory';
import { clearCookies, sleep } from '@/libs/utils/utils';
import { suppressVibeSessionAutoRestore } from '@/libs/vibe-session/auto-restore';
import { isVibeSessionConsumerEnabled } from '@/libs/vibe-session/config';
import type { Pubky } from '@/models/models.types';
import { NotificationNormalizer } from '@/pipes/notification/notification.normalizer';
import { PubkySpecsSingleton } from '@/pipes/pipes.builder';
import { SettingsNormalizer } from '@/pipes/settings/settings.normalizer';
import { clearRouteGuardReturnTo } from '@/providers/RouteGuardProvider/RouteGuardProvider.returnPath';
import { createCanceledError, isGrantKeyRemovalError } from '@/services/homeserver/error.utils';
import type { TGenerateAuthUrlResult, THomeserverSessionResult } from '@/services/homeserver/homeserver.types';
import type { MarketplaceSessionFlow } from '@/services/marketplace/marketplace-session';
import {
  clearPersistedAuthIdentity,
  hasPersistedAuthIdentity,
  readPersistedAuthIdentity,
  readPersistedGrantSessionRecordId,
} from '@/stores/auth/auth.persisted';
import { useAuthStore } from '@/stores/auth/auth.store';
import type { GrantSigner } from '@/stores/auth/auth.types';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { useHomeStore } from '@/stores/home/home.store';
import { useHotStore } from '@/stores/hot/hot.store';
import { useLocalFilesStore } from '@/stores/localFiles/localFiles.store';
import { useMessagingStore } from '@/stores/messaging/messaging.store';
import { useMigrationStore } from '@/stores/migration/migration.store';
import { useNotificationStore } from '@/stores/notification/notification.store';
import { useOnboardingStore } from '@/stores/onboarding/onboarding.store';
import { ONBOARDING_PERSIST_KEY } from '@/stores/persistedKeys';
import { useSearchStore } from '@/stores/search/search.store';
import { useSessionHandoffStore } from '@/stores/sessionHandoff/sessionHandoff.store';
import { useSettingsStore } from '@/stores/settings/settings.store';
import type { SettingsState } from '@/stores/settings/settings.types';
import { useSignInStore } from '@/stores/signIn/signIn.store';

export class AuthController {
  private constructor() {} // Prevent instantiation

  private static activeAuthFlow: { token: symbol; cancel: (() => void) | null } | null = null;

  /**
   * The Bitkit grant QR and the Pubky Passport button live beside the Ring QR
   * on /sign-in, so each grant signer has its own slot: starting one never
   * cancels another. A new flow for the same signer replaces its old one. All
   * are cancelled when any sign-in completes, on local-state cleanup, and on
   * cross-tab sign-out.
   */
  private static activeGrantFlows = new Map<GrantSigner, { token: symbol; cancel: (() => void) | null }>();

  /**
   * Bumped whenever every auth flow is cancelled. A grant approval that
   * settles after a bump lost to another sign-in (or a sign-out) and is
   * signed out instead of initialized.
   */
  private static authFlowGeneration = 0;

  /**
   * Covers QR wait AND both POSTs. wrapAuthFlow is not this lifetime: it
   * clears when awaitApproval/awaitToken settles, which is when the POSTs begin.
   *
   * ONE guard covers both ceremony kinds (direct sign-in / step-up and the
   * bridged first-commerce prompt): a getAuthUrl() arriving while a bridged
   * ceremony holds the POST window JOINS it instead of taking the default
   * clearDatabase entry path, and a second bridged dialog joins the in-flight
   * bridged flow instead of minting a second Ring prompt.
   */
  private static signInCeremony: {
    token: symbol;
    /** Sign-in view of the ceremony (what getAuthUrl / getStepUpAuthUrl join). */
    result: Promise<TGenerateAuthUrlResult>;
    /** Marketplace view — non-null only while a BRIDGED commerce ceremony holds the guard. */
    bridgedFlow: MarketplaceSessionFlow | null;
    /** Dual-POST outcome once the underlying flow has started (both kinds). */
    outcome: Promise<TSingleApprovalResult> | null;
  } | null = null;

  /**
   * Bumped synchronously at logout start, before any await. A restore that
   * began on an earlier generation (e.g. a RouteGuard-initiated restore
   * sharing the Application singleton promise with the logout's own restore)
   * must not run its restored-branch `init`: the logout owns finalization
   * now, and re-initing would re-persist the sessionExport of the identity
   * that was just logged out. A generation counter — not the suppression
   * marker — because a suppressed tab may still legitimately restore from a
   * pending `#s=` fragment, and that restore must init.
   */
  private static logoutGeneration = 0;

  /** `authEpoch` read when each grant sign-in QR started, keyed by its approved session. */
  private static grantEpochAtStart = new WeakMap<Session, number>();

  /** `authFlowGeneration` when each sign-in QR (Ring or Bitkit) started, keyed by its approved session. */
  private static sessionFlowGeneration = new WeakMap<Session, number>();
  /** The signer whose grant ceremony produced a session, saved with its grant record. */
  private static grantSignerBySession = new WeakMap<Session, GrantSigner>();

  /** Resolver of the `#s=` hand-off prompt the user has not answered yet. */
  private static pendingSessionHandoff: ((accepted: boolean) => void) | null = null;

  private static async confirmSessionHandoff(pubky: Pubky): Promise<boolean> {
    this.pendingSessionHandoff?.(false);
    return await new Promise<boolean>((resolve) => {
      this.pendingSessionHandoff = resolve;
      useSessionHandoffStore.getState().setPendingPubky(pubky);
    });
  }

  /** The user's answer to the `#s=` hand-off prompt. Only `true` signs the tab in. */
  static answerSessionHandoff(accepted: boolean): void {
    const resolve = this.pendingSessionHandoff;
    this.pendingSessionHandoff = null;
    useSessionHandoffStore.getState().setPendingPubky(null);
    resolve?.(accepted);
  }

  /**
   * Single-run guard for cleanupLocalState: concurrent Controller invocations
   * (e.g. a logout racing an in-flight restore) share one run, and once a run
   * has completed further calls are no-ops until a session init marks local
   * state dirty again.
   */
  private static cleanupState: { promise: Promise<void> | null; completed: boolean } = {
    promise: null,
    completed: false,
  };

  /**
   * Identity snapshot for the in-flight sign-in/sign-up/QR ceremony that
   * already took (or skipped) origin-scoped Dexie. Subsequent persist must
   * abort if a different account now owns that database.
   */
  private static pendingLocalStateCapture: CapturedAuthIdentity | null = null;

  /** Test-only: reset the cleanupLocalState single-run guard. */
  static resetCleanupLocalStateGuard(): void {
    this.cleanupState = { promise: null, completed: false };
    this.pendingLocalStateCapture = null;
  }

  private static captureAuthIdentity(): CapturedAuthIdentity {
    return captureAuthIdentityFromStore(useAuthStore.getState(), hasPersistedAuthIdentity());
  }

  /** Test-only: reset the single-approval ceremony join token (both ceremony kinds). */
  static resetSignInCeremonyGuard(): void {
    this.signInCeremony = null;
  }

  /**
   * Releases a hook-held auth flow. When the flow is still the
   * controller-tracked active flow, the whole active flow AND ceremony guard
   * are torn down, so a retry mints a FRESH single-use URL instead of joining
   * the cancelled ceremony and re-showing its dead QR. When the flow was
   * already superseded (another start won the slot), only the hook's own
   * stale handle is freed — the live superseding flow is left untouched.
   */
  static releaseAuthFlow(cancelAuthFlow: () => void): void {
    if (this.activeAuthFlow && this.activeAuthFlow.cancel === cancelAuthFlow) {
      this.cancelActiveAuthFlow();
      return;
    }
    for (const [signer, flow] of this.activeGrantFlows) {
      if (flow.cancel === cancelAuthFlow) {
        this.cancelActiveGrantFlow(signer);
        return;
      }
    }
    cancelAuthFlow();
  }

  /**
   * Frees a LIVE flow from an earlier entry point (e.g. a signup page's
   * wrapAuthFlow QR) before a new ceremony takes over the slot — a stale QR
   * approved mid-ceremony would otherwise run a concurrent session init on
   * freshly-cleared local state. Unlike cancelActiveAuthFlow this never
   * touches the caller's just-created ceremony guard. (Both call sites reach
   * here only when no guard matches the prior flow: the bridged entry returns
   * early on ANY existing guard, and the direct ceremony has already swapped
   * in its new guard token before this runs.)
   */
  private static releasePriorAuthFlow(): void {
    const prior = this.activeAuthFlow;
    if (!prior) return;
    this.activeAuthFlow = null;
    prior.cancel?.();
  }

  /** Local state is dirty again once a session is initialized into it. */
  private static markLocalStateDirty(): void {
    this.cleanupState.completed = false;
  }

  static cancelActiveAuthFlow() {
    const cancel = this.activeAuthFlow?.cancel;
    this.activeAuthFlow = null;
    this.signInCeremony = null;
    cancel?.();
  }

  private static cancelActiveGrantFlow(signer: GrantSigner) {
    const cancel = this.activeGrantFlows.get(signer)?.cancel;
    this.activeGrantFlows.delete(signer);
    cancel?.();
  }

  /** Ring, Bitkit and Passport flows alike: a completed sign-in or a sign-out ends all of them. */
  static cancelAllAuthFlows() {
    this.authFlowGeneration += 1;
    this.cancelActiveAuthFlow();
    for (const signer of [...this.activeGrantFlows.keys()]) this.cancelActiveGrantFlow(signer);
  }

  /** A QR approval whose flow started before the latest cancelAllAuthFlows lost to another sign-in or a sign-out. */
  private static lostToAnotherSignIn(session: Session): boolean {
    const startedAt = this.sessionFlowGeneration.get(session);
    return startedAt !== undefined && startedAt !== this.authFlowGeneration;
  }

  /**
   * First approval wins. The losing session is signed out and never
   * initialized; a losing Ring completion also drops the marketplace bearer
   * its dual POST minted (a grant approval mints none, so a losing Bitkit
   * approval never touches the winner's bearer). The winner's session and
   * grant record are left alone.
   */
  private static async discardLosingApproval(session: Session): Promise<never> {
    if (!AuthApplication.isGrantSession(session)) {
      CommerceController.clearMarketplaceSession();
    }
    await AuthApplication.logout({ session }).catch(() => {
      Logger.warn('Failed to sign out an approval that lost to another sign-in');
    });
    throw createCanceledError();
  }

  /**
   * Restores a persisted session from the auth store.
   * @returns Discriminated restore outcome for callers (logout vs route restore)
   * @throws Wrong-environment homeserver errors after local cleanup so UI can show feedback
   */
  static async restorePersistedSession(): Promise<TRestorePersistedSessionResult> {
    const authStore = useAuthStore.getState();
    // Captured before any await: a concurrent different-account sign-in must
    // be compared again inside the finalization lock (not as a stale boolean).
    const captured = this.captureAuthIdentity();
    // Captured before any await so a logout that starts while the shared
    // Application restore is in flight invalidates this invocation's
    // restored-branch finalization (compared again right before `init`).
    const logoutGenerationAtStart = this.logoutGeneration;
    // Captured before cleanup can reset the store: a restored grant session
    // keeps its BrowserSessionStore record (restore never saves).
    const restoredGrantRecordId = authStore.grantSessionRecordId;
    const restoredGrantSigner = authStore.grantSigner;
    // The Controller owns the restore loading flag for the whole flow: set once
    // before restore begins, cleared once after finalization. With a fresh-vibe
    // bridge restore (sessionExport === null) the isSessionRestorePending
    // backstop in useAuthStatus does not apply, so no intermediate owner may
    // leave a window where the flag reads false between restore start and init.
    authStore.setIsRestoringSession(true);
    let cleanedUp = false;
    try {
      const result = await AuthApplication.restorePersistedSession({
        authStore,
        confirmSessionHandoff: (pubky) => this.confirmSessionHandoff(pubky),
      });
      if (result.status === 'restored') {
        const { session } = result;
        const pubky = Identity.z32FromSession({ session });
        const persistedPubky = authStore.currentUserPubky;
        const sameIdentity = persistedPubky != null && persistedPubky === pubky;

        // Fresh vibe (no persisted identity) or a different pubky must not inherit
        // the previous account's hasProfile flag or IndexedDB/store snapshot.
        // isRestoringSession is already held by this method and survives the
        // auth-store reset inside cleanup, so useAuthStatus keeps loading.
        if (!sameIdentity) {
          await this.finalizeSignedOutUnderLock({
            captured,
            preservePublicCache: false,
          });
          cleanedUp = true;
        }

        const hasProfile = sameIdentity ? authStore.hasProfile : await AuthApplication.userIsSignedUp({ pubky });
        // A logout began while the shared restore was in flight: the logout
        // owns finalization now. Bail out as signed-out — never re-init the
        // just-logged-out identity (that would re-persist its sessionExport
        // and clear logout suppression inside `init`). Any cleanup this
        // invocation already ran is deduplicated by the single-run guard.
        if (this.logoutGeneration !== logoutGenerationAtStart) {
          return { status: 'signed-out' };
        }
        // The identity persist takes the finalization lock: a concurrent
        // visitor tab's no-identity cleanup re-reads identity INSIDE the
        // lock, so it either observes this persist (and skips its wipe) or
        // wiped before it (nothing of this identity existed yet).
        const persisted = await this.persistIdentityUnderLock(pubky, captured, () => {
          useAuthStore.getState().init({
            session,
            currentUserPubky: pubky,
            hasProfile,
            ...(AuthApplication.isGrantSession(session) && restoredGrantRecordId
              ? { grantSessionRecordId: restoredGrantRecordId, grantSigner: restoredGrantSigner }
              : {}),
          });
        });
        if (!persisted) {
          return { status: 'signed-out' };
        }
        // The marketplace bearer session survives reloads in localStorage,
        // scoped to the account whose app session was just restored; anything
        // persisted for another account is dropped inside the restore.
        const marketplaceSession = CommerceApplication.restoreMarketplaceSession(pubky);
        if (marketplaceSession) {
          CommerceController.writeMarketplaceSessionStore(marketplaceSession);
        }
        const inventorySession = CommerceApplication.restoreInventorySession(pubky);
        if (inventorySession) {
          CommerceController.writeInventorySessionStore(inventorySession);
        }
        return { status: 'restored' };
      }
      if (result.status === 'deferred') {
        authStore.setSessionRestoreDeferred(true);
        return { status: 'deferred' };
      }
      await this.finalizeSignedOutUnderLock({
        captured,
        preservePublicCache: !captured.hadIdentity,
      });
      cleanedUp = true;
      return { status: 'signed-out' };
    } catch (error) {
      if (isGrantKeyRemovalError(error)) {
        // The grant record and its key are still stored: keep the pointer so
        // the next restore or sign-out retries the removal. Not signed-out.
        Logger.error('Grant session key could not be removed; keeping its record for a retry', { error });
        authStore.setSessionRestoreDeferred(true);
        return { status: 'deferred' };
      }
      const appError = toAppError(error, ErrorService.Local, 'restorePersistedSession');
      if (!cleanedUp) {
        await this.finalizeSignedOutUnderLock({
          captured,
          preservePublicCache: !captured.hadIdentity,
        });
      }
      if (isWrongEnvironmentHomeserverError(appError)) {
        throw appError;
      }
      return { status: 'signed-out' };
    } finally {
      useAuthStore.getState().setIsRestoringSession(false);
    }
  }

  /**
   * Gets a homeserver service instance using the secret key from the onboarding store.
   * @param params - The authentication parameters
   * @param params.keypair - The cryptographic keypair for the user
   * @returns Configured homeserver service instance
   */
  private static async signIn({ keypair }: TKeypairParams): Promise<boolean> {
    BootstrapApplication.cancelModerationFollow();
    // Clear query clients to ensure no stale cache from previous session
    clearAllQueryClients();
    const captured = this.captureAuthIdentity();
    if (!(await this.takeLocalStateForCapturedIdentity(captured))) {
      return false;
    }
    const session = await AuthApplication.signIn({ keypair });
    if (!session) {
      // Never log the keypair (it carries the identity secret) — the public key only.
      Logger.error('Failed to sign in. Please try again.', { pubky: keypair.publicKey.z32() });
      return false;
    }
    // Environment guard already ran inside HomeserverService.signIn (before the
    // session was created), so go straight to shared initialization.
    await this.completeAuthenticatedSession(session);
    return true;
  }

  /**
   * Bootstrap data to initialize the application snapshot.
   * @param params - Object containing session and pubky data from authentication
   * @param params.session - The user session data
   * @param params.pubky - The user's public key identifier
   */
  private static async hydrateMeImAlive({ pubky }: { pubky: Pubky }) {
    const signInStore = useSignInStore.getState();
    const {
      meta: { url },
    } = NotificationNormalizer.to(pubky);

    // Progress callback to update signInStore from Controller layer (respecting architecture rules)
    const onProgress: BootstrapProgressCallback = (step) => {
      switch (step) {
        case 'bootstrapFetched':
          signInStore.setBootstrapFetched(true); // Step 3 complete (60%)
          break;
        case 'dataPersisted':
          signInStore.setDataPersisted(true); // Step 4 complete (80%)
          break;
        case 'homeserverSynced':
          signInStore.setHomeserverSynced(true); // Step 5 complete (100%)
          break;
      }
    };

    const localSettings = SettingsNormalizer.extractState(useSettingsStore.getState());

    // Sync settings from homeserver before bootstrap; errors are logged and fall back to local settings.
    const remoteSettings = await this.syncSettings(pubky, localSettings);

    // Resolve final preferences: remote settings win if available, otherwise use local
    const preferences = (remoteSettings ?? localSettings).notifications;
    const allowedTypes = NotificationNormalizer.toEnabledTypes(preferences);

    const notification = await BootstrapApplication.initialize({ pubky, lastReadUrl: url, allowedTypes }, onProgress);
    useNotificationStore.getState().setState(notification);

    // Pull the private cross-device watchlist and merge it into local state.
    // Fire-and-forget: sign-in must not block on it, and a failed round
    // leaves the outbox job pending to heal on the next marketplace visit.
    void CommerceController.syncWatchlist().catch((error) => {
      Logger.warn('Watchlist sync after bootstrap failed; it will retry on the next marketplace visit', { error });
    });

    // Apply remote settings to store (store mutation stays in Controller layer)
    if (remoteSettings) {
      useSettingsStore.getState().loadFromHomeserver(remoteSettings);
      Logger.info('Settings loaded from homeserver', { pubky });
    }
  }

  /**
   * In-flight session init, keyed by Session object identity. Every joiner of
   * one ceremony (a StrictMode double-effect, a remount) receives the same
   * awaitApproval settlement and must not run the store reset + bootstrap
   * twice: a second call for the SAME Session joins the first instead.
   */
  private static sessionInitInFlight: { session: Session; promise: Promise<void> } | null = null;

  /**
   * Initializes the authenticated session and checks if the user is signed up (profile.json in homeserver).
   *
   * Runs the staging environment guard first: the session was approved externally
   * (e.g. Pubky Ring), so this is its only checkpoint. Keypair flows skip the
   * guard here — HomeserverService.signIn already ran it before creating the
   * session, and re-asserting would duplicate the PKARR lookup and let a
   * transient second lookup abort an already-verified sign-in.
   * @param params - Object containing session data from authentication
   * @param params.session - The user session data
   */
  static async initializeAuthenticatedSession({ session }: THomeserverSessionResult) {
    const inFlight = this.sessionInitInFlight;
    if (inFlight && inFlight.session === session) {
      return await inFlight.promise;
    }
    const promise = this.runInitializeAuthenticatedSession({ session });
    this.sessionInitInFlight = { session, promise };
    // Joiners observe the real rejection through their own await; the stored
    // branch must never surface as an unhandled rejection.
    promise.catch(() => {});
    try {
      await promise;
    } finally {
      if (this.sessionInitInFlight?.promise === promise) {
        this.sessionInitInFlight = null;
      }
    }
  }

  private static async runInitializeAuthenticatedSession({ session }: THomeserverSessionResult) {
    if (this.lostToAnotherSignIn(session)) {
      return await this.discardLosingApproval(session);
    }
    try {
      try {
        const environmentCheckStartedAt = Date.now();
        await AuthApplication.assertUserHomeserverAllowed({ publicKey: session.info.publicKey });
        Logger.debug('Sign-in environment check completed', { elapsedMs: Date.now() - environmentCheckStartedAt });
      } catch (error) {
        // The just-approved session lives on the user's actual homeserver — sign it
        // out instead of leaving it dangling, whether the key was rejected or the
        // lookup failed. Best-effort: the failure must surface regardless.
        await AuthApplication.logout({ session }).catch((logoutError) => {
          Logger.warn('Failed to sign out session after environment check failure', { logoutError });
        });
        throw error;
      }
      await this.completeAuthenticatedSession({ session });
    } catch (error) {
      // A completion that lost to another sign-in was already cleaned up by
      // discardLosingApproval; the bearer at rest now belongs to the winner.
      if (this.lostToAnotherSignIn(session)) throw error;
      // The marketplace half of the ceremony may already have minted (and
      // persisted) a bearer for this approval; a sign-in that does NOT commit
      // — refused by the environment check OR failed anywhere in the
      // post-mint bootstrap — must not leave that bearer at rest.
      CommerceController.clearMarketplaceSession();
      useSignInStore.getState().reset();
      throw error;
    }
  }

  /**
   * Session initialization shared by all sign-in flows; assumes the environment
   * guard already passed for this session.
   */
  private static async completeAuthenticatedSession({ session }: THomeserverSessionResult) {
    // Checked and claimed with no await in between: of two approvals that both
    // reach here, the first bumps the generation (cancelAllAuthFlows below)
    // and the second is discarded before it can touch any store.
    if (this.lostToAnotherSignIn(session)) {
      return await this.discardLosingApproval(session);
    }
    const signInStore = useSignInStore.getState();
    signInStore.reset(); // Reset for fresh sign-in
    signInStore.setAuthUrlResolved(true); // Step 1 complete (20%)

    const authStore = useAuthStore.getState();
    let persistAborted = false;
    let grantSaveError: unknown = null;

    try {
      this.cancelAllAuthFlows();
      // This approval won; only the approvals it just cancelled count as lost.
      this.sessionFlowGeneration.delete(session);
      const pubky = Identity.z32FromSession({ session });

      // Identity persist takes the finalization lock so a visitor tab's
      // no-identity cleanup (which re-reads identity INSIDE the lock) either
      // observes this persist and skips its wipe, or wiped before it. The
      // network bootstrap below stays OUTSIDE the lock; the residual window
      // is closed by that same re-read — any later no-identity cleanup sees
      // the persisted identity and skips. A different account that signed in
      // after this ceremony captured local state aborts persist rather than
      // overwriting that account's Dexie rows.
      const persisted = await this.persistIdentityUnderLock(pubky, this.pendingLocalStateCapture, async () => {
        let grantSessionRecordId: string | null = null;
        if (AuthApplication.isGrantSession(session)) {
          // Inside the finalization lock: a sign-out since this QR started
          // (any tab) bumped the epoch, and the key must not be saved back.
          const epochAtStart = this.grantEpochAtStart.get(session);
          if (epochAtStart === undefined || epochAtStart !== readAuthEpoch()) {
            return false;
          }
          // Recorded before the save: a save that fails, or a tab that closes
          // mid-save, leaves an obligation the next load can discharge.
          const cleanupAlreadyPending = isGrantKeyCleanupPending();
          markGrantKeyCleanupPending();
          try {
            grantSessionRecordId = await AuthApplication.saveGrantSession(session);
          } catch (error) {
            grantSaveError = error;
            return false;
          }
          authStore.init({
            session,
            currentUserPubky: pubky,
            hasProfile: null,
            grantSessionRecordId,
            grantSigner: this.grantSignerBySession.get(session) ?? 'bitkit',
          });
          if (!cleanupAlreadyPending) clearGrantKeyCleanupPending();
          return true;
        }
        authStore.init({ session, currentUserPubky: pubky, hasProfile: null });
        return true;
      });
      if (!persisted) {
        persistAborted = true;
        await AuthApplication.logout({ session }).catch((logoutError) => {
          Logger.warn('Failed to sign out a session that lost the local-state race', { logoutError });
        });
        if (grantSaveError !== null) {
          // A failed save can leave a partial record and this flow's delegated
          // key in IndexedDB. The grant is signed out above (that needs the
          // key), so the key goes now. Sign-out uses the same order. If the
          // removal fails too, the pending marker keeps the obligation.
          await this.settlePendingGrantKeyCleanup();
          throw grantSaveError;
        }
        throw createCanceledError();
      }

      const isSignedUp = await AuthApplication.userIsSignedUp({ pubky });
      signInStore.setProfileChecked(true); // Step 2 complete (40%)

      if (isSignedUp) {
        await this.hydrateMeImAlive({ pubky });
      }

      // Update hasProfile after bootstrap completes - triggers redirect via useAuthStatus
      authStore.setHasProfile(isSignedUp);
    } catch (error) {
      if (!persistAborted) {
        authStore.reset();
        signInStore.reset();
      }
      throw error;
    }
  }

  /**
   * Signs up a new user with the homeserver using the provided secret key and signup token.
   * @param params - Object containing secret key and signup token for registration
   * @param params.secretKey - The secret key for the user
   * @param params.signupToken - Invitation code for user registration
   */
  static async signUp({ secretKey, signupToken }: TSignUpParams) {
    BootstrapApplication.cancelModerationFollow();
    // Clear query clients to ensure no stale cache from previous session
    clearAllQueryClients();
    const captured = this.captureAuthIdentity();
    if (!(await this.takeLocalStateForCapturedIdentity(captured))) {
      throw createCanceledError();
    }
    const keypair = Identity.keypairFromSecretKey(secretKey);
    const { session } = await AuthApplication.signUp({ keypair, signupToken });
    const authStore = useAuthStore.getState();
    const pubky = Identity.z32FromSession({ session });
    const persisted = await this.persistIdentityUnderLock(pubky, captured, () => {
      authStore.init({ session, currentUserPubky: pubky, hasProfile: false });
    });
    if (!persisted) {
      await AuthApplication.logout({ session }).catch((logoutError) => {
        Logger.warn('Failed to sign out a signup session that lost the local-state race', { logoutError });
      });
      throw createCanceledError();
    }
  }

  /**
   * Authenticates the keypair with the homeserver and saves the authenticated data if successful.
   * @param params - Object containing the mnemonic phrase for key derivation
   * @param params.mnemonic - The mnemonic phrase for key derivation
   * @returns Promise resolving to true if authentication succeeded, false otherwise
   */
  static async loginWithMnemonic({ mnemonic }: TLoginWithMnemonicParams): Promise<boolean> {
    const keypair = Identity.keypairFromMnemonic(mnemonic);
    return await this.signIn({ keypair });
  }

  /**
   * Decrypts the file to obtain the keypair, authenticates with the homeserver, and saves authenticated data if successful.
   * @param params - Object containing the encrypted file and password for decryption
   * @param params.encryptedFile - The encrypted recovery file
   * @param params.password - The password to decrypt the recovery file
   * @returns Promise resolving to true if authentication succeeded, false otherwise
   */
  static async loginWithEncryptedFile({ encryptedFile, password }: TLoginWithEncryptedFileParams): Promise<boolean> {
    const keypair = await Identity.decryptRecoveryFile({ encryptedFile, passphrase: password });
    return await this.signIn({ keypair });
  }

  /**
   * Wraps auth URL generation with flow tracking so useAuthUrl can cancel on unmount
   * and we detect stale requests (e.g. React StrictMode double-mount).
   * @param generateFn - Async function that returns the auth URL result
   * @param options.preserveLocalState - Step-up re-approval only: the identity is
   * unchanged and only the homeserver grant widens, so local state (Dexie, migration
   * cursors) must NOT be wiped the way a fresh sign-in requires.
   * @returns Promise resolving to the generated authentication URL with wrapped approval
   */
  private static async wrapAuthFlow(
    generateFn: () => Promise<TGenerateAuthUrlResult>,
    { preserveLocalState = false }: { preserveLocalState?: boolean } = {},
  ): Promise<TGenerateAuthUrlResult> {
    BootstrapApplication.cancelModerationFollow();
    if (!preserveLocalState) {
      const captured = this.captureAuthIdentity();
      if (!(await this.takeLocalStateForCapturedIdentity(captured))) {
        throw createCanceledError();
      }
    }
    const token = Symbol('auth-flow');
    this.cancelActiveAuthFlow();
    this.activeAuthFlow = { token, cancel: null };
    const { authorizationUrl, awaitApproval, cancelAuthFlow } = await generateFn();

    if (!this.activeAuthFlow || this.activeAuthFlow.token !== token) {
      cancelAuthFlow();
      return { authorizationUrl, awaitApproval, cancelAuthFlow };
    }

    this.activeAuthFlow.cancel = cancelAuthFlow;

    const wrappedAwaitApproval = awaitApproval.finally(() => {
      if (this.activeAuthFlow?.token === token) {
        this.activeAuthFlow = null;
      }
      cancelAuthFlow();
    });

    return { authorizationUrl, awaitApproval: wrappedAwaitApproval, cancelAuthFlow };
  }

  /**
   * Destructive restore finalization, serialized across tabs (and against
   * same-tab sign-in completion) by the auth finalization lock
   * (`navigator.locks` name `pubky-auth-finalization-v1` is origin-scoped and
   * cross-tab; the in-process tail is only the no-Web-Locks fallback).
   *
   * The identity snapshot is re-read INSIDE the lock from `AUTH_PERSIST_KEY`
   * (cross-tab source of truth; Zustand is per-tab and is not storage-event
   * synced) and from the live store (same-tab QR). Cleanup is keyed to the
   * identity captured at restore start: a different persist-blob or live pubky
   * means that sign-in now owns origin-scoped Dexie, so this wipe no-ops. An
   * identity that was absent at capture time means a sign-in now owns the
   * private data: skip cleanup entirely and let the caller return signed-out.
   * Wiping here would erase that sign-in's private rows and the messaging
   * wrapping key, making its wrapped messaging state unrecoverable.
   *
   * `preservePublicCache` keeps the shared public browsing cache (catalog,
   * counts, TTLs): the no-identity path exists to drop orphaned PRIVATE
   * data, not public browsing residue.
   */
  private static async finalizeSignedOutUnderLock({
    captured,
    preservePublicCache,
  }: {
    captured: CapturedAuthIdentity;
    preservePublicCache: boolean;
  }): Promise<void> {
    await withAuthFinalizationLock(async () => {
      if (shouldSkipDestructiveCleanup(captured, useAuthStore.getState(), readPersistedAuthIdentity())) {
        // A skipped logout must not pin the winning identity in the
        // logging-out state: `init` preserves `isLoggingOut`, and skip
        // does not run `reset`. This `set()` is not persisted when
        // `AUTH_PERSIST_KEY` already holds a different pubky (owner fence).
        useAuthStore.getState().setIsLoggingOut(false);
        return;
      }
      await this.cleanupLocalState({ preservePublicCache });
    });
  }

  /**
   * Capture is outside the lock; clear + owner check run inside it. Returns
   * false (and does not clear) when a different identity now owns Dexie.
   */
  private static async takeLocalStateForCapturedIdentity(captured: CapturedAuthIdentity): Promise<boolean> {
    return await withAuthFinalizationLock(async () => {
      if (shouldSkipDestructiveCleanup(captured, useAuthStore.getState(), readPersistedAuthIdentity())) {
        return false;
      }
      await clearDatabase();
      useMigrationStore.getState().reset();
      this.pendingLocalStateCapture = captured;
      return true;
    });
  }

  /**
   * Persist `newPubky` under the same lock that serializes cleanup. No-ops
   * (returns false) when `AUTH_PERSIST_KEY` or the live store already holds a
   * third identity.
   */
  private static async persistIdentityUnderLock(
    newPubky: string,
    captured: CapturedAuthIdentity | null,
    persist: () => void | boolean | Promise<boolean>,
  ): Promise<boolean> {
    return await withAuthFinalizationLock(async () => {
      const currentPubky = nonEmptyPubky(useAuthStore.getState().currentUserPubky);
      const persistedPubky = readPersistedAuthIdentity().pubky;
      if (shouldAbortIdentityPersist(captured, newPubky, currentPubky, persistedPubky)) {
        this.pendingLocalStateCapture = null;
        return false;
      }
      // Owner-guarded persist storage refuses A→B clobbers. A captured-identity
      // replace (same-tab switch) must drop the blob first so `init` can write.
      if (persistedPubky && persistedPubky !== newPubky) {
        clearPersistedAuthIdentity();
      }
      if ((await persist()) === false) {
        this.pendingLocalStateCapture = null;
        return false;
      }
      // A sign-in replacing another account skips the sign-out cleanup, so
      // the account that left must not keep a bearer at rest here.
      if ([captured?.pubky ?? null, currentPubky, persistedPubky].some((pubky) => pubky && pubky !== newPubky)) {
        CommerceController.clearMarketplaceSessionsOfOtherAccounts(newPubky);
        MessagingApplication.clearMessagingSessionsOfOtherAccounts(newPubky);
        FirstContactApplication.clearOtherAccounts(newPubky);
      }
      this.markLocalStateDirty();
      this.pendingLocalStateCapture = null;
      return true;
    });
  }

  /**
   * Centralizes all local state cleanup: resets every Zustand store, clears cookies,
   * IndexedDB, query cache, singletons, in-memory stream pagination queues, persisted localStorage keys,
   * and mute-sync `sessionStorage` cursors.
   * Used by both logout() and restorePersistedSession() on failure.
   *
   * With `preservePublicCache`, the SAME sequence runs but the database step
   * clears only private tables (`clearPrivateData`), keeping the shared
   * public catalog/browse cache — the no-identity restore path, where
   * orphaned private state must go but the marketplace grid's public rows
   * (and SSR→Dexie hydration) must survive. No step in the sequence touches
   * public-cache Dexie tables other than the database step itself.
   */
  private static async cleanupLocalState({
    preservePublicCache = false,
  }: { preservePublicCache?: boolean } = {}): Promise<void> {
    if (this.cleanupState.promise) {
      return await this.cleanupState.promise;
    }
    if (this.cleanupState.completed) {
      return;
    }
    this.cleanupState.promise = this.runCleanupLocalState({ preservePublicCache }).finally(() => {
      this.cleanupState.promise = null;
    });
    await this.cleanupState.promise;
    this.cleanupState.completed = true;
  }

  private static async runCleanupLocalState({ preservePublicCache }: { preservePublicCache: boolean }) {
    BootstrapApplication.cancelModerationFollow();
    // Capture pubky before resetting auth store; used to scope marker cleanup.
    const pubky = useAuthStore.getState().currentUserPubky;
    if (pubky) {
      TagApplication.clearViewerMarkers(pubky);
    }

    // Mute-list SSE cursors live in sessionStorage; clear before the next account might reuse the same tab.
    clearMuteSyncCursorSessionStorage();
    // A stored post-sign-in return path belongs to the signed-out identity.
    clearRouteGuardReturnTo();

    // Reset singletons
    PubkySpecsSingleton.reset();
    // No marketplace bearer may stay at rest for the user who is leaving.
    CommerceController.clearMarketplaceSessionForSignOut();
    // Same rule for the encrypted-messaging homeserver session and its live link handles.
    MessagingApplication.clearMessagingSession();
    // The mute list, known contacts and message counters belong to the signed-out identity.
    FirstContactApplication.clear();
    useMessagingStore.getState().clearMessagingEnabled();
    TtlCoordinator.resetInstance();
    StreamCoordinator.resetInstance();
    NotificationCoordinator.resetInstance();

    // Clear in-memory feed stream queues
    postStreamQueue.clear();

    this.cancelAllAuthFlows();

    // Cancel and clear all query clients (nexus, homegate, exchangerate, and any future ones)
    clearAllQueryClients();

    // Reset all Zustand stores.
    useOnboardingStore.getState().reset();
    // reset() rewrites the onboarding persist blob with nulled secrets; remove
    // the key outright so no onboarding residue (secret key, mnemonic, invite
    // code) survives at rest on a shared device.
    try {
      globalThis.localStorage?.removeItem(ONBOARDING_PERSIST_KEY);
    } catch {
      // Storage unavailable (private mode) — nothing could have persisted.
    }
    useAuthStore.getState().reset();
    useSignInStore.getState().reset();
    useLocalFilesStore.getState().reset();
    useCommerceStore.getState().reset();
    useHomeStore.getState().reset();
    useHotStore.getState().reset();
    useSearchStore.getState().reset();
    useNotificationStore.getState().reset();
    useSettingsStore.getState().reset();

    // Clear cookies (also drops any stale `locale` cookie from the removed language selection)
    clearCookies();

    // The only step that differs between a full sign-out wipe and the
    // no-identity restore path: the latter keeps the public browse cache.
    if (preservePublicCache) {
      await clearPrivateData();
    } else {
      await clearDatabase();
    }
    // Skip post-migration resync — full cleanup resets all state
    useMigrationStore.getState().reset();
  }

  /**
   * Generates an authentication URL for external authentication flows.
   * @returns Promise resolving to the generated authentication URL
   */
  static async getAuthUrl(): Promise<TGenerateAuthUrlResult> {
    if (!isSingleApprovalSignInEnabled()) {
      return this.wrapAuthFlow(() => AuthApplication.generateAuthUrl());
    }
    return this.wrapDirectSignInCeremony({ preserveLocalState: false });
  }

  /**
   * Bitkit sign-in: a grant QR (`pubkyauth://signin_grant`) beside the Ring
   * cookie QR, in its own slot so both stay scannable. The approved grant
   * session skips the marketplace redeem (it carries no AuthToken) and is
   * saved to BrowserSessionStore at completion.
   */
  static async getGrantAuthUrl(options?: { withPrivKeys?: boolean }): Promise<TGenerateAuthUrlResult> {
    return await this.beginGrantCeremony(
      () =>
        options === undefined
          ? AuthApplication.generateGrantAuthUrl()
          : AuthApplication.generateGrantAuthUrl(undefined, options),
      'bitkit',
    );
  }

  /**
   * Pubky Passport sign-in ("Continue with Google"): the same Shop grant as
   * Bitkit, approved in the Passport popup. `xCallback` names the Shop's
   * Passport return page. Completion is the Bitkit grant ceremony; the
   * session is recorded as Passport-approved so its purchase grant is
   * requested from Passport too.
   */
  static async getPassportGrantAuthUrl(
    xCallback?: XCallbackParams,
    options?: { withPrivKeys?: boolean },
  ): Promise<TGenerateAuthUrlResult> {
    return await this.beginGrantCeremony(
      () =>
        options === undefined
          ? AuthApplication.generateGrantAuthUrl(xCallback)
          : AuthApplication.generateGrantAuthUrl(xCallback, options),
      'passport',
    );
  }

  private static async beginGrantCeremony(
    generate: () => Promise<TGenerateAuthUrlResult>,
    signer: GrantSigner,
  ): Promise<TGenerateAuthUrlResult> {
    // Before the new flow creates its key: the cleanup removes every key.
    await this.settlePendingGrantKeyCleanup();
    const epochAtStart = readAuthEpoch();
    BootstrapApplication.cancelModerationFollow();
    const captured = this.captureAuthIdentity();
    if (!(await this.takeLocalStateForCapturedIdentity(captured))) {
      throw createCanceledError();
    }
    const token = Symbol('grant-flow');
    this.cancelActiveGrantFlow(signer);
    this.activeGrantFlows.set(signer, { token, cancel: null });
    const generationAtStart = this.authFlowGeneration;
    const { authorizationUrl, awaitApproval, cancelAuthFlow } = await generate();

    const slot = this.activeGrantFlows.get(signer);
    if (!slot || slot.token !== token) {
      cancelAuthFlow();
      return { authorizationUrl, awaitApproval, cancelAuthFlow };
    }
    slot.cancel = cancelAuthFlow;

    const wrappedAwaitApproval = awaitApproval
      .finally(() => {
        if (this.activeGrantFlows.get(signer)?.token === token) {
          this.activeGrantFlows.delete(signer);
        }
        cancelAuthFlow();
      })
      .then(async (session) => {
        this.sessionFlowGeneration.set(session, generationAtStart);
        if (this.lostToAnotherSignIn(session)) {
          return await this.discardLosingApproval(session);
        }
        await AuthApplication.assertFullGrantSession(session);
        this.grantEpochAtStart.set(session, epochAtStart);
        this.grantSignerBySession.set(session, signer);
        return session;
      });

    return { authorizationUrl, awaitApproval: wrappedAwaitApproval, cancelAuthFlow };
  }

  static isGrantSignInAvailable(): boolean {
    return AuthApplication.isGrantSignInAvailable();
  }

  static async getStepUpAuthUrl(): Promise<TGenerateAuthUrlResult> {
    // A grant session already holds the full Shop grant (checked at sign-in
    // and restore), and a Ring step-up would swap it for a cookie session
    // while its grant record stays stored. Refused here so every caller is
    // covered even if a new grant path skips those checks.
    if (AuthApplication.isGrantSession(useAuthStore.getState().session)) {
      throw Err.auth(
        AuthErrorCode.UNAUTHORIZED,
        'This sign-in already includes every Shop permission. If this keeps asking, sign out and sign in again.',
        { service: ErrorService.Local, operation: 'getStepUpAuthUrl' },
      );
    }
    if (!isSingleApprovalSignInEnabled()) {
      return this.wrapAuthFlow(() => AuthApplication.generateAuthUrl(), { preserveLocalState: true });
    }
    return this.wrapDirectSignInCeremony({ preserveLocalState: true });
  }

  /**
   * Bridged first-commerce prompt: one CAPABILITIES approval, same dual POST.
   * Never auto-started. Does not wipe local state.
   *
   * Holds the SAME single-flight guard as the sign-in ceremony: a second call
   * while one is in flight (two mounted dialogs, a remount) JOINS it — same
   * authorization URL, one Ring prompt — and a getAuthUrl() arriving during
   * its POST window joins the sign-in view instead of running clearDatabase
   * mid-ceremony.
   */
  static beginBridgedCommerceSessionFlow(): TBridgedCommerceSessionFlow {
    const existing = this.signInCeremony;
    if (existing) {
      if (existing.bridgedFlow) {
        // Join with a DISTINCT handle: its cancel is a no-op so the joining
        // dialog's close can never tear down the ceremony the owning dialog
        // still waits on (releaseAuthFlow matches only the owner's handle).
        return {
          authorizationUrl: existing.bridgedFlow.authorizationUrl,
          awaitSession: existing.bridgedFlow.awaitSession,
          cancel: () => {},
        };
      }
      // A DIRECT sign-in ceremony is in flight: its dual POST already redeems
      // the marketplace session, so join that outcome instead of minting a
      // second flow. Closing this dialog must not cancel the user's sign-in,
      // hence the no-op cancel. The ceremony's URL is not exposed here (the
      // sign-in surface owns it), so the handle is marked `joined` and the
      // hook shows an honest "approval already in progress" state instead of
      // a blank, un-scannable QR.
      const entry = existing;
      return {
        authorizationUrl: '',
        joined: true,
        awaitSession: async () => {
          const outcome = entry.outcome ?? (await entry.result.then(() => entry.outcome));
          if (!outcome) {
            throw createCanceledError();
          }
          const { marketplace } = await outcome;
          if (!marketplace) {
            throw Err.auth(
              AuthErrorCode.INVALID_TOKEN,
              'The marketplace service did not issue a session. Approve again to reconnect.',
              { service: ErrorService.Marketplace, operation: 'beginBridgedCommerceSessionFlow' },
            );
          }
          return marketplace;
        },
        cancel: () => {},
      };
    }

    const token = Symbol('bridged-commerce-ceremony');
    this.releasePriorAuthFlow();
    const flow = AuthApplication.startDirectSignInFlow();
    this.activeAuthFlow = { token, cancel: flow.cancelAuthFlow };

    const outcome: Promise<TSingleApprovalResult> = (async () => {
      const authToken = await AuthApplication.withAuthFlowTimeout(flow.awaitToken(), flow.cancelAuthFlow);
      return await AuthApplication.completeSingleApprovalCeremony(authToken, {
        // Swap the store session for the widened one BEFORE the marketplace
        // POST: if the marketplace half (or anything after it) fails, the
        // wide cookie and the store session never drift apart, so the next
        // click does not re-prompt for a grant the user already holds. The
        // ceremony's own settled-finally releases the flow.
        onHomeserverSession: async (session) => {
          await this.completeStepUpReauth({ session }, { releaseAuthFlow: false });
        },
      });
    })();
    // The stored outcome rejects for cancelled/failed ceremonies; joining
    // callers get the real rejection through their view — never as unhandled.
    outcome.catch(() => {});

    const settled = outcome.finally(() => {
      if (this.activeAuthFlow?.token === token) {
        this.activeAuthFlow = null;
      }
      if (this.signInCeremony?.token === token) {
        this.signInCeremony = null;
      }
      flow.cancelAuthFlow();
    });
    settled.catch(() => {});

    const marketplaceSession = settled.then(({ marketplace }) => {
      if (!marketplace) {
        throw Err.auth(
          AuthErrorCode.INVALID_TOKEN,
          'The marketplace service did not issue a session. Approve again to reconnect.',
          { service: ErrorService.Marketplace, operation: 'beginBridgedCommerceSessionFlow' },
        );
      }
      CommerceController.writeMarketplaceSessionStore(marketplace);
      return marketplace;
    });
    marketplaceSession.catch(() => {});

    const sessionView: TGenerateAuthUrlResult = {
      authorizationUrl: flow.authorizationUrl,
      awaitApproval: settled.then(({ session }) => session),
      cancelAuthFlow: flow.cancelAuthFlow,
    };
    const bridgedFlow: MarketplaceSessionFlow = {
      authorizationUrl: flow.authorizationUrl,
      awaitSession: () => marketplaceSession,
      cancel: flow.cancelAuthFlow,
    };
    this.signInCeremony = { token, result: Promise.resolve(sessionView), bridgedFlow, outcome: settled };
    return bridgedFlow;
  }

  private static wrapDirectSignInCeremony({
    preserveLocalState,
  }: {
    preserveLocalState: boolean;
  }): Promise<TGenerateAuthUrlResult> {
    if (this.signInCeremony) {
      // Joins a direct sign-in ceremony — or the sign-in view of an in-flight
      // BRIDGED commerce ceremony, whose POST window must never see the
      // default clearDatabase entry path. The joined handle gets a no-op
      // cancel: the surface that STARTED the ceremony owns its teardown, so a
      // joiner releasing its handle (dialog close, unmount) must not cancel
      // the flow out from under the owner (releaseAuthFlow matches only the
      // owner's tracked cancel).
      return this.signInCeremony.result.then((view) => ({ ...view, cancelAuthFlow: () => {} }));
    }
    const token = Symbol('sign-in-ceremony');
    const entry: NonNullable<(typeof AuthController)['signInCeremony']> = {
      token,
      result: undefined as unknown as Promise<TGenerateAuthUrlResult>,
      bridgedFlow: null,
      outcome: null,
    };
    this.signInCeremony = entry;
    entry.result = this.runDirectSignInCeremony(token, preserveLocalState);
    return entry.result;
  }

  private static async runDirectSignInCeremony(
    token: symbol,
    preserveLocalState: boolean,
  ): Promise<TGenerateAuthUrlResult> {
    try {
      BootstrapApplication.cancelModerationFollow();
      // Free a live QR from an earlier entry point (e.g. signup's wrapAuthFlow)
      // before this ceremony takes over the slot — a stale QR approved
      // mid-ceremony would otherwise run a concurrent session init on
      // freshly-cleared local state.
      this.releasePriorAuthFlow();
      if (!preserveLocalState) {
        const captured = this.captureAuthIdentity();
        if (!(await this.takeLocalStateForCapturedIdentity(captured))) {
          throw createCanceledError();
        }
      }
      if (!this.signInCeremony || this.signInCeremony.token !== token) {
        throw createCanceledError();
      }

      this.activeAuthFlow = { token, cancel: null };
      const generationAtStart = this.authFlowGeneration;
      const flow = AuthApplication.startDirectSignInFlow();
      if (!this.activeAuthFlow || this.activeAuthFlow.token !== token) {
        flow.cancelAuthFlow();
        throw createCanceledError();
      }
      this.activeAuthFlow.cancel = flow.cancelAuthFlow;

      const outcome: Promise<TSingleApprovalResult> = (async () => {
        const authToken = await AuthApplication.withAuthFlowTimeout(flow.awaitToken(), flow.cancelAuthFlow);
        if (
          !preserveLocalState &&
          this.signInCeremony?.token === token &&
          this.authFlowGeneration === generationAtStart
        ) {
          // Approval has arrived, but session exchanges and account checks still follow.
          // Show progress now instead of leaving the approved QR on screen.
          const signInStore = useSignInStore.getState();
          signInStore.reset();
          signInStore.setAuthUrlResolved(true);
        }
        // Step-up only (preserveLocalState): refuse a wrong-identity approval
        // INSIDE the ceremony, BEFORE the marketplace POST can mint (and
        // persist) a bearer for the other pubky — the same ordering the
        // bridged ceremony gets from its onHomeserverSession swap. A direct
        // sign-in changes identity by design, so it gets no gate.
        const result = preserveLocalState
          ? await AuthApplication.completeSingleApprovalCeremony(authToken, {
              onHomeserverSession: async (session) => this.assertStepUpSessionMatchesSignedInUser({ session }),
            })
          : await AuthApplication.completeSingleApprovalCeremony(authToken);
        if (!preserveLocalState) {
          // A Bitkit sign-in (or a sign-out) may have won while this
          // approval was inside its dual POST.
          this.sessionFlowGeneration.set(result.session, generationAtStart);
          if (this.lostToAnotherSignIn(result.session)) {
            return await this.discardLosingApproval(result.session);
          }
        }
        if (result.marketplace) {
          CommerceController.writeMarketplaceSessionStore(result.marketplace);
        }
        return result;
      })();
      // The stored outcome rejects for cancelled/failed ceremonies; joining
      // callers get the real rejection through awaitApproval — never as
      // unhandled.
      outcome.catch(() => {});
      if (this.signInCeremony?.token === token) {
        this.signInCeremony.outcome = outcome;
      }

      const awaitApproval = outcome
        .then(({ session }) => session)
        .catch((error: unknown) => {
          if (
            !preserveLocalState &&
            this.signInCeremony?.token === token &&
            this.authFlowGeneration === generationAtStart
          ) {
            useSignInStore.getState().reset();
          }
          throw error;
        })
        .finally(() => {
          if (this.activeAuthFlow?.token === token) {
            this.activeAuthFlow = null;
          }
          if (this.signInCeremony?.token === token) {
            this.signInCeremony = null;
          }
          flow.cancelAuthFlow();
        });
      // awaitApproval is created eagerly, before any caller can attach; an
      // abandoned ceremony must not leave an unhandled rejection behind.
      awaitApproval.catch(() => {});

      return { authorizationUrl: flow.authorizationUrl, awaitApproval, cancelAuthFlow: flow.cancelAuthFlow };
    } catch (error) {
      if (this.signInCeremony?.token === token) {
        this.signInCeremony = null;
      }
      if (this.activeAuthFlow?.token === token) {
        this.activeAuthFlow = null;
      }
      throw error;
    }
  }

  /**
   * Identity gate for an externally-approved session on the step-up path: the
   * approval must widen the SIGNED-IN identity, never silently switch
   * accounts. On mismatch the wrong-identity session is signed back out and
   * the call rejects.
   *
   * A resting marketplace bearer is dropped only when it belongs to an
   * identity OTHER than the signed-in one — a bearer must never stay at rest
   * for an identity this device is not signed in as. The signed-in user's own
   * bearer is never touched: this gate runs inside the step-up ceremony
   * BEFORE the marketplace POST (so no wrong-identity bearer can have been
   * minted yet), where the only bearer at rest is the signed-in user's own
   * still-valid approval, and a mistaken scan must not destroy it. The same
   * guard is correct at the second call site — completeStepUpReauth for the
   * hook-driven completion, which runs AFTER the ceremony outcome (i.e. after
   * any marketplace mint): a bearer resting there for a different pubky than
   * the current identity is still dropped.
   */
  private static async assertStepUpSessionMatchesSignedInUser({ session }: THomeserverSessionResult): Promise<void> {
    const authStore = useAuthStore.getState();
    const approvedPubky = Identity.z32FromSession({ session });
    if (authStore.currentUserPubky && approvedPubky === authStore.currentUserPubky) return;
    const restingBearerPubky = useCommerceStore.getState().marketplaceSession?.pubky ?? null;
    if (restingBearerPubky !== authStore.currentUserPubky) {
      CommerceController.clearMarketplaceSession();
    }
    await AuthApplication.logout({ session }).catch((logoutError) => {
      Logger.warn('Failed to sign out a step-up session approved for a different identity', { logoutError });
    });
    throw Err.auth(
      AuthErrorCode.UNAUTHORIZED,
      'The approval was for a different identity. Reconnect only widens the permissions of the signed-in account.',
      {
        service: ErrorService.Homeserver,
        operation: 'completeStepUpReauth',
        context: { expectedPubky: authStore.currentUserPubky, approvedPubky },
      },
    );
  }

  /**
   * Applies an approved step-up session to the CURRENT identity. The
   * approval replaces the homeserver cookie with the superset grant, so
   * watchlist sync, portable receipts, and messaging cookie-resume all
   * become capable without a reload; the auth store session (and its
   * persisted export) is swapped for the widened one.
   *
   * A session approved for a DIFFERENT identity is refused and signed back
   * out — a step-up must never silently switch accounts.
   *
   * `releaseAuthFlow: false` is for the bridged commerce ceremony, which
   * calls this mid-ceremony (between the homeserver and marketplace POSTs):
   * the ceremony's own settled-finally owns the guard and flow release, and
   * cancelling here would drop the single-flight guard during the POST window.
   */
  static async completeStepUpReauth(
    { session }: THomeserverSessionResult,
    { releaseAuthFlow = true }: { releaseAuthFlow?: boolean } = {},
  ): Promise<void> {
    const authStore = useAuthStore.getState();
    await this.assertStepUpSessionMatchesSignedInUser({ session });
    try {
      // Same externally-approved-session checkpoint as first sign-in.
      await AuthApplication.assertUserHomeserverAllowed({ publicKey: session.info.publicKey });
    } catch (error) {
      await AuthApplication.logout({ session }).catch((logoutError) => {
        Logger.warn('Failed to sign out session after environment check failure', { logoutError });
      });
      throw error;
    }
    if (releaseAuthFlow) {
      this.cancelActiveAuthFlow();
    }
    authStore.setSession(session);
  }

  /**
   * Generates a signup authentication URL for Pubky Ring authorization.
   * Decorates a standard auth URL with homeserver address and invite code metadata.
   * @param inviteCode - The invite code for signup
   * @returns Promise resolving to the generated signup authentication URL
   */
  static async getSignupAuthUrl(inviteCode: string): Promise<TGenerateAuthUrlResult> {
    return this.wrapAuthFlow(() => AuthApplication.generateSignupAuthUrl(inviteCode));
  }

  /**
   * Logs out the current user from both the homeserver and local application state.
   */
  static async logout() {
    // Bump before any await so an in-flight restore (sharing the Application
    // singleton promise) can tell its restored-branch result is stale.
    this.logoutGeneration += 1;
    // An unanswered `#s=` prompt holds the shared restore this logout joins.
    this.answerSessionHandoff(false);
    // Set before any await so RouteGuard cannot re-bridge between cleanup and this flag.
    suppressVibeSessionAutoRestore();
    AuthApplication.abortInFlightBridgeRequest();
    BootstrapApplication.cancelModerationFollow();
    // Captured before any await: a concurrent different-account sign-in must
    // be compared again inside the finalization lock so this logout cannot
    // wipe that account's origin-scoped Dexie.
    const captured = this.captureAuthIdentity();
    let authStore = useAuthStore.getState();

    // Set logging out flag immediately to prevent flash of weird states in UI
    authStore.setIsLoggingOut(true);
    authStore.setSessionRestoreDeferred(false);

    let session = authStore.session;
    let signedOut = false;

    try {
      // Fresh loads can still have a persisted session export before the live session is restored.
      // Reuse the restore flow so /logout performs a real homeserver sign-out before local cleanup.
      if (!session && (authStore.sessionExport || authStore.grantSessionRecordId || isVibeSessionConsumerEnabled())) {
        let restoreResult: TRestorePersistedSessionResult;
        try {
          restoreResult = await this.restorePersistedSession();
        } catch (error) {
          // restorePersistedSession already cleaned up local state; a wrong-environment
          // rejection needs no toast here — the user asked to log out anyway.
          Logger.warn('Persisted session restore during logout failed; local state already cleaned up', { error });
          await this.removeSignedOutSessionsUnderLock(captured.pubky);
          signedOut = true;
          return;
        }
        if (restoreResult.status === 'signed-out') {
          await this.removeSignedOutSessionsUnderLock(captured.pubky);
          signedOut = true;
          return;
        }
        if (restoreResult.status === 'deferred') {
          Logger.warn('Homeserver logout failed, clearing local state anyway', {
            error: 'Session restore deferred; homeserver sign-out could not run',
          });
          await this.removeSignedOutSessionsUnderLock(captured.pubky);
          await this.finalizeSignedOutUnderLock({ captured, preservePublicCache: false });
          signedOut = true;
          return;
        }
        authStore = useAuthStore.getState();
        session = authStore.session;
      }

      if (session) {
        try {
          await AuthApplication.logout({ session });
        } catch (error) {
          Logger.warn('Homeserver logout failed, clearing local state anyway', { error });
        }
      }

      // After the homeserver sign-out (it needs the grant key) and before the
      // record pointer is cleared: a key that cannot be removed keeps the
      // pointer and fails the logout instead of reporting signed-out.
      await this.removeSignedOutSessionsUnderLock(captured.pubky);
      // Serialized with restore finalization and sign-in identity persists.
      // Cleanup is keyed to the identity captured at logout start: a
      // different live pubky means that sign-in now owns origin-scoped Dexie.
      await this.finalizeSignedOutUnderLock({ captured, preservePublicCache: false });
      signedOut = true;
    } finally {
      if (signedOut) {
        broadcastSignedOut();
      } else {
        useAuthStore.getState().setIsLoggingOut(false);
      }
      // The internal restore's init() clears the auto-restore suppression
      // set above. If the homeserver sign-out then failed, the marker must
      // not stay cleared: a later reload in consumer mode would
      // bridge-restore the session the user just logged out of. Guarded so
      // it is a no-op when consumer mode is off (no bridge leg exists).
      if (isVibeSessionConsumerEnabled()) {
        suppressVibeSessionAutoRestore();
      }
    }
  }

  /**
   * Bumps the auth epoch and removes every stored grant session and key under
   * the finalization lock, so no tab can save a grant key after this sign-out.
   * Rejects while any stored record remains.
   *
   * In the same lock, removes the persisted auth session of the account being
   * signed out. Sign-out is the one auth write that removes a session this
   * tab does not own: the persist fence keeps another tab's newer session of
   * the same account through this tab's reset, but the user signed that
   * account out of this browser, so it must not be restored on the next load.
   * A session persisted after this lock, and another account's, are left.
   */
  private static async removeSignedOutSessionsUnderLock(pubky: string | null): Promise<void> {
    await withAuthFinalizationLock(async () => {
      bumpAuthEpoch();
      await AuthApplication.clearGrantSessions();
      clearGrantKeyCleanupPending();
      if (pubky && readPersistedAuthIdentity().pubky === pubky) clearPersistedAuthIdentity();
    });
  }

  /**
   * Discharges a pending grant-key cleanup (see `grant-key-cleanup.ts`):
   * removes every stored grant record and key, then drops the marker once the
   * store reads back empty. A signed-in grant session in any tab still needs
   * its own record, so the cleanup waits for that session's sign-out, which
   * removes every key and drops the marker. A failed removal keeps the marker
   * for the next attempt. Returns whether nothing is left pending.
   */
  static async settlePendingGrantKeyCleanup(): Promise<boolean> {
    if (!isGrantKeyCleanupPending()) return true;
    try {
      return await withAuthFinalizationLock(async () => {
        if (!isGrantKeyCleanupPending()) return true;
        if (useAuthStore.getState().grantSessionRecordId || readPersistedGrantSessionRecordId()) return false;
        await AuthApplication.clearGrantSessions();
        clearGrantKeyCleanupPending();
        return true;
      });
    } catch (error) {
      Logger.error('Grant keys left by a failed save are still stored; the cleanup is retried later', { error });
      return false;
    }
  }

  /**
   * Another tab signed out. A tab still holding a grant session in memory
   * signs it out and drops local state; cookie sessions are left alone.
   */
  static subscribeCrossTabSignOut(): () => void {
    return subscribeSignedOut(() => void this.handleCrossTabSignOut());
  }

  static async handleCrossTabSignOut(): Promise<void> {
    const { session, grantSessionRecordId } = useAuthStore.getState();
    if (!AuthApplication.isGrantSession(session) || !session) return;
    const captured = this.captureAuthIdentity();
    await AuthApplication.logout({ session }).catch((error) => {
      Logger.warn('Cross-tab grant sign-out could not reach the homeserver', { error });
    });
    this.cancelAllAuthFlows();
    if (grantSessionRecordId) {
      try {
        // Only this tab's record: a newer sign-in in another tab keeps its key.
        await AuthApplication.removeGrantSession(grantSessionRecordId);
      } catch (error) {
        Logger.error('Cross-tab sign-out could not remove the grant key of this tab; keeping it signed in', {
          error,
        });
        return;
      }
    }
    await this.finalizeSignedOutUnderLock({ captured, preservePublicCache: false });
  }

  /**
   * Initializes the application bootstrap after profile creation.
   * Waits for Nexus to index the user's profile.json, then bootstraps notifications and data.
   */
  static async bootstrapWithDelay() {
    const authStore = useAuthStore.getState();
    const pubky = authStore.selectCurrentUserPubky();
    // Wait 5 seconds before bootstrap to let Nexus index the user
    Logger.info(`Waiting 5 seconds to index ${pubky} profile.json in Nexus before bootstrap...`);
    await sleep(5000);
    await this.hydrateMeImAlive({ pubky });
    authStore.setHasProfile(true);
  }

  /**
   * Syncs user settings with the homeserver.
   * Returns remote settings if newer, null otherwise.
   * All failures are treated as non-blocking and fall back to local settings.
   */
  private static async syncSettings(pubky: Pubky, localSettings: SettingsState): Promise<SettingsState | null> {
    try {
      return await SettingsApplication.initializeSettings(pubky, localSettings);
    } catch (error) {
      Logger.error('Failed to initialize settings during bootstrap', { error, pubky });
      return null;
    }
  }

  /**
   * Generates a signup token for user registration. This is just for testing environments
   * @returns Promise resolving to the generated signup token
   */
  static async generateSignupToken() {
    return await AuthApplication.generateSignupToken();
  }

  /**
   * Verifies an invite code (signup token) against the homeserver before applying it.
   * @param inviteCode - The invite code to verify
   * @returns `'valid'`, `'used'`, or `'invalid'` depending on the homeserver response
   */
  static async verifySignupToken(inviteCode: string) {
    return await AuthApplication.verifySignupToken(inviteCode);
  }
}
