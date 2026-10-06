import type { CommerceMarketplaceSession } from '@/stores/commerce/commerce.types';

/**
 * Lifecycle of one interactive session-connect attempt:
 *
 * - `idle`      — no flow in progress (initial, after cancel).
 * - `creating`  — the BFF is creating a signer-bound flow.
 * - `awaiting`  — an authorization URL exists and the flow is waiting for the
 *                 user to approve on their signer.
 * - `joined`    — the flow JOINED an approval ceremony another surface already
 *                 owns (e.g. a sign-in in progress). That surface holds the
 *                 only scannable URL, so there is no QR here — just the honest
 *                 "already in progress" state while the join awaits the same
 *                 settlement.
 * - `connected` — the signer approved and the AuthToken was exchanged for a
 *                 bearer session; the store now carries the session facts.
 * - `error`     — the flow failed (relay timeout, rejected token, service
 *                 unreachable). The URL is cleared because AuthToken flows are
 *                 single-use: retrying always starts a FRESH flow.
 */
export type MarketplaceSessionConnectStatus =
  | 'idle'
  | 'creating'
  | 'awaiting'
  | 'verifying'
  | 'claiming'
  | 'joined'
  | 'connected'
  | 'mismatch'
  | 'expired'
  | 'cancelled'
  | 'error';

export interface UseMarketplaceSessionConnectOptions {
  /** Called once per successful connect, after the store has been updated. */
  onConnected?: (session: CommerceMarketplaceSession) => void;
}

export interface UseMarketplaceSessionConnectReturn {
  status: MarketplaceSessionConnectStatus;
  /** The `pubkyauth://` URL to render as a QR or open as a Ring deeplink. Empty outside `awaiting`. */
  authorizationUrl: string;
  /** The real failure message when `status === 'error'`, never a placeholder. */
  errorMessage: string | null;
  /**
   * Which consent `start()` will request: `true` = the full Shop grant
   * (bridged first-commerce prompt), `false` = the empty-capability
   * marketplace-only approval. Computed here ONCE so rendered copy and the
   * flow that actually starts can never diverge.
   */
  requestsFullGrant: boolean;
  /**
   * True only while `start()` is running (or about to run) the reconnect
   * grant. False for AuthToken bootstrap, including the BFF
   * `shop_session_missing` / `shop_session_expired` fallback. The dialog
   * must render this instead of re-reading the grant flag.
   */
  requestsGrantReconnect: boolean;
  /**
   * True while `start()` is running (or about to run) the browser bootstrap:
   * a grant (Bitkit or Pubky Passport) sign-in with no marketplace bearer yet.
   * Its approval comes from the same signer, never the Ring prompt.
   */
  requestsGrantBootstrap: boolean;
  /**
   * True when Pubky Passport approved the Shop sign-in, so it approves this
   * grant too. Passport opens in a popup, which needs a click: `start()` only
   * arms the approval (status `idle`, no URL) and `startPassport()` runs it.
   * The URL is set while Passport shows it, for the disclosure only: it is
   * never a QR or a deeplink.
   */
  requestsPassport: boolean;
  /** Begins a fresh flow, cancelling any in-flight one. */
  start: () => void;
  /** Opens the armed Passport approval. Call it from the click handler itself. */
  startPassport: () => void;
  /** Cancels the in-flight flow (frees it) and returns to `idle`. */
  cancel: () => void;
  /** Copies the authorization URL for manual transfer to the signer device. */
  copyAuthUrl: () => Promise<void>;
  /** Opens the authorization URL as a deeplink (same-device Pubky Ring). */
  openInRing: () => void;
  /** True between tapping "Open in Pubky Ring" and the page losing focus to the Ring app. */
  isOpeningRing: boolean;
}
