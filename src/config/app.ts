import { getHomeserver } from '@/config/network';
import { Env } from '@/libs/env/env';
import {
  getPrivEncryptionKeysEnabled,
  getPrivEncryptionKeysHomeservers,
  getSingleApprovalSignIn,
} from '@/libs/runtime-config/runtime-config';

export const APP_VERSION = Env.NEXT_PUBLIC_APP_VERSION;

/**
 * The single sign-in grant. One Ring approval covers everything the app does,
 * on purpose: the homeserver keeps ONE session cookie per user per origin, so
 * splitting capabilities across separate approvals means each new approval
 * clobbers the previous session (this broke all pubky.app writes when the
 * paykit-only messaging grant landed — see `messaging-contracts.ts`).
 * Scopes: the app's own tree, the Paykit tree (encrypted messaging), and the
 * app's private tree (cross-device watchlist sync — `/priv/` is enforced
 * private by the homeserver, verified empirically in
 * `docs/ecommerce/watchlist.md`).
 *
 * This is the grant Bitkit approves for client id {@link SHOP_GRANT_CLIENT_ID}.
 * Pubky Ring cookie approvals request {@link RING_COOKIE_CAPABILITIES}, a
 * superset of it.
 */
export const CAPABILITIES = '/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw';

/**
 * The Shop's scope for scoped encryption keys (priv-encryption Phase 4):
 * read, write and the `e` action on the Shop's own private tree only. `e` is
 * on no other scope, and `/priv/pubky.app/` stays `rw` so the key file and
 * the encrypted records sit under a scope that already exists today.
 */
export const PRIV_KEYS_SCOPE = '/priv/pubky.app/marketplace/:rwe';

/**
 * What a signer approves for {@link PRIV_KEYS_SCOPE} when the user declines
 * `e` but approves storage; the approval then carries no keys.
 */
export const PRIV_KEYS_SCOPE_DECLINED = '/priv/pubky.app/marketplace/:rw';

/** The grant sign-in request when scoped encryption keys are asked for. */
export const KEYED_CAPABILITIES = `${CAPABILITIES},${PRIV_KEYS_SCOPE}`;

/**
 * Whether the grant sign-in asks the signer for `e`: the runtime switch is on
 * and the deploy's homeserver is listed as running scoped keys. The
 * homeserver does not advertise the capability, and one that predates it
 * rejects the whole grant after the user approved, so both must hold.
 */
export function isPrivKeysRequested(): boolean {
  return getPrivEncryptionKeysEnabled() && getPrivEncryptionKeysHomeservers().includes(getHomeserver());
}

/** Client id Bitkit shows on its Authorize screen for the Shop's grant sign-in. */
export const SHOP_GRANT_CLIENT_ID = 'shop.pubky.app';

/**
 * Interim dual-POST ceremony (docs/ecommerce/single-approval.md). Runtime
 * flag (`PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN`, default on): `false`
 * restores `awaitApproval()` sign-in plus empty-capability marketplace
 * connect. Read at call time so a deploy can roll back without a rebuild.
 * Do not roll back by POSTing empty capabilities to `/session`.
 */
export function isSingleApprovalSignInEnabled(): boolean {
  return getSingleApprovalSignIn();
}

/**
 * What a Pubky Ring cookie sign-in requests: {@link CAPABILITIES} plus
 * pubky.app's own sign-in scopes (`/priv/social/:rw` and the Locks guarded
 * read `/priv/app.locks/content/:r`, from pubky.app's
 * `HOMESERVER_CAPABILITIES`). Shop and pubky.app share the one homeserver
 * cookie, so each cookie approval replaces the other site's; requesting both
 * sets keeps a Shop sign-in from stripping pubky.app's access. Every cookie
 * approval the Shop starts (sign-in, sign-up, step-up, bridged commerce
 * connect, messaging enable) requests this string, and the token it yields
 * must carry exactly this set.
 *
 * Grant sign-ins (Bitkit) are bound to the Shop's client id, never share the
 * cookie, and keep requesting and checking {@link CAPABILITIES}.
 */
export const RING_COOKIE_CAPABILITIES =
  '/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r';

function capabilitiesMatchSet(capabilities: readonly string[], expectedSet: string): boolean {
  const expected = expectedSet
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const incoming = [...new Set(capabilities.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
  if (incoming.length !== expected.length) return false;
  const incomingSet = new Set(incoming);
  return expected.every((entry) => incomingSet.has(entry));
}

/**
 * Order-insensitive set equality with the Shop grant: {@link CAPABILITIES}
 * alone, or with {@link PRIV_KEYS_SCOPE} as requested or as a signer leaves it
 * when the user declined `e`. A session approved before keys were requested
 * and one approved after both hold the full grant.
 */
export function capabilitiesMatchFullGrant(capabilities: readonly string[]): boolean {
  return (
    capabilitiesMatchSet(capabilities, CAPABILITIES) ||
    capabilitiesMatchSet(capabilities, KEYED_CAPABILITIES) ||
    capabilitiesMatchSet(capabilities, `${CAPABILITIES},${PRIV_KEYS_SCOPE_DECLINED}`)
  );
}

/** Order-insensitive set equality with {@link RING_COOKIE_CAPABILITIES} split on commas. */
export function capabilitiesMatchRingCookieGrant(capabilities: readonly string[]): boolean {
  return capabilitiesMatchSet(capabilities, RING_COOKIE_CAPABILITIES);
}
