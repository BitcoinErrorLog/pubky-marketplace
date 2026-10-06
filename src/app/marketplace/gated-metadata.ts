import type { Metadata as NextMetadata } from 'next';
import { Metadata } from '@/molecules/Metadata/Metadata';

/**
 * Static branded metadata for auth-gated marketplace surfaces (orders, offers,
 * inbox, dashboard, sell, ...). Generic copy only — these pages are personal,
 * so previews must never leak user data — and `noindex` since the content is
 * meaningless to crawlers. The preview image points at the `/marketplace`
 * segment's branded `opengraph-image` route explicitly: Next's file-convention
 * images do NOT cascade to nested routes, so without this the pages would
 * unfurl with no image at all (verified against the dev server).
 */
export function gatedMarketplaceMetadata(title: string, description: string, url: string): NextMetadata {
  const { openGraph, twitter, alternates, robots } = Metadata({
    title,
    description,
    url,
    robots: false,
    image: '/marketplace/opengraph-image',
  });

  return { title, description, openGraph, twitter, alternates, robots };
}
