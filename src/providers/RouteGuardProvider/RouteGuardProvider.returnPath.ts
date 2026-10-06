import { matchesAllowedRoute } from '@/app/routes';

export const ROUTE_GUARD_RETURN_TO_STORAGE_KEY = 'pubky.routeGuard.returnTo';

const MAX_ROUTE_GUARD_RETURN_TO_LENGTH = 256;
const PLACEHOLDER_ORIGIN = 'https://placeholder.invalid';
const CONTROL_OR_WHITESPACE = /[\u0000-\u001F\u007F]|\s/;
// Percent-encoded backslash is rejected: it does not change WHATWG origin, but
// Next/client decoding can still treat `\` as `/` and open a protocol-relative URL.
const ENCODED_BACKSLASH = /%5c/i;

function getSessionStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function isValidRouteGuardReturnToPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  if (path.length === 0 || path.length > MAX_ROUTE_GUARD_RETURN_TO_LENGTH) return false;
  if (!path.startsWith('/')) return false;

  const second = path.charAt(1);
  if (second === '/' || second === '\\') return false;
  if (path.includes('\\')) return false;
  if (CONTROL_OR_WHITESPACE.test(path)) return false;
  if (ENCODED_BACKSLASH.test(path)) return false;

  try {
    const url = new URL(path, PLACEHOLDER_ORIGIN);
    if (url.origin !== PLACEHOLDER_ORIGIN) return false;
    const composed = `${url.pathname}${url.search}${url.hash}`;
    if (!composed.startsWith('/')) return false;
  } catch {
    return false;
  }

  return true;
}

export function isRouteGuardReturnToAllowed(path: string, allowedRoutes: string[]): boolean {
  return allowedRoutes.some((route) => matchesAllowedRoute(path, route));
}

export function storeRouteGuardReturnTo(path: string): void {
  if (!isValidRouteGuardReturnToPath(path)) return;

  try {
    getSessionStorage()?.setItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY, path);
  } catch {
    // Best-effort: route guarding must keep working in storage-disabled contexts.
  }
}

export function clearRouteGuardReturnTo(): void {
  try {
    getSessionStorage()?.removeItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY);
  } catch {
    // Best-effort: sign-out must keep working in storage-disabled contexts.
  }
}

export function consumeRouteGuardReturnTo(allowedRoutes: string[]): string | null {
  let path: string | null | undefined;

  try {
    path = getSessionStorage()?.getItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY);
    getSessionStorage()?.removeItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY);
  } catch {
    return null;
  }

  if (!isValidRouteGuardReturnToPath(path)) return null;
  if (!isRouteGuardReturnToAllowed(path, allowedRoutes)) return null;

  return path;
}
