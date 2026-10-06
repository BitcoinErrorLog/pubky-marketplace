import { afterEach, describe, expect, it } from 'vitest';
import { AuthStatus } from '@/hooks/useAuthStatus/useAuthStatus.types';
import { setSocialHost } from '@/test-utils/social-host';
import { ROUTE_ACCESS_MAP } from './RouteGuardProvider.constants';

describe('ROUTE_ACCESS_MAP authenticated redirect', () => {
  afterEach(() => {
    setSocialHost(undefined);
  });

  it('sends signed-in users to /home while social link-out is off', () => {
    expect(ROUTE_ACCESS_MAP[AuthStatus.AUTHENTICATED].redirectTo).toBe('/home');
  });

  it('sends signed-in users to the marketplace while social link-out is on', () => {
    setSocialHost('https://pubky.app');
    expect(ROUTE_ACCESS_MAP[AuthStatus.AUTHENTICATED].redirectTo).toBe('/marketplace');
  });
});
