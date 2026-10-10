import NextImage, { type ImageProps as NextImageProps } from 'next/image';
import type * as React from 'react';
import { withBasePath } from '@/config/base-path';

type BasePathImageProps = NextImageProps & { ref?: React.Ref<HTMLImageElement> };

/**
 * `next/image` for the Shop's own artwork. Next.js does not add the mount path to a
 * root-relative `src` (`/images/key.webp`), so a Shop served under a base path would
 * request the host app's `/images/...` instead of its own. This wrapper prefixes string
 * sources that start with `/`; static imports and absolute URLs pass through, and with
 * no mount path the output is identical to `next/image`.
 */
export function BasePathImage({ src, ...props }: BasePathImageProps) {
  return <NextImage {...props} src={typeof src === 'string' ? withBasePath(src) : src} />;
}
