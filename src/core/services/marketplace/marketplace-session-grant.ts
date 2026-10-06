import { CAPABILITIES, isSingleApprovalSignInEnabled, RING_COOKIE_CAPABILITIES } from '@/config/app';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';

/**
 * The capabilities a marketplace purchase session requests, whichever signer
 * approves it: the Bitkit/Ring grant flow (marketplace-service
 * `GRANT_REQUEST_CAPABILITIES`) and the Pubky Ring "Connect marketplace" QR.
 * Inventory tools, plus the private tree whose data key
 * `GET /v1/me/priv-keys` releases only to a session that can read and write
 * it. The signer shows this string verbatim.
 */
export const MARKETPLACE_SESSION_GRANT = '/pub/pubky.app/marketplace-service/v1/:rw,/priv/pubky.app/:rw' as const;

/**
 * What marketplace-service requested before it asked for `/priv/pubky.app/`.
 * A service that has not yet deployed the wider request still emits it, so
 * the Shop and the service can deploy in either order.
 */
export const MARKETPLACE_PREVIOUS_SESSION_GRANT = '/pub/pubky.app/marketplace-service/v1/:rw' as const;

/** The two directories whose authority the service checks on a purchase session. */
export const MARKETPLACE_INVENTORY_SCOPE = '/pub/pubky.app/marketplace-service/v1/';
export const MARKETPLACE_PRIVATE_DATA_SCOPE = '/priv/pubky.app/';

const READ_WRITE_ACTIONS = new Set(['rw', 'wr']);

function capabilityParts(capabilities: string): string[] {
  return capabilities
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * True when some entry grants exactly read and write over a directory that
 * contains `scope` — the service's rule (`scope_covers_path` plus both
 * actions). Empty, read-only, narrower and unrelated grants do not cover it.
 */
export function capabilitiesCoverScope(capabilities: string, scope: string): boolean {
  return capabilityParts(capabilities).some((part) => {
    const separator = part.lastIndexOf(':');
    if (separator <= 0) return false;
    const directory = part.slice(0, separator);
    return directory.endsWith('/') && scope.startsWith(directory) && READ_WRITE_ACTIONS.has(part.slice(separator + 1));
  });
}

function sameCapabilitySet(capabilities: string, expected: string): boolean {
  const raw = capabilities.split(',').map((part) => part.trim());
  if (raw.some((part) => part.length === 0) || new Set(raw).size !== raw.length) return false;
  const wanted = expected.split(',');
  return raw.length === wanted.length && wanted.every((part) => raw.includes(part));
}

/** The grants a claimed (Bitkit or Ring grant-flow) session may carry. */
export const MARKETPLACE_CLAIMABLE_GRANTS = [MARKETPLACE_SESSION_GRANT, MARKETPLACE_PREVIOUS_SESSION_GRANT] as const;

/** True only for exactly one of `accepted`, entries in any order, no blanks or duplicates. */
export function matchesCapabilitySet(capabilities: string, accepted: readonly string[]): boolean {
  return accepted.some((expected) => sameCapabilitySet(capabilities, expected));
}

/** True only for exactly one of the two marketplace session grants, in any order. */
export function isMarketplaceSessionGrant(capabilities: string): boolean {
  return matchesCapabilitySet(capabilities, MARKETPLACE_CLAIMABLE_GRANTS);
}

/** Why a new session must not replace the current one, or null when it may. */
export type SessionReplacementRejection = 'unexpected_capabilities' | 'narrower_than_current';

/**
 * A newly minted session replaces the active purchase session only when it
 * carries exactly one of the `accepted` grants (null: whatever the caller
 * requested was not a fixed grant) and keeps every scope the current session
 * for the same pubky already covers.
 */
export function sessionReplacementRejection(
  claimedCapabilities: string,
  accepted: readonly string[] | null,
  current: { pubky: string; capabilities: string } | null,
  claimedPubky: string,
): SessionReplacementRejection | null {
  if (accepted && !matchesCapabilitySet(claimedCapabilities, accepted)) return 'unexpected_capabilities';
  if (!current || current.pubky !== claimedPubky) return null;
  for (const scope of [MARKETPLACE_INVENTORY_SCOPE, MARKETPLACE_PRIVATE_DATA_SCOPE]) {
    if (capabilitiesCoverScope(current.capabilities, scope) && !capabilitiesCoverScope(claimedCapabilities, scope)) {
      return 'narrower_than_current';
    }
  }
  return null;
}

function capsParam(authorizationUrl: string): string | null {
  try {
    return new URL(authorizationUrl).searchParams.getAll('caps').join(',');
  } catch {
    return null;
  }
}

/**
 * True only for an approval URL whose `caps` is exactly one of the two
 * marketplace session requests. Anything wider is never shown to a signer.
 */
export function isMarketplaceSessionGrantUrl(authorizationUrl: string): boolean {
  const caps = capsParam(authorizationUrl);
  return caps === MARKETPLACE_SESSION_GRANT || caps === MARKETPLACE_PREVIOUS_SESSION_GRANT;
}

export const MARKETPLACE_DISCLOSURE_PRIVATE_DATA =
  'Approving lets the marketplace handle your purchases and stock edits and read and write your private Shop data.';
export const MARKETPLACE_DISCLOSURE_INVENTORY = 'Approving lets the marketplace handle your purchases and stock edits.';
export const MARKETPLACE_DISCLOSURE_SIGN_IN =
  'Approving signs you in to Pubky Shop and gives the marketplace the same access, including your private Shop data.';
/** The Ring cookie set also carries pubky.app's scopes, so its approval keeps that site working too. */
export const MARKETPLACE_DISCLOSURE_RING_SIGN_IN =
  "Approving signs you in to Pubky Shop, gives the marketplace the same access, including your private Shop data, and keeps Pubky App's social and Locks access working.";

/**
 * The one sentence Shop shows beside a QR whose approval produces a
 * marketplace session, chosen from the capabilities the QR actually requests.
 * Null for any other request, which no marketplace surface may show.
 */
export function marketplaceApprovalDisclosure(authorizationUrl: string): string | null {
  const caps = capsParam(authorizationUrl);
  if (caps === null) return null;
  if (matchesCapabilitySet(caps, [MARKETPLACE_SESSION_GRANT])) return MARKETPLACE_DISCLOSURE_PRIVATE_DATA;
  if (matchesCapabilitySet(caps, [MARKETPLACE_PREVIOUS_SESSION_GRANT])) return MARKETPLACE_DISCLOSURE_INVENTORY;
  if (matchesCapabilitySet(caps, [RING_COOKIE_CAPABILITIES])) return MARKETPLACE_DISCLOSURE_RING_SIGN_IN;
  if (matchesCapabilitySet(caps, [CAPABILITIES])) return MARKETPLACE_DISCLOSURE_SIGN_IN;
  return null;
}

/**
 * The disclosure for a Pubky Ring sign-in or step-up QR. Its AuthToken also
 * mints a marketplace session only under single approval in a durable
 * commerce mode (`AuthApplication.completeSingleApprovalCeremony`); otherwise
 * the QR hands the marketplace nothing and shows nothing.
 */
export function signInApprovalDisclosure(authorizationUrl: string): string | null {
  if (!isSingleApprovalSignInEnabled() || !isDurableCommerceMode(getCommerceAdapterMode())) return null;
  return marketplaceApprovalDisclosure(authorizationUrl);
}
