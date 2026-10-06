import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRouteGuardReturnTo,
  consumeRouteGuardReturnTo,
  isValidRouteGuardReturnToPath,
  ROUTE_GUARD_RETURN_TO_STORAGE_KEY,
  storeRouteGuardReturnTo,
} from './RouteGuardProvider.returnPath';

describe('RouteGuardProvider return path', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('validates same-origin relative paths only', () => {
    expect(isValidRouteGuardReturnToPath('/marketplace/orders')).toBe(true);
    expect(isValidRouteGuardReturnToPath('/marketplace/orders?tab=open#x')).toBe(true);
    expect(isValidRouteGuardReturnToPath('https://evil')).toBe(false);
    expect(isValidRouteGuardReturnToPath('//evil')).toBe(false);
    expect(isValidRouteGuardReturnToPath('javascript:alert(1)')).toBe(false);
  });

  it('rejects backslash, encoded-backslash, whitespace, control, and oversized paths', () => {
    expect(isValidRouteGuardReturnToPath('/\\evil.com')).toBe(false);
    expect(isValidRouteGuardReturnToPath('/\\\\evil.com')).toBe(false);
    // %5C is not decoded by WHATWG origin checks; reject so a later client decode cannot
    // turn it into a protocol-relative `/\evil.com` open redirect.
    expect(isValidRouteGuardReturnToPath('/%5Cevil.com')).toBe(false);
    expect(isValidRouteGuardReturnToPath('/ /x')).toBe(false);
    expect(isValidRouteGuardReturnToPath('/\tx')).toBe(false);
    expect(isValidRouteGuardReturnToPath(`/${'a'.repeat(299)}`)).toBe(false);
  });

  it('stores and consumes an allowed route once', () => {
    storeRouteGuardReturnTo('/marketplace/orders');

    expect(consumeRouteGuardReturnTo(['/marketplace'])).toBe('/marketplace/orders');
    expect(window.sessionStorage.getItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY)).toBeNull();
    expect(consumeRouteGuardReturnTo(['/marketplace'])).toBeNull();
  });

  it('clears a stored route that is not allowed', () => {
    storeRouteGuardReturnTo('/marketplace/orders');

    expect(consumeRouteGuardReturnTo(['/feed'])).toBeNull();
    expect(window.sessionStorage.getItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY)).toBeNull();
  });

  it('clears a stored return path without consuming it', () => {
    storeRouteGuardReturnTo('/marketplace/orders');

    clearRouteGuardReturnTo();

    expect(window.sessionStorage.getItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY)).toBeNull();
    expect(consumeRouteGuardReturnTo(['/marketplace'])).toBeNull();
  });
});
