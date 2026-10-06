import type { MessagingEnabledInfo } from '@/services/paykit/paykit-messaging';

/**
 * Lifecycle of one interactive "enable encrypted messaging" attempt:
 *
 * - `idle`     — no flow in progress (initial, after cancel).
 * - `awaiting` — a `pubkyauth://` URL for the `/pub/paykit/:rw` grant exists
 *                and the flow is waiting for approval on the user's signer.
 * - `enabled`  — the signer approved, the receiver Noise key exists on this
 *                device, and the receiver marker was published — this user is
 *                now discoverable for encrypted messaging.
 * - `error`    — the flow failed (relay timeout, identity mismatch, marker
 *                publish failure). Retrying always starts a FRESH flow.
 */
export type MarketplaceMessagingEnableStatus = 'idle' | 'awaiting' | 'enabled' | 'error';

export interface UseMarketplaceMessagingEnableOptions {
  /** Called once per successful enable, after the store has been updated. */
  onEnabled?: (info: MessagingEnabledInfo) => void;
}

export interface UseMarketplaceMessagingEnableReturn {
  status: MarketplaceMessagingEnableStatus;
  /** The `pubkyauth://` URL to render as a QR or open as a Ring deeplink. Empty outside `awaiting`. */
  authorizationUrl: string;
  /** The real failure message when `status === 'error'`, never a placeholder. */
  errorMessage: string | null;
  /** Begins a fresh flow, detaching any in-flight one. */
  start: () => void;
  /** Detaches the in-flight flow and returns to `idle`. */
  cancel: () => void;
  /** Copies the authorization URL for manual transfer to the signer device. */
  copyAuthUrl: () => Promise<void>;
  /** Opens the authorization URL as a deeplink (same-device Pubky Ring). */
  openInRing: () => void;
  /** True between tapping "Open in Pubky Ring" and the page losing focus to the Ring app. */
  isOpeningRing: boolean;
}
