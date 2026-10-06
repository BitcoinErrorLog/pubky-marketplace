import { describe, expect, it, vi } from 'vitest';
import * as route from './opengraph-image';

vi.mock('@/libs/og/renderShopOg', () => ({
  renderShopOg: vi.fn(),
}));

describe('shop OG route caching', () => {
  it('delegates caching to response headers', () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect(Reflect.get(route, 'revalidate')).toBeUndefined();
  });
});
