import { afterEach, describe, expect, it } from 'vitest';
import { setBasePath } from '@/test-utils/base-path';
import { Metadata } from './Metadata';

describe('Metadata - Snapshots', () => {
  it('matches snapshot for default metadata configuration', () => {
    const result = Metadata({
      title: 'Test Title',
      description: 'Test Description',
    });
    expect(result).toMatchSnapshot();
  });

  it('matches snapshot for metadata with custom parameters', () => {
    const result = Metadata({
      title: 'Custom Title',
      description: 'Custom Description',
      image: '/custom-image.jpg',
      type: 'article',
      url: 'https://custom-url.com',
      siteName: 'Custom Site',
      locale: 'it_IT',
      author: 'Custom Author',
      keywords: 'custom, keywords',
      robots: false,
    });
    expect(result).toMatchSnapshot();
  });

  it('matches snapshot for metadata with minimal configuration', () => {
    const result = Metadata({
      title: 'Minimal',
      description: 'Minimal description',
    });
    expect(result).toMatchSnapshot();
  });

  it('matches snapshot for metadata with image', () => {
    const result = Metadata({
      title: 'Image Test',
      description: 'Testing custom image',
      image: '/image.jpg',
    });
    expect(result).toMatchSnapshot();
  });

  it('matches snapshot with empty strings', () => {
    const result = Metadata({
      title: '',
      description: '',
    });
    expect(result).toMatchSnapshot();
  });

  it('matches snapshot with long title and description', () => {
    const longTitle = 'A'.repeat(1000);
    const longDescription = 'B'.repeat(1000);
    const result = Metadata({
      title: longTitle,
      description: longDescription,
    });
    expect(result).toMatchSnapshot();
  });

  it('matches snapshot with special characters', () => {
    const result = Metadata({
      title: 'Special chars: <>&"\'',
      description: 'More special: ©®™€£¥',
    });
    expect(result).toMatchSnapshot();
  });
});

describe('Metadata - omitImages', () => {
  it('includes static openGraph/twitter images by default', () => {
    const result = Metadata({ title: 'T', description: 'D' });
    expect(result.openGraph.images).toBeDefined();
    expect(result.twitter.images).toBeDefined();
  });

  it('omits openGraph/twitter images when omitImages is true', () => {
    const result = Metadata({ title: 'T', description: 'D', omitImages: true });
    expect(result.openGraph).not.toHaveProperty('images');
    expect(result.twitter).not.toHaveProperty('images');
    // Other fields are still present.
    expect(result.openGraph.title).toBe('T');
    expect(result.twitter.card).toBe('summary_large_image');
  });
});

describe('Metadata - optional description', () => {
  it('includes description everywhere when provided', () => {
    const result = Metadata({ title: 'T', description: 'D' });
    expect(result.description).toBe('D');
    expect(result.openGraph.description).toBe('D');
    expect(result.twitter.description).toBe('D');
  });

  it('suppresses description (does not inherit parent) when absent/empty, keeping title', () => {
    const result = Metadata({ title: 'T', description: '' });
    // Top-level uses `null` (Next opt-out); og/twitter use '' — both override the
    // parent's generic description rather than inheriting it.
    expect(result.description).toBeNull();
    expect(result.openGraph.description).toBe('');
    expect(result.twitter.description).toBe('');
    // Title is still emitted so the page doesn't fall back to parent metadata.
    expect(result.title).toBe('T');
    expect(result.openGraph.title).toBe('T');
  });
});

describe('Metadata - mounted under a base path', () => {
  afterEach(() => setBasePath(''));

  it('keeps the manifest and root-relative asset URLs when served from the origin root', () => {
    const result = Metadata({ title: 'T', description: 'D', url: '/marketplace' });

    expect(result.manifest).toBe('/manifest.json');
    expect(result.icons.icon).toBe('/pubky-favicon.svg');
    expect(result.icons.apple[0].url).toBe('/images/manifest/web-app-manifest-180x180.png');
    expect(result.alternates.canonical).toBe('/marketplace');
    expect(result.metadataBase.href).toBe('https://pubky.app/');
  });

  it('prefixes icons, preview image and canonical URLs and drops the manifest', () => {
    setBasePath('/shop');
    const result = Metadata({ title: 'T', description: 'D', url: '/marketplace/listing/s/l' });

    expect(result.manifest).toBeUndefined();
    expect(result.icons.icon).toBe('/shop/pubky-favicon.svg');
    expect(result.icons.shortcut).toBe('/shop/pubky-favicon.svg');
    expect(result.icons.apple.map((icon) => icon.url)).toEqual([
      '/shop/images/manifest/web-app-manifest-180x180.png',
      '/shop/images/manifest/web-app-manifest-152x152.png',
      '/shop/images/manifest/web-app-manifest-144x144.png',
    ]);
    expect(result.openGraph.images?.[0].url).toBe('/shop/preview.webp');
    expect(result.twitter.images).toEqual(['/shop/preview.webp']);
    expect(result.alternates.canonical).toBe('/shop/marketplace/listing/s/l');
    expect(result.openGraph.url).toBe('/shop/marketplace/listing/s/l');
  });

  it('points the default canonical URL at the mounted Shop and leaves the base origin-only', () => {
    setBasePath('/shop');
    const result = Metadata({ title: 'T', description: 'D' });

    expect(result.alternates.canonical).toBe('https://pubky.app/shop');
    // Next.js adds the base path to its own OG/Twitter image routes; a base path here would double it.
    expect(result.metadataBase.href).toBe('https://pubky.app/');
  });

  it('does not prefix absolute image and canonical URLs', () => {
    setBasePath('/shop');
    const result = Metadata({
      title: 'T',
      description: 'D',
      image: 'https://cdn.example.com/a.png',
      url: 'https://example.com/x',
    });

    expect(result.openGraph.images?.[0].url).toBe('https://cdn.example.com/a.png');
    expect(result.alternates.canonical).toBe('https://example.com/x');
  });
});
