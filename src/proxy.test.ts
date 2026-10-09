// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { config, proxy } from './proxy';

const runtime = vi.hoisted(() => ({ frameAncestors: [] as string[] }));

vi.mock('@/libs/runtime-config/runtime-config', () => ({
  getFrameAncestors: () => runtime.frameAncestors,
}));

describe('proxy', () => {
  it('denies framing by default', () => {
    runtime.frameAncestors = [];
    const response = proxy();

    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
  });

  it('names the configured ancestors at request time, without X-Frame-Options', () => {
    runtime.frameAncestors = ['https://pubky.app'];
    const response = proxy();

    expect(response.headers.get('content-security-policy')).toBe('frame-ancestors https://pubky.app');
    expect(response.headers.get('x-frame-options')).toBeNull();
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
  });

  it('re-reads the allow-list on every request', () => {
    runtime.frameAncestors = ['https://pubky.app'];
    expect(proxy().headers.get('content-security-policy')).toBe('frame-ancestors https://pubky.app');
    runtime.frameAncestors = [];
    expect(proxy().headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });

  it('does not run for static build output or optimised images', () => {
    const [matcher] = config.matcher;
    const pattern = new RegExp(`^${matcher}$`);

    expect(pattern.test('/marketplace')).toBe(true);
    expect(pattern.test('/api/feedback')).toBe(true);
    expect(pattern.test('/')).toBe(true);
    expect(pattern.test('/_next/static/chunks/main.js')).toBe(false);
    expect(pattern.test('/_next/image')).toBe(false);
  });
});
