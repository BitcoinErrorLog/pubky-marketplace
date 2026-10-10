import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

describe('GET /version.json', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns name, version, commit and built_at as JSON without authentication', async () => {
    vi.stubEnv('SHOP_BUILD_NAME', 'pubky-marketplace');
    vi.stubEnv('SHOP_BUILD_VERSION', 'shop-v0.6.50');
    vi.stubEnv('SHOP_BUILD_COMMIT', '73cec61b6');
    vi.stubEnv('SHOP_BUILD_BUILT_AT', '2026-10-10T12:34:56.000Z');

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      name: 'pubky-marketplace',
      version: 'shop-v0.6.50',
      commit: '73cec61b6',
      built_at: '2026-10-10T12:34:56.000Z',
    });
  });
});
