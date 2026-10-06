import { describe, expect, it, vi } from 'vitest';
import { resolveMarketplaceMediaUrl } from './media-url';

const SELLER = 'y'.repeat(52);

vi.mock('@/libs/runtime-config/runtime-config', () => ({
  getHomeserverUrl: () => 'https://homeserver.staging.pubky.app',
}));

describe('resolveMarketplaceMediaUrl', () => {
  it('resolves a pubky marketplace media URI to the homeserver public read URL', () => {
    const url = resolveMarketplaceMediaUrl(`pubky://${SELLER}/pub/pubky.app/marketplace/v1/media/image_01`);

    expect(url).toBe(
      `https://homeserver.staging.pubky.app/pub/pubky.app/marketplace/v1/media/image_01?pubky-host=${SELLER}`,
    );
  });

  it('passes plain http(s) URLs through unchanged', () => {
    expect(resolveMarketplaceMediaUrl('https://cdn.example.com/media/1.jpg')).toBe(
      'https://cdn.example.com/media/1.jpg',
    );
    expect(resolveMarketplaceMediaUrl('http://localhost:8787/media/1.jpg')).toBe('http://localhost:8787/media/1.jpg');
  });

  it('uses the verified owner homeserver when one is supplied', () => {
    expect(
      resolveMarketplaceMediaUrl(
        `pubky://${SELLER}/pub/pubky.app/marketplace/v1/media/image_01`,
        'https://homeserver.other.example/',
      ),
    ).toBe(`https://homeserver.other.example/pub/pubky.app/marketplace/v1/media/image_01?pubky-host=${SELLER}`);
  });

  it('returns null for URIs with no browser-loadable form', () => {
    expect(resolveMarketplaceMediaUrl('')).toBeNull();
    expect(resolveMarketplaceMediaUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(resolveMarketplaceMediaUrl('pubky://not-a-valid-z32/pub/pubky.app/marketplace/v1/media/x')).toBeNull();
    // Valid owner but a private (non-/pub/) path is never publicly readable.
    expect(resolveMarketplaceMediaUrl(`pubky://${SELLER}/priv/secret.jpg`)).toBeNull();
    expect(resolveMarketplaceMediaUrl(`pubky://${SELLER}`)).toBeNull();
  });
  it.each([
    ['/pub/../x', 'dot-segment traversal'],
    ['/pub/%2e%2e/x', 'encoded dot-segment traversal'],
    ['/pub/a/..%2f..%2fx', 'encoded slash traversal'],
    ['/pub/pubky.app/marketplace/ok.jpg?x=1', 'query'],
    ['/pub/pubky.app/marketplace/ok.jpg#f', 'fragment'],
    ['/pub//x', 'empty segment'],
    ['/pub/pubky.app/other/x', 'outside marketplace prefix'],
    ['/pub/pubky.app/marketplace/ok\n.jpg', 'newline'],
    ['/pub/pubky.app/marketplace/ok\t.jpg', 'tab'],
    ['/pub/pubky.app/marketplace/ok\0.jpg', 'NUL'],
    ['/pub/pubky.app/marketplace/ok\x7f.jpg', 'DEL'],
  ])('rejects %s (%s)', (path) => {
    expect(resolveMarketplaceMediaUrl(`pubky://${SELLER}${path}`)).toBeNull();
  });
});
