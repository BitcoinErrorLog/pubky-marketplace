import { describe, expect, it, vi } from 'vitest';
import * as route from './opengraph-image';

vi.mock('@/libs/og/renderListingOg', () => ({
  renderListingOg: vi.fn(),
}));

describe('listing OG route caching', () => {
  it('delegates caching to response headers', () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect(Reflect.get(route, 'revalidate')).toBeUndefined();
  });
});
