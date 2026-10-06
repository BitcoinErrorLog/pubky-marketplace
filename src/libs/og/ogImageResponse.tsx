import { ImageResponse } from 'next/og';
import type { ReactElement } from 'react';
import { OG_CACHE_HEADERS, OG_SIZE } from './ogConstants';
import { getOgFonts } from './ogFonts';

/**
 * Builds a 1200x630 PNG `ImageResponse` with the bundled Inter Tight fonts and
 * the shared cache headers applied. Central factory so every OG route emits an
 * identically-configured image. `headers` may be overridden for routes whose
 * content churns faster than the social default (e.g. marketplace listings use
 * `OG_COMMERCE_CACHE_HEADERS`).
 */
export function ogImageResponse(
  element: ReactElement,
  headers: Record<string, string> = { ...OG_CACHE_HEADERS },
): ImageResponse {
  return new ImageResponse(element, {
    width: OG_SIZE.width,
    height: OG_SIZE.height,
    fonts: getOgFonts(),
    headers,
  });
}
