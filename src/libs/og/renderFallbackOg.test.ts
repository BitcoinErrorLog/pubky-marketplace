import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFallbackOg } from './renderFallbackOg';

const { getDefaultUrlMock, getPreviewImageMock } = vi.hoisted(() => ({
  getDefaultUrlMock: vi.fn(),
  getPreviewImageMock: vi.fn(),
}));

vi.mock('@/config/metadata', () => ({
  getDefaultUrl: getDefaultUrlMock,
  getPreviewImage: getPreviewImageMock,
}));

describe('renderFallbackOg', () => {
  beforeEach(() => {
    getDefaultUrlMock.mockReset();
    getPreviewImageMock.mockReset();
  });

  it('returns a redirect response when preview and default URLs are malformed', () => {
    getPreviewImageMock.mockReturnValue('/marketplace/opengraph-image');
    getDefaultUrlMock.mockReturnValue('not a URL');

    const response = renderFallbackOg();

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://shop.pubky.app/preview.webp');
    expect(response.headers.get('location')).not.toMatch(/\/marketplace\/|\/opengraph-image|\/twitter-image/);
  });

  it('returns the static preview asset when config getters throw', () => {
    getPreviewImageMock.mockImplementation(() => {
      throw new Error('invalid runtime config');
    });
    getDefaultUrlMock.mockImplementation(() => {
      throw new Error('invalid runtime config');
    });

    const response = renderFallbackOg();

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://shop.pubky.app/preview.webp');
    expect(response.headers.get('location')).not.toMatch(/\/marketplace\/|\/opengraph-image|\/twitter-image/);
  });

  it('redirects to the configured preview image as an absolute URL', () => {
    getPreviewImageMock.mockReturnValue('/preview.webp');
    getDefaultUrlMock.mockReturnValue('https://shop.example');

    const response = renderFallbackOg();

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://shop.example/preview.webp');
    expect(response.headers.get('location')).not.toMatch(/\/marketplace\/|\/opengraph-image|\/twitter-image/);
  });
});
