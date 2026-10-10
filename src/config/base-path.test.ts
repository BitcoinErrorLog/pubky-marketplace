import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBasePath } from '@/test-utils/base-path';
import { getBasePath, getShopBaseUrl, withBasePath, withoutBasePath } from './base-path';

vi.mock('@/config/metadata', () => ({ getDefaultUrl: () => 'https://pubky.app' }));

describe('base path config', () => {
  afterEach(() => setBasePath(''));

  it('serves from the origin root by default', () => {
    expect(getBasePath()).toBe('');
    expect(withBasePath('/api/feedback')).toBe('/api/feedback');
    expect(withoutBasePath('/marketplace')).toBe('/marketplace');
    expect(getShopBaseUrl()).toBe('https://pubky.app');
  });

  it('prefixes paths and builds the public URL under a mount path', () => {
    setBasePath('/shop');
    expect(getBasePath()).toBe('/shop');
    expect(withBasePath('/api/feedback')).toBe('/shop/api/feedback');
    expect(withoutBasePath('/shop/marketplace')).toBe('/marketplace');
    expect(getShopBaseUrl()).toBe('https://pubky.app/shop');
  });
});
