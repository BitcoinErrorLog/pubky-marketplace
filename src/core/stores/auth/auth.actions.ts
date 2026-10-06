import { Session } from '@synonymdev/pubky';
import { clearVibeSessionAutoRestoreSuppressed } from '@/libs/vibe-session/auto-restore';
import type { Pubky } from '@/models/models.types';
import { ZustandSet } from '../stores.types';
import { AuthActions, AuthActionTypes, authInitialState, AuthInitParams, AuthStore } from './auth.types';

const safeSessionExport = (session: Session | null): string | null => {
  if (!session) return null;
  // A grant session's export carries no key; reload restores it from
  // BrowserSessionStore instead (see `grantSessionRecordId`).
  if (session.grant !== undefined) return null;
  try {
    if (typeof session.export === 'function') {
      return session.export();
    }
  } catch {
    // ignore export errors; session persistence is best-effort here
  }
  return null;
};

// Actions/Mutators - State modification functions
export const createAuthActions = (set: ZustandSet<AuthStore>): AuthActions => ({
  init: ({
    session,
    currentUserPubky,
    hasProfile,
    grantSessionRecordId = null,
    grantSigner = null,
  }: AuthInitParams) => {
    clearVibeSessionAutoRestoreSuppressed();
    set(
      (state) => ({
        ...state,
        session,
        sessionExport: safeSessionExport(session),
        grantSessionRecordId: session && session.grant !== undefined ? grantSessionRecordId : null,
        grantSigner:
          session && session.grant !== undefined ? (grantSigner === 'passport' ? 'passport' : 'bitkit') : null,
        currentUserPubky,
        hasProfile,
        sessionRestoreDeferred: false,
      }),
      false,
      AuthActionTypes.INIT,
    );
  },
  // Storage management
  reset: () => {
    set(
      (state) => ({
        ...authInitialState,
        hasHydrated: state.hasHydrated, // Preserve hydration state
        isLoggingOut: state.isLoggingOut, // Preserve logout state to prevent UI flash
        isRestoringSession: state.isRestoringSession, // Hold restore loading through account cleanup
      }),
      false,
      AuthActionTypes.RESET,
    );
  },
  // Authentication data management
  setCurrentUserPubky: (pubky: Pubky | null) => {
    set({ currentUserPubky: pubky }, false, AuthActionTypes.SET_PUBKY);
  },

  setSession: (session: Session | null) => {
    set({ session, sessionExport: safeSessionExport(session) }, false, AuthActionTypes.SET_SESSION);
  },

  setIsRestoringSession: (isRestoringSession: boolean) => {
    set({ isRestoringSession }, false, AuthActionTypes.SET_IS_RESTORING_SESSION);
  },

  setHasProfile: (hasProfile: boolean) => {
    set({ hasProfile }, false, AuthActionTypes.SET_HAS_PROFILE);
  },

  setHasHydrated: (hasHydrated: boolean) => {
    set({ hasHydrated }, false, AuthActionTypes.SET_HAS_HYDRATED);
  },

  setShowSignInDialog: (showSignInDialog: boolean) => {
    set({ showSignInDialog }, false, AuthActionTypes.SET_SHOW_SIGN_IN_DIALOG);
  },

  setIsLoggingOut: (isLoggingOut: boolean) => {
    set({ isLoggingOut }, false, AuthActionTypes.SET_IS_LOGGING_OUT);
  },

  setSessionRestoreDeferred: (sessionRestoreDeferred: boolean) => {
    set({ sessionRestoreDeferred }, false, AuthActionTypes.SET_SESSION_RESTORE_DEFERRED);
  },
});
