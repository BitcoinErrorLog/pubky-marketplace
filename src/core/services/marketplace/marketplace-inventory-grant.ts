import { capabilitiesCoverScope, MARKETPLACE_INVENTORY_SCOPE } from './marketplace-session-grant';

/**
 * Studio inventory step-up grant. The only capability string Inventory Studio
 * may pass to `generateAuthTokenFlow`. Root `/:rw` covers the service ACL if
 * minted elsewhere; Studio must never request it.
 */
export const INVENTORY_GRANT = '/pub/pubky.app/marketplace-service/v1/:rw' as const;

export const INVENTORY_SESSION_STORAGE_KEY = 'pubky.marketplace.inventory-session.v1';

const ROOT_GRANT = '/:rw';

/** The allow-listed capability string for the Studio inventory mint. */
export function studioInventoryCapabilities(): typeof INVENTORY_GRANT {
  return INVENTORY_GRANT;
}

function capabilityParts(capabilities: string): string[] {
  return capabilities
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * True when a minted session's capability list covers inventory Read+Write.
 * Empty, `:r`, and unrelated paths do not. Root covers ACL but Studio never
 * requests it.
 */
export function inventoryCapabilityCovers(capabilities: string): boolean {
  const parts = capabilityParts(capabilities);
  return parts.includes(INVENTORY_GRANT) || parts.includes(ROOT_GRANT);
}

/**
 * True when some entry grants read and write over a directory that contains
 * the inventory scope — the service's own coverage rule. A purchase session
 * carrying the marketplace session grant, the Shop sign-in grant, or root
 * covers it; empty, read-only, narrower and unrelated grants do not.
 */
export function capabilitiesCoverInventoryScope(capabilities: string): boolean {
  return capabilitiesCoverScope(capabilities, MARKETPLACE_INVENTORY_SCOPE);
}

/**
 * Studio persists only the requested grant. Returned caps that are empty,
 * narrower, or wider (`/:rw`, extra paths) fail closed. Callers must store
 * this constant, never the service string verbatim.
 */
export function clampInventoryPersistedCapabilities(capabilities: string): typeof INVENTORY_GRANT | null {
  const parts = capabilityParts(capabilities);
  if (parts.length === 0) return null;
  if (parts.some((part) => part !== INVENTORY_GRANT)) return null;
  return INVENTORY_GRANT;
}
