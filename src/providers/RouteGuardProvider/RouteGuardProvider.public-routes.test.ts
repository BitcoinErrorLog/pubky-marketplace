import { describe, expect, it } from 'vitest';
import { APP_ROUTES, isDynamicPublicRoute, PUBLIC_ROUTES } from '@/app/routes';

/**
 * The provider's public-route table is `PUBLIC_ROUTES.includes(pathname)`
 * plus `isDynamicPublicRoute`. This file imports the real table (the main
 * RouteGuard tests mock `@/app/routes`).
 */
describe('RouteGuard public table — marketplace catalog', () => {
  it('allows the catalog home without waiting for auth hydration', () => {
    expect(PUBLIC_ROUTES.includes(APP_ROUTES.MARKETPLACE)).toBe(true);
  });

  it('does not treat personal marketplace surfaces as public', () => {
    expect(PUBLIC_ROUTES.includes('/marketplace/orders')).toBe(false);
    expect(PUBLIC_ROUTES.includes('/marketplace/sell')).toBe(false);
    expect(isDynamicPublicRoute('/marketplace/orders')).toBe(false);
    expect(isDynamicPublicRoute('/marketplace/dashboard')).toBe(false);
  });
});
