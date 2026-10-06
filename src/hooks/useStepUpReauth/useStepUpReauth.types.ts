/**
 * Lifecycle of one explicit step-up re-approval attempt:
 *
 * - `idle`           — no flow in progress (initial, after cancel).
 * - `starting`       — the authorization URL is being generated.
 * - `awaiting`       — an authorization URL exists and the flow is waiting
 *                      for the user to approve on their signer.
 * - `reauthenticated`— the signer approved and the widened session replaced
 *                      the auth-store session.
 * - `error`          — the flow failed (relay timeout, declined approval, a
 *                      different identity approved). The URL is cleared
 *                      because auth flows are single-use: retrying always
 *                      starts a FRESH flow.
 */
export type StepUpReauthStatus = 'idle' | 'starting' | 'awaiting' | 'reauthenticated' | 'error';

export interface UseStepUpReauthOptions {
  /** Called once per successful re-approval, after the auth-store session update. */
  onReauthenticated?: () => void | Promise<void>;
}

export interface UseStepUpReauthReturn {
  status: StepUpReauthStatus;
  /** The `pubkyauth://` URL to render as a QR or open as a Ring deeplink. Empty outside `awaiting`. */
  authorizationUrl: string;
  /** The real failure message when `status === 'error'`, never a placeholder. */
  errorMessage: string | null;
  /** Begins a fresh flow, cancelling any in-flight one. */
  start: () => void;
  /** Cancels the in-flight flow (frees it) and returns to `idle`. */
  cancel: () => void;
  /** Copies the authorization URL for manual transfer to the signer device. */
  copyAuthUrl: () => Promise<void>;
  /** Opens the authorization URL as a deeplink (same-device Pubky Ring). */
  openInRing: () => void;
  /** True between tapping "Open in Pubky Ring" and the page losing focus to the Ring app. */
  isOpeningRing: boolean;
}
