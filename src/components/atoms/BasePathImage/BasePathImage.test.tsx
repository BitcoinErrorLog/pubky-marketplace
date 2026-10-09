import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBasePath } from '@/test-utils/base-path';
import { BasePathImage } from './BasePathImage';

vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: unknown; alt: string }) => (
     
    <img src={typeof src === 'string' ? src : (src as { src: string }).src} alt={alt} />
  ),
}));

describe('BasePathImage', () => {
  afterEach(() => setBasePath(''));

  it('passes a root-relative source through unchanged when the Shop is served from the origin root', () => {
    render(<BasePathImage src="/images/key.webp" alt="key" width={10} height={10} />);
    expect(screen.getByAltText('key')).toHaveAttribute('src', '/images/key.webp');
  });

  it('prefixes a root-relative source with the mount path', () => {
    setBasePath('/shop');
    render(<BasePathImage src="/images/key.webp" alt="key" width={10} height={10} />);
    expect(screen.getByAltText('key')).toHaveAttribute('src', '/shop/images/key.webp');
  });

  it('leaves absolute URLs and static imports alone under a mount path', () => {
    setBasePath('/shop');
    render(
      <>
        <BasePathImage src="https://cdn.example.com/a.png" alt="remote" width={10} height={10} />
        <BasePathImage src={{ src: '/shop/_next/static/media/b.png', width: 10, height: 10 }} alt="static" />
      </>,
    );
    expect(screen.getByAltText('remote')).toHaveAttribute('src', 'https://cdn.example.com/a.png');
    expect(screen.getByAltText('static')).toHaveAttribute('src', '/shop/_next/static/media/b.png');
  });

  it('does not double the mount path on an already-prefixed source', () => {
    setBasePath('/shop');
    render(<BasePathImage src="/shop/images/key.webp" alt="key" width={10} height={10} />);
    expect(screen.getByAltText('key')).toHaveAttribute('src', '/shop/images/key.webp');
  });
});
