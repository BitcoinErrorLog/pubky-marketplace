import { Keypair, type Session } from '@synonymdev/pubky';
import type { Pubky } from '@/models/models.types';
import type { MarketplaceSessionInfo } from '@/services/marketplace/marketplace-session';
import type { AuthStore } from '@/stores/auth/auth.types';

export type TKeypairParams = {
  keypair: Keypair;
};

export type TSecretKey = {
  secretKey: string;
};

export type THomeserverAuthenticateParams = TKeypairParams & TSecretKey;

export interface TRestoreSessionParams {
  authStore: AuthStore;
  /**
   * Asks the user whether a `#s=` hand-off may sign this tab in as `pubky`.
   * Resolves true only on an explicit yes. Absent, every hand-off is declined.
   */
  confirmSessionHandoff?: (pubky: Pubky) => Promise<boolean>;
}

export type TRestoreSessionOutcome =
  | { status: 'restored'; session: Session }
  | { status: 'signed-out' }
  | { status: 'deferred' };

export type TRestoreSessionResult = Promise<TRestoreSessionOutcome>;

export type TRestorePersistedSessionResult = { status: TRestoreSessionOutcome['status'] };

/**
 * Why the marketplace half of the single-approval ceremony failed. Carries
 * ONLY the no-excerpt discipline fields (`statusCode` / `alreadyUsed`) —
 * never body text, never token bytes.
 */
export type TMarketplaceRedeemError = {
  statusCode?: number;
  alreadyUsed?: boolean;
};

export type TSingleApprovalResult = {
  session: Session;
  marketplace: MarketplaceSessionInfo | null;
  /**
   * Null when the marketplace half succeeded (or does not apply outside
   * durable commerce modes). A non-null value means the homeserver session
   * stands and the marketplace needs a separate reconnect approval — it is
   * never a sign-in failure (docs/ecommerce/single-approval.md §4.3).
   */
  marketplaceError: TMarketplaceRedeemError | null;
};

export type TSingleApprovalCeremonyHooks = {
  /**
   * Runs after the homeserver half resolves and BEFORE the marketplace POST.
   * The bridged ceremony uses it to swap the auth-store session for the
   * widened one while the cookie and the store cannot drift apart.
   */
  onHomeserverSession?: (session: Session) => Promise<void>;
};
