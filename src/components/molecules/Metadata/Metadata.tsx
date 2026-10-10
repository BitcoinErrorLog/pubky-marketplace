import { getBasePath, getShopBaseUrl, withBasePath } from '@/config/base-path';
import {
  getAuthor,
  getCreator,
  getDefaultUrl,
  getKeywords,
  getLocale,
  getPreviewImage,
  getSiteName,
  getType,
} from '@/config/metadata';

interface MetadataProps {
  title: string;
  /**
   * Optional. When empty/omitted, `description` is emitted as `null` — Next's
   * "opt out of inherited metadata" signal — so a page with no textual content
   * (e.g. a simple repost) still gets a title + image but does NOT inherit the
   * parent layout's generic description (which would read as if the author wrote
   * it). Only the description is suppressed; the rest of the metadata continues.
   */
  description?: string;
  image?: string;
  type?: string;
  url?: string;
  siteName?: string;
  locale?: string;
  author?: string;
  keywords?: string;
  robots?: boolean;
  creator?: string;
  site?: string;
  favicon?: string;
  /**
   * Omit the static `openGraph.images` / `twitter.images` arrays. Use on routes
   * that supply a dynamic image via the `opengraph-image` / `twitter-image` file
   * convention, so the file-convention image is the single source of truth
   * instead of conflicting with the static `/preview.webp`.
   */
  omitImages?: boolean;
}

export function getPWAConfig() {
  return {
    // The manifest claims the whole origin (`scope: "/"`), so a Shop mounted under a base path
    // on another app's origin must not advertise one: the host app owns installability there.
    ...(getBasePath() === '' && { manifest: '/manifest.json' }),
    appleWebApp: {
      capable: true,
      statusBarStyle: 'black' as const,
      title: getSiteName(),
    },
  };
}

export function Metadata({
  title,
  description,
  image,
  type,
  url,
  siteName,
  locale,
  author,
  keywords,
  robots = true,
  creator,
  site,
  favicon = '/pubky-favicon.svg',
  omitImages = false,
}: MetadataProps) {
  const defaultUrl = getDefaultUrl();
  const resolvedImage = withBasePath(image ?? getPreviewImage());
  const resolvedType = type ?? getType();
  const shopBaseUrl = getShopBaseUrl();
  const resolvedUrl = url === undefined ? shopBaseUrl : withBasePath(url);
  const resolvedSiteName = siteName ?? getSiteName();
  const resolvedLocale = locale ?? getLocale();
  const resolvedAuthor = author ?? getAuthor();
  const resolvedKeywords = keywords ?? getKeywords();
  const resolvedCreator = creator ?? getCreator();
  const resolvedSite = site ?? defaultUrl;
  const hasDescription = typeof description === 'string' && description.length > 0;
  // Top-level accepts `null` (Next's opt-out of inherited metadata); openGraph /
  // twitter only accept `string`, so they use `''`. Both override — rather than
  // inherit — the parent layout's generic description on a content-less page.
  const resolvedDescription = hasDescription ? description : '';

  return {
    // The origin only: Next.js prepends the base path itself to the dynamic OG and Twitter image
    // routes, so a base path here would double it. Root-relative values below are prefixed explicitly.
    metadataBase: new URL(defaultUrl),
    title,
    description: hasDescription ? resolvedDescription : null,
    keywords: resolvedKeywords,
    authors: [{ name: resolvedAuthor }],
    creator: resolvedAuthor,
    icons: {
      icon: withBasePath(favicon),
      shortcut: withBasePath(favicon),
      apple: [
        { url: withBasePath('/images/manifest/web-app-manifest-180x180.png'), sizes: '180x180', type: 'image/png' },
        { url: withBasePath('/images/manifest/web-app-manifest-152x152.png'), sizes: '152x152', type: 'image/png' },
        { url: withBasePath('/images/manifest/web-app-manifest-144x144.png'), sizes: '144x144', type: 'image/png' },
      ],
    },
    openGraph: {
      title,
      description: resolvedDescription,
      url: resolvedUrl,
      siteName: resolvedSiteName,
      ...(omitImages
        ? {}
        : {
            images: [
              {
                url: resolvedImage,
                width: 1200,
                height: 630,
                alt: title,
              },
            ],
          }),
      locale: resolvedLocale,
      type: resolvedType,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: resolvedDescription,
      ...(omitImages ? {} : { images: [resolvedImage] }),
      creator: resolvedCreator,
      site: resolvedSite,
    },
    robots: {
      index: robots,
      follow: robots,
    },
    alternates: {
      canonical: resolvedUrl,
    },
    ...getPWAConfig(),
  };
}
