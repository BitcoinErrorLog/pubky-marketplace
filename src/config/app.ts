import { Env } from '@/libs/env/env';
import { getSingleApprovalSignIn } from '@/libs/runtime-config/runtime-config';

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

/** Order-insensitive set equality with {@link CAPABILITIES} split on commas. */
export function capabilitiesMatchFullGrant(capabilities: readonly string[]): boolean {
  return capabilitiesMatchSet(capabilities, CAPABILITIES);
}

/** Order-insensitive set equality with {@link RING_COOKIE_CAPABILITIES} split on commas. */
export function capabilitiesMatchRingCookieGrant(capabilities: readonly string[]): boolean {
  return capabilitiesMatchSet(capabilities, RING_COOKIE_CAPABILITIES);
}
