import { describe, expect, it } from 'vitest';
import { buildFramingHeaders } from './headers';

describe('buildFramingHeaders', () => {
  it('denies framing and keeps popup openers when no ancestor is allowed (the default)', () => {
    expect(buildFramingHeaders([])).toEqual([
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    ]);
  });

  it('names exactly the allowed origins and drops X-Frame-Options', () => {
    const headers = buildFramingHeaders(['https://pubky.app', 'https://staging.pubky.app']);
    expect(headers).toEqual([
      { key: 'Content-Security-Policy', value: 'frame-ancestors https://pubky.app https://staging.pubky.app' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    ]);
    expect(headers.some((header) => header.key === 'X-Frame-Options')).toBe(false);
  });

  it("maps a same-origin-only list to SAMEORIGIN, the exact legacy equivalent of 'self'", () => {
    expect(buildFramingHeaders(["'self'"])).toEqual([
      { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    ]);
  });

  it("drops X-Frame-Options when 'self' is combined with other origins", () => {
    const headers = buildFramingHeaders(["'self'", 'https://pubky.app']);
    expect(headers[0]).toEqual({ key: 'Content-Security-Policy', value: "frame-ancestors 'self' https://pubky.app" });
    expect(headers.some((header) => header.key === 'X-Frame-Options')).toBe(false);
  });

  it('never emits a source twice', () => {
    expect(buildFramingHeaders(['https://pubky.app', 'https://pubky.app'])[0].value).toBe(
      'frame-ancestors https://pubky.app',
    );
  });
});
